import type {
  DeviceToServer,
  EndReason,
  RoomEndReason,
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
  /** Handset up, waiting for a key. `held`: a call this phone put on hold (MENU → Add caller). */
  | { kind: "offhook"; lastEnd?: EndReason; held?: string }
  | { kind: "dialing"; button: number; callId?: string; held?: string } // not yet answered
  | { kind: "incoming"; callId: string; from: string } // ringing, handset down
  | {
      kind: "incall";
      callId: string;
      connected: boolean;
      /** A consult call: the first call is on hold meanwhile (MENU → Merge / Transfer). */
      held?: string;
      /** The other side put this call on hold: play the soft hold tone. */
      heldByThem?: boolean;
      /** MENU → Transfer: the next key transfers the call to that key's person (blind). */
      transferPending?: boolean;
    }
  /**
   * In a room (a party line, a phone room, or a 3-way call after Merge). `roomId` is unknown
   * while joining; any key tells the room you're still here.
   */
  | { kind: "inroom"; roomId?: string; muted: boolean }
  /**
   * Our call wasn't answered and the server offered voicemail: play the greeting and the tone,
   * record, and send the message when the handset goes down (the shell does the audio and the
   * upload; hanging up here only returns to idle).
   */
  | { kind: "voicemail"; offer: VoicemailOffer };

/** MENU items during a call or in a room (the shell's menu turns them into these). */
export type CallAction = "hold" | "resume" | "merge" | "transfer" | "mute" | "unmute";

export type DeviceInput =
  | { type: "hook"; state: "up" | "down" }
  | { type: "button"; index: number }
  | { type: "action"; action: CallAction }
  /** MENU → Dial extension (team/org spaces): the handset is up and the digits are in. */
  | { type: "extension"; number: string }
  | {
      type: "server";
      msg: Extract<
        ServerToDevice,
        { t: "call.ringing" | "call.state" | "room.state" | "room.ended" }
      >;
    };

export interface DeviceStep {
  state: DeviceState;
  send: DeviceToServer[];
}

/** What the speaker/ringer should be doing in a given state. `hold` = the soft on-hold tone. */
export type Sound = "none" | "dialtone" | "ringback" | "ring" | "busy" | "hold";

export const initialDeviceState: DeviceState = { kind: "idle" };

const stay = (state: DeviceState, ...send: DeviceToServer[]): DeviceStep => ({ state, send });

/** How a room ending sounds on the handset (busy tone for anything but a normal leave). */
export function roomEndToCall(reason: RoomEndReason): EndReason {
  switch (reason) {
    case "left":
    case "closed":
    case "idle":
    case "removed":
      return "hangup";
    case "busy":
      return "busy";
    case "unreachable":
      return "unreachable";
    case "error":
      return "error";
    default:
      return "denied";
  }
}

/** Which actions the MENU offers in this state. */
export function callActions(s: DeviceState): CallAction[] {
  if (s.kind === "incall" && s.connected) {
    if (s.held) return ["merge", "transfer"];
    return s.heldByThem ? [] : ["hold", "transfer"];
  }
  if (s.kind === "offhook" && s.held) return ["resume"];
  if (s.kind === "inroom" && s.roomId) return [s.muted ? "unmute" : "mute"];
  return [];
}

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
    // Hook down always returns to idle, hanging up whatever is in progress (a held call too).
    const hangups: DeviceToServer[] = [];
    if ((s.kind === "dialing" || s.kind === "incall") && s.callId) {
      hangups.push({ t: "call.hangup", callId: s.callId });
    }
    if ((s.kind === "dialing" || s.kind === "incall" || s.kind === "offhook") && s.held) {
      hangups.push({ t: "call.hangup", callId: s.held });
    }
    if (s.kind === "inroom" && s.roomId) hangups.push({ t: "room.leave", roomId: s.roomId });
    if (s.kind === "incoming") return stay(s); // already down
    return stay({ kind: "idle" }, ...hangups, hook);
  }

  if (input.type === "button") {
    if (s.kind === "offhook") {
      return stay(
        { kind: "dialing", button: input.index, ...(s.held ? { held: s.held } : {}) },
        { t: "button", index: input.index },
      );
    }
    if (s.kind === "incall" && s.transferPending) {
      const { transferPending: _t, ...rest } = s;
      return stay(rest, { t: "call.transfer", callId: s.callId, to: { button: input.index } });
    }
    // In a room any key says "still here" (the answer to the idle warning).
    if (s.kind === "inroom" && s.roomId) return stay(s, { t: "room.here", roomId: s.roomId });
    return stay(s); // keys only dial with the handset up and nothing else going on
  }

  if (input.type === "action") return action(s, input.action);
  if (input.type === "extension") {
    if (s.kind !== "offhook") return stay(s);
    return stay(
      { kind: "dialing", button: -1, ...(s.held ? { held: s.held } : {}) },
      { t: "call.extension", number: input.number },
    );
  }

  const msg = input.msg;
  if (msg.t === "room.state") {
    const you = msg.participants.find((p) => p.id === msg.you);
    const muted = you?.muted ?? false;
    if (s.kind === "inroom" && (s.roomId === undefined || s.roomId === msg.roomId)) {
      return stay({ kind: "inroom", roomId: msg.roomId, muted });
    }
    if (s.kind === "dialing" && s.callId === undefined && !s.held) {
      return stay({ kind: "inroom", roomId: msg.roomId, muted });
    }
    // Not expecting a room (e.g. the handset went down while joining): leave it.
    return stay(s, { t: "room.leave", roomId: msg.roomId });
  }
  if (msg.t === "room.ended") {
    const lastEnd = roomEndToCall(msg.reason);
    if (s.kind === "inroom" && (s.roomId === undefined || s.roomId === msg.roomId)) {
      return stay({ kind: "offhook", lastEnd });
    }
    if (s.kind === "dialing" && s.callId === undefined && msg.roomId === undefined) {
      return stay({ kind: "offhook", lastEnd });
    }
    return stay(s);
  }
  if (msg.t === "call.ringing") {
    if (s.kind === "idle")
      return stay({ kind: "incoming", callId: msg.callId, from: msg.from.label });
    // Busy: decline so the caller hears it immediately instead of waiting for a timeout.
    if ("callId" in s && s.callId === msg.callId) return stay(s);
    return stay(s, { t: "call.hangup", callId: msg.callId });
  }

  // call.state
  // The call on hold: it can only end (the other person hung up) while we're elsewhere.
  if ("held" in s && s.held === msg.callId) {
    if (msg.state !== "ended") return stay(s);
    const { held: _h, ...rest } = s;
    return stay(rest.kind === "offhook" ? { kind: "offhook", lastEnd: "hangup" } : rest);
  }
  switch (s.kind) {
    case "dialing": {
      if (s.callId !== undefined && s.callId !== msg.callId) return stay(s);
      const held = s.held ? { held: s.held } : {};
      if (msg.state === "ended" && msg.voicemail && !s.held) {
        return stay({ kind: "voicemail", offer: msg.voicemail });
      }
      if (msg.state === "ended") {
        return stay({ kind: "offhook", lastEnd: msg.reason ?? "hangup", ...held });
      }
      if (msg.state === "active")
        return stay({ kind: "incall", callId: msg.callId, connected: true, ...held });
      if (msg.state === "connecting") {
        return stay({ kind: "incall", callId: msg.callId, connected: false, ...held });
      }
      return stay({ ...s, callId: msg.callId });
    }
    case "incoming":
      if (msg.callId !== s.callId) return stay(s);
      return msg.state === "ended" ? stay({ kind: "idle" }) : stay(s);
    case "incall": {
      if (msg.callId !== s.callId) return stay(s);
      if (msg.state === "ended") {
        if (msg.merged) return stay({ kind: "inroom", roomId: msg.merged.roomId, muted: false });
        if (msg.transfer) {
          // Transferred: the call goes on as a new one (ringing its target, for a blind one).
          return stay(
            msg.transfer.ringing
              ? { kind: "dialing", button: -1, callId: msg.transfer.callId }
              : { kind: "incall", callId: msg.transfer.callId, connected: false },
          );
        }
        const held = s.held ? { held: s.held } : {};
        return stay({ kind: "offhook", lastEnd: msg.reason ?? "hangup", ...held });
      }
      if (msg.state === "active") {
        const { heldByThem: _h, ...rest } = s;
        return stay({
          ...rest,
          connected: true,
          ...(msg.hold === "them" ? { heldByThem: true } : {}),
        });
      }
      return stay(s);
    }
    default:
      return stay(s);
  }
}

