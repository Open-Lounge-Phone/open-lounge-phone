/**
 * The phone's on-device menu. MENU opens it; each digit picks the option shown for it on the
 * display (or spoken, on phones without one); BACK steps out. Pure, so firmware can mirror it.
 */
import { CALL_PROMPT_TEXT, type CallAction, PROMPT_TEXT } from "@openloungephone/core";
import { STATUS_WIDTH } from "./strip.ts";

export type MenuScreen =
  | "root"
  | "volume"
  | "voicemail"
  /** Recording the greeting: BACK (or any key) finishes. */
  | "greeting"
  | "speaker"
  | "brightness"
  | "about"
  /** During a call or in a room: hold / add caller, merge, transfer, mute. */
  | "call";

export interface MenuState {
  screen: MenuScreen;
  /** On the `greeting` screen: which greeting is being recorded. */
  recording?: "name" | "custom";
  /** Epoch ms of the last key press, for the inactivity timeout. */
  lastInput: number;
}

export interface Settings {
  /** Earpiece/ringer volume, 0–10. */
  volume: number;
  speakerphone: boolean;
  /** Display brightness level, 1–5. */
  brightness: number;
}

export const DEFAULT_SETTINGS: Settings = { volume: 6, speakerphone: false, brightness: 5 };
export const MENU_TIMEOUT_MS = 20_000;

export type MenuEvent =
  | { type: "menu"; now: number }
  | { type: "back"; now: number }
  | { type: "digit"; digit: number; now: number }
  | { type: "tick"; now: number }
  /** The greeting recording finished (saved, or not). */
  | { type: "greeting-done"; ok: boolean; notAllowed?: boolean; now: number }
  /** Handset lifted or a call arrived: leave immediately. */
  | { type: "exit" };

export interface MenuContext {
  /** Callers with unheard voicemail. */
  missedCount: number;
  fw: string;
  /** A Lounge phone someone is using: adds "Open to chat" and "Log out". */
  lounge?: { openToChat: boolean };
  /** The phone's voicemail greeting (absent on Lounge phones). */
  greeting?: { kind: "default" | "name" | "custom"; canRecord: boolean };
  /** The four words of this phone's key (the app shows the same ones: compare them). */
  fingerprint?: readonly string[];
  /** In a call or a room: what MENU offers there (see `callActions`), digit 1 upward. */
  call?: { actions: readonly CallAction[] };
}

/** Something the phone must do or tell the server (greetings, Lounge phone items). */
export type MenuAction =
  | { type: "chat"; open: boolean }
  | { type: "logout" }
  /** Ask to record a greeting (`greeting.begin`); the phone records once the server agrees. */
  | { type: "greeting"; kind: "name" | "custom" }
  /** Stop recording the greeting and save it. */
  | { type: "greeting-stop" }
  /** Interrupted (a call, the handset): discard it. */
  | { type: "greeting-cancel" }
  | { type: "greeting-reset" }
  /** A call or room action (hold/add caller, resume, merge, transfer, mute). */
  | { type: "call"; action: CallAction };

export interface MenuResult {
  /** undefined = menu closed. */
  state: MenuState | undefined;
  settings: Settings;
  /** Something worth announcing (spoken on phones without a display). */
  say?: string;
  action?: MenuAction;
}

export interface MenuView {
  title: string;
  /** Label per digit (0–9); missing = unused on this screen. */
  labels: Partial<Record<number, string>>;
  /** Label for the MENU and BACK keys on this screen. */
  menuLabel: string;
  backLabel: string;
  /** Extra lines under the title (About: the four fingerprint words, two per line). */
  detail?: string[];
}

/** The four words as two strip lines ("ACORN BELL" / "CEDAR DUCK"); words are ≤ 7 letters. */
export function fingerprintLines(words: readonly string[]): string[] {
  const up = words.map((w) => w.toUpperCase());
  return [up.slice(0, 2).join(" "), up.slice(2, 4).join(" ")].filter(Boolean);
}

