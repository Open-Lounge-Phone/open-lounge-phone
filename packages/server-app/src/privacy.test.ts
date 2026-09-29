// Security and privacy settings (docs/security-model.md): the four-word device fingerprint,
// what a phone runs, per-space retention defaults and per-space transcription.

import { deviceFingerprint } from "@openloungephone/core";
import { DAY_MS } from "@openloungephone/db";
import { beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import { expectStatus, hello, newKey, TestServer } from "./testkit.ts";

const AUDIO = new Uint8Array(500).fill(3);
let s: TestServer;
let transcribe: Mock<(audio: ArrayBuffer, contentType: string) => Promise<string>>;
beforeEach(() => {
  transcribe = vi.fn(async (audio: ArrayBuffer) => `heard ${audio.byteLength} bytes`);
  s = new TestServer({ publicUrl: "https://home.test", env: { transcriber: { transcribe } } });
});

/** Mom (guardian) with a paired kids' phone, and Dad (a member, not a guardian). */
async function home() {
  const mom = await s.person("mom", "Mom");
  const dad = await s.store.createUser(
    { householdId: mom.household.id, name: "Dad", role: "contact" },
    s.timers.now,
  );
  const dadToken = await s.store.createSession(dad.id, s.timers.now);
  const key = await newKey();
  const conn = s.openDevice();
  conn.write(hello());
  conn.write({ t: "pair.begin", publicKey: key.publicKey });
  const { code } = await conn.next("pair.code");
  const preview = await s.http("/devices/pair/preview", { token: mom.token, body: { code } });
  const paired = await s.http("/devices/pair", { token: mom.token, body: { code, name: "Kid" } });
  const { deviceId } = await conn.next("pair.done");
  return { mom, dad, dadToken, key, deviceId, preview, paired };
}

const leaveVoicemail = (token: string, deviceId: string) =>
  s.http(`/devices/${deviceId}/voicemail?durationMs=3000`, {
    token,
    raw: AUDIO,
    type: "audio/webm",
  });

describe("four-word device fingerprint", () => {
  it("is shown before pairing, after pairing and on the phone's page — the phone's own words", async () => {
    const { mom, key, deviceId, preview, paired } = await home();
    const words = await deviceFingerprint(key.publicKey);
    expect(words).toHaveLength(4);
    expect(preview.json.fingerprint).toEqual(words);
    expect(paired.json.fingerprint).toEqual(words);
    const list = await s.http("/devices", { token: mom.token });
    expect(list.json.find((d: { id: string }) => d.id === deviceId)).toMatchObject({
      fingerprint: words,
      fw: null,
      lastSeen: null,
    });
    // Once it has connected: what it runs, and when it was last seen.
    await s.connectDevice(deviceId, key.pair);
    const after = (await s.http("/devices", { token: mom.token })).json[0];
    expect(after).toMatchObject({ fw: "test", model: "web-emulator", lastSeen: s.timers.now });
  });
});

describe("per-space retention", () => {
  const privacy = (token: string, body: unknown) =>
    s.http("/space/privacy", { method: "PUT", token, body });

  it("is forever by default, and only guardians change it", async () => {
    const { mom, dadToken } = await home();
    expect((await s.http("/space/privacy", { token: dadToken })).json).toEqual({
      history: "forever",
      voicemail: "forever",
      transcription: true,
      transcriber: true,
    });
    expectStatus(await privacy(dadToken, { history: "30d" }), 403);
    expectStatus(await privacy(mom.token, { history: "weekly" }), 400);
    expectStatus(await privacy(mom.token, { history: "30d", voicemail: "1y" }), 204);
    expect((await s.http("/space/privacy", { token: mom.token })).json).toMatchObject({
      history: "30d",
      voicemail: "1y",
    });
  });

  it("expires a phone's voicemail and calls, and the Lounge history, by the space's defaults", async () => {
    const { mom, deviceId } = await home();
    expectStatus(await leaveVoicemail(mom.token, deviceId), 201);
    await s.store.logCall({
      householdId: mom.household.id,
      accountId: null,
      deviceId,
      peer: `user:${mom.user.id}`,
      peerLabel: "Mom",
      direction: "out",
      startedAt: s.timers.now,
      answered: true,
      durationMs: 1000,
      endReason: "hangup",
    });
    const session = await s.store.startLoungeSession(
      { householdId: mom.household.id, deviceId, userId: mom.user.id },
      s.timers.now,
    );
    await s.store.endLoungeSession(session, "logout", s.timers.now);
    expectStatus(await privacy(mom.token, { history: "30d", voicemail: "30d" }), 204);
    s.timers.advance(29 * DAY_MS);
    await s.store.sweepExpired(mom.household.id, s.host, s.timers.now);
    expect(await s.store.listVoicemails(mom.household.id)).toHaveLength(1);
    s.timers.advance(2 * DAY_MS);
    // Reading the inbox sweeps first: the message and its audio are gone.
    expect((await s.http("/voicemails", { token: mom.token })).json).toEqual([]);
    expect(await s.store.listVoicemails(mom.household.id)).toEqual([]);
    expect([...s.blobs.keys()].filter((k) => k.startsWith("voicemail/"))).toEqual([]);
    expect(await s.store.listLoungeSessions(mom.household.id)).toEqual([]);
    const rows = await s.store.sweepExpired(mom.household.id, s.host, s.timers.now);
    expect(rows.calls).toBe(0);
  });

  it("a person's own setting comes first", async () => {
    const mom = await s.person("mom", "Mom");
    const bob = await s.person("bob", "Bob");
    expectStatus(
      await s.http("/connections", { token: mom.token, body: { to: bob.address } }),
      202,
    );
    const knock = (await s.http("/connections", { token: bob.token })).json.connections[0];
    await s.http(`/connections/${knock.id}/accept`, { method: "POST", token: bob.token });
    const log = (accountId: string, peer: string) =>
      s.store.logCall({
        householdId: bob.household.id,
        accountId,
        deviceId: null,
        peer,
        peerLabel: "x",
        direction: "in",
        startedAt: s.timers.now,
        answered: true,
        durationMs: 1,
        endReason: "hangup",
      });
    await log(bob.account.id, mom.address);
    // Bob's space keeps history 30 days; Bob keeps his forever.
    expectStatus(await privacy(bob.token, { history: "30d" }), 204);
    let timeline = await s.http(`/connections/${knock.id}/timeline`, { token: bob.token });
    expect(timeline.json.retention).toMatchObject({ effective: "30d", from: "space" });
    expectStatus(
      await s.http("/account/retention", {
        method: "PUT",
        token: bob.token,
        body: { retention: "forever" },
      }),
      204,
    );
    s.timers.advance(40 * DAY_MS);
    timeline = await s.http(`/connections/${knock.id}/timeline`, { token: bob.token });
    expect(timeline.json.retention).toMatchObject({ effective: "forever", from: "account" });
    expect(timeline.json.items).toHaveLength(1);
  });
});

describe("per-space transcription", () => {
  it("is on by default; switched off, voicemail is never sent to speech-to-text", async () => {
    const { mom, dadToken, deviceId } = await home();
    expectStatus(await leaveVoicemail(mom.token, deviceId), 201);
    await Promise.all(s.background);
    expect(transcribe).toHaveBeenCalledTimes(1);
    expectStatus(
      await s.http("/space/privacy", {
        method: "PUT",
        token: dadToken,
        body: { transcription: false },
      }),
      403,
    );
    expectStatus(
      await s.http("/space/privacy", {
        method: "PUT",
        token: mom.token,
        body: { transcription: false },
      }),
      204,
    );
    expectStatus(await leaveVoicemail(mom.token, deviceId), 201);
    await Promise.all(s.background);
    expect(transcribe).toHaveBeenCalledTimes(1);
    const inbox = (await s.http("/voicemails", { token: mom.token })).json;
    expect(inbox.map((v: { transcriptStatus: string }) => v.transcriptStatus)).toEqual([
      "unavailable",
      "done",
    ]);
  });
});
