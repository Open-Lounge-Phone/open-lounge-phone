/**
 * A 14-segment alphanumeric display renderer (SVG), for the "segments" display option.
 *
 *    ─a─       h i j = upper diagonals / centre
 *   f\ | /b    k l m = lower diagonals / centre
 *   ─g1 g2─
 *   e/ | \c
 *    ─d─  .
 */
export type Segment =
  | "a"
  | "b"
  | "c"
  | "d"
  | "e"
  | "f"
  | "g1"
  | "g2"
  | "h"
  | "i"
  | "j"
  | "k"
  | "l"
  | "m";

const GEOMETRY: Record<Segment, [number, number, number, number]> = {
  a: [8, 6, 32, 6],
  b: [34, 8, 34, 30],
  c: [34, 34, 34, 56],
  d: [8, 58, 32, 58],
  e: [6, 34, 6, 56],
  f: [6, 8, 6, 30],
  g1: [8, 32, 18, 32],
  g2: [22, 32, 32, 32],
  h: [9, 10, 18, 29],
  i: [20, 9, 20, 29],
  j: [31, 10, 22, 29],
  k: [18, 35, 9, 54],
  l: [20, 35, 20, 55],
  m: [22, 35, 31, 54],
};

const seg = (s: string) => s.split(" ") as Segment[];

export const FONT: Record<string, Segment[]> = {
  " ": [],
  "0": seg("a b c d e f j k"),
  "1": seg("b c j"),
  "2": seg("a b g1 g2 e d"),
  "3": seg("a b c d g2"),
  "4": seg("f g1 g2 b c"),
  "5": seg("a f g1 g2 c d"),
  "6": seg("a f e d c g1 g2"),
  "7": seg("a b c"),
  "8": seg("a b c d e f g1 g2"),
  "9": seg("a b c d f g1 g2"),
  A: seg("a b c e f g1 g2"),
  B: seg("a b c d i l g2"),
  C: seg("a d e f"),
  D: seg("a b c d i l"),
  E: seg("a d e f g1"),
  F: seg("a e f g1"),
  G: seg("a c d e f g2"),
  H: seg("b c e f g1 g2"),
  I: seg("a d i l"),
  J: seg("b c d e"),
  K: seg("e f g1 j m"),
  L: seg("d e f"),
  M: seg("b c e f h j"),
  N: seg("b c e f h m"),
  O: seg("a b c d e f"),
  P: seg("a b e f g1 g2"),
  Q: seg("a b c d e f m"),
  R: seg("a b e f g1 g2 m"),
  S: seg("a f g1 g2 c d"),
  T: seg("a i l"),
  U: seg("b c d e f"),
  V: seg("e f k j"),
  W: seg("b c e f k m"),
  X: seg("h j k m"),
  Y: seg("h j l"),
  Z: seg("a d j k"),
  "-": seg("g1 g2"),
  "+": seg("g1 g2 i l"),
  "/": seg("j k"),
  "%": seg("f c j k"),
  "'": seg("j"),
  "?": seg("a b g2 l"),
  _: seg("d"),
  "=": seg("g1 g2 d"),
};

/** Characters drawn as dots rather than segments. */
const DOTS: Record<string, [number, number][]> = {
  ":": [
    [20, 22],
    [20, 44],
  ],
  ".": [[38, 58]],
};

export function isRenderable(ch: string): boolean {
  return ch in FONT || ch in DOTS;
}

const NS = "http://www.w3.org/2000/svg";

function cell(ch: string): SVGSVGElement {
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", "0 0 42 64");
  svg.setAttribute("class", "seg-cell");
  const g = document.createElementNS(NS, "g");
  g.setAttribute("transform", "skewX(-7) translate(4 0)");
  const lit = new Set(FONT[ch] ?? []);
  for (const [name, [x1, y1, x2, y2]] of Object.entries(GEOMETRY)) {
    const line = document.createElementNS(NS, "line");
    line.setAttribute("x1", String(x1));
    line.setAttribute("y1", String(y1));
    line.setAttribute("x2", String(x2));
    line.setAttribute("y2", String(y2));
    line.setAttribute("class", lit.has(name as Segment) ? "seg on" : "seg");
    g.append(line);
  }
  for (const [cx, cy] of DOTS[ch] ?? []) {
    const dot = document.createElementNS(NS, "circle");
    dot.setAttribute("cx", String(cx));
    dot.setAttribute("cy", String(cy));
    dot.setAttribute("r", "2.6");
    dot.setAttribute("class", "seg on");
    g.append(dot);
  }
  svg.append(g);
  return svg;
}

/** Renders each line as a row of `width` character cells. */
export function renderSegments(container: HTMLElement, lines: readonly string[], width: number) {
  container.replaceChildren(
    ...lines.map((text) => {
      const row = document.createElement("div");
      row.className = "seg-row";
      row.setAttribute("aria-hidden", "true");
      for (const ch of text.toUpperCase().padEnd(width).slice(0, width)) row.append(cell(ch));
      return row;
    }),
  );
}
