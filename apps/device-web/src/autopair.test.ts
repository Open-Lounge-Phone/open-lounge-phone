import { describe, expect, it, vi } from "vitest";
import { claimPairing, parseAutopair, shouldAutopair } from "./autopair.ts";

const TOKEN = "t".repeat(40);

describe("parseAutopair", () => {
  it("is off unless requested", () => {
    expect(parseAutopair(new URLSearchParams(""))).toBeUndefined();
    expect(parseAutopair(new URLSearchParams("autopair=0"))).toBeUndefined();
  });
  it("reads name and ownership, with a sane default name", () => {
    expect(parseAutopair(new URLSearchParams("autopair=1&forMe=1&name=Jesse's phone"))).toEqual({
      forMe: true,
      name: "Jesse's phone",
    });
    expect(parseAutopair(new URLSearchParams("autopair=1"))).toEqual({
      forMe: false,
      name: "My phone",
    });
    expect(
      parseAutopair(new URLSearchParams(`autopair=1&name=${"x".repeat(40)}`))?.name,
    ).toHaveLength(24);
  });
});

describe("shouldAutopair", () => {
  const opts = { forMe: true, name: "P" };
  it("needs a request, a session and a fresh code", () => {
    expect(shouldAutopair(opts, TOKEN, "123456", new Set())).toBe(true);
    expect(shouldAutopair(undefined, TOKEN, "123456", new Set())).toBe(false);
    expect(shouldAutopair(opts, null, "123456", new Set())).toBe(false);
    expect(shouldAutopair(opts, "short", "123456", new Set())).toBe(false);
    expect(shouldAutopair(opts, TOKEN, "12345", new Set())).toBe(false);
    expect(shouldAutopair(opts, TOKEN, "123456", new Set(["123456"]))).toBe(false);
  });
});

describe("claimPairing", () => {
  it("posts to the same-origin pairing API with the session", async () => {
    const f = vi.fn(async () => new Response(JSON.stringify({ id: "dev_1" }), { status: 201 }));
    expect(await claimPairing("123456", { forMe: true, name: "P" }, TOKEN, f)).toEqual({
      ok: true,
    });
    expect(f).toHaveBeenCalledWith("/api/devices/pair", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ code: "123456", name: "P", forMe: true }),
    });
  });
  it("reports server and network errors", async () => {
    const bad = vi.fn(async () => new Response(JSON.stringify({ error: "nope" }), { status: 404 }));
    expect(await claimPairing("123456", { forMe: true, name: "P" }, TOKEN, bad)).toEqual({
      ok: false,
      error: "nope",
    });
    const down = vi.fn(async () => {
      throw new Error("offline");
    });
    expect(await claimPairing("123456", { forMe: true, name: "P" }, TOKEN, down)).toEqual({
      ok: false,
      error: "offline",
    });
  });
});
