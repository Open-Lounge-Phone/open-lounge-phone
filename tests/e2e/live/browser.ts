// Browser actors for the live test: a companion (one person, a Chromium context with a virtual
// passkey authenticator) and a browser phone (/device/). Every context records its
// RTCPeerConnections so checks can assert on real media state, and can force TURN relay.
import type { Browser, BrowserContext, CDPSession, Page } from "playwright-core";
import { api, type Person, type ServerTarget } from "../twoServers.ts";

export const CHROMIUM_ARGS = [
  "--use-fake-ui-for-media-stream",
  "--use-fake-device-for-media-stream",
  "--autoplay-policy=no-user-gesture-required",
];

/** Polls `fn` until it returns a truthy value. */
export async function until<T>(
  label: string,
  fn: () => Promise<T | undefined | null | false> | T | undefined | null | false,
  timeoutMs = 20_000,
  everyMs = 300,
): Promise<T> {
  const end = Date.now() + timeoutMs;
  let last: unknown;
  for (;;) {
    try {
      const v = await fn();
      if (v) return v as T;
    } catch (e) {
      last = e;
    }
    if (Date.now() > end) {
      throw new Error(`timed out waiting for ${label}${last ? `: ${String(last)}` : ""}`);
    }
    await new Promise((r) => setTimeout(r, everyMs));
  }
}

/** Installed in every page before its scripts run. */
function pcHook(): void {
  const w = window as unknown as {
    __olp: {
      forceRelay: boolean;
      pcs: { pc: RTCPeerConnection; config: RTCConfiguration; states: string[] }[];
    };
  };
  const Orig = window.RTCPeerConnection;
  if (!Orig || w.__olp) return;
  const state: (typeof w)["__olp"] = { forceRelay: false, pcs: [] };
  w.__olp = state;
  class Hooked extends Orig {
    constructor(config?: RTCConfiguration) {
      const cfg: RTCConfiguration = { ...(config ?? {}) };
      if (state.forceRelay) cfg.iceTransportPolicy = "relay";
      super(cfg);
      const rec = { pc: this as RTCPeerConnection, config: cfg, states: [] as string[] };
      this.addEventListener("connectionstatechange", () => rec.states.push(this.connectionState));
      state.pcs.push(rec);
    }
  }
  window.RTCPeerConnection = Hooked;
}

type PcRecord = { pc: RTCPeerConnection; config: RTCConfiguration; states: string[] };
type Hooked = { __olp?: { forceRelay: boolean; pcs: PcRecord[] } };

export interface PcInfo {
  count: number;
  state: string | null;
  states: string[];
  relayPolicy: boolean;
  iceServers: RTCIceServer[];
}

export async function lastPc(page: Page): Promise<PcInfo> {
  return page.evaluate(() => {
    const s = (window as unknown as Hooked).__olp;
    const rec = s?.pcs.at(-1);
    return {
      count: s?.pcs.length ?? 0,
      state: rec ? rec.pc.connectionState : null,
      states: rec ? rec.states : [],
      relayPolicy: rec?.config.iceTransportPolicy === "relay",
      iceServers: rec?.config.iceServers ?? [],
    };
  });
}

/** The candidate type (host/srflx/prflx/relay) of the selected pair's local side. */
export async function selectedCandidateType(page: Page): Promise<string | undefined> {
  return page.evaluate(async () => {
    const pc = (window as unknown as Hooked).__olp?.pcs.at(-1)?.pc;
    if (!pc) return undefined;
    const stats = await pc.getStats();
    let pairId: string | undefined;
    stats.forEach((r: { type: string; selectedCandidatePairId?: string }) => {
      if (r.type === "transport" && r.selectedCandidatePairId) pairId = r.selectedCandidatePairId;
    });
    const pair = pairId ? stats.get(pairId) : undefined;
    const local = pair ? stats.get(pair.localCandidateId) : undefined;
    return local?.candidateType as string | undefined;
  });
}

export async function setForceRelay(page: Page, on: boolean): Promise<void> {
  await page.evaluate((v: boolean) => {
    const s = (window as unknown as Hooked).__olp;
    if (s) s.forceRelay = v;
  }, on);
}

