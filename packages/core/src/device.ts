import type {
  DeviceToServer,
  EndReason,
  RoomEndReason,
  ServerToDevice,
  VoicemailOffer,
} from "@openloungephone/protocol";
import { CONNECTION_LOST_NOTE } from "./callControl.ts";
import { SIGN_IN_FOR_LINES_NOTE } from "./lines.ts";

/**
 * Handset behaviour shared by every Open Lounge Phone device. The web emulator runs this directly and
 * the ESP32 firmware mirrors it, so the phone feels identical everywhere.
 *
 * Only call-related server messages are inputs here; pairing, auth and config are handled by the
 * connection layer.
 */
export type DeviceState =
  | { kind: "idle" } // handset on the cradle
  /**
   * Handset up, waiting for a key. `held`: a call this phone put on hold (MENU → Add caller).
   * `callback`: you just asked a public line to call you back (your place is kept).
   * `signIn`: a Lounge phone with nobody signed in tried a public line (`SIGN IN TO CALL`).
   * `lost`: the last call's audio connection dropped and couldn't be restored (`CONNECTION LOST`).
   */
  | {
      kind: "offhook";
      lastEnd?: EndReason;
      held?: string;
      callback?: true;
      signIn?: true;
      lost?: true;
    }
  /**
   * Not yet answered. `queue`: calling a public line and waiting in its queue (the place in
   * line, whether key 1 leaves a voicemail instead, and whether key 2 asks for a call back).
   */
  | {
      kind: "dialing";
      button: number;
      callId?: string;
      held?: string;
      queue?: { position?: number; size?: number; voicemail?: boolean; callback?: boolean };
    }
  /**
   * Ringing, handset down. `callback`: a public line calling you back, as you asked. `addon`: the
   * caller is an add-on (shown as `SEAT · ADD-ON`); `share`: it calls within one of its shares
   * you hold (shown as `SEAT · BOOK CLUB`). `silenced`: BACK stopped the ringer on this phone (it
   * still rings elsewhere; lifting still answers).
   */
  | {
      kind: "incoming";
      callId: string;
      from: string;
      callback?: true;
      addon?: true;
      share?: string;
      silenced?: true;
    }
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
      /** MENU → Mute: the mic stops sending in this call (local: the server isn't told). */
      muted?: boolean;
      /** Call waiting: another call rings softly (1 takes it and holds this one, 2 ignores it). */
      waiting?: { callId: string; from: string; addon?: true; share?: string };
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
  /** The call's audio connection dropped and reconnecting gave up: end it, saying why. */
  | { type: "lost" }
  /** BACK while ringing: this phone's ringer stops (the call goes on ringing elsewhere). */
  | { type: "silence" }
  /** MENU → Missed → 1: call this missed caller back (`config.missed` item id). Handset up. */
  | { type: "callBack"; id: string }
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

/**
 * What the speaker/ringer should be doing in a given state. `hold` = the soft on-hold tone;
 * `waiting` = the call-waiting beep over the call.
 */
export type Sound = "none" | "dialtone" | "ringback" | "ring" | "busy" | "hold" | "waiting";

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

/**
 * The digit each call action has on the call screen, the same in every state and on every phone
 * (docs/phone-ux.md): 1 hold / resume / merge, 2 transfer, 3 mute / unmute.
 */
export function callActionDigit(a: CallAction): number {
  switch (a) {
    case "transfer":
      return 2;
    case "mute":
    case "unmute":
      return 3;
    default:
      return 1;
  }
}

