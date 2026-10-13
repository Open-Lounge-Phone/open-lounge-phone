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


# ---------------------------------------------------------------- switchhook (wall)
# The phone hangs on a wall, top up. One rocker, like an old payphone switchhook: a cradle whose
# two arms stand out from the wall and curl up round the earpiece cup (the handle hangs down
# between them, slid in from the front), a pivot hub, and a long tongue that runs down the face to
# SW15's keycap. The handset's weight tips the cradle down, the tongue presses the hook switch.
# Lift it: SW15's own spring lifts the tongue back. No other spring.
#
# Made for hard use: the rocker is a one-off in metal (316L or AlSi10Mg metal printing, or cast
# bronze/aluminium from a printed pattern; every edge rounded, walls >= 3 mm, no undercuts on the
# parting line y = pivot) or glass-filled nylon / PC. The faceplate's pivot mount is two thick
# lugs with gussets and a rib into the H4 screw boss, so the load goes into a screw, not the face.
# The pin is a 3 mm stainless dowel (ISO 2338, 3 x 36) in two flanged bushings (3 x 5 x 6,
# bronze or PTFE-lined) pressed into the lugs; the rocker turns on the pin (3.1 hole, ream 3 H8).
KEYCAP_TOP = P.PLATE_ABOVE_PCB + P.CAP_TOP   # 22: SW15's keycap top, not pressed (MEASURE yours)
PIV_X, PIV_KY = P.HOOK[0], P.BZ1_C[1]        # over the piezo, in line with SW15 (KiCad x, y)
PIV_Z = KEYCAP_TOP + 5.0                      # the tongue's underside sits on the keycap
HUB_D, HUB_X = 12.0, (6.0, 26.0)              # the pivot hub, between the lugs
PIN_D = 3.1
BUSH_OD, BUSH_L = 5.0, 6.0
LUG_T, LUG_GAP, LUG_W = 7.0, 0.5, 18.0
TONGUE_W, TONGUE_T = 9.0, 5.0
FOOT = 16.0                # the tongue's foot on the hook keycap
NECK = 40.0                # MEASURE: the handle's width under the cup (passes between the arms)
ROD_D = 8.0                # the cradle bar: a round bar, like a bent-rod switchhook
U_Z0 = 44.0                # the U's back, out from the board top
U_LIFT = 4.0               # the U's sides rise this much: a shallow bowl for the cup
ARM_L = 30.0               # the arms run straight out ...
CURL = 14.0                # ... and curl up this much at the tips, cupping the earpiece
PAD_D, PAD_T = 17.0, 5.0   # spoon pads on the tips
CRADLE_Z = U_Z0 + NECK / 2 + 10.0   # where the cup's weight lands, roughly
DENSITY = {"aluminium (AlSi10Mg, cast A356)": 2.68, "stainless 316L": 7.98, "bronze / brass": 8.6,
           "glass-filled nylon (PA12-GF)": 1.22}
HANDSET_G = 200.0          # MEASURE: your handset's weight
# Return spring: a compression spring in a boss under the tongue pushes it up, so with nothing on
# the hook the rocker sits up against its stop (the end of the shank's slot in the housing) and
# the hook key is free, whatever the rocker is made of. The handset's weight beats it.
SPRING_ARM = 18.0          # from the pin, along the tongue
SPRING_OD, SPRING_FREE = 5.0, 20.0   # compression spring, ~0.6 N/mm: ~2.5 N at its 16 mm fitted length
SPRING_N = 2.5
BOSS_TOP = 12.0            # the boss's top; the spring sits in a 6 mm deep pocket
STOP_GAP = 0.5             # the shank's clearance to its slot's end: the rocker's up-stop


def xbar(x0, x1, y, z, d):
    return Pos((x0 + x1) / 2, y, z) * Rot(0, 90, 0) * Cylinder(d / 2, x1 - x0)


def ybar(x, z, y0, y1, d):
    return Pos(x, (y0 + y1) / 2, z) * Rot(90, 0, 0) * Cylinder(d / 2, y1 - y0)


