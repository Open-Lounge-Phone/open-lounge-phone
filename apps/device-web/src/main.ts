import {
  CallMedia,
  getMicrophone,
  ProtocolSocket,
  type SocketStatus,
  socketUrl,
  TonePlayer,
} from "@opentincan/client";
import {
  type DeviceInput,
  type DeviceState,
  deviceStep,
  initialDeviceState,
  soundFor,
} from "@opentincan/core";
import {
  type DeviceToServer,
  decodeServerToDevice,
  fromBase64Url,
  type IceServer,
  PROTOCOL_VERSION,
  type ServerToDevice,
} from "@opentincan/protocol";
import { playChime, unlockChime } from "./chime.ts";
import {
  forgetIdentity,
  getDeviceId,
  loadOrCreateIdentity,
  setDeviceId,
  sign,
} from "./identity.ts";
import { type Connection, type DeviceConfig, hasNewMissed, ledsFor } from "./leds.ts";
import { renderSegments } from "./segments.ts";
import { MISSED_CYCLE_MS, STATUS_WIDTH, statusLines } from "./strip.ts";

type Signal = Extract<ServerToDevice, { t: "rtc.sdp" | "rtc.ice" }>;

const FW = "0.1.0";
const STATUS_INTERVAL_MS = 60_000;
const ANNOUNCE_INTERVAL_MS = 7_000;
const CLOSE_UNAUTHORIZED = 4401;
const CLOSE_REPLACED = 4000;

const params = new URLSearchParams(location.search);
const profile = params.get("profile")?.trim() || "default";
const keyCount = Math.min(8, Math.max(1, Math.trunc(Number(params.get("keys"))) || 4));
const startedAt = Date.now();
// The hardware display is undecided: a small e-ink stripe or 14-segment LED characters.
const displayMode = params.get("display") === "segments" ? "segments" : "eink";

const $ = <T extends Element>(sel: string) => document.querySelector(sel) as T;
const handsetEl = $<HTMLButtonElement>(".handset");
const keysEl = $<HTMLDivElement>(".keys");
const displayEl = $<HTMLDivElement>(".display");
const statusLedEl = $<HTMLSpanElement>(".status-led");
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
let pairingTimer: ReturnType<typeof setTimeout> | undefined;
let hookUp = false;
let activeKey: number | undefined;
let activeLabel: string | undefined;
const battery = { pct: 100, charging: true };
const iceByCall = new Map<string, IceServer[]>();
let call: { callId: string; media?: CallMedia; pending: Signal[] } | undefined;
let micPromise: Promise<MediaStream> | undefined;
let unauthorizedStreak = 0;
let announceTimer: ReturnType<typeof setInterval> | undefined;
let lastStatusText = "";
let callStartedAt: number | undefined;
let callTicker: ReturnType<typeof setInterval> | undefined;
let noticeTicker: ReturnType<typeof setInterval> | undefined;

const tones = new TonePlayer();
const identity = await loadOrCreateIdentity(profile);

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
    endCall();
    deviceState = hookUp ? { kind: "offhook" } : initialDeviceState;
    const deviceId = getDeviceId(profile);
    const hello: DeviceToServer = {
      t: "hello",
      proto: PROTOCOL_VERSION,
      model: "web-emulator",
      fw: FW,
      buttons: keyCount,
      display: "eink",
      ...(deviceId ? { deviceId } : {}),
    };
    raw(hello);
    log("→", hello);
    if (!deviceId) send({ t: "pair.begin", publicKey: identity.publicKey });
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

function forgetDeviceId(): void {
  unauthorizedStreak++;
  setDeviceId(profile, undefined);
  log("•", "server does not know this phone; it will pair again");
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
      pairingTimer = setTimeout(
        () => send({ t: "pair.begin", publicKey: identity.publicKey }),
        Math.max(5_000, msg.expiresAt - Date.now() - 5_000),
      );
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
      };
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
    case "call.state":
      step({ type: "server", msg });
      break;
    case "rtc.config":
      iceByCall.set(msg.callId, msg.iceServers);
      break;
    case "rtc.sdp":
    case "rtc.ice":
      if (call?.callId !== msg.callId) break;
      if (call.media) await call.media.handle(msg).catch((e) => log("•", `rtc error: ${e}`));
      else call.pending.push(msg);
      break;
    case "error":
      if (msg.code === "unauthorized" && getDeviceId(profile)) forgetDeviceId();
      break;
    default:
      break;
  }
  render();
}