/** Which actions the MENU offers in this state (each on its `callActionDigit`). */
export function callActions(s: DeviceState): CallAction[] {
  if (s.kind === "incall" && s.connected) {
    const mute: CallAction = s.muted ? "unmute" : "mute";
    if (s.held) return ["merge", "transfer", mute];
    return s.heldByThem ? [mute] : ["hold", "transfer", mute];
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
    // A call was waiting: now it rings like any call.
    if (s.kind === "incall" && s.waiting) {
      const { callId, from, addon, share } = s.waiting;
      return stay(
        {
          kind: "incoming",
          callId,
          from,
          ...(addon ? { addon } : {}),
          ...(share ? { share } : {}),
        },
        ...hangups,
        hook,
      );
    }
    return stay({ kind: "idle" }, ...hangups, hook);
  }

  if (input.type === "button") {
    if (s.kind === "offhook") {
      return stay(
        { kind: "dialing", button: input.index, ...(s.held ? { held: s.held } : {}) },
        { t: "button", index: input.index },
      );
    }
    // Waiting in a public line's queue: key 1 leaves a voicemail instead (when offered).
    if (s.kind === "dialing" && s.queue?.voicemail && s.callId && input.index === 0) {
      return stay(s, { t: "call.voicemail", callId: s.callId });
    }
    // …and key 2 asks the line to call you back instead (you keep your place).
    if (s.kind === "dialing" && s.queue?.callback && s.callId && input.index === 1) {
      return stay(s, { t: "call.callback", callId: s.callId });
    }
    // Call waiting: 1 takes it (the server holds this call first), 2 ignores it.
    if (s.kind === "incall" && s.waiting && !s.transferPending && input.index <= 1) {
      if (input.index === 1) {
        const { waiting: _w, ...rest } = s;
        return stay(rest);
      }
      return stay(
        { kind: "incall", callId: s.waiting.callId, connected: false, held: s.callId },
        { t: "call.answer", callId: s.waiting.callId },
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
  if (input.type === "silence") {
    return s.kind === "incoming" ? stay({ ...s, silenced: true }) : stay(s);
  }
  if (input.type === "lost") {
    if (s.kind !== "incall") return stay(s);
    return stay(
      { kind: "offhook", lastEnd: "error", lost: true, ...(s.held ? { held: s.held } : {}) },
      { t: "call.hangup", callId: s.callId, lost: true },
    );
  }
  if (input.type === "extension") {
    if (s.kind !== "offhook") return stay(s);
    return stay(
      { kind: "dialing", button: -1, ...(s.held ? { held: s.held } : {}) },
      { t: "call.extension", number: input.number },
    );
  }
  if (input.type === "callBack") {
    if (s.kind !== "offhook") return stay(s);
    return stay(
      { kind: "dialing", button: -1, ...(s.held ? { held: s.held } : {}) },
      { t: "call.back", id: input.id },
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
    if (s.kind === "idle") {
      return stay({
        kind: "incoming",
        callId: msg.callId,
        from: msg.from.label,
        ...(msg.callback ? { callback: true as const } : {}),
        ...(msg.from.kind === "addon" ? { addon: true as const } : {}),
        ...(msg.from.kind === "addon" && msg.from.share ? { share: msg.from.share } : {}),
      });
    }
    if ("callId" in s && s.callId === msg.callId) return stay(s);
    // Call waiting: in a call, a second call rings softly (one at a time).
    if (msg.waiting && s.kind === "incall" && s.connected && !s.held && !s.waiting) {
      return stay({
        ...s,
        waiting: {
          callId: msg.callId,
          from: msg.from.label,
          ...(msg.from.kind === "addon" ? { addon: true as const } : {}),
          ...(msg.from.kind === "addon" && msg.from.share ? { share: msg.from.share } : {}),
        },
      });
    }
    if (s.kind === "incall" && s.waiting?.callId === msg.callId) return stay(s);
    // Busy: decline so the caller hears it immediately instead of waiting for a timeout.
    return stay(s, { t: "call.hangup", callId: msg.callId });
  }

  // call.state
  // The waiting call: it ends when the caller gives up (or it goes to voicemail).
  if (s.kind === "incall" && s.waiting?.callId === msg.callId) {
    if (msg.state !== "ended") return stay(s);
    const { waiting: _w, ...rest } = s;
    return stay(rest);
  }
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
      if (msg.state === "ended" && msg.callback && !s.held) {
        return stay({ kind: "offhook", lastEnd: "hangup", callback: true });
      }
      if (msg.state === "ended") {
        const signIn = msg.note === SIGN_IN_FOR_LINES_NOTE ? { signIn: true as const } : {};
        return stay({ kind: "offhook", lastEnd: msg.reason ?? "hangup", ...held, ...signIn });
      }
      if (msg.state === "active")
        return stay({ kind: "incall", callId: msg.callId, connected: true, ...held });
      if (msg.state === "connecting") {
        return stay({ kind: "incall", callId: msg.callId, connected: false, ...held });
      }
      // A public line's queue: the place in line; `ringing` without one = ringing again.
      const { queue: _q, ...rest } = s;
      return stay({ ...rest, callId: msg.callId, ...(msg.queue ? { queue: msg.queue } : {}) });
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
        const lost = msg.note === CONNECTION_LOST_NOTE ? { lost: true as const } : {};
        return stay({ kind: "offhook", lastEnd: msg.reason ?? "hangup", ...held, ...lost });
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
      // In a call the mic is the phone's own: nobody else needs to know.
      if (s.kind === "incall") return stay({ ...s, muted: a === "mute" });
      if (s.kind !== "inroom" || !s.roomId) return stay(s);
      const muted = a === "mute";
      return stay({ ...s, muted }, { t: "room.mute", roomId: s.roomId, muted });
    }
  }
}

/** What a phone last called, for MENU → Redial (kept by the phone across restarts). */
export type LastDial =
  | { kind: "button"; index: number }
  | { kind: "extension"; number: string }
  | { kind: "back"; id: string };

/** The call this input starts from `s` (handset up, nothing dialled), if it starts one. */
export function dialOf(s: DeviceState, input: DeviceInput): LastDial | undefined {
  if (s.kind !== "offhook") return undefined;
  if (input.type === "button") return { kind: "button", index: input.index };
  if (input.type === "extension") return { kind: "extension", number: input.number };
  if (input.type === "callBack") return { kind: "back", id: input.id };
  return undefined;
}

/** MENU → Redial: the same call again. */
export function redialInput(last: LastDial): DeviceInput {
  switch (last.kind) {
    case "button":
      return { type: "button", index: last.index };
    case "extension":
      return { type: "extension", number: last.number };
    case "back":
      return { type: "callBack", id: last.id };
  }
}

/**
 * A `call.state ended` for a call that already ended here (a server repeating itself, or a late
 * answer to our own hang-up): phones drop it, so it can't end the next call. `recent` holds the
 * last few ended call ids.
 */
export function repeatedEnd(
  recent: readonly string[],
  msg: { t: string; callId?: string; state?: string },
): { repeat: boolean; recent: string[] } {
  if (msg.t !== "call.state" || msg.state !== "ended" || !msg.callId) {
    return { repeat: false, recent: [...recent] };
  }
  if (recent.includes(msg.callId)) return { repeat: true, recent: [...recent] };
  return { repeat: false, recent: [msg.callId, ...recent].slice(0, 4) };
}

export function soundFor(s: DeviceState): Sound {
  switch (s.kind) {
    case "idle":
    case "inroom":
    case "voicemail": // the greeting, the tone and the recording are the shell's
      return "none";
    case "incall":
      return s.waiting ? "waiting" : s.heldByThem ? "hold" : "none";
    case "incoming":
      return s.silenced ? "none" : "ring";
    case "dialing":
      return s.queue ? "hold" : "ringback";
    case "offhook":
      return s.lastEnd === undefined || s.lastEnd === "hangup" ? "dialtone" : "busy";
  }
}
