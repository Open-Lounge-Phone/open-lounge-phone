import {
  GREETING_MAX_MS,
  MAX_RING_SECONDS,
  MIN_RING_SECONDS,
  VOICEMAIL_MAX_MS,
} from "@openloungephone/core";
import {
  type Account,
  type GreetingKind,
  newId,
  type User,
  type Voicemail,
  type VoicemailOwner,
} from "@openloungephone/db";
import type { Hono } from "hono";
import { z } from "zod";
import type { ServerEnv } from "./env.ts";
import { fairUseProblem } from "./fairUse.ts";
import type { Coordinator } from "./gateway.ts";
import { body, type Vars } from "./httpUtil.ts";
import { sweepAccount } from "./timeline.ts";

/** Two minutes of Opus is ~500 KB; leave generous headroom for other codecs. */
export const MAX_VOICEMAIL_BYTES = 2 * 1024 * 1024;
export const MAX_VOICEMAIL_MS = VOICEMAIL_MAX_MS;
/** A 30 s greeting, with the same headroom. */
export const MAX_GREETING_BYTES = 1024 * 1024;

const AUDIO_TYPE = /^audio\/(webm|ogg|mp4|mpeg|wav|x-wav|aac)(;.*)?$/;

const publicView = ({ blobKey: _b, householdId: _h, ...v }: Voicemail) => v;

/** Transcribes in the background. */
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

export interface Recording {
  mime: string;
  audio: ArrayBuffer;
  durationMs: number;
}

/** A voicemail to store: for a household phone, or for a person (their own inbox). */
export interface Deposit extends Recording {
  to: { deviceId: string } | { userId: string } | { groupId: string };
  fromUser: string | null;
  fromLabel: string;
  /** The caller as the callee's call log names them (`user:<id>`, `device:<id>`, `handle@host`). */
  fromAddress?: string | null;
  /** When the missed call started: links the voicemail to its call-log row (the timeline). */
  since?: number;
}

/**
 * Stores a voicemail, starts its transcript, and tells whoever it's for: a phone's guardians
 * (and the phone's "missed" list), or the person (and their own phones). Undefined if the phone or
 * person no longer exists.
 */
export async function depositVoicemail(
  env: ServerEnv,
  live: Coordinator,
  input: Deposit,
): Promise<Voicemail | undefined> {
  const { store } = env;
  const device = "deviceId" in input.to ? await store.getDevice(input.to.deviceId) : undefined;
  const user = "userId" in input.to ? await store.getUser(input.to.userId) : undefined;
  const group = "groupId" in input.to ? await store.workplace.group(input.to.groupId) : undefined;
  const householdId = device?.householdId ?? user?.householdId ?? group?.householdId;
  if (!householdId) return undefined;
  const blobKey = `voicemail/${householdId}/${newId("vmb")}`;
  await env.blobs.put(blobKey, input.audio, input.mime);
  // A space can switch transcription off; then the audio is never sent to speech-to-text.
  const transcribes = !!env.transcriber && (await store.spacePrivacy(householdId)).transcribe;
  const fromLabel = input.fromLabel.slice(0, 24) || "Someone";
  const vm = await store.createVoicemail({
    householdId,
    deviceId: device?.id ?? null,
    toUser: user?.id ?? null,
    groupId: group?.id ?? null,
    fromUser: input.fromUser,
    fromLabel,
    fromAddress: input.fromAddress ?? null,
    createdAt: env.now(),
    durationMs: Math.min(MAX_VOICEMAIL_MS, input.durationMs),
    mime: input.mime.split(";")[0] ?? input.mime,
    blobKey,
    transcriptStatus: transcribes ? "pending" : "unavailable",
  });
  if (transcribes) env.defer(transcribe(env, vm, input.audio));
  if (input.fromAddress && input.since !== undefined) {
    await store.linkVoicemail(
      {
        accountId: user?.accountId ?? null,
        deviceId: device?.id ?? null,
        peer: input.fromAddress,
        voicemailId: vm.id,
      },
      input.since,
    );
  }
  if (device) {
    await live.refreshDevice(householdId, device.id);
    await live.announce(householdId, {
      t: "voicemail.new",
      id: vm.id,
      deviceId: device.id,
      from: fromLabel,
    });
  } else if (user) {
    await refreshOwnPhones(env, live, user);
    await live.notifyAccount(user.accountId, { t: "voicemail.inbox", id: vm.id, from: fromLabel });
  } else if (group) {
    // A shared box: every member of the group hears about it.
    for (const member of group.members) {
      const m = await store.getUser(member);
      if (!m) continue;
      await live.notifyAccount(m.accountId, {
        t: "voicemail.inbox",
        id: vm.id,
        from: fromLabel,
        box: group.name.slice(0, 40),
      });
    }
  }
  return vm;
}