/** Top-level options in keypad order (0 comes last, as on the phone). */
const ROOT_OPTIONS: { digit: number; label: string; screen: MenuScreen; spoken: string }[] = [
  { digit: 1, label: "Volume", screen: "volume", spoken: "volume" },
  { digit: 2, label: "Voicemail", screen: "voicemail", spoken: "voicemail" },
  { digit: 3, label: "Speaker", screen: "speaker", spoken: "speakerphone" },
  { digit: 4, label: "Bright", screen: "brightness", spoken: "brightness" },
  { digit: 0, label: "About", screen: "about", spoken: "about this phone" },
];

/** Lounge-session items on the top menu: 5 toggles "open to chat", 9 logs out. */
const CHAT_DIGIT = 5;
const LOGOUT_DIGIT = 9;

function rootLabels(ctx: MenuContext): Partial<Record<number, string>> {
  const labels: Partial<Record<number, string>> = Object.fromEntries(
    ROOT_OPTIONS.map((o) => [o.digit, o.label]),
  );
  if (ctx.lounge) {
    labels[CHAT_DIGIT] = ctx.lounge.openToChat ? "Chat off" : "Chat on";
    labels[LOGOUT_DIGIT] = "Log out";
  }
  return labels;
}

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

/** The call screen's labels and what each action says (prompt ids for firmware). */
const CALL_LABEL: Record<CallAction, string> = {
  hold: "Add caller",
  resume: "Resume",
  merge: "Merge",
  transfer: "Transfer",
  mute: "Mute",
  unmute: "Unmute",
};
const CALL_SPOKEN: Record<CallAction, string> = {
  hold: "put this call on hold and add a caller",
  resume: "go back to the call on hold",
  merge: "merge the calls",
  transfer: "transfer the call",
  mute: "mute",
  unmute: "unmute",
};

/** What the phone says after a call action (`CallPrompt` ids on hardware). */
export function callActionPrompt(action: CallAction, attended: boolean): string {
  switch (action) {
    case "hold":
      return CALL_PROMPT_TEXT["call.add"];
    case "transfer":
      return attended ? CALL_PROMPT_TEXT["call.transferred"] : CALL_PROMPT_TEXT["call.transfer"];
    case "mute":
      return CALL_PROMPT_TEXT["room.muted"];
    case "unmute":
      return CALL_PROMPT_TEXT["room.unmuted"];
    default:
      return "";
  }
}

/** Voicemail screen: 1 records your name, 2 a whole greeting, 3 goes back to the standard one. */
const GREETING_LABELS = { 1: "Name", 2: "Greeting", 3: "Default" } as const;
const GREETING_TEXT = { default: "standard", name: "your name", custom: "your own" } as const;

export function menuView(state: MenuState, settings: Settings, ctx: MenuContext): MenuView {
  const base = { menuLabel: "Close", backLabel: "Back" };
  switch (state.screen) {
    case "root":
      return {
        ...base,
        title: "MENU",
        labels: rootLabels(ctx),
        backLabel: "Close",
      };
    case "volume":
      return {
        ...base,
        title: `VOLUME ${settings.volume}/10`,
        labels: { 1: "Quieter", 2: "Louder" },
      };
    case "voicemail":
      return {
        ...base,
        title: ctx.missedCount ? `${ctx.missedCount} VOICEMAIL` : "NO VOICEMAIL",
        labels: ctx.greeting?.canRecord ? { ...GREETING_LABELS } : {},
      };
    case "greeting":
      return {
        ...base,
        title: state.recording === "name" ? "SAY YOUR NAME" : "RECORDING",
        labels: {},
        backLabel: "Done",
      };
    case "speaker":
      return {
        ...base,
        title: `SPEAKER ${settings.speakerphone ? "ON" : "OFF"}`,
        labels: { 1: "On", 2: "Off" },
      };
    case "brightness":
      return {
        ...base,
        title: `BRIGHT ${settings.brightness}/5`,
        labels: { 1: "Dimmer", 2: "Brighter" },
      };
    case "call":
      return {
        ...base,
        title: ctx.call?.actions.some((a) => a === "mute" || a === "unmute") ? "ROOM" : "CALL",
        labels: Object.fromEntries((ctx.call?.actions ?? []).map((a, i) => [i + 1, CALL_LABEL[a]])),
        backLabel: "Close",
      };
    case "about":
      return {
        ...base,
        title: `FW ${ctx.fw}`.toUpperCase(),
        labels: {},
        ...(ctx.fingerprint ? { detail: fingerprintLines(ctx.fingerprint) } : {}),
      };
  }
}

