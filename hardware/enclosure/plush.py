"""The plush series: a fat, cushion-like desk case that lies flat: build/plush/.

Two pillows fused like a sofa cushion: one over the keypad, one beside it that is the handset's
bed. Rigid print, made to look inflated (big radii everywhere). The keys are the same captive
caps as the wall faceplate (a flange under the face, a button through it), with their own puffy
tops. The handset lies in a pocket shaped to it (handset.py, the Opis 60s Micro outline); under
its lower cup the floor is a tongue printed with the case: the cup rests on the tongue alone, and
its weight bends the tongue onto the hook key's cap. Lift the handset: the tongue springs back and
the hook switch's own spring lifts the key. No extra parts. A bottom plate closes it from below.

    .venv/bin/python plush.py

Coordinates as faceplate.py: board top-left origin, x right, y up, z = 0 at the board top.
"""
from __future__ import annotations

import math
from pathlib import Path

from build123d import Box, Cylinder, Pos, export_step, export_stl, fillet, Text, extrude, FontStyle

import faceplate as F  # noqa: E402  (sets OLP_DISPLAY=2.13 and the captive-cap stack)
import handset as HS
import proto_box as P

OUT = Path(__file__).resolve().parent / "build" / "plush"

Z_BOT = -10.0              # the case's underside (the bottom plate sits flush in it)
WALL = 3.0
KEY_TOP, BED_TOP = 30.0, 36.0           # the two pillows' tops
KEY_R, BED_R = 17.0, 19.0               # their puffiness: the rounded top edge
CORNER = 2.0               # corner radius in plan = this x the top radius (fat, round corners)
BOTTOM_R = 2.5             # the soft edge it sits on (under the wall's thickness)
SEAM_Z, SEAM_W, SEAM_D = 2.0, 1.6, 0.8  # a piping seam round each pillow (height, width, depth)
KEY_BOX = (-8.0, 168.0, -8.0, 96.0)     # keypad pillow x0, x1, y0, y1
HS_C = (-8.0, 84.5)        # the handset's centre (x, y): its lower cup over the hook key's row
HS_Z = 26.5                # where the handset's cups rest (the tongue's top)
BED_BOX = (-50.0, 30.0, HS_C[1] - 105.0 - 9.0, HS_C[1] + 105.0 + 9.0)
KEYPAD = (34.0, 157.0, 0.0, 88.0)       # the recessed key panel (its floor is the captive face)
PANEL_R = 9.0

# the tongue under the lower cup: along x, rooted toward the cup's middle, its free end at the key
TONGUE_X = (-30.0, 22.0)
TONGUE_W = 16.0
TONGUE_T = 1.4             # TUNE on a print: thinner = softer (PETG/PLA); a 200 g handset bends it ~4 mm
CUP_DROP = 4.0             # the rest of the lower cup's pocket sits this much lower: the cup's stop
NUB_D = 8.0
GAP = 0.5                  # nub over the hook cap at rest

CORD_HOLES = ((8.0, 112.0), (7.0, 124.0))   # (diameter, y) through the bed pillow's outer side


def pillow(x0, x1, y0, y1, z0, z1, r):
    """A puffy pillow: fat round corners in plan, the top edge rounded all round, a soft bottom
    edge and a piping seam round its middle."""
    rc = r * CORNER
    b = F.rrect((x0 + x1) / 2, (y0 + y1) / 2, x1 - x0, y1 - y0, rc, z0, z1)
    b = F.round_top(b, z1, r)
    try:
        b = fillet([e for e in b.edges() if abs(e.center().Z - z0) < 1e-3], BOTTOM_R)
    except Exception:
        pass
    seam = F.rrect((x0 + x1) / 2, (y0 + y1) / 2, x1 - x0 + 2, y1 - y0 + 2, rc + 1, SEAM_Z - SEAM_W / 2, SEAM_Z + SEAM_W / 2)
    seam -= F.rrect((x0 + x1) / 2, (y0 + y1) / 2, x1 - x0 - 2 * SEAM_D, y1 - y0 - 2 * SEAM_D, rc - SEAM_D,
                    SEAM_Z - SEAM_W, SEAM_Z + SEAM_W)
    return b - seam


