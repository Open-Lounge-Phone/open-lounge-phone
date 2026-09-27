import { z } from "zod";

/** Wire protocol version. Bumped only for breaking changes; additive fields keep the version. */
export const PROTOCOL_VERSION = 1;

/**
 * Upper bound for a single encoded message. Sized so an SDP offer fits comfortably while
 * keeping the receive buffer small enough for a microcontroller.
 */
export const MAX_MESSAGE_BYTES = 16 * 1024;

/** Opaque identifier: short, URL-safe, printable on an e-ink panel if needed. */
export const Id = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9_-]+$/, "must be URL-safe");

/** base64url without padding. */
export const Base64Url = z.string().regex(/^[A-Za-z0-9_-]*$/, "must be base64url without padding");

/** Unix epoch milliseconds. */
export const EpochMs = z.number().int().nonnegative();

export const CallState = z
  .enum(["requesting", "ringing", "connecting", "active", "ended"])
  .describe("Lifecycle of a call as seen by one participant.");
export type CallState = z.infer<typeof CallState>;

export const EndReason = z
  .enum(["hangup", "declined", "busy", "denied", "voicemail", "timeout", "unreachable", "error"])
  .describe("Why a call ended. `denied` = blocked by allow-list or quiet hours.");
export type EndReason = z.infer<typeof EndReason>;

export const ErrorCode = z.enum([
  "bad_message",
  "unsupported_version",
  "unauthorized",
  "not_found",
  "rate_limited",
  "internal",
]);
export type ErrorCode = z.infer<typeof ErrorCode>;

export const IceServer = z.object({
  urls: z.union([z.string(), z.array(z.string()).min(1)]),
  username: z.string().optional(),
  credential: z.string().optional(),
});
export type IceServer = z.infer<typeof IceServer>;
