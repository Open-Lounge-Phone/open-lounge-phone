// The OTA test's assets: throwaway keys, three QEMU test builds (base 0.4.0, a good 0.4.1-test and
// a 0.4.2-test that crashes at boot), an image signed with the wrong key, and signed manifests,
// some deliberately wrong. They are hosted on a GitHub PRE-RELEASE marked "TEST ONLY" (no phone
// reads it: official builds read the fw-stable channel) that the test deletes afterwards. The test
// builds turn updates on (CONFIG_OLP_OTA) with test key A and set the URL with `ota url`.
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { FIRMWARE } from "./wokwi.ts";

const REPO = "Open-Lounge-Phone/open-lounge-phone";
const IDF = process.env.IDF_PATH ?? join(homedir(), "esp/esp-idf-v5.5.5");
export const OTA_DIR = join(FIRMWARE, "build-ota-test");

/** Runs a command in the ESP-IDF environment (espsecure, python with cryptography). */
function idf(cmd: string): string {
  return execFileSync("bash", ["-c", `. "${IDF}/export.sh" >/dev/null 2>&1 && ${cmd}`], {
    cwd: FIRMWARE,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
}

function qemuBuild(dir: string, version: string, defaults: string, server: string): void {
  const r = spawnSync(join(FIRMWARE, "tools/qemu.sh"), ["build"], {
    encoding: "utf8",
    env: {
      ...process.env,
      OLP_QEMU_BUILD: dir,
      OLP_QEMU_EXTRA_DEFAULTS: defaults,
      OLP_FW_VERSION: version,
      OLP_SIM_SERVER: server,
    },
  });
  if (r.status !== 0) throw new Error(`build ${dir} failed:\n${r.stdout}\n${r.stderr}`);
}

export interface OtaAssets {
  tag: string;
  baseBuild: string;
  urls: Record<"good" | "broken" | "badsig" | "sha" | "sbv2" | "old" | "board", string>;
}

export function buildOtaAssets(server: string, run: string): OtaAssets {
  mkdirSync(OTA_DIR, { recursive: true });
  const keyA = join(OTA_DIR, "test_key_a.pem");
  const keyB = join(OTA_DIR, "test_key_b.pem");
  for (const k of [keyA, keyB]) {
    if (!existsSync(k))
      idf(`espsecure.py generate_signing_key --version 2 --scheme rsa3072 "${k}"`);
  }
  const pubA = join(OTA_DIR, "test_pub_a.pem");
  idf(`openssl pkey -in "${keyA}" -pubout -out "${pubA}"`);
  const defaults = join(OTA_DIR, "ota.defaults");
  writeFileSync(
    defaults,
    [
      // Updates on, with this test's own throwaway key (source builds have none).
      "CONFIG_OLP_OTA=y",
      "CONFIG_SECURE_SIGNED_APPS_NO_SECURE_BOOT=y",
      "CONFIG_SECURE_SIGNED_APPS_RSA_SCHEME=y",
      "CONFIG_SECURE_SIGNED_ON_UPDATE_NO_SECURE_BOOT=y",
      "CONFIG_SECURE_BOOT_BUILD_SIGNED_BINARIES=y",
      `CONFIG_SECURE_BOOT_SIGNING_KEY="${keyA}"`,
      `CONFIG_OLP_OTA_PUBKEY="${pubA}"`,
      "",
    ].join("\n"),
  );
  const crash = join(OTA_DIR, "crash.defaults");
  writeFileSync(crash, "CONFIG_OLP_TEST_CRASH_AT_BOOT=y\n");
  const bases = {
    base: join(OTA_DIR, "base"),
    good: join(OTA_DIR, "good"),
    broken: join(OTA_DIR, "broken"),
  };
  qemuBuild(bases.base, "0.4.0", defaults, server);
  qemuBuild(bases.good, "0.4.1-test", defaults, server);
  qemuBuild(bases.broken, "0.4.2-test", `${defaults};${crash}`, server);

  const dist = join(OTA_DIR, "dist");
  mkdirSync(dist, { recursive: true });
  copyFileSync(join(bases.good, "openloungephone.bin"), join(dist, "good.bin"));
  copyFileSync(join(bases.broken, "openloungephone.bin"), join(dist, "broken.bin"));
  idf(
    `espsecure.py sign_data --version 2 --keyfile "${keyB}" --output "${join(dist, "wrongkey.bin")}" "${join(bases.good, "openloungephone-unsigned.bin")}"`,
  );
  const tag = `ota-test-DO-NOT-USE-${run}`;
  const url = (f: string) => `https://github.com/${REPO}/releases/download/${tag}/${f}`;
  const manifest = (
    out: string,
    bin: string,
    version: string,
    key: string,
    extra = "",
    board = "minimal-revA",
  ) =>
    idf(
      `python tools/ota_manifest.py make --bin "${join(dist, bin)}" --board "${board}" --version "${version}" --url "${url(bin)}" --key "${key}" --out "${join(dist, out)}" ${extra}`,
    );
  manifest("manifest-good.json", "good.bin", "0.4.1-test", keyA);
  manifest("manifest-broken.json", "broken.bin", "0.4.2-test", keyA);
  manifest("manifest-badsig.json", "good.bin", "0.4.1-test", keyB); // signed by another key
  manifest("manifest-sha.json", "good.bin", "0.4.1-test", keyA, `--sha256 ${"0".repeat(64)}`);
  manifest("manifest-sbv2.json", "wrongkey.bin", "0.4.1-test", keyA); // image signed by key B
  manifest("manifest-old.json", "good.bin", "0.3.9", keyA);
  // Correctly signed, but for another board (e.g. a future revision): never installed here.
  manifest("manifest-board.json", "good.bin", "0.4.1-test", keyA, "", "minimal-revB");
  const files = [
    "good.bin",
    "broken.bin",
    "wrongkey.bin",
    ...["good", "broken", "badsig", "sha", "sbv2", "old", "board"].map((n) => `manifest-${n}.json`),
  ].map((f) => join(dist, f));
  execFileSync(
    "gh",
    [
      "release",
      "create",
      tag,
      "--repo",
      REPO,
      "--prerelease",
      "--title",
      "TEST ONLY - firmware OTA test assets (DO NOT USE; deleted after the test)",
      "--notes",
      "Automated firmware OTA test (tests/e2e/live/firmware.test.ts). Test keys, test images. Not a release; deleted when the test ends.",
      ...files,
    ],
    { encoding: "utf8" },
  );
  return {
    tag,
    baseBuild: bases.base,
    urls: {
      good: url("manifest-good.json"),
      broken: url("manifest-broken.json"),
      badsig: url("manifest-badsig.json"),
      sha: url("manifest-sha.json"),
      sbv2: url("manifest-sbv2.json"),
      old: url("manifest-old.json"),
      board: url("manifest-board.json"),
    },
  };
}

/** Deletes the test pre-release and its tag. Returns what happened. */
export function deleteOtaAssets(tag: string): string {
  const r = spawnSync("gh", ["release", "delete", tag, "--repo", REPO, "--yes", "--cleanup-tag"], {
    encoding: "utf8",
  });
  const check = spawnSync("gh", ["release", "view", tag, "--repo", REPO], { encoding: "utf8" });
  return r.status === 0 && check.status !== 0
    ? `deleted pre-release ${tag}`
    : `NOT deleted ${tag}: ${r.stderr}`;
}

/**
 * QEMU hangs when the bootloader writes flash (tools/qemu_otadata.py): with the emulator stopped,
 * make the one otadata write the bootloader makes on this boot. Returns what it did.
 */
export function bootloaderStandIn(buildDir: string): string {
  return idf(`python tools/qemu_otadata.py boot "${join(buildDir, "qemu_flash.bin")}"`).trim();
}
