"""Open Lounge Phone prototype box: a plain, functional enclosure for the minimal board (M2).

    .venv/bin/python proto_box.py [--parts build/proto/board_parts.json] [--render]

Standalone. Printed parts: TRAY and LID (the lid IS the MX switch plate) plus a display BEZEL.
Outputs STL + STEP to build/proto/, numeric fit checks to build/proto/checks.txt (exit 1 on
FAIL), optional render proto.png. See PROTO_BOX.md for print and assembly notes.

Frames: base x left -> right, y front -> rear, z up from the table (mm). The board frame is
KiCad's (x right, y DOWN from the rear-left corner): base_x = GAP + WALL + bx,
base_y = GAP + WALL + (BOARD_H - by).

Board geometry below mirrors hardware/layout/place.py; the checks compare it with the placed
board (`make parts` -> build/proto/board_parts.json, from layout/dump_parts.py in KiCad's
Python). Designed to nominal dimensions for industrial printing (MJF/SLS/SLA class): 0.1 mm
clearance per side where parts mate.
"""

from __future__ import annotations

import argparse
import json
import math
import sys
from pathlib import Path

from build123d import (
    Align, Axis, Box, Circle, Cylinder, Part, Plane, Pos, RectangleRounded, Text, export_step,
    export_stl, extrude, fillet,
)

HERE = Path(__file__).resolve().parent
OUT = HERE / "build" / "proto"

# ---------------------------------------------------------------- board (= layout/place.py)
BOARD_W, BOARD_H, BOARD_R, BOARD_T = 156.0, 88.0, 3.0, 1.6
PITCH, X0, YR, YF = 19.05, 46.0, 13.5, 74.5
COLS = [X0 + i * PITCH for i in range(6)]
HOOK = (16.0, YF)                                  # SW15, the 13th MX switch
HOLES = [(152.5, 3.5), (152.5, 84.5), (3.5, 84.5), (31.0, 31.0)]    # H1-H4, M3
DISP_W, DISP_H = 91.8, 37.5                        # WeAct 2.9" e-paper module
DISP_X0, DISP_Y0 = COLS[2] - DISP_W / 2, (YR + YF) / 2 - DISP_H / 2
STANDOFFS = [(DISP_X0 + DISP_W - 2.8, DISP_Y0 + 2.8), (DISP_X0 + DISP_W - 2.8, DISP_Y0 + DISP_H - 2.8)]
J3_PIN1 = (DISP_X0 + 1.93, DISP_Y0 + DISP_H / 2 + 1.5 * 2.54)
J3_CENTRE = (J3_PIN1[0] + 1.27, J3_PIN1[1] - 3.81)
J3_BODY = (5.1, 10.2, 8.5)                         # 2x4 female socket w x h x height
BZ1_C, BZ1_D, BZ1_H = (15.8, 15.0), 12.2, 6.5      # piezo body centre (between its pins)
LED = (2.755, 59.325)                              # D2 reverse-mount LED, shines up through a hole
USB_X, JACK_X = 19.5, 6.5                          # J1 / J2 centres on the rear edge (bottom side)
BUTTONS = [(3.345, 23.045, "RESET SW1"), (35.0, 52.8, "BOOT SW2")]   # bottom side: floor pinholes

# ---------------------------------------------------------------- box parameters (mm)
GAP, WALL, FLOOR = 1.0, 2.5, 2.0
LEDGE = 1.0                    # tray wall steps in at the lid underside: the lid drops in and sits on it
OUT_W, OUT_H = BOARD_W + 2 * (GAP + WALL), BOARD_H + 2 * (GAP + WALL)    # 163 x 95
OUT_R, EDGE_FILLET = 6.0, 1.0
FIT = 0.1                      # clearance per side where printed parts mate (industrial print)

BOSS_H = 6.0                   # floor top -> board bottom: the jack (4.0) is the tallest part below
Z_FLOOR = FLOOR
Z_BB = Z_FLOOR + BOSS_H        # board bottom 8.0
Z_BT = Z_BB + BOARD_T          # board top 9.6
PLATE_ABOVE_PCB = 5.0          # MX: plate top = PCB top + 5.0
LID_T = 2.0
Z_LT = Z_BT + PLATE_ABOVE_PCB  # lid (plate) top 14.6
Z_LU = Z_LT - LID_T            # lid underside = the tray's ledge 12.6 (flat: the lid prints on it)
TOP_CLEAR = Z_LU - Z_BT        # 3.0 above the board top under the flat lid
BOT_CLEAR = Z_BB - Z_FLOOR     # 6.0 below the board bottom

KEY_CUT = 14.0                 # MX nominal; for hobby FDM use ~14.1
KEY_POCKET, KEY_POCKET_D = 15.2, 0.5
KEYCAP, KEYCAP_H = 18.2, 9.0   # clear XDA-profile 1u cap, nominal (measure yours)

# display: J3 (8.5) + the module's male pins (2.5 plastic) = 11.0 = M3 standoff length
STANDOFF_L, STANDOFF_HEX = 11.0, 5.5
Z_DISP = Z_BT + STANDOFF_L                         # module PCB underside 20.6
DISP_T = 1.2 + 1.2                                 # module PCB + panel glass (EST)
BEZEL_WALL, BEZEL_TOP = 1.2, 1.2
VIEW = (68.0, 30.0)            # window over the 66.9 x 29.1 active area (centred, EST)
J3_CUT = (J3_BODY[0] + 1.0, J3_BODY[1] + 1.0)
STANDOFF_HOLE = 7.0            # lid clearance round the hex standoffs

