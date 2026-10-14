/**
 * Listening to voicemail on the phone (MENU → 2 → 1 Play / 3 Clear), as the firmware's vmplay.c:
 * fetch the unheard messages, play them oldest first (1 again, 2 next, BACK stop), mark each one
 * played to the end as heard. Pure: the browser phone does the fetching and the audio.
 */

export interface VmItem {
  id: string;
  from: string;
  durationMs: number;
  /** Absent: a recording phones can't play (play it in the app). */
  ticket?: string;
}

export type VmPlayer =
  | { stage: "fetching"; clear: boolean; since: number }
  | { stage: "playing"; items: VmItem[]; cur: number }
  | { stage: "cant"; items: VmItem[]; cur: number; since: number }
  | { stage: "note"; lines: string[]; since: number };

export type VmEvent =
  | { type: "items"; items: VmItem[]; now: number }
  /** The current message played to the end. */
  | { type: "ended"; now: number }
  /** The current message couldn't be loaded or played. */
  | { type: "failed"; now: number }
  | { type: "key"; key: 1 | 2 | "back"; now: number }
  | { type: "tick"; now: number };

export interface VmResult {
  player: VmPlayer | undefined;
  /** Messages to mark heard (`voicemail.heard`). */
  heard: string[];
  /** Start playing this message (from the start). */
  play?: VmItem;
  /** Stop whatever is playing. */
  stop?: boolean;
}

export const FETCH_TIMEOUT_MS = 10_000;
export const CANT_PLAY_MS = 3_000;
export const NOTE_MS = 3_000;

export function vmStart(clear: boolean, now: number): VmPlayer {
  return { stage: "fetching", clear, since: now };
}

const note = (lines: string[], now: number): VmResult => ({
  player: { stage: "note", lines, since: now },
  heard: [],
  stop: true,
});

/** Play item `cur` (or say it can't be played here). */
function at(items: VmItem[], cur: number, now: number, heard: string[] = []): VmResult {
  if (cur >= items.length) return { ...note(["NO MORE MESSAGES"], now), heard };
  const item = items[cur] as VmItem;
  return item.ticket
    ? { player: { stage: "playing", items, cur }, heard, play: item }
    : { player: { stage: "cant", items, cur, since: now }, heard, stop: true };
}

export function vmStep(p: VmPlayer | undefined, e: VmEvent): VmResult {
  if (!p) return { player: undefined, heard: [] };
  if (e.type === "key" && e.key === "back") return { player: undefined, heard: [], stop: true };
  switch (p.stage) {
    case "fetching":
      if (e.type === "items") {
        if (e.items.length === 0) return note(["NO NEW VOICEMAIL"], e.now);
        if (p.clear) {
          return {
            ...note(["VOICEMAIL", `${e.items.length} CLEARED`], e.now),
            heard: e.items.map((i) => i.id),
          };
        }
        return at(e.items, 0, e.now);
      }
      if (e.type === "tick" && e.now - p.since > FETCH_TIMEOUT_MS) {
        return note(["COULDN'T GET", "VOICEMAIL"], e.now);
      }
      return { player: p, heard: [] };
    case "playing": {
      const item = p.items[p.cur] as VmItem;
      if (e.type === "ended") return at(p.items, p.cur + 1, e.now, [item.id]);
      if (e.type === "failed")
        return { player: { ...p, stage: "cant", since: e.now }, heard: [], stop: true };
      if (e.type === "key" && e.key === 1) return { player: p, heard: [], play: item };
      if (e.type === "key" && e.key === 2) return at(p.items, p.cur + 1, e.now);
      return { player: p, heard: [] };
    }
    case "cant":
      if (
        (e.type === "key" && e.key === 2) ||
        (e.type === "tick" && e.now - p.since > CANT_PLAY_MS)
      ) {
        return at(p.items, p.cur + 1, e.now);
      }
      return { player: p, heard: [] };
    case "note":
      if (e.type === "tick" && e.now - p.since > NOTE_MS) return { player: undefined, heard: [] };
      return { player: p, heard: [] };
  }
}

const mmss = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
};

/** What the display shows (the firmware's lines; `playedMs` = how far the audio is). */
export function vmLines(p: VmPlayer, playedMs: number): string[] {
  switch (p.stage) {
    case "fetching":
      return ["VOICEMAIL", "ONE MOMENT"];
    case "note":
      return p.lines;
    case "playing":
    case "cant": {
      const item = p.items[p.cur] as VmItem;
      const head = [
        `MESSAGE ${p.cur + 1} OF ${p.items.length}`,
        (item.from || "someone").toUpperCase().slice(0, 20),
      ];
      return p.stage === "cant"
        ? [...head, "PLAY IN APP", "2 NEXT"]
        : [...head, `${mmss(playedMs)} OF ${mmss(item.durationMs)}`, "1 AGAIN 2 NEXT"];
    }
  }
}
