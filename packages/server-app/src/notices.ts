// Notices (docs/notices.md): a space's owner, admins or (in a home) guardians post a short notice
// to the space's phones, optionally with a recording. Phones show it with a chime, play the
// recording when the handset is lifted, and dismiss it with a key. Local to the space: never
// federated. The hub delivers it (`HouseholdHub.refreshNotices`).
import {
  NOTICE_AUDIO_MAX_MS,
  NOTICE_DEFAULT_MINUTES,
  NOTICE_MAX_MINUTES,
  noticeLines,
  noticeLive,
} from "@openloungephone/core";
import type { Notice } from "@openloungephone/db";
import { Id } from "@openloungephone/protocol";
import type { Hono } from "hono";
import { z } from "zod";
import type { ServerEnv } from "./env.ts";
import type { Coordinator } from "./gateway.ts";
import { body, guardianOnly, type Vars } from "./httpUtil.ts";
import { readRecording } from "./voicemail.ts";
import { auditFrom } from "./workplace.ts";

/** Largest recording on a notice (30 s of 8 kHz 16-bit WAV, with room to spare). */
const NOTICE_AUDIO_MAX_BYTES = 1024 * 1024;

const PostBody = z
  .object({
    /** One or two lines (a line break between them), at most 16 characters each. */
    text: z.string().max(200),
    /** How long it lasts (default 60). */
    minutes: z.number().int().min(1).max(NOTICE_MAX_MINUTES).optional(),
    /** Only these phones of the space (default: every phone). */
    deviceIds: z.array(Id).min(1).max(100).optional(),
  })
  .strict();

/** What the companion shows of a notice. */
export function noticeView(n: Notice, now: number) {
  return {
    id: n.id,
    lines: n.lines,
    from: n.authorName,
    at: n.createdAt,
    expiresAt: n.expiresAt,
    endedAt: n.endedAt,
    live: noticeLive(n, now),
    deviceIds: n.deviceIds,
    audio: n.audio ? { durationMs: n.audio.durationMs } : null,
  };
}

/** `GET /api/notices/:id/audio?token=` for phones (no session: the token is the key). */
export function publicNoticeRoutes(api: Hono<Vars>, env: ServerEnv): void {
  api.get("/notices/:id/audio", async (c) => {
    const n = await env.store.notices.get(c.req.param("id"));
    const token = c.req.query("token") ?? "";
    if (!n?.audio || !token || n.audio.token !== token || !noticeLive(n, env.now())) {
      return c.json({ error: "not found" }, 404);
    }
    const blob = await env.blobs.get(n.audio.blobKey);
    if (!blob) return c.json({ error: "not found" }, 404);
    return c.body(blob.data, 200, {
      "content-type": blob.contentType,
      "cache-control": "no-store",
    });
  });
}

export function noticeRoutes(api: Hono<Vars>, env: ServerEnv, live: Coordinator): void {
  const { store } = env;

  /** The space's notices, newest first (admins and guardians). */
  api.get("/notices", guardianOnly, async (c) => {
    const now = env.now();
    const rows = await store.notices.ofSpace(c.get("user").householdId);
    return c.json(rows.map((n) => noticeView(n, now)));
  });

  /** Posts a notice to the space's phones (all of them, or the ones picked). */
  api.post("/notices", guardianOnly, async (c) => {
    const user = c.get("user");
    const b = await body(c.req.raw, PostBody);
    if (b instanceof Response) return b;
    const text = noticeLines(b.text);
    if ("error" in text) return c.json({ error: text.error }, 400);
    if (b.deviceIds) {
      const phones = new Set((await store.listDevices(user.householdId)).map((d) => d.id));
      if (!b.deviceIds.every((id) => phones.has(id))) {
        return c.json({ error: "pick phones of this space" }, 400);
      }
    }
    const now = env.now();
    const n = await store.notices.create(
      {
        householdId: user.householdId,
        createdBy: user.id,
        authorName: user.name,
        lines: text.lines,
        deviceIds: b.deviceIds ? [...new Set(b.deviceIds)] : null,
        expiresAt: now + (b.minutes ?? NOTICE_DEFAULT_MINUTES) * 60_000,
      },
      now,
    );
    await auditFrom(env, c, "notice.post", {
      noticeId: n.id,
      lines: n.lines,
      minutes: b.minutes ?? NOTICE_DEFAULT_MINUTES,
      ...(n.deviceIds ? { deviceIds: n.deviceIds } : {}),
    });
    await live.noticesChanged(user.householdId);
    return c.json(noticeView(n, now), 201);
  });

  /** Adds a recording (raw `audio/*`, 30 s): phones play it when the handset is lifted. */
  api.put("/notices/:id/audio", guardianOnly, async (c) => {
    const user = c.get("user");
    const n = await store.notices.get(c.req.param("id"));
    if (!n || n.householdId !== user.householdId) return c.json({ error: "not found" }, 404);
    if (!noticeLive(n, env.now())) return c.json({ error: "this notice is over" }, 409);
    const rec = await readRecording(c.req.raw, c.req.query("durationMs"), {
      bytes: NOTICE_AUDIO_MAX_BYTES,
      ms: NOTICE_AUDIO_MAX_MS,
    });
    if (rec instanceof Response) return rec;
    const blobKey = `notice/${n.id}-${env.now()}`;
    await env.blobs.put(blobKey, rec.audio, rec.mime);
    const { old } = await store.notices.setAudio(n.id, {
      blobKey,
      mime: rec.mime.split(";")[0] ?? rec.mime,
      durationMs: rec.durationMs,
    });
    if (old) await env.blobs.delete(old);
    await auditFrom(env, c, "notice.audio", { noticeId: n.id, durationMs: rec.durationMs });
    await live.noticesChanged(user.householdId);
    return c.body(null, 204);
  });

  /** Takes a notice down now (it leaves every phone). */
  api.delete("/notices/:id", guardianOnly, async (c) => {
    const user = c.get("user");
    const n = await store.notices.get(c.req.param("id"));
    if (!n || n.householdId !== user.householdId) return c.json({ error: "not found" }, 404);
    if (await store.notices.end(n.id, env.now())) {
      await auditFrom(env, c, "notice.delete", { noticeId: n.id, lines: n.lines });
      await live.noticesChanged(user.householdId);
    }
    return c.body(null, 204);
  });
}
