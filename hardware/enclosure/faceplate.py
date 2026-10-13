"""One-piece faceplate for the minimal board: build/faceplate/ (STEP, STL, drawing, render).

It covers the whole top of the board and drops on over the switches as they are (board-mounted
MX switches, no plate): one opening per switch (12 keys + the hook switch), a raised hood over the
e-paper module with a window onto the panel, a raised grille over the piezo, a pilot-light hole
over the status LED, and a skirt round the board edge. M3 screws come up through the board's four
holes (H1-H4) into heat-set inserts in bosses under the face.

Every position comes from the KiCad placement (proto_box.py: COLS, YR, YF, HOOK, HOLES, the
display, BZ1, LED). Coordinates here: board top-left origin like KiCad, x right, y down in the
board file, written as y up (BOARD_H - by); z = 0 is the board's top surface.

    .venv/bin/python faceplate.py        # OLP_DISPLAY=2.13 (default here) or 2.9

The heights that depend on your parts are parameters with how to measure them (FACE_Z, the
display stack). Dimensions are nominal (industrial printing: no FDM allowances).
"""
from __future__ import annotations

import math
import os
from pathlib import Path

os.environ.setdefault("OLP_DISPLAY", "2.13")   # the module the boards are being built with

from build123d import (Align, Axis, Box, Cylinder, GeomType, Pos, RectangleRounded, Select,  # noqa: E402
                       export_step, export_stl, extrude, fillet)

import proto_box as P  # noqa: E402

HERE = Path(__file__).resolve().parent
OUT = HERE / "build" / "faceplate"

# ---------------------------------------------------------------- what the faceplate fits
BOARD_W, BOARD_H, BOARD_R, BOARD_T = P.BOARD_W, P.BOARD_H, P.BOARD_R, P.BOARD_T
SWITCHES = [(bx, by, lab) for bx, by, lab in P.keys()]          # 12 keys + HOOK (SW15)
HOLES = P.HOLES                                                   # H1-H4, M3
MX_FLANGE = 15.6        # MX top housing, widest (its base): the opening must pass over it
MX_PLATE_Z = 5.0        # where a plate's top would be (MX: board top + 5.0)

# ---------------------------------------------------------------- the faceplate (mm)
# Face top above the board. It must stay below the keycaps' bottom edge when a key is pressed all
# the way: press a key down, measure board top -> keycap bottom edge (call it A), and set
# FACE_Z = A - 0.8. 4.6 sits just under where a switch plate would be (5.0), which MX keycaps
# never reach.
FACE_Z = 4.6
FACE_T = 2.0            # face thickness (its underside clears everything at 2.6 above the board)
CUT = 16.2              # switch openings: MX_FLANGE + 0.3 a side (the keycap's 18.2 hides it)
CUT_R = 1.6             # their corners
SKIRT_GAP, SKIRT_WALL = 0.3, 2.2   # round the board edge, down to the board's underside
EDGE_ROUND = 2.4        # the soft rounded top edge (enamel look)
BOSS_D = 7.0            # M3 insert bosses at H1-H4
INSERT_D, INSERT_L = 4.0, 3.0      # M3 x 3 heat-set insert (OD 4.0-4.2): leaves a 1.6 mm skin

# Display: the module stands on J3 (8.5) + its pins' plastic (2.5) = 11.0 (P.STANDOFF_L);
# module board 1.7, the panel's glass on it ~1.2 (measure: board top -> glass top = DISP_TOP).
DISP_TOP = P.STANDOFF_L + P.MODULE_PCB_T + 1.2      # 13.9
HOOD_WALL = 2.0
HOOD_LIP = 1.4          # over the glass edge, round the window
HOOD_R = 5.0            # its corners seen from above
WIN = P.VIEW            # window over the active area (EST: check against your panel)
WIN_R = 1.5
SCREW_HEAD_D, SCREW_HEAD_H = 6.0, 2.2    # the module's far-end screws: pockets in the lip
# Piezo BZ1: 12.2 round, 6.5 tall: higher than the face, so a raised grille covers it.
BZ = P.BZ1_C
BZ_D, BZ_H = P.BZ1_D, P.BZ1_H
GRILLE_D, GRILLE_TOP = 21.0, BZ_H + 1.6           # dome-ish round grille, its top 8.1 above board
SLOT_W, SLOT_PITCH = 1.4, 3.0
LED_HOLE = 3.0          # status LED (D2 shines up through the board)


