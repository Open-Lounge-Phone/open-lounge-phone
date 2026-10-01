// Writes the v1 conformance vectors and extends the schema snapshots.
//
//   node tests/conformance/generate.ts            vectors that don't exist yet (never rewrites one)
//   node tests/conformance/generate.ts snapshot   adds new fields/types to the schema snapshots;
//                                                 refuses if anything else changed
//
// The vectors are frozen: a file that exists is never written again (a breaking change needs v2
// and a new directory). Keys are the RFC 8032 §7.1 test keys: public test vectors, never used for
// anything real.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import {
  contentDigest,
  keyRotationStatement,
  loadServerKey,
  type ServerKey,
  signBytes,
  signRequest,
  streamStatement,
} from "@openloungephone/federation";
import { toBase64Url } from "@openloungephone/protocol";
import { compareAll } from "./schemaCompat.ts";
import { FEDERATION_SCHEMAS, GATED, PROTOCOL_SCHEMAS, snapshotAll } from "./schemas.ts";

const dir = (name: string) => new URL(`./${name}/`, import.meta.url);
const utf8 = (s: string) => new TextEncoder().encode(s);
const hex = (h: string) => Uint8Array.from(h.match(/../g) ?? [], (b) => Number.parseInt(b, 16));

/** RFC 8032 §7.1 TEST 1 and TEST 2 secret keys. */
export const TEST_SEEDS = {
  a: "9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60",
  b: "4ccd089b28ff96da9db6c346ec114e0f5b8a319f35aba624da8cf6ed4fb8a6fb",
};

/** An Ed25519 key from a raw 32-byte seed, as the JWK `generateServerKey` stores. */
export async function jwkFromSeed(seedHex: string): Promise<string> {
  const pkcs8 = new Uint8Array([...hex("302e020100300506032b657004220420"), ...hex(seedHex)]);
  const key = await crypto.subtle.importKey("pkcs8", pkcs8, { name: "Ed25519" }, true, ["sign"]);
  const jwk = await crypto.subtle.exportKey("jwk", key);
  return JSON.stringify({ kty: jwk.kty, crv: jwk.crv, d: jwk.d, x: jwk.x });
}

function write(name: string, file: string, data: unknown): void {
  const d = dir(name);
  mkdirSync(d, { recursive: true });
  const target = new URL(file, d);
  if (existsSync(target)) {
    console.log(`kept      ${name}/${file} (frozen)`);
    return;
  }
  writeFileSync(target, `${JSON.stringify(data, null, 2)}\n`);
  console.log(`wrote     ${name}/${file}`);
}

const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));

async function signatureVectors(a: ServerKey, jwkA: string) {
  const cases = [
    {
      name: "knock (POST with a JSON body)",
      method: "POST",
      url: "https://b.example/fed/v1/knock",
      body: '{"from":{"handle":"jesse","id":"acc_1","name":"Jesse"},"to":"bob","note":"hi"}',
      created: 1790000000,
      nonce: "Zm9vYmFyYmF6cXV4MTIzNA",
    },
    {
      name: "voicemail (POST with a query and a binary body)",
      method: "POST",
      url: "https://b.example/fed/v1/voicemail?to=dev_1&from=jesse&fromId=acc_1&name=Jesse&durationMs=1500",
      bodyBase64: b64(Uint8Array.from({ length: 64 }, (_, i) => (i * 37) % 256)),
      created: 1790000300,
      nonce: "AAECAwQFBgcICQoLDA0ODw",
    },
    {
      name: "a request without a body (no content-digest)",
      method: "POST",
      url: "https://b.example:8443/fed/v1/connections/remove",
      created: 1790000600,
      nonce: "bm9uY2Utd2l0aG91dC1ib2R5",
    },
  ];
  const vectors = [];
  for (const c of cases) {
    const body =
      "body" in c && c.body !== undefined
        ? utf8(c.body)
        : "bodyBase64" in c && c.bodyBase64
          ? Uint8Array.from(atob(c.bodyBase64), (x) => x.charCodeAt(0))
          : undefined;
    const headers = await signRequest({
      method: c.method,
      url: c.url,
      body,
      keyId: "a.example",
      privateKey: a.privateKey,
      now: c.created * 1000,
      nonce: c.nonce,
    });
    const params = headers["signature-input"]?.slice("sig1=".length);
    const lines = [
      `"@method": ${c.method}`,
      `"@target-uri": ${c.url}`,
      ...(headers["content-digest"] ? [`"content-digest": ${headers["content-digest"]}`] : []),
      `"@signature-params": ${params}`,
    ];
    vectors.push({ ...c, keyId: "a.example", base: lines.join("\n"), headers });
  }
  return {
    about:
      "RFC 9421 request signatures in the /fed/v1 profile (spec §4). `base` is the signature base; `headers` are exactly what the sender sends. Ed25519 is deterministic, so signing `base` with key `a` gives `headers.signature`.",
    keys: { a: { jwk: JSON.parse(jwkA), publicKey: a.publicKey } },
    vectors,
  };
}

