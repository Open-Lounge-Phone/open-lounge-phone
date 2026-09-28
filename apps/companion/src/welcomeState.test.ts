import { describe, expect, it } from "vitest";
import { finishWelcome, markWelcomePending, WELCOME_KEY, welcomePending } from "./welcomeState.ts";

function memory() {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
    m,
  };
}

describe("welcome", () => {
  it("shows once after joining, never again once finished or skipped", () => {
    const s = memory();
    expect(welcomePending(s)).toBe(false);
    markWelcomePending(s);
    expect(welcomePending(s)).toBe(true);
    finishWelcome(s);
    expect(welcomePending(s)).toBe(false);
    expect(s.m.get(WELCOME_KEY)).toBe("done");
  });
});