function sendStatus(): void {
  if (!authed) return;
  send({
    t: "status",
    battery: { pct: battery.pct, charging: battery.charging },
    uptimeS: Math.floor((Date.now() - startedAt) / 1000),
  });
}
setInterval(sendStatus, STATUS_INTERVAL_MS);

// --- handset state machine -------------------------------------------------------

function labelFor(index: number): string | undefined {
  return config?.buttons.find((b) => b.index === index)?.label;
}

function step(input: DeviceInput): void {
  const prev = deviceState;
  const r = deviceStep(prev, input);
  deviceState = r.state;
  if (authed) for (const m of r.send) send(m);

  const s = deviceState;
  if (s.kind === "dialing") {
    activeKey = s.button;
    activeLabel = labelFor(s.button);
  } else if (s.kind === "incoming") {
    activeKey = config?.buttons.find((b) => b.label === s.from)?.index;
    activeLabel = s.from;
  } else if (s.kind === "idle") {
    activeKey = undefined;
    activeLabel = undefined;
  }

  if (
    input.type === "server" &&
    input.msg.t === "call.state" &&
    input.msg.state === "connecting" &&
    s.kind === "incall"
  ) {
    // The party that placed the call sends the offer.
    void startMedia(s.callId, prev.kind === "dialing");
  }
  if (s.kind !== "incall" && call) endCall();
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
  call = { callId, pending: [] };
  const mic = await micPromise?.catch(() => undefined);
  if (call?.callId !== callId) return; // ended while waiting for the microphone
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
      audioEl.srcObject = stream;
      void audioEl.play().catch(() => {});
    },
    onState: (state) => log("•", `peer connection ${state}`),
  });
  call.media = media;
  try {
    await media.start();
    for (const m of call.pending.splice(0)) await media.handle(m);
  } catch (e) {
    log("•", `media error: ${e}`);
  }
}

function endCall(): void {
  call?.media?.close();
  if (call) iceByCall.delete(call.callId);
  call = undefined;
  audioEl.srcObject = null;
}

// --- physical controls -----------------------------------------------------------

