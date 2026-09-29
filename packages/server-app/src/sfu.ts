// Media relays for rooms (an SFU): the Cloudflare Realtime SFU, or a self-hosted LiveKit. Without
// one, rooms are a peer-to-peer mesh of at most 4 people. 1:1 calls never use a relay.
//
// Cloudflare (https://developers.cloudflare.com/realtime/sfu/https-api/): every participant has
// one peer connection = one SFU session. The server holds the app secret and drives everything:
// it pushes the participant's microphone and pulls the others' audio into "slots"
// (transceivers). When the active speakers change, the old slot is closed with a negotiated
// close (the client stops the transceiver and offers) and the new speaker is pulled; the SFU
// reuses the closed m-line, so the SDP doesn't grow. (`tracks/update` only re-targets simulcast
// tracks, so it can't move an audio slot to another speaker.)
//
// LiveKit (self-host): clients connect to the LiveKit server themselves with a join token this
// server signs (HS256, WebCrypto), and subscribe to whom `room.state.forward` lists.
import { toBase64Url } from "@openloungephone/protocol";

export interface CloudflareSfuConfig {
  kind: "cloudflare";
  appId: string;
  appSecret: string;
  /** Default https://rtc.live.cloudflare.com/v1 (tests point it elsewhere). */
  baseUrl?: string;
}

export interface LiveKitConfig {
  kind: "livekit";
  /** Where clients connect, e.g. wss://livekit.example.com. */
  url: string;
  apiKey: string;
  apiSecret: string;
  /** The server API base when it differs from `url` (e.g. http://livekit:7880 in compose). */
  apiUrl?: string;
}

export type RelayConfig = CloudflareSfuConfig | LiveKitConfig;

/** Reads the relay from environment variables (both backends use the same names). */
export function relayFromVars(vars: Record<string, string | undefined>): RelayConfig | undefined {
  const appId = vars.SFU_APP_ID?.trim();
  const appSecret = vars.SFU_APP_SECRET?.trim();
  if (appId && appSecret) return { kind: "cloudflare", appId, appSecret };
  const url = vars.LIVEKIT_URL?.trim();
  const apiKey = vars.LIVEKIT_API_KEY?.trim();
  const apiSecret = vars.LIVEKIT_API_SECRET?.trim();
  if (url && apiKey && apiSecret) {
    const apiUrl = vars.LIVEKIT_API_URL?.trim();
    return { kind: "livekit", url, apiKey, apiSecret, ...(apiUrl ? { apiUrl } : {}) };
  }
  return undefined;
}

export class SfuError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

type Sdp = { type: "offer" | "answer"; sdp: string };

interface TracksResponse {
  errorCode?: string;
  errorDescription?: string;
  requiresImmediateRenegotiation?: boolean;
  sessionDescription?: Sdp;
  tracks?: {
    mid?: string;
    trackName?: string;
    sessionId?: string;
    errorCode?: string;
    errorDescription?: string;
  }[];
}

/** The mid of the first audio section of an SDP (where a phone's or app's microphone goes). */
export function audioMid(sdp: string): string | undefined {
  const sections = sdp.split(/\r?\nm=/).slice(1);
  for (const section of sections) {
    if (!section.startsWith("audio")) continue;
    const mid = /\r?\na=mid:(\S+)/.exec(section)?.[1];
    if (mid !== undefined) return mid;
  }
  return undefined;
}

/** The Cloudflare Realtime SFU's HTTPS API, as this server uses it. */
export class CloudflareSfu {
  private readonly cfg: CloudflareSfuConfig;
  private readonly fetchFn: (r: Request) => Promise<Response>;

  constructor(cfg: CloudflareSfuConfig, fetchFn: (r: Request) => Promise<Response> = fetch) {
    this.cfg = cfg;
    this.fetchFn = fetchFn;
  }