# hook: the MX switch clips into the lid like a key; a square collar shrouds its keycap, which
# the handset cradle's foot rests on
HOOK_COLLAR_IN, HOOK_COLLAR_WALL, HOOK_COLLAR_H = 18.6, 1.6, 6.0
MX_PRETRAVEL, MX_TRAVEL = 2.0, 4.0

# handset cradle: one printed arm hinged on two ears at the lid's rear-left (an M3 screw is the
# pin); its front foot rests on a 1u keycap on the hook switch, and the switch's own spring lifts
# it when the handset comes off. The handset lies front to back in two V rests on the arm, which
# fit most banana-style handsets. Handset sizes: Opis 60s Micro (21 x 7 x 6 cm listed); handle
# width and how far the cups hang below the handle are estimates: measure yours.
HANDSET_L, CUP_D, HANDLE_W, CUP_DROP, HANDSET_H = 210.0, 70.0, 40.0, 35.0, 60.0
CAP_TOP = 17.0                 # plate top -> top of a 1u XDA cap on an MX switch [est]
ARM_W, ARM_H, FOOT_D = 12.0, 8.0, 8.0
HINGE_Y = 60.0                 # world y of the pin (rear-left, in front of the piezo dome)
EAR_T, EAR_GAP, PIN_HOLE, ARM_HOLE = 3.5, 0.3, 3.2, 3.4
REST_Y = (20.0, 52.0)          # world y of the two V rests
V_OPEN, V_WALL, V_T = 52.0, 4.0, 8.0     # V opening (fits handles up to ~50 mm), 90 degrees
CUP_CLEAR = 3.0
MX_ACTUATE_GF = 45.0           # typical linear MX switch at 2 mm; a lighter switch is fine
PA12_DENSITY = 1.01            # g/cm3, industrial nylon print

# piezo: the 6.5 mm body pokes 1.5 mm through the 5 mm plate: a dome on the lid covers it and
# carries the sound holes
PIEZO_BORE, PIEZO_ROOF = BZ1_D + 2 * 0.3, 1.2
Z_PIEZO_TOP = Z_BT + BZ1_H
SOUND_D, SOUND_N = 1.5, 7      # one centre hole + a ring of six
LED_HOLE = 3.0

# fastening: 4 screws clamp lid + spacer + board + tray (M3 x 12 countersunk into heat-set inserts)
SPACER_L, SPACER_OD = TOP_CLEAR, 6.0   # off-the-shelf M3 nylon spacer between lid and board
BOLTS = HOLES
BOSS_D = 7.0
SCREW_CLEAR, CSK_D = 3.3, 6.0
INSERT_D, INSERT_DEPTH = 4.0, 5.0  # M3 x 4 heat-set insert (OD 4.2)

# rear wall: USB-C and the 3.5 mm jack hang under the board at the rear edge
USB_BODY_H = 3.26
USB_CUT, USB_CUT_R = (12.8, 7.2), 3.4
Z_USB = Z_BB - USB_BODY_H / 2
JACK_AXIS_BELOW, JACK_BODY_H, JACK_HOLE_D = 2.0, 4.0, 8.0
Z_JACK = Z_BB - JACK_AXIS_BELOW
PINHOLE_D = 2.0

FEET = [(12.0, 10.0), (OUT_W - 12.0, 10.0), (12.0, OUT_H - 10.0), (OUT_W - 12.0, OUT_H - 10.0)]
FOOT_D, FOOT_DEPTH = 13.0, 1.0
TEXT, TEXT_SIZE, TEXT_DEPTH = "Open Lounge Phone · proto", 6.0, 0.6
BED = 220.0

# heights above the board surface by footprint name (mm); first match wins. Sources: datasheets
# where known; [est] = estimate, verify against the part before trusting a tight fit.
HEIGHTS = [
    ("USB_C_Receptacle", 3.26), ("ESP32-S3-WROOM-1", 3.3), ("PinSocket_2x04", 8.5),
    ("Buzzer_TDK_PS1240", 6.5), ("TS-1187A", 1.5), ("Jack_3.5mm", 4.0), ("ReverseMount", 0.3),
    ("Kailh", 1.85), ("CPG151101S11", 1.85), ("SOT-223", 1.8), ("SOT-23", 1.2), ("QFN", 1.0),
    ("MountingHole", 0.1), ("logo", 0.05), ("name", 0.05),
    ("_1206_", 1.2), ("_0805_", 1.3), ("_0603_", 0.9), ("_0402_", 0.6),
]


def bx2x(bx):
    return GAP + WALL + bx


def by2y(by):
    return GAP + WALL + (BOARD_H - by)


def cradle_geom():
    """World positions for the cradle (y grows toward the rear, z up from the table)."""
    lx, fy = bx2x(HOOK[0]), by2y(HOOK[1])
    z_cap = Z_LT + CAP_TOP
    zb0 = z_cap + FOOT_D / 2 - 1.0            # arm bottom; the foot hangs below it to the cap
    hz = zb0 + ARM_H / 2
    rear_row_cap = Z_LT + CAP_TOP
    handle_bottom = math.ceil(max(rear_row_cap, Z_PIEZO_TOP + 0.5 + PIEZO_ROOF) + CUP_DROP + CUP_CLEAR)
    apex = handle_bottom - (HANDLE_W / 2) * (math.sqrt(2) - 1)   # a round handle in a 90 deg V
    yc = sum(REST_Y) / 2
    return dict(lx=lx, fy=fy, z_cap=z_cap, zb0=zb0, hz=hz, apex=apex, hb=handle_bottom, yc=yc)


