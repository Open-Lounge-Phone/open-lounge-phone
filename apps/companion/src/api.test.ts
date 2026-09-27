import { describe, expect, it, vi } from "vitest";
import { ApiError, createApi } from "./api.ts";

function fakeFetch(status: number, body?: unknown) {
  return vi.fn(
    async (_url: string, _init?: RequestInit) =>
      new Response(body === undefined ? null : JSON.stringify(body), { status }),
  );
}

describe("createApi", () => {
  it("sends the bearer token and JSON body", async () => {
    const fetch = fakeFetch(201, { id: "dev_1", name: "Kid" });
    const api = createApi({ token: "t".repeat(20), fetch });
    expect(await api.pair("123456", "Kid")).toEqual({ id: "dev_1", name: "Kid" });
    const [url, init] = fetch.mock.calls[0] ?? [];
    expect(url).toBe("/api/devices/pair");
    expect(init?.method).toBe("POST");
    expect(init?.headers).toMatchObject({
      authorization: `Bearer ${"t".repeat(20)}`,
      "content-type": "application/json",
    });
    expect(JSON.parse(String(init?.body))).toEqual({ code: "123456", name: "Kid" });
  });

  it("omits auth when signed out and handles 204", async () => {
    const fetch = fakeFetch(204);
    const api = createApi({ token: null, fetch });
    await expect(api.setQuietHours([])).resolves.toBeUndefined();
    expect(fetch.mock.calls[0]?.[1]?.headers).not.toHaveProperty("authorization");
  });

  it("strips the id from contact bodies and encodes path segments", async () => {
    const fetch = fakeFetch(204);
    const api = createApi({ token: null, fetch });
    await api.putContact("dev/1", {
      id: "usr_a",
      label: "Gran",
      canCallDevice: true,
      deviceCanCall: false,
      bypassQuietHours: false,
    });
    expect(fetch.mock.calls[0]?.[0]).toBe("/api/devices/dev%2F1/contacts/usr_a");
    expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toEqual({
      label: "Gran",
      canCallDevice: true,
      deviceCanCall: false,
      bypassQuietHours: false,
    });
  });

  it("throws ApiError with the server's message", async () => {
    const api = createApi({
      token: null,
      fetch: fakeFetch(404, { error: "unknown or expired code" }),
    });
    const err = await api.pair("000000", "x").catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 404, message: "unknown or expired code" });
  });

  it("reports 401s so the session can be dropped", async () => {
    const onUnauthorized = vi.fn();
    const api = createApi({
      token: "x".repeat(20),
      fetch: fakeFetch(401, { error: "unauthorized" }),
      onUnauthorized,
    });
    await expect(api.me()).rejects.toThrow("unauthorized");
    expect(onUnauthorized).toHaveBeenCalledOnce();
  });
});