async function main() {
  const jwkA = await jwkFromSeed(TEST_SEEDS.a);
  const jwkB = await jwkFromSeed(TEST_SEEDS.b);
  const a = await loadServerKey(jwkA);
  const b = await loadServerKey(jwkB);

  if (process.argv[2] === "snapshot") {
    for (const [name, schemas] of [
      ["federation-v1", FEDERATION_SCHEMAS],
      ["protocol-v1", PROTOCOL_SCHEMAS],
    ] as const) {
      const file = new URL("schemas.json", dir(name));
      const current = snapshotAll(schemas);
      if (existsSync(file)) {
        const old = JSON.parse(readFileSync(file, "utf8"));
        const diff = compareAll(old, current, GATED);
        if (diff.breaking.length) {
          console.error(
            `${name}: not additive, snapshot NOT updated:\n${diff.breaking.join("\n")}`,
          );
          process.exitCode = 1;
          continue;
        }
        if (!diff.additive.length) {
          console.log(`unchanged ${name}/schemas.json`);
          continue;
        }
        console.log(`additive  ${name}/schemas.json:\n  ${diff.additive.join("\n  ")}`);
      }
      mkdirSync(dir(name), { recursive: true });
      writeFileSync(file, `${JSON.stringify(current, null, 2)}\n`);
      console.log(`wrote     ${name}/schemas.json`);
    }
    return;
  }

  write("federation-v1", "signatures.json", await signatureVectors(a, jwkA));

  const digests = [
    { body: "", digest: await contentDigest(new Uint8Array()) },
    { body: '{"hello":"world"}', digest: await contentDigest(utf8('{"hello":"world"}')) },
    { body: "héllo ✓", digest: await contentDigest(utf8("héllo ✓")) },
  ];
  write("federation-v1", "content-digest.json", {
    about: "RFC 9530 Content-Digest (sha-256, standard base64 between colons) of the UTF-8 body.",
    vectors: digests,
  });

  const rotation = { host: "a.example", previousKey: a.publicKey, newKey: b.publicKey };
  const created = 1790000000;
  const expires = created + 7 * 86400;
  const statement = keyRotationStatement({ ...rotation, created, expires });
  const legacyStatement = `openloungephone-key-rotation:${b.publicKey}`;
  write("federation-v1", "key-rotation.json", {
    about:
      "Key rotation (spec §3.2): key `a` hands over to key `b` for host a.example. `wellKnown` is the document published during the overlap; `checks` are what a receiver that pinned `a` decides at `now` (Unix seconds).",
    keys: { a: { jwk: JSON.parse(jwkA), publicKey: a.publicKey }, b: { publicKey: b.publicKey } },
    statement,
    sig: await signBytes(a, statement),
    legacy: { statement: legacyStatement, sig: await signBytes(a, legacyStatement) },
    wellKnown: {
      version: 1,
      server_key: b.publicKey,
      federation: "/fed/v1",
      software: "openloungephone/0.2.0",
      versions: { "1": "/fed/v1" },
      features: ["key-rotation"],
      previous_key: a.publicKey,
      rotation_sig: await signBytes(a, legacyStatement),
      rotation: { previous_key: a.publicKey, created, expires, sig: await signBytes(a, statement) },
    },
    checks: [
      { now: created, host: "a.example", result: { ok: true } },
      { now: expires - 1, host: "a.example", result: { ok: true } },
      { now: expires, host: "a.example", result: { ok: false, reason: "expired" } },
      { now: created - 301, host: "a.example", result: { ok: false, reason: "window" } },
      { now: created, host: "c.example", result: { ok: false, reason: "bad_signature" } },
    ],
  });

  const nonce = "c3RyZWFtLW5vbmNlLTAwMQ";
  const hello = { t: "hello", from: "a.example", to: "b.example", created, nonce };
  const helloOk = {
    t: "hello.ok",
    from: "b.example",
    to: "a.example",
    created: created + 1,
    nonce,
  };
  write("federation-v1", "stream-hello.json", {
    about:
      "The server-pair stream handshake (spec §6.1): a.example (key `a`) dials b.example (key `b`); `hello.ok` echoes the dialer's nonce. `statement` is what each side signs.",
    keys: { a: { publicKey: a.publicKey }, b: { publicKey: b.publicKey } },
    hello: {
      ...hello,
      statement: streamStatement(hello.from, hello.to, hello.created, nonce),
      sig: await signBytes(a, streamStatement(hello.from, hello.to, hello.created, nonce)),
    },
    helloOk: {
      ...helloOk,
      statement: streamStatement(helloOk.from, helloOk.to, helloOk.created, nonce),
      sig: await signBytes(b, streamStatement(helloOk.from, helloOk.to, helloOk.created, nonce)),
    },
  });

  const party = { handle: "jesse", id: "acc_1", name: "Jesse" };
  const callId = "call_7f3a";
  write("federation-v1", "messages.json", {
    about:
      "Example /fed/v1 bodies, results, queries and stream frames (spec §6.3, §7), by schema. Each must parse, and still parse to the same value with unknown fields added.",
    examples: [
      { schema: "KnockBody", json: { from: party, to: "bob", note: "It's Jesse from the band" } },
      { schema: "KnockBody", json: { from: party, to: "bob" } },
      {
        schema: "AcceptBody",
        json: { from: { handle: "bob", id: "acc_9", name: "Bob" }, to: "jesse" },
      },
      { schema: "RemoveBody", json: { from: party, to: "bob" } },
      { schema: "Accepted", json: { ok: true } },
      { schema: "FedErrorBody", json: { error: "signature: replay" } },
      { schema: "CallBody", json: { callId, from: party, to: { kind: "person", handle: "bob" } } },
      {
        schema: "CallBody",
        json: {
          callId,
          from: party,
          to: { kind: "phone", deviceId: "dev_kid1" },
          viaPhone: { label: "Kid phone" },
          recording: false,
        },
      },
      {
        schema: "CallBody",
        json: {
          callId,
          from: party,
          to: { kind: "guest", deviceId: "dev_lounge" },
          guestOf: "c.example",
          ringLabel: "Lounge",
          recording: true,
        },
      },
      { schema: "CallResult", json: { state: "ringing" } },
      {
        schema: "CallResult",
        json: { state: "ended", reason: "denied", note: "This server doesn't take recorded calls" },
      },
      {
        schema: "CallResult",
        json: {
          state: "ended",
          reason: "timeout",
          voicemail: {
            ticket: "vmt_0123456789abcdef",
            name: "Bob",
            maxMs: 120000,
            prompts: ["name", "vm.cant_take", "vm.leave_message", "vm.tone"],
          },
        },
      },
      {
        schema: "PresenceBody",
        json: { from: party, to: ["bob", "carol"], online: true, available: false },
      },
      {
        schema: "PhonesBody",
        json: { from: party, to: "bob", phones: [{ id: "dev_kid1", label: "Kid phone" }] },
      },
      { schema: "GreetingBody", json: { from: party, to: { kind: "person", handle: "bob" } } },
      {
        schema: "GreetingBody",
        json: { from: party, to: { kind: "phone", deviceId: "dev_kid1" } },
      },
      {
        schema: "VoicemailQuery",
        json: {
          to: "bob",
          kind: "person",
          from: "jesse",
          fromId: "acc_1",
          name: "Jesse",
          durationMs: "4000",
        },
      },
      {
        schema: "VoicemailQuery",
        json: { to: "dev_kid1", from: "jesse", fromId: "acc_1", name: "Jesse", durationMs: "1500" },
      },
      {
        schema: "LoungeClaimBody",
        json: {
          from: party,
          deviceId: "dev_lounge",
          nonce: "bG91bmdlLW5vbmNlLTAwMQ",
          directory: [{ address: "bob@b.example", name: "Bob" }],
        },
      },
      { schema: "LoungeClaimResult", json: { step: "press_key", expiresAt: 1790000030000 } },
      { schema: "LoungeClaimResult", json: { step: "failed", reason: "busy" } },
      {
        schema: "LoungeProgressBody",
        json: { to: "jesse", deviceId: "dev_lounge", step: "started" },
      },
      {
        schema: "LoungeDialBody",
        json: {
          callId,
          for: "jesse",
          deviceId: "dev_lounge",
          deviceLabel: "Lounge",
          to: "bob@b.example",
        },
      },
      { schema: "LoungeLeaveBody", json: { from: party, deviceId: "dev_lounge" } },
      { schema: "RoomJoinBody", json: { leg: "leg_1", from: party, room: "standup" } },
      { schema: "RoomJoinResult", json: { ok: true, roomId: "room_1", name: "Standup" } },
      { schema: "RoomJoinResult", json: { ok: false, reason: "locked" } },
      { schema: "StreamQuery", json: { from: "a.example" } },
      {
        schema: "StreamSignal",
        json: { t: "signal", msg: { t: "call.state", callId, state: "ringing" } },
      },
      {
        schema: "StreamSignal",
        json: { t: "signal", msg: { t: "call.state", callId, state: "ended", reason: "hangup" } },
      },
      {
        schema: "StreamSignal",
        json: { t: "signal", msg: { t: "rtc.sdp", callId, type: "offer", sdp: "v=0\r\n" } },
      },
      {
        schema: "StreamSignal",
        json: {
          t: "signal",
          msg: {
            t: "rtc.ice",
            callId,
            candidate: "candidate:1 1 udp 1 192.0.2.1 9 typ host",
            sdpMid: "0",
            sdpMLineIndex: 0,
          },
        },
      },
      {
        schema: "StreamSignal",
        json: {
          t: "signal",
          msg: { t: "room.signal", callId: "leg_1", msg: { t: "room.leave", roomId: "room_1" } },
        },
      },
      {
        schema: "StreamUnsupported",
        json: { t: "unsupported", type: "signal:call.video", callId },
      },
    ],
  });

  write("federation-v1", "well-known.json", {
    about:
      "`.well-known/openloungephone` documents (spec §2, §9): an 0.1 server's, a 0.2 server's, and a newer server's with fields and versions a v1 receiver doesn't know. All must parse; `offer` is what a receiver reads from each.",
    examples: [
      {
        name: "0.1 server",
        json: {
          version: 1,
          server_key: a.publicKey,
          federation: "/fed/v1",
          software: "openloungephone/0.1",
        },
        offer: { versions: { "1": "/fed/v1" }, legacyFeatures: true, negotiated: 1 },
      },
      {
        name: "0.2 server",
        json: {
          version: 1,
          server_key: a.publicKey,
          federation: "/fed/v1",
          software: "openloungephone/0.2.0",
          versions: { "1": "/fed/v1" },
          features: [
            "rooms",
            "recording-flag",
            "lounge-guests",
            "key-rotation",
            "voicemail-greeting",
            "presence-batch",
            "transfer",
          ],
        },
        offer: { versions: { "1": "/fed/v1" }, legacyFeatures: false, negotiated: 1 },
      },
      {
        name: "newer server (speaks 1 and 2, unknown fields and features)",
        json: {
          version: 2,
          server_key: a.publicKey,
          federation: "/fed/v1",
          software: "openloungephone/3.0.0",
          versions: { "1": "/fed/v1", "2": "/fed/v2" },
          features: ["rooms", "video"],
          motd: "hello",
          policy: { retention: "30d" },
        },
        offer: {
          versions: { "1": "/fed/v1", "2": "/fed/v2" },
          legacyFeatures: false,
          negotiated: 1,
        },
      },
      {
        name: "v2-only server (no common version with v1)",
        json: {
          version: 2,
          server_key: a.publicKey,
          federation: "/fed/v1",
          versions: { "2": "/fed/v2" },
          features: [],
        },
        offer: { versions: { "2": "/fed/v2" }, legacyFeatures: false, negotiated: null },
      },
    ],
  });

  const deviceKey = "Ag".padEnd(43, "A");
  write("protocol-v1", "messages.json", {
    about:
      "Example device and app messages (protocol.md), by direction. Each must decode, and still decode to the same value with unknown fields added.",
    examples: [
      {
        dir: "DeviceToServer",
        json: { t: "hello", proto: 1, model: "esp32s3", fw: "0.7.0", buttons: 10, display: "eink" },
      },
      {
        dir: "DeviceToServer",
        json: {
          t: "hello",
          proto: 1,
          deviceId: "dev_1",
          model: "web-emulator",
          fw: "web",
          buttons: 4,
          display: "none",
        },
      },
      { dir: "DeviceToServer", json: { t: "pair.begin", publicKey: deviceKey } },
      {
        dir: "DeviceToServer",
        json: { t: "pair.begin", alg: "ed25519", kind: "kids", publicKey: deviceKey },
      },
      { dir: "DeviceToServer", json: { t: "auth.proof", sig: "A".repeat(86) } },
      { dir: "DeviceToServer", json: { t: "hook", state: "up" } },
      { dir: "DeviceToServer", json: { t: "button", index: 0 } },
      { dir: "DeviceToServer", json: { t: "call.answer", callId } },
      { dir: "DeviceToServer", json: { t: "call.hangup", callId } },
      { dir: "DeviceToServer", json: { t: "rtc.sdp", callId, type: "answer", sdp: "v=0\r\n" } },
      { dir: "DeviceToServer", json: { t: "rtc.ice", callId, candidate: null } },
      { dir: "DeviceToServer", json: { t: "status", rssi: -61, uptimeS: 3600 } },
      { dir: "DeviceToServer", json: { t: "ping" } },
      {
        dir: "ServerToDevice",
        json: { t: "auth.challenge", nonce: "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8" },
      },
      { dir: "ServerToDevice", json: { t: "pair.code", code: "123456", expiresAt: 1790000600000 } },
      { dir: "ServerToDevice", json: { t: "pair.done", deviceId: "dev_1", householdId: "hh_1" } },
      {
        dir: "ServerToDevice",
        json: { t: "config", buttons: [{ index: 0, label: "Mom" }], quiet: false },
      },
      {
        dir: "ServerToDevice",
        json: {
          t: "config",
          buttons: [{ index: 0, label: "Mom" }],
          quiet: true,
          quietUntil: "07:00",
          utcOffsetMin: 120,
          missed: [{ from: "Grandma" }],
          greeting: { kind: "default", canRecord: true },
          owner: { mode: "kids", space: "Smith home" },
          server: {
            software: "openloungephone/0.2.0",
            protocol: { min: 1, max: 1 },
            features: ["call-control", "rooms"],
          },
        },
      },
      {
        dir: "ServerToDevice",
        json: {
          t: "config",
          buttons: [],
          quiet: false,
          update: { minProtocol: 2, message: "UPDATE NEEDED" },
        },
      },
      { dir: "ServerToDevice", json: { t: "call.ringing", callId, from: { label: "Grandma" } } },
      { dir: "ServerToDevice", json: { t: "call.state", callId, state: "connecting" } },
      {
        dir: "ServerToDevice",
        json: { t: "call.state", callId, state: "ended", reason: "voicemail", note: "Quiet hours" },
      },
      {
        dir: "ServerToDevice",
        json: { t: "rtc.config", callId, iceServers: [{ urls: "stun:stun.example:3478" }] },
      },
      {
        dir: "ServerToDevice",
        json: { t: "error", code: "bad_message", message: "not supported: x", unsupported: "x" },
      },
      {
        dir: "ServerToDevice",
        json: {
          t: "error",
          code: "unsupported_version",
          message: "Update needed",
          server: { software: "openloungephone/0.2.0", protocol: { min: 1, max: 1 }, features: [] },
        },
      },
      { dir: "ServerToDevice", json: { t: "pong" } },
      { dir: "AppToServer", json: { t: "app.hello", proto: 1, token: "tok_0123456789abcdef" } },
      { dir: "AppToServer", json: { t: "call.connection", connectionId: "c_1" } },
      { dir: "ServerToApp", json: { t: "app.ready", userId: "usr_1" } },
      {
        dir: "ServerToApp",
        json: {
          t: "app.ready",
          userId: "usr_1",
          server: {
            software: "openloungephone/0.2.0",
            protocol: { min: 1, max: 1 },
            features: ["rooms"],
          },
        },
      },
    ],
  });

  // A phone's answer to `auth.challenge`: Ed25519 over the raw nonce bytes (deterministic).
  const device = await crypto.subtle.importKey(
    "pkcs8",
    new Uint8Array([...hex("302e020100300506032b657004220420"), ...hex(TEST_SEEDS.b)]),
    { name: "Ed25519" },
    true,
    ["sign"],
  );
  const devicePub = (await crypto.subtle.exportKey("jwk", device)).x as string;
  const challenge = Uint8Array.from({ length: 32 }, (_, i) => (i * 13 + 7) % 256);
  const devSig = new Uint8Array(await crypto.subtle.sign("Ed25519", device, challenge));
  // P-256 (hardware phones): ECDSA isn't deterministic in WebCrypto; the vector is verified only.
  const p256 = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const p256Pub = new Uint8Array(await crypto.subtle.exportKey("raw", p256.publicKey));
  const p256Sig = new Uint8Array(
    await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, p256.privateKey, challenge),
  );
  write("protocol-v1", "auth.json", {
    about:
      "Device authentication (protocol.md): the server sends `auth.challenge` with `nonce` (base64url of 32 random bytes); the phone signs the raw nonce bytes and answers `auth.proof` with `sig` (base64url, 86 chars). Ed25519 is deterministic (key from RFC 8032 TEST 2); P-256 is ECDSA/SHA-256 as r‖s and is checked by verifying.",
    nonce: toBase64Url(challenge),
    ed25519: { publicKey: devicePub, sig: toBase64Url(devSig) },
    p256: { publicKey: toBase64Url(p256Pub), sig: toBase64Url(p256Sig) },
  });
}

await main();
