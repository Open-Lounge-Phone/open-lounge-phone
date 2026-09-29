import { describe, expect, it } from "vitest";
import { checkStatus, formatStatus } from "./status.ts";

const key = "A".repeat(43);
const server =
  (routes: Record<string, () => Response>) =>
  async (req: Request): Promise<Response> => {
    const r = routes[new URL(req.url).pathname];
    if (!r) return new Response("no", { status: 404 });
    return r();
  };

describe("status", () => {
  it("reports health, versions and the federation key", async () => {
    const r = await checkStatus(
      "https://a.example",
      server({
        "/api/health": () =>
          Response.json({ ok: true, software: "openloungephone/0.1", protocol: 1, federation: 1 }),
        "/.well-known/openloungephone": () =>
          Response.json({ version: 1, server_key: key, federation: "/fed/v1" }),
      }),
    );
    expect(r).toMatchObject({
      healthy: true,
      software: "openloungephone/0.1",
      protocol: 1,
      federation: { version: 1, path: "/fed/v1", key },
      problems: [],
    });
    expect(formatStatus(r).join("\n")).toMatch(/federation\s+v1 at \/fed\/v1/);
  });

  it("a server that doesn't federate, and one that is down", async () => {
    const off = await checkStatus(
      "https://b.example",
      server({ "/api/health": () => Response.json({ ok: true }) }),
    );
    expect(off).toMatchObject({ healthy: true, federation: null });
    const down = await checkStatus("https://c.example", async () => {
      throw new TypeError("fetch failed");
    });
    expect(down.healthy).toBe(false);
    expect(down.problems[0]).toMatch(/can't reach/);
    const broken = await checkStatus(
      "https://d.example",
      server({ "/api/health": () => new Response("oops", { status: 500 }) }),
    );
    expect(broken).toMatchObject({ healthy: false, problems: ["/api/health answered 500"] });
  });
});
