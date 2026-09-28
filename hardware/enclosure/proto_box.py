"""Open Lounge Phone prototype box: a plain, functional enclosure for the single 180 x 88 board.

    .venv/bin/python proto_box.py [--parts build/proto/board_parts.json] [--render]

Standalone (does not use or change olp/, the product enclosure). Two printed parts, TRAY and
LID, where the lid IS the MX switch plate; plus a hook PLUNGER and its SLEEVE for a
prototyping on/off-hook switch over the hall sensor. Outputs STL + STEP to build/proto/,
numeric fit checks to build/proto/checks.txt (exit 1 on FAIL), optional render proto.png.
See PROTO_BOX.md for print and assembly notes.

Frames: base x left -> right, y front -> rear, z up from the table (mm). The board frame is
KiCad's (x right, y DOWN from the rear-left corner): base_x = GAP + WALL + bx,
base_y = GAP + WALL + (BOARD_H - by).

Board part data (heights, courtyards) come from `layout/dump_parts.py` (KiCad's Python):
    cd hardware/layout && <kicad python> dump_parts.py main ../enclosure/build/proto/board_parts.json
Designed to nominal dimensions for industrial printing (MJF/SLS/SLA class): 0.1 mm clearance
per side where parts mate.
"""

from __future__ import annotations

import argparse
import json
import math
import sys
from pathlib import Path

from build123d import (
    Align, Axis, Box, Cylinder, Part, Plane, Pos, RectangleRounded, Rot, Text, chamfer,
    export_step, export_stl, extrude, fillet,
)

HERE = Path(__file__).resolve().parent
OUT = HERE / "build" / "proto"

# ---------------------------------------------------------------- parameters (mm)
BOARD_W, BOARD_H, BOARD_R, BOARD_T = 180.0, 88.0, 8.5, 1.6
GAP, WALL, FLOOR = 1.0, 2.5, 2.0
OUT_W, OUT_H = BOARD_W + 2 * (GAP + WALL), BOARD_H + 2 * (GAP + WALL)   # 187 x 95
OUT_R, EDGE_FILLET = 6.0, 1.0
FIT = 0.1                      # clearance per side where printed parts mate (industrial print)

BOSS_H = 7.0                   # support bosses: floor top -> board bottom (bottom parts <= 6)
Z_FLOOR = FLOOR
Z_BB = Z_FLOOR + BOSS_H        # board bottom 9.0
Z_BT = Z_BB + BOARD_T          # board top 10.6
PLATE_ABOVE_PCB = 5.0          # MX: plate top = PCB top + 5.0
LID_T = 2.0
Z_LT = Z_BT + PLATE_ABOVE_PCB  # lid (plate) top 15.6
Z_LU = Z_LT - LID_T            # lid underside = tray wall top 13.6
TOP_CLEAR = Z_LU - Z_BT        # 3.0 above the board top under the flat lid
BOT_CLEAR = Z_BB - Z_FLOOR     # 7.0 below the board bottom

# MX plate (the lid): cutout parameter, underside pocket so the clips see 1.5 mm
KEY_CUT = 14.0                 # MX nominal; for hobby FDM use ~14.1
KEY_POCKET, KEY_POCKET_D = 15.2, 0.5
DECK_ORIGIN = (31.5, 1.8)      # old deck origin in board coordinates (key grid kept)
KEY_X0, KEY_PITCH, KEY_ROWS = 10.9, 19.05, (13.0, 71.0)
EINK_PANEL = (9.5, 23.65, 88.5, 60.35)   # deck coords, GDEY029T94 outline 79.0 x 36.7
EINK_VIEW, EINK_CHAMFER, EINK_PANEL_T = (68.0, 30.0), 0.5, 1.0
LIGHT_HOLES = [(127.0, 62.8, 3.2), (158.5, 67.5, 2.0), (140.0, 63.6, 2.0)]   # board coords
PINHOLES = [(158.5, 12.5, 1.6, "RESET SW1"), (158.5, 20.8, 1.6, "BOOT SW2"),
            (152.0, 62.5, 1.6, "mic MK1")]    # base mic by the codecs and the MUTE switch

