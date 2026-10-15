import {
  browserVoice,
  CallMedia,
  CallRecorder,
  getMicrophone,
  LeaveMessage,
  type LeaveState,
  ProtocolSocket,
  RoomAudio,
  type SocketStatus,
  socketUrl,
  TonePlayer,
  uploadGreeting,
  VoicemailRecorder,
} from "@openloungephone/client";
import {
  CALL_PROMPT_TEXT,
  CLOSED_NOTE,
  callActions,
  type DeviceInput,
  type DeviceState,
  deviceFingerprint,
  deviceStep,
  dialOf,
  initialDeviceState,
  NO_EXTENSION_NOTE,
  PROMPT_TEXT,
  RECORDING_MAX_MS,
  redialInput,
  repeatedEnd,
  soundFor,
  WORKPLACE_PROMPT_TEXT,
} from "@openloungephone/core";
import {
  type DeviceToServer,
  decodeServerToDevice,
  fromBase64Url,
  type IceServer,
  PROTOCOL_VERSION,
  type ServerToDevice,
} from "@openloungephone/protocol";
import { encode } from "uqr";
import {
  type Autopair,
  COMPANION_TOKEN_KEY,
  claimPairing,
  parseAutopair,
  shouldAutopair,
} from "./autopair.ts";
import { forgetLastDial, isVoicemail, loadLastDial, missedEntries, saveLastDial } from "./calls.ts";
import { playChime, unlockChime } from "./chime.ts";
import {
  lines as epdLines,
  frame,
  keyMap,
  lineCapacity,
  loungeCode,
  MARQUEE_STEP_MS,
  paint,
} from "./epaper.ts";
import { keyGrid } from "./grid.ts";
import {
  forgetIdentity,
  getDeviceId,
  loadOrCreateIdentity,
  setDeviceId,
  sign,
} from "./identity.ts";
import {
  digitOf,
  isDigit,
  KEY_ROWS,
  type KeyId,
  keyFromKeyboard,
  SLOT_COUNT,
  slotOf,
} from "./keypad.ts";
import { type Connection, type DeviceConfig, hasNewMissed, statusLed } from "./leds.ts";
import {
  type LoungeView,
  loungeLines,
  loungeUrl,
  QR_REFRESH_LEAD_MS,
  showQr,
  wantsFreshCode,
} from "./lounge.ts";
import {
  DEFAULT_SETTINGS,
  type MenuEvent,
  type MenuState,
  type MenuView,
  menuLines,
  menuStep,
  menuView,
  type Settings,
} from "./menu.ts";
import { type PowerSource, powerStatus, type Variant } from "./power.ts";
import { renderSegments } from "./segments.ts";
import { forgetKind, loadKind, saveKind, startScreen } from "./setup.ts";
import { addonLabel, MISSED_CYCLE_MS, ownerLine, STATUS_WIDTH, statusLines } from "./strip.ts";
import { type VmEvent, type VmPlayer, vmLines, vmStart, vmStep } from "./vmplay.ts";
import { ScreenAwake, type WakeLockLike } from "./wake.ts";

type Signal = Extract<ServerToDevice, { t: "rtc.sdp" | "rtc.ice" }>;

const FW = "0.1.0";
const STATUS_INTERVAL_MS = 60_000;
const ANNOUNCE_INTERVAL_MS = 7_000;
const CLOSE_UNAUTHORIZED = 4401;
const CLOSE_REPLACED = 4000;

const params = new URLSearchParams(location.search);
const profile = params.get("profile")?.trim() || "default";
const startedAt = Date.now();
// The board has a header for a display module (standard: a 2.13-inch e-paper module, 250 x 122).
// `none` = Kids Lite (no display; keys carry printed labels), `segments` = 14-segment module.
const displayParam = params.get("display");
const displayMode =
  displayParam === "segments" ? "segments" : displayParam === "none" ? "none" : "eink";
const storage = (() => {
  try {
    return localStorage;
  } catch {
    return undefined;
  }
})();
// Kids, personal or Lounge: chosen on the first-run screen (or `?variant=`), remembered per
// profile; whoever claims the phone may pick another mode.
let chosenKind: Variant | undefined = loadKind(storage, profile, params.get("variant"));
let variant: Variant = chosenKind ?? "kids";
const devMode = params.get("dev") === "1";
const VARIANT_NAME: Record<Variant, string> = {
  kids: "Kids",
  personal: "Personal",
  lounge: "Lounge",
};
let powerSource: PowerSource = "3A";

const $ = <T extends Element>(sel: string) => document.querySelector(sel) as T;
const handsetEl = $<HTMLButtonElement>(".handset");
const hookKeyEl = $<HTMLButtonElement>(".hookkey");

// The e-paper, drawn as the firmware draws it (epaper.ts); see drawEpaper().
const EPD_INK = [36, 36, 32];
const EPD_PAPER = [226, 225, 216];
let epd: {
  lines: string[];
  grid?: string[][] | undefined;
  qr?: string | undefined;
  menu?: MenuView | undefined;
  offhook: boolean;
} = { lines: [], offhook: false };
let epdChanges = 0;
let epdScroll: ReturnType<typeof setInterval> | undefined;
const epdCanvas = document.createElement("canvas");
epdCanvas.className = "epd";
epdCanvas.width = 250;
epdCanvas.height = 122;

const keyRowEls = [$<HTMLDivElement>(".keys--top"), $<HTMLDivElement>(".keys--bottom")];
const displayEl = $<HTMLDivElement>(".display");
const statusLedEl = $<HTMLSpanElement>(".status-led");
const handsetLabelEl = $<HTMLSpanElement>(".handset__label");
const startEl = $<HTMLDivElement>(".start");
// Live call audio (no captions possible), so it is created here rather than in the markup.
const audioEl = document.createElement("audio");
audioEl.autoplay = true;
document.body.append(audioEl);
const logEl = $<HTMLOListElement>(".devpanel__log");
const fact = (name: string) => $<HTMLElement>(`[data-fact="${name}"]`);

// --- state ---------------------------------------------------------------------

let deviceState: DeviceState = initialDeviceState;
let config: DeviceConfig | undefined;
let connection: Connection = "connecting";
let authed = false;
let pairingCode: string | undefined;
const autopair: Autopair | undefined = parseAutopair(new URLSearchParams(location.search));
const autopairTried = new Set<string>();
let autopairStatus = autopair ? "waiting for a code" : "off";
let pairingTimer: ReturnType<typeof setTimeout> | undefined;
let hookUp = false;
let activeLabel: string | undefined;
/** The device's real battery when the browser shares it (or the developer panel's), else none:
 * the phone never reports a battery it doesn't know. */
let battery: { pct: number; charging: boolean } | undefined;
let batteryFromPanel = false;
const iceByCall = new Map<string, IceServer[]>();
/** The call being talked in, and one on hold (MENU → Add caller). Each has its own mic copy. */
type CallAudio = {
  callId: string;
  media?: CallMedia;
  pending: Signal[];
  mic?: MediaStream;
  /** The audio connection dropped and is being restored. */
  reconnecting?: boolean;
  /** Packet loss or jitter make the incoming audio poor. */
  poor?: boolean;
};
let call: CallAudio | undefined;
let heldCall: CallAudio | undefined;
/** Attended transfer: calls where this phone sends the offer though it didn't dial. */
const offererFor = new Set<string>();
/** Calls merged into a room: their audio plays until the room's is connected. */
const mergedCalls = new Set<string>();
const lingering: { media?: CallMedia; mic?: MediaStream; el: HTMLAudioElement }[] = [];
let lingerTimer: ReturnType<typeof setTimeout> | undefined;
/** The room this phone is in (a party line, a phone room or a 3-way call). */
let roomAudio: RoomAudio | undefined;
let roomPending: Extract<ServerToDevice, { t: "room.media" | "rtc.sdp" | "rtc.ice" }>[] = [];
let room:
  | { name: string; people: number; muted: boolean; idleWarning?: boolean; closing?: boolean }
  | undefined;
