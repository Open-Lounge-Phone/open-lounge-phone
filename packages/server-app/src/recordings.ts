// Call recording (docs/security-model.md, "Recording"): the per-space switch, the upload of a
// recording made by the recording side's own client, and access to recordings.
//
// The server never records anything itself (1:1 calls are peer to peer and it never hears them;
// rooms are recorded by the host's client too, see docs/security-model.md). It only hands one
// client an upload ticket, together with the announcement every party gets (`hub.ts`
// `announceRecording`, `liveRooms.ts` `updateRecording`).
import { mayEnableRecording, RECORDING_MAX_MS } from "@openloungephone/core";
import { deviceMode, newId, type Recording, type User } from "@openloungephone/db";
import type { Hono } from "hono";
import { z } from "zod";
import type { ServerEnv } from "./env.ts";
import { fairUseProblem } from "./fairUse.ts";
import { body, guardianOnly, type Vars } from "./httpUtil.ts";
import { readRecording } from "./voicemail.ts";
import { auditFrom } from "./workplace.ts";

/** A two-hour call in Opus is ~30 MB at most; leave room for other codecs' overhead. */
export const MAX_RECORDING_BYTES = 64 * 1024 * 1024;

const RecordingBody = z.object({ enabled: z.boolean() });

/** Kids' phones in a space (a home with any never records). */
async function kidsPhones(env: ServerEnv, householdId: string): Promise<number> {
  return (await env.store.listDevices(householdId)).filter((d) => deviceMode(d) === "kids").length;
}

/** Whether a space records calls right now (the switch, and no kids' phones). */
export async function spaceRecords(env: ServerEnv, householdId: string): Promise<boolean> {
  return (
    (await env.store.recordings.enabled(householdId)) && (await kidsPhones(env, householdId)) === 0
  );
}

const view = (r: Recording) => ({
  id: r.id,
  kind: r.kind,
  callId: r.callId,
  peerLabel: r.peerLabel,
  startedAt: r.startedAt,
  durationMs: r.durationMs,
  transcript: r.transcript,
  transcriptStatus: r.transcriptStatus,
});

async function transcribe(env: ServerEnv, rec: Recording, audio: ArrayBuffer): Promise<void> {
  if (!env.transcriber) return;
  try {
    const text = (await env.transcriber.transcribe(audio, rec.mime)).trim();
    await env.store.recordings.setTranscript(rec.id, "done", text);
  } catch (e) {
    env.log("warn", "recording transcription failed", { id: rec.id, error: String(e) });
    await env.store.recordings.setTranscript(rec.id, "failed", null);
  }
}

/** `POST /api/rec/upload`: its credential is the ticket (phones have no HTTP session). */
export function publicRecordingRoutes(api: Hono<Vars>, env: ServerEnv): void {
  const { store } = env;

  api.post("/rec/upload", async (c) => {
    const token = c.req.query("ticket") ?? "";
    const peek = await store.recordings.peekTicket(token, env.now());
    if (!peek) return c.json({ error: "unknown or used ticket" }, 404);
    const rec = await readRecording(c.req.raw, c.req.query("durationMs"), {
      bytes: MAX_RECORDING_BYTES,
      ms: RECORDING_MAX_MS,
    });
    if (rec instanceof Response) return rec;
    const over = await fairUseProblem(env, peek.accountId ?? undefined, "recording", {
      bytes: rec.audio.byteLength,
    });
    if (over) return c.json({ error: over }, 429);
    const t = await store.recordings.takeTicket(token, env.now());
    if (!t) return c.json({ error: "unknown or used ticket" }, 404);
    const blobKey = `recording/${t.householdId}/${newId("rcb")}`;
    await env.blobs.put(blobKey, rec.audio, rec.mime);
    // Transcribed only where the space transcribes (and the server can).
    const transcribes = !!env.transcriber && (await store.spacePrivacy(t.householdId)).transcribe;
    const saved = await store.recordings.create({
      householdId: t.householdId,
      kind: t.kind,
      callId: t.callId,
      accountId: t.accountId,
      peer: t.peer,
      peerLabel: t.peerLabel,
      startedAt: t.startedAt,
      createdAt: env.now(),
      durationMs: rec.durationMs,
      mime: rec.mime.split(";")[0] ?? rec.mime,
      blobKey,
      bytes: rec.audio.byteLength,
      transcriptStatus: transcribes ? "pending" : "unavailable",
    });
    if (transcribes) env.defer(transcribe(env, saved, rec.audio));
    if (t.accountId) {
      await store.addUsage(t.accountId, env.now(), { voicemailBytes: rec.audio.byteLength });
    }
    return c.json({ id: saved.id }, 201);
  });
}