def xcyl(x0, x1, y, z, d) -> Part:
    from build123d import Rot
    return Pos(x0, y, z) * Rot(0, 90, 0) * Cylinder(d / 2, x1 - x0,
                                                     align=(Align.CENTER, Align.CENTER, Align.MIN))


def hinge_ears() -> list[Part]:
    g = cradle_geom()
    lx, hz = g["lx"], g["hz"]
    out = []
    for sx in (-1, 1):
        x_in = lx + sx * (ARM_W / 2 + EAR_GAP)
        x0, x1 = sorted((x_in, x_in + sx * EAR_T))
        out.append(box(x0, x1, HINGE_Y - 6, HINGE_Y + 6, Z_LT - 0.01, hz + 6)
                   - xcyl(x0 - 1, x1 + 1, HINGE_Y, hz, PIN_HOLE))
    return out


def cradle() -> Part:
    """The arm: hinge at the rear, foot on the hook keycap, two V rests for the handset."""
    g = cradle_geom()
    lx, fy, zb0, hz, apex = g["lx"], g["fy"], g["zb0"], g["hz"], g["apex"]
    x0, x1 = lx - ARM_W / 2, lx + ARM_W / 2
    from build123d import Rot
    arm = box(x0, x1, fy - FOOT_D / 2, HINGE_Y + 6, zb0, zb0 + ARM_H)
    arm = arm + xcyl(x0, x1, fy, g["z_cap"] + FOOT_D / 2, FOOT_D)     # round foot on the cap
    arm = arm + xcyl(x0, x1, HINGE_Y, hz, 12.0)
    for y in REST_Y:
        w = V_OPEN + 2 * V_WALL
        depth = V_OPEN / 2
        arm = arm + box(x0, x1, y - V_T / 2, y + V_T / 2, zb0 + ARM_H - 0.01, apex - V_WALL + 0.01)
        block = box(lx - w / 2, lx + w / 2, y - V_T / 2, y + V_T / 2, apex - V_WALL, apex + depth)
        side = 2 * depth          # diamond with its bottom corner on the V apex
        v = Pos(lx, y, apex + side / math.sqrt(2)) * Rot(0, 45, 0) * Box(side, V_T + 2, side)
        arm = arm + (block - v)
    return arm - xcyl(x0 - 1, x1 + 1, HINGE_Y, hz, ARM_HOLE)


def handset_ghost() -> Part:
    """Rough handset envelope for the render and the clearance checks (not printed)."""
    g = cradle_geom()
    lx, yc, hb = g["lx"], g["yc"], g["hb"]
    pitch = HANDSET_L / 2 - CUP_D / 2
    handle = box(lx - HANDLE_W / 2, lx + HANDLE_W / 2, yc - pitch, yc + pitch, hb, hb + HANDSET_H - CUP_DROP)
    cups = [cyl(lx, yc + s * pitch, hb - CUP_DROP, hb + HANDSET_H - CUP_DROP, CUP_D) for s in (-1, 1)]
    return union([handle] + cups)


def keys():
    """(bx, by, label) of the 12 key centres + the hook switch."""
    labels = [["1", "2", "3", "4", "5", "MENU"], ["6", "7", "8", "9", "0", "BACK"]]
    return [(COLS[i], y, labels[r][i]) for r, y in enumerate((YR, YF)) for i in range(6)] + \
        [(HOOK[0], HOOK[1], "HOOK")]


def height_of(fp: str) -> float:
    for key, h in HEIGHTS:
        if key.lower() in fp.lower():
            return h
    return 1.2


# ---------------------------------------------------------------- primitives
def box(x0, x1, y0, y1, z0, z1) -> Part:
    return Pos(min(x0, x1), min(y0, y1), min(z0, z1)) * Box(
        abs(x1 - x0), abs(y1 - y0), abs(z1 - z0), align=(Align.MIN, Align.MIN, Align.MIN))


def cyl(x, y, z0, z1, d) -> Part:
    return Pos(x, y, min(z0, z1)) * Cylinder(d / 2, abs(z1 - z0),
                                              align=(Align.CENTER, Align.CENTER, Align.MIN))


def rrect(cx, cy, w, h, r, z0, z1) -> Part:
    r = max(0.01, min(r, w / 2 - 0.01, h / 2 - 0.01))
    return extrude(Pos(cx, cy, z0) * RectangleRounded(w, h, r), amount=z1 - z0)


def stadium_y(cx, cz, w, h, r, y0, y1) -> Part:
    """Rounded rectangle in the XZ plane, extruded along y from y0 to y1 (wall cut-outs)."""
    r = max(0.01, min(r, w / 2 - 0.01, h / 2 - 0.01))
    face = Plane.XZ.offset(-y0) * Pos(cx, cz) * RectangleRounded(w, h, r)
    return extrude(face, amount=-(y1 - y0))


def union(parts):
    out = parts[0]
    for p in parts[1:]:
        out = out + p
    return out


def load_parts(path: Path) -> list[dict]:
    if not path.exists():
        return []
    parts = json.loads(path.read_text())["parts"]
    for p in parts:
        p["h"] = height_of(p["fp"])
    return parts


def sound_holes():
    pts = [(0.0, 0.0)] + [(3.2 * math.cos(math.radians(60 * k)), 3.2 * math.sin(math.radians(60 * k)))
                          for k in range(SOUND_N - 1)]
    return [(bx2x(BZ1_C[0]) + dx, by2y(BZ1_C[1]) + dy) for dx, dy in pts]


