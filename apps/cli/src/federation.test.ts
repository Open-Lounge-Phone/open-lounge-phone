import { describe, expect, it } from "vitest";
import { parseCli } from "./args.ts";
import { rotateKey } from "./federation.ts";
import { scriptedIo } from "./io.ts";

const FP1 = `SHA256:${"a".repeat(43)}`;
const FP2 = `SHA256:${"b".repeat(43)}`;
const TOKEN = "session-token-123";

/** A fake server: records requests, answers the operator endpoints. */
function server(opts: { status?: number; rotation?: boolean } = {}) {
  const seen: { method: string; path: string; auth: string | null; body: string }[] = [];
  const fetchFn = async (req: Request) => {
    const path = new URL(req.url).pathname;
    seen.push({
      method: req.method,
      path,
      auth: req.headers.get("authorization"),
      body: await req.text(),
    });
    if (opts.status) return Response.json({ error: "operators only" }, { status: opts.status });
    if (path === "/api/admin/federation") {
      return Response.json({
        own: {
          host: "a.example",
          fingerprint: FP1,
          rotation: opts.rotation
            ? { previousFingerprint: FP2, expiresAt: Date.UTC(2026, 9, 6) }
            : null,
        },
        peers: [],
      });
    }
    if (path === "/api/admin/federation/rotate-key") {
      return Response.json({ from: FP1, to: FP2, overlapUntil: Date.UTC(2026, 9, 6) });
    }
    return new Response("no", { status: 404 });
  };
  return { seen, fetchFn };
}

describe("federation rotate-key", () => {
  it("parses, and never takes the session token as a flag", () => {
    expect(parseCli(["federation", "rotate-key", "--url", "a.example", "--yes"])).toEqual({
      kind: "federation-rotate-key",
      opts: { url: "https://a.example", force: false, yes: true },
    });
    expect(parseCli(["federation", "rotate-key"]).kind).toBe("error");
    expect(
      parseCli(["federation", "rotate-key", "--url", "a.example", "--token", "x"]),
    ).toMatchObject({ kind: "error", message: expect.stringMatching(/OLP_SESSION_TOKEN/) });
  });

  it("rotates with an operator's session and prints fingerprints only", async () => {
    const { io, lines } = scriptedIo([], false);
    const s = server();
    const code = await rotateKey(
      { url: "https://a.example", force: false, yes: true },
      io,
      { OLP_SESSION_TOKEN: TOKEN },
      s.fetchFn,
    );
    expect(code).toBe(0);
    expect(s.seen.map((r) => `${r.method} ${r.path}`)).toEqual([
      "GET /api/admin/federation",
      "POST /api/admin/federation/rotate-key",
    ]);
    expect(s.seen.every((r) => r.auth === `Bearer ${TOKEN}`)).toBe(true);
    const out = lines.join("\n");
    expect(out).toContain(`old key      ${FP1}`);
    expect(out).toContain(`new key      ${FP2}`);
    expect(out).not.toContain(TOKEN);
  });

  it("asks first, and does nothing when the answer is no", async () => {
    const { io } = scriptedIo(["n"]);
    const s = server();
    const code = await rotateKey(
      { url: "https://a.example", force: false, yes: false },
      io,
      { OLP_SESSION_TOKEN: TOKEN },
      s.fetchFn,
    );
    expect(code).toBe(1);
    expect(s.seen.map((r) => r.method)).toEqual(["GET"]);
  });

  it("stops during an overlap unless forced, without a session, and for non-operators", async () => {
    const env = { OLP_SESSION_TOKEN: TOKEN };
    const busy = server({ rotation: true });
    const opts = { url: "https://a.example", force: false, yes: true };
    expect(await rotateKey(opts, scriptedIo([], false).io, env, busy.fetchFn)).toBe(1);
    expect(busy.seen.map((r) => r.method)).toEqual(["GET"]);
    expect(
      await rotateKey({ ...opts, force: true }, scriptedIo([], false).io, env, busy.fetchFn),
    ).toBe(0);
    expect(busy.seen.at(-1)?.body).toBe('{"force":true}');
    const none = server();
    expect(await rotateKey(opts, scriptedIo([], false).io, {}, none.fetchFn)).toBe(2);
    expect(none.seen).toEqual([]);
    const denied = server({ status: 403 });
    const { io, lines } = scriptedIo([], false);
    expect(await rotateKey(opts, io, env, denied.fetchFn)).toBe(1);
    expect(lines.join("\n")).toMatch(/isn't an operator's/);
  });
});