# fastening: 4 shell-bolt holes clamp lid + board + tray (M2.5x10 countersunk into inserts)
BOLTS = [(5.0, 29.8), (26.0, 29.8), (154.0, 29.8), (176.0, 29.8)]
SUPPORTS = [(34.7, 5.0), (145.3, 5.0), (34.7, 82.6), (145.3, 82.6), (145.1, 29.4)]
BOSS_D = 6.0                   # = the board's hole keep-out diameter
SUPPORT_D = 4.6                # plain supports: clear of the hot-swap sockets next to them
SCREW_CLEAR, CSK_D = 2.8, 5.0  # M2.5 countersunk (ISO 10642: head 5.0, 90 deg)
INSERT_D, INSERT_DEPTH = 3.2, 5.0   # M2.5 x 4 heat-set insert (OD 3.5)

# rear wall USB-C (top-mount HRO TYPE-C-31-M-12, body 3.26 tall)
USB = [(153.8, "J7 handset", "rear"), (40.0, "J1 power", "right")]   # (x | y, label, wall), 2026-09-28
USB_BODY_H = 3.26
USB_CUT, USB_CUT_R = (12.8, 7.2), 3.4
USB_RECESS, USB_RECESS_D = (14.5, 9.0), 1.0
Z_USB = Z_BT + USB_BODY_H / 2
# right wall: side controls on the board's BOTTOM side (7 mm room), actuators at the edge
SIDE = [(70.8, "hole", 4.0, "VOL- SW3"), (62.8, "hole", 4.0, "VOL+ SW4"),
        (53.8, "slot", (9.0, 4.0), "MUTE SW5")]
Z_SIDE = Z_BB - 1.8

# hook-post sockets (raised collars on the lid) for a cradle's 12 mm posts/tubes
SOCKETS = [(9.0, 18.8, False), (171.0, 18.8, True)]   # right one over hall U10: plunger bore
SOCK_D, SOCK_OD, SOCK_DEPTH, SOCK_FLOOR = 12.2, 16.0, 8.0, 1.0
RIB_W, RIB_H = 0.8, 0.15       # 3 crush ribs (press fit for tubes of any finish)
PLUNGER_BORE = 10.0
Z_SOCK_FLOOR = Z_LU + SOCK_FLOOR       # 14.6
Z_COLLAR_TOP = Z_SOCK_FLOOR + SOCK_DEPTH   # 22.6

# plunger (proto on/off-hook switch): magnet 2 mm over U10 when pressed, 8 mm travel
HALL_H = 1.2                   # SOT-23 max
MAGNET = (3.0, 1.5)            # N35 disc d x h
TRAVEL = 8.0
STEM_D, BODY_D, BODY_H = 7.0, 9.6, 4.0
Z_TIP_PRESSED = Z_BT + HALL_H + 2.0            # 13.8
Z_GUIDE_TOP = Z_TIP_PRESSED + TRAVEL + 4.0     # stem stays 4 mm in the guide when released
SPRING_PRESSED = 4.0                           # spring length when pressed (solid height < 4)
Z_BODY_BOT = Z_GUIDE_TOP + SPRING_PRESSED
Z_SLEEVE_TOP = Z_BODY_BOT + BODY_H             # pressed: body flush with the sleeve top

# speaker 20 x 40 under the board, firing down through the floor
SPK_C, SPK_SIZE, SPK_T = (80.5, 43.8), (40.0, 20.0), 5.0   # board coords, centre bottom
SPK_RIM_T, SPK_RIM_H = 1.2, 3.0
GRILLE_D, GRILLE_PITCH = 2.0, 3.5

# 1S LiPo pack lying on the tray floor under the board (board coords), wires to J2 at (150, 46)
BATTERY = (102.4, 24.0, 142.4, 54.0, 6.0)   # x0, y0, x1, y1, thickness (e.g. 603040, ~700 mAh)

# underside
FEET = [(14.0, 10.0), (172.0, 10.0), (14.0, 85.0), (172.0, 85.0)]   # base frame
FOOT_D, FOOT_DEPTH = 13.0, 1.0
TEXT, TEXT_SIZE, TEXT_DEPTH = "Open Lounge Phone · proto", 6.0, 0.6

