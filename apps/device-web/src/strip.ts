import { type DeviceState, pageLabel, shownPages } from "@openloungephone/core";
import type { EndReason } from "@openloungephone/protocol";
import type { Connection, DeviceConfig } from "./leds.ts";

/** Characters per line. Fits both a narrow e-ink stripe and a 16-character segment display. */
export const STATUS_WIDTH = 16;

export interface StatusInput {
  connection: Connection;
  /** Pairing code while the device is unpaired. */
  pairingCode?: string;
  deviceState: DeviceState;
  config?: DeviceConfig;
  /** Label of the other party on the current or last call. */
  activeLabel?: string;
  battery?: { pct: number; charging: boolean };
  /** Lounge on a weak USB source runs with reduced features and asks for a better charger. */
  power?: { reduced: boolean };
  /** When the current call connected (epoch ms), for the call timer. */
  callStartedAt?: number;
  /** The call's audio connection dropped and is being restored. */
  reconnecting?: boolean;
  /** The call's incoming audio is poor (packet loss or jitter). */
  poor?: boolean;
  /** In a room: its name, how many are in, whether you're muted, and an idle warning. */
  room?: {
    name: string;
    people: number;
    muted: boolean;
    idleWarning?: boolean;
    /** Its hours end in a minute. */
    closing?: boolean;
  };
  /** Leaving a voicemail after an unanswered call (and its outcome, shortly after hang-up). */
  leave?: { stage: "greeting" | "recording" | "sending" | "sent" | "failed"; remainingMs?: number };
  /** The call or room is recorded (announced): the strip says REC, next to the recording light. */
  recording?: boolean;
  /** Local time "HH:MM" for the ready screen, once the phone knows it. */
  clock?: string;
  /** A notice from the space (docs/notices.md): shown on the ready screen until dismissed. */
  notice?: { lines: string[] };
  /** I'm OK was just counted (the server's config says done): thank them for a moment. */
  checkedIn?: boolean;
  now: number;
}

/**
 * Status text for the phone's small display: one or two uppercase lines of at most
 * STATUS_WIDTH characters, legible on e-ink or 14-segment LEDs alike. Pure, so firmware can
 * mirror it.
 */
export type StatusLines = [string] | [string, string];

const END_TEXT: Partial<Record<EndReason, string>> = {
  denied: "NOT ALLOWED",
  voicemail: "NOT ALLOWED",
  busy: "BUSY",
  timeout: "NO ANSWER",
  unreachable: "UNAVAILABLE",
  declined: "DECLINED",
  error: "CALL FAILED",
};

const clip = (s: string) => s.toUpperCase().slice(0, STATUS_WIDTH);

/** "CALLING MOM" on one line when it fits, otherwise "CALLING" / "GRANDMA JOSEPHINE". */
function withName(prefix: string, name: string, suffix = ""): StatusLines {
  const one = `${prefix}${prefix && name ? " " : ""}${name}${suffix && name ? " " : ""}${suffix}`;
  if (one.length <= STATUS_WIDTH) return [clip(one)];
  return prefix ? [clip(prefix), clip(name)] : [clip(name), clip(suffix)];
}

/**
 * An add-on's name, always marked as one: `SEAT · ADD-ON`, the name shortened when it must be
 * (whatever its name, it never shows as a person or a phone would).
 */
export function addonLabel(name: string): string {
  const mark = " · ADD-ON";
  const n = name.trim();
  const room = STATUS_WIDTH - mark.length;
  return clip(`${n.length > room ? n.slice(0, room) : n}${mark}`);
}

/**
 * An add-on calling: `SEAT · ADD-ON` / `LIFT TO ANSWER` when that fits, else the name and
 * `ADD-ON CALLING`. Within a share, the share with its name (`SEAT · BOOK CLUB`, when it fits)
 * and always `ADD-ON CALLING` below, so a share's label can't pass for a person.
 */
function addonCalling(name: string, share?: string): StatusLines {
  const n = name.trim();
  if (share?.trim()) {
    const both = `${n} · ${share.trim()}`;
    return [clip(both.length <= STATUS_WIDTH ? both : n), "ADD-ON CALLING"];
  }
  const full = `${n} · ADD-ON`;
  return full.length <= STATUS_WIDTH ? [clip(full), "LIFT TO ANSWER"] : [clip(n), "ADD-ON CALLING"];
}

function clock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const mm = Math.floor(total / 60);
  const ss = String(total % 60).padStart(2, "0");
  return mm >= 100
    ? `${Math.floor(mm / 60)}H${String(mm % 60).padStart(2, "0")}`
    : `${String(mm).padStart(2, "0")}:${ss}`;
}

