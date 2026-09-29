// LIVE end-to-end check against deployed servers, with real browsers (Chromium, fake media,
// virtual passkeys). Never runs in CI; opt in with OLP_LIVE=1:
//
//   OLP_LIVE=1 PLAYWRIGHT_CORE=/path/to/node_modules/playwright-core \
//     npx vitest run tests/e2e/live
//
// Env:
//   OLP_LIVE_A       server for the single-server checks (default https://t1.openloungephone.app)
//   OLP_LIVE_C/_D    servers of the two people in the cross-server checks (default: OLP_LIVE_A)
//   OLP_LIVE_HUB     the public hub, for its public checks (default https://hub.openloungephone.app)
//   OLP_LIVE_RUN     suffix for the test handles (olptest-a-<run>, …; default random)
//   OLP_LIVE_HEADED  1 = show the browsers
//   OLP_LIVE_KEEP    1 = don't delete the test accounts at the end
//   OLP_LIVE_OUT     where failure screenshots and the result JSON go (default: the OS temp dir)
//   OLP_LIVE_STATE   JSON file of test accounts (handle, session, passkey) to reuse between runs;
//                    sign-up is limited per IP per hour, so use it with OLP_LIVE_KEEP=1 while
//                    debugging. Delete the accounts at the end with a last run without KEEP.
//   OLP_LIVE_ONLY    comma-separated check numbers to run (the rest are SKIPPED)
//
// It only ever creates, uses and deletes accounts whose handles start with `olptest-`.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
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
  type StoredCredential,
  selectedCandidateType,
  setForceRelay,
  until,
} from "./browser.ts";

/** Signs `who` up through the UI, or reuses the account saved in $OLP_LIVE_STATE. */
async function ensure(browser: Browser, who: string, c: Companion, name: string): Promise<boolean> {
  await c.open(browser);
  const s = saved[who];
  if (s && s.origin === c.origin) {
    await c.addCredentials(s.creds);
    await c.resume(s.token);
    await c.refreshPerson();
    return false;
  }
  await c.signUp(name);
  if (STATE) {
    saved[who] = {
      handle: c.handle,
      origin: c.origin,
      token: c.person.token,
      creds: await c.credentials(),
    };
    writeFileSync(STATE, JSON.stringify(saved, null, 2));
  }
  return true;
}

const LIVE = process.env.OLP_LIVE === "1";
const A = process.env.OLP_LIVE_A ?? "https://t1.openloungephone.app";
const C = process.env.OLP_LIVE_C ?? A;
const D = process.env.OLP_LIVE_D ?? A;
const HUB = process.env.OLP_LIVE_HUB ?? "https://hub.openloungephone.app";
const RUN = process.env.OLP_LIVE_RUN ?? Math.random().toString(36).slice(2, 7);
const OUT = process.env.OLP_LIVE_OUT ?? tmpdir();
const STATE = process.env.OLP_LIVE_STATE;
type Saved = { handle: string; origin: string; token: string; creds: StoredCredential[] };
const saved: Record<string, Saved> =
  STATE && existsSync(STATE) ? JSON.parse(readFileSync(STATE, "utf8")) : {};
const ONLY = process.env.OLP_LIVE_ONLY
  ? new Set(process.env.OLP_LIVE_ONLY.split(",").map((x) => Number(x.trim())))
  : undefined;
const selected = (...ids: number[]) => !ONLY || ids.some((i) => ONLY.has(i));
const handle = (who: string) => saved[who]?.handle ?? `olptest-${who}-${RUN}`;
const hostOf = (origin: string) => new URL(origin).host;

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
      const path = join(OUT, `olp-live-${RUN}-${id}.png`);
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

const json = (p: Person, path: string, init?: { method?: string; body?: unknown }) =>
  api(p, path, init);

/**
 * Records "just your name" as the greeting in the companion (the fake microphone speaks) and
 * sets a short ring time, so a no-answer test doesn't wait 25 s.
 */
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

/** Back to the standard greeting and ring time, and removes test messages from `fromLabel`. */
async function resetVoicemail(p: Person, fromLabel: string): Promise<void> {
  await api(p, "/voicemail/greeting", { method: "DELETE" });
  await api(p, "/voicemail/settings", { method: "PATCH", body: { ringSeconds: 25 } });
  const list = ((await api(p, "/voicemails")).json ?? []) as { id: string; fromLabel: string }[];
  for (const v of list.filter((x) => x.fromLabel === fromLabel)) {
    await api(p, `/voicemails/${v.id}`, { method: "DELETE" });
  }
}

/** Watches a page for the greeting it fetches with a voicemail ticket. */
function greetingSeen(page: Page): () => { status: number; kind: string | undefined } | undefined {
  let seen: { status: number; kind: string | undefined } | undefined;
  type Res = { url(): string; status(): number; headers(): Record<string, string> };
  page.on("response", (r: Res) => {
    if (r.url().includes("/api/vm/greeting")) {
      seen = { status: r.status(), kind: r.headers()["olp-greeting"] };
    }
  });
  return () => seen;
}

/** A person's app socket pinned to a household (the one they act in), to observe or refuse. */
async function socketIn(p: Person, householdId: string) {
  return appSocket({ ...p, householdId });
}

/** Waits for a message on a raw socket (from twoServers/scenario) matching `pred`. */
async function nextWhere(
  sock: Awaited<ReturnType<typeof appSocket>>,
  t: string,
  pred: (m: Record<string, unknown>) => boolean,
) {
  for (;;) {
    const m = await sock.next(t);
    if (pred(m)) return m;
  }
}

