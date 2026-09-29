// The fair-use allowance (public hubs only; unlimited elsewhere). Checked when something starts
// (a call, a voicemail, a knock) — a call in progress is never cut off — and metered when it's
// done, per account per calendar month.
import { monthEnds, type Usage } from "@openloungephone/db";
import type { ServerEnv } from "./env.ts";

export type Metered = "call" | "voicemail" | "knock" | "room" | "recording";

/** "Oct 1": when this month's allowance resets. */
export function resetsOn(now: number): string {
  return new Date(monthEnds(now)).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

/**
 * Why `accountId` can't start another `kind` this month, in words for the person; undefined when
 * it can (no allowance on this server, an exempt account, or within the allowance).
 */
export async function fairUseProblem(
  env: ServerEnv,
  accountId: string | undefined,
  kind: Metered,
  extra: { bytes?: number } = {},
): Promise<string | undefined> {
  const limits = env.fairUse;
  if (!limits || !accountId) return undefined;
  const account = await env.store.getAccount(accountId);
  if (!account || account.fairUseExempt) return undefined;
  const now = env.now();
  const used: Usage = await env.store.usage(accountId, now);
  const until = `It resets on ${resetsOn(now)}.`;
  if (kind === "call" && limits.callMinutesPerMonth !== undefined) {
    if (used.callMinutes >= limits.callMinutesPerMonth) {
      return `You've used this month's ${limits.callMinutesPerMonth} call minutes (fair use). ${until}`;
    }
  }
  if (kind === "voicemail") {
    if (limits.voicemailsPerMonth !== undefined && used.voicemails >= limits.voicemailsPerMonth) {
      return `You've left this month's ${limits.voicemailsPerMonth} voicemails (fair use). ${until}`;
    }
    const cap = limits.voicemailMbPerMonth;
    if (cap !== undefined && used.voicemailBytes + (extra.bytes ?? 0) > cap * 1_000_000) {
      return `That's over this month's ${cap} MB of voicemail (fair use). ${until}`;
    }
  }
  if (kind === "recording") {
    // Recordings share the voicemail storage allowance (not the count of messages).
    const cap = limits.voicemailMbPerMonth;
    if (cap !== undefined && used.voicemailBytes + (extra.bytes ?? 0) > cap * 1_000_000) {
      return `That's over this month's ${cap} MB of voicemail and recordings (fair use). ${until}`;
    }
  }
  if (kind === "room" && limits.roomMinutesPerMonth !== undefined) {
    if (used.roomMinutes >= limits.roomMinutesPerMonth) {
      return `You've used this month's ${limits.roomMinutesPerMonth} room minutes (fair use). ${until}`;
    }
  }
  if (kind === "knock" && limits.knocksPerMonth !== undefined) {
    if (used.knocks >= limits.knocksPerMonth) {
      return `You've knocked ${limits.knocksPerMonth} times this month (fair use). ${until}`;
    }
  }
  return undefined;
}

/** Whether a count-type cap (phones per space, spaces per account) is reached. */
export async function capReached(
  env: ServerEnv,
  accountId: string | undefined,
  cap: "phonesPerSpace" | "spacesPerAccount",
  current: number,
): Promise<number | undefined> {
  const limit = env.fairUse?.[cap];
  if (limit === undefined || current < limit) return undefined;
  const account = accountId ? await env.store.getAccount(accountId) : undefined;
  return account?.fairUseExempt ? undefined : limit;
}