BED = 220.0

# heights above the board surface by footprint name (mm); first match wins. Sources: datasheets
# where known; [est] = estimate, verify against the part before trusting a tight fit.
HEIGHTS = [
    ("USB_C_Receptacle", 3.26), ("ESP32-S3-WROOM-1", 3.3), ("JST_PH", 6.0), ("JST_SH", 2.95),
    ("PinSocket_1x05", 3.0), ("Supercap", 6.0), ("Electret", 2.7), ("TS-1187A", 1.5),
    ("SKRTLAE010", 3.5), ("JS202011AQN", 3.8), ("FH12", 2.0), ("FPC", 2.0),
    ("Kailh", 1.85), ("CPG151101S11", 1.85), ("SK6812MINI", 1.6), ("SOIC", 1.75),
    ("L_Sunlord_SWPA4020S", 2.0), ("ITR8307", 2.0), ("D_SOD-123", 1.35), ("SOT-23", 1.2),
    ("MSOP", 1.1), ("QFN", 1.0), ("DFN", 1.0), ("LGA", 1.0), ("TestPoint", 0.1), ("TP_", 0.1),
    ("MountingHole", 0.1), ("logo", 0.05), ("NetTie", 0.05), ("NFC_Coil", 0.05),
    ("R_2512", 0.7), ("_1206_", 1.2), ("_0805_", 1.3), ("_0603_", 0.9), ("_0402_", 0.6),
]


def bx2x(bx):
    return GAP + WALL + bx


def by2y(by):
    return GAP + WALL + (BOARD_H - by)


def deck(dx, dy):
    return DECK_ORIGIN[0] + dx, DECK_ORIGIN[1] + dy


def keys():
    """(bx, by, label) of the 12 key centres, rear row 1 2 3 4 5 MENU, front 6 7 8 9 0 BACK."""
    labels = [["1", "2", "3", "4", "5", "MENU"], ["6", "7", "8", "9", "0", "BACK"]]
    return [(*deck(KEY_X0 + i * KEY_PITCH, y), labels[r][i])
            for r, y in enumerate(KEY_ROWS) for i in range(6)]


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


def stadium_x(cy, cz, w, h, r, x0, x1) -> Part:
    r = max(0.01, min(r, w / 2 - 0.01, h / 2 - 0.01))
    face = Plane.YZ.offset(x0) * Pos(cy, cz) * RectangleRounded(w, h, r)
    return extrude(face, amount=x1 - x0)


def union(parts):
    out = parts[0]
    for p in parts[1:]:
        out = out + p
    return out


# ---------------------------------------------------------------- board data
def load_parts(path: Path) -> list[dict]:
    if not path.exists():
        return []
    parts = json.loads(path.read_text())["parts"]
    for p in parts:
        p["h"] = height_of(p["fp"])
    return parts


def lid_pockets(parts) -> list[tuple]:
    """Top parts taller than the space under the flat lid get an underside pocket
    (courtyard + 0.3, depth = overlap + 0.2, max 1.0 so the lid keeps >= 1.0)."""
    out = []
    for p in parts:
        if p["side"] != "top" or p["h"] + 0.2 <= TOP_CLEAR:
            continue
        x0, y0, x1, y1 = p["crt"]
        depth = p["h"] + 0.2 - TOP_CLEAR
        out.append((p["ref"], x0 - 0.3, y0 - 0.3, x1 + 0.3, y1 + 0.3, depth))
    return out