/** What to say on entering a screen (the whole screen, for phones without a display). */
export function menuPrompt(state: MenuState, settings: Settings, ctx: MenuContext): string {
  switch (state.screen) {
    case "root": {
      const lounge = ctx.lounge
        ? ` Press ${CHAT_DIGIT} to ${ctx.lounge.openToChat ? "stop being" : "be"} open to chat. Press ${LOGOUT_DIGIT} to log out.`
        : "";
      return `Menu. ${ROOT_OPTIONS.map((o) => `Press ${o.digit} for ${o.spoken}.`).join(" ")}${lounge} Press back to leave.`;
    }
    case "volume":
      return `Volume ${settings.volume}. Press 1 for quieter, 2 for louder.`;
    case "voicemail": {
      const messages = ctx.missedCount
        ? `You have voicemail from ${ctx.missedCount} ${ctx.missedCount === 1 ? "person" : "people"}. Playing messages on the phone is not available yet; a grown-up can play them in the app.`
        : "You have no new voicemail.";
      const g = ctx.greeting;
      if (!g) return messages;
      const now = ` Callers hear the ${GREETING_TEXT[g.kind]} greeting.`;
      return g.canRecord
        ? `${messages}${now} Press 1 to record your name, 2 to record a greeting, 3 for the standard greeting.`
        : `${messages}${now} ${PROMPT_TEXT["greet.not_allowed"]}`;
    }
    case "greeting":
      return state.recording === "name"
        ? PROMPT_TEXT["greet.say_name"]
        : PROMPT_TEXT["greet.say_greeting"];
    case "speaker":
      return `Speakerphone is ${settings.speakerphone ? "on" : "off"}. Press 1 for on, 2 for off.`;
    case "brightness":
      return `Brightness ${settings.brightness}. Press 1 for dimmer, 2 for brighter.`;
    case "call": {
      const options = (ctx.call?.actions ?? []).map(
        (a, i) => `Press ${i + 1} to ${CALL_SPOKEN[a]}.`,
      );
      return `${options.join(" ")} Press back to leave the menu.`;
    }
    case "about": {
      const words = ctx.fingerprint
        ? ` This phone's words are: ${ctx.fingerprint.join(", ")}. The app shows the same four words for this phone.`
        : "";
      return `Open Lounge Phone, firmware ${ctx.fw}.${words}`;
    }
  }
}