def bx(x0, x1, y0, y1, z0, z1):
    x0, x1 = sorted((x0, x1))
    y0, y1 = sorted((y0, y1))
    z0, z1 = sorted((z0, z1))
    return Pos((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2) * Box(x1 - x0, y1 - y0, z1 - z0)


def soften(part, r):
    try:
        return fillet(part.edges(), r)
    except Exception:
        return part


def pivot_housing():
    """The pivot mount as one sculpted piece: two cheeks, each lofted from a broad rounded foot
    that flares into the face up to a rounded crown round the pin, on a low plinth that runs
    forward over the H4 insert boss (the pin's load goes to a screw). The slot between the
    cheeks opens onto the piezo grille. Rounded by construction (no fillets on the loft)."""
    from build123d import Plane, loft
    y = Y(PIV_KY)
    hy = Y(P.HOLES[3][1])
    s0, s1 = HUB_X[0] - LUG_GAP, HUB_X[1] + LUG_GAP           # the slot
    by0, by1 = hy - 5.0, min(y + LUG_W / 2 + 9.0, BOARD_H + 1.5)
    h = None
    for (fx0, fx1), (tx0, tx1) in (((-2.0, s0), (s0 - LUG_T, s0)), ((s1, s1 + LUG_T + 3.0), (s1, s1 + LUG_T))):
        foot = Plane.XY.offset(FACE_Z - 0.6) * Pos((fx0 + fx1) / 2, (by0 + by1) / 2) * RectangleRounded(fx1 - fx0, by1 - by0, 3.0)
        crown = Plane.XY.offset(PIV_Z) * Pos((tx0 + tx1) / 2, y) * RectangleRounded(tx1 - tx0, LUG_W, 2.5)
        cheek = loft([foot, crown]) + soften(xbar(tx0, tx1, y, PIV_Z, LUG_W), 1.6)
        h = cheek if h is None else h + cheek
    # close the top and the upper side between the cheeks: the crown runs across, a filler drops
    # to the face above the pivot; the only openings face down (the nook where the tongue leaves),
    # so the piezo's sound comes out there
    mid = loft([Plane.XY.offset(FACE_Z - 0.6) * Pos((s0 + s1) / 2, (y + HUB_D / 2 + 1.0 + by1) / 2)
                * RectangleRounded(s1 - s0 + 1.0, by1 - y - HUB_D / 2 - 1.0, 1.0),
                Plane.XY.offset(PIV_Z) * Pos((s0 + s1) / 2, y + HUB_D / 4 + LUG_W / 4 + 0.5)
                * RectangleRounded(s1 - s0 + 1.0, LUG_W / 2 - HUB_D / 2 - 1.0, 0.4)])
    h += mid + xbar(s0 - 0.5, s1 + 0.5, y, PIV_Z, LUG_W)
    h -= xbar(s0, s1, y, PIV_Z, HUB_D + 1.6)                         # the hub turns in here
    # the shank's way out, open downward: the rocker slides in from below, then the pin
    top = ROD_D / 2 + STOP_GAP                                      # its end is the up-stop
    h -= rrect(PIV_X, y + (top - LUG_W - 4.0) / 2, ROD_D + 1.6, LUG_W + 4.0 + top, (ROD_D + 1.6) / 2 - 0.01,
               PIV_Z, PIV_Z + LUG_W)
    h -= bx(s0, s1, y - LUG_W, y, FACE_Z - 0.5, PIV_Z)                # the nook below the pivot
    plinth = rrect((-2.0 + s1 + LUG_T + 3.0) / 2, (by0 + Y(BZ[1] + GRILLE_D / 2 + 0.5)) / 2,
                   s1 + LUG_T + 5.0, Y(BZ[1] + GRILLE_D / 2 + 0.5) - by0, 3.0, FACE_Z - 0.6, FACE_Z + 2.5)
    h += round_top(plinth, FACE_Z + 2.5, 1.5)
    return h


def build_hook_face():
    """The faceplate with the pivot housing: bushing bores and a pin hole."""
    shell = build()
    y = Y(PIV_KY)
    shell += pivot_housing()
    # keep the piezo grille and its hollow open (the housing's base runs round them)
    gx, gy = BZ[0], Y(BZ[1])
    shell -= cyl(gx, gy, FACE_Z - FACE_T - 1, BZ_H + 0.4, BZ_D + 0.8)
    # the return spring's boss under the tongue
    sy = y - SPRING_ARM
    boss = cyl(PIV_X, sy, FACE_Z - 0.5, BOSS_TOP, SPRING_OD + 4.0)
    shell += round_top(boss, BOSS_TOP, 1.0)
    shell -= cyl(PIV_X, sy, BOSS_TOP - 6.0, BOSS_TOP + 1, SPRING_OD + 0.4)
    xl, xr = HUB_X[0] - LUG_GAP - LUG_T, HUB_X[1] + LUG_GAP + LUG_T
    shell -= xbar(xl - 1, xl + BUSH_L, y, PIV_Z, BUSH_OD)
    shell -= xbar(xr - BUSH_L, xr + 1, y, PIV_Z, BUSH_OD)
    return shell


def cradle():
    """The cradle: one round bar swept along a U whose arms curl up, spoon pads on the tips."""
    from build123d import Circle, Plane, Spline, sweep
    y0, cx = Y(PIV_KY), PIV_X
    half = NECK / 2 + ROD_D / 2                     # arm centre lines (the gap between = NECK)
    zc = U_Z0 + half                                 # the U's centre
    pts = []
    for k in range(5, 0, -1):                        # left arm, from the tip in
        t = k / 5
        pts.append((cx - half, y0 + U_LIFT + CURL * t ** 2, zc + ARM_L * t))
    for k in range(-6, 7):                           # the U round the wall side
        ph = math.radians(90 * k / 6)
        pts.append((cx + half * math.sin(ph), y0 + U_LIFT * (k / 6) ** 2, zc - half * math.cos(ph)))
    for k in range(1, 6):                            # right arm, out to the tip
        t = k / 5
        pts.append((cx + half, y0 + U_LIFT + CURL * t ** 2, zc + ARM_L * t))
    path = Spline(*pts)
    start = Plane(origin=path @ 0, x_dir=(0, 1, 0), z_dir=path % 0)
    bar = sweep(start * Circle(ROD_D / 2), path=path)
    for u in (0.0, 1.0):                             # spoon pads, tilted with the curl
        tip = path @ u
        tan = path % u
        pad = Plane(origin=tip, z_dir=(0, 1, 0)) * Cylinder(PAD_D / 2, PAD_T)
        pad = soften(pad, 1.4)
        tilt = math.degrees(math.atan2(tan.Y, abs(tan.Z)))
        pad = Pos(tip.X, tip.Y, tip.Z) * Rot(-tilt, 0, 0) * Pos(-tip.X, -tip.Y, -tip.Z) * pad
        bar += pad
    return bar, zc - half


def build_rocker():
    """The switchhook: cradle, shank, hub and tongue in one piece."""
    y, cx = Y(PIV_KY), PIV_X
    r, z_join = cradle()
    # the shank: from the hub out to the U's back, the bar's own size
    shank = cyl(cx, y, PIV_Z, z_join + 2.0, ROD_D)
    hub = soften(xbar(*HUB_X, y, PIV_Z, HUB_D), 1.0)
    y_end = Y(P.HOOK[1] + 4.0)
    tongue = rrect(cx, (y + y_end) / 2, TONGUE_W, y - y_end, TONGUE_W / 2 - 0.01,
                   KEYCAP_TOP, KEYCAP_TOP + TONGUE_T)
    # a broad foot on the end: it covers the hook key's keycap (18.2 square)
    tongue += rrect(cx, Y(P.HOOK[1]), FOOT, FOOT, 4.0, KEYCAP_TOP, KEYCAP_TOP + TONGUE_T)
    tongue = soften(tongue, 1.2)
    # a web where the tongue leaves the hub (it carries the whole key force)
    web = bx(cx - TONGUE_W / 2, cx + TONGUE_W / 2, y - 16.0, y, KEYCAP_TOP, PIV_Z)
    web -= Pos(cx, y - 16.0, PIV_Z) * Rot(0, 90, 0) * Cylinder(10.0, TONGUE_W + 2)
    peg = cyl(cx, y - SPRING_ARM, KEYCAP_TOP - 2.5, KEYCAP_TOP + 0.5, SPRING_OD - 1.8)   # locates the spring
    r = r + shank + hub + tongue + web + peg
    r -= xbar(HUB_X[0] - 1, HUB_X[1] + 1, y, PIV_Z, PIN_D)
    return r


def balance(r) -> list[str]:
    """The rocker's own pull on the hook key, by material, and the handset's."""
    from build123d import CenterOf
    y = Y(PIV_KY)
    cg = r.center(CenterOf.MASS)
    arm_key = y - Y(P.HOOK[1])                      # pivot to SW15 along the tongue
    out = [f"rocker {r.volume / 1000:.1f} cm3, centre of mass {cg.Z - PIV_Z:.1f} mm out from the pin; "
           f"tongue {arm_key:.1f} mm; cradle centre {CRADLE_Z - PIV_Z:.1f} mm out"]
    hs = HANDSET_G * (CRADLE_Z - PIV_Z) / arm_key
    spring = SPRING_N * 102.0 * SPRING_ARM / arm_key          # gf at the key
    stop = math.degrees(math.atan2(STOP_GAP, HUB_D / 2 + 3.0))
    out.append(f"  spring {SPRING_N} N at {SPRING_ARM} mm = {spring:.0f} gf at the key; up-stop ~{stop:.1f} deg "
               f"(tongue {arm_key * math.sin(math.radians(stop)):.1f} mm over the key)")
    for name, rho in DENSITY.items():
        m = r.volume / 1000 * rho
        own = m * (cg.Z - PIV_Z) / arm_key
        on = own + hs - spring
        out.append(f"  {name:32s} {m:6.0f} g; empty hook: held up with {spring - own:4.0f} gf; "
                   f"handset on: {on:4.0f} gf on the key")
    out.append("  MX switch: 45-60 gf to switch (keep 'handset on' well above, 'held up' above 0)")
    return out


def build():
    """The faceplate."""
    cx, cy = BOARD_W / 2, BOARD_H / 2
    edge = SKIRT_GAP + SKIRT_WALL
    out_w, out_h = BOARD_W + 2 * edge, BOARD_H + 2 * edge
    out_r = BOARD_R + edge
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
    if os.environ.get("OLP_FACEPLATE") == "hook":
        rocker = build_rocker()
        print("\n".join(balance(rocker)))
        for name, part in {"faceplate-hook": build_hook_face(), "hook-rocker": rocker}.items():
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