def inside(x0, x1, y0, y1, r, z0, z1):
    """The room inside a pillow: its outline WALL in, the same rounding less the wall."""
    return F.rrect((x0 + x1) / 2, (y0 + y1) / 2, x1 - x0 - 2 * WALL, y1 - y0 - 2 * WALL, r * CORNER - WALL, z0, z1)


def hook_xy():
    return P.HOOK[0], F.Y(P.HOOK[1])


def build_case():
    zt, zu = F.FACE_Z, F.FACE_Z - F.FACE_T
    kx0, kx1, ky0, ky1 = KEY_BOX
    bx0, bx1, by0, by1 = BED_BOX
    body = pillow(kx0, kx1, ky0, ky1, Z_BOT, KEY_TOP, KEY_R) + pillow(bx0, bx1, by0, by1, Z_BOT, BED_TOP, BED_R)

    # inside: the board's room up to under the face, and the bed pillow hollowed (cords, plugs)
    body -= F.rrect(F.BOARD_W / 2, F.BOARD_H / 2, F.BOARD_W + 0.6, F.BOARD_H + 0.6, F.BOARD_R + 0.3, Z_BOT - 1, zu)
    hollow = inside(bx0, bx1, by0, by1, BED_R, Z_BOT - 1, 19.0)
    hollow -= F.rrect(F.BOARD_W / 2, F.BOARD_H / 2, F.BOARD_W + 0.6 + 2 * WALL, F.BOARD_H + 0.6 + 2 * WALL,
                      F.BOARD_R + 3.0, zu - 0.01, 20.0)        # over the board the room stops under the face
    body -= hollow
    body -= inside(kx0, kx1, ky0, ky1, KEY_R, Z_BOT - 1, 0.0)

    # the key panel: recessed into the pillow, its floor is the captive face
    px0, px1, py0, py1 = KEYPAD
    body -= F.rrect((px0 + px1) / 2, (py0 + py1) / 2, px1 - px0, py1 - py0, PANEL_R, zt, KEY_TOP + 1)

    # captive caps: openings through the face, room for every flange to travel (the hook's too)
    hx, hy = hook_xy()
    for x, y, lab in F.SWITCHES:
        if lab != "HOOK":
            body -= F.rrect(x, F.Y(y), F.HOLE, F.HOLE, F.BUTTON_R + 0.3, zu - 1, zt + 1)
        body -= F.rrect(x, F.Y(y), F.FLANGE + 0.8, F.FLANGE + 0.8, F.FLANGE_R + 0.4, F.MX_HOUSING_TOP, zu)

    # display: window, lens and frame, far-end posts (as the faceplate)
    (mx, my, mw, mh), (wx, wy, ww, wh) = F.display()
    module_top = P.STANDOFF_L + P.MODULE_PCB_T
    lw, lh, _ = F.LENS
    chim = F.rrect(wx, wy, lw + 0.4 + 2 * F.HOOD_WALL, lh + 0.4 + 2 * F.HOOD_WALL, F.HOOD_R, F.DISP_TOP + 0.2, zu + 0.01)
    body += chim
    for x, y in P.MODULE_FAR_HOLES:
        body += F.cyl(x, F.Y(y), module_top + 0.1, zu + 0.01, F.FAR_POST_D)
        body += F.cyl(x, F.Y(y), module_top + 0.1 - F.FAR_PIN_L, module_top + 0.11, F.FAR_PIN_D)
    body -= F.rrect(wx, wy, lw + 0.4, lh + 0.4, 1.5, F.DISP_TOP, zt - F.LENS_LIP)
    body -= F.rrect(wx, wy, ww, wh, F.WIN_R, F.DISP_TOP, zt + 1)
    body -= F.rrect(wx, wy, ww + 2 * F.WIN_BEVEL, wh + 2 * F.WIN_BEVEL, F.WIN_R + F.WIN_BEVEL, zt - F.WIN_BEVEL, zt + 1)

    # board screws: insert bosses down to the board at H1-H4
    for x, y in F.HOLES:
        body += F.cyl(x, F.Y(y), 0.0, zu + 0.01, F.BOSS_D)
        body -= F.cyl(x, F.Y(y), -0.01, F.INSERT_L, F.INSERT_D)

    # the handset's bed: a round pocket for each cup, 1 mm roomy (the handle arches clear above the
    # pillow); the upper cup sits on the pocket's floor, the lower cup's pocket is CUP_DROP deeper
    yc = HS.LENGTH / 2 - HS.CUP_D / 2
    low, high = (HS_C[0], HS_C[1] - yc), (HS_C[0], HS_C[1] + yc)
    body -= F.cyl(high[0], high[1], HS_Z, BED_TOP + 1, HS.CUP_D + 2.0)
    body -= F.cyl(low[0], low[1], HS_Z - CUP_DROP, BED_TOP + 1, HS.CUP_D + 2.0)

    # the hook key under the tongue: its opening and room for the cap and the nub to move
    body -= F.rrect(hx, hy, F.HOLE, F.HOLE, F.BUTTON_R + 0.3, zu - 1, zt + 0.01)
    body -= F.rrect(hx, hy, F.HOLE + 3.0, F.HOLE + 3.0, F.BUTTON_R + 1.5, zt, HS_Z)

    # the tongue: printed with the case, rooted on a pedestal toward the cup's middle
    t0, t1 = TONGUE_X
    tongue = F.bx(t0, t1, low[1] - TONGUE_W / 2, low[1] + TONGUE_W / 2, HS_Z - TONGUE_T, HS_Z)
    tongue += F.bx(t0 - 6.0, t0 + 0.5, low[1] - TONGUE_W / 2, low[1] + TONGUE_W / 2, HS_Z - CUP_DROP - 0.5, HS_Z)
    tongue += F.cyl(hx, hy, F.CAP_TOP + GAP, HS_Z - TONGUE_T + 0.01, NUB_D)
    body += tongue

    # sound and light: the piezo's slots and the LED's pipe up through the pillow
    body -= F.grille_slots(zu - 1, BED_TOP + 1)
    lx, ly = P.LED[0], F.Y(P.LED[1])
    body += F.cyl(lx, ly, 1.5, zu + 0.01, F.LIGHT_PIPE + 2.4)
    body -= F.cyl(lx, ly, 1.0, BED_TOP + 1, F.LIGHT_PIPE + 0.2)

    # cords out through the bed pillow's outer side, and bosses for the bottom plate
    for d, y in CORD_HOLES:
        body -= F.Pos(bx0 + WALL / 2, y, -3.0) * F.Rot(0, 90, 0) * Cylinder(d / 2, WALL * 3)
    for x, y in plate_screws():
        body += F.cyl(x, y, Z_BOT + 2.5, Z_BOT + 7.0, 7.0)
        body -= F.cyl(x, y, Z_BOT + 2.5 - 0.01, Z_BOT + 2.5 + F.INSERT_L, F.INSERT_D)
    return body


