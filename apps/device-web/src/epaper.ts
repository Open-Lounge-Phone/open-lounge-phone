/**
 * The e-paper screen as the firmware draws it (firmware/main/gfx.c, screens.c, marquee.c): the
 * same 5x7 font scaled up, the same layouts, on a 1-bit framebuffer the size of the 2.13-inch
 * panel (250 x 122). Pure, so the browser phone shows exactly what the board would.
 */

export const EPD_W = 250;
export const EPD_H = 122;

/** 5x7 font, ASCII 0x20-0x5F, one byte per column, low bit at the top (gfx.c). */
const FONT = new Uint8Array([
  0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x5f, 0x00, 0x00, 0x00, 0x07, 0x00, 0x07, 0x00, 0x14,
  0x7f, 0x14, 0x7f, 0x14, 0x24, 0x2a, 0x7f, 0x2a, 0x12, 0x23, 0x13, 0x08, 0x64, 0x62, 0x36, 0x49,
  0x56, 0x20, 0x50, 0x00, 0x05, 0x03, 0x00, 0x00, 0x00, 0x1c, 0x22, 0x41, 0x00, 0x00, 0x41, 0x22,
  0x1c, 0x00, 0x14, 0x08, 0x3e, 0x08, 0x14, 0x08, 0x08, 0x3e, 0x08, 0x08, 0x00, 0x50, 0x30, 0x00,
  0x00, 0x08, 0x08, 0x08, 0x08, 0x08, 0x00, 0x60, 0x60, 0x00, 0x00, 0x20, 0x10, 0x08, 0x04, 0x02,
  0x3e, 0x51, 0x49, 0x45, 0x3e, 0x00, 0x42, 0x7f, 0x40, 0x00, 0x42, 0x61, 0x51, 0x49, 0x46, 0x21,
  0x41, 0x45, 0x4b, 0x31, 0x18, 0x14, 0x12, 0x7f, 0x10, 0x27, 0x45, 0x45, 0x45, 0x39, 0x3c, 0x4a,
  0x49, 0x49, 0x30, 0x01, 0x71, 0x09, 0x05, 0x03, 0x36, 0x49, 0x49, 0x49, 0x36, 0x06, 0x49, 0x49,
  0x29, 0x1e, 0x00, 0x36, 0x36, 0x00, 0x00, 0x00, 0x56, 0x36, 0x00, 0x00, 0x08, 0x14, 0x22, 0x41,
  0x00, 0x14, 0x14, 0x14, 0x14, 0x14, 0x00, 0x41, 0x22, 0x14, 0x08, 0x02, 0x01, 0x51, 0x09, 0x06,
  0x32, 0x49, 0x79, 0x41, 0x3e, 0x7e, 0x11, 0x11, 0x11, 0x7e, 0x7f, 0x49, 0x49, 0x49, 0x36, 0x3e,
  0x41, 0x41, 0x41, 0x22, 0x7f, 0x41, 0x41, 0x22, 0x1c, 0x7f, 0x49, 0x49, 0x49, 0x41, 0x7f, 0x09,
  0x09, 0x09, 0x01, 0x3e, 0x41, 0x49, 0x49, 0x7a, 0x7f, 0x08, 0x08, 0x08, 0x7f, 0x00, 0x41, 0x7f,
  0x41, 0x00, 0x20, 0x40, 0x41, 0x3f, 0x01, 0x7f, 0x08, 0x14, 0x22, 0x41, 0x7f, 0x40, 0x40, 0x40,
  0x40, 0x7f, 0x02, 0x0c, 0x02, 0x7f, 0x7f, 0x04, 0x08, 0x10, 0x7f, 0x3e, 0x41, 0x41, 0x41, 0x3e,
  0x7f, 0x09, 0x09, 0x09, 0x06, 0x3e, 0x41, 0x51, 0x21, 0x5e, 0x7f, 0x09, 0x19, 0x29, 0x46, 0x46,
  0x49, 0x49, 0x49, 0x31, 0x01, 0x01, 0x7f, 0x01, 0x01, 0x3f, 0x40, 0x40, 0x40, 0x3f, 0x1f, 0x20,
  0x40, 0x20, 0x1f, 0x3f, 0x40, 0x38, 0x40, 0x3f, 0x63, 0x14, 0x08, 0x14, 0x63, 0x07, 0x08, 0x70,
  0x08, 0x07, 0x61, 0x51, 0x49, 0x45, 0x43, 0x00, 0x7f, 0x41, 0x41, 0x00, 0x02, 0x04, 0x08, 0x10,
  0x20, 0x00, 0x41, 0x41, 0x7f, 0x00, 0x04, 0x02, 0x01, 0x02, 0x04, 0x40, 0x40, 0x40, 0x40, 0x40,
]);