export function statusLines(input: StatusInput): StatusLines {
  const { connection, pairingCode, deviceState: s, config, activeLabel, battery } = input;
  const name = (activeLabel ?? "").trim();

  if (pairingCode)
    return [`PAIR ${pairingCode.slice(0, 3)} ${pairingCode.slice(3)}`, "ENTER IN APP"];
  if (connection === "offline") return ["OFFLINE", "RECONNECTING"];
  if (connection === "connecting") return ["CONNECTING"];

  switch (s.kind) {
    case "dialing":
      // Waiting in a public line's queue: key 1 leaves a voicemail instead, key 2 asks for a
      // call back (when the line offers them).
      if (s.queue) {
        const place = s.queue.position ? `IN LINE ${s.queue.position}` : "WAITING IN LINE";
        const { voicemail, callback } = s.queue;
        const keys =
          voicemail && callback
            ? "1 VM 2 CALL BACK"
            : voicemail
              ? "1 VOICEMAIL"
              : callback
                ? "2 CALL ME BACK"
                : name || "PLEASE WAIT";
        return [clip(place), clip(keys)];
      }
      return withName("CALLING", name);
    case "incoming": {
      if (s.callback) return [clip(s.from.trim()), "CALLS YOU BACK"];
      if (s.addon) return addonCalling(s.from, s.share);
      const who = withName("", s.from.trim(), "CALLING");
      // In turn on the second line: BACK silences the ringer here (until it's silenced).
      const answer = !s.silenced && hintNow(input.now) ? "BACK: SILENCE" : "LIFT TO ANSWER";
      return who.length === 1 ? [who[0], answer] : who;
    }
    case "incall":
      if (s.transferPending) return ["TRANSFER TO?", "PRESS A KEY"];
      // Call waiting: who, and the keys (a long name takes turns with them).
      if (s.waiting) {
        const who = s.waiting.addon ? addonLabel(s.waiting.from) : clip(s.waiting.from.trim());
        const top = `WAITING: ${who}`;
        if (top.length <= STATUS_WIDTH) return [top, WAITING_KEYS];
        return ["CALL WAITING", hintNow(input.now) ? WAITING_KEYS : who];
      }
      if (s.heldByThem) return name ? ["ON HOLD", clip(name)] : ["ON HOLD"];
      if (s.held && s.connected) return [clip(name || "IN CALL"), "MENU: MERGE"];
      if (!s.connected || input.callStartedAt === undefined) {
        return name ? ["CONNECTING", clip(name)] : ["CONNECTING"];
      }
      // Never a timer while there's no audio: say it's coming back.
      if (input.reconnecting) return name ? ["RECONNECTING", clip(name)] : ["RECONNECTING"];
      {
        const what = s.muted
          ? input.recording
            ? "REC MUTED"
            : "MUTED"
          : input.recording
            ? "REC"
            : "IN CALL";
        // In turn with the name: how to mute or unmute (MENU 3, docs/phone-ux.md).
        const hint = hintNow(input.now) ? (s.muted ? "MENU 3: UNMUTE" : "MENU 3: MUTE") : undefined;
        const second = input.poor ? "POOR CONNECTION" : (hint ?? (name ? clip(name) : undefined));
        return second
          ? [`${what} ${clock(input.now - input.callStartedAt)}`, second]
          : [`${what} ${clock(input.now - input.callStartedAt)}`];
      }
    case "inroom": {
      const room = input.room;
      if (!s.roomId || !room) return ["JOINING ROOM"];
      if (room.closing) return ["CLOSING SOON", clip(room.name)];
      if (room.idleWarning) return ["STILL THERE?", "PRESS ANY KEY"];
      const count = `${input.recording ? "REC " : ""}${room.people} IN ROOM${s.muted ? " MUTED" : ""}`;
      return [clip(room.name), clip(count)];
    }
    case "offhook": {
      if (s.lost) return ["CONNECTION LOST", "PRESS A KEY"];
      if (s.held) {
        const text = s.lastEnd && s.lastEnd !== "hangup" ? END_TEXT[s.lastEnd] : undefined;
        return [text ?? "CALLER ON HOLD", "PRESS A KEY"];
      }
      // Asked a public line to call back: the place in line is kept.
      if (s.callback) return ["PLACE KEPT", "WE'LL CALL BACK"];
      // A free Lounge phone tried a public line: only someone signed in can call one.
      if (s.signIn) return ["SIGN IN TO CALL", "PRESS A KEY"];
      const text = s.lastEnd ? END_TEXT[s.lastEnd] : undefined;
      if (text) return [text, "PRESS A KEY"];
      // More than one page of keys: which page is on screen, and how to turn it.
      const pages = shownPages(config);
      if (pages.length > 1) return [pageLabel(pages, s.page ?? 1), "BACK: NEXT PAGE"];
      return ["PRESS A KEY"];
    }
    case "voicemail": {
      const stage = input.leave?.stage ?? "greeting";
      if (stage === "recording") {
        return [`RECORDING ${clock(input.leave?.remainingMs ?? 0)}`, "HANG UP TO SEND"];
      }
      if (stage === "failed") return ["MESSAGE NOT SENT", "HANG UP"];
      return ["LEAVE A MESSAGE", clip(name || s.offer.name)];
    }
    default:
      break;
  }
  // Just hung up after leaving a message.
  if (input.leave?.stage === "sending") return ["SENDING MESSAGE"];
  if (input.leave?.stage === "sent") return ["MESSAGE SENT"];
  if (input.leave?.stage === "failed") return ["MESSAGE NOT SENT"];
  // A notice from the space, until a key dismisses it or it expires.
  const notice = input.notice?.lines.filter(Boolean).map(clip);
  if (notice?.length)
    return notice.length > 1 ? [notice[0] ?? "", notice[1] ?? ""] : [notice[0] ?? ""];
  // The daily check-in: asked until I'm OK (1, handset down); thanked once the server has it.
  if (input.checkedIn) return ["THANK YOU", "CHECKED IN"];
  const checkin = config?.checkin;
  if (checkin && !checkin.done) {
    return [checkin.alerted ? "CHECK-IN MISSED" : `CHECK IN BY ${checkin.by}`, "PRESS 1: I'M OK"];
  }

  const low = battery && !battery.charging && battery.pct < 20;
  const lowLine = low ? `LOW BATTERY ${battery.pct}%` : undefined;
  const quiet = config?.quiet
    ? config.quietUntil
      ? `QUIET TIL ${config.quietUntil}`
      : "QUIET HOURS"
    : undefined;
  const missedItems = (config?.missed ?? []).filter((m) => m.from.trim());
  const missed = missedItems.map((m) => m.from.trim());

  if (missed.length > 0) {
    const [newest] = missed as [string];
    const single = `MISSED ${newest}`;
    const summary =
      missed.length === 1
        ? single.length <= STATUS_WIDTH
          ? single
          : "MISSED CALL"
        : `${missed.length} MISSED CALLS`;
    if (quiet) return [quiet, clip(summary)];
    // A public line's call back nobody took: there's no message to play, just its name.
    if (missed.length === 1 && missedItems[0]?.callback) return ["MISSED CALL BACK", clip(newest)];
    if (missed.length === 1) {
      // A missed call (no message): it's on MENU 5. A message: where to listen.
      const next =
        missedItems[0]?.kind === "call"
          ? "MENU 5: MISSED"
          : !config?.owner || config.owner.mode === "kids"
            ? "ASK A GROWN-UP"
            : "PLAY IN APP";
      const lines: StatusLines =
        single.length <= STATUS_WIDTH ? [clip(single), next] : ["MISSED CALL", clip(newest)];
      return lowLine && lines[1] === next ? [lines[0], lowLine] : lines;
    }
    // Several callers: cycle their names on the second line every few seconds.
    const who = missed[Math.floor(input.now / MISSED_CYCLE_MS) % missed.length] as string;
    return [clip(summary), clip(who)];
  }

  const first =
    quiet ?? (input.clock ? `READY ${input.clock}` : battery ? `READY ${battery.pct}%` : "READY");
  if (input.power?.reduced) return [first, WEAK_CHARGER];
  if (lowLine) return [first, lowLine];
  const owner = config?.owner ? ownerLine(config.owner) : undefined;
  return owner ? [first, owner] : [first];
}

/**
 * The trust line: whose phone this is and how it's used ("KIDS: SMITH HOME", "JESSE'S PHONE",
 * "LOUNGE: OFFICE"), so anyone can see it at a glance.
 */
export function ownerLine(owner: NonNullable<DeviceConfig["owner"]>): string {
  if (owner.mode === "personal" && owner.person) return clip(`${owner.person}'S PHONE`);
  return clip(`${owner.mode === "lounge" ? "LOUNGE" : "KIDS"}: ${owner.space}`);
}

/** Shown on a Default (≤500 mA) USB source when the phone needs more (Lounge). */
export const WEAK_CHARGER = "USE 1.5A CHARGER";

/** How long each missed caller's name stays on screen when several are cycling. */
export const MISSED_CYCLE_MS = 3000;

/** Call waiting's keys: 1 takes the call (this one goes on hold), 2 ignores it. */
export const WAITING_KEYS = "1 TAKE 2 IGNORE";

/** A how-to hint (`BACK: SILENCE`, `MENU 3: MUTE`) takes the second line every third turn of
 * this long. */
export const HINT_CYCLE_MS = 3000;
const hintNow = (now: number) => Math.floor(now / HINT_CYCLE_MS) % 3 === 2;
