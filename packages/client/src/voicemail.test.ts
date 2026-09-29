import { describe, expect, it } from "vitest";
import { fetchGreeting, playGreeting, uploadRecording, uploadVoicemail } from "./voicemail.ts";

describe("voicemail helpers", () => {
  it("fetches a recorded greeting, and falls back to the spoken default", async () => {
    const seen: string[] = [];
    const recorded = await fetchGreeting({ ticket: "a b" }, "https://x.test", async (url) => {
      seen.push(url);
      return new Response(new Uint8Array([1, 2]), {
        headers: { "olp-greeting": "name", "content-type": "audio/webm" },
      });
    });
    expect(seen).toEqual(["https://x.test/api/vm/greeting?ticket=a%20b"]);
    expect(recorded.kind).toBe("name");
    expect(recorded.audio?.size).toBe(2);
    expect(
      await fetchGreeting({ ticket: "t" }, "", async () => new Response(null, { status: 204 })),
    ).toEqual({ kind: "default" });
    expect(
      await fetchGreeting({ ticket: "t" }, "", async () => {
        throw new TypeError("offline");
      }),
    ).toEqual({ kind: "default" });
  });

  it("uploads the message with its length, and reports refusals", async () => {
    let got: { url: string; type: string | null } | undefined;
    const ok = await uploadVoicemail(
      { ticket: "tk" },
      { blob: new Blob([new Uint8Array(3)], { type: "audio/ogg" }), durationMs: 1234.4 },
      "",
      async (url, init) => {
        got = { url, type: new Headers(init?.headers).get("content-type") };
        return new Response(null, { status: 201 });
      },
    );
    expect(ok).toEqual({ ok: true });
    expect(got).toEqual({ url: "/api/vm/message?ticket=tk&durationMs=1234", type: "audio/ogg" });
    const refused = await uploadVoicemail(
      { ticket: "tk" },
      { blob: new Blob([new Uint8Array(3)]), durationMs: 1 },
      "",
      async () => Response.json({ error: "unknown or used ticket" }, { status: 404 }),
    );
    expect(refused).toEqual({ ok: false, status: 404, message: "unknown or used ticket" });
  });

  it("plays the greeting's steps in order and stops when cancelled", async () => {
    const log: string[] = [];
    const voice = {
      say: async (t: string) => void log.push(`say ${t}`),
      play: async () => void log.push("play"),
      tone: async () => void log.push("tone"),
      stop: () => {},
    };
    await playGreeting(
      [{ kind: "audio" }, { kind: "say", text: "can't take your call." }, { kind: "tone" }],
      { kind: "name", audio: new Blob([]) },
      voice,
      () => false,
    );
    expect(log).toEqual(["play", "say can't take your call.", "tone"]);
    log.length = 0;
    await playGreeting([{ kind: "tone" }], { kind: "default" }, voice, () => true);
    expect(log).toEqual([]);
  });
});

describe("uploading a call recording", () => {
  it("posts the audio with its ticket and duration", async () => {
    let got: string | undefined;
    const r = await uploadRecording(
      "t k",
      { blob: new Blob([new Uint8Array(2)], { type: "audio/webm" }), durationMs: 65_000 },
      "https://x.test",
      async (url) => {
        got = url;
        return Response.json({ id: "rec_1" }, { status: 201 });
      },
    );
    expect(r.ok).toBe(true);
    expect(got).toBe("https://x.test/api/rec/upload?ticket=t%20k&durationMs=65000");
  });
});
