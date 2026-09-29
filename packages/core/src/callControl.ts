// Hold, consult, merge and transfer: which of these one party may do, given their calls. Pure;
// the hub asks before acting, and phones mirror it in `deviceStep`.
import type { CallPrompt } from "@openloungephone/protocol";
import type { RoomPhase } from "./callRoom.ts";

/** One of a party's calls, from that party's point of view. */
export interface PartyCall {
  callId: string;
  phase: RoomPhase;
  /** `me`: this party put it on hold; `other`: the other side did. */
  heldBy?: "me" | "other";
}

export type ControlAction =
  | { type: "dial" }
  | { type: "hold"; callId: string; hold: boolean }
  | { type: "merge"; held: string; active: string }
  | { type: "transfer"; callId: string }
  | { type: "transfer-attended"; held: string; active: string };

export type ControlDecision = { ok: true } | { ok: false; error: string };

const no = (error: string): ControlDecision => ({ ok: false, error });
const yes: ControlDecision = { ok: true };

/**
 * - **dial**: with no call, or while your one other call is on hold by you (a consult call);
 *   never a third call.
 * - **hold**: an answered call; one call on hold at a time; you can't hold a call the other side
 *   is holding. **resume** (hold false): your held call, once the consult call has ended.
 * - **merge** / **transfer-attended**: your held call plus the answered call you're in now.
 * - **transfer** (blind): an answered call.
 */
export function controlCheck(calls: readonly PartyCall[], action: ControlAction): ControlDecision {
  const byId = new Map(calls.map((c) => [c.callId, c]));
  const answered = (c: PartyCall | undefined): c is PartyCall =>
    !!c && (c.phase === "connecting" || c.phase === "active");
  switch (action.type) {
    case "dial": {
      if (calls.length === 0) return yes;
      if (calls.length === 1 && calls[0]?.heldBy === "me") return yes;
      return no(calls.length > 1 ? "two calls at once is the limit" : "you're in a call");
    }
    case "hold": {
      const call = byId.get(action.callId);
      if (!answered(call)) return no("no such answered call");
      if (action.hold) {
        if (call.heldBy === "me") return yes;
        if (call.heldBy === "other") return no("they have you on hold");
        if (calls.some((c) => c !== call && c.heldBy === "me")) {
          return no("you already have a call on hold");
        }
        if (calls.some((c) => c !== call)) return no("finish your other call first");
        return yes;
      }
      if (call.heldBy !== "me") return call.heldBy === undefined ? yes : no("not yours to resume");
      if (calls.some((c) => c !== call)) return no("end or merge the other call first");
      return yes;
    }
    case "merge":
    case "transfer-attended": {
      if (action.held === action.active) return no("two different calls are needed");
      const held = byId.get(action.held);
      const active = byId.get(action.active);
      if (!answered(held) || held.heldBy !== "me") return no("put the first call on hold first");
      if (!answered(active) || active.heldBy !== undefined) return no("the second call isn't live");
      return yes;
    }
    case "transfer": {
      const call = byId.get(action.callId);
      if (!answered(call)) return no("no such answered call");
      if (call.heldBy === "other") return no("they have you on hold");
      return yes;
    }
  }
}

/** What the call and room prompts say (the browser phone speaks them; hardware plays the ids). */
export const CALL_PROMPT_TEXT: Record<CallPrompt, string> = {
  "hold.tone": "",
  "call.on_hold": "You're on hold.",
  "call.add": "Choose who to add, then press menu to merge.",
  "call.merged": "You're all together now.",
  "call.transfer": "Choose who to transfer to.",
  "call.transferred": "Call transferred.",
  "room.joined": "You're in the room.",
  "room.left": "You left the room.",
  "room.idle": "Still there? Press any key to stay.",
  "room.removed": "The host removed you from the room.",
  "room.locked": "That room is locked.",
  "room.full": "That room is full.",
  "room.muted": "Muted.",
  "room.unmuted": "Unmuted.",
};
