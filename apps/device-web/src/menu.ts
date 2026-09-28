/**
 * The phone's on-device menu. MENU opens it; each digit picks the option shown for it on the
 * display (or spoken, on phones without one); BACK steps out. Pure, so firmware can mirror it.
 */
import { STATUS_WIDTH } from "./strip.ts";

export type MenuScreen = "root" | "volume" | "voicemail" | "speaker" | "brightness" | "about";

export interface MenuState {
  screen: MenuScreen;
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
  /** Handset lifted or a call arrived: leave immediately. */
  | { type: "exit" };

export interface MenuContext {
  /** Callers with unheard voicemail. */
  missedCount: number;
  fw: string;
  /** A Lounge phone someone is using: adds "Open to chat" and "Log out". */
  lounge?: { openToChat: boolean };
}

/** Something the phone must tell the server (Lounge phone menu items). */
export type MenuAction = { type: "chat"; open: boolean } | { type: "logout" };

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
        labels: {},
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
    case "about":
      return { ...base, title: `FW ${ctx.fw}`.toUpperCase(), labels: {} };
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
    case "voicemail":
      return ctx.missedCount
        ? `You have voicemail from ${ctx.missedCount} ${ctx.missedCount === 1 ? "person" : "people"}. Playing messages on the phone is not available yet; a grown-up can play them in the app.`
        : "You have no new voicemail.";
    case "speaker":
      return `Speakerphone is ${settings.speakerphone ? "on" : "off"}. Press 1 for on, 2 for off.`;
    case "brightness":
      return `Brightness ${settings.brightness}. Press 1 for dimmer, 2 for brighter.`;
    case "about":
      return `Open Lounge Phone, firmware ${ctx.fw}.`;
  }
}

export function menuStep(
  state: MenuState | undefined,
  settings: Settings,
  event: MenuEvent,
  ctx: MenuContext,
): MenuResult {
  if (event.type === "exit") return { state: undefined, settings };
  if (event.type === "tick") {
    if (state && event.now - state.lastInput >= MENU_TIMEOUT_MS)
      return { state: undefined, settings };
    return { state, settings };
  }

  const enter = (screen: MenuScreen, s: Settings = settings): MenuResult => {
    const next = { screen, lastInput: event.now };
    return { state: next, settings: s, say: menuPrompt(next, s, ctx) };
  };

  if (!state) {
    return event.type === "menu" ? enter("root") : { state, settings };
  }
  const touched = { ...state, lastInput: event.now };

  if (event.type === "menu") {
    // MENU at the top closes the menu; anywhere else it returns to the top.
    return state.screen === "root" ? { state: undefined, settings } : enter("root");
  }
  if (event.type === "back") {
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
    case "brightness": {
      if (d !== 1 && d !== 2) return { state: touched, settings };
      const brightness = clamp(settings.brightness + (d === 2 ? 1 : -1), 1, 5);
      return {
        state: touched,
        settings: { ...settings, brightness },
        say: `Brightness ${brightness}`,
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
  const options = Object.entries(view.labels)
    .sort(([a], [b]) => (a === "0" ? 10 : Number(a)) - (b === "0" ? 10 : Number(b)))
    .map(([d, label]) => `${d} ${label}`);
  if (options.length === 0) return [clip(view.title), clip(`${view.backLabel} = BACK`)];
  const current = options[Math.floor(now / 2000) % options.length] as string;
  return [clip(view.title), clip(current)];
}