function toggleHook(): void {
  tones.unlock();
  unlockChime();
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

function pressKey(index: number): void {
  tones.unlock();
  unlockChime();
  const el = keysEl.children[index];
  el?.classList.add("is-pressed");
  setTimeout(() => el?.classList.remove("is-pressed"), 140);
  if (!authed || pairingCode) return; // keys do nothing until the phone is paired and online
  step({ type: "button", index });
}

for (let i = 0; i < keyCount; i++) {
  const key = document.createElement("button");
  key.type = "button";
  key.className = "key";
  key.innerHTML = `<span class="key__cap"><span class="key__num">${i + 1}</span><span class="key__led"></span><span class="key__legend"></span></span>`;
  key.addEventListener("click", () => pressKey(i));
  keysEl.append(key);
}
keysEl.style.setProperty("--cols", String(keyCount <= 4 ? 2 : 4));
handsetEl.addEventListener("click", toggleHook);

document.addEventListener("keydown", (e) => {
  if (e.target instanceof HTMLInputElement || e.repeat || e.metaKey || e.ctrlKey) return;
  if (e.code === "Space") {
    e.preventDefault();
    toggleHook();
    return;
  }
  const n = Number(e.key);
  if (Number.isInteger(n) && n >= 1 && n <= keyCount) pressKey(n - 1);
});

// --- developer panel controls ----------------------------------------------------

const pctEl = $<HTMLInputElement>('[data-battery="pct"]');
const pctOut = $<HTMLOutputElement>('[data-battery="out"]');
const chargingEl = $<HTMLInputElement>('[data-battery="charging"]');
pctEl.addEventListener("input", () => {
  battery.pct = Number(pctEl.value);
  pctOut.value = `${battery.pct}%`;
  render();
});
pctEl.addEventListener("change", sendStatus);
chargingEl.addEventListener("change", () => {
  battery.charging = chargingEl.checked;
  sendStatus();
  render();
});
$<HTMLButtonElement>(".devpanel__forget").addEventListener("click", async () => {
  socket.close();
  await forgetIdentity(profile);
  location.reload();
});

// --- pairing announcement (no screen needed) ---------------------------------------

function announce(): void {
  if (!pairingCode || !("speechSynthesis" in window)) return;
  const digits = pairingCode.split("").join(". ");
  speechSynthesis.cancel();
  speechSynthesis.speak(new SpeechSynthesisUtterance(`Your pairing code is ${digits}.`));
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

  const leds = ledsFor({
    deviceState,
    config,
    pairing: Boolean(pairingCode),
    connection,
    buttons: keyCount,
    activeKey,
  });
  leds.keys.forEach((led, i) => {
    const el = keysEl.children[i] as HTMLElement | undefined;
    if (!el) return;
    el.dataset.color = led.color;
    el.dataset.mode = led.mode;
    const legend = el.querySelector(".key__legend");
    if (legend) legend.textContent = labelFor(i) ?? "";
    el.setAttribute("aria-label", `Key ${i + 1}${labelFor(i) ? `: ${labelFor(i)}` : ""}`);
  });
  statusLedEl.dataset.color = leds.status.color;
  statusLedEl.dataset.mode = leds.status.mode;

  renderDisplay();

  const muted = pairingCode || !authed;
  tones.play(muted ? "none" : soundFor(deviceState));
  updateAnnouncement();

  fact("profile").textContent = profile;
  fact("connection").textContent = `${connection}${authed ? " (authenticated)" : ""}`;
  fact("deviceId").textContent = getDeviceId(profile) ?? "— (unpaired)";
  fact("pairing").textContent = pairingCode ?? "—";
  fact("state").textContent = JSON.stringify(deviceState);
  fact("config").textContent = config
    ? JSON.stringify({ buttons: config.buttons, quiet: config.quiet })
    : "—";
  fact("quietUntil").textContent = config?.quiet ? (config.quietUntil ?? "(no end)") : "—";
  fact("missed").textContent = config?.missed?.length
    ? config.missed.map((m) => m.from).join(", ")
    : "—";
}

function renderDisplay(): void {
  const lines = statusLines({
    connection,
    ...(pairingCode ? { pairingCode } : {}),
    deviceState,
    ...(config ? { config } : {}),
    ...(activeLabel ? { activeLabel } : {}),
    ...(callStartedAt !== undefined ? { callStartedAt } : {}),
    battery,
    now: Date.now(),
  });
  const text = lines.join("\n");
  if (text === lastStatusText) return;
  lastStatusText = text;
  displayEl.setAttribute("aria-label", lines.join(". "));
  if (displayMode === "segments") {
    renderSegments(displayEl, lines, STATUS_WIDTH);
    return;
  }
  displayEl.replaceChildren(
    ...lines.map((line) => {
      const div = document.createElement("div");
      div.className = "eink-line";
      div.textContent = line;
      return div;
    }),
  );
  // E-ink panels flash on a full refresh; skip it for the call timer's partial updates.
  if (!(deviceState.kind === "incall" && deviceState.connected)) {
    displayEl.classList.remove("display--refresh");
    void displayEl.offsetWidth;
    displayEl.classList.add("display--refresh");
  }
}

displayEl.classList.add(`display--${displayMode}`);
const brightnessEl = $<HTMLInputElement>('[data-display="brightness"]');
brightnessEl.addEventListener("input", () =>
  displayEl.style.setProperty("--brightness", String(Number(brightnessEl.value) / 100)),
);

render();
