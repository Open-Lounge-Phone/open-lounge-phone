import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateServerKey, publicKeyOf } from "@openloungephone/federation";
import { afterEach, expect, it } from "vitest";
import { federationKeyFile, federationKeyStore } from "./adapters.ts";

const dirs: string[] = [];
const dataDir = () => {
  const d = mkdtempSync(join(tmpdir(), "olp-keys-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

it("keeps the current key and, for the overlap, the previous one with its hand-over", async () => {
  const dir = dataDir();
  const first = await federationKeyFile(dir);
  const store = federationKeyStore(dir);
  expect(await store.load()).toEqual({ privateKey: first });
  const next = await generateServerKey();
  const now = Math.floor(Date.now() / 1000);
  const rotation = {
    previous_key: publicKeyOf(first),
    created: now,
    expires: now + 60,
    sig: "s",
    legacy_sig: "l",
  };
  // Only over the key that is current (a racing rotation loses).
  expect(await store.save({ privateKey: next, rotation }, publicKeyOf(next))).toBe(false);
  expect(await store.save({ privateKey: next, rotation }, publicKeyOf(first))).toBe(true);
  expect(await store.load()).toEqual({ privateKey: next, rotation });
  for (const f of ["federation-key.jwk", "federation-key.previous.json"]) {
    expect(statSync(join(dir, f)).mode & 0o777).toBe(0o600);
  }
  // The previous file keeps only the public half of the old key.
  const previous = readFileSync(join(dir, "federation-key.previous.json"), "utf8");
  expect(previous).not.toContain(JSON.parse(first).d);
  // A new process reads the same state (the key file wins over creating a new one).
  expect(await federationKeyFile(dir)).toBe(next);
});

it("drops the hand-over when the overlap is over, or when it's for another key", async () => {
  const dir = dataDir();
  const first = await federationKeyFile(dir);
  const store = federationKeyStore(dir);
  const next = await generateServerKey();
  const past = Math.floor(Date.now() / 1000) - 10;
  const rotation = {
    previous_key: publicKeyOf(first),
    created: past - 60,
    expires: past,
    sig: "s",
    legacy_sig: "l",
  };
  await store.save({ privateKey: next, rotation }, publicKeyOf(first));
  expect(await store.load()).toEqual({ privateKey: next });
  // Removed from disk as well.
  expect(() => statSync(join(dir, "federation-key.previous.json"))).toThrow();
  // A backup of the old key file restored over the new one: the stale hand-over is ignored.
  const later = { ...rotation, expires: past + 3600 };
  await store.save({ privateKey: first, rotation: later }, publicKeyOf(next));
  writeFileSync(join(dir, "federation-key.jwk"), `${next}\n`);
  expect(await store.load()).toEqual({ privateKey: next });
});
