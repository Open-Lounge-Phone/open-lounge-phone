import { describe, expect, it } from "vitest";
import {
  DEFAULT_SETTINGS,
  MENU_TIMEOUT_MS,
  type MenuEvent,
  type MenuState,
  menuLines,
  menuPrompt,
  menuStep,
  menuView,
  type Settings,
} from "./menu.ts";

const ctx = { missedCount: 2, fw: "0.1.0" };

function run(events: MenuEvent[], start?: MenuState, settings: Settings = DEFAULT_SETTINGS) {
  let state = start;
  let s = settings;
  const said: string[] = [];
  for (const e of events) {
    const r = menuStep(state, s, e, ctx);
    state = r.state;
    s = r.settings;
    if (r.say) said.push(r.say);
  }
  return { state, settings: s, said };
}

const menu = (now = 0): MenuEvent => ({ type: "menu", now });
const back = (now = 0): MenuEvent => ({ type: "back", now });
const digit = (d: number, now = 0): MenuEvent => ({ type: "digit", digit: d, now });

describe("menuStep", () => {
  it("opens with MENU and announces the options", () => {
    const r = run([menu()]);
    expect(r.state?.screen).toBe("root");
    expect(r.said[0]).toMatch(/^Menu\. Press 1 for volume\. .*Press 0 for about this phone\./);
  });

  it("ignores digits and BACK while closed (they're speed dial then)", () => {
    expect(run([digit(1), back()]).state).toBeUndefined();
  });

  it("navigates into a submenu, changes a setting, and steps back out", () => {
    const r = run([menu(), digit(1), digit(2), digit(2), back(), back()]);
    expect(r.state).toBeUndefined();
    expect(r.settings.volume).toBe(DEFAULT_SETTINGS.volume + 2);
    expect(r.said).toContain("Volume 8");
  });

  it("clamps volume and brightness", () => {
    const loud = run([menu(), digit(1), ...Array(20).fill(digit(2))]);
    expect(loud.settings.volume).toBe(10);
    const dim = run([menu(), digit(4), ...Array(20).fill(digit(1))]);
    expect(dim.settings.brightness).toBe(1);
  });

  it("toggles speakerphone", () => {
    expect(run([menu(), digit(3), digit(1)]).settings.speakerphone).toBe(true);
    expect(run([menu(), digit(3), digit(1), digit(2)]).settings.speakerphone).toBe(false);
  });

  it("MENU closes at the top and returns to the top from a submenu", () => {
    expect(run([menu(), menu()]).state).toBeUndefined();
    expect(run([menu(), digit(1), menu()]).state?.screen).toBe("root");
  });

  it("ignores unused digits without closing", () => {
    expect(run([menu(), digit(7)]).state?.screen).toBe("root");
  });

  it("times out after inactivity, counted from the last key press", () => {
    const open = run([menu(0), digit(1, 5_000)]).state;
    expect(
      menuStep(open, DEFAULT_SETTINGS, { type: "tick", now: 5_000 + MENU_TIMEOUT_MS - 1 }, ctx)
        .state,
    ).toBeDefined();
    expect(
      menuStep(open, DEFAULT_SETTINGS, { type: "tick", now: 5_000 + MENU_TIMEOUT_MS }, ctx).state,
    ).toBeUndefined();
  });

  it("exits immediately on handset lift or an incoming call", () => {
    const open = run([menu(), digit(2)]).state;
    expect(menuStep(open, DEFAULT_SETTINGS, { type: "exit" }, ctx).state).toBeUndefined();
  });

  it("says voicemail playback isn't available yet", () => {
    const r = run([menu(), digit(2)]);
    expect(r.said.at(-1)).toMatch(/2 people.*not available yet/);
  });
});

describe("menuView / menuLines", () => {
  it("labels the digits for the current screen", () => {
    const root = menuView({ screen: "root", lastInput: 0 }, DEFAULT_SETTINGS, ctx);
    expect(root.labels).toEqual({
      1: "Volume",
      2: "Voicemail",
      3: "Speaker",
      4: "Bright",
      0: "About",
    });
    expect(root.backLabel).toBe("Close");
    const vol = menuView({ screen: "volume", lastInput: 0 }, DEFAULT_SETTINGS, ctx);
    expect(vol.title).toBe("VOLUME 6/10");
    expect(vol.labels).toEqual({ 1: "Quieter", 2: "Louder" });
  });

  it("fits 16-character displays, cycling options with 0 last", () => {
    const root = menuView({ screen: "root", lastInput: 0 }, DEFAULT_SETTINGS, ctx);
    const seen = [0, 2000, 4000, 6000, 8000].map((t) => menuLines(root, t)[1]);
    expect(seen).toEqual(["1 VOLUME", "2 VOICEMAIL", "3 SPEAKER", "4 BRIGHT", "0 ABOUT"]);
    for (const line of seen) expect(line?.length ?? 0).toBeLessThanOrEqual(16);
  });

  it("prompts every screen in words", () => {
    for (const screen of [
      "root",
      "volume",
      "voicemail",
      "speaker",
      "brightness",
      "about",
    ] as const) {
      expect(menuPrompt({ screen, lastInput: 0 }, DEFAULT_SETTINGS, ctx).length).toBeGreaterThan(5);
    }
  });
});