/** A person's own phones show their unheard voicemail too. */
async function refreshOwnPhones(env: ServerEnv, live: Coordinator, user: User): Promise<void> {
  for (const d of await env.store.listDevices(user.householdId)) {
    if (d.ownerUserId === user.id) await live.refreshDevice(user.householdId, d.id);
  }
}

/** Checks an uploaded recording: an audio type, not empty, not too big. */
export async function readRecording(
  req: Request,
  durationParam: string | undefined,
  limits: { bytes: number; ms: number } = { bytes: MAX_VOICEMAIL_BYTES, ms: MAX_VOICEMAIL_MS },
): Promise<Recording | Response> {
  const mime = req.headers.get("content-type") ?? "";
  if (!AUDIO_TYPE.test(mime))
    return Response.json({ error: "expected an audio/* body" }, { status: 415 });
  const declared = Number(req.headers.get("content-length") ?? 0);
  if (declared > limits.bytes)
    return Response.json({ error: "recording too long" }, { status: 413 });
  const audio = await req.arrayBuffer();
  if (audio.byteLength === 0) return Response.json({ error: "empty recording" }, { status: 400 });
  if (audio.byteLength > limits.bytes) {
    return Response.json({ error: "recording too long" }, { status: 413 });
  }
  const durationMs = Math.min(limits.ms, Math.max(0, Math.round(Number(durationParam ?? 0)) || 0));
  return { mime, audio, durationMs };
}

// --- greetings ---------------------------------------------------------------------------

/** The greeting callers hear: a recording, or the spoken default (no audio). */
export interface Greeting {
  kind: "default" | GreetingKind;
  durationMs?: number;
  audio?: { data: ArrayBuffer; contentType: string };
}

export async function greetingOf(
  env: ServerEnv,
  owner: VoicemailOwner,
  withAudio = true,
): Promise<Greeting> {
  const g = (await env.store.voicemailPrefs(owner)).greeting;
  if (!g) return { kind: "default" };
  if (!withAudio) return { kind: g.kind, durationMs: g.durationMs };
  const blob = await env.blobs.get(g.blobKey);
  if (!blob) return { kind: "default" };
  return { kind: g.kind, durationMs: g.durationMs, audio: blob };
}

/** A greeting as an HTTP answer: the audio with `olp-greeting: name|custom`, or 204. */
export function greetingResponse(g: Greeting): Response {
  if (g.kind === "default" || !g.audio) {
    return new Response(null, { status: 204, headers: { "olp-greeting": "default" } });
  }
  return new Response(g.audio.data, {
    headers: {
      "content-type": g.audio.contentType,
      "olp-greeting": g.kind,
      "cache-control": "private, no-store",
    },
  });
}