def plate_screws():
    """Bosses on straight stretches of wall (each touches it), clear of the board."""
    kx0, kx1, ky0, ky1 = KEY_BOX
    bx0, bx1, by0, by1 = BED_BOX
    d = WALL + 3.2
    return [(kx1 - d, ky0 + 25.0), (kx1 - d, ky1 - 25.0), (bx0 + d, by0 + 40.0), (bx0 + d, by1 - 40.0),
            (bx1 - d, by1 - 30.0)]


def build_plate():
    """The bottom: flush inside the pillows' walls, screwed up into six bosses, four feet."""
    kx0, kx1, ky0, ky1 = KEY_BOX
    bx0, bx1, by0, by1 = BED_BOX
    g = WALL + 0.3
    plate = F.rrect((kx0 + kx1) / 2, (ky0 + ky1) / 2, kx1 - kx0 - 2 * g, ky1 - ky0 - 2 * g, KEY_R * CORNER - g, Z_BOT, Z_BOT + 2.5)
    plate += F.rrect((bx0 + bx1) / 2, (by0 + by1) / 2, bx1 - bx0 - 2 * g, by1 - by0 - 2 * g, BED_R * CORNER - g, Z_BOT, Z_BOT + 2.5)
    for x, y in plate_screws():
        plate -= F.cyl(x, y, Z_BOT - 1, Z_BOT + 3.5, 3.4)
        plate -= F.cyl(x, y, Z_BOT - 0.01, Z_BOT + 1.6, 6.4)          # screw head
    for x, y in ((kx1 - 20, ky0 + 20), (kx1 - 20, ky1 - 20), (bx0 + 20, by0 + 20), (bx0 + 20, by1 - 20)):
        plate -= F.cyl(x, y, Z_BOT - 0.01, Z_BOT + 1.0, 10.5)          # stick-on rubber feet
    return plate


