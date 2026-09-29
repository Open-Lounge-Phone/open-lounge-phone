import type { EndReason } from "@openloungephone/protocol";

/**
 * Server-side lifecycle of a two-party call. Pure: the backend persists the state and turns
 * transitions into protocol messages.
 */
export type RoomPhase = "ringing" | "connecting" | "active" | "ended";

export interface RoomState {
  phase: RoomPhase;
  caller: string;
  callee: string;
  reason?: EndReason;
}

export type RoomEvent =
  | { type: "answer"; by: string }
  | { type: "connected" }
  | { type: "hangup"; by: string }
  | { type: "timeout" }
  | { type: "fail" }
  /** The other server ended or refused the call, with its reason (federated calls). */
  | { type: "end"; reason: EndReason };

export type RoomTransition =
  | { ok: true; state: RoomState; changed: boolean }
  | { ok: false; error: string };

export function newRoom(caller: string, callee: string): RoomState {
  return { phase: "ringing", caller, callee };
}

const end = (s: RoomState, reason: EndReason): RoomTransition => ({
  ok: true,
  state: { ...s, phase: "ended", reason },
  changed: true,
});

export function roomStep(s: RoomState, e: RoomEvent): RoomTransition {
  // Ended rooms absorb everything so late or duplicate messages are harmless.
  if (s.phase === "ended") return { ok: true, state: s, changed: false };

  if ((e.type === "answer" || e.type === "hangup") && e.by !== s.caller && e.by !== s.callee) {
    return { ok: false, error: `${e.by} is not in this call` };
  }

  switch (e.type) {
    case "fail":
      return end(s, "error");
    case "end":
      return end(s, e.reason);
    case "hangup":
      if (s.phase === "ringing") return end(s, e.by === s.callee ? "declined" : "hangup");
      return end(s, "hangup");
    case "timeout":
      return end(s, s.phase === "ringing" ? "timeout" : "unreachable");
    case "answer":
      if (e.by !== s.callee) return { ok: false, error: "only the callee can answer" };
      if (s.phase !== "ringing") return { ok: true, state: s, changed: false };
      return { ok: true, state: { ...s, phase: "connecting" }, changed: true };
    case "connected":
      if (s.phase === "connecting") {
        return { ok: true, state: { ...s, phase: "active" }, changed: true };
      }
      if (s.phase === "active") return { ok: true, state: s, changed: false };
      return { ok: false, error: `cannot connect while ${s.phase}` };
  }
}