/** The room's microphone copy and the others' audio (for a recording this phone makes). */
let roomMic: MediaStream | undefined;
let roomStreams: MediaStream[] = [];
let micPromise: Promise<MediaStream> | undefined;
let unauthorizedStreak = 0;
let announceTimer: ReturnType<typeof setInterval> | undefined;
let lastStatusText = "";
let callStartedAt: number | undefined;
/** The space's UTC offset (`config.utcOffsetMin`), for when missed calls were. */
let utcOffsetMin = -new Date().getTimezoneOffset();
/** The last few calls that ended here (a repeated ended for one of them is dropped). */
let endedCalls: string[] = [];
let callTicker: ReturnType<typeof setInterval> | undefined;
let noticeTicker: ReturnType<typeof setInterval> | undefined;
/** A notice from the space (docs/notices.md), until it's dismissed or cleared. */
let notice: Extract<ServerToDevice, { t: "notice" }> | undefined;
/** Its recording, playing in the earpiece while the handset is up. */
let noticeAudio: HTMLAudioElement | undefined;
let menu: MenuState | undefined;
/** Listening to voicemail (MENU 2 → 1), as the firmware's vmplay.c. */
let vm: VmPlayer | undefined;
let vmAudio: HTMLAudioElement | undefined;
let vmTicker: ReturnType<typeof setInterval> | undefined;
let settings: Settings = { ...DEFAULT_SETTINGS };
let menuTicker: ReturnType<typeof setInterval> | undefined;
const keyEls = new Map<KeyId, HTMLButtonElement>();
/** Lounge phone state from the server; emptied when a session ends. */
let lounge: LoungeView = {};
let challengeTimer: ReturnType<typeof setTimeout> | undefined;
let qrTimer: ReturnType<typeof setTimeout> | undefined;
let lastQrAsk = 0;
/** Leaving a voicemail after an unanswered call (and its outcome for a moment after). */
let leaveFlow: LeaveMessage | undefined;
let leave: LeaveState | undefined;
let leaveTicker: ReturnType<typeof setInterval> | undefined;
let leaveClear: ReturnType<typeof setTimeout> | undefined;
/** Calls and rooms announced as recorded (the light and REC stay on while they last). */
const recorded = new Set<string>();
/** The recording this phone makes for its space, if the server picked it (call or room id). */
let recorder: { id: string; ticket: string; rec: CallRecorder } | undefined;

/** Recording the phone's greeting from MENU → Voicemail. */
let greetingRec:
  | { kind: "name" | "custom"; stage: "asking" | "recording"; recorder?: VoicemailRecorder }
  | undefined;

const tones = new TonePlayer();
/** Greetings and prompts through the handset (on hardware: pre-recorded prompt ids). */
const voice = browserVoice({ volume: () => settings.volume / 10 });
const identity = await loadOrCreateIdentity(profile);
/** MENU → About shows these four words; the app shows the same ones for this phone's key. */
const fingerprint = await deviceFingerprint(identity.publicKey);

// --- developer log -------------------------------------------------------------

function log(dir: "→" | "←" | "•", what: unknown): void {
  const text =
    typeof what === "string"
      ? what
      : JSON.stringify(what, (k, v) =>
          k === "sdp" && typeof v === "string" ? `${v.slice(0, 40)}…` : v,
        );
  const li = document.createElement("li");
  li.textContent = `${new Date().toLocaleTimeString()} ${dir} ${text}`;
  logEl.prepend(li);
  while (logEl.children.length > 200) logEl.lastElementChild?.remove();
}

// --- socket ----------------------------------------------------------------------

function send(msg: DeviceToServer): void {
  if (socket.send(msg) && msg.t !== "ping") log("→", msg);
}

const socket = new ProtocolSocket<ServerToDevice, DeviceToServer>({
  // The device id routes the socket to its household (a Durable Object on Cloudflare).
  url: () => {
    const id = getDeviceId(profile);
    return socketUrl(id ? `/ws/device?device=${encodeURIComponent(id)}` : "/ws/device");
  },
  decode: decodeServerToDevice,
  onOpen: (raw) => {
    authed = false;
    lounge = {};
    endCall();
    deviceState = hookUp ? { kind: "offhook" } : initialDeviceState;
    const deviceId = getDeviceId(profile);
    const hello: DeviceToServer = {
      t: "hello",
      proto: PROTOCOL_VERSION,
      model: "web-emulator",
      fw: FW,
      buttons: SLOT_COUNT,
      display: displayMode === "segments" ? "seg14" : displayMode,
      ...(deviceId ? { deviceId } : {}),
      // What this phone shows truthfully beyond the base protocol (docs/protocol.md).
      features: ["missed-calls"],
    };
    raw(hello);
    log("→", hello);
    // A new phone asks for a pairing code once it knows what kind of phone it is.
    if (!deviceId && chosenKind) beginPairing();
  },
  onMessage: (msg) => {
    if (msg.t !== "pong") log("←", msg);
    void handle(msg);
  },
  onStatus: (status: SocketStatus, detail) => {
    connection = status === "open" ? "online" : status === "connecting" ? "connecting" : "offline";
    if (status === "closed") {
      authed = false;
      endCall();
      if (detail) log("•", `closed ${detail.code} ${detail.reason}`);
      if (detail?.code === CLOSE_UNAUTHORIZED && getDeviceId(profile)) forgetDeviceId();
      if (detail?.code === CLOSE_REPLACED)
        log("•", "another tab took over this phone; not reconnecting");
    }
    render();
  },
  // Stop after repeated auth failures or when another tab owns this identity.
  shouldReconnect: (code) => code !== CLOSE_REPLACED && unauthorizedStreak <= 3,
});

function beginPairing(): void {
  send({ t: "pair.begin", publicKey: identity.publicKey, kind: chosenKind ?? "kids" });
}

function forgetDeviceId(): void {
  unauthorizedStreak++;
  setDeviceId(profile, undefined);
  log("•", "server does not know this phone; it will pair again");
}

/** Opened from the companion's "Add my virtual phone": pair with that account, no typing. */
async function tryAutopair(code: string): Promise<void> {
  let token: string | null = null;
  try {
    token = localStorage.getItem(COMPANION_TOKEN_KEY);
  } catch {}
  if (!shouldAutopair(autopair, token, code, autopairTried)) return;
  autopairTried.add(code);
  autopairStatus = "Pairing with your account…";
  render();
  const res = await claimPairing(code, autopair, token as string);
  autopairStatus = res.ok
    ? "paired with your account"
    : `couldn't pair automatically (${res.error}); use the code`;
  log("•", `autopair: ${autopairStatus}`);
  render();
}