/** Reads an uploaded greeting of `kind`: an audio body within that kind's length. */
export async function readGreeting(
  req: Request,
  kind: string | undefined,
  durationParam: string | undefined,
): Promise<(Recording & { kind: GreetingKind }) | Response> {
  if (kind !== "name" && kind !== "custom") {
    return Response.json({ error: "kind must be name or custom" }, { status: 400 });
  }
  const ms = GREETING_MAX_MS[kind];
  const r = await readRecording(req, durationParam ?? String(ms), {
    bytes: MAX_GREETING_BYTES,
    ms,
  });
  return r instanceof Response ? r : { ...r, kind };
}

/** Stores a greeting (replacing the old one's audio). */
export async function saveGreeting(
  env: ServerEnv,
  owner: VoicemailOwner,
  rec: Recording & { kind: GreetingKind },
): Promise<void> {
  const blobKey = `greeting/${newId("grb")}`;
  await env.blobs.put(blobKey, rec.audio, rec.mime);
  const old = await env.store.setGreeting(
    owner,
    {
      kind: rec.kind,
      mime: rec.mime.split(";")[0] ?? rec.mime,
      blobKey,
      durationMs: rec.durationMs,
    },
    env.now(),
  );
  if (old) await env.blobs.delete(old);
}

/** Back to the spoken default greeting. */
export async function resetGreeting(env: ServerEnv, owner: VoicemailOwner): Promise<void> {
  const old = await env.store.setGreeting(owner, null, env.now());
  if (old) await env.blobs.delete(old);
}

/** Deletes the audio of voicemail and greetings before their rows cascade away. */
export async function dropVoicemailBlobs(
  env: ServerEnv,
  scope: Parameters<ServerEnv["store"]["voicemailBlobs"]>[0],
): Promise<void> {
  for (const key of await env.store.voicemailBlobs(scope)) await env.blobs.delete(key);
}

const SettingsBody = z
  .object({
    ringSeconds: z.number().int().min(MIN_RING_SECONDS).max(MAX_RING_SECONDS).optional(),
    /** Kids' phones: whether the child may record the phone's greeting. */
    childGreeting: z.boolean().optional(),
  })
  .refine((b) => b.ringSeconds !== undefined || b.childGreeting !== undefined, {
    message: "nothing to change",
  });

// --- routes ------------------------------------------------------------------------------