def Y(by: float) -> float:
    """KiCad's y (down) -> this model's y (up)."""
    return BOARD_H - by


def rrect(cx, cy, w, h, r, z0, z1):
    r = max(0.01, min(r, w / 2 - 0.01, h / 2 - 0.01))
    return extrude(Pos(cx, cy, z0) * RectangleRounded(w, h, r), amount=z1 - z0)


def cyl(x, y, z0, z1, d):
    return Pos(x, y, z0) * Cylinder(d / 2, z1 - z0, align=(Align.CENTER, Align.CENTER, Align.MIN))


def round_top(part, z, r):
    """Fillet the horizontal edges lying at height z (soft top edges)."""
    edges = [e for e in part.edges() if abs(e.center().Z - z) < 1e-3 and abs(e.length) > 0.5
             and abs(e.start_point().Z - e.end_point().Z) < 1e-6]
    try:
        return fillet(edges, r) if edges else part
    except Exception:
        return part


def display():
    """(centre x, centre y, w, h) of the fitted module, and its window, in model coords."""
    d = P.DSP
    cx = P.DISP_X0 + d["w"] / 2
    wx = P.DISP_X0 + d["view_cx"]
    return (cx, Y(P.DISP_MID), d["w"], d["h"]), (wx, Y(P.DISP_MID), WIN[0], WIN[1])