let browser: Browser | undefined;
const people: Companion[] = [];
const phones: Phone[] = [];

async function cleanup(): Promise<string[]> {
  const left: string[] = [];
  for (const [who, sv] of Object.entries(saved)) {
    if (people.some((p) => p.handle === sv.handle && p.person)) continue;
    const c = new Companion(sv.origin, sv.handle);
    c.person = { server: c.server, token: sv.token, householdId: "", address: "" };
    people.push(c);
    console.log(`cleanup also: ${who} ${sv.handle}`);
  }
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
    } else console.log(`deleted ${c.handle}@${hostOf(c.origin)}`);
  }
  return left;
}

afterAll(async () => {
  if (!LIVE) return;
  let left: string[] = [];
  if (process.env.OLP_LIVE_KEEP !== "1") {
    left = await cleanup();
    if (STATE && left.length === 0) writeFileSync(STATE, "{}");
  }
  await browser?.close().catch(() => {});
  const report = { run: RUN, servers: { A, C, D, HUB }, results, cleanupLeft: left };
  const path = join(OUT, `olp-live-${RUN}.json`);
  writeFileSync(path, JSON.stringify(report, null, 2));
  console.log(`\n=== results (${path}) ===`);
  for (const r of results.sort((x, y) => x.id - y.id)) {
    console.log(`${String(r.id).padStart(2)} ${r.status.padEnd(7)} ${r.title} — ${r.note}`);
  }
  console.log(
    left.length ? `cleanup left: ${left.join("; ")}` : "cleanup: all test accounts deleted",
  );
}, 120_000);