# ---------------------------------------------------------------- parts
def rear_cutters():
    x = bx2x(USB_X)
    cut = [stadium_y(x, Z_USB, *USB_CUT, USB_CUT_R, OUT_H - WALL - 0.5, OUT_H + 1)]
    face = Plane.XZ.offset(-(OUT_H - WALL - 0.5)) * Pos(bx2x(JACK_X), Z_JACK) * Circle(JACK_HOLE_D / 2)
    cut.append(extrude(face, amount=-(WALL + 1.5)))
    return cut


def tray() -> Part:
    shell = rrect(OUT_W / 2, OUT_H / 2, OUT_W, OUT_H, OUT_R, 0, Z_LT)
    shell = fillet(shell.edges().group_by(Axis.Z)[0] + shell.edges().group_by(Axis.Z)[-1], EDGE_FILLET)
    t = shell - rrect(OUT_W / 2, OUT_H / 2, OUT_W - 2 * WALL, OUT_H - 2 * WALL,
                      OUT_R - WALL, Z_FLOOR, Z_LU + 0.01)
    up = WALL - LEDGE              # the wall above the ledge, round the dropped-in lid
    t = t - rrect(OUT_W / 2, OUT_H / 2, OUT_W - 2 * up, OUT_H - 2 * up, OUT_R - up, Z_LU, Z_LT + 1)
    t = t + union([cyl(bx2x(bx), by2y(by), Z_FLOOR - 0.01, Z_BB, BOSS_D) for bx, by in BOLTS])
    cut = []
    for bx, by in BOLTS:
        x, y = bx2x(bx), by2y(by)
        cut.append(cyl(x, y, -1, Z_BB + 1, SCREW_CLEAR))
        cut.append(cyl(x, y, Z_BB - INSERT_DEPTH, Z_BB + 1, INSERT_D))
    for bx, by, _ in BUTTONS:    # poke a paper clip through the floor to press RESET / BOOT
        cut.append(cyl(bx2x(bx), by2y(by), -1, Z_FLOOR + 1, PINHOLE_D))
    for x, y in FEET:
        cut.append(cyl(x, y, -1, FOOT_DEPTH, FOOT_D))
    cut += rear_cutters()
    from build123d import Rot
    txt = Text(TEXT, font_size=TEXT_SIZE, align=(Align.CENTER, Align.CENTER))
    cut.append(Pos(OUT_W / 2 + 20, OUT_H / 2, 0) * Rot(0, 180, 0) * extrude(txt, amount=-TEXT_DEPTH))
    return t - union(cut)


def lid() -> Part:
    up = WALL - LEDGE
    plate = rrect(OUT_W / 2, OUT_H / 2, OUT_W - 2 * (up + FIT), OUT_H - 2 * (up + FIT),
                  OUT_R - up - FIT, Z_LU, Z_LT)
    add = []
    hx, hy = bx2x(HOOK[0]), by2y(HOOK[1])
    o = HOOK_COLLAR_IN + 2 * HOOK_COLLAR_WALL
    add.append(box(hx - o / 2, hx + o / 2, hy - o / 2, hy + o / 2, Z_LT - 0.01, Z_LT + HOOK_COLLAR_H)
               - box(hx - HOOK_COLLAR_IN / 2, hx + HOOK_COLLAR_IN / 2, hy - HOOK_COLLAR_IN / 2,
                     hy + HOOK_COLLAR_IN / 2, Z_LT - 1, Z_LT + HOOK_COLLAR_H + 1))
    px, py = bx2x(BZ1_C[0]), by2y(BZ1_C[1])
    add.append(cyl(px, py, Z_LT - 0.01, Z_PIEZO_TOP + 0.5 + PIEZO_ROOF, PIEZO_BORE + 2 * 1.6))
    add += hinge_ears()
    body = plate + union(add)
    cut = []
    for bx, by, _ in keys():
        x, y = bx2x(bx), by2y(by)
        cut.append(box(x - KEY_CUT / 2, x + KEY_CUT / 2, y - KEY_CUT / 2, y + KEY_CUT / 2,
                       Z_LU - 3, Z_LT + 1))
        cut.append(box(x - KEY_POCKET / 2, x + KEY_POCKET / 2, y - KEY_POCKET / 2,
                       y + KEY_POCKET / 2, Z_LU - 3, Z_LU + KEY_POCKET_D))
    jx, jy = bx2x(J3_CENTRE[0]), by2y(J3_CENTRE[1])
    cut.append(box(jx - J3_CUT[0] / 2, jx + J3_CUT[0] / 2, jy - J3_CUT[1] / 2, jy + J3_CUT[1] / 2,
                   Z_LU - 3, Z_LT + 1))
    for bx, by in STANDOFFS:
        cut.append(cyl(bx2x(bx), by2y(by), Z_LU - 3, Z_LT + 1, STANDOFF_HOLE))
    cut.append(cyl(px, py, Z_LU - 3, Z_PIEZO_TOP + 0.5, PIEZO_BORE))
    for x, y in sound_holes():
        cut.append(cyl(x, y, Z_PIEZO_TOP, Z_PIEZO_TOP + 5, SOUND_D))
    cut.append(cyl(bx2x(LED[0]), by2y(LED[1]), Z_LU - 3, Z_LT + 1, LED_HOLE))
    for bx, by in BOLTS:
        x, y = bx2x(bx), by2y(by)
        cut.append(cyl(x, y, Z_BT - 1, Z_LT + 1, SCREW_CLEAR))
        h = (CSK_D - SCREW_CLEAR) / 2
        from build123d import Cone
        cut.append(Pos(x, y, Z_LT - h) * Cone(SCREW_CLEAR / 2, CSK_D / 2 + 0.3, h + 0.3,
                                              align=(Align.CENTER, Align.CENTER, Align.MIN)))
    return body - union(cut)


