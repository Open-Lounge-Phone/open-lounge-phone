import type { DeviceState } from "@openloungephone/core";
import type { EndReason } from "@openloungephone/protocol";
import type { Connection, DeviceConfig } from "./leds.ts";

/** Characters per line. Fits both a narrow e-ink stripe and a 16-character segment display. */
export const STATUS_WIDTH = 16;

export interface StatusInput {
  connection: Connection;
  /** Pairing code while the device is unpaired. */
  pairingCode?: string;
  deviceState: DeviceState;
  config?: DeviceConfig;
  /** Label of the other party on the current or last call. */
  activeLabel?: string;
  battery?: { pct: number; charging: boolean };
  /** Lounge on a weak USB source runs with reduced features and asks for a better charger. */
  power?: { reduced: boolean };
  /** When the current call connected (epoch ms), for the call timer. */
  callStartedAt?: number;
  now: number;
}

/**
 * Status text for the phone's small display: one or two uppercase lines of at most
 * STATUS_WIDTH characters, legible on e-ink or 14-segment LEDs alike. Pure, so firmware can
 * mirror it.
 */
export type StatusLines = [string] | [string, string];

const END_TEXT: Partial<Record<EndReason, string>> = {
  denied: "NOT ALLOWED",
  voicemail: "NOT ALLOWED",
  busy: "BUSY",
  timeout: "NO ANSWER",
  unreachable: "UNAVAILABLE",
  declined: "DECLINED",
  error: "CALL FAILED",
};

const clip = (s: string) => s.toUpperCase().slice(0, STATUS_WIDTH);

/** "CALLING MOM" on one line when it fits, otherwise "CALLING" / "GRANDMA JOSEPHINE". */
function withName(prefix: string, name: string, suffix = ""): StatusLines {
  const one = `${prefix}${prefix && name ? " " : ""}${name}${suffix && name ? " " : ""}${suffix}`;
  if (one.length <= STATUS_WIDTH) return [clip(one)];
  return prefix ? [clip(prefix), clip(name)] : [clip(name), clip(suffix)];
}

function clock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const mm = Math.floor(total / 60);
  const ss = String(total % 60).padStart(2, "0");
  return mm >= 100
    ? `${Math.floor(mm / 60)}H${String(mm % 60).padStart(2, "0")}`
    : `${String(mm).padStart(2, "0")}:${ss}`;
}

export function statusLines(input: StatusInput): StatusLines {
  const { connection, pairingCode, deviceState: s, config, activeLabel, battery } = input;
  const name = (activeLabel ?? "").trim();

  if (pairingCode)
    return [`PAIR ${pairingCode.slice(0, 3)} ${pairingCode.slice(3)}`, "LIFT TO HEAR"];
  if (connection === "offline") return ["OFFLINE", "RECONNECTING"];
  if (connection === "connecting") return ["CONNECTING"];

  switch (s.kind) {
    case "dialing":
      return withName("CALLING", name);
    case "incoming": {
      const who = withName("", s.from.trim(), "CALLING");
      return who.length === 1 ? [who[0], "LIFT TO ANSWER"] : who;
    }
    case "incall":
      if (!s.connected || input.callStartedAt === undefined) {
        return name ? ["CONNECTING", clip(name)] : ["CONNECTING"];
      }
      return name
        ? [`IN CALL ${clock(input.now - input.callStartedAt)}`, clip(name)]
        : [`IN CALL ${clock(input.now - input.callStartedAt)}`];
    case "offhook": {
      const text = s.lastEnd ? END_TEXT[s.lastEnd] : undefined;
      return text ? [text, "PRESS A KEY"] : ["PRESS A KEY"];
    }
    default:
      break;
  }

  const low = battery && !battery.charging && battery.pct < 20;
  const lowLine = low ? `LOW BATTERY ${battery.pct}%` : undefined;
  const quiet = config?.quiet
    ? config.quietUntil
      ? `QUIET TIL ${config.quietUntil}`
      : "QUIET HOURS"
    : undefined;
  const missed = (config?.missed ?? []).map((m) => m.from.trim()).filter(Boolean);

  if (missed.length > 0) {
    const [newest] = missed as [string];
    const single = `MISSED ${newest}`;
    const summary =
      missed.length === 1
        ? single.length <= STATUS_WIDTH
          ? single
          : "MISSED CALL"
        : `${missed.length} MISSED CALLS`;
    if (quiet) return [quiet, clip(summary)];
    if (missed.length === 1) {
      const lines: StatusLines =
        single.length <= STATUS_WIDTH
          ? [clip(single), "ASK A GROWN-UP"]
          : ["MISSED CALL", clip(newest)];
      return lowLine && lines[1] === "ASK A GROWN-UP" ? [lines[0], lowLine] : lines;
    }
    // Several callers: cycle their names on the second line every few seconds.
    const who = missed[Math.floor(input.now / MISSED_CYCLE_MS) % missed.length] as string;
    return [clip(summary), clip(who)];
  }

  const first = quiet ?? (battery ? `READY ${battery.pct}%` : "READY");
  if (input.power?.reduced) return [first, WEAK_CHARGER];
  return lowLine ? [first, lowLine] : [first];
}

/** Shown on a Default (≤500 mA) USB source when the phone needs more (Lounge). */
export const WEAK_CHARGER = "USE 1.5A CHARGER";

/** How long each missed caller's name stays on screen when several are cycling. */
export const MISSED_CYCLE_MS = 3000;
