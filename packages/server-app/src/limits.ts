import type { FundingConfig } from "@openloungephone/core";
import type { ServerEnv } from "./env.ts";

/**
 * Every rate limit in one place. Hosts may override any of them (`ServerEnv.limits`); the
 * defaults are fair for a public server and harmless for a family one.
 */
export interface Limits {
  /** Knocks one account may send per day. */
  knocksPerDay: number;
  /** Knocks one account accepts into its inbox per day (the rest are dropped silently). */
  inboxKnocksPerDay: number;
  /** Signed requests any one other server may make per minute. */
  fedRequestsPerMinute: number;
  /** Knocks any one other server may deliver per day. */
  fedKnocksPerDay: number;
  /** Accounts one IP address may create per hour (successful sign-ups). */
  signupsPerIpPerHour: number;
  /** Sign-up attempts (passkey ceremonies started) from one IP address per hour. */
  signupAttemptsPerIpPerHour: number;
  /** Recovery-code attempts from one IP address per hour. */
  recoveryAttemptsPerIpPerHour: number;
  /** Recovery-code attempts for one handle from one IP address per hour (so a stranger
   * guessing elsewhere can't lock the owner out). */
  recoveryAttemptsPerHandlePerHour: number;
  /** Recovery-code attempts for one handle per day, from anywhere. */
  recoveryAttemptsPerHandlePerDay: number;
  /** Passkey sign-in attempts from one IP address per minute. */
  signInsPerIpPerMinute: number;
  /** Changes (non-GET API requests) one account may make per minute. */
  writesPerAccountPerMinute: number;
  /** Calls one caller (an address) may place to one public line per hour. */
  lineCallsPerCallerPerHour: number;
  /** Calls any one other server's people may place to one public line per hour. */
  lineCallsPerServerPerHour: number;
  /**
   * Calls one add-on takes at once, at most (it asks for up to this with `addon.about.lines`;
   * default 1). Enough for a small radio's listeners; beyond it callers hear busy.
   */
  addonCallsAtOnce: number;
  /**
   * The longest call with an add-on, in minutes: a forgotten open line (or an endless stream)
   * stops counting against its owner, and the call's TURN credentials expire with it.
   */
  addonCallMinutes: number;
  /** Calls one add-on may place per hour (to its owner and holders together). */
  addonCallsOutPerHour: number;
  /** Calls one add-on may place to one person per day: no ringing everyone as a broadcast. */
  addonCallsOutPerPersonPerDay: number;
  /** Calls one person may place to one add-on per hour. */
  addonCallsInPerCallerPerHour: number;
  /** Share lists (`addon.shares`) one add-on may send per hour. */
  addonShareUpdatesPerHour: number;
  /** Times one add-on may connect (and sign in) per hour: a reconnect storm is cut off. */
  addonConnectsPerHour: number;
  /** Messages one add-on connection may send per minute (more closes it). */
  addonMessagesPerMinute: number;
}

export const DEFAULT_LIMITS: Limits = {
  knocksPerDay: 10,
  inboxKnocksPerDay: 50,
  fedRequestsPerMinute: 300,
  fedKnocksPerDay: 500,
  signupsPerIpPerHour: 10,
  signupAttemptsPerIpPerHour: 60,
  recoveryAttemptsPerIpPerHour: 20,
  recoveryAttemptsPerHandlePerHour: 5,
  recoveryAttemptsPerHandlePerDay: 100,
  signInsPerIpPerMinute: 30,
  writesPerAccountPerMinute: 120,
  lineCallsPerCallerPerHour: 10,
  lineCallsPerServerPerHour: 300,
  addonCallsAtOnce: 10,
  addonCallMinutes: 240,
  addonCallsOutPerHour: 10,
  addonCallsOutPerPersonPerDay: 6,
  addonCallsInPerCallerPerHour: 30,
  addonShareUpdatesPerHour: 60,
  addonConnectsPerHour: 120,
  addonMessagesPerMinute: 600,
};

export const limitsOf = (env: ServerEnv): Limits => ({ ...DEFAULT_LIMITS, ...env.limits });

