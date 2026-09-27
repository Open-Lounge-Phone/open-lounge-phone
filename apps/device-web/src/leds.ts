import type { DeviceState } from "@opentincan/core";

export type LedColor = "white" | "green" | "red" | "blue" | "amber" | "purple";
/** `breathe` is a slow, gentle pulse for notices that can wait (e.g. missed voicemail). */
export type LedMode = "off" | "dim" | "on" | "pulse" | "breathe" | "blink";

export interface Led {
  color: LedColor;
  mode: LedMode;
}

export type Connection = "connecting" | "online" | "offline";

export interface DeviceConfig {
  buttons: { index: number; label: string }[];
  quiet: boolean;
  /** Local "HH:MM" when current quiet hours end. */
  quietUntil?: string;
  /** Callers with unheard voicemail, newest first. */
  missed?: { from: string }[];
}

export interface LedInput {
  deviceState: DeviceState;
  config?: DeviceConfig;
  /** Showing a pairing code. */
  pairing: boolean;
  connection: Connection;
  /** Number of physical keys. */
  buttons: number;
  /** The key of the current or most recent outbound call, if any. */
  activeKey?: number;
}

export interface LedState {
  keys: Led[];
  status: Led;
}

const OFF: Led = { color: "white", mode: "off" };

/** Per-key and status LEDs for the current phone state. Pure, so firmware can mirror it. */
export function ledsFor(input: LedInput): LedState {
  const { deviceState: s, config, pairing, connection, buttons, activeKey } = input;
  const mapped = new Set(config?.buttons.map((b) => b.index) ?? []);

  let status: Led;
  if (pairing) status = { color: "blue", mode: "pulse" };
  else if (connection === "offline") status = { color: "red", mode: "on" };
  else if (connection === "connecting") status = { color: "amber", mode: "pulse" };
  else if (config?.quiet) status = { color: "purple", mode: "on" };
  else status = { color: "green", mode: "on" };

  if (pairing) {
    return {
      keys: Array.from({ length: buttons }, () => ({ color: "blue", mode: "pulse" })),
      status,
    };
  }

  const keys: Led[] = Array.from({ length: buttons }, (_, i) =>
    mapped.has(i) && connection === "online" ? { color: "white", mode: "dim" } : OFF,
  );
  const set = (i: number | undefined, led: Led) => {
    if (i !== undefined && i >= 0 && i < buttons) keys[i] = led;
  };

  switch (s.kind) {
    case "dialing":
      set(s.button, { color: "green", mode: "on" });
      break;
    case "incall":
      set(activeKey, { color: "green", mode: "on" });
      break;
    case "incoming": {
      const match = config?.buttons.find((b) => b.label === s.from);
      if (match) set(match.index, { color: "green", mode: "pulse" });
      else for (let i = 0; i < buttons; i++) keys[i] = { color: "green", mode: "pulse" };
      break;
    }
    case "offhook":
      if (s.lastEnd !== undefined && s.lastEnd !== "hangup") {
        if (activeKey !== undefined) set(activeKey, { color: "red", mode: "blink" });
        else for (let i = 0; i < buttons; i++) keys[i] = { color: "red", mode: "blink" };
      }
      break;
    case "idle": {
      // Missed voicemail: breathe the newest caller's key, or the status LED if unmapped.
      const newest = config?.missed?.[0]?.from;
      if (!newest || connection !== "online") break;
      const match = config?.buttons.find((b) => b.label === newest);
      if (match && match.index < buttons) set(match.index, { color: "amber", mode: "breathe" });
      else status = { ...status, mode: "breathe" };
      break;
    }
    default:
      break;
  }
  return { keys, status };
}

/** True when `next` lists a caller with unheard voicemail that `prev` did not. */
export function hasNewMissed(prev: DeviceConfig | undefined, next: DeviceConfig): boolean {
  const before = new Set(prev?.missed?.map((m) => m.from) ?? []);
  return (next.missed ?? []).some((m) => !before.has(m.from));
}
