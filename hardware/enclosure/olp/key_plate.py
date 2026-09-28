"""Printable key plate (alternative to the FR4 plate from the PCB fab): 1.5 mm, 14.0 mm MX
cutouts at the deck's switch positions, e-ink pocket, FPC slot, light holes, countersunk holes at
deck holes 1-4 and a plain hole at hole 5. Print flat, 100 % infill (or 6 perimeters)."""

from __future__ import annotations

from .common import Geo, cbox, cyl, cut_all, rrect_prism


def build(g: Geo):
    k = g.ks
    pp = g.p["keys"]["printed_plate"]
    x0, x1, y0, y1 = g.deck_rect
    z0, z1 = k["plate_bot"], k["plate_top"]
    plate = rrect_prism((x0 + x1) / 2, (y0 + y1) / 2, x1 - x0, y1 - y0, 1.5, z0, z1)
    cuts = [cbox(x, y, pp["cutout"], pp["cutout"], z0 - 1, z1 + 1) for _, x, y in g.keys]
    e = g.p["eink"]
    px0, px1, py0, py1 = g.panel_rect
    cuts.append(cbox((px0 + px1) / 2, (py0 + py1) / 2, px1 - px0 + 2 * e["pocket_clear"], py1 - py0 + 2 * e["pocket_clear"], z0 - 1, z1 + 1))
    for sx0, sy0, sx1, sy1 in g.boards["deck"].get("slots", []):
        a, b = g.deck_xy(sx0, sy0), g.deck_xy(sx1, sy1)
        cuts.append(cbox((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, abs(b[0] - a[0]), abs(b[1] - a[1]), z0 - 1, z1 + 1))
    for hx, hy, d in g.boards["deck"].get("plate_light_holes", []):
        x, y = g.deck_xy(hx, hy)
        cuts.append(cyl(x, y, z0 - 1, z1 + 1, d))
    for x, y in g.deck_holes:
        cuts.append(cyl(x, y, z0 - 1, z1 + 1, pp["hole_d"]))
        cuts.append(cyl(x, y, z1 - 1.0, z1 + 1, 5.0))        # countersink-ish recess for flat heads
    return cut_all(plate, cuts)