def bezel() -> Part:
    """Frame over the display module: sits on the lid top, walls round the module, a lip over
    its border with the viewing window. z = 0 at the lid top."""
    iw, ih = DISP_W + 2 * FIT, DISP_H + 2 * FIT
    ow, oh = iw + 2 * BEZEL_WALL, ih + 2 * BEZEL_WALL
    top = Z_DISP + DISP_T - Z_LT
    b = box(-ow / 2, ow / 2, -oh / 2, oh / 2, 0, top + BEZEL_TOP)
    b = b - box(-iw / 2, iw / 2, -ih / 2, ih / 2, -1, top)
    return b - box(-VIEW[0] / 2, VIEW[0] / 2, -VIEW[1] / 2, VIEW[1] / 2, top - 1, top + BEZEL_TOP + 1)


# ---------------------------------------------------------------- checks
def circle_rect_dist(cx, cy, r, rect):
    x0, y0, x1, y1 = rect
    dx = max(x0 - cx, 0, cx - x1)
    dy = max(y0 - cy, 0, cy - y1)
    return math.hypot(dx, dy) - r


def run_checks(parts, shapes) -> list[tuple[str, str, str]]:
    R = []

    def add(ok, name, msg):
        R.append(("PASS" if ok is True else ("WARN" if ok == "warn" else "FAIL"), name, msg))

    for name, s in shapes.items():
        bb = s.bounding_box()
        dims = sorted([bb.size.X, bb.size.Y])
        add(dims[0] <= BED and dims[1] <= BED, f"bed fit {name}",
            f"{bb.size.X:.1f} x {bb.size.Y:.1f} x {bb.size.Z:.1f} mm (bed {BED:.0f})")
    add(WALL >= 2 and FLOOR >= 2 and LID_T >= 2, "walls",
        f"wall {WALL}, floor {FLOOR}, lid {LID_T}; key clip ledge {LID_T - KEY_POCKET_D}")
    lb = shapes["lid"].bounding_box()
    add(abs(lb.min.Z - Z_LU) < 1e-6, "lid prints flat",
        f"nothing below the lid underside (z {lb.min.Z:.2f}); the tray's {LEDGE} mm ledge and "
        f"{WALL - LEDGE} mm wall above it locate the lid")
    add(SPACER_OD <= BOSS_D and abs(SPACER_L - (Z_LU - Z_BT)) < 1e-6, "spacers",
        f"M3 nylon spacer {SPACER_L:.1f} mm long, OD {SPACER_OD} (lid underside -> board top)")
    add(abs(Z_LT - (Z_BT + 5.0)) < 1e-6, "MX stack",
        f"board top z {Z_BT:.1f}, plate top z {Z_LT:.1f} (+{Z_LT - Z_BT:.1f}), "
        f"space under the lid {TOP_CLEAR:.1f}, under the board {BOT_CLEAR:.1f}")
    add(MX_PRETRAVEL >= 2.0 and MX_TRAVEL <= 4.0, "hook travel",
        f"hook = MX switch: actuates at {MX_PRETRAVEL} mm, hard stop at {MX_TRAVEL} mm "
        f"(DESIGN §5: >= 2 mm, stop within 4 mm); collar {HOOK_COLLAR_IN} mm square, "
        f"{HOOK_COLLAR_H} mm tall guides the rest's plunger")
    jack_ok = (Z_JACK - JACK_HOLE_D / 2 >= 0.0 and JACK_BODY_H <= BOT_CLEAR - 1.0
               and Z_USB - USB_CUT[1] / 2 >= 0.0)
    add(jack_ok, "rear openings", f"USB-C {USB_CUT[0]} x {USB_CUT[1]} at z {Z_USB:.1f}, jack "
        f"Ø{JACK_HOLE_D} at z {Z_JACK:.1f} (floor top {Z_FLOOR}); both hang under the board")
    top = Z_DISP + DISP_T
    gap = (2 * YF - 2 * YR) / 2 - KEYCAP - (DISP_H + 2 * FIT + 2 * BEZEL_WALL)
    add(gap / 2 >= 0.8, "bezel vs keycaps",
        f"rows {YF - YR:.0f} mm apart: {gap / 2:.2f} mm between the bezel and each keycap row")
    add(abs(STANDOFF_L - (J3_BODY[2] + 2.5)) < 1e-6, "display stack",
        f"socket {J3_BODY[2]} + header plastic 2.5 = standoff {STANDOFF_L} mm; module top z "
        f"{top:.1f}, {top - Z_LT:.1f} above the plate")
    if not parts:
        add("warn", "board data", "no board_parts.json: fit checks against parts skipped")
        return R
    by_ref = {p["ref"]: p for p in parts}
    add(abs(by_ref.get("J1", {}).get("crt", [0, 1, 0, 0])[1]) < 1.0 and by_ref["J1"]["side"] == "bottom"
        and abs(by_ref["J1"]["at"][0] - USB_X) < 0.3, "USB-C J1",
        f"J1 at {by_ref['J1']['at']} {by_ref['J1']['side']}, rear edge, cut-out x {USB_X}")
    j2 = by_ref["J2"]
    add(j2["crt"][1] < 1.0 and j2["side"] == "bottom" and abs(j2["at"][0] - JACK_X) < 0.3,
        "jack J2", f"J2 at {j2['at']} {j2['side']}, rear edge, opening x {JACK_X}")
    # bottom parts vs the space under the board, top parts vs the lid
    for p in parts:
        if p["side"] == "bottom" and p["h"] > BOT_CLEAR - 1.0:
            add(False, f"under-board height {p['ref']}", f"{p['fp']} h {p['h']} > {BOT_CLEAR - 1}")
    through = {"J3": "socket passes the lid cut-out", "BZ1": "piezo dome"}
    for p in parts:
        if p["side"] == "top" and p["h"] + 0.2 > TOP_CLEAR and "Kailh" not in p["fp"]:
            add(p["ref"] in through, f"top part {p['ref']}",
                f"h {p['h']} > {TOP_CLEAR:.1f} under the lid: {through.get(p['ref'], 'NO opening')}")
    # module mounting: J3 and the standoff holes where the WeAct drawing puts them
    j3 = by_ref["J3"]
    pin1 = next(q["at"] for q in j3["pads"] if q["n"] == "1") if j3.get("pads") else j3["at"]
    ok = math.dist(pin1, J3_PIN1) < 0.05 and all(
        math.dist(by_ref[h]["at"], s) < 0.05 for h, s in zip(("H5", "H6"), STANDOFFS))
    add(ok, "display mount", f"J3 pin 1 {pin1} (drawing {J3_PIN1[0]:.2f}, {J3_PIN1[1]:.2f}); "
        f"standoffs H5/H6 at {STANDOFFS[0]}, {STANDOFFS[1]} = module holes 86.2 x 31.9")
    # bosses vs parts (tray boss below, nylon spacer above)
    bad = []
    for bx, by in BOLTS:
        for p in parts:
            if p["ref"].startswith("H") or p["fp"].startswith("Mounting"):
                continue
            if circle_rect_dist(bx, by, BOSS_D / 2, p["crt"]) < 0:
                bad.append(f"({bx},{by}) {p['ref']}")
    add(not bad, "bosses / spacers", f"Ø{BOSS_D} at the 4 holes clear of every courtyard"
        + (": " + ", ".join(bad) if bad else ""))
    # openings over their parts
    bz = by_ref["BZ1"]
    add(math.dist(((bz["crt"][0] + bz["crt"][2]) / 2, (bz["crt"][1] + bz["crt"][3]) / 2), BZ1_C) < 0.5,
        "piezo dome", f"Ø{PIEZO_BORE:.1f} bore + {SOUND_N} Ø{SOUND_D} sound holes over BZ1 "
        f"(body top z {Z_PIEZO_TOP:.1f})")
    d2 = by_ref["D2"]
    add(math.dist(d2["at"], LED) < 0.3, "LED hole", f"Ø{LED_HOLE} over D2's board light hole {d2['at']}")
    for bx, by, label in BUTTONS:
        ref = label.split()[1]
        add(math.dist(by_ref[ref]["at"], (bx, by)) < 0.3 and by_ref[ref]["side"] == "bottom",
            f"pinhole {label}", f"Ø{PINHOLE_D} floor hole under {ref} {by_ref[ref]['at']}")
    sw = [p for p in parts if "Kailh" in p["fp"] or "CPG151101S11" in p["fp"]]
    want = sorted((round(x, 2), round(y, 2)) for x, y, _ in keys())
    got = sorted((round(p["at"][0], 2), round(p["at"][1], 2)) for p in sw)
    add(len(sw) == 13 and all(math.dist(a, b) < 0.3 for a, b in zip(want, got)), "key grid",
        f"{len(sw)} switch sockets (12 keys + hook) vs lid cut-outs")
    R += cradle_checks(shapes)
    return R


