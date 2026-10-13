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

from build123d import (Align, Axis, Box, Cylinder, GeomType, Pos, RectangleRounded, Rot, Select,  # noqa: E402
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


# ---------------------------------------------------------------- wall version: payphone cradle
# The faceplate grows a wing on the left (the phone hangs on a wall, y up); on it, a saddle whose
# prongs are part of the print. The handset's earpiece cup drops into the saddle and its rim rests
# on a two-finger fork (the handle hangs down between the fingers). The fork is keyed on a printed
# D-shaft that runs sideways through both prongs and a bearing block to an arm over the hook switch
# (SW15): the cup's weight turns the shaft and the arm's foot presses SW15's keycap in. Lift the
# handset and SW15's own spring plus one compression spring under a finger bring the fork back up.
# A ledge under the fingers stops them, so the switch travels ~3 mm (actuates at 2, bottoms at 4).
# Handset sizes are the Opis 60s Micro's (cup ~70, handle ~40): measure yours.
WING_W = 92.0             # wing width left of the faceplate's skirt
CUP_IN = 72.0             # between the prongs (the earpiece cup's diameter + 2)
PRONG = 9.0               # prong wall thickness
HANDLE_GAP = 42.0         # between the fingers: the handle hangs through here
LIPS = 8.0                # front lips narrow the opening so the cup can't fall forward
SAD_Y0, SAD_Y1 = 24.0, 76.0      # saddle bottom and prong tops (y, model)
SAD_Z1 = 68.0             # how far the saddle stands out (z above the board top)
BACK_Z = 20.0             # the saddle's back wall face
AX_Y, AX_Z = 38.0, 26.0   # the shaft (y, z); above SW15's keycap top (P.CAP_TOP + 5 = 22)
SHAFT_D, SHAFT_FLAT = 6.0, 1.0    # printed D-shaft
BEARING = 6.4             # round holes it turns in
FINGER_W, FINGER_T = 12.0, 4.0
FINGER_TIP_Z = 58.0
LEDGE_TOP = AX_Y - 6.0    # under the fingers: their stop (4 mm at the tips)
SPRING_D, SPRING_POCKET = 5.6, 5.0   # a 5 x 10 mm compression spring
HUB_D = 12.0
ARM_X = 16.0              # over SW15
BLOCK_X = (5.0, 10.0)     # the bearing block between the prong and the arm
KEYCAP_TOP = P.PLATE_ABOVE_PCB + P.CAP_TOP   # 22: SW15 keeps a 1u keycap the arm presses


def sad_x() -> float:
    return -(SKIRT_GAP + SKIRT_WALL) - WING_W / 2


def xcyl(x0, x1, y, z, d):
    """A cylinder along x."""
    return Pos((x0 + x1) / 2, y, z) * Rot(0, 90, 0) * Cylinder(d / 2, x1 - x0)


def dshaft_hole(x0, x1, y, z, d, flat):
    """A D-shaped hole along x (keys the fork and the arm to the shaft)."""
    hole = xcyl(x0, x1, y, z, d)
    return hole - Pos((x0 + x1) / 2, y, z + d / 2 - flat / 2 + 0.25) * Box(x1 - x0 + 2, d + 2, flat + 0.5)


def bx(x0, x1, y0, y1, z0, z1):
    return Pos((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2) * Box(x1 - x0, y1 - y0, z1 - z0)


def build_wall():
    """The faceplate with the wing and the saddle (one print)."""
    shell = build(WING_W)
    z_top = FACE_Z
    # the saddle: two prongs and a back wall, then the cavity, the lips and the handle gap
    sx = sad_x()
    hw = CUP_IN / 2 + PRONG
    saddle = rrect(sx, (SAD_Y0 + SAD_Y1) / 2, 2 * hw, SAD_Y1 - SAD_Y0, 6.0, z_top - 0.5, SAD_Z1)
    saddle = round_top(saddle, SAD_Z1, 3.0)
    saddle -= bx(sx - CUP_IN / 2, sx + CUP_IN / 2, LEDGE_TOP, SAD_Y1 + 1, BACK_Z, SAD_Z1 + 1)
    # front lips: the opening narrows at the front
    saddle += bx(sx - CUP_IN / 2, sx - CUP_IN / 2 + LIPS, LEDGE_TOP, SAD_Y1, SAD_Z1 - 6, SAD_Z1)
    saddle += bx(sx + CUP_IN / 2 - LIPS, sx + CUP_IN / 2, LEDGE_TOP, SAD_Y1, SAD_Z1 - 6, SAD_Z1)
    # the handle hangs through the floor between the fingers (front of the shaft)
    saddle -= bx(sx - HANDLE_GAP / 2, sx + HANDLE_GAP / 2, SAD_Y0 - 1, LEDGE_TOP + 0.1, AX_Z + HUB_D / 2 + 1, SAD_Z1 + 1)
    # room for the fork's hub to turn, behind the ledges
    saddle -= bx(sx - CUP_IN / 2, sx + CUP_IN / 2, AX_Y - HUB_D / 2 - 1.5, LEDGE_TOP + 0.1, BACK_Z, AX_Z + HUB_D / 2 + 1)
    # the shaft's holes through both prongs (the left one blind, from inside)
    saddle -= xcyl(sx - CUP_IN / 2 - PRONG + 2, sx + hw + 1, AX_Y, AX_Z, BEARING)
    # spring pocket under the left finger, near its tip
    fx = sx - HANDLE_GAP / 2 - FINGER_W / 2 - 0.5
    saddle -= Pos(fx, LEDGE_TOP - SPRING_POCKET / 2, FINGER_TIP_Z - 8) * Rot(90, 0, 0) * Cylinder(SPRING_D / 2, SPRING_POCKET)
    shell = shell + saddle
    # bearing block between the prong and the arm (over the board's left edge, clear of the LED)
    block = rrect(sum(BLOCK_X) / 2, AX_Y, BLOCK_X[1] - BLOCK_X[0], 14.0, 2.0, z_top - 0.5, AX_Z + 7)
    block = round_top(block, AX_Z + 7, 2.0)
    block -= xcyl(BLOCK_X[0] - 1, BLOCK_X[1] + 1, AX_Y, AX_Z, BEARING)
    shell = shell + block
    return shell


def build_fork():
    """The two-finger fork, keyed onto the shaft."""
    sx = sad_x()
    hub_len = CUP_IN - 1.0
    fork = xcyl(sx - hub_len / 2, sx + hub_len / 2, AX_Y, AX_Z, HUB_D)
    for side in (-1, 1):
        x_in = sx + side * HANDLE_GAP / 2
        x0, x1 = sorted((x_in, x_in + side * FINGER_W))
        fork += bx(x0, x1, AX_Y + 2 - FINGER_T, AX_Y + 2, AX_Z, FINGER_TIP_Z)
        fork += Pos((x0 + x1) / 2, AX_Y + 2 - FINGER_T / 2, FINGER_TIP_Z) * Rot(0, 90, 0) * Cylinder(FINGER_T / 2, x1 - x0)
    fork -= dshaft_hole(sx - hub_len / 2 - 1, sx + hub_len / 2 + 1, AX_Y, AX_Z, SHAFT_D + 0.2, SHAFT_FLAT)
    return fork


def build_arm():
    """The arm over SW15: a hub keyed on the shaft and a foot that presses the keycap."""
    w = 6.0
    arm = xcyl(ARM_X - w / 2, ARM_X + w / 2, AX_Y, AX_Z, HUB_D)
    arm += bx(ARM_X - w / 2, ARM_X + w / 2, P.YR - 4, AX_Y, AX_Z - 3, AX_Z + 3)     # the bar down
    arm += bx(ARM_X - 6, ARM_X + 6, P.YR - 6, P.YR + 6, KEYCAP_TOP, AX_Z - 2)        # the foot
    arm -= dshaft_hole(ARM_X - w / 2 - 1, ARM_X + w / 2 + 1, AX_Y, AX_Z, SHAFT_D + 0.2, SHAFT_FLAT)
    # an M3 grub screw clamps it on the flat
    arm -= Pos(ARM_X, AX_Y, AX_Z + HUB_D / 2) * Cylinder(1.25, HUB_D / 2 + 1)
    return arm


def build_shaft():
    """The printed D-shaft: from inside the left prong to past the arm."""
    sx = sad_x()
    x0 = sx - CUP_IN / 2 - PRONG + 2.5
    x1 = ARM_X + 3.0
    shaft = xcyl(x0, x1, AX_Y, AX_Z, SHAFT_D)
    shaft -= Pos((x0 + x1) / 2, AX_Y, AX_Z + SHAFT_D / 2 - SHAFT_FLAT / 2 + 0.25) * Box(x1 - x0 + 2, SHAFT_D + 2, SHAFT_FLAT + 0.5)
    return shaft


# ---------------------------------------------------------------- variant B: one-piece rocker
SNAP = 5.4                # the open-top bearing's mouth: the 6 mm bar snaps past it


def snap_slot(x0, x1, y_top):
    """An open-top bearing along x: a round seat at the shaft, a narrower mouth up to y_top."""
    seat = xcyl(x0, x1, AX_Y, AX_Z, BEARING)
    return seat + bx(x0, x1, AX_Y, y_top + 1, AX_Z - SNAP / 2, AX_Z + SNAP / 2)


def build_wall_b():
    """The faceplate and saddle with open-top (snap) bearings instead of holes."""
    shell = build_wall()
    sx = sad_x()
    hw = CUP_IN / 2 + PRONG
    for x0, x1 in ((sx - hw + 2, sx - CUP_IN / 2 + 0.1), (sx + CUP_IN / 2 - 0.1, sx + hw + 0.1)):
        shell -= snap_slot(x0, x1, SAD_Y1)
    shell -= snap_slot(BLOCK_X[0] - 1, BLOCK_X[1] + 1, AX_Y + 8)
    return shell


def build_rocker():
    """B: the fork's fingers, a 6 mm bar and the arm over SW15 in one print."""
    sx = sad_x()
    rocker = build_fork()
    x0 = sx - CUP_IN / 2 - PRONG + 2.5
    rocker += xcyl(x0, ARM_X + 3, AX_Y, AX_Z, SHAFT_D)
    arm = build_arm()
    rocker += arm
    rocker -= Pos(ARM_X, AX_Y, AX_Z + HUB_D / 2) * Cylinder(1.3, HUB_D / 2 + 1)   # no grub screw
    return rocker


# ---------------------------------------------------------------- variant C: a hook, no saddle
HOOK_Y = 70.0             # where the hook sticks out (upper wing)
HOOK_LEN = 62.0           # from the shaft to the tip
HOOK_W, HOOK_T = 16.0, 7.0


def build_wall_c():
    """The faceplate with the wing and a smooth boss housing the hook's pivot (no saddle)."""
    shell = build(WING_W)
    z_top = FACE_Z
    sx = sad_x()
    # a long smooth boss on the wing carrying the bar from the hook to the board edge
    boss = rrect((sx - 20 + BLOCK_X[1]) / 2, AX_Y, BLOCK_X[1] - (sx - 20), 18.0, 9.0, z_top - 0.5, AX_Z + 8)
    boss = round_top(boss, AX_Z + 8, 4.0)
    # a channel the bar turns in (open at the top: it snaps in), and the hook's slot
    boss -= snap_slot(sx - 20 + 4, BLOCK_X[1] + 1, AX_Y + 10)
    boss -= bx(sx - HOOK_W / 2 - 1, sx + HOOK_W / 2 + 1, AX_Y - 10, AX_Y + 10, AX_Z - 6, AX_Z + 9)
    shell = shell + boss
    return shell


def build_hook():
    """C: the hook (handset hangs on it by the handle), the bar and the arm, one print."""
    sx = sad_x()
    hook = xcyl(sx - 20 + 4.5, ARM_X + 3, AX_Y, AX_Z, SHAFT_D)
    hub = xcyl(sx - HOOK_W / 2, sx + HOOK_W / 2, AX_Y, AX_Z, HUB_D)
    arm_out = bx(sx - HOOK_W / 2, sx + HOOK_W / 2, AX_Y - HOOK_T / 2, AX_Y + HOOK_T / 2, AX_Z, AX_Z + HOOK_LEN)
    lip = bx(sx - HOOK_W / 2, sx + HOOK_W / 2, AX_Y - HOOK_T / 2, AX_Y + 14, AX_Z + HOOK_LEN - HOOK_T, AX_Z + HOOK_LEN)
    hook = hook + hub + arm_out + lip
    hook = round_top(hook, AX_Y + 14, 2.0)
    hook += build_arm()
    hook -= Pos(ARM_X, AX_Y, AX_Z + HUB_D / 2) * Cylinder(1.3, HUB_D / 2 + 1)
    return hook


def build(wing: float = 0.0):
    """The faceplate; `wing` grows it that much to the left (the wall version's cradle wing)."""
    cx, cy = BOARD_W / 2, BOARD_H / 2
    edge = SKIRT_GAP + SKIRT_WALL
    out_w, out_h = BOARD_W + 2 * edge + wing, BOARD_H + 2 * edge
    out_r = BOARD_R + edge
    z_top, z_under = FACE_Z, FACE_Z - FACE_T
    # Shell: the face plus the skirt down to the board's underside, with a rounded top edge.
    shell = rrect(cx - wing / 2, cy, out_w, out_h, out_r, -BOARD_T, z_top)
    shell = round_top(shell, z_top, EDGE_ROUND)
    shell -= rrect(cx, cy, BOARD_W + 2 * SKIRT_GAP, BOARD_H + 2 * SKIRT_GAP, BOARD_R + SKIRT_GAP,
                   -BOARD_T - 1, z_under)
    if wing:   # the wing is hollow underneath too (the wall box closes it)
        x0, x1 = -edge - wing + SKIRT_WALL, -SKIRT_GAP
        shell -= rrect((x0 + x1) / 2, cy, x1 - x0, BOARD_H + 2 * SKIRT_GAP, 2.0, -BOARD_T - 1, z_under)
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
    if os.environ.get("OLP_FACEPLATE") == "wall":
        parts = {"a-faceplate": build_wall(), "a-fork": build_fork(), "a-arm": build_arm(),
                 "a-shaft": build_shaft(),
                 "b-faceplate": build_wall_b(), "b-rocker": build_rocker(),
                 "c-faceplate": build_wall_c(), "c-hook": build_hook()}
        for name, part in parts.items():
            export_step(part, str(OUT / f"{name}.step"))
            export_stl(part, str(OUT / f"{name}.stl"), tolerance=0.02, angular_tolerance=0.15)
            bb = part.bounding_box()
            print(f"{name}: {bb.size.X:.1f} x {bb.size.Y:.1f} x {bb.size.Z:.1f} mm, "
                  f"{part.volume / 1000:.1f} cm3")
        return
    shell = build()
    export_step(shell, str(OUT / "faceplate.step"))
    export_stl(shell, str(OUT / "faceplate.stl"), tolerance=0.02, angular_tolerance=0.15)
    text = "\n".join(report(shell))
    (OUT / "faceplate.txt").write_text(text + "\n")
    print(text)
    print("volume", round(shell.volume / 1000, 1), "cm3")


if __name__ == "__main__":
    main()
