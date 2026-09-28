import { describe, expect, it } from "vitest";
import { ScreenAwake, type WakeLockLike } from "./wake.ts";

function fakeApi(fail = false) {
  const sentinels: { released: boolean; release(): Promise<void> }[] = [];
  const api: WakeLockLike = {
    request: async () => {
      if (fail) throw new Error("NotAllowedError");
      const s = {
        released: false,
        release: async () => {
          s.released = true;
        },
      };
      sentinels.push(s);
      return s;
    },
  };
  return { api, sentinels };
}

describe("ScreenAwake", () => {
  it("holds the lock once enabled and re-acquires it after the page was hidden", async () => {
    const { api, sentinels } = fakeApi();
    let visible = true;
    const awake = new ScreenAwake(api, () => visible);
    await awake.onVisibilityChange();
    expect(sentinels).toHaveLength(0); // not wanted yet
    await awake.enable();
    expect(awake.held).toBe(true);
    // The browser releases the lock when the page is hidden.
    visible = false;
    (sentinels[0] as { released: boolean }).released = true;
    await awake.onVisibilityChange();
    expect(awake.held).toBe(false);
    expect(sentinels).toHaveLength(1);
    visible = true;
    await awake.onVisibilityChange();
    expect(awake.held).toBe(true);
    expect(sentinels).toHaveLength(2);
    // Already held: no duplicate request.
    await awake.onVisibilityChange();
    expect(sentinels).toHaveLength(2);
  });

  it("releases on disable and stays off", async () => {
    const { api, sentinels } = fakeApi();
    const awake = new ScreenAwake(api, () => true);
    await awake.enable();
    await awake.disable();
    expect(sentinels[0]?.released).toBe(true);
    await awake.onVisibilityChange();
    expect(awake.held).toBe(false);
  });

  it("copes with no API or a refused request", async () => {
    const none = new ScreenAwake(undefined, () => true);
    await none.enable();
    expect(none.supported).toBe(false);
    expect(none.held).toBe(false);
    const refused = new ScreenAwake(fakeApi(true).api, () => true);
    await refused.enable();
    expect(refused.held).toBe(false);
  });
});