it.skipIf(!LIVE)(
  "live: Open Lounge Phone on production servers",
  async () => {
    const pw = await import(process.env.PLAYWRIGHT_CORE ?? "playwright-core");
    const chromium = pw.chromium ?? pw.default?.chromium;
    browser = (await chromium.launch({
      headless: process.env.OLP_LIVE_HEADED !== "1",
      args: CHROMIUM_ARGS,
    })) as Browser;
    const b0 = browser;
    const hostA = hostOf(A);

    // ---------------------------------------------------------------- A. single server
    const a = new Companion(A, handle("a"));
    const b = new Companion(A, handle("b"));
    people.push(a, b);
    const kid = new Phone(A, `kid-${RUN}`);
    const lounge = new Phone(A, `lounge-${RUN}`);
    phones.push(kid, lounge);
    let kidId: string | undefined;
    let loungeId: string | undefined;
    let bUserId: string | undefined;
    let bInA = false;

    const needA = selected(1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 22);
    if (needA && ONLY && !ONLY.has(1)) await ensure(b0, "a", a, "olptest-a");
    await check(1, "sign up with a passkey; /api/me shows handle@host", async () => {
      focus = a.page;
      const fresh = await ensure(b0, "a", a, "olptest-a");
      if (!fresh) throw new Skip("reused a saved account");
      const me = await json(a.person, "/me");
      assert(
        me.json.account.address === `${a.handle}@${hostA}`,
        `address ${me.json.account.address}`,
      );
      const creds = await a.credentials();
      assert(creds.length === 1 && creds[0]?.isResidentCredential, "one resident passkey");
      return me.json.account.address;
    });
    const aOk = !!a.person;
    if (STATE && aOk) {
      saved.a = { ...(saved.a as Saved), token: a.person.token };
      writeFileSync(STATE, JSON.stringify(saved, null, 2));
    }

    await check(2, "sign out, then sign in with the passkey", async () => {
      need(aOk, "no account from 1");
      const before = a.person.token;
      await a.signOut();
      assert(
        (await api({ server: a.server, token: before }, "/me")).status === 401,
        "old session still valid",
      );
      await a.signIn();
      await a.refreshPerson();
      assert(a.person.token !== before, "same token after sign-in");
      const me = await json(a.person, "/me");
      assert(me.json.account.handle === a.handle, "signed in as someone else");
      await a.resume(a.person.token);
      if (STATE) {
        saved.a = { ...(saved.a as Saved), token: a.person.token };
        writeFileSync(STATE, JSON.stringify(saved, null, 2));
      }
    });

    await check(
      3,
      "pair a browser phone (Kids) with the 6-digit code in the companion",
      async () => {
        need(aOk, "no account");
        await kid.open(b0, "kids");
        focus = kid.page;
        const code = (await kid.facts()).pairing;
        focus = a.page;
        await a.tab("Home");
        await a.page.getByRole("button", { name: "+ Pair a phone" }).click();
        await a.page.getByLabel("Pairing code").fill(code);
        await a.page.getByRole("textbox", { name: /^Phone name/ }).fill("Kid phone");
        await a.page.getByRole("button", { name: "Pair phone" }).click();
        kidId = await kid.authed();
        const list = (await json(a.person, "/devices")).json as { id: string; kind: string }[];
        const d = list.find((x) => x.id === kidId);
        assert(d?.kind === "kids", `device kind ${d?.kind}`);
        await until(
          "Kid phone on Home",
          async () => (await a.page.locator("li.device", { hasText: "Kid phone" }).count()) > 0,
        );
        return `${kidId}`;
      },
    );

    await check(4, "phone → guardian call: ring, answer, connected, hang up (phone)", async () => {
      need(kidId, "no paired phone");
      focus = a.page;
      const [pa, pk] = [await a.pcCount(), await kid.pcCount()];
      await kid.hook();
      await kid.press("1");
      await a.answer();
      await pcConnected(a.page, pa);
      await pcConnected(kid.page, pk);
      await kid.hook();
      await a.ended();
      await kid.waitKind("idle");
      assert((await lastPc(a.page)).state !== "connected", "companion media still connected");
    });

    await check(
      5,
      "guardian → phone call: ring, answer, connected, hang up (guardian)",
      async () => {
        need(kidId, "no paired phone");
        focus = a.page;
        const [pa, pk] = [await a.pcCount(), await kid.pcCount()];
        await a.tab("Home");
        await a.page
          .locator("li.device", { hasText: "Kid phone" })
          .getByRole("button", { name: "Call" })
          .click();
        await kid.waitKind("incoming");
        await kid.hook();
        await pcConnected(a.page, pa);
        await pcConnected(kid.page, pk);
        await a.hangUp();
        await kid.waitKind("offhook");
        await kid.hook();
        await a.ended();
      },
    );

    await check(
      22,
      "phone → grown-up, no answer: a's name greeting plays, the message lands in a's inbox",
      async () => {
        need(kidId, "no paired phone");
        focus = a.page;
        await recordName(a, 10);
        const greeting = greetingSeen(kid.page);
        await kid.hook();
        await kid.press("1");
        await a.page.locator(".overlay-incoming").waitFor({ timeout: 20_000 }); // not answered
        await kid.waitKind("voicemail", 30_000);
        focus = kid.page;
        await until(
          "phone records",
          async () => (await kid.facts()).display.includes("RECORDING"),
          40_000,
        );
        const g = greeting();
        assert(g?.status === 200 && g.kind === "name", `greeting ${JSON.stringify(g)}`);
        await kid.page.waitForTimeout(4_000);
        await kid.hook(); // hang up to send
        await until("MESSAGE SENT", async () =>
          (await kid.facts()).display.includes("MESSAGE SENT"),
        );
        type Vm = {
          fromLabel: string;
          toUser: string | null;
          deviceId: string | null;
          durationMs: number;
        };
        const vm = await until("message in a's inbox", async () => {
          const list = (await json(a.person, "/voicemails")).json as Vm[];
          return list.find((v) => v.fromLabel === "Kid phone" && v.toUser);
        });
        assert(vm.deviceId === null && vm.durationMs >= 2_000, `voicemail ${JSON.stringify(vm)}`);
        focus = a.page;
        await a.page.locator("li.voicemail", { hasText: "Kid phone" }).first().waitFor();
        await resetVoicemail(a.person, "Kid phone");
        return `greeting ${g.kind}; message ${vm.durationMs} ms`;
      },
    );

    // olptest-b: own account, then joins a's household by invite (needed for 6, 7, 8, 10).
    const joinB = async () => {
      need(aOk, "no account");
      focus = b.page;
      await ensure(b0, "b", b, "olptest-b");
      const mine = (await json(b.person, "/me")).json.memberships as { householdId: string }[];
      if (mine.some((m) => m.householdId === a.person.householdId)) {
        const users = (await json(a.person, "/users")).json as { id: string; name: string }[];
        bUserId = users.find((u) => u.name === "olptest-b")?.id;
        bInA = !!bUserId;
        return "reused";
      }
      const inv = await json(a.person, "/invites", {
        body: { name: "olptest-b", role: "contact" },
      });
      assert(inv.status === 201, `invite ${inv.status} ${JSON.stringify(inv.json)}`);
      // A hash-only change doesn't reload the app, so load it fresh.
      await b.page.goto("about:blank");
      await b.page.goto(`${A}/#invite=${inv.json.token}`);
      await b.page.getByRole("button", { name: /^(Join|Sign in)$/ }).click();
      await until("b is a member of a's household", async () => {
        const me = await json(b.person, "/me");
        return (me.json.memberships as { householdId: string }[]).some(
          (m) => m.householdId === a.person.householdId,
        );
      });
      const users = (await json(a.person, "/users")).json as {
        id: string;
        name: string;
        accountId?: string;
      }[];
      bUserId = users.find((u) => u.name === "olptest-b")?.id;
      assert(bUserId, "b not in a's people");
      bInA = true;
      await b.resume(b.person.token);
      return "joined as contact";
    };
    if (selected(6, 7, 8, 10)) {
      const joined =
        ONLY && !ONLY.has(8)
          ? await joinB().then(
              () => true,
              (e) => {
                console.log(`join b: ${e}`);
                return false;
              },
            )
          : await check(8, "invite olptest-b by link → joins (part 1 of 8)", joinB);
      // Remove the part-1 row; item 8's final verdict is recorded below.
      if (joined && (!ONLY || ONLY.has(8))) results.pop();
    }

    await check(6, "allow-list: a non-allowed person can't call the phone (denied)", async () => {
      need(kidId && bInA, "needs the phone and olptest-b");
      focus = b.page;
      await b.tab("Home");
      const btn = b.page
        .locator("li.device", { hasText: "Kid phone" })
        .getByRole("button", { name: "Call" });
      assert(await btn.isDisabled(), "Call button enabled for a non-allowed person");
      const s = await socketIn(b.person, a.person.householdId);
      s.send({ t: "call.dial", deviceId: kidId as string });
      const m = await nextWhere(s, "call.state", (x) => x.state === "ended");
      s.ws.close();
      assert(m.reason === "denied", `reason ${m.reason}`);
      assert((await kid.kind()) === "idle", "phone rang");
      return "UI button disabled; server says denied";
    });

    await check(
      7,
      "quiet hours → voicemail (5 s) → inbox → transcript → missed → heard",
      async () => {
        need(kidId && bInA && bUserId, "needs the phone and olptest-b");
        focus = b.page;
        const put = await json(a.person, `/devices/${kidId}/contacts/${bUserId}`, {
          method: "PUT",
          body: { label: "B", canCallDevice: true, deviceCanCall: true, bypassQuietHours: false },
        });
        assert(put.status === 204, `allow b: ${put.status}`);
        const allDay = [{ days: [0, 1, 2, 3, 4, 5, 6], start: "00:00", end: "23:59" }];
        const q = await json(a.person, "/quiet-hours", { method: "PUT", body: { rules: allDay } });
        assert(q.status < 300, `quiet hours ${q.status} ${JSON.stringify(q.json)}`);
        await b.page.reload();
        await b.tab("Home");
        const call = b.page
          .locator("li.device", { hasText: "Kid phone" })
          .getByRole("button", { name: "Call" });
        await until("Call enabled for b", async () => !(await call.isDisabled()));
        await call.click();
        // The phone's greeting plays, then the tone, then it records; hang up to send.
        await b
          .overlay()
          .getByText(/Recording ·/)
          .waitFor({ timeout: 30_000 });
        await b.page.waitForTimeout(5_500);
        await b.overlay().getByRole("button", { name: "Hang up & send" }).click();
        await b.page.getByText(/Message sent to/).waitFor({ timeout: 20_000 });
        assert((await kid.kind()) === "idle", "phone rang during quiet hours");
        type Vm = {
          id: string;
          deviceId: string;
          fromLabel: string;
          durationMs: number;
          transcriptStatus: string;
          transcript: string | null;
        };
        const vm = await until("voicemail in the inbox", async () => {
          const list = (await json(a.person, "/voicemails")).json as Vm[];
          return list.find((v) => v.deviceId === kidId || v.fromLabel === "B");
        });
        assert(vm.durationMs >= 4_000, `duration ${vm.durationMs}`);
        focus = a.page;
        await a.tab("Voicemail");
        await a.page.getByText("B", { exact: false }).first().waitFor();
        const done = await until(
          "transcript",
          async () => {
            const list = (await json(a.person, "/voicemails")).json as Vm[];
            const v = list.find((x) => x.id === vm.id);
            return v && v.transcriptStatus !== "pending" ? v : undefined;
          },
          60_000,
          2_000,
        );
        focus = kid.page;
        await until("phone shows missed", async () => {
          const f = await kid.facts();
          return f.missed !== "—" && f.missed !== "" ? f.missed : undefined;
        });
        const heard = await json(a.person, `/voicemails/${vm.id}/heard`, { method: "POST" });
        assert(heard.status === 204, `heard ${heard.status}`);
        await until("missed cleared", async () => (await kid.facts()).missed === "—");
        await json(a.person, "/quiet-hours", { method: "PUT", body: { rules: [] } });
        assert(done.transcriptStatus === "done", `transcript ${done.transcriptStatus}`);
        return `transcript: ${JSON.stringify(done.transcript)}`;
      },
    );

    await check(8, "invite → join; grown-up ↔ grown-up call; unavailable → refused", async () => {
      need(bInA && bUserId, "olptest-b didn't join");
      focus = a.page;
      await a.page.reload();
      await a.tab("Home");
      const [pa, pb] = [await a.pcCount(), await b.pcCount()];
      await a.page
        .locator("li.device", { hasText: "olptest-b" })
        .getByRole("button", { name: "Call" })
        .click();
      focus = b.page;
      await b.answer();
      await pcConnected(a.page, pa);
      await pcConnected(b.page, pb);
      await b.hangUp();
      await a.ended();
      await b.ended();
      // b turns availability off; a's call is refused.
      await b.tab("Home");
      const sw = b.page.getByRole("switch", { name: "Available for calls" });
      await sw.click();
      await until("b unavailable", async () => (await sw.getAttribute("aria-checked")) === "false");
      const s = await socketIn(a.person, a.person.householdId);
      s.send({ t: "call.user", userId: bUserId as string });
      const m = await nextWhere(s, "call.state", (x) => x.state === "ended");
      s.ws.close();
      await sw.click();
      assert(m.reason === "unavailable", `refusal reason ${m.reason}`);
      return "call connected both ways; unavailable refused";
    });

    await check(9, "create a second space, switch to it, then back", async () => {
      need(aOk, "no account");
      const home = a.person.householdId;
      const made = await json(a.person, "/spaces", {
        body: { name: "olptest team", type: "team" },
      });
      assert(made.status === 201, `create ${made.status} ${JSON.stringify(made.json)}`);
      const team = made.json.household.id as string;
      let me = await json(a.person, "/me");
      assert(me.json.household.id === team, "new space not active");
      await a.page.reload();
      await a.page.locator(".topbar").getByText("olptest team").first().waitFor();
      const back = await json(a.person, "/me/household", {
        method: "PUT",
        body: { householdId: home },
      });
      assert(back.status === 204, `switch back ${back.status}`);
      me = await json(a.person, "/me");
      assert(me.json.household.id === home, "not back home");
      assert(me.json.memberships.length >= 2, "memberships");
      await a.page.reload();
      await a.page.locator("nav.tabs").waitFor();
    });

    await check(
      10,
      "Lounge: takeover with key proof, wrong key/replay refused, rings, log out",
      async () => {
        need(bInA && bUserId, "needs olptest-b in the household");
        await lounge.open(b0, "lounge");
        focus = lounge.page;
        const code = (await lounge.facts()).pairing;
        await a.tab("Home");
        await a.page.getByRole("button", { name: "+ Pair a phone" }).click();
        await a.page.getByLabel("Pairing code").fill(code);
        await a.page.getByRole("textbox", { name: /^Phone name/ }).fill("Lounge phone");
        await a.page.getByLabel(/^Kind of phone/).selectOption("lounge");
        await a.page.getByRole("button", { name: "Pair phone" }).click();
        loungeId = await lounge.authed();
        const nonceAfter = async (n: number) => {
          const m = await until("lounge.idle", async () => {
            const idle = lounge.frames.filter((f) => f.t === "lounge.idle");
            return idle.length > n ? idle.at(-1) : undefined;
          });
          return m.nonce as string;
        };
        const idles = () => lounge.frames.filter((f) => f.t === "lounge.idle").length;
        const digitOf = (index: number) => String(index === 9 ? 0 : index + 1);

        // Wrong key. The phone can get a second code right after connecting, so claim with the
        // newest one and retry once if the server says it's stale.
        const s = await socketIn(b.person, a.person.householdId);
        const log: Record<string, unknown>[] = [];
        s.ws.addEventListener("message", (e) => log.push(JSON.parse(String(e.data))));
        await nonceAfter(0);
        await lounge.page.waitForTimeout(1_500);
        let n1 = "";
        let first: Record<string, unknown> | undefined;
        for (let attempt = 0; attempt < 3 && first?.step !== "press_key"; attempt++) {
          n1 = (lounge.lastFrame("lounge.idle")?.nonce as string) ?? "";
          const before = log.length;
          s.send({ t: "lounge.claim", deviceId: loungeId, nonce: n1 });
          first = await until("claim answer", () =>
            log.slice(before).find((m) => m.t === "lounge.progress" || m.t === "error"),
          );
          if (first.step !== "press_key") console.log(`claim refused: ${JSON.stringify(first)}`);
        }
        assert(first?.step === "press_key", `claim refused: ${JSON.stringify(first)}`);
        let seen = idles();
        const ch = await until("lounge.challenge", async () =>
          lounge.lastFrame("lounge.challenge"),
        );
        await lounge.press(digitOf(((ch.index as number) + 1) % 10));
        const wrong = await until("wrong-key failure", () =>
          log.find((m) => m.t === "lounge.progress" && m.step === "failed"),
        );
        assert(wrong.reason === "wrong_key", `wrong key → ${wrong.reason}`);
        // Replay of the used nonce.
        const mark = log.length;
        s.send({ t: "lounge.claim", deviceId: loungeId, nonce: n1 });
        const replay = await until("replay answer", () =>
          log.slice(mark).find((m) => m.t === "lounge.progress"),
        );
        assert(replay.step === "failed", "replayed nonce accepted");
        s.ws.close();

        // The real takeover, through the companion's /lounge page.
        const n2 = await nonceAfter(seen);
        assert(n2 !== n1, "nonce not rotated");
        seen = lounge.frames.filter((f) => f.t === "lounge.challenge").length;
        focus = b.page;
        await b.page.goto(`${A}/lounge#${loungeId}.${n2}`);
        await b.ready();
        await b.page.getByRole("button", { name: "Use this phone" }).click();
        const ch2 = await until("second challenge", async () => {
          const all = lounge.frames.filter((f) => f.t === "lounge.challenge");
          return all.length > seen ? all.at(-1) : undefined;
        });
        await lounge.press(digitOf(ch2.index as number));
        await b.page.getByText(/You're on/).waitFor({ timeout: 15_000 });
        focus = lounge.page;
        await until("HI on the strip", async () =>
          /HI OLPTEST-B/.test((await lounge.facts()).display),
        );

        // A call to b rings the Lounge phone.
        const sa = await socketIn(a.person, a.person.householdId);
        sa.send({ t: "call.user", userId: bUserId as string });
        await lounge.waitKind("incoming");
        const st = await sa.next("call.state");
        sa.send({ t: "call.hangup", callId: st.callId as string });
        await lounge.waitKind("idle");
        sa.ws.close();
        await b.ended().catch(() => {});

        // MENU → 9 = Log out.
        await lounge.press("m");
        await lounge.press("9");
        await until("lounge.ended logout", async () => {
          const e = lounge.lastFrame("lounge.ended");
          return e?.reason === "logout";
        });
        await until("SCAN TO USE", async () => /SCAN TO USE/.test((await lounge.facts()).display));
        return `wrong key → wrong_key; replay → ${replay.reason}`;
      },
    );

    await check(11, "fair-use counter (hub) and funding card shows $150", async () => {
      const hub = await (await fetch(`${HUB}/api/hub`)).json();
      assert(hub.funding?.balanceUsd === 150, `hub funding ${JSON.stringify(hub.funding)}`);
      assert(hub.fairUse?.callMinutesPerMonth, "hub has no fair use");
      if (hostOf(A) !== hostOf(HUB)) {
        throw new Skip(
          `hub /api/hub: funding $${hub.funding.balanceUsd}, fair use on (API PASS); ` +
            "the in-app cards need a hub account (sign-up needs a human)",
        );
      }
      await a.tab("Account");
      await a.page.getByText("Fair use this month").waitFor();
      await a.page.locator(".funding").getByText("$150").first().waitFor();
    });

    await check(
      12,
      "Sponsor button hidden (SPONSOR_URL unset) and the unsubscribe.llc credit",
      async () => {
        need(aOk, "no account");
        focus = a.page;
        await a.tab("Account");
        await a.page.getByText("Proudly supported by unsubscribe.llc").waitFor();
        const link = a.page.getByRole("link", { name: "Proudly supported by unsubscribe.llc" });
        assert((await link.getAttribute("href")) === "https://www.unsubscribe.llc/", "credit link");
        assert((await a.page.getByText("Sponsor the hub").count()) === 0, "Sponsor button shown");
        const info = await (await fetch(`${A}/api/hub`)).json();
        const hub = await (await fetch(`${HUB}/api/hub`)).json();
        assert(info.sponsorUrl === null && hub.sponsorUrl === null, "sponsorUrl set");
      },
    );

    // ---------------------------------------------------------------- B. across servers
    await check(13, "/.well-known/openloungephone on every server", async () => {
      const hosts = [...new Set([HUB, A, C, D])];
      for (const h of hosts) {
        const w = await (await fetch(`${h}/.well-known/openloungephone`)).json();
        assert(w.version === 1 && /^[\w-]{43}$/.test(w.server_key), `${h}: ${JSON.stringify(w)}`);
        assert(w.federation === "/fed/v1", `${h}: federation path`);
      }
      return hosts.map(hostOf).join(", ");
    });

    const c = new Companion(C, handle("c"));
    const d = new Companion(D, handle("d"));
    people.push(c, d);
    let cToD: string | undefined;
    let dToC: string | undefined;

    const connectCD = async () => {
      await ensure(b0, "c", c, "olptest-c");
      await ensure(b0, "d", d, "olptest-d");
      const existing = (
        (await json(c.person, "/connections")).json.connections as {
          id: string;
          address: string;
          state: string;
        }[]
      ).find((x) => x.address === d.person.address && x.state === "active");
      if (existing) {
        cToD = existing.id;
        dToC = (await json(d.person, "/connections")).json.connections.find(
          (x: { address: string }) => x.address === c.person.address,
        )?.id;
        return "reused";
      }
      focus = c.page;
      await c.tab("Connect");
      await c.page.getByLabel("Their address").fill(d.person.address);
      await c.page.getByRole("button", { name: "Knock" }).click();
      await c.page.getByText(`If ${d.person.address} exists`).waitFor();
      focus = d.page;
      await d.page.reload();
      await d.tab("Connect");
      await d.page.getByText("Knocks for you").waitFor({ timeout: 20_000 });
      await d.page.getByRole("button", { name: "Accept" }).click();
      const cc = await until("c sees active", async () => {
        const list = (await json(c.person, "/connections")).json.connections as {
          id: string;
          address: string;
          state: string;
        }[];
        return list.find((x) => x.address === d.person.address && x.state === "active");
      });
      const dc = (await json(d.person, "/connections")).json.connections.find(
        (x: { address: string }) => x.address === c.person.address,
      );
      assert(dc?.state === "active", `d's row ${dc?.state}`);
      cToD = cc.id;
      dToC = dc.id;
      return C === D ? "t1↔t1 (two accounts on one server)" : "";
    };
    if (selected(14, 15, 16, 17, 18, 19, 20, 21, 23)) {
      if (ONLY && !ONLY.has(14)) await connectCD().catch((e) => console.log(`connect c,d: ${e}`));
      else await check(14, "c knocks d → shows for d → accept → both active", connectCD);
    }

    const connectedCall = async (
      from: Companion,
      to: Companion,
      toAddress: string,
      hangBy: Companion,
    ) => {
      await from.page.reload();
      await from.ready();
      await to.ready();
      const [pf, pt] = [await from.pcCount(), await to.pcCount()];
      await from.tab("Connect");
      await from.page
        .locator("li.card", { hasText: toAddress })
        .getByRole("button", { name: "Call", exact: true })
        .first()
        .click();
      focus = to.page;
      await to.answer().catch(async (e) => {
        const o = await from
          .overlay()
          .innerText()
          .catch(() => "");
        throw new Error(`${to.handle} never rang; caller shows "${o.replace(/\s+/g, " ")}" (${e})`);
      });
      const pc = await pcConnected(from.page, pf).catch(async (e) => {
        const [x, y] = [await lastPc(from.page), await lastPc(to.page)];
        throw new Error(
          `${from.handle}→${to.handle} media: caller pcs=${x.count - pf} ${x.state} [${x.states}], callee pcs=${y.count - pt} ${y.state} [${y.states}] (${e})`,
        );
      });
      await pcConnected(to.page, pt);
      await hangBy.hangUp();
      await from.ended();
      await to.ended();
      return pc;
    };

    let turnC: string | undefined;
    await check(15, "connection call c→d and d→c: ring, answer, connected, hang up", async () => {
      need(cToD, "no connection");
      const pc = await connectedCall(c, d, d.person.address, c);
      turnC = JSON.stringify(pc.iceServers);
      await connectedCall(d, c, c.person.address, c);
    });

    await check(
      23,
      "connection call c→d, no answer: d's name greeting (fetched across servers), message in d's inbox",
      async () => {
        need(cToD, "no connection");
        focus = d.page;
        await recordName(d, 10);
        await c.page.reload();
        await c.ready();
        const greeting = greetingSeen(c.page);
        await c.tab("Connect");
        await c.page
          .locator("li.card", { hasText: d.person.address })
          .getByRole("button", { name: "Call", exact: true })
          .first()
          .click();
        await d.page.locator(".overlay-incoming").waitFor({ timeout: 20_000 }); // not answered
        focus = c.page;
        await c
          .overlay()
          .getByText(/Recording ·/)
          .waitFor({ timeout: 40_000 });
        const g = greeting();
        assert(g?.status === 200 && g.kind === "name", `greeting ${JSON.stringify(g)}`);
        await c.page.waitForTimeout(4_000);
        await c.overlay().getByRole("button", { name: "Hang up & send" }).click();
        await c.page.getByText(/Message sent to/).waitFor({ timeout: 20_000 });
        const cName = "olptest-c";
        type Vm = { fromLabel: string; toUser: string | null };
        await until("message in d's inbox", async () => {
          const list = (await json(d.person, "/voicemails")).json as Vm[];
          return list.find((v) => v.toUser && v.fromLabel.startsWith(cName));
        });
        await resetVoicemail(d.person, cName);
        return `greeting ${g.kind} via ${hostOf(C)} → ${hostOf(D)}`;
      },
    );

    await check(20, "rtc.config has TURN servers with credentials", async () => {
      need(turnC, "no call media from 15");
      const servers = JSON.parse(turnC) as RTCIceServer[];
      const turn = servers.filter((s) => [s.urls].flat().some((u) => /^turns?:/.test(u)));
      assert(turn.length > 0, `no turn: urls in ${turnC}`);
      assert(
        turn.every((s) => s.username && s.credential),
        "TURN without credentials",
      );
      if (hostOf(HUB) !== hostOf(C) && hostOf(HUB) !== hostOf(A)) {
        return `${hostOf(C)}: ${[turn[0]?.urls].flat().join(" ")} (hub not checked: no hub account)`;
      }
      return [turn[0]?.urls].flat().join(" ");
    });

    await check(
      21,
      "a call with iceTransportPolicy relay on both ends connects via TURN",
      async () => {
        need(cToD, "no connection");
        await c.page.reload();
        await d.page.reload();
        await setForceRelay(c.page, true);
        await setForceRelay(d.page, true);
        const [pf, pt] = [await c.pcCount(), await d.pcCount()];
        await c.tab("Connect");
        await c.page
          .locator("li.card", { hasText: d.person.address })
          .getByRole("button", { name: "Call", exact: true })
          .first()
          .click();
        await d.answer();
        const x = await pcConnected(c.page, pf, 40_000);
        await pcConnected(d.page, pt, 40_000);
        const types = [await selectedCandidateType(c.page), await selectedCandidateType(d.page)];
        await c.hangUp();
        await c.ended();
        await d.ended();
        await c.page.reload();
        await d.page.reload();
        assert(x.relayPolicy, "relay policy not applied");
        assert(
          types.every((t) => t === "relay"),
          `selected candidates ${types.join(",")}`,
        );
        return `selected local candidates: ${types.join(", ")}`;
      },
    );

    await check(17, "presence (opt-in) shows up for the connection", async () => {
      need(dToC, "no connection");
      const off = (await json(d.person, "/connections")).json.connections.find(
        (x: { id: string }) => x.id === dToC,
      );
      const patch = await json(c.person, "/account", {
        method: "PATCH",
        body: { sharePresence: true },
      });
      assert(patch.status < 300, `share ${patch.status}`);
      const on = await until("presence for c at d", async () => {
        const row = (await json(d.person, "/connections")).json.connections.find(
          (x: { id: string }) => x.id === dToC,
        );
        return row?.presence ? row.presence : undefined;
      });
      // c goes unavailable: d sees it.
      await c.page.reload();
      await c.ready();
      await c.tab("Home");
      // Presence is rate-limited to 5 updates per 10 s per person; let the reload's pass.
      await c.page.waitForTimeout(11_000);
      const sw = c.page.getByRole("switch", { name: "Available for calls" });
      await sw.click();
      const unav = await until(
        "c unavailable at d",
        async () => {
          const row = (await json(d.person, "/connections")).json.connections.find(
            (x: { id: string }) => x.id === dToC,
          );
          return row?.presence && row.presence.available === false ? row.presence : undefined;
        },
        20_000,
      );
      await sw.click();
      return `before opt-in ${JSON.stringify(off?.presence ?? null)}; on ${JSON.stringify(on)}; then ${JSON.stringify(unav)}`;
    });

    let dPhone: Phone | undefined;
    await check(
      16,
      "voicemail across a connection (phone in quiet hours) with transcript",
      async () => {
        need(dToC, "no connection");
        dPhone = new Phone(D, `dkid-${RUN}`);
        phones.push(dPhone);
        await dPhone.open(b0, "kids");
        const code = (await dPhone.facts()).pairing;
        await d.tab("Home");
        await d.page.getByRole("button", { name: "+ Pair a phone" }).click();
        await d.page.getByLabel("Pairing code").fill(code);
        await d.page.getByRole("textbox", { name: /^Phone name/ }).fill(`D kid ${RUN}`);
        await d.page.getByRole("button", { name: "Pair phone" }).click();
        const dev = await dPhone.authed();
        const put = await json(d.person, `/devices/${dev}/remote-contacts/${dToC}`, {
          method: "PUT",
          body: { label: "C", canCallDevice: true, deviceCanCall: true, bypassQuietHours: false },
        });
        assert(put.status === 200, `remote contact ${put.status} ${JSON.stringify(put.json)}`);
        const allDay = [{ days: [0, 1, 2, 3, 4, 5, 6], start: "00:00", end: "23:59" }];
        await json(d.person, "/quiet-hours", { method: "PUT", body: { rules: allDay } });
        focus = c.page;
        await until("phone shared with c", async () => {
          const row = (await json(c.person, "/connections")).json.connections.find(
            (x: { id: string }) => x.id === cToD,
          );
          return row?.phones?.length ? row : undefined;
        });
        await c.page.reload();
        await c.ready();
        await c.tab("Connect");
        await c.page
          .locator(".shared-phones li", { hasText: `D kid ${RUN}` })
          .getByRole("button", { name: "Call" })
          .click();
        await c.page
          .getByRole("button", { name: "Record" })
          .click({ timeout: 20_000 })
          .catch(async (e: unknown) => {
            const o = await c
              .overlay()
              .innerText()
              .catch(() => "(no overlay)");
            throw new Error(`no Record offer; overlay: "${o.replace(/\s+/g, " ")}" (${e})`);
          });
        await c.page.waitForTimeout(5_500);
        await c.page.getByRole("button", { name: "Stop" }).click();
        await c.page.getByRole("button", { name: "Send" }).click();
        await c.page.getByText(/Message sent to/).waitFor({ timeout: 20_000 });
        type Vm = {
          id: string;
          deviceId: string;
          transcriptStatus: string;
          transcript: string | null;
        };
        const vm = await until(
          "voicemail at d with transcript",
          async () => {
            const list = (await json(d.person, "/voicemails")).json as Vm[];
            const v = list.find((x) => x.deviceId === dev);
            return v && v.transcriptStatus !== "pending" ? v : undefined;
          },
          60_000,
          2_000,
        );
        await json(d.person, "/quiet-hours", { method: "PUT", body: { rules: [] } });
        assert(vm.transcriptStatus === "done", `transcript ${vm.transcriptStatus}`);
        return `transcript: ${JSON.stringify(vm.transcript)}${C === D ? " (same server: host '' path)" : ""}`;
      },
    );

    await check(19, "knock to a nonexistent handle gets the neutral answer", async () => {
      need(c.person, "no account");
      focus = c.page;
      const ghosts = [`olptest-nobody-${RUN}@${hostOf(HUB)}`, `olptest-nobody-${RUN}@${hostOf(D)}`];
      for (const to of ghosts) {
        const r = await json(c.person, "/connections", { body: { to } });
        assert(
          r.status === 202 && r.json?.status === "sent",
          `${to}: ${r.status} ${JSON.stringify(r.json)}`,
        );
      }
      await c.page.reload();
      await c.tab("Connect");
      const ghost = `olptest-ghost-${RUN}@${hostOf(HUB)}`;
      await c.page.getByLabel("Their address").fill(ghost);
      await c.page.getByRole("button", { name: "Knock" }).click();
      await c.page.getByText(`If ${ghost} exists, they'll get your request.`).waitFor();
      return ghosts.concat(ghost).join(", ");
    });

    await check(
      18,
      "block: d blocks c → c's call refused, new knock gets the neutral answer",
      async () => {
        need(cToD && dToC, "no connection");
        const blk = await json(d.person, `/connections/${dToC}/block`, { method: "POST" });
        assert(blk.status === 204, `block ${blk.status}`);
        const cRows = (await json(c.person, "/connections")).json.connections as {
          id: string;
          address: string;
          state: string;
        }[];
        assert(
          !cRows.some((x) => x.address === d.person.address && x.state === "active"),
          "c still connected",
        );
        const s = await socketIn(c.person, c.person.householdId);
        const seen: Record<string, unknown>[] = [];
        s.ws.addEventListener("message", (e) => seen.push(JSON.parse(String(e.data))));
        s.send({ t: "call.connection", connectionId: cToD as string });
        const m = await until("refusal", () =>
          seen.find((x) => x.t === "error" || (x.t === "call.state" && x.state !== "requesting")),
        );
        s.ws.close();
        assert(m.t === "error" || m.state === "ended", `call not refused: ${JSON.stringify(m)}`);
        assert((await d.overlay().count()) === 0, "d's app rang");
        const again = await json(c.person, "/connections", { body: { to: d.person.address } });
        assert(again.status === 202 && again.json?.status === "sent", `knock ${again.status}`);
        const dRows = (await json(d.person, "/connections")).json.connections as {
          address: string;
          state: string;
        }[];
        const mine = dRows.filter((x) => x.address === c.person.address).map((x) => x.state);
        assert(mine.join() === "blocked", `d sees ${mine.join()}`);
        return `call → ${m.t === "error" ? `error ${m.code}: ${m.message}` : `ended (${m.reason})`}`;
      },
    );

    // Close the browsers before cleanup so no socket reconnects.
    for (const p of [...people, ...phones]) await p.context?.close().catch(() => {});
  },
  30 * 60_000,
);
