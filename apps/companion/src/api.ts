/** Typed client for the Open Lounge Phone REST API (`/api/*`). */
import type { SpaceType } from "./spaces.ts";

export type Role = "guardian" | "contact";

export interface User {
  id: string;
  householdId: string;
  /** The person's account (the same across their households). */
  accountId?: string;
  name: string;
  role: Role;
}

/** You on this server: `handle@host`. */
export interface AccountInfo {
  id: string;
  handle: string;
  name: string;
  address: string;
}

/** One of your households (spaces) and your role there. */
export interface Membership {
  userId: string;
  householdId: string;
  householdName: string;
  /** `home` = a household; `team` / `org` = grown-ups only. */
  spaceType?: SpaceType;
  name: string;
  role: Role;
}

export interface Me {
  /** Your membership in the active household; null if you're in none yet. */
  user: User | null;
  household: Household | null;
  available?: boolean;
  account?: AccountInfo;
  memberships?: Membership[];
  openSignup?: boolean;
  /** You run this server (the admin view). */
  operator?: boolean;
}

export interface Household {
  id: string;
  name: string;
  timeZone: string;
  createdAt: number;
  type?: SpaceType;
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
  /** Set when this is a person's own phone (physical or virtual); null for household phones. */
  ownerUserId?: string | null;
  /** `lounge` = a shared phone people take over by scanning its code. */
  kind?: "kids" | "lounge";
  /** How it's used: a kids' phone, someone's own phone, or a shared Lounge phone. */
  mode?: "kids" | "personal" | "lounge";
  /** How this device lists the signed-in user, if at all. */
  contact: ContactEntry | null;
}

export type LoungeSessionPolicy = "idle" | "end_of_day" | "until_logout";

export type HouseLineTarget =
  | { kind: "user"; userId: string }
  | { kind: "device"; deviceId: string }
  | { kind: "group"; userIds: string[] };

export interface HouseLineKey {
  index: number;
  label: string;
  target: HouseLineTarget;
}

export interface LoungeIdle {
  houseLine: { enabled: boolean; keys: HouseLineKey[] };
  whosHere: boolean;
}

export interface LoungeSettingsPatch {
  idleMinutes?: number;
  guests?: boolean;
  session?: LoungeSessionPolicy;
  dayEnd?: string;
  houseLine?: LoungeIdle["houseLine"];
  whosHere?: boolean;
}

export interface LoungeInfo {
  idleMinutes: number;
  /** People from other servers may use these Lounge phones (their server vouches). */
  guests?: boolean;
  /** How long a session lasts in this space. */
  session?: LoungeSessionPolicy;
  /** `end_of_day`: local "HH:MM". */
  dayEnd?: string;
  /** Guardians: what idle phones offer (all off by default). */
  idle?: LoungeIdle;
  phones: {
    id: string;
    name: string;
    online: boolean;
    session: { userId: string; name: string; since: number } | null;
  }[];
  /** Guardians only: that sessions happened (who, where, when) — nothing about calls. */
  history?: {
    deviceId: string;
    userId: string;
    userName: string;
    startedAt: number;
    endedAt: number | null;
    endReason: string | null;
  }[];
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
  householdId?: string;
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
  account?: AccountInfo;
}

/** Someone you're connected with, knocked on, or blocked. */
export interface ConnectionView {
  id: string;
  /** `handle@host` */
  address: string;
  host: string;
  /** On another server. */
  remote: boolean;
  name: string;
  state: "requested" | "active" | "declined" | "blocked";
  /** `in` = they knocked on you; `out` = you knocked on them. */
  direction: "in" | "out" | "none";
  note: string | null;
  createdAt: number;
  expiresAt: number | null;
  /** Their availability, if they share it with connections (null = not shared / unknown). */
  presence?: { online: boolean; available: boolean; at: number } | null;
  /** Household phones on their side that you may call. */
  phones?: { deviceId: string; label: string }[];
}

export interface ConnectionsInfo {
  /** Your own address, to share. */
  address: string;
  /** Whether this server can connect to other servers. */
  federates: boolean;
  connections: ConnectionView[];
  blockedServers: { id: string; host: string }[];
  /** Whether you share your availability with your connections. */
  sharePresence?: boolean;
}

/** A connection on a phone's allow-list (its `rc_…` id is also in `contacts`). */
export interface RemoteContactInfo {
  id: string;
  connectionId: string;
  address: string;
  name: string;
}

/** The fair-use allowance (unset limits = unlimited). */
export interface FairUseLimits {
  callMinutesPerMonth?: number;
  voicemailsPerMonth?: number;
  voicemailMbPerMonth?: number;
  knocksPerMonth?: number;
  phonesPerSpace?: number;
  spacesPerAccount?: number;
}

export interface UsageInfo {
  month: string;
  callMinutes: number;
  voicemails: number;
  voicemailBytes: number;
  knocks: number;
  resetsAt: number;
  resetsOn: string;
  limits: FairUseLimits | null;
  exempt: boolean;
}