def build_puffy_cap(label: str):
    """A captive cap with a puffy, marshmallow top and an engraved legend."""
    btn = F.rrect(0, 0, F.BUTTON, F.BUTTON, 4.0, F.FLANGE_Z1 - 0.01, F.CAP_TOP)
    try:
        btn = fillet([e for e in btn.edges() if e.center().Z > F.CAP_TOP - 0.1], 3.2)
    except Exception:
        pass
    cap = F.round_top(F.rrect(0, 0, F.FLANGE, F.FLANGE, F.FLANGE_R, F.FLANGE_Z0, F.FLANGE_Z1), F.FLANGE_Z1, 0.6)
    cap = cap + btn + F.cyl(0, 0, F.POST_Z0, F.FLANGE_Z0 + 0.01, F.POST_D)
    for w, l in ((F.CROSS_W, F.CROSS_L), (F.CROSS_L, F.CROSS_W)):
        cap -= F.bx(-w / 2, w / 2, -l / 2, l / 2, F.POST_Z0 - 1, F.POST_Z0 + F.SOCKET_DEPTH + 0.4)
    text = F.LEGENDS.get(label, label)
    if text:
        size = 6.5 if len(text) == 1 else 2.7
        t = extrude(Text(text, font_size=size, font_style=FontStyle.BOLD), amount=3.0)
        cap -= Pos(0, 0, F.CAP_TOP - 0.7) * t
    return cap


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / "caps").mkdir(exist_ok=True)
    parts = {"plush-case": build_case(), "plush-bottom": build_plate()}
    for name, part in parts.items():
        export_step(part, str(OUT / f"{name}.step"))
        export_stl(part, str(OUT / f"{name}.stl"), tolerance=0.02, angular_tolerance=0.15)
        bb = part.bounding_box()
        print(f"{name}: {bb.size.X:.1f} x {bb.size.Y:.1f} x {bb.size.Z:.1f} mm, {part.volume / 1000:.1f} cm3, "
              f"{len(part.solids())} solid(s) {[round(x.volume) for x in part.solids()][:5]}")
    for _, _, lab in F.SWITCHES:
        cap = build_puffy_cap(lab) if lab != "HOOK" else F.build_cap("HOOK")
        export_stl(cap, str(OUT / "caps" / f"puffy-{lab.lower()}.stl"), tolerance=0.01, angular_tolerance=0.1)
        export_step(cap, str(OUT / "caps" / f"puffy-{lab.lower()}.step"))
    # how far the handset bends the tongue (cantilever, the lower cup's half of the weight at the nub)
    e_mpa = 2000.0
    i = TONGUE_W * TONGUE_T ** 3 / 12
    a = hook_xy()[0] - TONGUE_X[0]
    per_n = a ** 3 / (3 * e_mpa * i)
    print(f"tongue {TONGUE_X[1] - TONGUE_X[0]:.0f} x {TONGUE_W} x {TONGUE_T} mm: {per_n:.1f} mm per newton at the key "
          f"(a 200 g handset puts ~1 N on it: ~{per_n:.1f} mm free, the hook cap sits {GAP} mm under the nub)")


if __name__ == "__main__":
    main()