async function handle(msg: ServerToDevice): Promise<void> {
  switch (msg.t) {
    case "auth.challenge":
      send({ t: "auth.proof", sig: await sign(identity, fromBase64Url(msg.nonce)) });
      break;
    case "pair.code":
      pairingCode = msg.code;
      clearTimeout(pairingTimer);
      // Codes expire; ask for a fresh one shortly before that happens.
      pairingTimer = setTimeout(beginPairing, Math.max(5_000, msg.expiresAt - Date.now() - 5_000));
      void tryAutopair(msg.code);
      break;
    case "pair.done":
      setDeviceId(profile, msg.deviceId);
      pairingCode = undefined;
      clearTimeout(pairingTimer);
      socket.reconnect();
      break;
    case "config": {
      const next: DeviceConfig = {
        buttons: msg.buttons,
        quiet: msg.quiet,
        ...(msg.quietUntil ? { quietUntil: msg.quietUntil } : {}),
        ...(msg.missed ? { missed: msg.missed } : {}),
        ...(msg.greeting ? { greeting: msg.greeting } : {}),
        ...(msg.owner ? { owner: msg.owner } : {}),
        ...(msg.extensions ? { extensions: true } : {}),
      };
      if (msg.utcOffsetMin !== undefined) utcOffsetMin = msg.utcOffsetMin;
      // The mode is decided when the phone is claimed; it may differ from the first-run choice.
      if (msg.owner && msg.owner.mode !== variant) {
        variant = msg.owner.mode;
        chosenKind = variant;
        saveKind(storage, profile, variant);
        $<HTMLElement>('[data-power="variant"]').textContent = VARIANT_NAME[variant];
      }
      // An idle Lounge phone: the space's house-line keys and "who's here", if it has them.
      lounge = { ...lounge };
      if (msg.houseLine) lounge.houseLine = true;
      else delete lounge.houseLine;
      if (msg.here) lounge.here = msg.here;
      else delete lounge.here;
      // Chime once for a newly missed caller, but never over a call or a lifted handset.
      if (authed && hasNewMissed(config, next) && !hookUp && deviceState.kind === "idle") {
        playChime();
      }
      config = next;
      // Several missed callers cycle their names on the display.
      clearInterval(noticeTicker);
      noticeTicker =
        (next.missed?.length ?? 0) > 1 ? setInterval(render, MISSED_CYCLE_MS) : undefined;
      if (!authed) {
        authed = true;
        unauthorizedStreak = 0;
        sendStatus();
        if (hookUp) send({ t: "hook", state: "up" });
      }
      break;
    }
    case "call.ringing":
    case "call.state": {
      // A second ended for a call that already ended can't end the next one.
      const repeat = repeatedEnd(endedCalls, msg);
      endedCalls = repeat.recent;
      if (repeat.repeat) {
        log("•", `repeated end of ${msg.callId} ignored`);
        break;
      }
      if (msg.t === "call.state" && msg.state === "ended" && msg.note === NO_EXTENSION_NOTE) {
        speak(WORKPLACE_PROMPT_TEXT["ext.unknown"]);
      }
      if (msg.t === "call.state" && msg.state === "ended" && msg.note === CLOSED_NOTE) {
        speak(WORKPLACE_PROMPT_TEXT["ext.closed"]);
      }
      if (msg.t === "call.state" && msg.state === "active" && msg.recording) {
        onRecording(msg.callId, msg.recording);
      }
      if (msg.t === "call.state" && msg.state === "ended") {
        recorded.delete(msg.callId);
        if (recorder?.id === msg.callId) stopRecorder();
        if (msg.merged) mergedCalls.add(msg.callId);
        if (msg.transfer?.offerer) offererFor.add(msg.transfer.callId);
      }
      step({ type: "server", msg });
      break;
    }
    case "room.state":
      step({ type: "server", msg });
      if (deviceState.kind === "inroom" && deviceState.roomId === msg.roomId) {
        enterRoom(msg);
        onRecording(msg.roomId, msg.recording);
      }
      break;
    case "room.ended": {
      if (msg.roomId) recorded.delete(msg.roomId);
      if (recorder && recorder.id === msg.roomId) stopRecorder();
      const was = deviceState.kind === "inroom";
      step({ type: "server", msg });
      leaveRoomAudio();
      if (was || msg.roomId === undefined) {
        const prompt =
          msg.reason === "removed"
            ? CALL_PROMPT_TEXT["room.removed"]
            : msg.reason === "locked"
              ? CALL_PROMPT_TEXT["room.locked"]
              : msg.reason === "full"
                ? CALL_PROMPT_TEXT["room.full"]
                : undefined;
        if (prompt) speak(prompt);
      }
      break;
    }
    case "room.idle":
      // A party line's hours end at `dropAt` (it closes for everyone), or the idle warning.
      if (msg.closing) {
        if (room) room = { ...room, closing: true };
        speak(`${room?.name ?? "The party line"} closes in a minute.`);
        break;
      }
      if (room) room = { ...room, idleWarning: true };
      speak(CALL_PROMPT_TEXT["room.idle"]);
      break;
    case "room.media":
      if (roomAudio?.roomId === msg.roomId) roomAudio.handle(msg);
      else roomPending.push(msg);
      break;
    case "rtc.config":
      iceByCall.set(msg.callId, msg.iceServers);
      break;
    case "greeting.ticket":
      void recordGreeting(msg.kind, msg.ticket, msg.maxMs);
      break;
    case "voicemail.items":
      vmApply({
        type: "items",
        items: msg.items.map((i) => ({
          id: i.id,
          from: i.from,
          durationMs: i.durationMs,
          ...(i.ticket ? { ticket: i.ticket } : {}),
        })),
        now: Date.now(),
      });
      break;
    case "greeting.done":
      if (msg.result === "not_allowed") {
        greetingRec = undefined;
        if (menu?.screen === "greeting") {
          applyMenu({ type: "greeting-done", ok: false, notAllowed: true, now: Date.now() });
        } else speak(PROMPT_TEXT["greet.not_allowed"]);
      }
      break;
    case "lounge.idle":
      lounge = { ...lounge, nonce: { nonce: msg.nonce, expiresAt: msg.expiresAt } };
      delete lounge.challenge;
      // Look again shortly before it expires; render() asks for a new one if it's still shown.
      clearTimeout(qrTimer);
      qrTimer = setTimeout(
        render,
        Math.max(1_000, msg.expiresAt - Date.now() - QR_REFRESH_LEAD_MS),
      );
      break;
    case "lounge.challenge":
      lounge = { ...lounge, challenge: { index: msg.index, expiresAt: msg.expiresAt } };
      if (menu) applyMenu({ type: "exit" });
      clearTimeout(challengeTimer);
      challengeTimer = setTimeout(() => {
        delete lounge.challenge;
        render();
      }, msg.expiresAt - Date.now());
      break;
    case "lounge.session":
      lounge = { ...lounge, session: { name: msg.name, openToChat: msg.openToChat } };
      delete lounge.challenge;
      break;
    case "lounge.ended":
      forgetPerson();
      break;
    case "rtc.sdp":
    case "rtc.ice": {
      if (msg.peer) {
        if (roomAudio?.roomId === msg.callId) roomAudio.handle(msg);
        else roomPending.push(msg);
        break;
      }
      const target =
        call?.callId === msg.callId ? call : heldCall?.callId === msg.callId ? heldCall : undefined;
      if (!target) break;
      if (target.media) await target.media.handle(msg).catch((e) => log("•", `rtc error: ${e}`));
      else target.pending.push(msg);
      break;
    }
    case "error":
      if (msg.code === "unauthorized" && getDeviceId(profile)) forgetDeviceId();
      break;
    case "notice": {
      const fresh = notice?.id !== msg.id;
      notice = msg;
      // A chime for a new one (not for its recording arriving), never during quiet hours or over
      // a call or a lifted handset.
      if (fresh && !hookUp && deviceState.kind === "idle" && !config?.quiet) playChime();
      log("•", `notice: ${msg.lines.join(" / ")}${msg.audio ? " (recorded)" : ""}`);
      break;
    }
    case "notice.cleared":
      if (notice?.id === msg.id) {
        notice = undefined;
        stopNoticeAudio();
      }
      break;
    case "wipe":
      await wipe();
      return;
    default:
      break;
  }
  render();
}

/**
 * Removed by its owner in the app: forget everything — the device key (IndexedDB), its id, how it
 * was set up and the log — and start over at "Set me up". Wi-Fi would be kept on hardware.
 */
async function wipe(): Promise<void> {
  log("•", "removed in the app: wiping this phone");
  socket.close();
  await forgetIdentity(profile);
  forgetKind(storage, profile);
  forgetLastDial(storage, profile);
  logEl.replaceChildren();
  location.reload();
}

