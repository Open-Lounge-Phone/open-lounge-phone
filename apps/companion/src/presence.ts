import type { MemberLive } from "./connection.ts";

export interface Presence {
  dot: "on" | "away" | "off";
  label: string;
  callable: boolean;
}

/** How another member's presence is shown, and whether they can be called right now. */
export function presenceOf(m: MemberLive | undefined): Presence {
  if (!m?.online) return { dot: "off", label: "Offline", callable: false };
  const at = m.lounge
    ? ` · at ${m.lounge.label}${m.lounge.openToChat ? " · open to chat" : ""}`
    : "";
  if (!m.available) return { dot: "away", label: `Not taking calls${at}`, callable: false };
  return { dot: "on", label: `Available${at}`, callable: true };
}
