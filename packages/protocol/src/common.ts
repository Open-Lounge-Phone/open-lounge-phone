import { z } from "zod";

/** Wire protocol version. Bumped only for breaking changes; additive fields keep the version. */
export const PROTOCOL_VERSION = 1;

/**
 * The oldest protocol version a server still accepts (phones and apps within
 * `MIN_PROTOCOL_VERSION..PROTOCOL_VERSION` are served; older ones are told to update). When
 * `PROTOCOL_VERSION` is bumped, this stays at the previous version for the support window.
 */
export const MIN_PROTOCOL_VERSION = 1;

/**
 * Optional capabilities a server offers phones and apps, listed in `config.server.features` and
 * `app.ready.server.features`. Clients hide what a server doesn't list and ignore names they don't
 * know.
 */
export const DEVICE_FEATURES = [
  "call-control",
  "rooms",
  "greetings",
  "extensions",
  "lounge",
  "recording",
] as const;
export type DeviceFeature = (typeof DEVICE_FEATURES)[number];

/** Lenient list of names: entries a client can't hold are skipped, never fatal. */
const Names = (max: number) =>
  z.preprocess(
    (v) =>
      Array.isArray(v) ? v.filter((x) => typeof x === "string" && x.length <= 32).slice(0, max) : v,
    z.array(z.string().max(32)).max(max),
  );

export const ServerInfo = z
  .object({
    software: z
      .string()
      .max(64)
      .describe("Implementation and version, e.g. `openloungephone/0.2.0`."),
    protocol: z
      .object({
        min: z.number().int().positive().describe("Oldest protocol version accepted."),
        max: z
          .number()
          .int()
          .positive()
          .describe("Newest protocol version spoken (`PROTOCOL_VERSION`)."),
      })
      .describe("The protocol versions the server accepts."),
    features: Names(32).describe(
      "Optional capabilities: `call-control` (hold, merge, transfer), `rooms`, `greetings` (`greeting.*`), `extensions` (`call.extension`), `lounge`, `recording` (recording notices). Unknown names are ignored.",
    ),
  })
  .describe("What the server speaks, so a client can adapt to an older or newer server.");
export type ServerInfo = z.infer<typeof ServerInfo>;

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
  .enum([
    "hangup",
    "declined",
    "busy",
    "denied",
    "voicemail",
    "timeout",
    "unreachable",
    "unavailable",
    "error",
  ])
  .describe(
    "Why a call ended. `denied` = blocked by allow-list or quiet hours; `unavailable` = the person isn't taking calls.",
  );
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
