import type { Tone } from "@openloungephone/client";
import type { EndReason, LineInfo, ServerToApp, VoicemailOffer } from "@openloungephone/protocol";

/** Waiting in a public line's queue (`call.state.queue`). */
export interface QueueView {
  position?: number;
  size?: number;
  /** "Leave a voicemail instead" is offered. */
  voicemail?: boolean;
}

/** What the call UI shows. At most one call at a time. */
export type CallView =
  | { phase: "idle" }
  | {
      phase: "outgoing";
      callId?: string;
      label: string;
      ringing: boolean;
      deviceId?: string;
      /** A grown-up, app-to-app call to another person (no voicemail). */
      person?: boolean;
      /** Dialled through a connection (another household or server): its id. */
      via?: string;
      /** Calling a public line: what it is. */
      line?: LineInfo;
      /** Waiting in the line's queue (nobody free yet). */
      queue?: QueueView;
    }
  | {
      phase: "incoming";
      callId: string;
      label: string;
      /** A public line's call: the caller's verified address, and which line. */
      address?: string;
      line?: string;
    }
  | {
      phase: "connecting" | "active";
      callId: string;
      label: string;
      offerer: boolean;
      startedAt?: number;
      /** `you` put it on hold; `them` = the other side is holding you (soft tone). */
      hold?: "you" | "them";
      /** The call is recorded (announced to everyone): by this space. Stays until it ends. */
      recording?: string;
    }
  | {
      phase: "ended";
      label: string;
      reason: EndReason | undefined;
      /** The phone this app dialled, so a voicemail can be left for it. */
      deviceId?: string;
      person?: boolean;
      via?: string;
      /** The server's own explanation, if it gave one (e.g. a fair-use allowance). */
      note?: string;
      /** Unanswered: a message may be left (greeting, tone, record, hang up to send). */
      voicemail?: VoicemailOffer;
    };

export type CallEvent =
  | { type: "dial"; label: string; deviceId?: string; person?: boolean; via?: string }
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
  /** The call became part of this room (3-way): keep its audio until the room's is up. */
  merged?: string;
  /** The call was transferred: it goes on as `view`'s new call; drop the old audio. */
  transferred?: string;
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
          ...(e.person ? { person: true } : {}),
          ...(e.via ? { via: e.via } : {}),
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
      return {
        view: {
          phase: "incoming",
          callId: msg.callId,
          label: msg.from.label,
          ...(msg.from.address ? { address: msg.from.address } : {}),
          ...(msg.line ? { line: msg.line.name } : {}),
        },
      };
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
      if (msg.merged) return { view: { phase: "idle" }, merged: msg.merged.roomId };
      if (msg.transfer) {
        const next = msg.transfer;
        return {
          transferred: callId,
          view: next.ringing
            ? { phase: "outgoing", callId: next.callId, label, ringing: true, person: true }
            : { phase: "connecting", callId: next.callId, label, offerer: next.offerer },
        };
      }
      return {
        view: {
          phase: "ended",
          label,
          reason: msg.reason,
          ...(view.phase === "outgoing" && view.deviceId ? { deviceId: view.deviceId } : {}),
          ...(view.phase === "outgoing" && view.person ? { person: true } : {}),
          ...(view.phase === "outgoing" && view.via ? { via: view.via } : {}),
          ...(msg.note ? { note: msg.note } : {}),
          ...(msg.voicemail && view.phase === "outgoing" ? { voicemail: msg.voicemail } : {}),
        },
      };
    case "requesting":
    case "ringing": {
      if (view.phase !== "outgoing") return { view };
      // A public line: its name, then the caller's place in its queue (none = ringing again).
      const { queue: _q, ...rest } = view;
      return {
        view: {
          ...rest,
          callId,
          ringing: true,
          ...(msg.line ? { line: msg.line, label: msg.line.name } : {}),
          ...(msg.queue ? { queue: msg.queue } : {}),
        },
      };
    }
    case "connecting":
      if (view.phase === "connecting" || view.phase === "active") return { view };
      return { view: { phase: "connecting", callId, label, offerer } };
    case "active": {
      const hold = msg.hold ? { hold: msg.hold } : {};
      const recording = msg.recording ? { recording: msg.recording.by } : {};
      if (view.phase === "active") {
        if (view.hold === msg.hold && (!msg.recording || view.recording)) return { view };
        const { hold: _h, ...rest } = view;
        return { view: { ...rest, ...hold, ...recording } };
      }
      return {
        view: {
          phase: "active",
          callId,
          label,
          offerer: view.phase === "connecting" ? view.offerer : offerer,
          startedAt: now,
          ...hold,
          ...recording,
        },
      };
    }
  }
}

export function toneFor(view: CallView): Tone {
  if (view.phase === "incoming") return "ring";
  if (view.phase === "active" && view.hold === "them") return "hold";
  // Waiting in a public line's queue: the soft waiting tone, not ringback.
  if (view.phase === "outgoing" && view.queue) return "hold";
  if (view.phase === "outgoing" && view.ringing) return "ringback";
  return "none";
}

/** An unanswered call the server offered voicemail for (to anyone: a person or a phone). */
export function canLeaveVoicemail(view: CallView): view is Extract<CallView, { phase: "ended" }> & {
  voicemail: VoicemailOffer;
} {
  return view.phase === "ended" && !!view.voicemail;
}