/** A Lounge session ended: nothing about the person may stay on the phone. */
function forgetPerson(): void {
  lounge = lounge.nonce ? { nonce: lounge.nonce } : {};
  config = config ? { buttons: [], quiet: false } : undefined;
  activeLabel = undefined;
  if (menu) applyMenu({ type: "exit" });
  lastStatusText = "";
  logEl.replaceChildren(); // the developer log holds names and call history too
  log("•", "Lounge session ended; forgot everything");
}

/** Lounge: fetch a new takeover code when the idle screen shows a missing or stale one. */
function maybeRefreshQr(): void {
  if (variant !== "lounge" || !authed || pairingCode) return;
  const now = Date.now();
  const visible = document.visibilityState === "visible";
  if (!wantsFreshCode(lounge, deviceState, !!menu, now, visible)) return;
  if (now - lastQrAsk < QR_REFRESH_LEAD_MS) return;
  lastQrAsk = now;
  send({ t: "lounge.refresh" });
}

function sendStatus(): void {
  if (!authed) return;
  send({
    t: "status",
    ...(battery ? { battery } : {}),
    uptimeS: Math.floor((Date.now() - startedAt) / 1000),
    power: powerStatus(variant, powerSource),
  });
}
setInterval(sendStatus, STATUS_INTERVAL_MS);

// --- handset state machine -------------------------------------------------------

function labelFor(index: number): string | undefined {
  return config?.buttons.find((b) => b.index === index)?.label;
}

function step(input: DeviceInput): void {
  const prev = deviceState;
  // What this phone last called, for MENU 8 Redial (not on a Lounge phone: it forgets people).
  const dialled = variant === "lounge" ? undefined : dialOf(prev, input);
  if (dialled) saveLastDial(storage, profile, dialled);
  const r = deviceStep(prev, input);
  deviceState = r.state;
  if (authed) for (const m of r.send) send(m);

  const s = deviceState;
  // A call (or the handset) comes first: stop listening to voicemail.
  if (vm && prev.kind !== s.kind) vmApply({ type: "key", key: "back", now: Date.now() });
  // Lifting the handset or an incoming call leaves the menu (the call menu: any change of state).
  if (menu && (menu.screen === "call" ? prev.kind !== s.kind : s.kind !== "idle")) {
    applyMenu({ type: "exit" });
  }
  // We put the call on hold: its audio steps aside (and stops sending).
  if (prev.kind === "incall" && s.kind === "offhook" && s.held === prev.callId && call) {
    for (const t of call.mic?.getAudioTracks() ?? []) t.enabled = false;
    heldCall = call;
    call = undefined;
    audioEl.srcObject = null;
  }
  // Back from hold.
  if (s.kind === "incall" && heldCall?.callId === s.callId) {
    for (const t of heldCall.mic?.getAudioTracks() ?? []) t.enabled = true;
    call = heldCall;
    heldCall = undefined;
    const remote = call.media?.pc.getReceivers()[0]?.track;
    if (remote) audioEl.srcObject = new MediaStream([remote]);
  }
  // Merged into a room: keep the calls' audio until the room's is up.
  if (s.kind === "inroom") {
    for (const c of [call, heldCall]) if (c) lingerCall(c);
    call = undefined;
    heldCall = undefined;
  }
  // The held call ended (the other person hung up).
  if (heldCall && !("held" in s && s.held === heldCall.callId) && s.kind !== "inroom") {
    if (!(s.kind === "incall" && s.callId === heldCall.callId)) {
      if (mergedCalls.has(heldCall.callId)) lingerCall(heldCall);
      else closeCallAudio(heldCall);
      heldCall = undefined;
    }
  }
  // Transferred (attended): the call goes on under a new id; the old audio goes.
  if (s.kind === "incall" && call && call.callId !== s.callId) endCall();
  if (s.kind === "dialing") {
    activeLabel = labelFor(s.button);
  } else if (s.kind === "incoming") {
    // An add-on keeps its label in the call too ("IN CALL 00:12" / "SEAT · ADD-ON").
    activeLabel = s.addon ? addonLabel(s.from) : s.from;
  } else if (s.kind === "idle") {
    activeLabel = undefined;
  }

  if (
    input.type === "server" &&
    input.msg.t === "call.state" &&
    input.msg.state === "connecting" &&
    s.kind === "incall"
  ) {
    // The party that placed the call sends the offer (or was told to, after a transfer).
    void startMedia(s.callId, prev.kind === "dialing" || offererFor.delete(s.callId));
  }
  if (s.kind !== "incall" && call) endCall();
  // MENU 3 in a call: the mic really stops sending (its track is disabled), and comes back.
  if (s.kind === "incall" && call?.callId === s.callId) {
    for (const t of call.mic?.getAudioTracks() ?? []) t.enabled = !s.muted;
  }
  if (s.kind !== "inroom" && roomAudio) leaveRoomAudio();
  if (s.kind === "voicemail" && prev.kind !== "voicemail") startLeaving(s.offer);
  if (prev.kind === "voicemail" && s.kind !== "voicemail") leaveFlow?.finish(); // hang up to send
  if (s.kind === "incall" && s.connected && callStartedAt === undefined) {
    callStartedAt = Date.now();
    callTicker = setInterval(renderDisplay, 1000);
  } else if (!(s.kind === "incall" && s.connected) && callStartedAt !== undefined) {
    callStartedAt = undefined;
    clearInterval(callTicker);
  }
  render();
}

async function startMedia(callId: string, offerer: boolean): Promise<void> {
  const pending = call?.callId === callId ? call.pending : [];
  call = { callId, pending };
  const base = await micPromise?.catch(() => undefined);
  if (call?.callId !== callId) return; // ended while waiting for the microphone
  // Each call has its own copy of the microphone, so holding one doesn't mute the other.
  const mic = base ? new MediaStream(base.getAudioTracks().map((t) => t.clone())) : undefined;
  call.mic = mic;
  if (!mic) {
    log("•", "no microphone available; hanging up");
    send({ t: "call.hangup", callId });
    return;
  }
  const media = new CallMedia({
    callId,
    iceServers: iceByCall.get(callId) ?? [],
    offerer,
    microphone: mic,
    send: (m) => send(m),
    onRemoteStream: (stream) => {
      if (recorder?.id === callId) recorder.rec.add(stream);
      audioEl.srcObject = stream;
      void audioEl.play().catch(() => {});
    },
    onState: (state) => log("•", `peer connection ${state}`),
    onLink: (state) => {
      log("•", `call connection ${state}`);
      const mine = [call, heldCall].find((c) => c?.callId === callId);
      if (!mine) return;
      mine.reconnecting = state === "reconnecting";
      if (state === "lost") {
        // Reconnecting gave up: end the call, saying why (the other side hears it too).
        if (mine === call) step({ type: "lost" });
        else send({ t: "call.hangup", callId, lost: true });
      }
      render();
    },
    onQuality: (poor) => {
      const mine = [call, heldCall].find((c) => c?.callId === callId);
      if (mine) mine.poor = poor;
      render();
    },
  });
  call.media = media;
  try {
    await media.start();
    for (const m of call.pending.splice(0)) await media.handle(m);
  } catch (e) {
    log("•", `media error: ${e}`);
  }
}

/** Whether the call or room this phone is in right now is recorded. */
function recordedNow(): boolean {
  const s = deviceState;
  if (s.kind === "incall") return recorded.has(s.callId);
  if (s.kind === "inroom") return !!s.roomId && recorded.has(s.roomId);
  return false;
}

/**
 * A call or room is recorded: the phone says so ("This call is recorded."), lights its
 * recording light, and — if the server picked this phone to make the recording (a ticket) —
 * records what it sends and hears, and uploads it when the call ends.
 */