  private async call<T extends { errorCode?: string; errorDescription?: string }>(
    method: "GET" | "POST" | "PUT",
    path: string,
    body?: unknown,
  ): Promise<T> {
    const base = this.cfg.baseUrl ?? "https://rtc.live.cloudflare.com/v1";
    const res = await this.fetchFn(
      new Request(`${base}/apps/${this.cfg.appId}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${this.cfg.appSecret}`,
          "content-type": "application/json",
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    );
    const json = (await res.json().catch(() => ({}))) as T;
    if (!res.ok || json.errorCode) {
      throw new SfuError(
        json.errorCode ?? `http_${res.status}`,
        json.errorDescription ?? `SFU ${path}: HTTP ${res.status}`,
      );
    }
    return json;
  }

  async newSession(): Promise<string> {
    const r = await this.call<{ sessionId?: string; errorCode?: string }>("POST", "/sessions/new");
    if (!r.sessionId) throw new SfuError("no_session", "the SFU returned no session");
    return r.sessionId;
  }

  /** Publishes the client's microphone (its offer) under `trackName`; returns the answer. */
  async push(sessionId: string, offer: string, trackName: string): Promise<string> {
    const mid = audioMid(offer);
    if (mid === undefined) throw new SfuError("no_audio", "the offer has no audio");
    const r = await this.call<TracksResponse>("POST", `/sessions/${sessionId}/tracks/new`, {
      sessionDescription: { type: "offer", sdp: offer },
      tracks: [{ location: "local", mid, trackName }],
    });
    const failed = r.tracks?.find((t) => t.errorCode);
    if (failed)
      throw new SfuError(failed.errorCode as string, failed.errorDescription ?? "push failed");
    if (r.sessionDescription?.type !== "answer") throw new SfuError("no_answer", "no SDP answer");
    return r.sessionDescription.sdp;
  }

  /**
   * Pulls other participants' audio into new slots. Returns the SFU's offer for the client (to
   * answer, then `renegotiate`) and the new slots' mids, in request order.
   */
  async pull(
    sessionId: string,
    sources: { sessionId: string; trackName: string }[],
  ): Promise<{ offer?: string; mids: string[] }> {
    const r = await this.call<TracksResponse>("POST", `/sessions/${sessionId}/tracks/new`, {
      tracks: sources.map((s) => ({
        location: "remote",
        sessionId: s.sessionId,
        trackName: s.trackName,
      })),
    });
    const failed = r.tracks?.find((t) => t.errorCode);
    if (failed)
      throw new SfuError(failed.errorCode as string, failed.errorDescription ?? "pull failed");
    const mids = (r.tracks ?? []).map((t) => t.mid ?? "");
    return {
      mids,
      ...(r.requiresImmediateRenegotiation && r.sessionDescription?.type === "offer"
        ? { offer: r.sessionDescription.sdp }
        : {}),
    };
  }

  async renegotiate(sessionId: string, answer: string): Promise<void> {
    await this.call("PUT", `/sessions/${sessionId}/renegotiate`, {
      sessionDescription: { type: "answer", sdp: answer },
    });
  }

  /**
   * Closes tracks. With the client's offer (it stopped those transceivers first) the close is
   * negotiated and the SFU returns an answer; the SFU then reuses those m-lines for later pulls,
   * so the session's SDP stays small however often the speakers change. Without an offer the
   * close is forced (someone who left or was removed: nothing to negotiate).
   */
  async close(sessionId: string, mids: string[], offer?: string): Promise<string | undefined> {
    if (mids.length === 0) return undefined;
    const r = await this.call<TracksResponse>("PUT", `/sessions/${sessionId}/tracks/close`, {
      tracks: mids.map((mid) => ({ mid })),
      ...(offer ? { sessionDescription: { type: "offer", sdp: offer } } : {}),
      force: !offer,
    });
    return r.sessionDescription?.type === "answer" ? r.sessionDescription.sdp : undefined;
  }
}

// --- LiveKit ---------------------------------------------------------------------

const enc = new TextEncoder();

async function hmacSha256(secret: string, data: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(data)));
}

/** An HS256 JWT (what LiveKit uses for join tokens and its server API). */
export async function signJwt(secret: string, claims: Record<string, unknown>): Promise<string> {
  const header = toBase64Url(enc.encode(JSON.stringify({ alg: "HS256", typ: "JWT" })));
  const payload = toBase64Url(enc.encode(JSON.stringify(claims)));
  const sig = toBase64Url(await hmacSha256(secret, `${header}.${payload}`));
  return `${header}.${payload}.${sig}`;
}

/** A LiveKit join token for one participant (audio only, 6 hours). */
export function livekitJoinToken(
  cfg: LiveKitConfig,
  p: { room: string; identity: string; name: string },
  now: number,
): Promise<string> {
  const s = Math.floor(now / 1000);
  return signJwt(cfg.apiSecret, {
    iss: cfg.apiKey,
    sub: p.identity,
    name: p.name,
    nbf: s - 10,
    exp: s + 6 * 3600,
    video: {
      room: p.room,
      roomJoin: true,
      canPublish: true,
      canSubscribe: true,
      canPublishData: false,
      canPublishSources: ["microphone"],
    },
  });
}

/** Removes someone from a LiveKit room (host remove, idle drop, leaving). */
export async function livekitRemove(
  cfg: LiveKitConfig,
  room: string,
  identity: string,
  now: number,
  fetchFn: (r: Request) => Promise<Response> = fetch,
): Promise<void> {
  const s = Math.floor(now / 1000);
  const token = await signJwt(cfg.apiSecret, {
    iss: cfg.apiKey,
    nbf: s - 10,
    exp: s + 60,
    video: { room, roomAdmin: true },
  });
  const base = (cfg.apiUrl ?? cfg.url).replace(/^ws/, "http").replace(/\/$/, "");
  await fetchFn(
    new Request(`${base}/twirp/livekit.RoomService/RemoveParticipant`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ room, identity }),
    }),
  );
}
