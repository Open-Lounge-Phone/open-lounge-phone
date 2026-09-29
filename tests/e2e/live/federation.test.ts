// LIVE cross-server check (section B on two real hosts): two independent Open Lounge Phone
// servers, with real browsers (Chromium, fake media, virtual passkeys, one context per person or
// phone). Never runs in CI; opt in with OLP_LIVE=1 and run this file on its own:
//
//   OLP_LIVE=1 PLAYWRIGHT_CORE=/path/to/node_modules/playwright-core \
//     npx vitest run tests/e2e/live/federation.test.ts
//
// People: olptest-a and olptest-b on server 1; olptest-c and olptest-d on server 2.
// Env:
//   OLP_FED_1 / OLP_FED_2  the two servers (default https://t1 / https://t2.openloungephone.app);
//                          they must differ, have open sign-up (no Turnstile) and TURN.
//   OLP_LIVE_RUN, OLP_LIVE_HEADED, OLP_LIVE_KEEP, OLP_LIVE_OUT, OLP_LIVE_ONLY as in live.test.ts.
//
// It only ever creates, uses and deletes accounts whose handles start with `olptest-`.
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Browser, Page } from "playwright-core";
import { afterAll, it } from "vitest";
import { api, appSocket, type Person } from "../twoServers.ts";
import {
  CHROMIUM_ARGS,
  Companion,
  lastPc,
  Phone,
  pcConnected,
  selectedCandidateType,
  setForceRelay,
  until,
} from "./browser.ts";

const LIVE = process.env.OLP_LIVE === "1";
const S1 = process.env.OLP_FED_1 ?? "https://t1.openloungephone.app";
const S2 = process.env.OLP_FED_2 ?? "https://t2.openloungephone.app";
const RUN = process.env.OLP_LIVE_RUN ?? Math.random().toString(36).slice(2, 7);
const OUT = process.env.OLP_LIVE_OUT ?? tmpdir();
const ONLY = process.env.OLP_LIVE_ONLY
  ? new Set(process.env.OLP_LIVE_ONLY.split(",").map((x) => Number(x.trim())))
  : undefined;
const hostOf = (origin: string) => new URL(origin).host;
const H1 = hostOf(S1);
const H2 = hostOf(S2);

type Status = "PASS" | "FAIL" | "SKIPPED";
const results: { id: number; title: string; status: Status; note: string }[] = [];
class Skip extends Error {}
let focus: Page | undefined;

async function check(id: number, title: string, fn: () => Promise<unknown>): Promise<boolean> {
  const t0 = Date.now();
  if (ONLY && !ONLY.has(id)) {
    results.push({ id, title, status: "SKIPPED", note: "not selected (OLP_LIVE_ONLY)" });
    return false;
  }
  try {
    const out = await fn();
    const note = typeof out === "string" ? out : "";
    results.push({ id, title, status: "PASS", note });
    console.log(`PASS ${id}. ${title} (${Date.now() - t0} ms) ${note}`);
    return true;
  } catch (e) {
    if (e instanceof Skip) {
      results.push({ id, title, status: "SKIPPED", note: e.message });
      console.log(`SKIPPED ${id}. ${title}: ${e.message}`);
      return false;
    }
    const note = e instanceof Error ? (e.message.split("\n")[0] ?? "") : String(e);
    results.push({ id, title, status: "FAIL", note });
    console.log(`FAIL ${id}. ${title}: ${note}`);
    if (focus) {
      const path = join(OUT, `olp-fed-${RUN}-${id}.png`);
      await focus.screenshot({ path }).catch(() => {});
      console.log(`  screenshot: ${path}`);
    }
    return false;
  }
}

function need(cond: unknown, why: string): asserts cond {
  if (!cond) throw new Skip(why);
}

function assert(cond: unknown, what: string): asserts cond {
  if (!cond) throw new Error(what);
}

type Conn = {
  id: string;
  address: string;
  state: string;
  remote?: boolean;
  presence?: { available: boolean } | null;
  phones?: { deviceId: string; name: string }[];
};
const conns = async (p: Person) =>
  ((await api(p, "/connections")).json?.connections ?? []) as Conn[];