# ---------------------------------------------------------------- parts
def usb_cutters():
    cut = []
    for pos, _, wall in USB:
        if wall == "right":   # power port on the right wall (board y = pos)
            y = by2y(pos)
            cut.append(stadium_x(y, Z_USB, *USB_CUT, USB_CUT_R, OUT_W - WALL - 0.5, OUT_W + 1))
            cut.append(box(OUT_W - USB_RECESS_D, OUT_W + 1, y - USB_RECESS[0] / 2,
                           y + USB_RECESS[0] / 2, Z_USB - USB_RECESS[1] / 2, Z_LT + 1))
            cut.append(box(OUT_W - WALL - 0.5, OUT_W + 1, y - USB_CUT[0] / 2, y + USB_CUT[0] / 2,
                           Z_USB, Z_LT + 1))
            continue
        x = bx2x(pos)
        cut.append(stadium_y(x, Z_USB, *USB_CUT, USB_CUT_R, OUT_H - WALL - 0.5, OUT_H + 1))
        # outside recess (1.0 deep), open to the top like the cut-out (the plug overmold
        # reaches the lid top: a top-mount receptacle's centre is only 5.0 - 1.63 below it)
        cut.append(box(x - USB_RECESS[0] / 2, x + USB_RECESS[0] / 2, OUT_H - USB_RECESS_D,
                       OUT_H + 1, Z_USB - USB_RECESS[1] / 2, Z_LT + 1))
        cut.append(box(x - USB_CUT[0] / 2, x + USB_CUT[0] / 2, OUT_H - WALL - 0.5, OUT_H + 1,
                       Z_USB, Z_LT + 1))
    return cut


def tray(parts) -> Part:
    shell = rrect(OUT_W / 2, OUT_H / 2, OUT_W, OUT_H, OUT_R, 0, Z_LU)
    shell = fillet(shell.edges().group_by(Axis.Z)[0], EDGE_FILLET)
    t = shell - rrect(OUT_W / 2, OUT_H / 2, OUT_W - 2 * WALL, OUT_H - 2 * WALL,
                      OUT_R - WALL, Z_FLOOR, Z_LU + 1)
    add = []
    for bx, by in BOLTS:
        add.append(cyl(bx2x(bx), by2y(by), Z_FLOOR - 0.01, Z_BB, BOSS_D))
    for bx, by in SUPPORTS:
        add.append(cyl(bx2x(bx), by2y(by), Z_FLOOR - 0.01, Z_BB, SUPPORT_D))
    # speaker retaining rim on the floor
    sx, sy = bx2x(SPK_C[0]), by2y(SPK_C[1])
    w, h = SPK_SIZE[0] + 2 * FIT, SPK_SIZE[1] + 2 * FIT
    rim = (box(sx - w / 2 - SPK_RIM_T, sx + w / 2 + SPK_RIM_T, sy - h / 2 - SPK_RIM_T,
               sy + h / 2 + SPK_RIM_T, Z_FLOOR - 0.01, Z_FLOOR + SPK_RIM_H)
           - box(sx - w / 2, sx + w / 2, sy - h / 2, sy + h / 2, Z_FLOOR - 1, Z_FLOOR + 5))
    add.append(rim)
    t = t + union(add)
    cut = []
    for bx, by in BOLTS:
        x, y = bx2x(bx), by2y(by)
        cut.append(cyl(x, y, -1, Z_BB + 1, SCREW_CLEAR))
        cut.append(cyl(x, y, Z_BB - INSERT_DEPTH, Z_BB + 1, INSERT_D))
    # grille: 2 mm holes on a 3.5 mm hex grid inside the speaker outline (1.5 mm margin)
    gx0, gx1 = sx - SPK_SIZE[0] / 2 + 1.5, sx + SPK_SIZE[0] / 2 - 1.5
    gy0, gy1 = sy - SPK_SIZE[1] / 2 + 1.5, sy + SPK_SIZE[1] / 2 - 1.5
    row, y = 0, gy0 + GRILLE_D / 2
    while y <= gy1 - GRILLE_D / 2 + 1e-6:
        x = gx0 + GRILLE_D / 2 + (GRILLE_PITCH / 2 if row % 2 else 0)
        while x <= gx1 - GRILLE_D / 2 + 1e-6:
            cut.append(cyl(x, y, -1, Z_FLOOR + 1, GRILLE_D))
            x += GRILLE_PITCH
        y += GRILLE_PITCH * math.sqrt(3) / 2
        row += 1
    for x, y in FEET:
        cut.append(cyl(x, y, -1, FOOT_DEPTH, FOOT_D))
    cut += usb_cutters()
    for by, kind, size, _ in SIDE:
        y = by2y(by)
        if kind == "hole":
            cut.append(stadium_x(y, Z_SIDE, size, size, size / 2, OUT_W - WALL - 1, OUT_W + 1))
        else:
            cut.append(stadium_x(y, Z_SIDE, size[0], size[1], size[1] / 2, OUT_W - WALL - 1,
                                 OUT_W + 1))
    txt = Text(TEXT, font_size=TEXT_SIZE, align=(Align.CENTER, Align.CENTER))
    txt = Pos(OUT_W / 2 + 12, 22.0, 0) * Rot(0, 180, 0) * extrude(txt, amount=-TEXT_DEPTH)
    cut.append(txt)
    return t - union(cut)


