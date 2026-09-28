/**
 * Keeps the screen on while the browser phone is open (Screen Wake Lock API). Browsers drop the
 * lock whenever the page is hidden, so it is taken again when the page becomes visible.
 */

export interface WakeLockSentinelLike {
  readonly released: boolean;
  release(): Promise<void>;
}

export interface WakeLockLike {
  request(type: "screen"): Promise<WakeLockSentinelLike>;
}

export class ScreenAwake {
  private sentinel?: WakeLockSentinelLike;
  private wanted = false;
  private pending?: Promise<void>;
  private readonly api: WakeLockLike | undefined;
  private readonly visible: () => boolean;

  constructor(api: WakeLockLike | undefined, visible: () => boolean) {
    this.api = api;
    this.visible = visible;
  }

  /** Whether the screen is being kept on right now. */
  get held(): boolean {
    return !!this.sentinel && !this.sentinel.released;
  }

  get supported(): boolean {
    return !!this.api;
  }

  /** Start keeping the screen on (call from a tap: some browsers need a user gesture). */
  enable(): Promise<void> {
    this.wanted = true;
    return this.acquire();
  }

  async disable(): Promise<void> {
    this.wanted = false;
    const s = this.sentinel;
    this.sentinel = undefined;
    await s?.release().catch(() => {});
  }

  /** Call on `visibilitychange`. */
  onVisibilityChange(): Promise<void> {
    return this.acquire();
  }

  private acquire(): Promise<void> {
    if (!this.api || !this.wanted || !this.visible() || this.held) return Promise.resolve();
    this.pending ??= this.api
      .request("screen")
      .then((s) => {
        this.sentinel = s;
      })
      .catch(() => {
        // Denied (battery saver, not visible): try again on the next visibility change.
      })
      .finally(() => {
        this.pending = undefined;
      });
    return this.pending;
  }
}
