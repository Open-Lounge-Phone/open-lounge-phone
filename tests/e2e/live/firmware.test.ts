// LIVE end-to-end check of the ESP32 firmware in a simulator (QEMU by default, or Wokwi: see
// wokwi.ts) against a deployed server,
// with a real companion in Chromium (a test-tone microphone, virtual passkey). Calls carry real
// audio: the phone's test device sends a 1 kHz tone that the companion finds with WebAudio, and
// the companion's 440 Hz tone is measured on the phone. Never runs in CI; opt in with OLP_LIVE=1
// and OLP_FIRMWARE=1:
//
//   OLP_LIVE=1 OLP_FIRMWARE=1 PLAYWRIGHT_CORE=/path/to/node_modules/playwright-core \
//     OLP_CHROMIUM="/path/to/chrome" npx vitest run tests/e2e/live/firmware.test.ts
//
// Env: OLP_E2E_SERVER (required: a disposable test server with open sign-up, e.g.
// https://t2.openloungephone.app; never the owner's l1 — the test creates an account there; the
// simulator firmware is built for it: OLP_SIM_SERVER in firmware/tools/sim.sh), OLP_LIVE_OUT (logs, PNGs and the result JSON; default
// firmware/build-sim/e2e), OLP_LIVE_KEEP=1 (keep the test account), OLP_CHROMIUM (a Chromium
// binary if playwright-core's own isn't installed), OLP_FW_NO_BUILD=1 (skip the sim build),
// WOKWI_CLI_TOKEN or firmware/.wokwi-token, OLP_WOKWI_CLI, OLP_FW_STEPS (e.g. `3,4`: only those
// steps, for troubleshooting; 1-2 always run).
//
// Two simulations (a Wokwi run lasts at most 5 minutes; QEMU has no limit): A = steps 1-5 and 7,
// B = step 6.
// It only ever creates, uses and deletes an account whose handle starts with `olptest-`.
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Browser } from "playwright-core";
import { afterAll, it } from "vitest";
import { api, type Person } from "../twoServers.ts";
import { CHROMIUM_ARGS, Companion, setForceRelay, until } from "./browser.ts";
import { mediaReport, parseAudioLine, writeToneWav } from "./media.ts";
import { bootloaderStandIn, buildOtaAssets, deleteOtaAssets, type OtaAssets } from "./ota.ts";
import { buildSimFirmware, FIRMWARE, QemuPhone, SIM, simPhone, type WokwiPhone } from "./wokwi.ts";

const A = process.env.OLP_E2E_SERVER ?? "";
const LIVE = process.env.OLP_LIVE === "1" && process.env.OLP_FIRMWARE === "1" && A !== "";
/** The simulator build's own server (firmware/sdkconfig.sim) is the owner's: never test there. */
if (LIVE && new URL(A).host === "l1.openloungephone.app") {
  throw new Error("OLP_E2E_SERVER must be a disposable test server, not l1");
}
const WSS = A.replace(/^http/, "ws").replace(/\/$/, "");
const RUN = process.env.OLP_LIVE_RUN ?? Math.random().toString(36).slice(2, 7);
const OUT = process.env.OLP_LIVE_OUT ?? join(FIRMWARE, "build-sim/e2e");
const PHONE_NAME = "Sim phone";
const STEPS = process.env.OLP_FW_STEPS
  ? process.env.OLP_FW_STEPS.split(",").map((x) => x.trim())
  : undefined;
const want = (id: string) => !STEPS || STEPS.includes(id);
/** Known not to work yet (firmware README "Call audio"): run only when asked for by id. */
const OPT_IN = ["8", "9"];
/** The phone's test device sends 1 kHz; the companion's fake microphone plays 440 Hz. */
const PHONE_TONE_HZ = 1000;
const COMPANION_TONE_HZ = 440;

type Status = "PASS" | "FAIL" | "SKIPPED";
const results: { id: string; title: string; status: Status; note: string; ms: number }[] = [];
let browser: Browser | undefined;
let guardian: Companion | undefined;
const phones: WokwiPhone[] = [];