def lid(parts) -> Part:
    plate = rrect(OUT_W / 2, OUT_H / 2, OUT_W, OUT_H, OUT_R, Z_LU, Z_LT)
    plate = fillet(plate.edges().group_by(Axis.Z)[-1], EDGE_FILLET)
    add = []
    # locating lip on the underside, inset FIT from the tray's inner wall
    iw, ih, ir = OUT_W - 2 * WALL - 2 * FIT, OUT_H - 2 * WALL - 2 * FIT, OUT_R - WALL
    add.append(rrect(OUT_W / 2, OUT_H / 2, iw, ih, ir, Z_LU - 1.5, Z_LU + 0.01)
               - rrect(OUT_W / 2, OUT_H / 2, iw - 2.4, ih - 2.4, ir - 1.2, Z_LU - 2, Z_LU + 1))
    # clamp spacers: lid underside -> board top at the 4 bolt holes
    for bx, by in BOLTS:
        add.append(cyl(bx2x(bx), by2y(by), Z_BT, Z_LU + 0.01, BOSS_D))
    # hook-post socket collars
    for bx, by, _ in SOCKETS:
        add.append(cyl(bx2x(bx), by2y(by), Z_LT - 0.01, Z_COLLAR_TOP, SOCK_OD))
    body = plate + union(add)
    cut = []
    for bx, by, _ in keys():
        x, y = bx2x(bx), by2y(by)
        cut.append(box(x - KEY_CUT / 2, x + KEY_CUT / 2, y - KEY_CUT / 2, y + KEY_CUT / 2,
                       Z_LU - 3, Z_LT + 1))
        cut.append(box(x - KEY_POCKET / 2, x + KEY_POCKET / 2, y - KEY_POCKET / 2,
                       y + KEY_POCKET / 2, Z_LU - 3, Z_LU + KEY_POCKET_D))
    # e-ink: panel pocket in the underside (panel raised to plate level) + chamfered window
    x0, y0 = deck(EINK_PANEL[0], EINK_PANEL[1])
    x1, y1 = deck(EINK_PANEL[2], EINK_PANEL[3])
    ex, ey = bx2x((x0 + x1) / 2), by2y((y0 + y1) / 2)
    pw, ph = (x1 - x0) + 2 * FIT, (y1 - y0) + 2 * FIT
    cut.append(box(ex - pw / 2, ex + pw / 2, ey - ph / 2, ey + ph / 2, Z_LU - 3,
                   Z_LU + EINK_PANEL_T))
    win = box(ex - EINK_VIEW[0] / 2, ex + EINK_VIEW[0] / 2, ey - EINK_VIEW[1] / 2,
              ey + EINK_VIEW[1] / 2, Z_LU, Z_LT + 1)
    cut.append(win)
    c = EINK_CHAMFER   # 45 deg chamfer on the window's top edge
    cut.append(extrude(Pos(ex, ey, Z_LT - c) * RectangleRounded(EINK_VIEW[0], EINK_VIEW[1], 0.01),
                       amount=c + 0.01, taper=-45))
    for bx, by, d in LIGHT_HOLES:
        cut.append(cyl(bx2x(bx), by2y(by), Z_LU - 1, Z_LT + 1, d))
    for bx, by, d, _ in PINHOLES:
        cut.append(cyl(bx2x(bx), by2y(by), Z_LU - 1, Z_LT + 1, d))
    for bx, by in BOLTS:
        x, y = bx2x(bx), by2y(by)
        cut.append(cyl(x, y, Z_BT - 1, Z_LT + 1, SCREW_CLEAR))
        cut.append(_csk(x, y))
    for bx, by, bore in SOCKETS:
        x, y = bx2x(bx), by2y(by)
        cut.append(cyl(x, y, Z_SOCK_FLOOR, Z_COLLAR_TOP + 1, SOCK_D))
        if bore:
            cut.append(cyl(x, y, Z_LU - 3, Z_SOCK_FLOOR + 1, PLUNGER_BORE))
    for ref, x0, y0, x1, y1, depth in lid_pockets(parts):
        cut.append(box(bx2x(x0), bx2x(x1), by2y(y0), by2y(y1), Z_LU - 3, Z_LU + depth))
    cut += usb_cutters()
    body = body - union(cut)
    # crush ribs inside the sockets (3 x 120 deg)
    ribs = []
    for bx, by, _ in SOCKETS:
        x, y = bx2x(bx), by2y(by)
        for k in range(3):
            a = math.radians(90 + 120 * k)
            r = SOCK_D / 2 - RIB_H + RIB_W / 2
            ribs.append(Pos(x + r * math.cos(a), y + r * math.sin(a), Z_SOCK_FLOOR)
                        * Rot(0, 0, math.degrees(a))
                        * Box(RIB_W, RIB_W, SOCK_DEPTH - 0.8,
                              align=(Align.CENTER, Align.CENTER, Align.MIN)))
    return body + union(ribs)


