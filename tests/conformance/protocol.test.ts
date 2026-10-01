// Device protocol v1 conformance (protocol.md "Versions and compatibility"): example messages and
// the schema snapshot. NEVER edit a v1 vector to make a test pass: a change that needs one is a
// breaking change and needs a new PROTOCOL_VERSION (CONTRIBUTING.md).
import { readFileSync } from "node:fs";
import {
  decodeAppToServer,
  decodeDeviceToServer,
  decodeServerToApp,
  decodeServerToDevice,
  fromBase64Url,
  PROTOCOL_VERSION,
} from "@openloungephone/protocol";
import { describe, expect, it } from "vitest";
import { compare, compareAll } from "./schemaCompat.ts";
import { GATED, PROTOCOL_SCHEMAS, snapshotAll } from "./schemas.ts";
import { withUnknownFields } from "./tolerance.ts";

const load = (file: string) =>
  JSON.parse(readFileSync(new URL(`./protocol-v1/${file}`, import.meta.url), "utf8"));

const DECODERS = {
  DeviceToServer: decodeDeviceToServer,
  ServerToDevice: decodeServerToDevice,
  AppToServer: decodeAppToServer,
  ServerToApp: decodeServerToApp,
} as const;

describe("device protocol v1", () => {
  it("is still version 1", () => {
    expect(PROTOCOL_VERSION).toBe(1);
  });

  it("every example decodes, and decodes the same with unknown fields added", () => {
    for (const ex of load("messages.json").examples) {
      const decode = DECODERS[ex.dir as keyof typeof DECODERS];
      const res = decode(JSON.stringify(ex.json));
      expect(res.ok, `${ex.dir} ${JSON.stringify(ex.json)} ${res.ok ? "" : res.detail}`).toBe(true);
      const again = decode(JSON.stringify(withUnknownFields(ex.json)));
      expect(again, ex.json.t).toEqual(res);
    }
  });

  it("covers the handshake, pairing, auth, config and calls", () => {
    const types = new Set(
      (load("messages.json").examples as { json: { t: string } }[]).map((e) => e.json.t),
    );
    for (const t of [
      "hello",
      "pair.begin",
      "pair.code",
      "pair.done",
      "auth.challenge",
      "auth.proof",
      "config",
      "call.ringing",
      "call.answer",
      "call.hangup",
      "call.state",
      "rtc.config",
      "rtc.sdp",
      "rtc.ice",
      "error",
      "app.hello",
      "app.ready",
    ]) {
      expect(types.has(t), t).toBe(true);
    }
  });

  it("auth.proof: a signature over the raw nonce bytes verifies (Ed25519 and P-256 r‖s)", async () => {
    const a = load("auth.json");
    const nonce = fromBase64Url(a.nonce);
    expect(nonce.length).toBe(32);
    const ed = await crypto.subtle.importKey(
      "raw",
      fromBase64Url(a.ed25519.publicKey),
      { name: "Ed25519" },
      false,
      ["verify"],
    );
    expect(a.ed25519.sig).toHaveLength(86);
    expect(await crypto.subtle.verify("Ed25519", ed, fromBase64Url(a.ed25519.sig), nonce)).toBe(
      true,
    );
    const p256 = await crypto.subtle.importKey(
      "raw",
      fromBase64Url(a.p256.publicKey),
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"],
    );
    expect(a.p256.sig).toHaveLength(86);
    expect(
      await crypto.subtle.verify(
        { name: "ECDSA", hash: "SHA-256" },
        p256,
        fromBase64Url(a.p256.sig),
        nonce,
      ),
    ).toBe(true);
    expect(decodeDeviceToServer(JSON.stringify({ t: "auth.proof", sig: a.p256.sig })).ok).toBe(
      true,
    );
  });

  it("schema snapshot: additive changes only", () => {
    const snapshot = load("schemas.json");
    const diff = compareAll(snapshot, snapshotAll(PROTOCOL_SCHEMAS), GATED);
    expect(diff.breaking).toEqual([]);
    // New message types are additive; a removed one is not.
    const union = snapshot.DeviceToServer;
    const fewer = structuredClone(union);
    fewer.anyOf = (fewer.anyOf ?? fewer.oneOf).filter(
      (v: { properties: { t: { const: string } } }) => v.properties.t.const !== "hook",
    );
    delete fewer.oneOf;
    expect(compare(union, fewer).breaking).toContain("(root): variant t=hook removed");
  });
});
