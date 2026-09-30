// LIVE end-to-end check of the ESP32 firmware (v0, signaling only) in the Wokwi simulator against
// a deployed server, with a real companion in Chromium (fake media, virtual passkey). Never runs
// in CI; opt in with OLP_LIVE=1 and OLP_FIRMWARE=1:
//
//   OLP_LIVE=1 OLP_FIRMWARE=1 PLAYWRIGHT_CORE=/path/to/node_modules/playwright-core \
//     OLP_CHROMIUM="/path/to/chrome" npx vitest run tests/e2e/live/firmware.test.ts
//
// Env: OLP_E2E_SERVER (required: a disposable test server with open sign-up, e.g.
// https://t2.openloungephone.app; never the owner's l1 — the test creates an account there; the
// simulator firmware is built for it: OLP_SIM_SERVER in firmware/tools/sim.sh), OLP_LIVE_OUT (logs, PNGs and the result JSON; default
// firmware/build-sim/e2e), OLP_LIVE_KEEP=1 (keep the test account), OLP_CHROMIUM (a Chromium
// binary if playwright-core's own isn't installed), OLP_FW_NO_BUILD=1 (skip the sim build),
// WOKWI_CLI_TOKEN or firmware/.wokwi-token, OLP_WOKWI_CLI.
//
// Two simulations (a Wokwi run lasts at most 5 minutes): A = steps 1-5 and 7, B = step 6.
// It only ever creates, uses and deletes an account whose handle starts with `olptest-`.
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Browser } from "playwright-core";
import { afterAll, it } from "vitest";
import { api, type Person } from "../twoServers.ts";
import { CHROMIUM_ARGS, Companion, until } from "./browser.ts";
import { buildSimFirmware, FIRMWARE, WokwiPhone } from "./wokwi.ts";

const A = process.env.OLP_E2E_SERVER ?? "";
const LIVE = process.env.OLP_LIVE === "1" && process.env.OLP_FIRMWARE === "1" && A !== "";
/** The simulator build's own server (firmware/sdkconfig.sim) is the owner's: never test there. */
if (LIVE && new URL(A).host === "l1.openloungephone.app") {
  throw new Error("OLP_E2E_SERVER must be a disposable test server, not l1");
}
const WSS = A.replace(/^http/, "ws").replace(/\/$/, "");
const RUN = process.env.OLP_LIVE_RUN ?? Math.random().toString(36).slice(2, 7);
const OUT = process.env.OLP_LIVE_OUT ?? join(FIRMWARE, "build-sim/e2e");
const PHONE_NAME = "Wokwi phone";

type Status = "PASS" | "FAIL" | "SKIPPED";
const results: { id: string; title: string; status: Status; note: string; ms: number }[] = [];
let browser: Browser | undefined;
let guardian: Companion | undefined;
const phones: WokwiPhone[] = [];

async function step(id: string, title: string, fn: () => Promise<unknown>): Promise<boolean> {
  const t0 = Date.now();
  try {
    const out = await fn();
    const note = typeof out === "string" ? out : "";
    results.push({ id, title, status: "PASS", note, ms: Date.now() - t0 });
    console.log(`PASS ${id}. ${title} (${Date.now() - t0} ms) ${note}`);
    return true;
  } catch (e) {
    const note = e instanceof Error ? e.message : String(e);
    results.push({ id, title, status: "FAIL", note, ms: Date.now() - t0 });
    console.log(`FAIL ${id}. ${title}: ${note}`);
    return false;
  }
}

function skip(id: string, title: string, why: string): void {
  results.push({ id, title, status: "SKIPPED", note: why, ms: 0 });
  console.log(`SKIPPED ${id}. ${title}: ${why}`);
}

function assert(cond: unknown, what: string): asserts cond {
  if (!cond) throw new Error(what);
}

const json = (p: Person, path: string, init?: { method?: string; body?: unknown }) =>
  api(p, path, init);