def cradle_checks(shapes) -> list[tuple[str, str, str]]:
    R = []

    def add(ok, name, msg):
        R.append(("PASS" if ok else "FAIL", name, msg))

    g = cradle_geom()
    lx, fy, yc, hb = g["lx"], g["fy"], g["yc"], g["hb"]
    pitch = HANDSET_L / 2 - CUP_D / 2
    caps = [(bx2x(bx), by2y(by)) for bx, by, _ in keys()]
    half = KEYCAP / 2

    def highest_under(cx, cy, r):
        top, what = Z_LT, "lid"
        for x, y in caps:
            if circle_rect_dist(x, y, r, (cx - half, cy - half, cx + half, cy + half)) < 0 \
                    or circle_rect_dist(cx, cy, r, (x - half, y - half, x + half, y + half)) < 0:
                if Z_LT + CAP_TOP > top:
                    top, what = Z_LT + CAP_TOP, "a keycap"
        if math.dist((cx, cy), (bx2x(BZ1_C[0]), by2y(BZ1_C[1]))) < r + PIEZO_BORE / 2 + 1.6:
            dome = Z_PIEZO_TOP + 0.5 + PIEZO_ROOF
            if dome > top:
                top, what = dome, "the piezo dome"
        if not (-r < cy < OUT_H + r and -r < cx < OUT_W + r):
            return 0.0, "the table"
        return top, what

    gaps = []
    for sgn, name in ((-1, "front"), (1, "rear")):
        cy = yc + sgn * pitch
        top, what = highest_under(lx, cy, CUP_D / 2)
        gaps.append(f"{name} cup {hb - CUP_DROP - top:.1f} mm over {what}")
        ok = hb - CUP_DROP - top >= CUP_CLEAR - 1e-6
        add(ok, f"handset {name} cup", gaps[-1])
    rest_bottom = g["apex"] - V_WALL
    under = max(Z_LT + CAP_TOP, Z_DISP + DISP_T + BEZEL_TOP)
    add(rest_bottom - under >= 15, "rests vs keys",
        f"V rests start {rest_bottom - under:.1f} mm above the keycap tops (fingers fit under)")
    cr = shapes["cradle"]
    grams = cr.volume / 1000 * PA12_DENSITY
    arm_len = HINGE_Y - fy
    self_share = (HINGE_Y - cr.center().Y) / arm_len
    share = (HINGE_Y - yc) / arm_len
    need = MX_ACTUATE_GF * 1.5 / share
    add(grams * self_share < 0.5 * MX_ACTUATE_GF and 0.3 < share <= 1.0, "hook load",
        f"arm {grams:.0f} g puts {grams * self_share:.0f} g on the hook cap (switch lifts it); "
        f"{share * 100:.0f} % of the handset's weight presses the switch: handset >= {need:.0f} g "
        f"for 1.5x a {MX_ACTUATE_GF:.0f} gf switch")
    csk = bx2x(HOLES[3][0]) - CSK_D / 2
    ear_out = lx + ARM_W / 2 + EAR_GAP + EAR_T
    dome_y = by2y(BZ1_C[1]) - PIEZO_BORE / 2 - 1.6
    add(ear_out < csk - 1 and HINGE_Y + 6 < dome_y - 1, "hinge ears",
        f"ears x {lx - ear_out + lx:.1f}-{ear_out:.1f} clear of the H4 countersink (x {csk:.1f}) and "
        f"the piezo dome (y {dome_y:.1f}); pin = M3 x {math.ceil((ear_out - lx) * 2 + 4)}+ screw + nylock nut")
    deg = math.degrees(math.atan(MX_TRAVEL / arm_len))
    add(deg < 10, "arm travel", f"{MX_TRAVEL} mm at the foot = {deg:.1f} deg about the pin, "
        f"{arm_len:.1f} mm away")
    return R