function onRecording(
  id: string,
  notice: { by: string; ticket?: string; maxMs?: number } | undefined,
): void {
  if (!notice) {
    recorded.delete(id);
    if (recorder?.id === id) stopRecorder();
    return;
  }
  if (!recorded.has(id)) {
    recorded.add(id);
    speak(CALL_PROMPT_TEXT["call.recorded"]);
    log("•", `recorded by ${notice.by}`);
  }
  if (!notice.ticket || recorder?.ticket === notice.ticket) return;
  if (recorder) stopRecorder();
  const rec = new CallRecorder({
    ticket: notice.ticket,
    maxMs: notice.maxMs ?? RECORDING_MAX_MS,
    onDone: (r) => log("•", r.ok ? "recording uploaded" : `recording not saved: ${r.message}`),
  });
  const mine = call?.callId === id ? call : undefined;
  rec.add(mine?.mic);
  const remote = mine?.media?.pc.getReceivers()[0]?.track;
  if (remote) rec.add(new MediaStream([remote]));
  if (roomAudio?.roomId === id) {
    rec.add(roomMic);
    for (const s of roomStreams) rec.add(s);
  }
  if (rec.start()) recorder = { id, ticket: notice.ticket, rec };
}

function stopRecorder(): void {
  const r = recorder;
  recorder = undefined;
  r?.rec.stop();
}

function closeCallAudio(c: CallAudio): void {
  c.media?.close();
  for (const t of c.mic?.getTracks() ?? []) t.stop();
  iceByCall.delete(c.callId);
}

function endCall(): void {
  if (recorder && recorder.id === call?.callId) stopRecorder();
  if (call && mergedCalls.has(call.callId)) lingerCall(call);
  else if (call) closeCallAudio(call);
  call = undefined;
  audioEl.srcObject = null;
}

/** A call merged into a room keeps playing until the room's audio is connected. */
function lingerCall(c: CallAudio): void {
  mergedCalls.delete(c.callId);
  for (const t of c.mic?.getAudioTracks() ?? []) t.enabled = true;
  const el = new Audio();
  el.autoplay = true;
  const remote = c.media?.pc.getReceivers()[0]?.track;
  if (remote) {
    el.srcObject = new MediaStream([remote]);
    void el.play().catch(() => {});
  }
  lingering.push({ ...(c.media ? { media: c.media } : {}), ...(c.mic ? { mic: c.mic } : {}), el });
  clearTimeout(lingerTimer);
  lingerTimer = setTimeout(endLinger, 15_000);
}

function endLinger(): void {
  clearTimeout(lingerTimer);
  for (const l of lingering.splice(0)) {
    l.media?.close();
    for (const t of l.mic?.getTracks() ?? []) t.stop();
    l.el.srcObject = null;
  }
}

/** In a room: start (or update) its audio. */
function enterRoom(msg: Extract<ServerToDevice, { t: "room.state" }>): void {
  const me = msg.participants.find((p) => p.id === msg.you);
  const first = !room;
  room = { name: msg.name, people: msg.participants.length, muted: me?.muted ?? false };
  activeLabel = msg.name;
  if (first) speak(CALL_PROMPT_TEXT[msg.kind === "call" ? "call.merged" : "room.joined"]);
  if (roomAudio?.roomId === msg.roomId) {
    roomAudio.update(msg);
    return;
  }
  void (async () => {
    micPromise ??= getMicrophone();
    const base = await micPromise.catch(() => undefined);
    if (!base || deviceState.kind !== "inroom" || deviceState.roomId !== msg.roomId) return;
    roomAudio?.close();
    roomMic = new MediaStream(base.getAudioTracks().map((t) => t.clone()));
    roomStreams = [];
    recorder?.rec.add(roomMic);
    roomAudio = new RoomAudio({
      roomId: msg.roomId,
      iceServers: iceByCall.get(msg.roomId) ?? [],
      microphone: roomMic,
      send: (m) => send(m),
      onStream: (stream) => {
        roomStreams.push(stream);
        if (recorder?.id === msg.roomId) recorder.rec.add(stream);
      },
      volume: settings.volume / 10,
      onConnected: () => {
        log("•", "room audio connected");
        endLinger();
      },
    });
    roomAudio.update(msg);
    for (const m of roomPending.splice(0)) roomAudio.handle(m);
  })();
}

function leaveRoomAudio(): void {
  if (recorder && recorder.id === roomAudio?.roomId) stopRecorder();
  roomAudio?.close();
  roomAudio = undefined;
  roomPending = [];
  room = undefined;
  endLinger();
}

// --- voicemail: leaving a message, recording the greeting ---------------------------------

/** Unanswered: their greeting, the tone, then record until the handset goes down. */
function startLeaving(offer: Extract<DeviceState, { kind: "voicemail" }>["offer"]): void {
  leaveFlow?.cancel();
  clearTimeout(leaveClear);
  const flow = new LeaveMessage({
    offer,
    voice,
    onState: (state) => {
      if (leaveFlow !== flow) return;
      leave = state;
      log("•", `voicemail: ${state.stage}`);
      clearInterval(leaveTicker);
      if (state.stage === "recording") leaveTicker = setInterval(renderDisplay, 1000);
      if (state.stage === "sent" || state.stage === "failed" || state.stage === "cancelled") {
        leaveClear = setTimeout(() => {
          if (leaveFlow !== flow) return;
          leave = undefined;
          leaveFlow = undefined;
          render();
        }, 4000);
      }
      render();
    },
  });
  leaveFlow = flow;
  void flow.start();
}

/** The server agreed (`greeting.ticket`): prompt, tone, record until a key or the limit, save. */
async function recordGreeting(kind: "name" | "custom", ticket: string, maxMs: number) {
  if (menu?.screen !== "greeting" || greetingRec?.kind !== kind) return;
  await voice.say(PROMPT_TEXT[kind === "name" ? "greet.say_name" : "greet.say_greeting"]);
  await voice.tone();
  if (greetingRec?.kind !== kind || menu?.screen !== "greeting") return;
  const recorder = new VoicemailRecorder(
    {
      onTick: () => {},
      onDone: (rec) =>
        void uploadGreeting(ticket, rec).then((r) => {
          log("•", `greeting ${r.ok ? "saved" : `not saved: ${r.message}`}`);
          greetingRec = undefined;
          if (menu?.screen === "greeting") {
            applyMenu({ type: "greeting-done", ok: r.ok, now: Date.now() });
          }
        }),
      onError: (message) => {
        log("•", `greeting: ${message}`);
        greetingRec = undefined;
        if (menu?.screen === "greeting")
          applyMenu({ type: "greeting-done", ok: false, now: Date.now() });
      },
    },
    maxMs,
  );
  greetingRec = { kind, stage: "recording", recorder };
  await recorder.start();
}

// --- physical controls -----------------------------------------------------------

/** Lifting the handset with a recorded notice showing plays it in the earpiece. */
function playNoticeAudio(): void {
  if (!notice?.audio) return;
  stopNoticeAudio();
  const el = new Audio(
    `/api/notices/${encodeURIComponent(notice.id)}/audio?token=${encodeURIComponent(notice.audio.token)}`,
  );
  el.volume = settings.volume / 10;
  // Over and over until the handset goes down or a key clears the notice.
  el.loop = true;
  void el.play().catch((e) => log("•", `notice audio: ${e}`));
  noticeAudio = el;
}

function stopNoticeAudio(): void {
  noticeAudio?.pause();
  noticeAudio = undefined;
}

function toggleHook(): void {
  tones.unlock();
  unlockChime();
  // A notice's recording plays when the handset comes up, and stops when it goes down.
  if (!hookUp && deviceState.kind === "idle" && notice?.audio && !menu) playNoticeAudio();
  else stopNoticeAudio();
  hookUp = !hookUp;
  if (hookUp && !micPromise) {
    micPromise = getMicrophone();
    micPromise.catch((e) => {
      log("•", `microphone unavailable: ${e}`);
      micPromise = undefined;
    });
  }
  step({ type: "hook", state: hookUp ? "up" : "down" });
}

function flash(key: KeyId): void {
  const el = keyEls.get(key);
  el?.classList.add("is-pressed");
  setTimeout(() => el?.classList.remove("is-pressed"), 140);
}