export function menuStep(
  state: MenuState | undefined,
  settings: Settings,
  event: MenuEvent,
  ctx: MenuContext,
): MenuResult {
  if (event.type === "exit") {
    // Leaving mid-recording (a call, the handset) keeps nothing.
    return state?.screen === "greeting"
      ? { state: undefined, settings, action: { type: "greeting-cancel" } }
      : { state: undefined, settings };
  }
  if (event.type === "tick") {
    // No timeout while recording: the recording has its own limit.
    if (state && state.screen !== "greeting" && event.now - state.lastInput >= MENU_TIMEOUT_MS)
      return { state: undefined, settings };
    return { state, settings };
  }
  if (event.type === "greeting-done") {
    if (!state) return { state, settings };
    const next: MenuState = { screen: "voicemail", lastInput: event.now };
    return {
      state: next,
      settings,
      say: event.ok
        ? PROMPT_TEXT["greet.saved"]
        : PROMPT_TEXT[event.notAllowed ? "greet.not_allowed" : "greet.not_saved"],
    };
  }

  const enter = (screen: MenuScreen, s: Settings = settings): MenuResult => {
    const next = { screen, lastInput: event.now };
    return { state: next, settings: s, say: menuPrompt(next, s, ctx) };
  };

  if (!state) {
    if (event.type !== "menu") return { state, settings };
    // During a call or in a room, MENU opens what can be done there.
    return ctx.call?.actions.length ? enter("call") : enter("root");
  }
  const touched = { ...state, lastInput: event.now };

  // Recording the greeting: any key finishes it (the phone then saves it and says so).
  if (state.screen === "greeting") {
    return { state: touched, settings, action: { type: "greeting-stop" } };
  }

  if (event.type === "menu") {
    // MENU at the top closes the menu; anywhere else it returns to the top.
    if (state.screen === "call") return { state: undefined, settings };
    return state.screen === "root" ? { state: undefined, settings } : enter("root");
  }
  if (event.type === "back") {
    if (state.screen === "call") return { state: undefined, settings };
    return state.screen === "root" ? { state: undefined, settings } : enter("root");
  }

  // digit
  const d = event.digit;
  switch (state.screen) {
    case "root": {
      if (ctx.lounge && d === CHAT_DIGIT) {
        const open = !ctx.lounge.openToChat;
        return {
          state: undefined,
          settings,
          say: open ? "You're open to chat." : "You're no longer open to chat.",
          action: { type: "chat", open },
        };
      }
      if (ctx.lounge && d === LOGOUT_DIGIT) {
        return { state: undefined, settings, say: "Logged out.", action: { type: "logout" } };
      }
      const option = ROOT_OPTIONS.find((o) => o.digit === d);
      return option ? enter(option.screen) : { state: touched, settings };
    }
    case "volume": {
      if (d !== 1 && d !== 2) return { state: touched, settings };
      const volume = clamp(settings.volume + (d === 2 ? 1 : -1), 0, 10);
      return { state: touched, settings: { ...settings, volume }, say: `Volume ${volume}` };
    }
    case "speaker": {
      if (d !== 1 && d !== 2) return { state: touched, settings };
      const speakerphone = d === 1;
      return {
        state: touched,
        settings: { ...settings, speakerphone },
        say: `Speakerphone ${speakerphone ? "on" : "off"}`,
      };
    }
    case "voicemail": {
      if (!ctx.greeting?.canRecord || (d !== 1 && d !== 2 && d !== 3)) {
        return { state: touched, settings };
      }
      if (d === 3) {
        return {
          state: touched,
          settings,
          say: PROMPT_TEXT["greet.default"],
          action: { type: "greeting-reset" },
        };
      }
      const kind = d === 1 ? "name" : "custom";
      const next: MenuState = { screen: "greeting", recording: kind, lastInput: event.now };
      return {
        state: next,
        settings,
        say: menuPrompt(next, settings, ctx),
        action: { type: "greeting", kind },
      };
    }
    case "brightness": {
      if (d !== 1 && d !== 2) return { state: touched, settings };
      const brightness = clamp(settings.brightness + (d === 2 ? 1 : -1), 1, 5);
      return {
        state: touched,
        settings: { ...settings, brightness },
        say: `Brightness ${brightness}`,
      };
    }
    case "call": {
      const actions = ctx.call?.actions ?? [];
      const action = actions[d - 1];
      if (!action) return { state: touched, settings };
      const attended = actions.includes("merge");
      const say = callActionPrompt(action, attended);
      return {
        state: undefined,
        settings,
        ...(say ? { say } : {}),
        action: { type: "call", action },
      };
    }
    default:
      return { state: touched, settings };
  }
}

/**
 * Two status-display lines for the menu on a 16-character display (14-segment mode): the title,
 * then the options one at a time.
 */
export function menuLines(view: MenuView, now: number): [string] | [string, string] {
  const clip = (s: string) => s.toUpperCase().slice(0, STATUS_WIDTH);
  const options = view.detail?.length
    ? view.detail
    : Object.entries(view.labels)
        .sort(([a], [b]) => (a === "0" ? 10 : Number(a)) - (b === "0" ? 10 : Number(b)))
        .map(([d, label]) => `${d} ${label}`);
  if (options.length === 0) return [clip(view.title), clip(`${view.backLabel} = BACK`)];
  const current = options[Math.floor(now / 2000) % options.length] as string;
  return [clip(view.title), clip(current)];
}
