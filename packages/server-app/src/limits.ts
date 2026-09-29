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
}

export const DEFAULT_LIMITS: Limits = {
  knocksPerDay: 10,
  inboxKnocksPerDay: 50,
  fedRequestsPerMinute: 300,
  fedKnocksPerDay: 500,
};

export const limitsOf = (env: ServerEnv): Limits => ({ ...DEFAULT_LIMITS, ...env.limits });
