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

# ---------------------------------------------------------------- captive caps (vandal-proof keys)
# Every switch (12 keys + the hook) wears a captive cap: a wide flange under the face and a button
# that comes up through a smaller hole. Pull a button and the flange meets the face, so the switch
# never takes the pull; the switches sit hidden under the face. The caps go on the switches before
# the faceplate. The face sits just over the flanges, so the faceplate is a shallow cover.
MX_HOUSING_TOP = 11.6   # MEASURE: board top -> top of a switch's top housing
MX_STEM_TOP = 16.6      # MEASURE: board top -> top of a switch's stem (not pressed)
MX_TRAVEL = P.MX_TRAVEL  # 4.0 to the bottom
SOCKET_DEPTH, POST_D = 3.8, 5.5          # the cap's MX socket: cross 4.1 x 1.35 in a 5.5 post
CROSS_L, CROSS_W = 4.1, 1.35
FLANGE, FLANGE_T, FLANGE_R = 17.6, 1.6, 2.0
PRESS_CLEAR = 0.3       # flange over the housing with the key at the bottom
LIFT_CLEAR = 0.3        # flange under the face at rest
BUTTON, BUTTON_R = 13.0, 2.5
HOLE = BUTTON + 0.6     # the face's openings (0.3 a side)
PROUD = 3.6             # the button stands this far out of the face; the rocker's foot stops on the
                        # face after 3.6 mm, between the hook switch's 2 (switch) and 4 (bottom)
FLANGE_Z0 = MX_HOUSING_TOP + MX_TRAVEL + PRESS_CLEAR       # 15.9
FLANGE_Z1 = FLANGE_Z0 + FLANGE_T                           # 17.5
FACE_T = 2.5
FACE_Z = FLANGE_Z1 + LIFT_CLEAR + FACE_T                   # 20.3: the face top over the board
CAP_TOP = FACE_Z + PROUD                                   # 23.9: a button's top, not pressed
POST_Z0 = MX_STEM_TOP - SOCKET_DEPTH                       # 12.8
DISH = 0.7              # the keys' dished tops (cylindrical, like a keycap's)
ENGRAVE = 0.6           # legends cut into the dish
LEGENDS = {"1": "1", "2": "2", "3": "3", "4": "4", "5": "5", "6": "6", "7": "7", "8": "8", "9": "9",
           "0": "0", "MENU": "MENU", "BACK": "BACK", "HOOK": ""}

SKIRT_GAP, SKIRT_WALL = 0.3, 2.2   # round the board edge, down to the board's underside
EDGE_ROUND = 3.0        # the soft rounded top edge (enamel look)
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
# Piezo BZ1: 12.2 round, 6.5 tall, well under the face: sound out through slots.
BZ = P.BZ1_C
BZ_D, BZ_H = P.BZ1_D, P.BZ1_H
GRILLE_D = 21.0         # the grille's dish in the face
SLOT_W, SLOT_PITCH = 1.4, 3.0
LED_HOLE = 3.0          # status LED (D2 shines up through the board); a tube under the face holds
LIGHT_PIPE = 3.0        # a 3 mm clear acrylic rod as a light pipe up to the face
WIN_BEVEL = 1.2         # the window's bevel at the face


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
KEYCAP_TOP = CAP_TOP                          # the hook key's rounded crown, not pressed
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
# Return spring: the hook switch's own. A heavy linear MX switch (or a ~120 gf spring swapped into
# the hook switch) pushes its captive cap up, and the cap holds the tongue and the rocker up: with
# nothing on the hook the key is up, whatever the rocker is made of. The handset's weight beats it.
HOOK_SPRING_GF = (75.0, 120.0)   # the heavy spring: at the top of travel, at the bottom (4 mm)
STOP_GAP = 0.5             # the shank's clearance to its slot's end: a backstop if the rocker is lifted


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
    shell -= grille_slots(FACE_Z - FACE_T - 1, FACE_Z + 0.01)   # the grille stays open in the nook
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
    r = r + shank + hub + tongue + web
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
    p0, p4 = HOOK_SPRING_GF
    at2 = p0 + (p4 - p0) * 2.0 / MX_TRAVEL
    out.append(f"  hook switch spring {p0:.0f} gf at the top, {at2:.0f} at 2 mm (switches), {p4:.0f} at 4; "
               f"the face stops the foot at {PROUD} mm")
    for name, rho in DENSITY.items():
        m = r.volume / 1000 * rho
        own = m * (cg.Z - PIV_Z) / arm_key
        on = own + hs
        out.append(f"  {name:32s} {m:6.0f} g; empty hook: {own:4.0f} gf on the key (stays up below {p0:.0f}); "
                   f"handset on: {on:4.0f} gf (switches above {at2:.0f})")
    return out