/** The display's framebuffer as a PNG next to the logs. */
async function snapshot(phone: WokwiPhone, name: string): Promise<void> {
  const dump = await phone.screen();
  const file = join(OUT, `${name}.fb.txt`);
  writeFileSync(file, dump);
  spawnSync("python3", [join(FIRMWARE, "tools/fb2png.py"), file, join(OUT, `${name}.png`)]);
}

/** Boots a simulation and returns the pairing code it shows. */
async function boot(phone: WokwiPhone): Promise<string> {
  phones.push(phone);
  phone.start();
  await phone.waitFor(/Open Lounge Phone firmware [\d.]+ \(simulator build\)/, 90_000, "boot");
  await phone.waitFor(/WIFI connected/, 60_000, "Wi-Fi");
  phone.send("hook down"); // the Wokwi hook button isn't held: put the handset down
  await phone.waitFor(
    new RegExp(`WS connecting ${WSS.replace(/[.]/g, "\\.")}/ws/device`),
    60_000,
    "test server",
  );
  await phone.waitFor(/WS open/, 90_000, "WebSocket open");
  await phone.waitFor(/"t":"pair\.begin","alg":"p256"/, 20_000, "pair.begin");
  const m = await phone.waitFor(/PAIRING CODE: (\d{6})/, 30_000, "pairing code");
  await phone.waitFor(/STRIP \[PAIR \d{3} \d{3}\|LIFT TO HEAR\]/, 10_000, "code on the strip");
  return m[1] as string;
}

/** Claims the phone as a Kids phone through the API; waits until it has signed in. */
async function pair(phone: WokwiPhone, g: Companion, code: string): Promise<string> {
  const preview = await json(g.person, "/devices/pair/preview", { body: { code } });
  const res = await json(g.person, "/devices/pair", {
    body: { code, name: PHONE_NAME, mode: "kids" },
  });
  assert(res.status < 300, `pair ${res.status} ${JSON.stringify(res.json)}`);
  const done = await phone.waitFor(/PAIRED device=(\S+) household/, 30_000, "pair.done");
  const id = done[1] as string;
  await phone.waitFor(/WS connecting wss:\/\/\S+\/ws\/device\?device=/, 10_000, "reconnect");
  await phone.waitFor(/"t":"auth\.challenge"/, 90_000, "auth.challenge");
  await phone.waitFor(/"t":"auth\.proof","sig":"[\w-]{86}"/, 20_000, "auth.proof");
  await phone.waitFor(/<- \{"t":"config"/, 20_000, "config");
  await phone.waitFor(/SIGNED IN as/, 10_000, "signed in");
  const strip = await phone.waitFor(/STRIP \[READY\|KIDS: [^\]]*\]/, 20_000, "idle strip");
  const words = /identity: fingerprint: (\w+) (\w+) (\w+) (\w+)/.exec(phone.log);
  assert(words, "no fingerprint in the boot log");
  const fw = words.slice(1, 5);
  const devices = (await json(g.person, "/devices")).json as {
    id: string;
    fingerprint: string[];
  }[];
  const server = devices.find((d) => d.id === id)?.fingerprint;
  assert(
    JSON.stringify(server) === JSON.stringify(fw),
    `words: phone ${fw.join(" ")}, server ${JSON.stringify(server)}`,
  );
  const pre = preview.json?.fingerprint as string[] | undefined;
  assert(
    !pre || JSON.stringify(pre) === JSON.stringify(fw),
    `preview words ${JSON.stringify(pre)}`,
  );
  return `${id}; words ${fw.join(" ")}; ${strip[0]}`;
}

