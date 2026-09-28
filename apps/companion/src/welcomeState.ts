/**
 * The short welcome shown once after joining or first-run setup. It's remembered on this device
 * so it never shows again once finished or skipped.
 */
export const WELCOME_KEY = "openloungephone.welcome";

type Store = Pick<Storage, "getItem" | "setItem" | "removeItem">;

/** Call right after joining or setting up, before signing in. */
export function markWelcomePending(storage: Store): void {
  storage.setItem(WELCOME_KEY, "pending");
}

export function welcomePending(storage: Store): boolean {
  return storage.getItem(WELCOME_KEY) === "pending";
}

export function finishWelcome(storage: Store): void {
  storage.setItem(WELCOME_KEY, "done");
}