/** Records "just your name" as the greeting (the fake microphone speaks) and sets the ring time. */
async function recordName(c: Companion, ringSeconds: number): Promise<void> {
  await c.tab("Voicemail");
  const editor = c.page.locator("details.greeting-editor");
  if (!(await editor.getAttribute("open"))) await editor.locator("summary").click();
  await editor.getByRole("button", { name: /Record just your name/ }).click();
  await editor.getByRole("button", { name: "Save" }).click({ timeout: 15_000 }); // stops at 3 s
  await until("name greeting saved", async () => {
    const s = await api(c.person, "/voicemail/settings");
    return s.json?.greeting?.kind === "name";
  });
  const r = await api(c.person, "/voicemail/settings", {
    method: "PATCH",
    body: { ringSeconds },
  });
  assert(r.status === 204, `ring time ${r.status}`);
}

/** Watches a page for the greeting it fetches with a voicemail ticket. */
function greetingSeen(page: Page): () => { status: number; kind: string | undefined } | undefined {
  let seen: { status: number; kind: string | undefined } | undefined;
  type Res = { url(): string; status(): number; headers(): Record<string, string> };
  page.on("response", (r: Res) => {
    if (r.url().includes("/vm/greeting")) {
      seen = { status: r.status(), kind: r.headers()["olp-greeting"] };
    }
  });
  return () => seen;
}

let browser: Browser | undefined;
const people: Companion[] = [];
const phones: Phone[] = [];

/** Deletes every test account and confirms its old session is dead. */
async function cleanup(): Promise<string[]> {
  const left: string[] = [];
  for (const c of people) {
    const token = c.person?.token ?? (await c.token().catch(() => null));
    if (!token) {
      if (c.person) left.push(`${c.handle}: no session`);
      continue;
    }
    const res = await api({ server: c.server, token }, "/account", {
      method: "DELETE",
      body: { confirm: c.handle },
    });
    const after = await api({ server: c.server, token }, "/me");
    if (res.status !== 204 || after.status !== 401) {
      left.push(`${c.handle}@${hostOf(c.origin)}: delete ${res.status}, /me after ${after.status}`);
    } else console.log(`deleted ${c.handle}@${hostOf(c.origin)} (old token → ${after.status})`);
  }
  return left;
}

afterAll(async () => {
  if (!LIVE) return;
  for (const p of [...people, ...phones]) await p.context?.close().catch(() => {});
  let left: string[] = [];
  if (process.env.OLP_LIVE_KEEP !== "1") left = await cleanup();
  await browser?.close().catch(() => {});
  const report = { run: RUN, servers: [S1, S2], results, cleanupLeft: left };
  const path = join(OUT, `olp-fed-${RUN}.json`);
  writeFileSync(path, JSON.stringify(report, null, 2));
  console.log(`\n=== results (${path}) ===`);
  for (const r of results.sort((x, y) => x.id - y.id)) {
    console.log(`${String(r.id).padStart(2)} ${r.status.padEnd(7)} ${r.title} — ${r.note}`);
  }
  console.log(
    left.length ? `cleanup left: ${left.join("; ")}` : "cleanup: all test accounts deleted",
  );
}, 180_000);