function canUseMenu(): boolean {
  if (!authed || pairingCode) return false;
  // In a call or a room, MENU offers hold / add caller, merge, transfer, mute.
  if (callActions(deviceState).length > 0) return true;
  return !hookUp && deviceState.kind === "idle";
}

function pressKey(key: KeyId): void {
  tones.unlock();
  unlockChime();
  flash(key);
  if (!authed || pairingCode) return; // keys do nothing until the phone is paired and online
  // Lounge takeover: the person proves they're here by pressing the glowing key.
  if (lounge.challenge && isDigit(key)) {
    send({ t: "lounge.press", index: slotOf(Number(key)) });
    return;
  }
  const now = Date.now();
  // Listening to voicemail: 1 again, 2 next, BACK stop; other keys do nothing meanwhile.
  if (vm && !menu) {
    if (key === "back") vmApply({ type: "key", key: "back", now });
    else if (key === "1" || key === "2") vmApply({ type: "key", key: Number(key) as 1 | 2, now });
    return;
  }
  if (key === "menu") {
    if (menu || canUseMenu()) applyMenu({ type: "menu", now });
    return;
  }
  // A notice's recording playing with the handset up: any key stops it and clears the notice.
  if (noticeAudio && hookUp && deviceState.kind === "offhook" && !menu) {
    dismissNotice();
    return;
  }
  if (key === "back") {
    if (menu) applyMenu({ type: "back", now });
    else if (notice && deviceState.kind === "idle") dismissNotice();
    // Ringing: BACK silences the ringer on this phone (lifting still answers).
    else if (deviceState.kind === "incoming") step({ type: "silence" });
    return;
  }
  const digit = Number(key);
  if (menu) {
    applyMenu({ type: "digit", digit, now });
    return;
  }
  // A notice showing on the ready screen: any key dismisses it (on this phone).
  if (notice && !hookUp && deviceState.kind === "idle") {
    dismissNotice();
    return;
  }
  // In a room any key answers "still there?".
  if (deviceState.kind === "inroom" && room?.idleWarning) room = { ...room, idleWarning: false };
  // Speed dial: digit 1–9 → slot 0–8, digit 0 → slot 9.
  step({ type: "button", index: slotOf(digit) });
}

function dismissNotice(): void {
  if (!notice) return;
  send({ t: "notice.dismiss", id: notice.id });
  notice = undefined;
  stopNoticeAudio();
  render();
}

function menuContext() {
  return {
    missedCount: config?.missed?.filter(isVoicemail).length ?? 0,
    ...(variant !== "lounge"
      ? { calls: { missed: missedEntries(config, Date.now(), utcOffsetMin) } }
      : {}),
    play:
      variant === "personal"
        ? ("play" as const)
        : variant === "kids"
          ? ("kids" as const)
          : ("app" as const),
    fw: FW,
    fingerprint,
    ...(lounge.session ? { lounge: { openToChat: lounge.session.openToChat } } : {}),
    ...(config?.greeting && variant !== "lounge" ? { greeting: config.greeting } : {}),
    ...(callActions(deviceState).length ? { call: { actions: callActions(deviceState) } } : {}),
    ...(config?.extensions ? { extensions: true } : {}),
  };
}

function vmPlayedMs(): number {
  return vmAudio ? Math.floor(vmAudio.currentTime * 1000) : 0;
}

function vmApply(event: VmEvent): void {
  const r = vmStep(vm, event);
  vm = r.player;
  for (const id of r.heard) send({ t: "voicemail.heard", id });
  if (r.stop || r.play) {
    vmAudio?.pause();
    vmAudio = undefined;
  }
  if (r.play?.ticket) {
    const t = r.play.ticket;
    const el = new Audio(
      /^https?:\/\//.test(t) ? t : `/api/vm/play?ticket=${encodeURIComponent(t)}`,
    );
    el.volume = settings.volume / 10;
    el.addEventListener("ended", () => vmApply({ type: "ended", now: Date.now() }));
    el.addEventListener("error", () => vmApply({ type: "failed", now: Date.now() }));
    void el.play().catch(() => vmApply({ type: "failed", now: Date.now() }));
    vmAudio = el;
  }
  if (vm && !vmTicker) {
    vmTicker = setInterval(() => vmApply({ type: "tick", now: Date.now() }), 500);
  } else if (!vm && vmTicker) {
    clearInterval(vmTicker);
    vmTicker = undefined;
  }
  render();
}

function applyMenu(event: MenuEvent): void {
  const was = menu;
  const r = menuStep(menu, settings, event, menuContext());
  menu = r.state;
  if (r.settings !== settings) applySettings(r.settings);
  if (r.action?.type === "chat") send({ t: "lounge.chat", open: r.action.open });
  if (r.action?.type === "logout") send({ t: "lounge.leave" });
  if (r.action?.type === "greeting") {
    greetingRec = { kind: r.action.kind, stage: "asking" };
    send({ t: "greeting.begin", kind: r.action.kind });
  }
  if (r.action?.type === "greeting-stop") {
    // Recording: stop and save. Still waiting for the server: forget it.
    if (greetingRec?.recorder?.recording) greetingRec.recorder.stop();
    else greetingRec = undefined;
  }
  if (r.action?.type === "greeting-cancel") {
    greetingRec?.recorder?.cancel();
    greetingRec = undefined;
    voice.stop();
  }
  if (r.action?.type === "greeting-reset") send({ t: "greeting.reset" });
  if (r.action?.type === "vm-play") {
    vm = vmStart(false, Date.now());
    send({ t: "voicemail.fetch" });
  }
  if (r.action?.type === "vm-clear") {
    // Clear: every message is heard (missed calls are cleared on MENU 5).
    vm = vmStart(true, Date.now());
    send({ t: "voicemail.fetch" });
  }
  if (r.action?.type === "missed-clear") send({ t: "missed.clear" });
  if (r.action?.type === "call-back") {
    // Calling back needs the handset up (the browser phone lifts it, as for an extension).
    if (!hookUp) toggleHook();
    step({ type: "callBack", id: r.action.id });
  }
  if (r.action?.type === "redial") {
    const last = loadLastDial(storage, profile);
    if (!last) speak("Nothing to redial yet.");
    else {
      if (!hookUp) toggleHook();
      step(redialInput(last));
    }
  }
  if (r.action?.type === "extension") {
    // Dialing needs the handset up.
    if (!hookUp) toggleHook();
    step({ type: "extension", number: r.action.number });
  }
  if (r.action?.type === "call") {
    const action = r.action.action;
    if (action === "mute" || action === "unmute") roomAudio?.setMuted(action === "mute");
    if (room && (action === "mute" || action === "unmute"))
      room = { ...room, muted: action === "mute" };
    step({ type: "action", action });
    // Call prompts are spoken on every phone (phones without a display already spoke it).
    if (r.say && displayMode !== "none") speak(r.say);
  }
  // Phones without a display speak the menu; the others can show it.
  // Greeting results are always spoken; its recording prompt is spoken when recording starts.
  const spoken = displayMode === "none" || event.type === "greeting-done";
  if (r.say && spoken && r.action?.type !== "greeting") speak(r.say);
  if (was && !menu && displayMode === "none" && event.type !== "exit") speak("Menu closed.");
  if (menu && !menuTicker) {
    menuTicker = setInterval(() => applyMenu({ type: "tick", now: Date.now() }), 1000);
  } else if (!menu && menuTicker) {
    clearInterval(menuTicker);
    menuTicker = undefined;
  }
  render();
}

function applySettings(next: Settings): void {
  settings = next;
  audioEl.volume = settings.volume / 10;
  const level = settings.brightness / 5;
  displayEl.style.setProperty("--brightness", String(level));
  brightnessEl.value = String(Math.round(level * 100));
  log("•", `settings ${JSON.stringify(settings)}`);
}