/**
 * The fair-use allowance: generous caps that stop abuse of a shared server, not a paid plan.
 * Unset = unlimited, which is the default everywhere except a public hub. Operators can exempt
 * an account (e.g. a venue with Lounge phones).
 */
export interface FairUse {
  callMinutesPerMonth?: number;
  voicemailsPerMonth?: number;
  voicemailMbPerMonth?: number;
  knocksPerMonth?: number;
  phonesPerSpace?: number;
  spacesPerAccount?: number;
  /** Minutes in rooms (participant-minutes: 3 people for 10 minutes = 30 for the three). */
  roomMinutesPerMonth?: number;
}

/** The public hub's allowance (FAIR_USE=hub). */
export const HUB_FAIR_USE: Required<FairUse> = {
  callMinutesPerMonth: 1000,
  voicemailsPerMonth: 100,
  voicemailMbPerMonth: 100,
  knocksPerMonth: 100,
  phonesPerSpace: 5,
  spacesPerAccount: 5,
  roomMinutesPerMonth: 1000,
};

const FAIR_USE_VARS: Record<keyof FairUse, string> = {
  callMinutesPerMonth: "FAIR_USE_CALL_MINUTES",
  voicemailsPerMonth: "FAIR_USE_VOICEMAILS",
  voicemailMbPerMonth: "FAIR_USE_VOICEMAIL_MB",
  knocksPerMonth: "FAIR_USE_KNOCKS",
  phonesPerSpace: "FAIR_USE_PHONES_PER_SPACE",
  spacesPerAccount: "FAIR_USE_SPACES_PER_ACCOUNT",
  roomMinutesPerMonth: "FAIR_USE_ROOM_MINUTES",
};

/**
 * Reads the allowance from environment variables: `FAIR_USE=hub` starts from the hub's
 * defaults; `FAIR_USE_*` set or override single limits (a number, or `unlimited`). Nothing set →
 * undefined → unlimited (self-hosted servers).
 */
export function fairUseFromVars(vars: Record<string, string | undefined>): FairUse | undefined {
  const base: FairUse = vars.FAIR_USE === "hub" ? { ...HUB_FAIR_USE } : {};
  let any = vars.FAIR_USE === "hub";
  for (const [key, name] of Object.entries(FAIR_USE_VARS) as [keyof FairUse, string][]) {
    const raw = vars[name]?.trim();
    if (!raw) continue;
    any = true;
    if (raw === "unlimited") delete base[key];
    else if (/^\d+$/.test(raw)) base[key] = Number(raw);
  }
  return any ? base : undefined;
}

/** Hub-only details shown to everyone (funding transparency and the Sponsor link). */
export interface HubInfo {
  funding?: FundingConfig;
  /** GitHub Sponsors (or other) link; the Sponsor button is hidden while unset. */
  sponsorUrl?: string;
}

/** `FUNDING_BALANCE_USD`, `BASE_COST_USD_PER_MONTH`, `COST_PER_ACTIVE_USER_USD_PER_MONTH`, `SPONSOR_URL`. */
export function hubInfoFromVars(vars: Record<string, string | undefined>): HubInfo | undefined {
  const num = (name: string) => {
    const v = Number(vars[name]);
    return vars[name] !== undefined && vars[name] !== "" && Number.isFinite(v) ? v : undefined;
  };
  const balance = num("FUNDING_BALANCE_USD");
  const sponsor = vars.SPONSOR_URL?.trim();
  const info: HubInfo = {};
  if (balance !== undefined) {
    info.funding = {
      balanceUsd: balance,
      baseCostUsdPerMonth: num("BASE_COST_USD_PER_MONTH") ?? 5,
      costPerActiveUserUsdPerMonth: num("COST_PER_ACTIVE_USER_USD_PER_MONTH") ?? 0.02,
    };
  }
  if (sponsor && /^https:\/\/\S+$/.test(sponsor)) info.sponsorUrl = sponsor;
  return info.funding || info.sponsorUrl ? info : undefined;
}