export interface HubInfo {
  fairUse: FairUseLimits | null;
  funding: {
    balanceUsd: number;
    summary: {
      balanceUsd: number;
      peoplePerDollarPerMonth: number;
      peopleForAYear: number;
      peopleForSixMonths: number;
    };
  } | null;
  sponsorUrl: string | null;
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
  /** Left for a household phone (guardians see these)… */
  deviceId: string | null;
  /** …or for you (your own inbox). */
  toUser: string | null;
  fromUser: string | null;
  fromLabel: string;
  createdAt: number;
  durationMs: number;
  mime: string;
  transcript: string | null;
  transcriptStatus: TranscriptStatus;
  heardAt: number | null;
}

/** How long history is kept; "default" = inherit (connection → account → server). */
export type Retention = "default" | "30d" | "1y" | "forever";

export interface TimelineVoicemail {
  id: string;
  at: number;
  fromLabel: string;
  durationMs: number;
  transcript: string | null;
  transcriptStatus: TranscriptStatus;
  heardAt: number | null;
}

export type TimelineItem =
  | {
      kind: "call";
      id: string;
      at: number;
      direction: "in" | "out";
      answered: boolean;
      durationMs: number;
      endReason: string | null;
      voicemail: TimelineVoicemail | null;
    }
  | { kind: "voicemail"; id: string; at: number; voicemail: TimelineVoicemail };

/** One connection's history (GET /connections/:id/timeline). */
export interface Timeline {
  connection: ConnectionView;
  retention: {
    setting: Retention;
    account: Retention;
    effective: Exclude<Retention, "default">;
    from: "connection" | "account" | "server";
  };
  items: TimelineItem[];
}

export type GreetingKind = "default" | "name" | "custom";

/** Voicemail settings of a person (yours) or a kids' phone. */
export interface VoicemailSettings {
  ringSeconds: number;
  greeting: { kind: GreetingKind; durationMs?: number };
  /** Who callers hear named in the default greeting. */
  name: string;
  /** Kids' phones: the child may record the phone's greeting from its menu. */
  childGreeting?: boolean;
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
  /** Act in this one of your households (sent as `x-household`); else the session's active one. */
  household?: string;
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
    if (opts.household) headers["x-household"] = opts.household;
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
    if (opts.household) headers["x-household"] = opts.household;
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
    setupStatus: () =>
      request<{ needed: boolean; signup?: boolean; turnstileSiteKey?: string }>("GET", "/setup"),
    /** Public: the server's fair-use allowance, funding and Sponsor link (hubs). */
    hubInfo: () => request<HubInfo>("GET", "/hub"),
    usage: () => request<UsageInfo>("GET", "/usage"),
    me: () => request<Me>("GET", "/me"),

    // Accounts and households
    signupOptions: (input: {
      handle: string;
      name: string;
      timeZone: string;
      householdName?: string;
      turnstileToken?: string;
    }) => request<CeremonyOptions & { address: string }>("POST", "/signup/options", input),
    signup: (challengeId: string, response: unknown, passkeyName: string) =>
      request<SignedInResult>("POST", "/signup", { challengeId, response, passkeyName }),
    createHousehold: (input: { name: string; timeZone?: string; type?: SpaceType }) =>
      request<{ household: Household; user: User }>("POST", "/households", input),
    switchHousehold: (householdId: string) =>
      request<void>("PUT", "/me/household", { householdId }),
    updateAccount: (changes: { handle?: string; name?: string; sharePresence?: boolean }) =>
      request<AccountInfo>("PATCH", "/account", changes),
    logout: () => request<void>("POST", "/logout"),
    /** Everything this server holds about your account (JSON, docs/export.md). */
    exportAccount: async () => (await send("GET", "/account/export")).blob(),
    deleteAccount: (confirm: string) => request<void>("DELETE", "/account", { confirm }),
    users: () => request<User[]>("GET", "/users"),
    devices: () => request<DeviceSummary[]>("GET", "/devices"),
    pair: (code: string, name: string, mode: "kids" | "personal" | "lounge") =>
      request<{ id: string; name: string; mode: string }>("POST", "/devices/pair", {
        code,
        name,
        mode,
      }),
    /** Before pairing: what the phone was set up as. */
    pairPreview: (code: string) =>
      request<{ mode: "kids" | "personal" | "lounge" | null }>("POST", "/devices/pair/preview", {
        code,
      }),
    lounge: () => request<LoungeInfo>("GET", "/lounge"),
    /** Use a Lounge phone on another server; this server vouches for you there. */
    remoteLounge: (input: { host: string; deviceId: string; nonce: string }) =>
      request<{ step: "press_key" | "failed"; reason?: string; expiresAt?: number }>(
        "POST",
        "/lounge/remote",
        input,
      ),
    remoteLoungeLeave: (input: { host: string; deviceId: string }) =>
      request<void>("POST", "/lounge/remote/leave", input),
    setLoungeIdle: (idleMinutes: number) =>
      request<void>("PUT", "/lounge/settings", { idleMinutes }),
    setLoungeGuests: (guests: boolean) => request<void>("PUT", "/lounge/settings", { guests }),
    setLoungeSettings: (patch: LoungeSettingsPatch) =>
      request<void>("PUT", "/lounge/settings", patch),
    updateDevice: (deviceId: string, changes: { name?: string; owner?: "me" | "household" }) =>
      request<void>("PATCH", `/devices/${enc(deviceId)}`, changes),
    removeDevice: (deviceId: string) => request<void>("DELETE", `/devices/${enc(deviceId)}`),
    contacts: (deviceId: string) =>
      request<{
        contacts: ContactEntry[];
        buttons: Record<string, string>;
        remote?: RemoteContactInfo[];
      }>("GET", `/devices/${enc(deviceId)}/contacts`),
    putRemoteContact: (deviceId: string, connectionId: string, contact: Omit<ContactEntry, "id">) =>
      request<{ id: string }>(
        "PUT",
        `/devices/${enc(deviceId)}/remote-contacts/${enc(connectionId)}`,
        contact,
      ),