it.skipIf(!LIVE)(
  "live: calls between two Open Lounge Phone servers",
  async () => {
    assert(H1 !== H2, "OLP_FED_1 and OLP_FED_2 must be different servers");
    const pw = await import(process.env.PLAYWRIGHT_CORE ?? "playwright-core");
    const chromium = pw.chromium ?? pw.default?.chromium;
    browser = (await chromium.launch({
      headless: process.env.OLP_LIVE_HEADED !== "1",
      args: CHROMIUM_ARGS,
    })) as Browser;
    const b0 = browser;

    const a = new Companion(S1, `olptest-a-${RUN}`);
    const b = new Companion(S1, `olptest-b-${RUN}`);
    const c = new Companion(S2, `olptest-c-${RUN}`);
    const d = new Companion(S2, `olptest-d-${RUN}`);
    people.push(a, b, c, d);
    for (const [p, name] of [
      [a, "olptest-a"],
      [b, "olptest-b"],
      [c, "olptest-c"],
      [d, "olptest-d"],
    ] as const) {
      await p.open(b0);
      focus = p.page;
      await p.signUp(name);
      assert(p.person.address === `${p.handle}@${hostOf(p.origin)}`, `address ${p.person.address}`);
    }
    console.log(`signed up: ${people.map((p) => p.person.address).join(", ")}`);

    // ------------------------------------------------------------------------------------ 1
    await check(
      1,
      "/.well-known/openloungephone on both hosts, different server keys",
      async () => {
        const keys: string[] = [];
        for (const h of [S1, S2]) {
          const w = await (await fetch(`${h}/.well-known/openloungephone`)).json();
          assert(w.version === 1 && /^[\w-]{43}$/.test(w.server_key), `${h}: ${JSON.stringify(w)}`);
          assert(w.federation === "/fed/v1", `${h}: federation path`);
          keys.push(w.server_key);
        }
        assert(keys[0] !== keys[1], "same server key on both hosts");
        return `${H1} ${keys[0]?.slice(0, 8)}…, ${H2} ${keys[1]?.slice(0, 8)}…`;
      },
    );

    // ------------------------------------------------------------------------------------ 2
    let aToC: string | undefined;
    let cToA: string | undefined;
    await check(2, "a@t1 knocks c@t2 → visible on t2 → accept → active on both", async () => {
      focus = a.page;
      await a.tab("Connect");
      await a.page.getByLabel("Their address").fill(c.person.address);
      await a.page.getByRole("button", { name: "Knock" }).click();
      await a.page.getByText(`If ${c.person.address} exists`).waitFor();
      focus = c.page;
      const knock = await until("knock at c", async () =>
        (await conns(c.person)).find((x) => x.address === a.person.address),
      );
      assert(knock.state === "requested" && knock.remote, `c's row ${JSON.stringify(knock)}`);
      await c.page.reload();
      await c.ready();
      await c.tab("Connect");
      await c.page.getByText("Knocks for you").waitFor({ timeout: 20_000 });
      await c.page.getByRole("button", { name: "Accept" }).click();
      const ac = await until("a sees active", async () =>
        (await conns(a.person)).find((x) => x.address === c.person.address && x.state === "active"),
      );
      const ca = (await conns(c.person)).find((x) => x.address === a.person.address);
      assert(ca?.state === "active", `c's row ${ca?.state}`);
      aToC = ac.id;
      cToA = ca.id;
      return `${a.person.address} ↔ ${c.person.address}`;
    });

    const clickCall = async (from: Companion, toAddress: string) => {
      await from.tab("Connect");
      await from.page
        .locator("li.card", { hasText: toAddress })
        .getByRole("button", { name: "Call", exact: true })
        .first()
        .click();
    };

    const connectedCall = async (
      from: Companion,
      to: Companion,
      hangBy: Companion,
      timeoutMs = 30_000,
    ) => {
      await from.page.reload();
      await from.ready();
      await to.ready();
      const [pf, pt] = [await from.pcCount(), await to.pcCount()];
      await clickCall(from, to.person.address);
      focus = to.page;
      await to.answer().catch(async (e) => {
        const o = await from
          .overlay()
          .innerText()
          .catch(() => "");
        throw new Error(`${to.handle} never rang; caller shows "${o.replace(/\s+/g, " ")}" (${e})`);
      });
      const pc = await pcConnected(from.page, pf, timeoutMs).catch(async (e) => {
        const [x, y] = [await lastPc(from.page), await lastPc(to.page)];
        throw new Error(
          `${from.handle}→${to.handle} media: caller ${x.state} [${x.states}], callee ${y.state} [${y.states}] (${e})`,
        );
      });
      await pcConnected(to.page, pt, timeoutMs);
      const types = [await selectedCandidateType(from.page), await selectedCandidateType(to.page)];
      await hangBy.hangUp();
      await from.ended();
      await to.ended();
      return { pc, types };
    };

    // ------------------------------------------------------------------------------------ 3
    await check(3, "cross-server calls a→c (callee hangs up), c→a (caller hangs up)", async () => {
      need(aToC, "no connection");
      const one = await connectedCall(a, c, c);
      const two = await connectedCall(c, a, c);
      return `a→c connected (${one.types.join("/")}), c→a connected (${two.types.join("/")})`;
    });

    // ------------------------------------------------------------------------------------ 4
    await check(4, "forced relay on both ends: connected via relay candidates", async () => {
      need(aToC, "no connection");
      await a.page.reload();
      await c.page.reload();
      await a.ready();
      await c.ready();
      await setForceRelay(a.page, true);
      await setForceRelay(c.page, true);
      const [pf, pt] = [await a.pcCount(), await c.pcCount()];
      await clickCall(a, c.person.address);
      focus = c.page;
      await c.answer();
      const x = await pcConnected(a.page, pf, 40_000);
      const y = await pcConnected(c.page, pt, 40_000);
      const types = [await selectedCandidateType(a.page), await selectedCandidateType(c.page)];
      await a.hangUp();
      await a.ended();
      await c.ended();
      await a.page.reload();
      await c.page.reload();
      assert(x.relayPolicy && y.relayPolicy, "relay policy not applied");
      assert(
        types.every((t) => t === "relay"),
        `selected candidates ${types.join(",")}`,
      );
      const turn = x.iceServers.flatMap((s) => [s.urls].flat()).filter((u) => /^turns?:/.test(u));
      return `selected local candidates ${types.join(", ")}; TURN ${turn[0] ?? "?"}`;
    });

    // ------------------------------------------------------------------------------------ 5
    await check(
      5,
      "no answer across servers: c's name greeting, a records, inbox + transcript + call log",
      async () => {
        need(aToC, "no connection");
        await c.ready();
        focus = c.page;
        await recordName(c, 25);
        await a.page.reload();
        await a.ready();
        const greeting = greetingSeen(a.page);
        const t0 = Date.now();
        await clickCall(a, c.person.address);
        await c.page.locator(".overlay-incoming").waitFor({ timeout: 20_000 }); // not answered
        focus = a.page;
        await a
          .overlay()
          .getByText(/Recording ·/)
          .waitFor({ timeout: 60_000 });
        const ringMs = Date.now() - t0;
        const g = greeting();
        assert(g?.status === 200 && g.kind === "name", `greeting ${JSON.stringify(g)}`);
        await a.page.waitForTimeout(5_000);
        await a.overlay().getByRole("button", { name: "Hang up & send" }).click();
        await a.page.getByText(/Message sent to/).waitFor({ timeout: 20_000 });
        type Vm = {
          id: string;
          fromLabel: string;
          toUser: string | null;
          durationMs: number;
          transcriptStatus: string;
          transcript: string | null;
        };
        const vm = await until(
          "message with transcript in c's inbox",
          async () => {
            const list = (await api(c.person, "/voicemails")).json as Vm[];
            const v = list.find((x) => x.toUser && x.fromLabel.startsWith("olptest-a"));
            return v && v.transcriptStatus !== "pending" ? v : undefined;
          },
          60_000,
          2_000,
        );
        assert(vm.transcriptStatus === "done", `transcript ${vm.transcriptStatus}`);
        assert(vm.durationMs >= 3_000, `duration ${vm.durationMs}`);
        await c.tab("Voicemail");
        await c.page.locator("li.voicemail", { hasText: "olptest-a" }).first().waitFor();
        // The call log (the timeline) — exposed through the account export.
        type Log = { peer: string; direction: string; answered: boolean };
        const cLog = (await api(c.person, "/account/export")).json.calls as Log[];
        const aLog = (await api(a.person, "/account/export")).json.calls as Log[];
        const inRow = cLog.find(
          (l) => l.peer === a.person.address && l.direction === "in" && !l.answered,
        );
        const outRow = aLog.find(
          (l) => l.peer === c.person.address && l.direction === "out" && !l.answered,
        );
        assert(inRow && outRow, `call log c=${JSON.stringify(cLog)} a=${JSON.stringify(aLog)}`);
        return `greeting after ${Math.round(ringMs / 1000)} s (kind ${g.kind}); ${vm.durationMs} ms; transcript ${JSON.stringify(vm.transcript)}; missed call in both logs`;
      },
    );

    // ------------------------------------------------------------------------------------ 6
    await check(6, "c unavailable → a's call goes straight to voicemail", async () => {
      need(aToC, "no connection");
      await c.page.reload();
      await c.ready();
      await c.tab("Home");
      const sw = c.page.getByRole("switch", { name: "Available for calls" });
      if ((await sw.getAttribute("aria-checked")) !== "false") await sw.click();
      await until("c unavailable", async () => (await sw.getAttribute("aria-checked")) === "false");
      try {
        await a.page.reload();
        await a.ready();
        focus = a.page;
        const t0 = Date.now();
        await clickCall(a, c.person.address);
        await a.overlay().locator(".voicemail-panel").waitFor({ timeout: 10_000 });
        const offerMs = Date.now() - t0;
        assert((await c.overlay().count()) === 0, "c's app rang while unavailable");
        await a
          .overlay()
          .getByText(/Recording ·/)
          .waitFor({ timeout: 30_000 });
        await a.page.waitForTimeout(3_000);
        await a.overlay().getByRole("button", { name: "Hang up & send" }).click();
        await a.page.getByText(/Message sent to/).waitFor({ timeout: 20_000 });
        const n = await until("second message at c", async () => {
          const list = (await api(c.person, "/voicemails")).json as { fromLabel: string }[];
          const mine = list.filter((v) => v.fromLabel.startsWith("olptest-a"));
          return mine.length >= 2 ? mine.length : undefined;
        });
        return `voicemail offered after ${offerMs} ms, no ring; ${n} messages from a at c`;
      } finally {
        await sw.click();
        await until("c available", async () => (await sw.getAttribute("aria-checked")) === "true");
      }
    });

    // ------------------------------------------------------------------------------------ 7
    let kidDev: string | undefined;
    await check(7, "t2 Kids phone allows a@t1 → connected; d@t2 not allowed → denied", async () => {
      need(aToC && cToA, "no connection");
      const kid = new Phone(S2, `ckid-${RUN}`);
      phones.push(kid);
      await kid.open(b0, "kids");
      focus = kid.page;
      const code = (await kid.facts()).pairing;
      focus = c.page;
      await c.tab("Home");
      await c.page.getByRole("button", { name: "+ Pair a phone" }).click();
      await c.page.getByLabel("Pairing code").fill(code);
      await c.page.getByRole("textbox", { name: /^Phone name/ }).fill(`C kid ${RUN}`);
      await c.page.getByRole("button", { name: "Pair phone" }).click();
      kidDev = await kid.authed();
      const put = await api(c.person, `/devices/${kidDev}/remote-contacts/${cToA}`, {
        method: "PUT",
        body: { label: "A", canCallDevice: true, deviceCanCall: true, bypassQuietHours: false },
      });
      assert(put.status === 200, `remote contact ${put.status} ${JSON.stringify(put.json)}`);
      focus = a.page;
      await until("phone shared with a", async () =>
        (await conns(a.person)).find((x) => x.id === aToC)?.phones?.length ? true : undefined,
      );
      await a.page.reload();
      await a.ready();
      await a.tab("Connect");
      const [pa, pk] = [await a.pcCount(), await kid.pcCount()];
      await a.page
        .locator(".shared-phones li", { hasText: `C kid ${RUN}` })
        .getByRole("button", { name: "Call" })
        .click();
      focus = kid.page;
      await kid.waitKind("incoming", 30_000);
      await kid.hook();
      await pcConnected(a.page, pa);
      await pcConnected(kid.page, pk);
      await a.hangUp();
      await kid.waitKind("offhook");
      await kid.hook();
      await a.ended();
      await kid.waitKind("idle");

      // d@t2 connects with c (same server), but isn't on the phone's allow-list.
      focus = d.page;
      const k = await api(d.person, "/connections", { body: { to: c.person.address } });
      assert(k.status === 202, `d knock ${k.status}`);
      const req = await until("d's knock at c", async () =>
        (await conns(c.person)).find((x) => x.address === d.person.address),
      );
      const acc = await api(c.person, `/connections/${req.id}/accept`, { method: "POST" });
      assert(acc.status === 200, `accept d ${acc.status}`);
      const dToC = (await conns(d.person)).find((x) => x.address === c.person.address);
      assert(dToC?.state === "active", `d's row ${dToC?.state}`);
      assert(!dToC.phones?.length, `phone listed for d: ${JSON.stringify(dToC.phones)}`);
      const s = await appSocket(d.person);
      const seen: Record<string, unknown>[] = [];
      s.ws.addEventListener("message", (e) => seen.push(JSON.parse(String(e.data))));
      s.send({ t: "call.phone", connectionId: dToC.id, deviceId: kidDev });
      const m = await until("d refused", () =>
        seen.find((x) => x.t === "error" || (x.t === "call.state" && x.state === "ended")),
      );
      s.ws.close();
      assert((await kid.kind()) === "idle", "kids phone rang for d");
      // A phone that isn't shared with d is unknown to d's server (not_found); one that is shared
      // but whose allow-list says no ends as denied. Either way it must not ring.
      const refused =
        (m.t === "error" && m.code === "not_found") ||
        (m.t === "call.state" && m.reason === "denied");
      assert(refused, `d's call: ${JSON.stringify(m)}`);
      const how = m.t === "error" ? `error ${m.code}` : `ended (${m.reason})`;
      return `a→kids phone connected; d (not allowed) → ${how}, phone never rang`;
    });

    // ------------------------------------------------------------------------------------ 8
    await check(
      8,
      "t2 Lounge (guests on): a@t1 takes over, b@t1 calls a → rings, log out",
      async () => {
        need(aToC, "no connection");
        // b joins a's space so b can call a (app → app on t1).
        const inv = await api(a.person, "/invites", {
          body: { name: "olptest-b", role: "contact" },
        });
        assert(inv.status === 201, `invite ${inv.status}`);
        await b.page.goto("about:blank");
        await b.page.goto(`${S1}/#invite=${inv.json.token}`);
        await b.page.getByRole("button", { name: /^(Join|Sign in)$/ }).click();
        await until("b in a's space", async () =>
          ((await api(b.person, "/me")).json.memberships as { householdId: string }[]).some(
            (m) => m.householdId === a.person.householdId,
          ),
        );
        const aUserId = (await api(a.person, "/me")).json.user?.id as string | undefined;
        assert(aUserId, "a's user id");

        const lounge = new Phone(S2, `clounge-${RUN}`);
        phones.push(lounge);
        await lounge.open(b0, "lounge");
        focus = lounge.page;
        const code = (await lounge.facts()).pairing;
        focus = c.page;
        await c.tab("Home");
        await c.page.getByRole("button", { name: "+ Pair a phone" }).click();
        await c.page.getByLabel("Pairing code").fill(code);
        await c.page.getByRole("textbox", { name: /^Phone name/ }).fill(`C lounge ${RUN}`);
        await c.page.getByLabel(/^Kind of phone/).selectOption("lounge");
        await c.page.getByRole("button", { name: "Pair phone" }).click();
        const loungeId = await lounge.authed();
        const g = await api(c.person, "/lounge/settings", {
          method: "PUT",
          body: { guests: true },
        });
        assert(g.status === 204, `guests on ${g.status}`);
        assert((await api(c.person, "/lounge")).json.guests === true, "guests not on");

        await until("lounge.idle", async () => lounge.lastFrame("lounge.idle"));
        await lounge.page.waitForTimeout(1_500); // a second code can follow right after connecting
        const nonce = lounge.lastFrame("lounge.idle")?.nonce as string;
        const seenCh = lounge.frames.filter((f) => f.t === "lounge.challenge").length;
        focus = a.page;
        await a.page.goto("about:blank");
        await a.page.goto(`${S1}/lounge#${loungeId}.${nonce}@${H2}`);
        await a.ready();
        await a.page.getByRole("button", { name: "Use this phone" }).click();
        const ch = await until("challenge on the t2 phone", async () => {
          const all = lounge.frames.filter((f) => f.t === "lounge.challenge");
          return all.length > seenCh ? all.at(-1) : undefined;
        });
        const idx = ch.index as number;
        await lounge.press(String(idx === 9 ? 0 : idx + 1));
        await a.page.getByText(/You're on/).waitFor({ timeout: 20_000 });
        focus = lounge.page;
        await until("HI on the strip", async () =>
          /HI OLPTEST-A/i.test((await lounge.facts()).display),
        );

        // b@t1 calls a: the t2 Lounge phone rings.
        const sb = await appSocket({ ...b.person, householdId: a.person.householdId });
        sb.send({ t: "call.user", userId: aUserId });
        await lounge.waitKind("incoming", 30_000);
        const st = await sb.next("call.state");
        sb.send({ t: "call.hangup", callId: st.callId as string });
        await lounge.waitKind("idle");
        sb.ws.close();
        await a.ended().catch(() => {});

        await lounge.press("m");
        await lounge.press("9");
        await until(
          "lounge.ended logout",
          async () => lounge.lastFrame("lounge.ended")?.reason === "logout",
        );
        await until("SCAN TO USE", async () => /SCAN TO USE/.test((await lounge.facts()).display));
        await a.page.goto(`${S1}/`);
        await a.ready();
        return `takeover ${H1}→${H2}; b's call rang it; logged out`;
      },
    );

    // ------------------------------------------------------------------------------------ 9
    await check(9, "presence across servers: ≤5 s, and after quick toggles", async () => {
      need(cToA, "no connection");
      const patch = await api(a.person, "/account", {
        method: "PATCH",
        body: { sharePresence: true },
      });
      assert(patch.status < 300, `share ${patch.status}`);
      const rowAtC = async () => (await conns(c.person)).find((x) => x.id === cToA);
      const on = await until("a's presence at c", async () => (await rowAtC())?.presence, 10_000);
      await a.page.reload();
      await a.ready();
      await a.tab("Home");
      await a.page.waitForTimeout(11_000); // presence limit: 5 per 10 s; let the reload's pass
      const sw = a.page.getByRole("switch", { name: "Available for calls" });
      const waitAt = async (available: boolean, ms: number) => {
        const t0 = Date.now();
        await until(
          `c sees a available=${available}`,
          async () => (await rowAtC())?.presence?.available === available,
          ms,
          250,
        );
        return Date.now() - t0;
      };
      await sw.click(); // → unavailable
      const single = await waitAt(false, 5_000);
      await a.page.waitForTimeout(11_000);
      for (let i = 0; i < 7; i++) {
        await sw.click(); // ends available (odd count)
        await a.page.waitForTimeout(150);
      }
      assert((await sw.getAttribute("aria-checked")) === "true", "switch not back on");
      let burst: number;
      try {
        burst = await waitAt(true, 5_000);
      } catch {
        const late = await waitAt(true, 15_000).catch(() => -1);
        throw new Error(`after 7 quick toggles c saw the final state only after 5 s (+${late} ms)`);
      }
      // Stays converged (no stale state arriving later).
      await a.page.waitForTimeout(3_000);
      assert((await rowAtC())?.presence?.available === true, "stale presence arrived later");
      return `on ${JSON.stringify(on)}; single change ${single} ms; after 7 toggles ${burst} ms`;
    });

    // ----------------------------------------------------------------------------------- 11
    await check(
      11,
      "federation stream closes idle; after ~70 s a new call still works",
      async () => {
        need(aToC, "no connection");
        await a.page.waitForTimeout(70_000);
        const r = await connectedCall(a, c, a);
        return `connected after 70 s idle (${r.types.join("/")})`;
      },
    );

    // ----------------------------------------------------------------------------------- 10
    await check(
      10,
      "c blocks a → a's call refused, a's new knock gets the neutral answer",
      async () => {
        need(aToC && cToA, "no connection");
        const blk = await api(c.person, `/connections/${cToA}/block`, { method: "POST" });
        assert(blk.status === 204, `block ${blk.status}`);
        await until(
          "a's connection gone",
          async () =>
            !(await conns(a.person)).some(
              (x) => x.address === c.person.address && x.state === "active",
            ),
        );
        const s = await appSocket(a.person);
        const seen: Record<string, unknown>[] = [];
        s.ws.addEventListener("message", (e) => seen.push(JSON.parse(String(e.data))));
        s.send({ t: "call.connection", connectionId: aToC });
        const m = await until("refusal", () =>
          seen.find((x) => x.t === "error" || (x.t === "call.state" && x.state === "ended")),
        );
        s.ws.close();
        await c.page.waitForTimeout(1_000);
        assert((await c.overlay().count()) === 0, "c's app rang");
        const again = await api(a.person, "/connections", { body: { to: c.person.address } });
        assert(again.status === 202 && again.json?.status === "sent", `knock ${again.status}`);
        const mine = (await conns(c.person))
          .filter((x) => x.address === a.person.address)
          .map((x) => x.state);
        assert(mine.join() === "blocked", `c sees ${mine.join()}`);
        return `call → ${m.t === "error" ? `error ${m.code}` : `ended (${m.reason})`}; knock → 202 sent; c sees blocked`;
      },
    );

    for (const p of [...people, ...phones]) await p.context?.close().catch(() => {});
  },
  40 * 60_000,
);
