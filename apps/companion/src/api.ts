/** Typed client for the OpenTinCan REST API (`/api/*`). */

export type Role = "guardian" | "contact";

export interface User {
  id: string;
  householdId: string;
  name: string;
  role: Role;
}

export interface Household {
  id: string;
  name: string;
  timeZone: string;
  createdAt: number;
}

export interface ContactEntry {
  /** The contact's user id. */
  id: string;
  label: string;
  canCallDevice: boolean;
  deviceCanCall: boolean;
  bypassQuietHours: boolean;
}

export interface DeviceSummary {
  id: string;
  name: string;
  online: boolean;
  lastSeen: number | null;
  /** How this device lists the signed-in user, if at all. */
  contact: ContactEntry | null;
}

export interface QuietRule {
  days: number[];
  start: string;
  end: string;
}

export interface Schedule {
  timeZone: string;
  rules: QuietRule[];
}

export interface InviteCreated {
  token: string;
  expiresAt: number;
}

export interface InvitePreview {
  householdName: string;
  name: string;
  role: Role;
  /** A sign-in link for someone who already has an account. */
  existing: boolean;
}

export interface SignedInResult {
  token: string;
  user: User;
  household: Household;
}

export interface PasskeySummary {
  id: string;
  name: string;
  createdAt: number;
  lastUsedAt: number | null;
}

export type TranscriptStatus = "pending" | "done" | "failed" | "unavailable";

export interface VoicemailSummary {
  id: string;
  deviceId: string;
  fromUser: string | null;
  fromLabel: string;
  createdAt: number;
  durationMs: number;
  mime: string;
  transcript: string | null;
  transcriptStatus: TranscriptStatus;
  heardAt: number | null;
}

/** Passkey ceremony options as returned by the server (passed through to the browser API). */
// biome-ignore lint/suspicious/noExplicitAny: opaque WebAuthn JSON, typed by @simplewebauthn
export type CeremonyOptions = { challengeId: string; options: any };

export class ApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

export interface ApiOptions {
  token: string | null;
  fetch?: Fetch;
  /** Called on any 401 so the app can drop the session. */
  onUnauthorized?: () => void;
  base?: string;
}

export function createApi(opts: ApiOptions) {
  const doFetch: Fetch = opts.fetch ?? ((input, init) => fetch(input, init));
  const base = opts.base ?? "/api";

  /** Raw request; throws ApiError for non-2xx. */
  async function send(
    method: string,
    path: string,
    init: { json?: unknown; body?: Blob; contentType?: string } = {},
  ): Promise<Response> {
    const headers: Record<string, string> = {};
    if (init.json !== undefined) headers["content-type"] = "application/json";
    if (init.body) headers["content-type"] = init.contentType ?? init.body.type;
    if (opts.token) headers.authorization = `Bearer ${opts.token}`;
    const res = await doFetch(`${base}${path}`, {
      method,
      headers,
      ...(init.json !== undefined ? { body: JSON.stringify(init.json) } : {}),
      ...(init.body ? { body: init.body } : {}),
    });
    if (res.status === 401) opts.onUnauthorized?.();
    if (!res.ok) throw await errorFrom(res);
    return res;
  }

  async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = {};
    if (body !== undefined) headers["content-type"] = "application/json";
    if (opts.token) headers.authorization = `Bearer ${opts.token}`;
    const res = await doFetch(`${base}${path}`, {
      method,
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    if (res.status === 401) opts.onUnauthorized?.();
    const text = await res.text();
    const json = text ? (JSON.parse(text) as unknown) : undefined;
    if (!res.ok) {
      const message =
        json && typeof json === "object" && "error" in json
          ? String((json as { error: unknown }).error)
          : `request failed (${res.status})`;
      throw new ApiError(res.status, message);
    }
    return json as T;
  }

  const enc = encodeURIComponent;

  return {
    setup: (input: {
      token: string;
      householdName: string;
      guardianName: string;
      timeZone: string;
    }) => request<{ token: string; user: User; household: Household }>("POST", "/setup", input),
    me: () => request<{ user: User; household: Household }>("GET", "/me"),
    logout: () => request<void>("POST", "/logout"),
    users: () => request<User[]>("GET", "/users"),
    devices: () => request<DeviceSummary[]>("GET", "/devices"),
    pair: (code: string, name: string) =>
      request<{ id: string; name: string }>("POST", "/devices/pair", { code, name }),
    contacts: (deviceId: string) =>
      request<{ contacts: ContactEntry[]; buttons: Record<string, string> }>(
        "GET",
        `/devices/${enc(deviceId)}/contacts`,
      ),
    putContact: (deviceId: string, contact: ContactEntry) => {
      const { id, ...rest } = contact;
      return request<void>("PUT", `/devices/${enc(deviceId)}/contacts/${enc(id)}`, rest);
    },
    deleteContact: (deviceId: string, userId: string) =>
      request<void>("DELETE", `/devices/${enc(deviceId)}/contacts/${enc(userId)}`),
    setButton: (deviceId: string, index: number, userId: string | null) =>
      request<void>("PUT", `/devices/${enc(deviceId)}/buttons/${index}`, { userId }),
    quietHours: () => request<Schedule>("GET", "/quiet-hours"),
    setQuietHours: (rules: QuietRule[]) => request<void>("PUT", "/quiet-hours", { rules }),

    // People & invites
    invite: (input: { name: string; role: Role } | { userId: string }) =>
      request<InviteCreated>("POST", "/invites", input),
    invitePreview: (token: string) => request<InvitePreview>("GET", `/invites/${enc(token)}`),
    acceptInvite: (token: string) => request<SignedInResult>("POST", "/invites/accept", { token }),
    removeUser: (userId: string) => request<void>("DELETE", `/users/${enc(userId)}`),

    // Passkeys
    passkeys: () => request<PasskeySummary[]>("GET", "/passkeys"),
    removePasskey: (id: string) => request<void>("DELETE", `/passkeys/${enc(id)}`),
    passkeyRegisterOptions: () => request<CeremonyOptions>("POST", "/passkeys/register/options"),
    passkeyRegisterVerify: (challengeId: string, response: unknown, name: string) =>
      request<void>("POST", "/passkeys/register/verify", { challengeId, response, name }),
    passkeyLoginOptions: () => request<CeremonyOptions>("POST", "/passkeys/login/options"),
    passkeyLoginVerify: (challengeId: string, response: unknown) =>
      request<SignedInResult>("POST", "/passkeys/login/verify", { challengeId, response }),

    // Voicemail
    voicemails: () => request<VoicemailSummary[]>("GET", "/voicemails"),
    voicemailAudio: async (id: string) =>
      (await send("GET", `/voicemails/${enc(id)}/audio`)).blob(),
    markHeard: (id: string) => request<void>("POST", `/voicemails/${enc(id)}/heard`),
    deleteVoicemail: (id: string) => request<void>("DELETE", `/voicemails/${enc(id)}`),
    leaveVoicemail: async (deviceId: string, audio: Blob, durationMs: number) =>
      (await (
        await send(
          "POST",
          `/devices/${enc(deviceId)}/voicemail?durationMs=${Math.round(durationMs)}`,
          { body: audio },
        )
      ).json()) as { id: string },
  };
}

export type Api = ReturnType<typeof createApi>;

async function errorFrom(res: Response): Promise<ApiError> {
  let message = `request failed (${res.status})`;
  try {
    const json = (await res.json()) as { error?: unknown };
    if (json && typeof json === "object" && "error" in json) message = String(json.error);
  } catch {
    // not JSON
  }
  return new ApiError(res.status, message);
}