export function voicemailRoutes(api: Hono<Vars>, env: ServerEnv, live: Coordinator): void {
  const { store } = env;

  /**
   * Leave a voicemail for a phone. Only people on its allow-list who may call it can do so.
   * (Kept for older apps; calls now hand out a ticket, see `POST /api/vm/message`.)
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
    const account = c.get("account").id;
    const over = await fairUseProblem(env, account, "voicemail", { bytes: rec.audio.byteLength });
    if (over) return c.json({ error: over }, 429);
    const vm = await depositVoicemail(env, live, {
      to: { deviceId: device.id },
      fromUser: user.id,
      fromLabel: contact.label,
      fromAddress: `user:${user.id}`,
      ...rec,
    });
    if (!vm) return c.json({ error: "not found" }, 404);
    await store.addUsage(account, env.now(), {
      voicemails: 1,
      voicemailBytes: rec.audio.byteLength,
    });
    return c.json({ id: vm.id }, 201);
  });

  /**
   * Your inbox: voicemail left for you (in any of your spaces), plus — for guardians — what was
   * left for this space's phones.
   */
  api.get("/voicemails", async (c) => {
    const user = c.get("user");
    // Expired voicemail is deleted before it could be shown.
    await sweepAccount(env, c.get("account").id);
    const personal = await store.listPersonalVoicemails(c.get("account").id);
    const phones =
      user.role === "guardian"
        ? (await store.listVoicemails(user.householdId)).filter((v) => v.deviceId !== null)
        : [];
    // Shared boxes of the ring groups you're in (admins: every group of the space).
    const groups = await boxesFor(user);
    const shared = await store.listGroupVoicemails([...groups.keys()]);
    const heardBy = new Map<string, string>();
    for (const v of shared) {
      if (v.heardBy && !heardBy.has(v.heardBy)) {
        heardBy.set(v.heardBy, (await store.getUser(v.heardBy))?.name ?? "");
      }
    }
    const all = [...personal, ...phones, ...shared].sort((a, b) => b.createdAt - a.createdAt);
    return c.json(
      all.map((v) => ({
        ...publicView(v),
        ...(v.groupId ? { box: groups.get(v.groupId) ?? "" } : {}),
        ...(v.heardBy ? { heardByName: heardBy.get(v.heardBy) ?? "" } : {}),
      })),
    );
  });

  /**
   * The shared boxes a member may open (group id → name): the groups they're in; an admin of a
   * team/org space, all of the space's groups.
   */
  const boxesFor = async (user: User): Promise<Map<string, string>> => {
    const groups = await store.workplace.groups(user.householdId);
    return new Map(
      groups
        .filter((g) => user.role === "guardian" || g.members.includes(user.id))
        .map((g) => [g.id, g.name]),
    );
  };

  /**
   * A voicemail the caller may open: their own, (guardians) one for this space's phones, or one
   * in a shared box they may open.
   */
  const reachable = async (user: User, account: Account, id: string) => {
    const vm = await store.getVoicemail(id);
    if (!vm) return undefined;
    if (vm.groupId !== null) {
      return vm.householdId === user.householdId && (await boxesFor(user)).has(vm.groupId)
        ? vm
        : undefined;
    }
    if (vm.deviceId !== null) {
      return user.role === "guardian" && vm.householdId === user.householdId ? vm : undefined;
    }
    const to = vm.toUser ? await store.getUser(vm.toUser) : undefined;
    return to?.accountId === account.id ? vm : undefined;
  };

  /** After a voicemail is heard or deleted: phones update their "missed" list. */
  const refreshFor = async (vm: Voicemail) => {
    if (vm.deviceId) return live.refreshDevice(vm.householdId, vm.deviceId);
    const to = vm.toUser ? await store.getUser(vm.toUser) : undefined;
    if (to) await refreshOwnPhones(env, live, to);
  };

  api.get("/voicemails/:id/audio", async (c) => {
    const vm = await reachable(c.get("user"), c.get("account"), c.req.param("id"));
    const blob = vm && (await env.blobs.get(vm.blobKey));
    if (!blob) return c.json({ error: "not found" }, 404);
    return new Response(blob.data, {
      headers: { "content-type": blob.contentType, "cache-control": "private, max-age=3600" },
    });
  });

  api.post("/voicemails/:id/heard", async (c) => {
    const vm = await reachable(c.get("user"), c.get("account"), c.req.param("id"));
    if (!vm) return c.json({ error: "not found" }, 404);
    await store.markVoicemailHeard(vm.id, env.now(), c.get("user").id);
    await refreshFor(vm);
    return c.body(null, 204);
  });

  api.delete("/voicemails/:id", async (c) => {
    const vm = await reachable(c.get("user"), c.get("account"), c.req.param("id"));
    if (!vm) return c.json({ error: "not found" }, 404);
    await store.deleteVoicemail(vm.id);
    await env.blobs.delete(vm.blobKey);
    await refreshFor(vm);
    return c.body(null, 204);
  });

  // --- your own voicemail settings and greeting ----------------------------------------

  const mine = (c: { get(k: "account"): Account }): VoicemailOwner => ({
    accountId: c.get("account").id,
  });

  /** Your phones' config carries your greeting (MENU → Voicemail shows it). */
  const refreshMyPhones = async (account: Account) => {
    for (const m of await store.listMemberships(account.id)) {
      await refreshOwnPhones(env, live, m.user);
    }
  };

  api.get("/voicemail/settings", async (c) => {
    const prefs = await store.voicemailPrefs(mine(c));
    const g = await greetingOf(env, mine(c), false);
    return c.json({
      ringSeconds: prefs.ringSeconds,
      greeting: {
        kind: g.kind,
        ...(g.durationMs !== undefined ? { durationMs: g.durationMs } : {}),
      },
      name: c.get("account").name,
    });
  });

  api.patch("/voicemail/settings", async (c) => {
    const b = await body(c.req.raw, SettingsBody);
    if (b instanceof Response) return b;
    if (b.ringSeconds !== undefined) {
      await store.setVoicemailPrefs(mine(c), { ringSeconds: b.ringSeconds }, env.now());
    }
    return c.body(null, 204);
  });

  api.get("/voicemail/greeting/audio", async (c) =>
    greetingResponse(await greetingOf(env, mine(c))),
  );

  api.put("/voicemail/greeting", async (c) => {
    const rec = await readGreeting(c.req.raw, c.req.query("kind"), c.req.query("durationMs"));
    if (rec instanceof Response) return rec;
    await saveGreeting(env, mine(c), rec);
    await refreshMyPhones(c.get("account"));
    return c.body(null, 204);
  });

  api.delete("/voicemail/greeting", async (c) => {
    await resetGreeting(env, mine(c));
    await refreshMyPhones(c.get("account"));
    return c.body(null, 204);
  });

  // --- a household phone's voicemail settings and greeting (its guardians) ---------------

  const kidsPhone = async (user: User, id: string) => {
    const device = await store.getDevice(id);
    if (!device || device.householdId !== user.householdId) return undefined;
    // A person's own phone uses its owner's settings; Lounge phones never take voicemail.
    if (device.ownerUserId || device.kind === "lounge") return undefined;
    return user.role === "guardian" ? device : undefined;
  };

  api.get("/devices/:id/voicemail", async (c) => {
    const device = await kidsPhone(c.get("user"), c.req.param("id"));
    if (!device) return c.json({ error: "not found" }, 404);
    const owner = { deviceId: device.id };
    const prefs = await store.voicemailPrefs(owner);
    const g = await greetingOf(env, owner, false);
    return c.json({
      ringSeconds: prefs.ringSeconds,
      childGreeting: prefs.childGreeting,
      greeting: {
        kind: g.kind,
        ...(g.durationMs !== undefined ? { durationMs: g.durationMs } : {}),
      },
      name: device.name,
    });
  });

  api.patch("/devices/:id/voicemail", async (c) => {
    const device = await kidsPhone(c.get("user"), c.req.param("id"));
    if (!device) return c.json({ error: "not found" }, 404);
    const b = await body(c.req.raw, SettingsBody);
    if (b instanceof Response) return b;
    await store.setVoicemailPrefs({ deviceId: device.id }, b, env.now());
    await live.refreshDevice(device.householdId, device.id);
    return c.body(null, 204);
  });

  api.get("/devices/:id/greeting/audio", async (c) => {
    const device = await kidsPhone(c.get("user"), c.req.param("id"));
    if (!device) return c.json({ error: "not found" }, 404);
    return greetingResponse(await greetingOf(env, { deviceId: device.id }));
  });

  api.put("/devices/:id/greeting", async (c) => {
    const device = await kidsPhone(c.get("user"), c.req.param("id"));
    if (!device) return c.json({ error: "not found" }, 404);
    const rec = await readGreeting(c.req.raw, c.req.query("kind"), c.req.query("durationMs"));
    if (rec instanceof Response) return rec;
    await saveGreeting(env, { deviceId: device.id }, rec);
    await live.refreshDevice(device.householdId, device.id);
    return c.body(null, 204);
  });

  api.delete("/devices/:id/greeting", async (c) => {
    const device = await kidsPhone(c.get("user"), c.req.param("id"));
    if (!device) return c.json({ error: "not found" }, 404);
    await resetGreeting(env, { deviceId: device.id });
    await live.refreshDevice(device.householdId, device.id);
    return c.body(null, 204);
  });
}