export interface Frame {
  w: number;
  h: number;
  /** One byte per pixel: 1 = ink. */
  px: Uint8Array;
}

export function frame(w = EPD_W, h = EPD_H): Frame {
  return { w, h, px: new Uint8Array(w * h) };
}

function dot(f: Frame, x: number, y: number, on: boolean): void {
  if (x < 0 || y < 0 || x >= f.w || y >= f.h) return;
  f.px[y * f.w + x] = on ? 1 : 0;
}

export function rect(f: Frame, x: number, y: number, w: number, h: number, on = true): void {
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) dot(f, x + i, y + j, on);
}

function glyph(f: Frame, x0: number, y0: number, ch: string, scale: number, on: boolean): void {
  let c = ch.toUpperCase().charCodeAt(0);
  if (Number.isNaN(c) || c < 0x20 || c > 0x5f) c = 0x3f; // "?"
  const base = (c - 0x20) * 5;
  for (let col = 0; col < 5; col++) {
    const bits = FONT[base + col] as number;
    for (let row = 0; row < 7; row++) {
      if (bits & (1 << row)) rect(f, x0 + col * scale, y0 + row * scale, scale, scale, on);
    }
  }
}

/** Width in pixels (6 px pitch per character, less the last gap). */
export function textWidth(s: string, scale: number): number {
  return s.length ? s.length * 6 * scale - scale : 0;
}

export function text(f: Frame, x: number, y: number, s: string, scale: number, on = true): void {
  for (let k = 0; k < s.length; k++) glyph(f, x + k * 6 * scale, y, s[k] as string, scale, on);
}

/** marquee.c: `width` characters of `s` at `step`, holding at the start, then looping. */
export const MARQUEE_STEP_MS = 600;
const HOLD = 3;
const GAP = 3;
export function marquee(s: string, width: number, step: number): string {
  if (s.length <= width || width <= 0) return s;
  const cycle = s.length + GAP;
  const pos = Math.max(0, step) % (cycle + HOLD);
  const off = pos < HOLD ? 0 : pos - HOLD;
  let out = "";
  for (let k = 0; k < width; k++) {
    const i = (off + k) % cycle;
    out += i < s.length ? s[i] : " ";
  }
  return out;
}

/** Characters per line at the scale `lines()` picks for `n` lines. */
export function lineCapacity(n: number, w = EPD_W, h = EPD_H): number {
  return Math.min(24, Math.floor((w - 4) / (6 * scaleFor(n, w, h))));
}

function scaleFor(n: number, w: number, h: number): number {
  let scale = n <= 2 ? 3 : 2;
  while (scale > 1 && (16 * 6 * scale > w || n * 10 * scale > h)) scale--;
  return scale;
}

/** gfx_render_lines: up to 4 centred lines, as large as fits (status: 2 lines, menus: 4). */
export function lines(f: Frame, ls: string[], step = 0): void {
  f.px.fill(0);
  const n = Math.min(4, ls.length);
  if (!n) return;
  const scale = scaleFor(n, f.w, f.h);
  const cap = lineCapacity(n, f.w, f.h);
  const pitch = 6 * scale,
    lineH = 7 * scale,
    gap = 3 * scale;
  let y = Math.floor((f.h - (n * lineH + (n - 1) * gap)) / 2);
  for (let i = 0; i < n; i++, y += lineH + gap) {
    const s = marquee((ls[i] as string).toUpperCase(), cap, step);
    const x = Math.floor((f.w - (s.length * pitch - scale)) / 2);
    text(f, x, y, s, scale);
  }
}

