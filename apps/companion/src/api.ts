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
  };
}

export type Api = ReturnType<typeof createApi>;