for (const [r, row] of KEY_ROWS.entries()) {
  for (const key of row) {
    const el = document.createElement("button");
    el.type = "button";
    el.className = isDigit(key) ? "key" : "key key--fn";
    el.dataset.key = key;
    const face = isDigit(key) ? key : key.toUpperCase();
    el.innerHTML = `<span class="key__cap"><span class="key__num">${face}</span><span class="key__legend"></span></span>`;
    el.addEventListener("click", () => pressKey(key));
    keyRowEls[r]?.append(el);
    keyEls.set(key, el);
  }
}
handsetEl.addEventListener("click", toggleHook);
hookKeyEl.addEventListener("click", toggleHook);

document.addEventListener("keydown", (e) => {
  if (
    e.target instanceof HTMLInputElement ||
    e.target instanceof HTMLSelectElement ||
    e.repeat ||
    e.metaKey ||
    e.ctrlKey
  ) {
    return;
  }
  if (e.code === "Space") {
    e.preventDefault();
    toggleHook();
    return;
  }
  const key = keyFromKeyboard(e.key);
  if (key) {
    e.preventDefault();
    pressKey(key);
  }
});

// --- developer panel controls ----------------------------------------------------

const pctEl = $<HTMLInputElement>('[data-battery="pct"]');
const pctOut = $<HTMLOutputElement>('[data-battery="out"]');
const chargingEl = $<HTMLInputElement>('[data-battery="charging"]');
/** The panel's values replace the real battery from the first touch on. */
function panelBattery(): void {
  batteryFromPanel = true;
  battery = { pct: Number(pctEl.value), charging: chargingEl.checked };
  pctOut.value = `${battery.pct}%`;
}
pctEl.addEventListener("input", () => {
  panelBattery();
  render();
});
pctEl.addEventListener("change", sendStatus);
const sourceEl = $<HTMLSelectElement>('[data-power="source"]');
sourceEl.addEventListener("change", () => {
  powerSource = sourceEl.value as PowerSource;
  sendStatus();
  render();
});
$<HTMLElement>('[data-power="variant"]').textContent = VARIANT_NAME[variant];
chargingEl.addEventListener("change", () => {
  panelBattery();
  sendStatus();
  render();
});

/** The device's own battery (Chrome and Android share it; Safari and Firefox don't). */
async function watchBattery(): Promise<void> {
  type BatteryLike = EventTarget & { level: number; charging: boolean };
  const nav = navigator as Navigator & { getBattery?(): Promise<BatteryLike> };
  if (!nav.getBattery) return;
  try {
    const b = await nav.getBattery();
    const update = () => {
      if (batteryFromPanel) return;
      battery = { pct: Math.round(b.level * 100), charging: b.charging };
      pctEl.value = String(battery.pct);
      pctOut.value = `${battery.pct}%`;
      chargingEl.checked = battery.charging;
      sendStatus();
      render();
    };
    b.addEventListener("levelchange", update);
    b.addEventListener("chargingchange", update);
    update();
  } catch {
    // Not shared here: report no battery.
  }
}
void watchBattery();
$<HTMLButtonElement>(".devpanel__forget").addEventListener("click", async () => {
  socket.close();
  await forgetIdentity(profile);
  location.reload();
});

// --- device mode: first-run choice, one tap to start, screen kept on -------------------

const awake = new ScreenAwake(
  (navigator as Navigator & { wakeLock?: WakeLockLike }).wakeLock,
  () => document.visibilityState === "visible",
);
let started = false;

function showStart(): void {
  const screen = startScreen({ kind: chosenKind, paired: !!getDeviceId(profile), started });
  startEl.hidden = screen === "none";
  startEl.dataset.screen = screen;
}

/** The first tap: allows sound, asks for the microphone once, keeps the screen on. */
function start(kind?: Variant): void {
  if (kind) {
    chosenKind = kind;
    variant = kind;
    saveKind(storage, profile, kind);
    $<HTMLElement>('[data-power="variant"]').textContent = VARIANT_NAME[kind];
    if (authed || getDeviceId(profile)) sendStatus();
    else beginPairing();
  }
  started = true;
  showStart();
  tones.unlock();
  unlockChime();
  void awake.enable();
  // Ask for the microphone now, so the first call doesn't stop at a permission prompt. The
  // stream is closed again right away; lifting the handset opens it for real.
  if (!micPromise && "mediaDevices" in navigator) {
    void getMicrophone().then(
      (s) => {
        for (const t of s.getTracks()) t.stop();
      },
      (e) => log("•", `microphone unavailable: ${e}`),
    );
  }
  // Fill the screen on phones and tablets (ignored where not allowed, e.g. iOS Safari).
  if (matchMedia("(pointer: coarse)").matches && !document.fullscreenElement) {
    void document.documentElement.requestFullscreen?.().catch(() => {});
  }
  render();
}