/** screens.c screen_keys: the key map when the handset is up. */
export function keyMap(f: Frame, title: string, labels: string[], footer: string, step = 0): void {
  f.px.fill(0);
  const { w, h } = f;
  rect(f, 0, 0, w, 22);
  const tcap = Math.floor((w - 8 + 2) / 12);
  const t = marquee(title.toUpperCase(), tcap, step);
  text(f, Math.floor((w - textWidth(t, 2)) / 2), 4, t, 2, false);
  const top = 26,
    bottom = h - 14,
    pitch = Math.floor((bottom - top) / 5),
    col = Math.floor((w - 8) / 2);
  const kw = 16,
    kh = Math.min(15, pitch - 1);
  const room = col - kw - 10;
  for (let i = 0; i < 10; i++) {
    const x = 4 + Math.floor(i / 5) * col,
      y = top + (i % 5) * pitch;
    const label = (labels[i] ?? "").trim();
    const digit = i === 9 ? "0" : String(i + 1);
    const ds = kh >= 14 ? 2 : 1;
    if (label) rect(f, x, y, kw, kh);
    text(
      f,
      x + Math.floor((kw - textWidth(digit, ds) + 1) / 2),
      y + Math.floor((kh - 7 * ds + 1) / 2),
      digit,
      ds,
      !label,
    );
    const name = label ? label.toUpperCase() : "-";
    const s = textWidth(name, 2) <= room && kh >= 14 ? 2 : 1;
    const shown = marquee(name, Math.floor((room + s) / (6 * s)), step);
    text(f, x + kw + 5, y + Math.floor((kh - 7 * s) / 2), shown, s);
  }
  for (let x = 8; x < w - 8; x += 3) dot(f, x, h - 13, true);
  const ft = marquee(footer.toUpperCase(), Math.floor((w - 8 + 1) / 6), step);
  text(f, Math.floor((w - textWidth(ft, 1)) / 2), h - 9, ft, 1);
}

/** screens.c screen_lounge: a free Lounge phone's takeover code. */
export function loungeCode(f: Frame, modules: boolean[][], hint: string, space: string): void {
  f.px.fill(0);
  const { w, h } = f;
  const n = modules.length;
  const px = Math.max(1, Math.min(4, Math.floor((h - 8) / (n + 2))));
  const side = (n + 2) * px;
  const qx = 4,
    qy = Math.floor((h - side) / 2);
  for (let y = 0; y < n; y++)
    for (let x = 0; x < n; x++)
      if (modules[y]?.[x]) rect(f, qx + (x + 1) * px, qy + (y + 1) * px, px, px);
  const x = qx + side + 8,
    right = w - x - 4;
  text(f, x, 10, "SCAN TO", 2);
  text(f, x, 28, "USE THIS", 2);
  text(f, x, 46, "PHONE", 2);
  rect(f, x, 68, right, 1);
  const fit = (s: string) => {
    let t = s.toUpperCase();
    while (textWidth(t, 1) > right && t.length > 1) t = t.slice(0, -1);
    return t;
  };
  text(f, x, 76, fit(hint), 1);
  text(f, x, h - 12, fit(space), 1);
}

/** Paints a frame into RGBA pixels (e-paper: dark grey ink on light grey). */
export function paint(f: Frame, out: Uint8ClampedArray, ink: number[], paper: number[]): void {
  for (let i = 0; i < f.px.length; i++) {
    const c = f.px[i] ? ink : paper;
    out[i * 4] = c[0] as number;
    out[i * 4 + 1] = c[1] as number;
    out[i * 4 + 2] = c[2] as number;
    out[i * 4 + 3] = 255;
  }
}