export function recordingRoutes(api: Hono<Vars>, env: ServerEnv): void {
  const { store } = env;

  /** Whether this space records calls, and whether it may (never a home with kids' phones). */
  api.get("/space/recording", async (c) => {
    const hh = c.get("user").householdId;
    const space = await store.getHousehold(hh);
    const may = mayEnableRecording({
      type: space?.type ?? "home",
      kidsPhones: await kidsPhones(env, hh),
    });
    return c.json({
      enabled: await store.recordings.enabled(hh),
      allowed: may.ok,
      ...(may.ok ? {} : { reason: may.error }),
    });
  });

  /** Guardians (admins) turn recording on or off for the space. It's off by default. */
  api.put("/space/recording", guardianOnly, async (c) => {
    const b = await body(c.req.raw, RecordingBody);
    if (b instanceof Response) return b;
    const hh = c.get("user").householdId;
    if (b.enabled) {
      const space = await store.getHousehold(hh);
      const may = mayEnableRecording({
        type: space?.type ?? "home",
        kidsPhones: await kidsPhones(env, hh),
      });
      if (!may.ok) return c.json({ error: may.error }, 409);
    }
    await store.recordings.setEnabled(hh, b.enabled);
    await auditFrom(env, c, "recording.update", { enabled: b.enabled });
    return c.body(null, 204);
  });

  /** A recording the caller may play: of a call they were in, or (guardians/admins) any here. */
  const reachable = async (user: User, accountId: string, id: string) => {
    const rec = await store.recordings.get(id);
    if (!rec) return undefined;
    if (user.role === "guardian" && rec.householdId === user.householdId) return rec;
    return (await store.recordings.wasParty(rec.id, accountId)) ? rec : undefined;
  };

  /** Your calls' recordings; guardians and admins: all of this space's. */
  api.get("/recordings", async (c) => {
    const user = c.get("user");
    const mine = await store.recordings.forAccount(c.get("account").id);
    const space = user.role === "guardian" ? await store.recordings.list(user.householdId) : [];
    const seen = new Set<string>();
    const all = [...space, ...mine].filter((r) => !seen.has(r.id) && seen.add(r.id));
    return c.json(all.sort((a, b) => b.startedAt - a.startedAt).map(view));
  });

  api.get("/recordings/:id/audio", async (c) => {
    const rec = await reachable(c.get("user"), c.get("account").id, c.req.param("id"));
    const blob = rec && (await env.blobs.get(rec.blobKey));
    if (!blob) return c.json({ error: "not found" }, 404);
    return new Response(blob.data, {
      headers: { "content-type": blob.contentType, "cache-control": "private, max-age=3600" },
    });
  });

  /** Guardians/admins, or whoever made it. */
  api.delete("/recordings/:id", async (c) => {
    const user = c.get("user");
    const account = c.get("account");
    const rec = await store.recordings.get(c.req.param("id"));
    const allowed =
      rec &&
      ((user.role === "guardian" && rec.householdId === user.householdId) ||
        rec.accountId === account.id);
    if (!rec || !allowed) return c.json({ error: "not found" }, 404);
    await store.recordings.delete(rec.id);
    await env.blobs.delete(rec.blobKey);
    await auditFrom(env, c, "recording.delete", { recordingId: rec.id });
    return c.body(null, 204);
  });
}
