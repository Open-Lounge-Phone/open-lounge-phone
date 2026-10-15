/**
 * A call's connection health, from its RTCPeerConnection: reconnecting instead of silence when the
 * network drops (the party that offered restarts ICE), lost when it can't recover in time, and a
 * "poor connection" note from packet loss and jitter. Pure: `CallMedia` feeds in what it sees.
 */

export type LinkState = "connecting" | "connected" | "reconnecting" | "lost";

/** A short drop often recovers by itself: wait this long before restarting ICE. */
export const RESTART_AFTER_MS = 2000;
/** Restart again if the last restart hasn't worked after this long. */
export const RESTART_EVERY_MS = 6000;
/** Give up (the call ends: "the connection was lost") after reconnecting this long. */
export const GIVE_UP_MS = 20_000;

export interface Link {
  state: LinkState;
  /** Reconnecting since. */
  since?: number;
  lastRestart?: number;
}

export const NEW_LINK: Link = { state: "connecting" };

export type LinkEvent =
  | { type: "pc"; state: RTCPeerConnectionState | RTCIceConnectionState }
  | { type: "tick" };

/**
 * One step. `restart`: the offerer should restart ICE now (a new offer with `iceRestart`).
 * Before the first connection a failure is final (the server's connect timeout is the other
 * guard); a closed connection is final too.
 */
export function linkStep(
  link: Link,
  e: LinkEvent,
  now: number,
  offerer: boolean,
): { link: Link; restart: boolean } {
  if (link.state === "lost") return { link, restart: false };
  if (e.type === "pc") {
    switch (e.state) {
      case "connected":
      case "completed":
        return { link: { state: "connected" }, restart: false };
      case "closed":
        return { link: { state: "lost" }, restart: false };
      case "disconnected":
      case "failed": {
        if (link.state === "connecting") {
          return e.state === "failed"
            ? { link: { state: "lost" }, restart: false }
            : { link, restart: false };
        }
        const since = link.since ?? now;
        const next: Link = { ...link, state: "reconnecting", since };
        // Failed means ICE gave up: restart at once (the offerer). Disconnected may come back.
        if (e.state === "failed" && offerer && link.lastRestart === undefined) {
          return { link: { ...next, lastRestart: now }, restart: true };
        }
        return { link: next, restart: false };
      }
      default:
        return { link, restart: false };
    }
  }
  // tick
  if (link.state !== "reconnecting" || link.since === undefined) return { link, restart: false };
  if (now - link.since >= GIVE_UP_MS) return { link: { state: "lost" }, restart: false };
  const due =
    link.lastRestart === undefined
      ? now - link.since >= RESTART_AFTER_MS
      : now - link.lastRestart >= RESTART_EVERY_MS;
  if (offerer && due) return { link: { ...link, lastRestart: now }, restart: true };
  return { link, restart: false };
}

/** One reading of the incoming audio's statistics (`inbound-rtp`, kind audio). */
export interface RtpSample {
  at: number;
  packetsReceived: number;
  packetsLost: number;
  /** Seconds. */
  jitter: number;
}

/** The window loss and jitter are judged over. */
export const QUALITY_WINDOW_MS = 10_000;
/** Too few packets (the other side is silent: Opus DTX sends almost nothing) to judge loss. */
export const QUALITY_MIN_PACKETS = 50;
/** Poor above 5 % loss or 60 ms jitter; good again below 2 % and 30 ms. */
export const POOR_LOSS = 0.05;
export const POOR_JITTER_S = 0.06;
export const GOOD_LOSS = 0.02;
export const GOOD_JITTER_S = 0.03;

export interface Quality {
  samples: RtpSample[];
  poor: boolean;
}

export const NEW_QUALITY: Quality = { samples: [], poor: false };

/** Adds a reading; `poor` changes only with enough evidence, with some hysteresis. */
export function qualityStep(q: Quality, sample: RtpSample): Quality {
  const samples = [...q.samples, sample].filter((s) => sample.at - s.at <= QUALITY_WINDOW_MS);
  const first = samples[0] as RtpSample;
  const received = sample.packetsReceived - first.packetsReceived;
  const lost = Math.max(0, sample.packetsLost - first.packetsLost);
  const total = received + lost;
  const loss = total >= QUALITY_MIN_PACKETS ? lost / total : undefined;
  let poor = q.poor;
  if (!q.poor && ((loss !== undefined && loss > POOR_LOSS) || sample.jitter > POOR_JITTER_S)) {
    poor = true;
  } else if (q.poor && (loss === undefined || loss < GOOD_LOSS) && sample.jitter < GOOD_JITTER_S) {
    poor = false;
  }
  return { samples, poor };
}

/** The incoming audio's numbers from a `getStats()` report, if there are any. */
export function inboundAudio(report: RTCStatsReport, at: number): RtpSample | undefined {
  let out: RtpSample | undefined;
  report.forEach(
    (s: { type?: string; kind?: string; mediaType?: string } & Record<string, unknown>) => {
      if (s.type !== "inbound-rtp" || (s.kind ?? s.mediaType) !== "audio") return;
      out = {
        at,
        packetsReceived: Number(s.packetsReceived ?? 0),
        packetsLost: Number(s.packetsLost ?? 0),
        jitter: Number(s.jitter ?? 0),
      };
    },
  );
  return out;
}