    // Operators (the hub's admin view)
    adminOverview: () =>
      request<{
        counts: Record<string, number>;
        blockedServers: { host: string; reason: string | null; createdAt: number }[];
        keyAlerts: { host: string; rejectedAt: number }[];
      }>("GET", "/admin/overview"),
    adminFindAccount: (handle: string) =>
      request<{
        id: string;
        handle: string;
        name: string;
        createdAt: number;
        suspended: boolean;
        exempt: boolean;
        spaces: number;
        usage: { callMinutes: number; voicemails: number; knocks: number };
      }>("GET", `/admin/accounts?handle=${enc(handle)}`),
    adminSuspend: (accountId: string, suspended: boolean) =>
      request<void>("POST", `/admin/accounts/${enc(accountId)}/suspend`, { suspended }),
    adminExempt: (accountId: string, exempt: boolean) =>
      request<void>("POST", `/admin/accounts/${enc(accountId)}/exempt`, { exempt }),
    adminBlockServer: (host: string, reason?: string) =>
      request<void>("POST", "/admin/servers/block", { host, ...(reason ? { reason } : {}) }),
    adminUnblockServer: (host: string) => request<void>("DELETE", `/admin/servers/${enc(host)}`),

    // Connections (knock, then talk)
    connections: () => request<ConnectionsInfo>("GET", "/connections"),
    knock: (to: string, note?: string) =>
      request<{ status: "sent" | "connected"; connection: ConnectionView }>(
        "POST",
        "/connections",
        {
          to,
          ...(note ? { note } : {}),
        },
      ),
    acceptConnection: (id: string) =>
      request<ConnectionView>("POST", `/connections/${enc(id)}/accept`),
    declineConnection: (id: string) => request<void>("POST", `/connections/${enc(id)}/decline`),
    blockConnection: (id: string) => request<void>("POST", `/connections/${enc(id)}/block`),
    removeConnection: (id: string) => request<void>("DELETE", `/connections/${enc(id)}`),
    blockServer: (host: string) => request<void>("POST", "/connections/block-server", { host }),
    /** A connection's history: calls and the voicemails they left you. */
    timeline: (id: string) => request<Timeline>("GET", `/connections/${enc(id)}/timeline`),
    setConnectionRetention: (id: string, retention: Retention) =>
      request<void>("PUT", `/connections/${enc(id)}/retention`, { retention }),
    accountRetention: () => request<{ retention: Retention }>("GET", "/account/retention"),
    setAccountRetention: (retention: Retention) =>
      request<void>("PUT", "/account/retention", { retention }),
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

    /**
     * Voicemail settings and greeting: yours (`deviceId` undefined) or a kids' phone's
     * (guardians).
     */
    voicemailSettings: (deviceId?: string) =>
      request<VoicemailSettings>(
        "GET",
        deviceId ? `/devices/${enc(deviceId)}/voicemail` : "/voicemail/settings",
      ),
    setVoicemailSettings: (
      patch: { ringSeconds?: number; childGreeting?: boolean },
      deviceId?: string,
    ) =>
      request<void>(
        "PATCH",
        deviceId ? `/devices/${enc(deviceId)}/voicemail` : "/voicemail/settings",
        patch,
      ),
    greetingAudio: async (deviceId?: string) => {
      const res = await send(
        "GET",
        deviceId ? `/devices/${enc(deviceId)}/greeting/audio` : "/voicemail/greeting/audio",
      );
      return res.status === 200 ? res.blob() : undefined;
    },
    setGreeting: async (
      kind: "name" | "custom",
      audio: Blob,
      durationMs: number,
      deviceId?: string,
    ) => {
      const path = deviceId ? `/devices/${enc(deviceId)}/greeting` : "/voicemail/greeting";
      await send("PUT", `${path}?kind=${kind}&durationMs=${Math.round(durationMs)}`, {
        body: audio,
      });
    },
    resetGreeting: (deviceId?: string) =>
      request<void>(
        "DELETE",
        deviceId ? `/devices/${enc(deviceId)}/greeting` : "/voicemail/greeting",
      ),
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