def _csk(x, y) -> Part:
    """90 deg countersink cone for an M2.5 flat head, flush with the lid top."""
    h = (CSK_D - SCREW_CLEAR) / 2
    return Pos(x, y, Z_LT - h) * _cone(SCREW_CLEAR / 2, CSK_D / 2 + 0.3, h + 0.3)


def _cone(r0, r1, h) -> Part:
    from build123d import Cone
    return Cone(r0, r1, h, align=(Align.CENTER, Align.CENTER, Align.MIN))


def sleeve() -> Part:
    """Post stub for the right socket that guides the plunger (printed upright)."""
    h = Z_SLEEVE_TOP - Z_SOCK_FLOOR
    s = cyl(0, 0, 0, h, 12.0)
    s = s - cyl(0, 0, -1, Z_GUIDE_TOP - Z_SOCK_FLOOR, STEM_D + 2 * FIT)
    s = s - cyl(0, 0, Z_GUIDE_TOP - Z_SOCK_FLOOR, h + 1, BODY_D + 2 * FIT)
    return s


def plunger() -> Part:
    """Stem with the magnet pocket in its tip + body the handset presses (printed body down)."""
    stem_l = Z_BODY_BOT - Z_TIP_PRESSED
    p = cyl(0, 0, 0, stem_l, STEM_D) + cyl(0, 0, stem_l - 0.01, stem_l + BODY_H, BODY_D)
    p = p - cyl(0, 0, -1, MAGNET[1] + 0.1, MAGNET[0] + 2 * FIT)
    return p


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
        f"wall {WALL}, floor {FLOOR}, lid {LID_T}; thinnest lid: key clip {LID_T - KEY_POCKET_D}, "
        f"e-ink rim {LID_T - EINK_PANEL_T}")
    add(abs(Z_LT - (Z_BT + 5.0)) < 1e-6, "MX stack",
        f"board top z {Z_BT:.1f}, plate top z {Z_LT:.1f} (+{Z_LT - Z_BT:.1f}), "
        f"space under the lid {TOP_CLEAR:.1f}, under the board {BOT_CLEAR:.1f}")
    if not parts:
        add("warn", "board data", "no board_parts.json: fit checks against parts skipped")
        return R
    by_ref = {p["ref"]: p for p in parts}

    # tall top parts -> lid pockets
    for ref, x0, y0, x1, y1, depth in lid_pockets(parts):
        ok = depth <= 1.0
        add(ok, f"lid pocket {ref}",
            f"{by_ref[ref]['fp']} h {by_ref[ref]['h']:.2f} > {TOP_CLEAR:.1f}: pocket {depth:.2f} deep "
            f"(lid left {LID_T - depth:.2f})" + ("" if ok else " -> too tall for the lid"))
    # bottom parts vs floor space
    for p in parts:
        if p["side"] == "bottom" and p["h"] > BOT_CLEAR - 1.0:
            add(False, f"under-board height {p['ref']}", f"{p['fp']} h {p['h']} > {BOT_CLEAR - 1}")
    # bosses / spacers vs parts (Ø BOSS_D at every hole; bottom = tray boss, top = lid spacer)
    holes_ok = True
    for bx, by in BOLTS + SUPPORTS:
        dia = BOSS_D if (bx, by) in BOLTS else SUPPORT_D
        for p in parts:
            if p["fp"].startswith("MountingHole") or p["ref"].startswith("H"):
                continue
            side_hit = p["side"] == "bottom" or p["tht"] or ((bx, by) in BOLTS)
            if not side_hit:
                continue
            d = circle_rect_dist(bx, by, dia / 2, p["crt"])
            if d < 0:
                holes_ok = False
                add(False, f"boss ({bx},{by}) vs {p['ref']}",
                    f"{p['side']} {p['fp']} courtyard overlaps the Ø{dia} boss by {-d:.2f} mm")
    if holes_ok:
        add(True, "bosses / spacers", f"no part courtyard inside a boss/spacer (bolts Ø{BOSS_D}, "
            f"supports Ø{SUPPORT_D})")
    # speaker under the board
    sx0 = SPK_C[0] - SPK_SIZE[0] / 2 - SPK_RIM_T - FIT
    sx1 = SPK_C[0] + SPK_SIZE[0] / 2 + SPK_RIM_T + FIT
    sy0 = SPK_C[1] - SPK_SIZE[1] / 2 - SPK_RIM_T - FIT
    sy1 = SPK_C[1] + SPK_SIZE[1] / 2 + SPK_RIM_T + FIT
    room = Z_BB - (Z_FLOOR + max(SPK_T, SPK_RIM_H))
    bad = []
    for p in parts:
        x0, y0, x1, y1 = p["crt"]
        over = not (x1 <= sx0 or x0 >= sx1 or y1 <= sy0 or y0 >= sy1)
        if over and (p["side"] == "bottom" or p["tht"]):
            h = p["h"] if p["side"] == "bottom" else 1.5    # THT leads ~1.5 below
            if h > room - 0.5:
                bad.append(f"{p['ref']} ({p['side']}, h {h})")
    add(not bad, "speaker keep-out",
        f"speaker {SPK_SIZE[0]:.0f}x{SPK_SIZE[1]:.0f}x{SPK_T} under board ({sx0:.1f}..{sx1:.1f}, "
        f"{sy0:.1f}..{sy1:.1f}), {room:.1f} mm to the board bottom"
        + (": conflicts " + ", ".join(bad) if bad else ""))
    # battery pocket under the board
    bx0, by0, bx1, by1, bt = BATTERY
    # (the module's thermal vias and the mounting holes have no leads below the board)
    bad = [p["ref"] for p in parts if (p["side"] == "bottom" or p["tht"])
           and not any(k in p["fp"] for k in ("MountingHole", "ESP32"))
           and not (p["crt"][2] <= bx0 or p["crt"][0] >= bx1 or p["crt"][3] <= by0
                    or p["crt"][1] >= by1)]
    add(not bad and bt <= BOT_CLEAR - 1.0, "battery pocket",
        f"{bx1 - bx0:.0f} x {by1 - by0:.0f} x {bt} mm pack under the board ({bx0}..{bx1}, {by0}..{by1})"
        + (": conflicts " + ", ".join(bad) if bad else ""))
    # sockets: parts under the plunger stem
    for bx, by, bore in SOCKETS:
        if not bore:
            continue
        hall = by_ref.get("U10")
        if hall:
            off = math.hypot(hall["at"][0] - bx, hall["at"][1] - by)
            add(off < 0.5, "hall under plunger", f"U10 at {hall['at']}, socket ({bx},{by}), off {off:.2f}")
        for p in parts:
            if p["side"] != "top" or p["ref"] == "U10":
                continue
            d = circle_rect_dist(bx, by, PLUNGER_BORE / 2, p["crt"])
            if d < 0 and Z_BT + p["h"] > Z_TIP_PRESSED - 1.0:
                add(False, f"plunger vs {p['ref']}", f"h {p['h']} under the Ø10 bore")
    # connectors and controls vs cut-outs
    for pos, label, wall in USB:
        ref = label.split()[0]
        p = by_ref.get(ref)
        if p:
            k = 1 if wall == "right" else 0
            edge = p["crt"][2] > BOARD_W - 1.0 if wall == "right" else p["crt"][1] < 1.0
            add(abs(p["at"][k] - pos) < 0.3 and p["side"] == "top" and edge, f"USB-C {label}",
                f"{ref} at {'y' if k else 'x'} {p['at'][k]} ({p['side']}), {wall} wall cut-out "
                f"{pos}, z {Z_USB:.2f}")
    for by, kind, _, label in SIDE:
        ref = label.split()[1]
        p = by_ref.get(ref)
        if p:
            cy = (p["crt"][1] + p["crt"][3]) / 2
            ok = abs(cy - by) < 0.6 and p["side"] == "bottom" and p["crt"][2] > BOARD_W - 1.5
            add(ok, f"side {label}", f"{ref} at {p['at']} {p['side']} (need bottom, y {by}, at edge)")
    sw = [p for p in parts if "CPG151101S11" in p["fp"] or "Kailh" in p["fp"] or "MX" in p["fp"]]
    if sw:
        want = sorted((round(x, 2), round(y, 2)) for x, y, _ in keys())
        got = sorted((round(p["at"][0], 2), round(p["at"][1], 2)) for p in sw)
        add(len(sw) == 12 and all(math.hypot(a[0] - b[0], a[1] - b[1]) < 0.3 for a, b in
                                  zip(want, got)), "key grid", f"{len(sw)} switch sockets vs lid cut-outs")
    return R


