// Words for rooms in the app. Honest about who could hear a room.
import type { RoomMediaKind } from "./api.ts";

/**
 * Who could hear a room. A peer-to-peer mesh is end-to-end encrypted; a relayed room is
 * encrypted in transit but the relay could hear it, until end-to-end room encryption (SFrame).
 */
export function roomPrivacyText(media: RoomMediaKind): string {
  if (media === "mesh") {
    return "Peer to peer: only the people in the room can hear it (end-to-end encrypted). Up to 4 people.";
  }
  return "Through this server's relay: encrypted in transit, but not end to end — the relay could hear it. End-to-end encryption for rooms (SFrame) is planned.";
}

/** "Mom, Dad and 2 others" / "Nobody's in". */
export function whoIsIn(people: readonly string[]): string {
  if (people.length === 0) return "Nobody's in";
  if (people.length === 1) return `${people[0]} is in`;
  if (people.length <= 3) {
    return `${people.slice(0, -1).join(", ")} and ${people.at(-1)} are in`;
  }
  return `${people.slice(0, 2).join(", ")} and ${people.length - 2} others are in`;
}

/** Seconds left before an idle drop, for the warning. */
export function idleSecondsLeft(dropAt: number, now: number): number {
  return Math.max(0, Math.ceil((dropAt - now) / 1000));
}

/** A room's kind in words. */
export function roomKindText(kind: "party" | "phone" | "call"): string {
  return kind === "party" ? "Party line" : kind === "phone" ? "Phone room" : "3-way call";
}