# ---------------------------------------------------------------- main
def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--parts", default=str(OUT / "board_parts.json"))
    ap.add_argument("--render", action="store_true")
    a = ap.parse_args()
    OUT.mkdir(parents=True, exist_ok=True)
    parts = load_parts(Path(a.parts))
    shapes = {"tray": tray(), "lid": lid(), "bezel": bezel(), "cradle": cradle()}
    for name, s in shapes.items():
        export_stl(s, str(OUT / f"{name}.stl"), tolerance=0.02, angular_tolerance=0.15)
        export_step(s, str(OUT / f"{name}.step"))
    R = run_checks(parts, shapes)
    lines = [f"{s:4}  {n}: {m}" for s, n, m in R]
    (OUT / "checks.txt").write_text("\n".join(lines) + "\n")
    print("\n".join(lines))
    if a.render:
        render(shapes)
        render_assembled(shapes)
    return 1 if any(s == "FAIL" for s, _, _ in R) else 0


def mesh_of(shape, tol=0.15, ang=0.4):
    import numpy as np
    v, t = shape.tessellate(tol, ang)
    return np.array([[p.X, p.Y, p.Z] for p in v], dtype=float), np.array(t, dtype=int)


def draw(items, path, elev=28, azim=-60, size=(12, 8), title=None, light=(0.35, -0.8, 0.9),
         zoom=1.25, dpi=110) -> None:
    """Headless PNG (matplotlib, Lambert shading). items: [(V, F, '#rrggbb')] in mm; one
    collection for all faces so the per-polygon depth sort is global."""
    import matplotlib
    import numpy as np

    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    from mpl_toolkits.mplot3d.art3d import Poly3DCollection

    fig = plt.figure(figsize=size, dpi=dpi)
    ax = fig.add_subplot(111, projection="3d")
    L = np.array(light, dtype=float)
    L /= np.linalg.norm(L)
    tris, cols, allv = [], [], []
    for V, F, col in items:
        if len(F) == 0:
            continue
        tri = V[F]
        n = np.cross(tri[:, 1] - tri[:, 0], tri[:, 2] - tri[:, 0])
        nn = np.linalg.norm(n, axis=1, keepdims=True)
        n = n / np.where(nn == 0, 1, nn)
        shade = 0.25 + 0.75 * np.clip(np.abs(n @ L), 0, 1) ** 1.2
        base = np.array([int(col.lstrip("#")[i:i + 2], 16) / 255 for i in (0, 2, 4)])
        tris.append(tri)
        cols.append(np.clip(base[None, :] * shade[:, None], 0, 1))
        allv.append(V)
    C = np.concatenate(cols)
    ax.add_collection3d(Poly3DCollection(np.concatenate(tris), facecolors=np.c_[C, np.ones(len(C))],
                                         edgecolors="none", linewidths=0))
    A = np.vstack(allv)
    mn, mx = A.min(0), A.max(0)
    ax.set_xlim(mn[0], mx[0])
    ax.set_ylim(mn[1], mx[1])
    ax.set_zlim(mn[2], mx[2])
    ax.set_box_aspect(tuple(np.maximum(mx - mn, 1e-3)), zoom=zoom)
    ax.view_init(elev=elev, azim=azim)
    ax.set_axis_off()
    if title:
        ax.set_title(title, fontsize=14)
    fig.subplots_adjust(0, 0, 1, 1)
    fig.savefig(path, facecolor="white")
    plt.close(fig)


