import { describe, expect, it } from "vitest";
import { FONT, isRenderable } from "./segments.ts";

describe("14-segment font", () => {
  it("covers every character the status text can produce", () => {
    const needed = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 :%";
    for (const ch of needed) expect(isRenderable(ch), ch).toBe(true);
  });

  it("gives every letter and digit a distinct glyph", () => {
    const glyphs = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"
      .split("")
      .map((c) => [...(FONT[c] ?? [])].sort().join(" "));
    // 5 and S share a shape on 14-segment displays by convention; everything else is unique.
    const counts = new Map<string, number>();
    for (const g of glyphs) counts.set(g, (counts.get(g) ?? 0) + 1);
    const dupes = [...counts].filter(([, n]) => n > 1).map(([g]) => g);
    expect(dupes).toEqual([[...(FONT.S ?? [])].sort().join(" ")]);
  });
});