for (const el of startEl.querySelectorAll<HTMLButtonElement>(".start__kind")) {
  el.addEventListener("click", () => start(el.dataset.kind as Variant));
}
$<HTMLButtonElement>(".start__go").addEventListener("click", () => start());
document.addEventListener("visibilitychange", () => {
  void awake.onVisibilityChange();
  // Back from the background (or a sleeping tablet): reconnect now instead of after backoff.
  if (document.visibilityState === "visible") socket.retryNow();
  render();
});
// The network changed (Wi-Fi ↔ cellular, router restart): the old socket is probably dead.
addEventListener("online", () => socket.reconnect());
if (devMode) $<HTMLElement>(".devpanel").hidden = false;
if ("serviceWorker" in navigator && !import.meta.env.DEV) {
  void navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`).catch(() => {});
}
showStart();

// --- pairing announcement (no screen needed) ---------------------------------------

/** Speaks through the handset (on hardware: pre-recorded prompts). Replaces anything playing. */
function speak(text: string): void {
  if (!("speechSynthesis" in window)) return;
  speechSynthesis.cancel();
  speechSynthesis.speak(new SpeechSynthesisUtterance(text));
}

function announce(): void {
  if (!pairingCode) return;
  speak(`Your pairing code is ${pairingCode.split("").join(". ")}.`);
}

function updateAnnouncement(): void {
  const want = Boolean(pairingCode && hookUp);
  if (want && !announceTimer) {
    announce();
    announceTimer = setInterval(announce, ANNOUNCE_INTERVAL_MS);
  } else if (!want && announceTimer) {
    clearInterval(announceTimer);
    announceTimer = undefined;
    if ("speechSynthesis" in window) speechSynthesis.cancel();
  }
}

// --- rendering -----------------------------------------------------------------------

function render(): void {
  handsetEl.setAttribute("aria-pressed", String(hookUp));
  hookKeyEl.setAttribute("aria-pressed", String(!hookUp)); // the switch is down on the hook
  handsetLabelEl.textContent = hookUp
    ? "Hang up"
    : deviceState.kind === "incoming"
      ? "Answer"
      : "Lift handset";

  // Keys have no lights on the minimal board: just their names (Kids Lite prints them on the caps).
  for (let slot = 0; slot < SLOT_COUNT; slot++) {
    const digit = digitOf(slot);
    const el = keyEls.get(String(digit) as KeyId);
    if (!el) continue;
    const name = labelFor(slot);
    const legend = el.querySelector(".key__legend");
    if (legend) legend.textContent = displayMode === "none" ? (name ?? "") : "";
    el.setAttribute("aria-label", `Key ${digit}${name ? `: ${name}` : ""}`);
  }
  // One red status LED, which is also the recording light (docs/phone-ux.md).
  const recOn = recordedNow();
  const led = statusLed({
    deviceState,
    config,
    pairing: Boolean(pairingCode),
    connection,
    recording: recOn,
  });
  statusLedEl.dataset.mode = led;
  statusLedEl.setAttribute(
    "aria-label",
    recOn ? "Status light: recording" : `Status light: ${led}`,
  );

  renderDisplay();
  maybeRefreshQr();

  const muted = pairingCode || !authed;
  tones.play(muted ? "none" : soundFor(deviceState));
  updateAnnouncement();

  fact("profile").textContent = profile;
  fact("connection").textContent = `${connection}${authed ? " (authenticated)" : ""}`;
  fact("deviceId").textContent = getDeviceId(profile) ?? "— (unpaired)";
  fact("pairing").textContent = pairingCode ?? "—";
  fact("autopair").textContent = autopairStatus;
  fact("state").textContent = JSON.stringify(deviceState);
  fact("config").textContent = config
    ? JSON.stringify({ buttons: config.buttons, quiet: config.quiet })
    : "—";
  fact("quietUntil").textContent = config?.quiet ? (config.quietUntil ?? "(no end)") : "—";
  fact("missed").textContent = config?.missed?.length
    ? config.missed.map((m) => m.from).join(", ")
    : "—";
  fact("menu").textContent = menu ? menu.screen : "closed";
  fact("fingerprint").textContent = fingerprint.join(" ");
  fact("settings").textContent =
    `volume ${settings.volume}/10 · brightness ${settings.brightness}/5`;
}

/** The voicemail flow as the display shows it. */
function leaveView() {
  if (!leave || leave.stage === "cancelled") return undefined;
  if (leave.stage === "recording") {
    return { stage: "recording" as const, remainingMs: leave.maxMs - leave.elapsed };
  }
  return { stage: leave.stage };
}

function renderDisplay(): void {
  const view = menu ? menuView(menu, settings, menuContext()) : undefined;
  const loungeLive = variant === "lounge" && authed && !pairingCode && connection === "online";
  // A notice from the space shows on an idle Lounge phone too (over its takeover text).
  const loungeText =
    loungeLive && !view && !(notice && deviceState.kind === "idle")
      ? loungeLines(lounge, deviceState)
      : undefined;
  const deviceId = getDeviceId(profile);
  const qr =
    loungeLive && deviceId && lounge.nonce && showQr(lounge, deviceState, !!view, Date.now())
      ? loungeUrl(location.origin, deviceId, lounge.nonce.nonce)
      : undefined;
  const lines = loungeText
    ? loungeText
    : vm && !view
      ? displayMode === "segments"
        ? vmLines(vm, vmPlayedMs()).slice(0, 2)
        : vmLines(vm, vmPlayedMs())
      : view
        ? displayMode === "segments"
          ? menuLines(view, Date.now())
          : [view.title, ...(view.detail ?? [])]
        : statusLines({
            // Connected but not yet signed in (or given a pairing code): still connecting.
            connection:
              connection === "online" && !authed && !pairingCode ? "connecting" : connection,
            ...(pairingCode ? { pairingCode } : {}),
            deviceState,
            ...(config ? { config } : {}),
            ...(activeLabel ? { activeLabel } : {}),
            ...(callStartedAt !== undefined ? { callStartedAt } : {}),
            ...(call?.reconnecting ? { reconnecting: true } : {}),
            ...(call?.poor ? { poor: true } : {}),
            ...(leaveView() ? { leave: leaveView() } : {}),
            ...(room ? { room } : {}),
            ...(recordedNow() ? { recording: true } : {}),
            ...(battery ? { battery } : {}),
            power: powerStatus(variant, powerSource),
            clock: new Date().toTimeString().slice(0, 5),
            ...(notice && deviceState.kind === "idle" ? { notice } : {}),
            now: Date.now(),
          });
  // The key map needs a signed-in phone; while pairing or offline the status says it all.
  const grid =
    authed &&
    !pairingCode &&
    !lounge.challenge &&
    !(loungeLive && !lounge.session && !lounge.houseLine && !view)
      ? keyGrid(config, view)
      : undefined;
  const text = JSON.stringify([lines, displayMode === "eink" ? grid : null, qr]);
  if (text === lastStatusText) return;
  lastStatusText = text;
  displayEl.setAttribute("aria-label", lines.join(". "));
  if (displayMode === "none") return; // Kids Lite: no display; status is LEDs + voice
  if (displayMode === "segments") {
    renderSegments(displayEl, lines, STATUS_WIDTH);
    return;
  }
  epd = {
    lines,
    grid,
    qr,
    menu: view,
    offhook: deviceState.kind === "offhook" && !deviceState.held,
  };
  drawEpaper();
  // E-paper: fast partial refreshes, a full one (it flashes) every 20 changes, as on the board.
  if (++epdChanges % 20 === 0) {
    displayEl.classList.remove("display--refresh");
    void displayEl.offsetWidth;
    displayEl.classList.add("display--refresh");
  }
}

// --- the e-paper, drawn as the firmware draws it (epaper.ts) ----------------------------

/** The menu as the board shows it: the title, then "1 VOLUME 2 VOICEMAIL"… in 20-character lines. */
function menuScreen(view: MenuView): string[] {
  if (view.detail?.length) return [view.title, ...view.detail].slice(0, 4);
  const items = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "0"]
    .map((d) => [d, view.labels[Number(d)]] as const)
    .filter(([, l]) => l)
    .map(([d, l]) => `${d} ${l}`.toUpperCase());
  const out: string[] = [];
  for (const item of items) {
    const last = out[out.length - 1];
    if (last !== undefined && last.length + 1 + item.length <= 20)
      out[out.length - 1] = `${last} ${item}`;
    else out.push(item);
  }
  return [view.title, ...out].slice(0, 4);
}

function drawEpaper(): void {
  if (displayMode !== "eink") return;
  if (epdCanvas.parentElement !== displayEl) displayEl.replaceChildren(epdCanvas);
  const f = frame();
  const step = Math.floor(Date.now() / MARQUEE_STEP_MS);
  let shown: string[] = [];
  if (epd.qr) {
    loungeCode(
      f,
      encode(epd.qr, { border: 0 }).data,
      epd.lines[1] ?? "",
      config?.owner?.space ?? "",
    );
  } else if (epd.menu) {
    shown = menuScreen(epd.menu);
    epdLines(f, shown, step);
  } else if (epd.grid && epd.offhook) {
    // Handset up, nothing dialled: whose phone it is and who is on each key (screens.c).
    const g = epd.grid;
    const labels = [...(g[0] ?? []).slice(0, 5), ...(g[1] ?? []).slice(0, 5)];
    const footer =
      epd.lines.length > 1 ? `${epd.lines[0]} - ${epd.lines[1]}` : "PRESS A KEY TO CALL";
    keyMap(f, config?.owner ? ownerLine(config.owner) : "SPEED DIAL", labels, footer, step);
    shown = [...labels, footer];
  } else {
    shown = epd.lines;
    epdLines(f, shown, step);
  }
  const ctx = epdCanvas.getContext("2d");
  if (ctx) {
    const img = ctx.createImageData(250, 122);
    paint(f, img.data, EPD_INK, EPD_PAPER);
    ctx.putImageData(img, 0, 0);
  }
  // Long names scroll (marquee.c): redraw while anything is wider than its line.
  const scrolls = shown.some(
    (l) => l.length > lineCapacity(Math.max(1, Math.min(4, shown.length))),
  );
  if (scrolls && !epdScroll) epdScroll = setInterval(drawEpaper, MARQUEE_STEP_MS);
  else if (!scrolls && epdScroll) {
    clearInterval(epdScroll);
    epdScroll = undefined;
  }
}

displayEl.classList.add(`display--${displayMode}`);
const brightnessEl = $<HTMLInputElement>('[data-display="brightness"]');
brightnessEl.addEventListener("input", () =>
  displayEl.style.setProperty("--brightness", String(Number(brightnessEl.value) / 100)),
);

render();

// The ready screen's clock: redraw when the minute changes.
let clockMinute = new Date().getMinutes();
setInterval(() => {
  const minute = new Date().getMinutes();
  if (minute === clockMinute) return;
  clockMinute = minute;
  render();
}, 5000);
