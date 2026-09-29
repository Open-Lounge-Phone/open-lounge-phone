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

  it("pins requests to a household when given one", async () => {
    const fetch = fakeFetch(200, []);
    await createApi({ token: "t".repeat(20), fetch, household: "hh_home" }).devices();
    expect(fetch.mock.calls[0]?.[1]?.headers).toMatchObject({ "x-household": "hh_home" });
    await createApi({ token: "t".repeat(20), fetch }).devices();
    expect(fetch.mock.calls[1]?.[1]?.headers).not.toHaveProperty("x-household");
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

describe("M4 endpoints", () => {
  it("uploads voicemail as a raw audio body with its type", async () => {
    const fetch = fakeFetch(201, { id: "vm_1" });
    const api = createApi({ token: "t".repeat(20), fetch });
    const blob = new Blob([new Uint8Array(10)], { type: "audio/webm;codecs=opus" });
    expect(await api.leaveVoicemail("dev 1", blob, 4200.4)).toEqual({ id: "vm_1" });
    const [url, init] = fetch.mock.calls[0] ?? [];
    expect(url).toBe("/api/devices/dev%201/voicemail?durationMs=4200");
    expect(init?.headers).toMatchObject({ "content-type": "audio/webm;codecs=opus" });
    expect(init?.body).toBe(blob);
  });

  it("surfaces server errors from raw requests", async () => {
    const onUnauthorized = vi.fn();
    const api = createApi({
      token: "t".repeat(20),
      fetch: fakeFetch(403, { error: "not allowed" }),
      onUnauthorized,
    });
    const err = await api
      .leaveVoicemail("d", new Blob(["x"], { type: "audio/ogg" }), 1)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 403, message: "not allowed" });
    expect(onUnauthorized).not.toHaveBeenCalled();
  });

  it("fetches voicemail audio as a blob with auth", async () => {
    const fetch = vi.fn(async () => new Response(new Uint8Array([1, 2, 3]), { status: 200 }));
    const api = createApi({ token: "t".repeat(20), fetch });
    const blob = await api.voicemailAudio("vm_1");
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
    expect(fetch.mock.calls[0]).toMatchObject([
      "/api/voicemails/vm_1/audio",
      { method: "GET", headers: { authorization: `Bearer ${"t".repeat(20)}` } },
    ]);
  });

  it("sends invite and passkey requests to the right routes", async () => {
    const fetch = fakeFetch(201, { token: "x", expiresAt: 1 });
    const api = createApi({ token: null, fetch });
    await api.invite({ name: "Grandma", role: "contact" });
    await api.invite({ userId: "usr_1" });
    await api.acceptInvite("tok");
    await api.passkeyLoginVerify("ch_1", { id: "cred" });
    const calls = fetch.mock.calls.map(([u, i]) => [u, i?.method, JSON.parse(String(i?.body))]);
    expect(calls).toEqual([
      ["/api/invites", "POST", { name: "Grandma", role: "contact" }],
      ["/api/invites", "POST", { userId: "usr_1" }],
      ["/api/invites/accept", "POST", { token: "tok" }],
      ["/api/passkeys/login/verify", "POST", { challengeId: "ch_1", response: { id: "cred" } }],
    ]);
  });
});
