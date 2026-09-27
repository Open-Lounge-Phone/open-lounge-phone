import type { Tone } from "@opentincan/client";
import type { EndReason, ServerToApp } from "@opentincan/protocol";

/** What the call UI shows. At most one call at a time. */
export type CallView =
  | { phase: "idle" }
  | { phase: "outgoing"; callId?: string; label: string; ringing: boolean; deviceId?: string }
  | { phase: "incoming"; callId: string; label: string }
  | {
      phase: "connecting" | "active";
      callId: string;
      label: string;
      offerer: boolean;
      startedAt?: number;
    }
  | {
      phase: "ended";
      label: string;
      reason: EndReason | undefined;
      /** The phone this app dialled, so a voicemail can be left for it. */
      deviceId?: string;
    };

export type CallEvent =
  | { type: "dial"; label: string; deviceId?: string }
  | { type: "answer" }
  | { type: "hangup" }
  | { type: "dismiss" }
  | {
      type: "server";
      msg: Extract<ServerToApp, { t: "call.ringing" | "call.state" }>;
      now: number;
    };

export interface CallStep {
  view: CallView;
  /** A second incoming call while busy should be declined with this callId. */
  decline?: string;
}

const callIdOf = (v: CallView): string | undefined =>
  v.phase === "outgoing" ||
  v.phase === "incoming" ||
  v.phase === "connecting" ||
  v.phase === "active"
    ? v.callId
    : undefined;

export function callStep(view: CallView, e: CallEvent): CallStep {
  switch (e.type) {
    case "dial":
      if (view.phase !== "idle" && view.phase !== "ended") return { view };
      return {
        view: {
          phase: "outgoing",
          label: e.label,
          ringing: false,
          ...(e.deviceId ? { deviceId: e.deviceId } : {}),
        },
      };
    case "answer":
      if (view.phase !== "incoming") return { view };
      return {
        view: { phase: "connecting", callId: view.callId, label: view.label, offerer: false },
      };
    case "hangup":
      if (view.phase === "idle" || view.phase === "ended") return { view };
      return { view: { phase: "ended", label: labelOf(view), reason: "hangup" } };
    case "dismiss":
      return view.phase === "ended" ? { view: { phase: "idle" } } : { view };
    case "server":
      break;
  }

  const msg = e.msg;
  if (msg.t === "call.ringing") {
    if (view.phase === "idle" || view.phase === "ended") {
      return { view: { phase: "incoming", callId: msg.callId, label: msg.from.label } };
    }
    if (callIdOf(view) === msg.callId) return { view };
    return { view, decline: msg.callId };
  }

  // call.state
  const current = callIdOf(view);
  if (view.phase === "outgoing" && current === undefined) {
    // First state after call.dial carries the new call's id.
    return stateFor({ ...view, callId: msg.callId }, msg, e.now, true);
  }
  if (current !== msg.callId) return { view };
  return stateFor(view, msg, e.now, view.phase === "outgoing");
}

function labelOf(v: CallView): string {
  return v.phase === "idle" ? "" : v.label;
}

function stateFor(
  view: CallView,
  msg: Extract<ServerToApp, { t: "call.state" }>,
  now: number,
  offerer: boolean,
): CallStep {
  const callId = msg.callId;
  const label = labelOf(view);
  switch (msg.state) {
    case "ended":
      // An incoming call answered on another of our sessions just disappears.
      if (view.phase === "incoming") return { view: { phase: "idle" } };
      return {
        view: {
          phase: "ended",
          label,
          reason: msg.reason,
          ...(view.phase === "outgoing" && view.deviceId ? { deviceId: view.deviceId } : {}),
        },
      };
    case "requesting":
    case "ringing":
      if (view.phase === "outgoing") return { view: { ...view, callId, ringing: true } };
      return { view };
    case "connecting":
      if (view.phase === "connecting" || view.phase === "active") return { view };
      return { view: { phase: "connecting", callId, label, offerer } };
    case "active":
      if (view.phase === "active") return { view };
      return {
        view: {
          phase: "active",
          callId,
          label,
          offerer: view.phase === "connecting" ? view.offerer : offerer,
          startedAt: now,
        },
      };
  }
}

export function toneFor(view: CallView): Tone {
  if (view.phase === "incoming") return "ring";
  if (view.phase === "outgoing" && view.ringing) return "ringback";
  return "none";
}

/** A refused call to a phone in quiet hours can be followed by a recorded message. */
export function canLeaveVoicemail(view: CallView): view is Extract<CallView, { phase: "ended" }> & {
  deviceId: string;
} {
  return view.phase === "ended" && view.reason === "voicemail" && !!view.deviceId;
}