/** Waits until the newest peer connection created after `since` (a count) is connected. */
export async function pcConnected(page: Page, since: number, timeoutMs = 30_000) {
  return until(
    "RTCPeerConnection connected",
    async () => {
      const pc = await lastPc(page);
      return pc.count > since && pc.state === "connected" ? pc : undefined;
    },
    timeoutMs,
  );
}

async function newContext(browser: Browser, origin: string): Promise<BrowserContext> {
  const context = await browser.newContext({
    timezoneId: "UTC",
    viewport: { width: 1100, height: 800 },
  });
  await context.grantPermissions(["microphone"], { origin });
  await context.addInitScript(pcHook);
  return context;
}

export interface StoredCredential {
  credentialId: string;
  isResidentCredential: boolean;
  rpId: string;
  privateKey: string;
  userHandle?: string;
  signCount: number;
}

/** One person in the companion app, with a virtual platform authenticator. */
export class Companion {
  readonly origin: string;
  readonly handle: string;
  page!: Page;
  context!: BrowserContext;
  cdp!: CDPSession;
  authenticatorId!: string;
  person!: Person;

  constructor(origin: string, handle: string) {
    this.origin = origin;
    this.handle = handle;
  }

  get server(): ServerTarget {
    return { base: this.origin, origin: this.origin };
  }

  async open(browser: Browser): Promise<void> {
    this.context = await newContext(browser, this.origin);
    this.page = await this.context.newPage();
    this.cdp = await this.context.newCDPSession(this.page);
    await this.cdp.send("WebAuthn.enable");
    const { authenticatorId } = await this.cdp.send("WebAuthn.addVirtualAuthenticator", {
      options: {
        protocol: "ctap2",
        transport: "internal",
        hasResidentKey: true,
        hasUserVerification: true,
        isUserVerified: true,
        automaticPresenceSimulation: true,
      },
    });
    this.authenticatorId = authenticatorId;
  }

  async credentials(): Promise<StoredCredential[]> {
    const { credentials } = await this.cdp.send("WebAuthn.getCredentials", {
      authenticatorId: this.authenticatorId,
    });
    return credentials;
  }

  async addCredentials(creds: StoredCredential[]): Promise<void> {
    for (const credential of creds) {
      await this.cdp.send("WebAuthn.addCredential", {
        authenticatorId: this.authenticatorId,
        credential,
      });
    }
  }

  async token(): Promise<string | null> {
    if (!this.page) return null;
    return this.page.evaluate(() => localStorage.getItem("openloungephone.token"));
  }

  /** Loads the app signed in with `token`, without the one-time welcome. */
  async resume(token: string): Promise<void> {
    await this.page.goto(`${this.origin}/`);
    await this.page.evaluate((t: string) => {
      localStorage.setItem("openloungephone.token", t);
      localStorage.setItem("openloungephone.welcome", "done");
    }, token);
    await this.page.goto(`${this.origin}/`);
    await this.page.locator("nav.tabs").waitFor({ timeout: 20_000 });
    await this.ready();
  }

  /** Open sign-up through the UI with a passkey. */
  async signUp(name: string): Promise<void> {
    const page = this.page;
    await page.goto(`${this.origin}/`);
    await page.getByRole("button", { name: "Create an account" }).click();
    await page.getByLabel("Your name").fill(name);
    await page.getByRole("textbox", { name: /^Handle/ }).fill(this.handle);
    await page.getByRole("textbox", { name: /^Time zone/ }).fill("UTC");
    const create = page.getByRole("button", { name: /Create account with a passkey/ });
    await until(
      "sign-up button enabled (Turnstile)",
      async () => !(await create.isDisabled()),
      30_000,
    );
    await create.click();
    const token = await until("session token after sign-up", () => this.token(), 30_000);
    await this.resume(token);
    await this.refreshPerson();
  }

  async refreshPerson(): Promise<Person> {
    const token = (await this.token()) as string;
    const me = await api({ server: this.server, token }, "/me");
    if (me.status !== 200) throw new Error(`/api/me ${me.status}`);
    this.person = {
      server: this.server,
      token,
      householdId: me.json.household?.id,
      address: me.json.account.address,
    };
    return this.person;
  }

  /** Waits until the app's socket is open (the status dot isn't marked "socket-down"). */
  async ready(): Promise<void> {
    await this.page.locator(".phone-led:not(.socket-down)").waitFor({ timeout: 20_000 });
  }

  async tab(name: string): Promise<void> {
    await this.page.locator("nav.tabs button", { hasText: name }).first().click();
  }

