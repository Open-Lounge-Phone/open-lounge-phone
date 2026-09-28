"""Owner's signature logo -> KiCad silkscreen footprints (reproducible, no manual tracing).

    ../.venv/bin/python make_logo.py        # uses Pillow from the project venv

signature.jpg (white strokes on black) -> crop -> resample onto a 0.05 mm grid at the final
logo width -> threshold -> thicken strokes (morphological dilation) until every stroke is
>= 0.2 mm -> check: a morphological opening with a 0.15 mm (3-cell) square must keep every
silk cell (i.e. no feature narrower than 0.15 mm, the common silkscreen minimum) ->
write merged rectangles as filled fp_poly on F.SilkS / B.SilkS (mirrored) into
../layout/footprints/openloungephone.pretty/openloungephone_logo_{F,B}.kicad_mod, plus logo-preview.png.
"""

from __future__ import annotations

import sys
from pathlib import Path

from PIL import Image, ImageFilter

HERE = Path(__file__).resolve().parent
LIB = HERE.parent / "layout" / "footprints" / "openloungephone.pretty"
WIDTH_MM = 16.0
CELL = 0.05          # mm per grid cell
MIN_FEATURE = 0.15   # mm, common silkscreen minimum (JLCPCB 0.15, most fabs 0.15-0.2)
TARGET_STROKE = 0.2  # mm


def load_mask() -> Image.Image:
    img = Image.open(HERE / "signature.jpg").convert("L")
    bw = img.point(lambda v: 255 if v > 128 else 0)
    box = bw.getbbox()
    crop = img.crop((box[0] - 4, box[1] - 4, box[2] + 4, box[3] + 4))
    cols = round(WIDTH_MM / CELL)
    rows = round(cols * crop.height / crop.width)
    # area-average down to the grid, then keep any cell that is >= 25 % white, so strokes
    # thinner than a cell survive and are thickened below
    small = crop.resize((cols, rows), Image.BOX)
    return small.point(lambda v: 255 if v >= 64 else 0)


def thicken(mask: Image.Image) -> Image.Image:
    """Dilate once with a 3x3 window: +1 cell (0.05 mm) per side, so a 1-3 cell stroke
    becomes >= 3-5 cells (0.15-0.25 mm); repeat while the opening test still loses cells."""
    m = mask.filter(ImageFilter.MaxFilter(3))
    for _ in range(3):
        if lost_cells(m) == 0:
            break
        m = m.filter(ImageFilter.MaxFilter(3))
    return m


def lost_cells(m: Image.Image) -> int:
    k = round(MIN_FEATURE / CELL)  # 3 cells
    opened = m.filter(ImageFilter.MinFilter(k)).filter(ImageFilter.MaxFilter(k))
    a, b = m.load(), opened.load()
    return sum(1 for y in range(m.height) for x in range(m.width) if a[x, y] and not b[x, y])


def rectangles(m: Image.Image) -> list[tuple[int, int, int, int]]:
    """Horizontal runs merged vertically into rectangles (x0, y0, x1, y1) in cells."""
    px = m.load()
    runs_prev: dict[tuple[int, int], int] = {}
    rects = []
    for y in range(m.height + 1):
        runs = []
        if y < m.height:
            x = 0
            while x < m.width:
                if px[x, y]:
                    x0 = x
                    while x < m.width and px[x, y]:
                        x += 1
                    runs.append((x0, x))
                else:
                    x += 1
        cur = {}
        for r in runs:
            cur[r] = runs_prev.pop(r, y)
        for (x0, x1), y0 in runs_prev.items():
            rects.append((x0, y0, x1, y))
        runs_prev = cur
    return rects


def footprint(name: str, rects, cols, rows, layer: str, mirror: bool) -> str:
    ox, oy = cols * CELL / 2, rows * CELL / 2
    out = [f'(footprint "{name}"', "\t(version 20260206)", '\t(generator "openloungephone_logo")',
           f'\t(layer "{"B.Cu" if mirror else "F.Cu"}")',
           '\t(descr "openloungephone signature logo (hardware/art/make_logo.py), silkscreen only")',
           '\t(tags "logo")',
           '\t(property "Reference" "G***" (at 0 0 0) (layer "%s") (hide yes)'
           ' (effects (font (size 1 1) (thickness 0.15))))' % ("B.Fab" if mirror else "F.Fab"),
           f'\t(property "Value" "{name}" (at 0 0 0) (layer "%s") (hide yes)'
           ' (effects (font (size 1 1) (thickness 0.15))))' % ("B.Fab" if mirror else "F.Fab"),
           "\t(attr board_only exclude_from_pos_files exclude_from_bom allow_missing_courtyard)"]
    for x0, y0, x1, y1 in rects:
        xs = [x0 * CELL - ox, x1 * CELL - ox]
        if mirror:
            xs = [-xs[1], -xs[0]]
        ya, yb = y0 * CELL - oy, y1 * CELL - oy
        pts = (f"(xy {xs[0]:.3f} {ya:.3f}) (xy {xs[1]:.3f} {ya:.3f}) "
               f"(xy {xs[1]:.3f} {yb:.3f}) (xy {xs[0]:.3f} {yb:.3f})")
        out.append(f'\t(fp_poly (pts {pts}) (stroke (width 0) (type solid)) (fill yes) '
                   f'(layer "{layer}"))')
    out += ["\t(embedded_fonts no)", ")", ""]
    return "\n".join(out)


def main() -> int:
    mask = thicken(load_mask())
    lost = lost_cells(mask)
    cols, rows = mask.size
    rects = rectangles(mask)
    LIB.mkdir(parents=True, exist_ok=True)
    (LIB / "openloungephone_logo_F.kicad_mod").write_text(
        footprint("openloungephone_logo_F", rects, cols, rows, "F.SilkS", False))
    (LIB / "openloungephone_logo_B.kicad_mod").write_text(
        footprint("openloungephone_logo_B", rects, cols, rows, "B.SilkS", True))
    mask.resize((cols * 4, rows * 4), Image.NEAREST).save(HERE / "logo-preview.png")
    print(f"logo {cols * CELL:.1f} x {rows * CELL:.1f} mm, {len(rects)} rectangles, "
          f"min-feature check ({MIN_FEATURE} mm opening): {lost} cells lost")
    return 1 if lost else 0


if __name__ == "__main__":
    sys.exit(main())
