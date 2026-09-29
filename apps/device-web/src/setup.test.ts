import { describe, expect, it } from "vitest";
import { forgetKind, kindKey, loadKind, saveKind, startScreen } from "./setup.ts";

function memory() {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    m,
  };
}

describe("phone kind", () => {
  it("is unset until chosen, then remembered per profile", () => {
    const s = memory();
    expect(loadKind(s, "a", null)).toBeUndefined();
    saveKind(s, "a", "lounge");
    expect(loadKind(s, "a", null)).toBe("lounge");
    expect(loadKind(s, "b", null)).toBeUndefined();
    expect(s.m.get(kindKey("a"))).toBe("lounge");
  });

  it("lets ?variant= override and ignores junk", () => {
    const s = memory();
    saveKind(s, "a", "lounge");
    expect(loadKind(s, "a", "kids")).toBe("kids");
    s.setItem(kindKey("a"), "toaster");
    expect(loadKind(s, "a", null)).toBeUndefined();
    expect(loadKind(s, "a", "toaster")).toBeUndefined();
  });

  it("survives blocked storage", () => {
    const blocked = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
    };
    expect(loadKind(blocked, "a", null)).toBeUndefined();
    expect(() => saveKind(blocked, "a", "kids")).not.toThrow();
  });
});

describe("start screen", () => {
  it("asks for the kind on first run, then only for a tap", () => {
    expect(startScreen({ kind: undefined, paired: false, started: false })).toBe("choose");
    expect(startScreen({ kind: "kids", paired: false, started: false })).toBe("tap");
    // Paired before this setting existed: don't ask, it's a kids' phone.
    expect(startScreen({ kind: undefined, paired: true, started: false })).toBe("tap");
    expect(startScreen({ kind: undefined, paired: false, started: true })).toBe("none");
  });
});

describe("personal phones and wiping", () => {
  it("remembers a personal phone, and forgets the choice when wiped", () => {
    const data = new Map<string, string>();
    const store = {
      getItem: (k: string) => data.get(k) ?? null,
      setItem: (k: string, v: string) => void data.set(k, v),
      removeItem: (k: string) => void data.delete(k),
    };
    expect(loadKind(store, "a", "personal")).toBe("personal");
    saveKind(store, "a", "personal");
    expect(loadKind(store, "a", null)).toBe("personal");
    forgetKind(store, "a");
    expect(loadKind(store, "a", null)).toBeUndefined();
    expect(startScreen({ kind: undefined, paired: false, started: false })).toBe("choose");
  });
});