  async signOut(): Promise<void> {
    await this.tab("Account");
    await this.page.getByRole("button", { name: "Sign out of this device" }).click();
    await this.page.getByRole("button", { name: "Sign in with a passkey" }).waitFor();
  }

  async signIn(): Promise<void> {
    await this.page.getByRole("button", { name: "Sign in with a passkey" }).click();
    await this.page.locator("nav.tabs").waitFor({ timeout: 20_000 });
  }

  overlay() {
    return this.page.locator(".overlay");
  }

  async answer(): Promise<void> {
    await this.page.locator(".overlay-incoming").getByRole("button", { name: "Answer" }).click({
      timeout: 20_000,
    });
  }

  async hangUp(): Promise<void> {
    await this.overlay().getByRole("button", { name: "Hang up" }).click();
  }

  /** Waits for the call overlay to show the call ended (or be gone), then closes it. */
  async ended(): Promise<string> {
    const text = await until(
      "call overlay ended",
      async () => {
        const o = this.page.locator(".overlay");
        if ((await o.count()) === 0) return "closed";
        const ended = this.page.locator(".overlay-ended");
        return (await ended.count()) > 0 ? await ended.innerText() : undefined;
      },
      20_000,
    );
    const close = this.page.locator(".overlay-ended").getByRole("button", { name: "Close" });
    if ((await close.count()) > 0) await close.click();
    return text;
  }

  pcCount(): Promise<number> {
    return lastPc(this.page).then((p) => p.count);
  }
}

export interface PhoneFacts {
  pairing: string;
  deviceId: string;
  connection: string;
  state: string;
  missed: string;
  display: string;
}

/** A browser phone at /device/ with the developer panel on. */
export class Phone {
  readonly origin: string;
  readonly profile: string;
  page!: Page;
  context!: BrowserContext;
  /** Every server message the phone received, newest last. */
  readonly frames: { t: string; [k: string]: unknown }[] = [];

  constructor(origin: string, profile: string) {
    this.origin = origin;
    this.profile = profile;
  }

  async open(browser: Browser, kind: "kids" | "lounge"): Promise<void> {
    this.context = await newContext(browser, this.origin);
    this.page = await this.context.newPage();
    type WsLike = { on(e: "framereceived", f: (x: { payload: string | Buffer }) => void): void };
    this.page.on("websocket", (ws: WsLike) => {
      ws.on("framereceived", (f) => {
        try {
          this.frames.push(JSON.parse(String(f.payload)));
        } catch {}
      });
    });
    await this.page.goto(`${this.origin}/device/?profile=${this.profile}&dev=1`);
    await this.page.locator(`.start__kind[data-kind="${kind}"]`).click();
    await until("pairing code", async () => /^\d{6}$/.test((await this.facts()).pairing), 20_000);
  }

  async facts(): Promise<PhoneFacts> {
    return this.page.evaluate(() => {
      const f = (n: string) =>
        document.querySelector(`[data-fact="${n}"]`)?.textContent?.trim() ?? "";
      return {
        pairing: f("pairing"),
        deviceId: f("deviceId"),
        connection: f("connection"),
        state: f("state"),
        missed: f("missed"),
        display: (document.querySelector(".display") as HTMLElement | null)?.innerText ?? "",
      };
    });
  }

  async kind(): Promise<string> {
    const s = (await this.facts()).state;
    try {
      return (JSON.parse(s) as { kind: string }).kind;
    } catch {
      return s;
    }
  }

  async waitKind(kind: string, timeoutMs = 20_000): Promise<void> {
    await until(`phone state ${kind}`, async () => (await this.kind()) === kind, timeoutMs);
  }

  async authed(): Promise<string> {
    return until(
      "phone authenticated",
      async () => {
        const f = await this.facts();
        return f.connection.includes("authenticated") && f.deviceId.startsWith("dev")
          ? f.deviceId
          : undefined;
      },
      30_000,
    );
  }

  async hook(): Promise<void> {
    await this.page.locator(".handset").click();
  }

  async press(key: string): Promise<void> {
    await this.page.keyboard.press(key);
  }

  lastFrame(t: string) {
    return [...this.frames].reverse().find((m) => m.t === t);
  }

  pcCount(): Promise<number> {
    return lastPc(this.page).then((p) => p.count);
  }
}