async function step(id: string, title: string, fn: () => Promise<unknown>): Promise<boolean> {
  if (!["0", "1", "2"].includes(id) && !want(id)) {
    skip(id, title, "not in OLP_FW_STEPS");
    return false;
  }
  if (OPT_IN.includes(id) && !STEPS?.includes(id)) {
    skip(id, title, "opt-in (OLP_FW_STEPS): TURN over TCP/TLS doesn't work in esp_peer 1.5.6");
    return false;
  }
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
  await phone.waitFor(/Open Lounge Phone firmware [\d.]+ \(simulator build/, 90_000, "boot");
  await phone.waitFor(/WIFI connected/, 60_000, "Wi-Fi");
  await phone.consoleReady();
  phone.send("hook down"); // Wokwi's hook button isn't held: put the handset down
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

let otaCleanup = "";

/**
 * Over-the-air updates against the test pre-release: a manifest signed by another key, one for
 * another board, a hash that doesn't match, an image signed by another key (Secure Boot V2 check
 * in esp_ota_end) and an older version are all refused; a signed image that crashes at boot is
 * rolled back; a good one boots on trial, is kept once it reaches the server, and stays after a
 * restart. QEMU can't run the bootloader's own otadata writes, so the test makes them between
 * runs (bootloaderStandIn); the slot choice and everything in the app run for real.
 */
async function ota(phone: WokwiPhone, a: OtaAssets): Promise<string> {
  const p = phone as WokwiPhone & { buildDir?: string; resume(): void };
  p.buildDir = a.baseBuild;
  phones.push(phone);
  phone.start();
  await phone.waitFor(/running 0\.4\.0 from ota_0/, 90_000, "base 0.4.0 in ota_0");
  await phone.consoleReady();
  await phone.waitFor(/PAIRING CODE: \d{6}/, 90_000, "server reached");
  /** Points the phone at a manifest; waits for the answer before typing anything else. */
  const useUrl = async (which: keyof OtaAssets["urls"]) => {
    phone.send(`ota url ${a.urls[which]}`);
    await phone.waitFor(new RegExp(`url=${a.urls[which].replace(/[.?]/g, "\\$&")}`), 20_000);
  };
  const refuse = async (which: keyof OtaAssets["urls"], why: RegExp, cmd = "now") => {
    await useUrl(which);
    phone.send(`ota ${cmd}`);
    const m = await phone.waitFor(why, 180_000, `${which}: ${why}`);
    await new Promise((r) => setTimeout(r, 1_500));
    return `${which}: ${m[0].replace(/^OTA /, "")}`;
  };
  const notes = [
    await refuse("badsig", /OTA REFUSED: bad manifest signature/),
    await refuse("board", /OTA REFUSED: for another board \(manifest for "minimal-revB"/),
    await refuse("sha", /OTA REFUSED: sha256 mismatch/),
    await refuse("sbv2", /OTA REFUSED: image invalid \(format or signature\)/),
    await refuse("old", /OTA UP TO DATE \(running 0\.4\.0, latest 0\.3\.9\)/, "check"),
  ];
  const events: string[] = [];
  /**
   * The phone restarted. Normally its bootloader makes its otadata write and starts the app; if
   * QEMU stalls on that write (tools/qemu_otadata.py), make it on the stopped emulator and go on.
   * Records which happened.
   */
  const reboot = async (what: string) => {
    await phone.waitFor(/2nd stage bootloader/, 60_000, `${what}: bootloader`);
    try {
      await phone.waitFor(/cpu_start: Pro cpu start user code/, 30_000, `${what}: app start`);
      events.push(`${what}: bootloader wrote otadata itself`);
    } catch {
      await phone.stop();
      events.push(`${what}: stalled, stand-in ${bootloaderStandIn(a.baseBuild)}`);
      p.resume();
    }
  };
  // A signed image that crashes at boot: installed, tried, rolled back.
  await useUrl("broken");
  phone.send("ota now");
  await phone.waitFor(/OTA INSTALLED 0\.4\.2-test/, 240_000, "broken image installed");
  await phone.waitFor(/OTA RESTART/, 30_000);
  await reboot("into 0.4.2-test"); // NEW -> PENDING_VERIFY
  await phone.waitFor(/TEST BUILD: crashing at boot on purpose/, 90_000, "the broken image ran");
  await reboot("after the crash"); // PENDING_VERIFY -> ABORTED
  await phone.waitFor(/running 0\.4\.0 from ota_0/, 120_000, "back on 0.4.0");
  await phone.waitFor(/OTA ROLLED BACK: 0\.4\.2-test \(in ota_1\) didn't start properly/, 10_000);
  notes.push("0.4.2-test crashed → rolled back to 0.4.0");
  // A good image: trial boot, kept once the server answers, still there after a restart.
  await phone.waitFor(/olp> /, 60_000);
  await useUrl("good");
  phone.send("ota now");
  await phone.waitFor(/OTA INSTALLED 0\.4\.1-test/, 240_000, "good image installed");
  await reboot("into 0.4.1-test"); // NEW -> PENDING_VERIFY
  await phone.waitFor(/running 0\.4\.1-test from ota_1/, 120_000, "restarted into 0.4.1-test");
  await phone.waitFor(/OTA TRIAL 0\.4\.1-test/, 10_000);
  await phone.waitFor(/OTA VALID 0\.4\.1-test/, 120_000, "kept after reaching the server");
  phone.send("reboot");
  await reboot("a plain restart"); // VALID: nothing to write
  await phone.waitFor(/running 0\.4\.1-test from ota_1/, 120_000, "0.4.1-test after a restart");
  await new Promise((r) => setTimeout(r, 3_000));
  assert(!/OTA TRIAL/.test(phone.log.slice(phone.cursor)), "still on trial after being kept");
  notes.push("0.4.1-test: trial → valid → kept after restart");
  return `${notes.join("; ")}; boots: ${events.join(", ")}`;
}

const ENC_BUILD = "build-qemu-enc";

/**
 * NVS encryption with the eFuse HMAC key (a release-build option) in QEMU, whose eFuses and HMAC
 * peripheral are emulated: the first boot burns the key; the device key, its id and the Wi-Fi
 * password are not readable in the flash; after a restart they decrypt (same phone, signs in); a
 * wipe from the server erases them and keeps the Wi-Fi.
 */
async function encryptedStorage(phone: QemuPhone, g: Companion): Promise<string> {
  const defaults = join(FIRMWARE, ENC_BUILD + ".defaults");
  writeFileSync(
    defaults,
    [
      "CONFIG_OLP_STORAGE_ENCRYPTED=y",
      "CONFIG_NVS_ENCRYPTION=y",
      "CONFIG_NVS_SEC_KEY_PROTECT_USING_HMAC=y",
      "CONFIG_NVS_SEC_HMAC_EFUSE_KEY_ID=5",
      "",
    ].join("\n"),
  );
  const r = spawnSync(join(FIRMWARE, "tools/qemu.sh"), ["build"], {
    encoding: "utf8",
    env: {
      ...process.env,
      OLP_QEMU_BUILD: ENC_BUILD,
      OLP_QEMU_EXTRA_DEFAULTS: defaults,
      OLP_SIM_SERVER: WSS,
    },
  });
  assert(r.status === 0, `encrypted build failed:\n${r.stdout}\n${r.stderr}`);
  phone.buildDir = ENC_BUILD;
  const blankEfuse = Buffer.alloc(1024);
  blankEfuse[38] = 0x0c;
  const code = await boot(phone);
  const burn = /FIRST ENCRYPTED BOOT: burning a new NVS HMAC key into eFuse KEY5/.exec(phone.log);
  assert(burn, "no key burned on the first boot");
  assert(
    /STORAGE encrypted \(NVS, HMAC key in eFuse KEY5, new\): ESP_OK/.test(phone.log),
    "storage",
  );
  const id = (await pair(phone, g, code)).split(";")[0] as string;
  phone.send("wifi Canary-Net-7431 canary-pass-9913");
  await phone.waitFor(/wifi saved: Canary-Net-7431/, 10_000);
  await new Promise((r) => setTimeout(r, 1_000));
  await phone.stop();
  const nvs = phone.nvs();
  for (const secret of [id, "Canary-Net-7431", "canary-pass-9913"])
    assert(!nvs.includes(secret), `"${secret}" is readable in the NVS flash`);
  assert(
    nvs.some((b) => b !== 0xff),
    "NVS is empty",
  );
  assert(!phone.efuse().equals(blankEfuse), "the eFuse file didn't change");
  phone.resume();
  await phone.waitFor(
    /STORAGE encrypted \(NVS, HMAC key in eFuse KEY5, existing\): ESP_OK/,
    90_000,
  );
  await phone.waitFor(/saved Wi-Fi: Canary-Net-7431/, 30_000, "Wi-Fi decrypted");
  await phone.waitFor(new RegExp(`SIGNED IN as ${id}`), 90_000, "same phone signs in again");
  const del = await json(g.person, `/devices/${id}`, { method: "DELETE" });
  assert(del.status === 204, `remove ${del.status}`);
  await phone.waitFor(
    /WIPE: NVS partition erased \(ESP_OK\); putting Wi-Fi and the server back/,
    30_000,
  );
  await phone.waitFor(/saved Wi-Fi: Canary-Net-7431/, 90_000, "Wi-Fi kept");
  await phone.waitFor(/no device key: generating a P-256 key/, 30_000, "new key after the wipe");
  assert(!/FIRST ENCRYPTED BOOT/.test(phone.log.slice(phone.cursor)), "burned again");
  return `key burned once into KEY5; ${id}, Wi-Fi name and password not in the flash; decrypted after a restart and signed in; wipe erased and kept Wi-Fi`;
}

const SETUP_PORT = 18080;

/**
 * The Wi-Fi setup network (SoftAP provisioning). QEMU has no radio, so its Ethernet stands in and
 * the setup site is reached through a forwarded port; Wokwi (no port forwarding) uses the phone's
 * own `setup test`. Forget Wi-Fi → reboot → the setup screen → the page in Chromium (form, a bad
 * password refused, save) → the phone restarts with the saved network and no setup network.
 */
async function provisioning(phone: WokwiPhone, b: Browser): Promise<string> {
  const qemu = SIM === "qemu";
  if (qemu) (phone as { hostfwd?: string }).hostfwd = `tcp:127.0.0.1:${SETUP_PORT}-:80`;
  phones.push(phone);
  phone.start();
  await phone.waitFor(/Open Lounge Phone firmware [\d.]+ \(simulator build/, 90_000, "boot");
  await phone.consoleReady();
  phone.send("wifi forget");
  await phone.waitFor(/wifi forgotten/, 10_000);
  phone.send("reboot");
  await phone.waitFor(/PROV open \(no Wi-Fi saved\)/, 90_000, "setup opens by itself");
  const ap = await phone.waitFor(/PROV AP UP ssid=(OpenLoungePhone-[0-9A-F]{4})/, 20_000);
  const strip = await phone.waitFor(
    /STRIP \[WI-FI SETUP: JOIN\|(OpenLoungePhone-[0-9A-F]{4})\|PASSWORD (\d{8})\|OPEN 192\.168\.4\.1\]/,
    20_000,
    "the setup steps on the display",
  );
  assert(strip[1] === ap[1], "display and network names differ");
  await snapshot(phone, `C10-setup-${RUN}`);
  await phone.waitFor(/olp> /, 60_000, "console after the reboot");
  // The phone checks its own site (the way the Wokwi run can).
  phone.send("setup test");
  await phone.waitFor(/PROV TEST GET \/ 200 form server-choice/, 30_000, "self-test page");
  await phone.waitFor(/PROV TEST GET \/generate_204 302/, 30_000, "self-test captive redirect");
  await phone.waitFor(/PROV TEST POST bad 200 error-shown/, 30_000, "self-test bad input");
  if (!qemu) return `${ap[1]}; self-test only (no port forwarding in Wokwi)`;

  const base = `http://127.0.0.1:${SETUP_PORT}`;
  // What a phone's captive-portal check sees.
  const probe = await fetch(`${base}/hotspot-detect.html`, { redirect: "manual" });
  assert(probe.status === 302, `captive probe ${probe.status}`);
  assert(probe.headers.get("location") === "http://192.168.4.1/", "captive redirect target");
  // A person in a browser: the page, a too-short password (refused), then a good one.
  const page = await b.newPage();
  try {
    await page.goto(`${base}/`);
    await page.getByRole("heading", { name: "Set up your phone" }).waitFor({ timeout: 20_000 });
    // The server question: the phone's server (this build's) is pre-selected as "My own server";
    // the public hub is only a choice.
    assert(await page.getByRole("radio", { name: /My own server/ }).isChecked(), "own server");
    assert(!(await page.getByRole("radio", { name: /Public hub/ }).isChecked()), "hub checked");
    await page.getByLabel("Or type its name").fill("Home Wi-Fi & Co");
    await page.getByLabel("Password").fill("short");
    await page.getByRole("button", { name: "Save and restart" }).click();
    await page
      .getByText("Wi-Fi passwords have at least 8 characters.")
      .waitFor({ timeout: 20_000 });
    await page.getByLabel("Or type its name").fill("Home Wi-Fi & Co");
    await page.getByLabel("Password").fill("pa ss&word=1");
    await page.getByRole("button", { name: "Save and restart" }).click();
    await page.getByRole("heading", { name: "Saved" }).waitFor({ timeout: 20_000 });
    await page.getByText("joins Home Wi-Fi & Co").waitFor({ timeout: 5_000 });
  } finally {
    await page.close();
  }
  await phone.waitFor(
    new RegExp(
      `PROV SAVED ssid=Home Wi-Fi & Co server=${WSS.replace(/[.]/g, "\\.")} \\(restarting\\)`,
    ),
    20_000,
    "saved with the same server",
  );
  await phone.waitFor(/Open Lounge Phone firmware/, 60_000, "restart");
  await phone.waitFor(/saved Wi-Fi: Home Wi-Fi & Co/, 30_000, "the network was saved");
  await phone.waitFor(/WIFI connected/, 60_000);
  await new Promise((r) => setTimeout(r, 5_000));
  const after = phone.log.slice(phone.cursor);
  assert(!/PROV open/.test(after), "the setup network opened again after saving");
  return `${ap[1]}; captive redirect, bad password refused, saved "Home Wi-Fi & Co", restarted`;
}

/** Puts the handset down (a no-op when idle) so a failed step doesn't leave a call running. */
async function idle(phone: WokwiPhone): Promise<void> {
  phone.send("hook down");
  await phone.waitFor(/HOOK down \(console\)/, 10_000);
  await new Promise((r) => setTimeout(r, 1_000));
}

/**
 * Call audio, both ways: the phone's ICE + DTLS-SRTP come up, RTP flows in both directions, the
 * companion hears the phone's 1 kHz tone (WebAudio FFT) and the phone hears the companion's 440 Hz.
 */
async function checkAudio(phone: WokwiPhone, g: Companion, callStart: number): Promise<string> {
  // The media may connect before the signaling lines the step waited for: look from the call's start.
  const up = await until(
    "media connected",
    () => /RTC CONNECTED: ICE \+ DTLS-SRTP up in (\d+) ms/.exec(phone.log.slice(callStart)),
    90_000,
  );
  // Let RTP run, then read both ends.
  await g.page.waitForTimeout(8_000);
  phone.send("audio");
  const line = await phone.waitFor(/AUDIO device=\S+ call=1 [^\n]*/, 20_000, "audio status");
  const a = parseAudioLine(line[0]) ?? {};
  phone.send("rtc");
  const rtc = await phone.waitFor(
    /RTC call=\S+ state=\S+ connected=1 [^\n]*/,
    20_000,
    "rtc status",
  );
  const r = await mediaReport(g.page, PHONE_TONE_HZ);
  const summary =
    `setup ${up[1]} ms; phone tx=${a.tx} rx=${a.rx} rx${COMPANION_TONE_HZ}Hz=${a[`rx${COMPANION_TONE_HZ}Hz`]} ` +
    `rxlevel=${a.rxlevel} under=${a.under}; companion ${r.codec} ${r.local}↔${r.remote} ` +
    `sent=${r.packetsSent} recv=${r.packetsReceived} lost=${r.packetsLost} jitter=${r.jitterMs}ms ` +
    `tone ${r.toneHz} Hz +${r.toneOverMedianDb} dB; ${rtc[0].replace(/^RTC /, "")}`;
  console.log(`AUDIO ${summary}`);
  assert(/pcmu/i.test(r.codec), `codec ${r.codec}`);
  assert((a.tx ?? 0) > 100, `phone sent ${a.tx} frames`);
  assert((a.rx ?? 0) > 50, `phone received ${a.rx} frames`);
  assert(r.packetsReceived > 50, `companion received ${r.packetsReceived} packets`);
  assert(r.packetsSent > 50, `companion sent ${r.packetsSent} packets`);
  assert(
    Math.abs(r.toneHz - PHONE_TONE_HZ) <= 30 && r.toneOverMedianDb >= 20,
    `companion did not hear the phone's ${PHONE_TONE_HZ} Hz tone (${r.toneHz} Hz, +${r.toneOverMedianDb} dB)`,
  );
  const heard = a[`rx${COMPANION_TONE_HZ}Hz`] ?? -100;
  assert(
    heard > -50 && heard >= (a.rxlevel ?? -100) - 10,
    `phone did not hear the companion's ${COMPANION_TONE_HZ} Hz tone (${heard} dBFS, level ${a.rxlevel})`,
  );
  return summary;
}

afterAll(async () => {
  if (!LIVE) return;
  for (const p of phones) await p.stop();
  let cleanup = guardian?.person ? "kept (OLP_LIVE_KEEP=1)" : "no account was created";
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
  if (otaCleanup) cleanup += `; ${otaCleanup}`;
  const report = { run: RUN, sim: SIM, server: A, results, cleanup };
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
    const wav = join(OUT, "tone440.wav");
    writeToneWav(wav, { hz: COMPANION_TONE_HZ });
    browser = (await chromium.launch({
      headless: process.env.OLP_LIVE_HEADED !== "1",
      args: [...CHROMIUM_ARGS, `--use-file-for-fake-audio-capture=${wav}`],
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
    const phone = simPhone(join(OUT, `serial-A-${RUN}.log`));
    let code = "";
    let deviceId = "";
    const booted = await step("1", "boots, joins the network, connects, shows a code", async () => {
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
        ["8", "TURN over TCP"],
        ["9", "TURN over TLS"],
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
          const callStart = phone.log.length;
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
          const audio = await checkAudio(phone, g, callStart);
          phone.send("hook down");
          await phone.waitFor(/-> \{"t":"call\.hangup"/, 10_000);
          await phone.waitFor(/STATE idle/, 10_000);
          await phone.waitFor(/call media off \(mic off\)/, 10_000, "mic off after the call");
          const ended = await g.ended();
          return `${audio}; companion: ${ended.replace(/\s+/g, " ").slice(0, 40)}`;
        },
      );

      await step(
        "4",
        "companion calls the phone: ring (buzzer + LED), lift, active, hang up",
        async () => {
          await idle(phone);
          const callStart = phone.log.length;
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
          const audio = await checkAudio(phone, g, callStart);
          await g.hangUp();
          await phone.waitFor(/"state":"ended","reason":"hangup"/, 20_000, "ended");
          await phone.waitFor(/STATE offhook/, 10_000);
          phone.send("hook down");
          await phone.waitFor(/STATE idle/, 10_000);
          await g.ended();
          return audio;
        },
      );

      for (const [id, mode, url] of [
        ["8", "tcp", /^turn:\S+\?transport=tcp$/],
        ["9", "tls", /^turns:\S+:443\?transport=tcp$/],
      ] as const) {
        await step(
          id,
          `TURN over ${mode.toUpperCase()} only (\`ice ${mode}\`): the phone calls, audio both ways, companion relay-only`,
          async () => {
            await idle(phone);
            const callStart = phone.log.length;
            phone.send(`ice ${mode}`);
            await phone.waitFor(new RegExp(`ice ${mode} \\(next call\\)`), 10_000);
            await setForceRelay(g.page, true);
            try {
              phone.send("hook up");
              await phone.waitFor(/STATE offhook/, 10_000);
              phone.send("key 1");
              await phone.waitFor(/STRIP \[CALLING MOM\]/, 10_000);
              await g.answer();
              const start = await phone.waitFor(/RTC start: offerer, ICE \w+ \[([^\]]*)\]/, 30_000);
              assert(url.test(start[1] as string), `servers ${start[1]}`);
              await phone.waitFor(/"t":"call\.state","callId":"[^"]+","state":"active"/, 30_000);
              const audio = await checkAudio(phone, g, callStart);
              assert(/relay/.test(audio), "the companion's path is not a relay");
              phone.send("hook down");
              await phone.waitFor(/STATE idle/, 10_000);
              await g.ended();
              return audio;
            } finally {
              phone.send("ice all");
              await setForceRelay(g.page, false);
              await g.ended().catch(() => "");
            }
          },
        );
      }

      await step("7", "dropped connection → reconnect → re-auth", async () => {
        await idle(phone);
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
    const phone2 = simPhone(join(OUT, `serial-B-${RUN}.log`));
    if (want("6"))
      await step("6", "removed in the app → wipe → new key → a new pairing code", async () => {
        const first = await boot(phone2);
        const note = await pair(phone2, g, first);
        const id = note.split(";")[0] as string;
        const oldWords = /identity: fingerprint: (\w+ \w+ \w+ \w+)/.exec(phone2.log)?.[1];
        // QEMU: the id is in the (plain, development build) NVS flash now…
        const qemu = phone2 instanceof QemuPhone ? phone2 : undefined;
        if (qemu) {
          await qemu.stop();
          assert(qemu.nvs().includes(id), "the device id isn't in the NVS flash (check broken?)");
          qemu.resume();
          await phone2.waitFor(/SIGNED IN as/, 90_000, "signed in again");
        }
        const del = await json(g.person, `/devices/${id}`, { method: "DELETE" });
        assert(del.status === 204, `remove ${del.status}`);
        await phone2.waitFor(/<- \{"t":"wipe","reason":"removed"\}/, 30_000, "wipe");
        await phone2.waitFor(/wiped the device key/, 10_000);
        await phone2.waitFor(/Open Lounge Phone firmware/, 60_000, "reboot");
        await phone2.waitFor(/no device key: generating a P-256 key/, 30_000, "new key");
        const words = await phone2.waitFor(/identity: fingerprint: (\w+ \w+ \w+ \w+)/, 30_000);
        await phone2.waitFor(/device id: \(unpaired\)/, 10_000);
        let erased = "";
        if (qemu) {
          // …and after the wipe it's gone from the flash: erased, not just marked deleted.
          await qemu.stop();
          assert(!qemu.nvs().includes(id), "the old device id is still in the NVS flash");
          erased = "; old id erased from the flash";
          qemu.resume();
        }
        await phone2.waitFor(/olp> /, 60_000, "the console after the reboot");
        phone2.send("hook down");
        const again = await phone2.waitFor(/PAIRING CODE: (\d{6})/, 120_000, "a new code");
        await snapshot(phone2, `B6-new-code-${RUN}`);
        assert(words[1] !== oldWords, "same fingerprint after the wipe");
        const still = (await json(g.person, "/devices")).json as { id: string }[];
        assert(!still.some((d) => d.id === id), "the phone is still listed");
        return `old ${oldWords} → new ${words[1]}; code ${again[1]}${erased}`;
      });
    await phone2.stop();

    // ------------------------------------------------------------ simulation C
    if (want("10")) {
      const phone3 = simPhone(join(OUT, `serial-C-${RUN}.log`));
      await step("10", "no Wi-Fi → the setup network and its page → save → restart", () =>
        provisioning(phone3, browser as Browser),
      );
      await phone3.stop();
    }

    // ------------------------------------------------------------ simulation E
    if (want("12") && SIM === "qemu") {
      const phone5 = new QemuPhone(join(OUT, `serial-E-${RUN}.log`));
      await step(
        "12",
        "encrypted storage: key burned once, NVS unreadable in flash, wipe erases",
        () => encryptedStorage(phone5, g),
      );
      await phone5.stop();
    } else if (want("12")) {
      skip("12", "encrypted storage", "QEMU only (eFuse and HMAC emulation)");
    }

    // ------------------------------------------------------------ simulation D
    if (want("11") && SIM === "qemu") {
      let assets: OtaAssets | undefined;
      const phone4 = simPhone(join(OUT, `serial-D-${RUN}.log`));
      try {
        await step(
          "11",
          "OTA: refuses bad signatures/hashes, rolls back a broken image, keeps a good one",
          async () => {
            assets = buildOtaAssets(WSS, RUN);
            return ota(phone4, assets);
          },
        );
      } finally {
        await phone4.stop();
        if (assets) otaCleanup = deleteOtaAssets(assets.tag);
      }
    } else if (want("11")) {
      skip("11", "OTA", "QEMU only (a Wokwi run is capped at 5 minutes)");
    }

    const failed = results.filter((r) => r.status === "FAIL");
    assert(failed.length === 0, `failed: ${failed.map((r) => r.id).join(", ")}`);
  },
  30 * 60_000,
);
