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
import { type Connection, type DeviceConfig, hasNewMissed, ledsFor } from "./leds.ts";
import {
  DEFAULT_SETTINGS,
  type MenuEvent,
  type MenuState,
  menuLines,
  menuStep,
  menuView,
  type Settings,
} from "./menu.ts";
import { type PowerSource, parseVariant, powerStatus } from "./power.ts";
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
const startedAt = Date.now();
// The hardware display is undecided: a small e-ink stripe or 14-segment LED characters.
// `none` = Kids Lite (no display; keys carry printed labels), `segments` = 14-segment module.
const displayParam = params.get("display");
const displayMode =
  displayParam === "segments" ? "segments" : displayParam === "none" ? "none" : "eink";
const variant = parseVariant(params.get("variant"));
let powerSource: PowerSource = "3A";

const $ = <T extends Element>(sel: string) => document.querySelector(sel) as T;
const handsetEl = $<HTMLButtonElement>(".handset");
const keyRowEls = [$<HTMLDivElement>(".keys--top"), $<HTMLDivElement>(".keys--bottom")];
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
let menu: MenuState | undefined;
let settings: Settings = { ...DEFAULT_SETTINGS };
let menuTicker: ReturnType<typeof setInterval> | undefined;
const keyEls = new Map<KeyId, HTMLButtonElement>();

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
      buttons: SLOT_COUNT,
      display: displayMode === "segments" ? "seg14" : displayMode,
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
  const r = deviceStep(prev, input);
  deviceState = r.state;
  if (authed) for (const m of r.send) send(m);

  const s = deviceState;
  // Lifting the handset or an incoming call leaves the menu.
  if (menu && s.kind !== "idle") applyMenu({ type: "exit" });
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

function flash(key: KeyId): void {
  const el = keyEls.get(key);
  el?.classList.add("is-pressed");
  setTimeout(() => el?.classList.remove("is-pressed"), 140);
}

function canUseMenu(): boolean {
  return authed && !pairingCode && !hookUp && deviceState.kind === "idle";
}

function pressKey(key: KeyId): void {
  tones.unlock();
  unlockChime();
  flash(key);
  if (!authed || pairingCode) return; // keys do nothing until the phone is paired and online
  const now = Date.now();
  if (key === "menu") {
    if (menu || canUseMenu()) applyMenu({ type: "menu", now });
    return;
  }
  if (key === "back") {
    if (menu) applyMenu({ type: "back", now });
    return;
  }
  const digit = Number(key);
  if (menu) {
    applyMenu({ type: "digit", digit, now });
    return;
  }
  // Speed dial: digit 1–9 → slot 0–8, digit 0 → slot 9.
  step({ type: "button", index: slotOf(digit) });
}

function menuContext() {
  return { missedCount: config?.missed?.length ?? 0, fw: FW };
}

function applyMenu(event: MenuEvent): void {
  const was = menu;
  const r = menuStep(menu, settings, event, menuContext());
  menu = r.state;
  if (r.settings !== settings) applySettings(r.settings);
  // Phones without a display speak the menu; the others can show it.
  if (r.say && displayMode === "none") speak(r.say);
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
    el.innerHTML = `<span class="key__cap"><span class="key__num">${face}</span><span class="key__led"></span><span class="key__legend"></span></span>`;
    el.addEventListener("click", () => pressKey(key));
    keyRowEls[r]?.append(el);
    keyEls.set(key, el);
  }
}
handsetEl.addEventListener("click", toggleHook);

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
pctEl.addEventListener("input", () => {
  battery.pct = Number(pctEl.value);
  pctOut.value = `${battery.pct}%`;
  render();
});
pctEl.addEventListener("change", sendStatus);
const sourceEl = $<HTMLSelectElement>('[data-power="source"]');
sourceEl.addEventListener("change", () => {
  powerSource = sourceEl.value as PowerSource;
  sendStatus();
  render();
});
$<HTMLElement>('[data-power="variant"]').textContent = variant === "lounge" ? "Lounge" : "Kids";
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

  const view = menu ? menuView(menu, settings, menuContext()) : undefined;
  const leds = ledsFor({
    deviceState,
    config,
    pairing: Boolean(pairingCode),
    connection,
    buttons: SLOT_COUNT,
    activeKey,
    ...(view ? { menuSlots: Object.keys(view.labels).map((d) => slotOf(Number(d))) } : {}),
  });
  leds.keys.forEach((led, slot) => {
    const digit = digitOf(slot);
    const el = keyEls.get(String(digit) as KeyId);
    if (!el) return;
    el.dataset.color = led.color;
    el.dataset.mode = led.mode;
    // Kids Lite has no display: names are printed on the (relegendable) keycaps instead.
    const name = labelFor(slot);
    const legend = el.querySelector(".key__legend");
    if (legend) legend.textContent = displayMode === "none" ? (name ?? "") : "";
    el.setAttribute("aria-label", `Key ${digit}${name ? `: ${name}` : ""}`);
  });
  for (const key of ["menu", "back"] as const) {
    const el = keyEls.get(key);
    if (!el) continue;
    el.dataset.color = leds.fn.color;
    el.dataset.mode = leds.fn.mode;
    el.setAttribute("aria-label", key === "menu" ? "Menu" : "Back");
  }
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
  fact("menu").textContent = menu ? menu.screen : "closed";
  fact("settings").textContent = `volume ${settings.volume}/10 · speakerphone ${
    settings.speakerphone ? "on" : "off"
  } · brightness ${settings.brightness}/5`;
}

function renderDisplay(): void {
  const view = menu ? menuView(menu, settings, menuContext()) : undefined;
  const lines = view
    ? displayMode === "segments"
      ? menuLines(view, Date.now())
      : ([view.title] as [string])
    : statusLines({
        connection,
        ...(pairingCode ? { pairingCode } : {}),
        deviceState,
        ...(config ? { config } : {}),
        ...(activeLabel ? { activeLabel } : {}),
        ...(callStartedAt !== undefined ? { callStartedAt } : {}),
        battery,
        power: powerStatus(variant, powerSource),
        now: Date.now(),
      });
  // The key map needs a signed-in phone; while pairing or offline the status says it all.
  const grid = authed && !pairingCode ? keyGrid(config, view) : undefined;
  const text = JSON.stringify([lines, displayMode === "eink" ? grid : null]);
  if (text === lastStatusText) return;
  lastStatusText = text;
  displayEl.setAttribute("aria-label", lines.join(". "));
  if (displayMode === "none") return; // Kids Lite: no display; status is LEDs + voice
  if (displayMode === "segments") {
    renderSegments(displayEl, lines, STATUS_WIDTH);
    return;
  }
  const children: HTMLElement[] = lines.map((line) => {
    const div = document.createElement("div");
    div.className = "eink-line";
    div.textContent = line;
    return div;
  });
  if (grid) {
    // A small map of the keys: same order as the rows above and below the display.
    const map = document.createElement("div");
    map.className = "eink-grid";
    for (const [r, row] of grid.entries()) {
      for (const [c, label] of row.entries()) {
        const cell = document.createElement("div");
        const key = KEY_ROWS[r]?.[c];
        cell.className = `eink-cell${key && !isDigit(key) ? " eink-cell--fn" : ""}`;
        const num = document.createElement("span");
        num.className = "eink-cell__key";
        num.textContent = key && isDigit(key) ? key : "";
        const name = document.createElement("span");
        name.className = "eink-cell__label";
        name.textContent = label;
        cell.append(num, name);
        map.append(cell);
      }
    }
    children.push(map);
  }
  displayEl.replaceChildren(...children);
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