def build():
    cx, cy = BOARD_W / 2, BOARD_H / 2
    out_w, out_h = BOARD_W + 2 * (SKIRT_GAP + SKIRT_WALL), BOARD_H + 2 * (SKIRT_GAP + SKIRT_WALL)
    out_r = BOARD_R + SKIRT_GAP + SKIRT_WALL
    z_top, z_under = FACE_Z, FACE_Z - FACE_T
    # Shell: the face plus the skirt down to the board's underside, with a rounded top edge.
    shell = rrect(cx, cy, out_w, out_h, out_r, -BOARD_T, z_top)
    shell = round_top(shell, z_top, EDGE_ROUND)
    shell -= rrect(cx, cy, BOARD_W + 2 * SKIRT_GAP, BOARD_H + 2 * SKIRT_GAP, BOARD_R + SKIRT_GAP,
                   -BOARD_T - 1, z_under)
    # Display hood: walls round the module from the face up past the glass, a lip, a window.
    (mx, my, mw, mh), (wx, wy, ww, wh) = display()
    cav_w, cav_h = mw + 0.6, mh + 0.6
    hood_w, hood_h = cav_w + 2 * HOOD_WALL, cav_h + 2 * HOOD_WALL
    module_top = P.STANDOFF_L + P.MODULE_PCB_T          # the module's board: screw heads sit on it
    # high enough over the glass for the lip, and over the screw heads for a 1 mm skin
    hood_top = max(DISP_TOP + 0.2 + HOOD_LIP, module_top + SCREW_HEAD_H + 0.2 + 1.0)
    hood = rrect(mx, my, hood_w, hood_h, HOOD_R, z_under, hood_top)
    hood = round_top(hood, hood_top, 1.8)
    shell += hood
    shell -= rrect(mx, my, cav_w, cav_h, 1.0, z_under - 1, DISP_TOP + 0.2)      # the module
    win = rrect(wx, wy, ww, wh, WIN_R, DISP_TOP, hood_top + 1)
    shell -= win
    # chamfer-like bevel round the window: a slightly larger window in the lip's top half
    shell -= rrect(wx, wy, ww + 1.6, wh + 1.6, WIN_R + 0.8, hood_top - 0.6, hood_top + 1)
    for bx, by in P.MODULE_FAR_HOLES:                                      # screw heads
        shell -= cyl(bx, Y(by), module_top - 0.1, module_top + SCREW_HEAD_H + 0.2, SCREW_HEAD_D)
    # Piezo grille: a raised round boss with slots, hollow over the piezo.
    gx, gy = BZ[0], Y(BZ[1])
    grille = cyl(gx, gy, z_under, GRILLE_TOP, GRILLE_D)
    grille = round_top(grille, GRILLE_TOP, 1.6)
    shell += grille
    shell -= cyl(gx, gy, z_under - 1, BZ_H + 0.4, BZ_D + 0.8)
    n = int((BZ_D - 2) // SLOT_PITCH)
    for i in range(n):
        sy = gy + (i - (n - 1) / 2) * SLOT_PITCH
        half = math.sqrt(max(0.0, (BZ_D / 2 - 0.8) ** 2 - (sy - gy) ** 2))
        if half > 1.0:
            shell -= rrect(gx, sy, 2 * half, SLOT_W, SLOT_W / 2 - 0.01, BZ_H, GRILLE_TOP + 1)
    # Switch openings (12 keys + hook): through the face, rounded corners.
    for bx, by, _ in SWITCHES:
        shell -= rrect(bx, Y(by), CUT, CUT, CUT_R, z_under - 1, z_top + 1)
    # Status LED: a pilot-light hole.
    shell -= cyl(P.LED[0], Y(P.LED[1]), z_under - 1, z_top + 1, LED_HOLE)
    # M3 insert bosses down to the board at H1-H4 (screws come up through the board).
    for bx, by in HOLES:
        boss = cyl(bx, Y(by), 0.0, z_under + 0.01, BOSS_D)
        shell += boss
        shell -= cyl(bx, Y(by), -0.01, INSERT_L, INSERT_D)
    return shell


def report(shell) -> list[str]:
    bb = shell.bounding_box()
    (mx, my, mw, mh), (wx, wy, ww, wh) = display()
    lines = [
        "Faceplate (all mm; board top-left corner = origin, x right, y down as in KiCad; z = board top)",
        f"Outside: {bb.size.X:.1f} x {bb.size.Y:.1f}, corners R{BOARD_R + SKIRT_GAP + SKIRT_WALL:.1f}; "
        f"skirt {SKIRT_WALL} thick, {SKIRT_GAP} clear of the board edge, down to the board's underside",
        f"Face top {FACE_Z} above the board top (set from your keycaps: see FACE_Z), face {FACE_T} thick",
        f"Highest point: display hood {bb.max.Z:.1f} above the board top",
        f"Switch openings: {CUT} x {CUT} (R{CUT_R}), 13, centred on the switches:",
    ]
    for bx, by, lab in SWITCHES:
        lines.append(f"  {lab:5s} centre ({bx:7.2f}, {by:6.2f})")
    lines += [
        f"Pitch {P.PITCH} across; rows at y = {P.YR} and {P.YF}; hook switch at {P.HOOK}",
        f"Display hood over the module {mw} x {mh} (centre {mx:.2f}, {BOARD_H - my:.2f}): "
        f"cavity {mw + 0.6:.1f} x {mh + 0.6:.1f} up to {DISP_TOP + 0.2:.1f}; window {ww} x {wh} "
        f"centred ({wx:.2f}, {BOARD_H - wy:.2f}); screw-head pockets D{SCREW_HEAD_D} at "
        + ", ".join(f"({x:.1f}, {y:.1f})" for x, y in P.MODULE_FAR_HOLES),
        f"Piezo grille D{GRILLE_D} at ({BZ[0]}, {BZ[1]}), top {GRILLE_TOP:.1f}; hollow D{BZ_D + 0.8:.1f} "
        f"to {BZ_H + 0.4:.1f}",
        f"LED hole D{LED_HOLE} at ({P.LED[0]}, {P.LED[1]})",
        "Insert bosses D{} at H1-H4: {}; hole D{} x {} deep (M3 x 3 heat-set insert); "
        "screws M3 x 5 from under the board".format(
            BOSS_D, ", ".join(f"({x}, {y})" for x, y in HOLES), INSERT_D, INSERT_L),
    ]
    return lines


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    shell = build()
    export_step(shell, str(OUT / "faceplate.step"))
    export_stl(shell, str(OUT / "faceplate.stl"), tolerance=0.02, angular_tolerance=0.15)
    text = "\n".join(report(shell))
    (OUT / "faceplate.txt").write_text(text + "\n")
    print(text)
    print("volume", round(shell.volume / 1000, 1), "cm3")


if __name__ == "__main__":
    main()