function action(s: DeviceState, a: CallAction): DeviceStep {
  if (!callActions(s).includes(a)) return stay(s);
  switch (a) {
    case "hold":
      if (s.kind !== "incall") return stay(s);
      return stay(
        { kind: "offhook", held: s.callId },
        { t: "call.hold", callId: s.callId, hold: true },
      );
    case "resume":
      if (s.kind !== "offhook" || !s.held) return stay(s);
      return stay(
        { kind: "incall", callId: s.held, connected: true },
        { t: "call.hold", callId: s.held, hold: false },
      );
    case "merge":
      if (s.kind !== "incall" || !s.held) return stay(s);
      return stay(
        { kind: "inroom", muted: false },
        { t: "call.merge", callId: s.held, with: s.callId },
      );
    case "transfer":
      if (s.kind !== "incall") return stay(s);
      // With a consult call: connect the two others (attended). Otherwise: pick a key (blind).
      if (s.held) return stay(s, { t: "call.transfer", callId: s.held, toCall: s.callId });
      return stay({ ...s, transferPending: true });
    case "mute":
    case "unmute": {
      if (s.kind !== "inroom" || !s.roomId) return stay(s);
      const muted = a === "mute";
      return stay({ ...s, muted }, { t: "room.mute", roomId: s.roomId, muted });
    }
  }
}

export function soundFor(s: DeviceState): Sound {
  switch (s.kind) {
    case "idle":
    case "inroom":
    case "voicemail": // the greeting, the tone and the recording are the shell's
      return "none";
    case "incall":
      return s.heldByThem ? "hold" : "none";
    case "incoming":
      return "ring";
    case "dialing":
      return "ringback";
    case "offhook":
      return s.lastEnd === undefined || s.lastEnd === "hangup" ? "dialtone" : "busy";
  }
}