# ---------------------------------------------------------------- main
def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--parts", default=str(OUT / "board_parts.json"))
    ap.add_argument("--render", action="store_true")
    a = ap.parse_args()
    OUT.mkdir(parents=True, exist_ok=True)
    parts = load_parts(Path(a.parts))
    shapes = {"tray": tray(parts), "lid": lid(parts), "plunger": plunger(), "sleeve": sleeve()}
    for name, s in shapes.items():
        export_stl(s, str(OUT / f"{name}.stl"), tolerance=0.02, angular_tolerance=0.15)
        export_step(s, str(OUT / f"{name}.step"))
    R = run_checks(parts, shapes)
    lines = [f"{s:4}  {n}: {m}" for s, n, m in R]
    (OUT / "checks.txt").write_text("\n".join(lines) + "\n")
    print("\n".join(lines))
    if a.render:
        render(shapes)
    return 1 if any(s == "FAIL" for s, _, _ in R) else 0


def render(shapes) -> None:
    sys.path.insert(0, str(HERE))
    from olp.render import mesh_of, render as draw
    sx, sy = bx2x(SOCKETS[1][0]), by2y(SOCKETS[1][1])
    items = [
        (*mesh_of(shapes["tray"]), "#d8d2c4"),
        (*mesh_of(Pos(0, 0, 18) * shapes["lid"]), "#ece6d6"),
        (*mesh_of(rrect(bx2x(BOARD_W / 2), by2y(BOARD_H / 2), BOARD_W, BOARD_H, BOARD_R, Z_BB, Z_BT)),
         "#2f6b3a"),
        (*mesh_of(Pos(sx, sy, Z_SOCK_FLOOR + 18) * sleeve()), "#9aa3ad"),
        (*mesh_of(Pos(sx, sy, Z_TIP_PRESSED + 18 + 26) * plunger()), "#c0392b"),
    ]
    draw(items, OUT / "proto.png", elev=30, azim=-58, zoom=0.95, title="Open Lounge Phone proto box (lid lifted 18 mm)")


if __name__ == "__main__":
    sys.exit(main())
