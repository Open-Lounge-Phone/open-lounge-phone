import { describe, expect, it } from "vitest";
import {
  DEFAULT_SETTINGS,
  fingerprintLines,
  MENU_TIMEOUT_MS,
  type MenuContext,
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

describe("recording the greeting (MENU → Voicemail → 4)", () => {
  const g = (canRecord: boolean) => ({
    ...ctx,
    greeting: { kind: "default" as const, canRecord },
  });
  const step = (state: MenuState | undefined, e: MenuEvent, c = g(true)) =>
    menuStep(state, DEFAULT_SETTINGS, e, c);

  it("offers name, greeting and default under 4 when allowed", () => {
    const vm = step(step(undefined, menu()).state, digit(2)).state as MenuState;
    expect(vm.screen).toBe("voicemail");
    expect(menuView(vm, DEFAULT_SETTINGS, g(true)).labels).toMatchObject({ 4: "Greeting" });
    const greetings = step(vm, digit(4)).state as MenuState;
    expect(greetings.screen).toBe("greetings");
    expect(menuView(greetings, DEFAULT_SETTINGS, g(true)).labels).toEqual({
      1: "Name",
      2: "Greeting",
      3: "Default",
    });
    expect(menuView(greetings, DEFAULT_SETTINGS, g(true)).detail).toEqual(["NOW: STANDARD"]);
    expect(menuPrompt(greetings, DEFAULT_SETTINGS, g(true))).toMatch(/standard greeting\. Press 1/);
    const name = step(greetings, digit(1));
    expect(name.state).toMatchObject({ screen: "greeting", recording: "name" });
    expect(name.action).toEqual({ type: "greeting", kind: "name" });
    expect(name.say).toMatch(/Say your name after the tone/);
    // No menu timeout while recording; any key finishes it.
    expect(step(name.state, { type: "tick", now: MENU_TIMEOUT_MS * 3 }).state).toBeDefined();
    const done = step(name.state, back(5));
    expect(done.action).toEqual({ type: "greeting-stop" });
    const saved = step(done.state, { type: "greeting-done", ok: true, now: 6 });
    expect(saved.state?.screen).toBe("greetings");
    expect(saved.say).toBe("Greeting saved.");
    expect(step(greetings, digit(3)).action).toEqual({ type: "greeting-reset" });
    // BACK steps out to the voicemail screen.
    expect(step(greetings, back()).state?.screen).toBe("voicemail");
    // A call or the handset mid-recording discards it.
    expect(step(name.state, { type: "exit" }).action).toEqual({ type: "greeting-cancel" });
  });

  it("offers no greeting when the guardians turned it off", () => {
    const vm = step(step(undefined, menu()).state, digit(2), g(false)).state as MenuState;
    expect(menuView(vm, DEFAULT_SETTINGS, g(false)).labels).toEqual({});
    expect(step(vm, digit(4), g(false)).state?.screen).toBe("voicemail");
  });
});

describe("voicemail screen (MENU → 2), as on hardware", () => {
  const own = { ...ctx, play: "play" as const };
  const step = (state: MenuState | undefined, e: MenuEvent, c: MenuContext = own) =>
    menuStep(state, DEFAULT_SETTINGS, e, c);
  const open = (c: MenuContext) =>
    step(step(undefined, menu(), c).state, digit(2), c).state as MenuState;

  it("a person's own phone: 1 plays, 3 clears messages and missed call backs", () => {
    const c = { ...own, missedCallbacks: 1 };
    const vm = open(c);
    const view = menuView(vm, DEFAULT_SETTINGS, c);
    expect(view.title).toBe("2 NEW VOICEMAIL");
    expect(view.detail).toEqual(["1 MISSED CALL BACK"]);
    expect(view.labels).toEqual({ 1: "Play", 3: "Clear" });
    expect(menuPrompt(vm, DEFAULT_SETTINGS, c)).toMatch(
      /2 new voicemail messages\. Press 1 to play them\. You missed a call back.*Press 3 to clear/,
    );
    expect(step(vm, digit(1), c)).toMatchObject({ state: undefined, action: { type: "vm-play" } });
    expect(step(vm, digit(3), c).action).toEqual({
      type: "vm-clear",
      voicemail: true,
      callbacks: true,
    });
  });

  it("only call backs: 3 clears them; nothing at all: no Clear", () => {
    const c = { ...own, missedCount: 0, missedCallbacks: 2 };
    expect(menuView(open(c), DEFAULT_SETTINGS, c).detail).toEqual(["2 MISSED CALL BACKS"]);
    expect(step(open(c), digit(3), c).action).toEqual({
      type: "vm-clear",
      voicemail: false,
      callbacks: true,
    });
    const none = { ...own, missedCount: 0 };
    expect(menuView(open(none), DEFAULT_SETTINGS, none).labels).toEqual({ 1: "Play" });
    expect(step(open(none), digit(3), none).action).toBeUndefined();
  });

  it("a kids' phone asks a grown-up; other phones play in the app", () => {
    const kids = { ...ctx, play: "kids" as const };
    expect(menuView(open(kids), DEFAULT_SETTINGS, kids).detail).toEqual(["ASK A GROWN-UP"]);
    expect(menuPrompt(open(kids), DEFAULT_SETTINGS, kids)).toMatch(/Ask a grown-up/);
    expect(step(open(kids), digit(1), kids).action).toBeUndefined();
    const lounge = { ...ctx, play: "app" as const };
    expect(menuView(open(lounge), DEFAULT_SETTINGS, lounge).detail).toEqual(["PLAY IN APP"]);
  });
});

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

  it("clamps volume", () => {
    const loud = run([menu(), digit(1), ...Array(20).fill(digit(2))]);
    expect(loud.settings.volume).toBe(10);
    const quiet = run([menu(), digit(1), ...Array(20).fill(digit(1))]);
    expect(quiet.settings.volume).toBe(0);
  });

  it("has no speakerphone item: the phone has a handset only (hardware H5)", () => {
    const r = run([menu(), digit(3)]);
    expect(r.state?.screen).toBe("root");
    expect(r.settings).toEqual(DEFAULT_SETTINGS);
  });

  it("MENU closes the menu from anywhere; BACK goes one level up", () => {
    expect(run([menu(), menu()]).state).toBeUndefined();
    expect(run([menu(), digit(1), menu()]).state).toBeUndefined();
    expect(run([menu(), digit(1), back()]).state?.screen).toBe("root");
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
});

describe("menuView / menuLines", () => {
  it("labels the digits for the current screen", () => {
    const root = menuView({ screen: "root", lastInput: 0 }, DEFAULT_SETTINGS, ctx);
    expect(root.labels).toEqual({
      1: "Volume",
      2: "Voicemail",
      0: "About",
    });
    expect(root.backLabel).toBe("Close");
    const vol = menuView({ screen: "volume", lastInput: 0 }, DEFAULT_SETTINGS, ctx);
    expect(vol.title).toBe("VOLUME 6/10");
    expect(vol.labels).toEqual({ 1: "Quieter", 2: "Louder" });
  });

  it("fits 16-character displays, cycling options with 0 last", () => {
    const root = menuView({ screen: "root", lastInput: 0 }, DEFAULT_SETTINGS, ctx);
    const seen = [0, 2000, 4000].map((t) => menuLines(root, t)[1]);
    expect(seen).toEqual(["1 VOLUME", "2 VOICEMAIL", "0 ABOUT"]);
    for (const line of seen) expect(line?.length ?? 0).toBeLessThanOrEqual(16);
  });

  it("prompts every screen in words", () => {
    for (const screen of ["root", "volume", "voicemail", "about"] as const) {
      expect(menuPrompt({ screen, lastInput: 0 }, DEFAULT_SETTINGS, ctx).length).toBeGreaterThan(5);
    }
  });
});

describe("Lounge session menu", () => {
  const lounge = (openToChat: boolean) => ({ ...ctx, lounge: { openToChat } });

  it("offers open to chat and log out only while someone uses a Lounge phone", () => {
    const state = { screen: "root" as const, lastInput: 0 };
    expect(menuView(state, DEFAULT_SETTINGS, ctx).labels[8]).toBeUndefined();
    const labels = menuView(state, DEFAULT_SETTINGS, lounge(false)).labels;
    expect(labels[5]).toBe("Chat on");
    expect(labels[8]).toBe("Log out");
    expect(menuView(state, DEFAULT_SETTINGS, lounge(true)).labels[5]).toBe("Chat off");
    expect(menuPrompt(state, DEFAULT_SETTINGS, lounge(false))).toMatch(/Press 8 to log out/);
  });

  it("returns the action and closes the menu", () => {
    const open = menuStep(undefined, DEFAULT_SETTINGS, menu(), lounge(false));
    const chat = menuStep(open.state, DEFAULT_SETTINGS, digit(5), lounge(false));
    expect(chat.action).toEqual({ type: "chat", open: true });
    expect(chat.state).toBeUndefined();
    const off = menuStep(open.state, DEFAULT_SETTINGS, digit(5), lounge(true));
    expect(off.action).toEqual({ type: "chat", open: false });
    const out = menuStep(open.state, DEFAULT_SETTINGS, digit(8), lounge(true));
    expect(out.action).toEqual({ type: "logout" });
    // Without a session, 5 and 8 do nothing.
    const none = menuStep(open.state, DEFAULT_SETTINGS, digit(8), ctx);
    expect(none.action).toBeUndefined();
    expect(none.state?.screen).toBe("root");
  });
});

describe("About", () => {
  it("shows the firmware and the phone's four words, two per line, and says them", () => {
    const ctx = { missedCount: 0, fw: "0.1.0", fingerprint: ["acorn", "bell", "cedar", "duck"] };
    const about = menuStep(
      { screen: "root", lastInput: 0 },
      DEFAULT_SETTINGS,
      {
        type: "digit",
        digit: 0,
        now: 1,
      },
      ctx,
    );
    const view = menuView(about.state as MenuState, DEFAULT_SETTINGS, ctx);
    expect(view.title).toBe("FW 0.1.0");
    expect(view.detail).toEqual(["ACORN BELL", "CEDAR DUCK"]);
    expect(about.say).toContain("acorn, bell, cedar, duck");
    expect(menuLines(view, 0)).toEqual(["FW 0.1.0", "ACORN BELL"]);
    expect(menuLines(view, 2000)).toEqual(["FW 0.1.0", "CEDAR DUCK"]);
    // The longest words still fit a 16-character line.
    expect(fingerprintLines(["pelican", "unicorn", "a", "b"])[0]).toHaveLength(15);
  });
});

describe("the call menu (hold, add caller, merge, transfer, rooms)", () => {
  const ctx = (actions: ("hold" | "resume" | "merge" | "transfer" | "mute" | "unmute")[]) => ({
    missedCount: 0,
    fw: "t",
    call: { actions },
  });

  it("MENU during a call opens the call screen; 1 adds a caller", () => {
    const open = menuStep(
      undefined,
      DEFAULT_SETTINGS,
      { type: "menu", now: 0 },
      ctx(["hold", "transfer"]),
    );
    expect(open.state?.screen).toBe("call");
    const view = menuView(
      open.state as NonNullable<typeof open.state>,
      DEFAULT_SETTINGS,
      ctx(["hold", "transfer"]),
    );
    expect(view).toMatchObject({ title: "CALL", labels: { 1: "Add caller", 2: "Transfer" } });
    const add = menuStep(
      open.state,
      DEFAULT_SETTINGS,
      { type: "digit", digit: 1, now: 1 },
      ctx(["hold", "transfer"]),
    );
    expect(add).toMatchObject({ state: undefined, action: { type: "call", action: "hold" } });
    expect(add.say).toMatch(/Choose who to add/);
  });

  it("while consulting: 1 merges, 2 transfers (attended)", () => {
    const c = ctx(["merge", "transfer"]);
    const open = menuStep(undefined, DEFAULT_SETTINGS, { type: "menu", now: 0 }, c);
    const t = menuStep(open.state, DEFAULT_SETTINGS, { type: "digit", digit: 2, now: 1 }, c);
    expect(t).toMatchObject({
      action: { type: "call", action: "transfer" },
      say: "Call transferred.",
    });
    const m = menuStep(open.state, DEFAULT_SETTINGS, { type: "digit", digit: 1, now: 1 }, c);
    expect(m.action).toEqual({ type: "call", action: "merge" });
  });

  it("in a room: MENU mutes; BACK closes", () => {
    const c = ctx(["mute"]);
    const open = menuStep(undefined, DEFAULT_SETTINGS, { type: "menu", now: 0 }, c);
    expect(menuView(open.state as NonNullable<typeof open.state>, DEFAULT_SETTINGS, c).title).toBe(
      "ROOM",
    );
    expect(
      menuStep(open.state, DEFAULT_SETTINGS, { type: "back", now: 1 }, c).state,
    ).toBeUndefined();
    expect(
      menuStep(open.state, DEFAULT_SETTINGS, { type: "digit", digit: 1, now: 1 }, c),
    ).toMatchObject({
      action: { type: "call", action: "mute" },
      say: "Muted.",
    });
  });

  it("without a call MENU opens the usual menu", () => {
    const open = menuStep(undefined, DEFAULT_SETTINGS, { type: "menu", now: 0 }, ctx([]));
    expect(open.state?.screen).toBe("root");
  });
});

describe("MENU → Dial extension (team/org spaces)", () => {
  const w = { ...ctx, extensions: true };
  const step = (state: MenuState | undefined, e: MenuEvent, c: typeof ctx = w) =>
    menuStep(state, DEFAULT_SETTINGS, e, c);

  it("offers 6 only where the space has extensions", () => {
    const root = step(undefined, menu()).state as MenuState;
    expect(menuView(root, DEFAULT_SETTINGS, w).labels[6]).toBe("Dial ext");
    expect(menuView(root, DEFAULT_SETTINGS, ctx).labels[6]).toBeUndefined();
    expect(step(root, digit(6), ctx).state?.screen).toBe("root");
  });

  it("collects digits, BACK deletes one, MENU dials", () => {
    let s = step(step(undefined, menu()).state, digit(6));
    expect(s.state?.screen).toBe("extension");
    expect(s.say).toMatch(/Enter the extension/);
    for (const d of [2, 0, 9]) s = step(s.state, digit(d));
    expect(s.state?.digits).toBe("209");
    s = step(s.state, back());
    expect(s.state?.digits).toBe("20");
    expect(menuView(s.state as MenuState, DEFAULT_SETTINGS, w)).toMatchObject({
      title: "EXT 20",
      menuLabel: "Dial",
      backLabel: "Delete",
    });
    s = step(s.state, digit(1));
    const dialed = step(s.state, menu());
    expect(dialed.state).toBeUndefined();
    expect(dialed.action).toEqual({ type: "extension", number: "201" });
  });

  it("too short to dial: says so; BACK on nothing returns to the top", () => {
    let s = step(step(undefined, menu()).state, digit(6));
    s = step(s.state, digit(4));
    const early = step(s.state, menu());
    expect(early.action).toBeUndefined();
    expect(early.state?.screen).toBe("extension");
    s = step(step(early.state, back()).state, back());
    expect(s.state?.screen).toBe("root");
    // At most six digits.
    let t = step(step(undefined, menu()).state, digit(6));
    for (let i = 0; i < 8; i++) t = step(t.state, digit(1));
    expect(t.state?.digits).toBe("111111");
  });
});
