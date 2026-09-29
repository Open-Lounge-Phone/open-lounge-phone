import type { DeviceState } from "@openloungephone/core";

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
  /** The phone's voicemail greeting, and whether MENU → Voicemail may change it. */
  greeting?: { kind: "default" | "name" | "custom"; canRecord: boolean };
  /** Whose phone this is and how it's used (the strip's trust line). */
  owner?: { mode: "kids" | "personal" | "lounge"; space: string; person?: string };
  /** A team/org space with extensions: MENU → 6 dials one. */
  extensions?: boolean;
}

export interface LedInput {
  deviceState: DeviceState;
  config?: DeviceConfig;
  /** Showing a pairing code. */
  pairing: boolean;
  connection: Connection;
  /** Number of speed-dial digit keys (protocol button indices 0..buttons-1). */
  buttons: number;
  /** The key of the current or most recent outbound call, if any. */
  activeKey?: number;
  /** Menu open: button indices of the digits that do something on the current screen. */
  menuSlots?: number[];
}

export interface LedState {
  /** Per digit key, by protocol button index. */
  keys: Led[];
  /** MENU and BACK keys (they always light the same way). */
  fn: Led;
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
    const pulse: Led = { color: "blue", mode: "pulse" };
    return { keys: Array.from({ length: buttons }, () => pulse), fn: pulse, status };
  }

  const online = connection === "online";
  if (input.menuSlots) {
    // Menu: light exactly the digits that mean something on this screen.
    const lit = new Set(input.menuSlots);
    return {
      keys: Array.from({ length: buttons }, (_, i) =>
        lit.has(i) ? { color: "white", mode: "on" } : OFF,
      ),
      fn: { color: "white", mode: "on" },
      status,
    };
  }
  const fn: Led = online ? { color: "white", mode: "dim" } : OFF;

  const keys: Led[] = Array.from({ length: buttons }, (_, i) =>
    mapped.has(i) && online ? { color: "white", mode: "dim" } : OFF,
  );
  const set = (i: number | undefined, led: Led) => {
    if (i !== undefined && i >= 0 && i < buttons) keys[i] = led;
  };

  switch (s.kind) {
    case "dialing":
      set(s.button, { color: "green", mode: "on" });
      break;
    case "incall":
      // Held by the other side: the key breathes amber until they're back.
      set(
        activeKey,
        s.heldByThem ? { color: "amber", mode: "breathe" } : { color: "green", mode: "on" },
      );
      break;
    case "inroom":
      set(activeKey, { color: "green", mode: "on" });
      break;
    case "voicemail":
      // Leaving a message: the called key glows red, like a recording light.
      set(activeKey, { color: "red", mode: "on" });
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
  return { keys, fn, status };
}

/** True when `next` lists a caller with unheard voicemail that `prev` did not. */
export function hasNewMissed(prev: DeviceConfig | undefined, next: DeviceConfig): boolean {
  const before = new Set(prev?.missed?.map((m) => m.from) ?? []);
  return (next.missed ?? []).some((m) => !before.has(m.from));
}
