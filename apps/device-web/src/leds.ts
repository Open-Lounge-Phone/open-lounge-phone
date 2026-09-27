import type { DeviceState } from "@opentincan/core";

export type LedColor = "white" | "green" | "red" | "blue" | "amber" | "purple";
export type LedMode = "off" | "dim" | "on" | "pulse" | "blink";

export interface Led {
  color: LedColor;
  mode: LedMode;
}

export type Connection = "connecting" | "online" | "offline";

export interface DeviceConfig {
  buttons: { index: number; label: string }[];
  quiet: boolean;
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
    default:
      break;
  }
  return { keys, status };
}