afterAll(async () => {
  if (!LIVE) return;
  for (const p of phones) await p.stop();
  let cleanup = "kept (OLP_LIVE_KEEP=1)";
  if (guardian?.person && process.env.OLP_LIVE_KEEP !== "1") {
    const g = guardian;
    const res = await api(g.person, "/account", { method: "DELETE", body: { confirm: g.handle } });
    const after = await api(g.person, "/me");
    cleanup =
      res.status === 204 && after.status === 401
        ? `deleted ${g.handle}`
        : `NOT deleted ${g.handle}: ${res.status}, /me ${after.status}`;
  }
  await browser?.close().catch(() => {});
  const report = { run: RUN, server: A, results, cleanup };
  writeFileSync(join(OUT, `result-${RUN}.json`), JSON.stringify(report, null, 2));
  console.log(`\n=== firmware e2e ${RUN} (${OUT}) ===`);
  for (const r of results) {
    console.log(`${r.id.padStart(2)} ${r.status.padEnd(7)} ${r.title} (${r.ms} ms) — ${r.note}`);
  }
  console.log(`cleanup: ${cleanup}`);
}, 120_000);

it.skipIf(!LIVE)(
  "firmware e2e: the simulated phone against a live server",
  async () => {
    mkdirSync(OUT, { recursive: true });
    if (process.env.OLP_FW_NO_BUILD !== "1") buildSimFirmware(WSS);
    const pw = await import(process.env.PLAYWRIGHT_CORE ?? "playwright-core");
    const chromium = pw.chromium ?? pw.default?.chromium;
    browser = (await chromium.launch({
      headless: process.env.OLP_LIVE_HEADED !== "1",
      args: CHROMIUM_ARGS,
      ...(process.env.OLP_CHROMIUM ? { executablePath: process.env.OLP_CHROMIUM } : {}),
    })) as Browser;

    const g = new Companion(A, `olptest-fw-${RUN}`);
    guardian = g;
    const signedUp = await step("0", "guardian signs up with a passkey (companion)", async () => {
      await g.open(browser as Browser);
      await g.signUp("Mom");
      return g.person.address;
    });
    if (!signedUp) return;
    const me = (await json(g.person, "/me")).json as { user: { id: string } };
    const guardianId = me.user.id;

    // ------------------------------------------------------------ simulation A
    const phone = new WokwiPhone(join(OUT, `serial-A-${RUN}.log`));
    let code = "";
    let deviceId = "";
    const booted = await step("1", "boots, joins Wokwi-GUEST, connects, shows a code", async () => {
      code = await boot(phone);
      await snapshot(phone, `A1-pairing-${RUN}`);
      return `code ${code}`;
    });
    const paired =
      booted &&
      (await step(
        "2",
        "paired via the API → pair.done → reconnect → P-256 auth → config",
        async () => {
          const note = await pair(phone, g, code);
          deviceId = note.split(";")[0] as string;
          // MENU → About shows the same four words.
          phone.send("key menu");
          await phone.waitFor(/MENU root/, 15_000);
          phone.send("key 0");
          const about = await phone.waitFor(/ABOUT fw=\S+ words=(\w+ \w+ \w+ \w+)/, 15_000);
          await snapshot(phone, `A2-about-${RUN}`);
          phone.send("key back");
          phone.send("key back");
          await phone.waitFor(/MENU closed/, 15_000);
          await snapshot(phone, `A2-idle-${RUN}`);
          return `${note}; about: ${about[1]}`;
        },
      ));

    if (!paired) {
      for (const [id, t] of [
        ["3", "phone → companion"],
        ["4", "companion → phone"],
        ["7", "reconnect"],
        ["5", "quiet hours"],
      ] as const)
        skip(id, t, "not paired");
    } else {
      await step(
        "3",
        "allow-list key 1; phone calls the companion: ring, answer, active, hook down",
        async () => {
          const put = await json(g.person, `/devices/${deviceId}/contacts/${guardianId}`, {
            method: "PUT",
            body: {
              label: "Mom",
              canCallDevice: true,
              deviceCanCall: true,
              bypassQuietHours: false,
            },
          });
          assert(put.status === 204, `allow-list ${put.status} ${JSON.stringify(put.json)}`);
          await phone.waitFor(
            /<- \{"t":"config"[^\n]*"label":"Mom"/,
            20_000,
            "config with Mom on key 1",
          );
          phone.send("hook up");
          await phone.waitFor(/STATE offhook/, 10_000);
          phone.send("key 1");
          await phone.waitFor(/-> \{"t":"button","index":0\}/, 10_000);
          await phone.waitFor(/STRIP \[CALLING MOM\]/, 10_000);
          await g.answer();
          await phone.waitFor(
            /-> \{"t":"rtc\.sdp","callId":"[^"]+","type":"offer"/,
            30_000,
            "SDP offer",
          );
          await phone.waitFor(
            /"t":"call\.state","callId":"[^"]+","state":"active"/,
            30_000,
            "active",
          );
          await phone.waitFor(/STRIP \[IN CALL \d\d:\d\d\|MOM\]/, 15_000, "IN CALL on the strip");
          await snapshot(phone, `A3-incall-${RUN}`);
          phone.send("hook down");
          await phone.waitFor(/-> \{"t":"call\.hangup"/, 10_000);
          await phone.waitFor(/STATE idle/, 10_000);
          const ended = await g.ended();
          return `companion: ${ended.replace(/\s+/g, " ").slice(0, 60)}`;
        },
      );

      await step(
        "4",
        "companion calls the phone: ring (buzzer + LED), lift, active, hang up",
        async () => {
          await g.tab("Home");
          await g.page
            .locator("li.device", { hasText: PHONE_NAME })
            .getByRole("button", { name: "Call" })
            .click();
          await phone.waitFor(/<- \{"t":"call\.ringing"/, 30_000, "call.ringing");
          // The strip, the LED and the buzzer change together (in this order in the log).
          const ring = phone.cursor;
          await phone.waitFor(/STRIP \[MOM CALLING\|LIFT TO ANSWER\]/, 10_000);
          await phone.waitFor(/SIG ring=on/, 10_000, "buzzer ringing");
          assert(phone.seenSince(ring, /SIG led=ringing/), "LED not ringing");
          phone.send("hook up");
          await phone.waitFor(/-> \{"t":"call\.answer"/, 10_000);
          await phone.waitFor(/SIG ring=off/, 10_000);
          await phone.waitFor(
            /-> \{"t":"rtc\.sdp","callId":"[^"]+","type":"answer"/,
            30_000,
            "SDP answer",
          );
          await phone.waitFor(
            /"t":"call\.state","callId":"[^"]+","state":"active"/,
            30_000,
            "active",
          );
          await phone.waitFor(/STRIP \[IN CALL/, 15_000);
          await g.hangUp();
          await phone.waitFor(/"state":"ended","reason":"hangup"/, 20_000, "ended");
          await phone.waitFor(/STATE offhook/, 10_000);
          phone.send("hook down");
          await phone.waitFor(/STATE idle/, 10_000);
          await g.ended();
        },
      );

      await step("7", "dropped connection → reconnect → re-auth", async () => {
        phone.send("drop");
        await phone.waitFor(/dropping the WebSocket/, 10_000);
        await phone.waitFor(/STRIP \[OFFLINE\|RECONNECTING\]/, 10_000);
        await phone.waitFor(/WS open/, 90_000, "reopened");
        await phone.waitFor(/"t":"hello","proto":1,"deviceId":"/, 10_000, "hello with the id");
        await phone.waitFor(/"t":"auth\.proof"/, 30_000);
        await phone.waitFor(/SIGNED IN as/, 30_000);
        await phone.waitFor(/STRIP \[READY\|KIDS: /, 20_000);
      });

      await step(
        "5",
        "quiet hours: the call goes to voicemail; the phone shows it missed",
        async () => {
          const allDay = [{ days: [0, 1, 2, 3, 4, 5, 6], start: "00:00", end: "23:59" }];
          const q = await json(g.person, "/quiet-hours", {
            method: "PUT",
            body: { rules: allDay },
          });
          assert(q.status < 300, `quiet hours ${q.status}`);
          await phone.waitFor(/STRIP \[QUIET (HOURS|TIL \d\d:\d\d)/, 30_000, "quiet on the strip");
          const from = phone.cursor;
          await g.page.reload();
          await g.tab("Home");
          const call = g.page
            .locator("li.device", { hasText: PHONE_NAME })
            .getByRole("button", { name: "Call" });
          await until("Call enabled", async () => !(await call.isDisabled()));
          await call.click();
          await g
            .overlay()
            .getByText(/Recording ·/)
            .waitFor({ timeout: 40_000 });
          await g.page.waitForTimeout(5_000);
          await g.overlay().getByRole("button", { name: "Hang up & send" }).click();
          await g.page.getByText(/Message sent to/).waitFor({ timeout: 30_000 });
          const missed = await phone.waitFor(
            /STRIP \[QUIET [^|]*\|([^\]]*MISSED[^\]]*)\]/,
            60_000,
            "missed on the strip",
          );
          assert(
            !phone.seenSince(from, /"t":"call\.ringing"/),
            "the phone rang during quiet hours",
          );
          await snapshot(phone, `A5-missed-${RUN}`);
          type Vm = { id: string; deviceId: string | null };
          const list = (await json(g.person, "/voicemails")).json as Vm[];
          for (const v of list.filter((x) => x.deviceId === deviceId)) {
            await json(g.person, `/voicemails/${v.id}/heard`, { method: "POST" });
          }
          await json(g.person, "/quiet-hours", { method: "PUT", body: { rules: [] } });
          await phone.waitFor(/STRIP \[READY\|KIDS: /, 30_000, "back to ready");
          return missed[1] as string;
        },
      );
    }
    await phone.stop();

    // ------------------------------------------------------------ simulation B
    const phone2 = new WokwiPhone(join(OUT, `serial-B-${RUN}.log`));
    await step("6", "removed in the app → wipe → new key → a new pairing code", async () => {
      const first = await boot(phone2);
      const note = await pair(phone2, g, first);
      const id = note.split(";")[0] as string;
      const oldWords = /identity: fingerprint: (\w+ \w+ \w+ \w+)/.exec(phone2.log)?.[1];
      const del = await json(g.person, `/devices/${id}`, { method: "DELETE" });
      assert(del.status === 204, `remove ${del.status}`);
      await phone2.waitFor(/<- \{"t":"wipe","reason":"removed"\}/, 30_000, "wipe");
      await phone2.waitFor(/wiped the device key/, 10_000);
      await phone2.waitFor(/Open Lounge Phone firmware/, 60_000, "reboot");
      await phone2.waitFor(/no device key: generating a P-256 key/, 30_000, "new key");
      const words = await phone2.waitFor(/identity: fingerprint: (\w+ \w+ \w+ \w+)/, 30_000);
      await phone2.waitFor(/device id: \(unpaired\)/, 10_000);
      phone2.send("hook down");
      const again = await phone2.waitFor(/PAIRING CODE: (\d{6})/, 120_000, "a new code");
      await snapshot(phone2, `B6-new-code-${RUN}`);
      assert(words[1] !== oldWords, "same fingerprint after the wipe");
      const still = (await json(g.person, "/devices")).json as { id: string }[];
      assert(!still.some((d) => d.id === id), "the phone is still listed");
      return `old ${oldWords} → new ${words[1]}; code ${again[1]}`;
    });
    await phone2.stop();

    const failed = results.filter((r) => r.status === "FAIL");
    assert(failed.length === 0, `failed: ${failed.map((r) => r.id).join(", ")}`);
  },
  30 * 60_000,
);