def grille_slots(z0, z1):
    gx, gy = BZ[0], Y(BZ[1])
    cut = None
    n = int((GRILLE_D - 4) // SLOT_PITCH)
    for i in range(n):
        sy = gy + (i - (n - 1) / 2) * SLOT_PITCH
        half = math.sqrt(max(0.0, (GRILLE_D / 2 - 2.0) ** 2 - (sy - gy) ** 2))
        if half > 1.0:
            sl = rrect(gx, sy, 2 * half, SLOT_W, SLOT_W / 2 - 0.01, z0, z1)
            cut = sl if cut is None else cut + sl
    return cut


def build():
    """The faceplate: a shallow cover over the board, captive caps' buttons through the face."""
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
    # Display: a window in the face, and a chimney under it down to the glass (it holds the module
    # down and closes the gap round the window).
    (mx, my, mw, mh), (wx, wy, ww, wh) = display()
    module_top = P.STANDOFF_L + P.MODULE_PCB_T
    chim = rrect(wx, wy, ww + 2 * HOOD_LIP + 2 * HOOD_WALL, wh + 2 * HOOD_LIP + 2 * HOOD_WALL, HOOD_R,
                 DISP_TOP + 0.2, z_under + 0.01)
    for bx, by in P.MODULE_FAR_HOLES:                                      # screw heads
        chim -= cyl(bx, Y(by), module_top - 0.1, module_top + SCREW_HEAD_H + 0.4, SCREW_HEAD_D)
    shell += chim
    shell -= rrect(wx, wy, ww, wh, WIN_R, DISP_TOP, z_top + 1)
    shell -= rrect(wx, wy, ww + 2 * WIN_BEVEL, wh + 2 * WIN_BEVEL, WIN_R + WIN_BEVEL, z_top - WIN_BEVEL, z_top + 1)
    # Piezo grille: slots in the face over it, in a shallow round dish.
    gx, gy = BZ[0], Y(BZ[1])
    shell -= cyl(gx, gy, z_top - 0.6, z_top + 1, GRILLE_D)
    shell -= grille_slots(z_under - 1, z_top + 1)
    # Captive caps: the buttons' openings; under the face, room for the flanges to travel.
    for bx, by, _ in SWITCHES:
        shell -= rrect(bx, Y(by), HOLE, HOLE, BUTTON_R + 0.3, z_under - 1, z_top + 1)
    # Status LED: a hole in the face and a tube down to the LED for a light pipe.
    lx, ly = P.LED[0], Y(P.LED[1])
    shell += cyl(lx, ly, 1.5, z_under + 0.01, LIGHT_PIPE + 2.4)
    shell -= cyl(lx, ly, 1.0, z_top + 1, LIGHT_PIPE + 0.2)
    # M3 insert bosses down to the board at H1-H4 (screws come up through the board).
    for bx, by in HOLES:
        shell += cyl(bx, Y(by), 0.0, z_under + 0.01, BOSS_D)
        shell -= cyl(bx, Y(by), -0.01, INSERT_L, INSERT_D)
    for bx, by, _ in SWITCHES:      # nothing under the face may meet a flange on its way down
        shell -= rrect(bx, Y(by), FLANGE + 0.8, FLANGE + 0.8, FLANGE_R + 0.4, MX_HOUSING_TOP, z_under)
    return shell


def build_cap(label: str):
    """A captive cap: MX socket post, a flange under the face, a button through it, dished top."""
    from build123d import Text
    # the button: the keys get a cylindrical dish; the hook key a rounded top the rocker's foot
    # rolls on (a sphere here tessellates badly, a cylinder doesn't)
    btn = rrect(0, 0, BUTTON, BUTTON, BUTTON_R, FLANGE_Z1 - 0.01, CAP_TOP)
    if label == "HOOK":
        R = 14.0
        btn &= Pos(0, 0, CAP_TOP - R) * Rot(90, 0, 0) * Cylinder(R, BUTTON + 2)
    else:
        R = 30.0
        btn -= Pos(0, 0, CAP_TOP + R - DISH) * Rot(90, 0, 0) * Cylinder(R, BUTTON + 2)
    cap = round_top(rrect(0, 0, FLANGE, FLANGE, FLANGE_R, FLANGE_Z0, FLANGE_Z1), FLANGE_Z1, 0.6)
    cap = cap + btn + cyl(0, 0, POST_Z0, FLANGE_Z0 + 0.01, POST_D)
    # MX socket (a cross) up into the post, with a little relief past the stem's top
    for w, l in ((CROSS_W, CROSS_L), (CROSS_L, CROSS_W)):
        cap -= bx(-w / 2, w / 2, -l / 2, l / 2, POST_Z0 - 1, POST_Z0 + SOCKET_DEPTH + 0.4)
    text = LEGENDS.get(label, label)
    if text:
        size = 7.0 if len(text) == 1 else 2.9
        t = extrude(Text(text, font_size=size, font_style=__import__("build123d").FontStyle.BOLD), amount=3.0)
        cap -= Pos(0, 0, CAP_TOP - DISH - ENGRAVE) * t
    return cap


def report(shell) -> list[str]:
    bb = shell.bounding_box()
    (mx, my, mw, mh), (wx, wy, ww, wh) = display()
    lines = [
        "Faceplate (all mm; board top-left corner = origin, x right, y down as in KiCad; z = board top)",
        f"Outside: {bb.size.X:.1f} x {bb.size.Y:.1f}, corners R{BOARD_R + SKIRT_GAP + SKIRT_WALL:.1f}; "
        f"skirt {SKIRT_WALL} thick, {SKIRT_GAP} clear of the board edge, down to the board's underside",
        f"Face top {FACE_Z:.1f} above the board top, face {FACE_T} thick; captive caps: flange {FLANGE} "
        f"({FLANGE_Z0:.1f}-{FLANGE_Z1:.1f}), button {BUTTON} through {HOLE:.1f} holes, {PROUD} proud (top {CAP_TOP:.1f})",
        f"Highest point: display hood {bb.max.Z:.1f} above the board top",
        f"Button openings: {HOLE:.1f} x {HOLE:.1f} (R{BUTTON_R + 0.3}), 13, centred on the switches:",
    ]
    for bx, by, lab in SWITCHES:
        lines.append(f"  {lab:5s} centre ({bx:7.2f}, {by:6.2f})")
    lines += [
        f"Pitch {P.PITCH} across; rows at y = {P.YR} and {P.YF}; hook switch at {P.HOOK}",
        f"Display hood over the module {mw} x {mh} (centre {mx:.2f}, {BOARD_H - my:.2f}): "
        f"cavity {mw + 0.6:.1f} x {mh + 0.6:.1f} up to {DISP_TOP + 0.2:.1f}; window {ww} x {wh} "
        f"centred ({wx:.2f}, {BOARD_H - wy:.2f}); screw-head pockets D{SCREW_HEAD_D} at "
        + ", ".join(f"({x:.1f}, {y:.1f})" for x, y in P.MODULE_FAR_HOLES),
        f"Piezo grille: slots in a D{GRILLE_D} dish in the face at ({BZ[0]}, {BZ[1]})",
        f"LED: D{LIGHT_PIPE} light pipe (clear acrylic rod) in a tube at ({P.LED[0]}, {P.LED[1]})",
        "Insert bosses D{} at H1-H4: {}; hole D{} x {} deep (M3 x 3 heat-set insert); "
        "screws M3 x 5 from under the board".format(
            BOSS_D, ", ".join(f"({x}, {y})" for x, y in HOLES), INSERT_D, INSERT_L),
    ]
    return lines


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    if os.environ.get("OLP_FACEPLATE") == "caps":
        (OUT / "caps").mkdir(exist_ok=True)
        for _, _, lab in SWITCHES:
            cap = build_cap(lab)
            name = f"cap-{lab.lower()}"
            export_step(cap, str(OUT / "caps" / f"{name}.step"))
            export_stl(cap, str(OUT / "caps" / f"{name}.stl"), tolerance=0.01, angular_tolerance=0.1)
            print(name, f"{cap.volume / 1000:.2f} cm3")
        return
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
