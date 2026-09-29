import { newId, type Voicemail } from "@openloungephone/db";
import type { Hono } from "hono";
import type { ServerEnv } from "./env.ts";
import type { Coordinator } from "./gateway.ts";
import { guardianOnly, type Vars } from "./httpUtil.ts";

/** A minute of Opus is ~250 KB; leave generous headroom for other codecs. */
export const MAX_VOICEMAIL_BYTES = 2 * 1024 * 1024;
export const MAX_VOICEMAIL_MS = 60_000;

const AUDIO_TYPE = /^audio\/(webm|ogg|mp4|mpeg|wav|x-wav|aac)(;.*)?$/;

const publicView = ({ blobKey: _b, householdId: _h, ...v }: Voicemail) => v;

/** Transcribes in the background, then tells guardians the transcript is ready. */
async function transcribe(env: ServerEnv, vm: Voicemail, audio: ArrayBuffer): Promise<void> {
  if (!env.transcriber) return;
  try {
    const text = (await env.transcriber.transcribe(audio, vm.mime)).trim();
    await env.store.setTranscript(vm.id, "done", text);
  } catch (e) {
    env.log("warn", "transcription failed", { id: vm.id, error: String(e) });
    await env.store.setTranscript(vm.id, "failed", null);
  }
}

/** Stores a voicemail for a phone, starts its transcript, and tells the household. */
export async function depositVoicemail(
  env: ServerEnv,
  live: Coordinator,
  input: {
    device: { id: string; householdId: string };
    fromUser: string | null;
    fromLabel: string;
    mime: string;
    audio: ArrayBuffer;
    durationMs: number;
  },
): Promise<Voicemail> {
  const { device } = input;
  const blobKey = `voicemail/${device.householdId}/${newId("vmb")}`;
  await env.blobs.put(blobKey, input.audio, input.mime);
  const vm = await env.store.createVoicemail({
    householdId: device.householdId,
    deviceId: device.id,
    fromUser: input.fromUser,
    fromLabel: input.fromLabel,
    createdAt: env.now(),
    durationMs: input.durationMs,
    mime: input.mime.split(";")[0] ?? input.mime,
    blobKey,
    transcriptStatus: env.transcriber ? "pending" : "unavailable",
  });
  env.defer(transcribe(env, vm, input.audio));
  await live.refreshDevice(device.householdId, device.id);
  await live.announce(device.householdId, {
    t: "voicemail.new",
    id: vm.id,
    deviceId: device.id,
    from: input.fromLabel,
  });
  return vm;
}

/** Checks an uploaded recording: an audio type, not empty, not too big. */
export async function readRecording(
  req: Request,
  durationParam: string | undefined,
): Promise<{ mime: string; audio: ArrayBuffer; durationMs: number } | Response> {
  const mime = req.headers.get("content-type") ?? "";
  if (!AUDIO_TYPE.test(mime))
    return Response.json({ error: "expected an audio/* body" }, { status: 415 });
  const declared = Number(req.headers.get("content-length") ?? 0);
  if (declared > MAX_VOICEMAIL_BYTES)
    return Response.json({ error: "voicemail too long" }, { status: 413 });
  const audio = await req.arrayBuffer();
  if (audio.byteLength === 0) return Response.json({ error: "empty recording" }, { status: 400 });
  if (audio.byteLength > MAX_VOICEMAIL_BYTES) {
    return Response.json({ error: "voicemail too long" }, { status: 413 });
  }
  const durationMs = Math.min(
    MAX_VOICEMAIL_MS,
    Math.max(0, Math.round(Number(durationParam ?? 0)) || 0),
  );
  return { mime, audio, durationMs };
}

export function voicemailRoutes(api: Hono<Vars>, env: ServerEnv, live: Coordinator): void {
  const { store } = env;

  /**
   * Leave a voicemail for a phone. Only people on its allow-list who may call it can do so;
   * the companion records one when quiet hours send the call to voicemail.
   */
  api.post("/devices/:id/voicemail", async (c) => {
    const user = c.get("user");
    const device = await store.getDevice(c.req.param("id"));
    if (!device || device.householdId !== user.householdId) {
      return c.json({ error: "not found" }, 404);
    }
    const contact = await store.getContact(device.id, user.id);
    if (!contact?.canCallDevice) return c.json({ error: "not allowed" }, 403);

    const rec = await readRecording(c.req.raw, c.req.query("durationMs"));
    if (rec instanceof Response) return rec;
    const vm = await depositVoicemail(env, live, {
      device,
      fromUser: user.id,
      fromLabel: contact.label,
      ...rec,
    });
    return c.json({ id: vm.id }, 201);
  });

  api.get("/voicemails", guardianOnly, async (c) => {
    const list = await store.listVoicemails(c.get("user").householdId);
    return c.json(list.map(publicView));
  });

  /** Loads a voicemail and checks it belongs to the caller's household. */
  const own = async (householdId: string, id: string) => {
    const vm = await store.getVoicemail(id);
    return vm && vm.householdId === householdId ? vm : undefined;
  };

  api.get("/voicemails/:id/audio", guardianOnly, async (c) => {
    const vm = await own(c.get("user").householdId, c.req.param("id"));
    const blob = vm && (await env.blobs.get(vm.blobKey));
    if (!blob) return c.json({ error: "not found" }, 404);
    return new Response(blob.data, {
      headers: { "content-type": blob.contentType, "cache-control": "private, max-age=3600" },
    });
  });

  api.post("/voicemails/:id/heard", guardianOnly, async (c) => {
    const vm = await own(c.get("user").householdId, c.req.param("id"));
    if (!vm) return c.json({ error: "not found" }, 404);
    await store.markVoicemailHeard(vm.id, env.now());
    await live.refreshDevice(vm.householdId, vm.deviceId);
    return c.body(null, 204);
  });

  api.delete("/voicemails/:id", guardianOnly, async (c) => {
    const vm = await own(c.get("user").householdId, c.req.param("id"));
    if (!vm) return c.json({ error: "not found" }, 404);
    await store.deleteVoicemail(vm.id);
    await env.blobs.delete(vm.blobKey);
    await live.refreshDevice(vm.householdId, vm.deviceId);
    return c.body(null, 204);
  });
}
