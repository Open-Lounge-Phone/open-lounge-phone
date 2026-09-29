import type {
  DeviceToServer,
  EndReason,
  ServerToDevice,
  VoicemailOffer,
} from "@openloungephone/protocol";

/**
 * Handset behaviour shared by every Open Lounge Phone device. The web emulator runs this directly and
 * the ESP32 firmware mirrors it, so the phone feels identical everywhere.
 *
 * Only call-related server messages are inputs here; pairing, auth and config are handled by the
 * connection layer.
 */
export type DeviceState =
  | { kind: "idle" } // handset on the cradle
  | { kind: "offhook"; lastEnd?: EndReason } // handset up, waiting for a button
  | { kind: "dialing"; button: number; callId?: string } // outbound, not yet answered
  | { kind: "incoming"; callId: string; from: string } // ringing, handset down
  | { kind: "incall"; callId: string; connected: boolean }
  /**
   * Our call wasn't answered and the server offered voicemail: play the greeting and the tone,
   * record, and send the message when the handset goes down (the shell does the audio and the
   * upload; hanging up here only returns to idle).
   */
  | { kind: "voicemail"; offer: VoicemailOffer };

export type DeviceInput =
  | { type: "hook"; state: "up" | "down" }
  | { type: "button"; index: number }
  | { type: "server"; msg: Extract<ServerToDevice, { t: "call.ringing" | "call.state" }> };

export interface DeviceStep {
  state: DeviceState;
  send: DeviceToServer[];
}

/** What the speaker/ringer should be doing in a given state. */
export type Sound = "none" | "dialtone" | "ringback" | "ring" | "busy";

export const initialDeviceState: DeviceState = { kind: "idle" };

const stay = (state: DeviceState, ...send: DeviceToServer[]): DeviceStep => ({ state, send });

export function deviceStep(s: DeviceState, input: DeviceInput): DeviceStep {
  if (input.type === "hook") {
    const hook: DeviceToServer = { t: "hook", state: input.state };
    if (input.state === "up") {
      if (s.kind === "idle") return stay({ kind: "offhook" }, hook);
      if (s.kind === "incoming") {
        return stay({ kind: "incall", callId: s.callId, connected: false }, hook, {
          t: "call.answer",
          callId: s.callId,
        });
      }
      return stay(s); // already up
    }
    // Hook down always returns to idle, hanging up whatever call is in progress.
    if (s.kind === "dialing" && s.callId) {
      return stay({ kind: "idle" }, { t: "call.hangup", callId: s.callId }, hook);
    }
    if (s.kind === "incall") {
      return stay({ kind: "idle" }, { t: "call.hangup", callId: s.callId }, hook);
    }
    if (s.kind === "incoming") return stay(s); // already down
    return stay({ kind: "idle" }, hook);
  }

  if (input.type === "button") {
    // Buttons only dial with the handset up and nothing else going on.
    if (s.kind !== "offhook") return stay(s);
    return stay({ kind: "dialing", button: input.index }, { t: "button", index: input.index });
  }

  const msg = input.msg;
  if (msg.t === "call.ringing") {
    if (s.kind === "idle")
      return stay({ kind: "incoming", callId: msg.callId, from: msg.from.label });
    // Busy: decline so the caller hears it immediately instead of waiting for a timeout.
    if ("callId" in s && s.callId === msg.callId) return stay(s);
    return stay(s, { t: "call.hangup", callId: msg.callId });
  }

  // call.state
  switch (s.kind) {
    case "dialing":
      if (s.callId !== undefined && s.callId !== msg.callId) return stay(s);
      if (msg.state === "ended" && msg.voicemail) {
        return stay({ kind: "voicemail", offer: msg.voicemail });
      }
      if (msg.state === "ended") return stay({ kind: "offhook", lastEnd: msg.reason ?? "hangup" });
      if (msg.state === "active")
        return stay({ kind: "incall", callId: msg.callId, connected: true });
      if (msg.state === "connecting") {
        return stay({ kind: "incall", callId: msg.callId, connected: false });
      }
      return stay({ ...s, callId: msg.callId });
    case "incoming":
      if (msg.callId !== s.callId) return stay(s);
      return msg.state === "ended" ? stay({ kind: "idle" }) : stay(s);
    case "incall":
      if (msg.callId !== s.callId) return stay(s);
      if (msg.state === "ended") return stay({ kind: "offhook", lastEnd: msg.reason ?? "hangup" });
      if (msg.state === "active") return stay({ ...s, connected: true });
      return stay(s);
    default:
      return stay(s);
  }
}

export function soundFor(s: DeviceState): Sound {
  switch (s.kind) {
    case "idle":
    case "incall":
    case "voicemail": // the greeting, the tone and the recording are the shell's
      return "none";
    case "incoming":
      return "ring";
    case "dialing":
      return "ringback";
    case "offhook":
      return s.lastEnd === undefined || s.lastEnd === "hangup" ? "dialtone" : "busy";
  }
}