def render(shapes) -> None:
    dx, dy = bx2x(DISP_X0 + DISP_W / 2), by2y(DISP_Y0 + DISP_H / 2)
    items = [
        (*mesh_of(shapes["tray"]), "#d8d2c4"),
        (*mesh_of(Pos(0, 0, 18) * shapes["lid"]), "#ece6d6"),
        (*mesh_of(Pos(dx, dy, Z_LT + 30) * shapes["bezel"]), "#555555"),
        (*mesh_of(rrect(bx2x(BOARD_W / 2), by2y(BOARD_H / 2), BOARD_W, BOARD_H, BOARD_R, Z_BB, Z_BT)),
         "#2f6b3a"),
    ]
    draw(items, OUT / "proto.png", elev=30, azim=-58, zoom=0.95,
         title="Open Lounge Phone proto box (lid lifted 18 mm, bezel 30 mm)")


def raster(items, path, elev=35, azim=-60, width=2400, ss=2, light=(0.35, -0.8, 0.9)) -> None:
    """Orthographic z-buffer render to a transparent PNG (correct hidden surfaces, Lambert shading)."""
    import numpy as np
    from PIL import Image

    a, e = math.radians(azim), math.radians(elev)
    to_cam = np.array([math.cos(e) * math.sin(a) * -1, math.cos(e) * math.cos(a) * -1, math.sin(e)])
    right = np.array([math.cos(a), -math.sin(a), 0.0])
    up = np.cross(to_cam, right)
    L = np.array(light, dtype=float)
    L /= np.linalg.norm(L)
    tris, cols = [], []
    for V, F, col in items:
        t = V[F]
        n = np.cross(t[:, 1] - t[:, 0], t[:, 2] - t[:, 0])
        n /= np.where(np.linalg.norm(n, axis=1, keepdims=True) == 0, 1, np.linalg.norm(n, axis=1, keepdims=True))
        sh = 0.35 + 0.65 * np.clip(np.abs(n @ L), 0, 1) ** 1.1
        base = np.array([int(col.lstrip("#")[i:i + 2], 16) / 255 for i in (0, 2, 4)])
        tris.append(t)
        cols.append(np.clip(base[None] * sh[:, None], 0, 1))
    T, C = np.concatenate(tris), np.concatenate(cols)
    sx, sy, sz = T @ right, T @ up, T @ to_cam
    x0, x1, y0, y1 = sx.min(), sx.max(), sy.min(), sy.max()
    W = int(width * ss)
    k = (W - 20 * ss) / (x1 - x0)
    H = (int((y1 - y0) * k) + 20 * ss) // ss * ss
    px, py = (sx - x0) * k + 10 * ss, (y1 - sy) * k + 10 * ss
    zbuf = np.full((H, W), -1e9)
    img = np.zeros((H, W, 4))
    for i in range(len(T)):
        X, Y, Z = px[i], py[i], sz[i]
        xa, xb = max(int(X.min()), 0), min(int(X.max()) + 1, W - 1)
        ya, yb = max(int(Y.min()), 0), min(int(Y.max()) + 1, H - 1)
        if xb < xa or yb < ya:
            continue
        d = (Y[1] - Y[2]) * (X[0] - X[2]) + (X[2] - X[1]) * (Y[0] - Y[2])
        if abs(d) < 1e-9:
            continue
        gx, gy = np.meshgrid(np.arange(xa, xb + 1) + 0.5, np.arange(ya, yb + 1) + 0.5)
        l0 = ((Y[1] - Y[2]) * (gx - X[2]) + (X[2] - X[1]) * (gy - Y[2])) / d
        l1 = ((Y[2] - Y[0]) * (gx - X[2]) + (X[0] - X[2]) * (gy - Y[2])) / d
        l2 = 1 - l0 - l1
        inside = (l0 >= -1e-6) & (l1 >= -1e-6) & (l2 >= -1e-6)
        z = l0 * Z[0] + l1 * Z[1] + l2 * Z[2]
        sub = zbuf[ya:yb + 1, xa:xb + 1]
        m = inside & (z > sub)
        sub[m] = z[m]
        img[ya:yb + 1, xa:xb + 1][m] = (*C[i], 1.0)
    img = img.reshape(H // ss, ss, W // ss, ss, 4).mean((1, 3))
    rgb = np.where(img[..., 3:] > 0, img[..., :3] / np.maximum(img[..., 3:], 1e-6), 0)
    Image.fromarray((np.dstack([rgb, img[..., 3:]]) * 255).astype("uint8"), "RGBA").save(path)


def render_assembled(shapes) -> None:
    """The finished prototype: closed box, board, keycaps, display module and bezel."""
    dx, dy = bx2x(DISP_X0 + DISP_W / 2), by2y(DISP_Y0 + DISP_H / 2)
    cap = Box(KEYCAP, KEYCAP, KEYCAP_H, align=(Align.CENTER, Align.CENTER, Align.MIN))
    cap = fillet(cap.edges().group_by(Axis.Z)[-1], 1.8)
    items = [
        (*mesh_of(shapes["tray"]), "#d8d2c4"),
        (*mesh_of(shapes["lid"]), "#ece6d6"),
        (*mesh_of(rrect(dx, dy, DISP_W, DISP_H, 1.0, Z_DISP, Z_DISP + 1.2)), "#2f6b3a"),
        (*mesh_of(rrect(dx, dy, 66.9, 29.1, 0.5, Z_DISP + 1.2, Z_DISP + DISP_T)), "#f2f0ea"),
        (*mesh_of(Pos(dx, dy, Z_LT) * shapes["bezel"]), "#3a3d3c"),
    ]
    for bx, by, label in keys():
        z = Z_LT + (1.0 if label != "HOOK" else 3.0)
        items.append((*mesh_of(Pos(bx2x(bx), by2y(by), z) * cap), "#3d4744"))
    raster(items, OUT / "assembled.png", elev=36, azim=-18)


if __name__ == "__main__":
    sys.exit(main())
