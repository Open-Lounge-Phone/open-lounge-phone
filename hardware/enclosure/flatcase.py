"""The flat-cut case: a laser-cut sandwich for the minimal board, a wall phone like the core.

Every part is cut from one sheet of 3 mm acrylic (or plywood) and held with M3 standoffs,
screws and nuts. Layers, front to back: the front plate, which is the switch plate (each switch
stands in its own 14 mm opening, the keycaps float above it and the display module stands over
it on its socket), the board hung 2 mm under it, and the back plate, which hangs on a wall from
two keyholes.

The switchhook works like the core wall phone's: one rocker, its centreline straight above the
hook key, on an M3 screw between two lugs at the top of the face.

- The ear: a wide flat fork standing out from the wall. The earpiece cup sits between its two
  prongs (the handle hangs down between them), and a post at each prong's tip keeps the cup from
  sliding off.
- The stem: a long fin from the ear down the face to the hook key's cap.
- The handset's weight tips the ear down, and the stem presses the hook key. Lift the handset
  and the key's own spring pushes the stem back up.

    .venv/bin/python flatcase.py            # build/flatcase/: cut files (DXF, SVG) and STL

Coordinates: the board's, x right, y up (the top edge carries USB-C and the handset jack),
z = 0 the board's top surface, +z out from the wall.
"""
from __future__ import annotations

import math
from pathlib import Path

from build123d import (
    Align,
    offset,
    Box,
    Cylinder,
    ExportDXF,
    ExportSVG,
    Face,
    Plane,
    Polygon,
    Pos,
    Rectangle,
    RectangleRounded,
    Circle,
    Rot,
    export_step,
    export_stl,
    extrude,
    fillet,
    Axis,
)

import faceplate as F  # noqa: E402  (board geometry: switches, holes, display, LED, piezo)
import handset as HS
import proto_box as P

OUT = Path(__file__).resolve().parent / "build" / "flatcase"

# --- sheet and stack (mm) ----------------------------------------------------------------------
T = 3.0                    # sheet thickness (3 mm acrylic or plywood)
# The front plate is the switch plate, as on a keyboard: it lies 2 mm over the board, its top at
# the switches' plate line (5.0 mm over the board, where an MX switch's top housing starts), so
# each switch stands in its own 14 mm opening and the keycaps float above the plate. The board
# hangs under it on four 2 mm spacers. Only the piezo and the display socket stand up from the
# board's top; the USB-C, the ESP32, the jack and the hot-swap sockets are on the bottom.
PLATE_GAP = 2.0            # M3 spacers, board top to plate (button-head screws fit under it)
COLUMN = 12.0              # M3 standoffs, back plate to front plate, outside the board
SWITCH_HOLE = 14.0         # the MX plate opening (Gateron KS-8 and other MX-size switches)
KEYCAP, KEYCAP_H = P.KEYCAP, P.KEYCAP_H          # clear XDA 1u caps, as the prototype box
FRONT_Z0 = PLATE_GAP                             # front plate's back face (board top = 0)
FRONT_Z1 = FRONT_Z0 + T                          # 5.0: the switches' plate line
KEYCAP_TOP = FRONT_Z1 + P.CAP_TOP                # cap tops over the board (the box's estimate)
BACK_Z1 = FRONT_Z0 - COLUMN                      # back plate's front face
BACK_Z0 = BACK_Z1 - T
UNDER_BOARD = BACK_Z1 + F.BOARD_T                # 8.4 below the board: the jack's plug and leads

PIEZO_HOLE = 13.4          # the piezo (12.2 across, 6.5 tall) stands 1.5 mm out of the plate
M3 = 3.4                   # clearance hole
M2 = 2.4
HOOK_KEY = next((x, F.Y(y)) for x, y, lab in F.SWITCHES if lab == "HOOK")
PIEZO = (P.BZ1_C[0], F.Y(P.BZ1_C[1]))

# --- outline: the board and a margin, like the core faceplate --------------------------------
MARGIN = 10.0              # plate beyond the board
R_CORNER = 10.0
BODY = (-MARGIN, F.BOARD_W + MARGIN, -MARGIN, F.BOARD_H + MARGIN)
COLUMNS = [(-5.0, -5.0), (F.BOARD_W + 5.0, -5.0), (F.BOARD_W + 5.0, F.BOARD_H + 5.0),
           (-5.0, F.BOARD_H + 5.0), (40.0, F.BOARD_H + 5.0)]   # outside the board and the plugs
KEYHOLES = [(60.0, 47.0), (140.0, 47.0)]   # under the board, clear of the parts on its bottom

# --- the switchhook: one rocker, straight above the hook key -----------------------------------
HS_X = HOOK_KEY[0]         # the handset's centreline runs through the hook key
PIVOT = (55.0, KEYCAP_TOP + 5.5)  # (y, z): below the piezo, a short lever to the hook key
LUG_X = (HS_X - T - 0.5, HS_X + T + 0.5)         # the two fixed lugs either side of the stem
LUG_Y = (PIVOT[0] - 8.5, PIVOT[0] + 8.5)        # their feet on the front plate
STEM_W = 9.0               # the stem bar (in z)
NECK = (PIVOT[1] - 4.0, PIVOT[1] + 4.0)          # the stem's top, through the ear (z)
SHOULDER = (PIVOT[1] - 5.5, PIVOT[1] + 5.5)      # the stem below the ear: the ear sits on it
EAR_Y = BODY[3]            # the ear's underside, just over the plates' top edge
GAP_X = 25.0               # the prongs' inner edges, either side of the centreline: the handle
PRONG_W = 7.0              # (39-46 mm wide under the cup) passes between them
EAR_Z0 = 15.0              # the ear's inner edge (the plates' edge is under it)
BAR_Z1 = 36.0              # the crossbar's outer edge: behind the handset's back
CUP_R = HS.CUP_D / 2
FRONT_GAP = 40.0           # the rests: M3 standoffs from the front plate to the handset's back
HS_BASE_Z = FRONT_Z1 + FRONT_GAP                  # the handset's back (its cups' rims)
CUP_Y = EAR_Y + T + math.sqrt(CUP_R ** 2 - GAP_X ** 2)   # the earpiece cup's centre, on the prongs
POST_D = 6.0               # M3 standoffs (5.5 hex), as round posts
LIP_L = 8.0                # the lips: short standoffs on the prongs' tips, in front of the cup
LIP_X = GAP_X + PRONG_W / 2                       # from the centreline
LIP_Z = 70.5               # just in front of the cup (its front rises steeply; checked)
EAR_Z1 = LIP_Z + 5.0
RESTS = [(HS_X - 14.0, -5.0), (HS_X + 14.0, -5.0)]   # under the mouthpiece, below the board
HANDSET_G = 180.0          # MEASURE: your handset's weight
HOOK_SPRING_GF = (30.0, 60.0)    # a linear MX switch: at the top of travel and at the bottom


def rect(x0, x1, y0, y1):
    return Pos((x0 + x1) / 2, (y0 + y1) / 2) * Rectangle(x1 - x0, y1 - y0)


def rrect(x0, x1, y0, y1, r):
    return Pos((x0 + x1) / 2, (y0 + y1) / 2) * RectangleRounded(x1 - x0, y1 - y0, r)


def outline():
    """The plates' shape: the board and a margin, corners rounded like the core faceplate."""
    return rrect(*BODY, R_CORNER)


def board_y(y):
    return F.Y(y)


# ============================================================================== plates
def front_plate_2d():
    """The switch plate: a 14 mm opening per switch (the 12 keys and the hook), a hole the piezo
    stands up through, one for the display's socket, one over the status light, and the board's
    four screws."""
    s = outline()
    for x, y, _ in F.SWITCHES:
        s -= Pos(x, board_y(y)) * RectangleRounded(SWITCH_HOLE, SWITCH_HOLE, 0.3)
    s -= Pos(*PIEZO) * Circle(PIEZO_HOLE / 2)          # the ringer stands through, open to the air
    jx, jy = P.J3_CENTRE[0], board_y(P.J3_CENTRE[1])
    s -= Pos(jx, jy) * RectangleRounded(*P.J3_CUT, 0.5)  # the display module plugs in through it
    lx, ly = P.LED[0], board_y(P.LED[1])
    s -= Pos(lx, ly) * Circle(1.6)                    # the status light shows through
    for x, y in F.HOLES:                              # the board hangs under the plate
        s -= Pos(x, board_y(y)) * Circle(M3 / 2)
    for x, y in COLUMNS:
        s -= Pos(x, y) * Circle(M3 / 2)
    for x, y in P.MODULE_FAR_HOLES:                   # the module's far end stands on the plate
        s -= Pos(x, board_y(y)) * Circle(M2 / 2)
    for x, y in RESTS:                                # the mouthpiece's rests
        s -= Pos(x, y) * Circle(M3 / 2)
    for lx in LUG_X:                                  # the lugs' tabs and screws
        y0, y1 = lug_tab()
        s -= rect(lx - (T + 0.2) / 2, lx + (T + 0.2) / 2, y0 - 0.1, y1 + 0.1)
        s -= Pos(lx, lug_screw()) * Circle(M3 / 2)
    return s


def back_plate_2d():
    s = outline()
    for x, y in COLUMNS:
        s -= Pos(x, y) * Circle(M3 / 2)
    for x, y, _ in P.BUTTONS:                        # pinholes for RESET and BOOT
        s -= Pos(x, board_y(y)) * Circle(1.0)
    for x, y in KEYHOLES:
        s -= keyhole(x, y)
    return s


def keyhole(x, y):
    """A keyhole for a wall screw: the head goes through the round part, then the phone slides
    down so the screw sits at the top of the slot."""
    return Pos(x, y) * Circle(4.5) + rrect(x - 2.0, x + 2.0, y, y + 10.0, 1.9)


# ============================================================================== fins (in y-z)
def lug_tab():
    """(y0, y1) of each lug's tab into the front plate."""
    return LUG_Y[0] + 9.5, LUG_Y[1] - 0.5


def lug_screw():
    """y of each lug's T-slot screw: from under the front plate, its head between the piezo and
    the board's edge (the plugs come out past it)."""
    return LUG_Y[0] + 5.6


def poly(points):
    """A polygon, always counter-clockwise: a clockwise one faces the other way, won't merge with
    the rest of a part and extrudes backwards."""
    area = sum(x0 * y1 - x1 * y0 for (x0, y0), (x1, y1) in zip(points, points[1:] + points[:1]))
    return Polygon(*(points if area > 0 else points[::-1]), align=None)


def t_slot(u, v, toward=(0.0, -1.0), depth=10.0):
    """A T-slot for an M3 screw and nut, cut into a fin's edge at (u, v), going `toward`."""
    du, dv = toward
    pu, pv = -dv, du   # perpendicular
    shaft = poly([(u + pu * 1.6, v + pv * 1.6), (u - pu * 1.6, v - pv * 1.6),
                  (u - pu * 1.6 + du * depth, v - pv * 1.6 + dv * depth),
                  (u + pu * 1.6 + du * depth, v + pv * 1.6 + dv * depth)])
    nu, nv = u + du * (depth - 4.5), v + dv * (depth - 4.5)
    nut = poly([(nu + pu * 2.9 - du * 1.3, nv + pv * 2.9 - dv * 1.3), (nu - pu * 2.9 - du * 1.3, nv - pv * 2.9 - dv * 1.3),
                (nu - pu * 2.9 + du * 1.3, nv - pv * 2.9 + dv * 1.3), (nu + pu * 2.9 + du * 1.3, nv + pv * 2.9 + dv * 1.3)])
    return shaft + nut


def lug_2d():
    """A fixed lug (u = y, v = z): a tab into the front plate and the pivot screw on top."""
    z0 = FRONT_Z1
    py, pz = PIVOT
    body = poly([(LUG_Y[0], z0), (LUG_Y[1], z0), (py + 5.0, pz + 5.0), (py - 5.0, pz + 5.0),
                 (LUG_Y[0], z0 + 15.0)])
    body += Pos(py, pz) * Circle(5.0)
    body += rect(*lug_tab(), z0 - T, z0 + 1.0)
    body -= Pos(py, pz) * Circle(M3 / 2)
    body -= t_slot(lug_screw(), z0, toward=(0.0, 1.0))
    return body


def bar(p0, p1, w):
    """A straight bar of width w from p0 to p1 with rounded ends."""
    (u0, v0), (u1, v1) = p0, p1
    L = math.hypot(u1 - u0, v1 - v0)
    pu, pv = -(v1 - v0) / L * w / 2, (u1 - u0) / L * w / 2
    body = poly([(u0 + pu, v0 + pv), (u1 + pu, v1 + pv), (u1 - pu, v1 - pv), (u0 - pu, v0 - pv)])
    return body + Pos(u0, v0) * Circle(w / 2) + Pos(u1, v1) * Circle(w / 2)


def stem_tip():
    """(y, z) of the round end that rests on the hook key's cap."""
    return HOOK_KEY[1], KEYCAP_TOP + STEM_W / 2


def stem_2d():
    """The stem (u = y, v = z): a long bar from the hook key's cap up to the pivot, then on up
    through the ear, which sits on its shoulder and is held down by a screw across the neck."""
    py, pz = PIVOT
    body = bar(stem_tip(), (py, pz), STEM_W)
    body += Pos(py, pz) * Circle(6.0)                 # the hub round the pivot screw
    body += rect(py, EAR_Y, *SHOULDER)                # up to the ear
    top = EAR_Y + T + 7.0
    body += rect(EAR_Y - 1.0, top, *NECK)             # through the ear's slot
    body -= Pos(py, pz) * Circle(1.8)                 # turns freely on the screw
    body -= Pos(lock_y(), pz) * Circle(M3 / 2)        # the screw that holds the ear down
    return body


def lock_y():
    return EAR_Y + T + 1.7


def ear_2d():
    """The ear (u = x, v = z): a wide fork standing out from the wall. A crossbar behind the
    handset carries the stem's slot; two prongs run out under the earpiece cup, with a hole at
    each tip for its lip."""
    x0, x1 = HS_X - GAP_X - PRONG_W, HS_X + GAP_X + PRONG_W
    body = rrect(x0, x1, EAR_Z0, BAR_Z1, 3.0)
    for sg in (-1, 1):
        px = HS_X + sg * LIP_X
        body += rrect(px - PRONG_W / 2, px + PRONG_W / 2, BAR_Z1 - 4.0, EAR_Z1, PRONG_W / 2 - 0.01)
        body -= Pos(px, LIP_Z) * Circle(M3 / 2)
    body -= rect(HS_X - (T + 0.2) / 2, HS_X + (T + 0.2) / 2, NECK[0] - 0.1, NECK[1] + 0.1)
    return body


# ============================================================================== 3D placement
def plate3d(face, z0):
    return Pos(0, 0, z0) * extrude(face, amount=T, dir=(0, 0, 1))


def fin3d(face, x):
    """A fin drawn in (y, z) placed at x, T thick, centred on x."""
    pl = Plane(origin=(x - T / 2, 0, 0), x_dir=(0, 1, 0), z_dir=(1, 0, 0))
    # a fixed direction: a face built from several pieces may have some wound the other way
    return extrude(pl * face, amount=T, dir=(1, 0, 0))


def ear3d(face):
    """The ear drawn in (x, z), lying at EAR_Y, T thick upward."""
    pl = Plane(origin=(0, EAR_Y, 0), x_dir=(1, 0, 0), z_dir=(0, -1, 0))
    return extrude(pl * face, amount=T, dir=(0, 1, 0))


def parts_2d():
    parts = _parts_2d()
    for name, face in parts.items():                 # every part must cut as one piece
        n = len(face.faces())
        if n != 1:
            raise SystemExit(f"{name} would cut as {n} separate pieces")
    return parts


def _parts_2d():
    return {
        "front-plate": front_plate_2d(),
        "back-plate": back_plate_2d(),
        "lug": lug_2d(),
        "stem": stem_2d(),
        "ear": ear_2d(),
    }


QTY = {"front-plate": 1, "back-plate": 1, "lug": 2, "stem": 1, "ear": 1}


def assembly(p2):
    a = {
        "front-plate": plate3d(p2["front-plate"], FRONT_Z0),
        "back-plate": plate3d(p2["back-plate"], BACK_Z0),
        "stem": fin3d(p2["stem"], HS_X),
        "ear": ear3d(p2["ear"]),
    }
    for i, lx in enumerate(LUG_X):
        a[f"lug-{i + 1}"] = fin3d(p2["lug"], lx)
    return a


def lips3d():
    """The two lips on the ear's prong tips (short M3 standoffs), part of the rocker."""
    return [Pos(HS_X + sg * LIP_X, EAR_Y + T, LIP_Z) * Rot(-90, 0, 0)
            * Cylinder(POST_D / 2, LIP_L, align=(Align.CENTER, Align.CENTER, Align.MIN)) for sg in (-1, 1)]


def rests3d():
    """The two rests under the mouthpiece (M3 standoffs standing on the front plate)."""
    return [Pos(x, y, FRONT_Z1) * Cylinder(POST_D / 2, FRONT_GAP, align=(Align.CENTER, Align.CENTER, Align.MIN))
            for x, y in RESTS]


def hardware3d():
    """Standoffs, spacers and screws, for checks and renders (not cut)."""
    h = {}
    for x, y in COLUMNS:
        h[f"column {x:.0f},{y:.0f}"] = Pos(x, y, BACK_Z1) * Cylinder(3.0, COLUMN, align=(Align.CENTER, Align.CENTER, Align.MIN))
    for x, y in F.HOLES:
        h[f"spacer {x:.0f}"] = Pos(x, board_y(y), 0) * Cylinder(3.0, PLATE_GAP, align=(Align.CENTER, Align.CENTER, Align.MIN))
    x0, x1 = min(LUG_X) - 4.0, max(LUG_X) + 4.0
    h["pivot screw"] = Pos((x0 + x1) / 2, PIVOT[0], PIVOT[1]) * Rot(0, 90, 0) * Cylinder(1.5, x1 - x0)
    h["lock screw"] = Pos(HS_X, lock_y(), PIVOT[1]) * Rot(0, 90, 0) * Cylinder(1.5, 8.0)
    for i, p in enumerate(lips3d()):
        h[f"lip {i + 1}"] = p
    for i, p in enumerate(rests3d()):
        h[f"rest {i + 1}"] = p
    return h


def board3d():
    """A stand-in board: PCB, switch bodies, keycaps, the display module (for checks)."""
    from build123d import Align
    b = Pos(F.BOARD_W / 2, F.BOARD_H / 2, -F.BOARD_T) * Box(F.BOARD_W, F.BOARD_H, F.BOARD_T, align=(Align.CENTER, Align.CENTER, Align.MIN))
    caps = []
    for x, y, _ in F.SWITCHES:
        yy = board_y(y)
        b += Pos(x, yy, 0) * Box(14.0, 14.0, F.MX_HOUSING_TOP, align=(Align.CENTER, Align.CENTER, Align.MIN))
        caps.append(Pos(x, yy, KEYCAP_TOP - KEYCAP_H) * Box(KEYCAP, KEYCAP, KEYCAP_H, align=(Align.CENTER, Align.CENTER, Align.MIN)))
    (mx, my, mw, mh), _ = F.display()
    b += Pos(mx, my, P.STANDOFF_L) * Box(mw, mh, P.MODULE_PCB_T + 1.2, align=(Align.CENTER, Align.CENTER, Align.MIN))
    return b, caps


def handset3d():
    """The handset hanging earpiece up, its back toward the wall, the cup on the ear's prongs."""
    hs = HS.build()
    # handset.py builds it lying along y (earpiece at +y) with its cups' rims on z = 0.
    return Pos(HS_X, CUP_Y - (HS.LENGTH / 2 - CUP_R), HS_BASE_Z) * hs


SHEET = (380.0, 190.0)     # one sheet holds every part (checked)
GAP = 4.0                  # between parts (the laser's kerf is ~0.2)


def sheet_layout(p2):
    """Every part, in its quantity, on one SHEET: the two plates side by side, the rocker's parts
    and the lugs in a row under them."""
    def at(face, x, y):
        b = face.bounding_box()
        return Pos(x - b.min.X, y - b.min.Y) * face

    placed, x = [], 5.0
    for name in ("front-plate", "back-plate"):
        placed.append((name, at(p2[name], x, 5.0)))
        x += BODY[1] - BODY[0] + GAP
    x, y = 5.0, 5.0 + BODY[3] - BODY[2] + GAP
    for n in ("ear", "stem", "lug", "lug"):
        placed.append((n, at(p2[n], x, y)))
        x += p2[n].bounding_box().size.X + GAP
    return placed


def check_sheet(placed):
    """Every part on the sheet and none overlapping (in 2D)."""
    bad = []
    for name, f in placed:
        b = f.bounding_box()
        if b.min.X < 0 or b.min.Y < 0 or b.max.X > SHEET[0] or b.max.Y > SHEET[1]:
            bad.append(f"{name} is off the sheet")
    for i, (n1, f1) in enumerate(placed):
        for n2, f2 in placed[i + 1:]:
            hit = f1 & f2
            if hit.area > 0.01:
                bad.append(f"{n1} and {n2} overlap")
    if bad:
        raise SystemExit("sheet layout:\n  " + "\n  ".join(bad))


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    p2 = parts_2d()
    for name, face in p2.items():
        dxf = ExportDXF()
        dxf.add_shape(face)
        dxf.write(str(OUT / f"{name}.dxf"))
        svg = ExportSVG(scale=1.0)
        svg.add_shape(face)
        svg.write(str(OUT / f"{name}.svg"))
    placed = sheet_layout(p2)
    check_sheet(placed)
    sheet = placed[0][1]
    for _, f in placed[1:]:
        sheet += f
    dxf = ExportDXF()
    dxf.add_shape(sheet)
    dxf.write(str(OUT / "flatcase-sheet.dxf"))
    svg = ExportSVG(scale=1.0)
    svg.add_shape(sheet)
    svg.write(str(OUT / "flatcase-sheet.svg"))
    print(f"sheet: every part on one {SHEET[0]:.0f} x {SHEET[1]:.0f} mm sheet of {T:g} mm acrylic")
    a = assembly(p2)
    for name, part in a.items():
        export_stl(part, str(OUT / f"{name}.stl"), tolerance=0.02, angular_tolerance=0.15)
    print("parts:", ", ".join(f"{n} x{QTY[n]}" for n in p2))
    bb = a["front-plate"].bounding_box()
    print(f"front plate {bb.size.X:.0f} x {bb.size.Y:.0f} mm; stack {FRONT_Z1 - BACK_Z0:.1f} mm deep; "
          f"keycaps {KEYCAP_TOP - FRONT_Z1:.1f} mm over the plate")
    check_stack()
    check_hook(a)


def check_hook(a):
    """The switchhook: the handset hangs clear of everything, the lips and rests hold it, the
    stem rests on the hook key, the pressed rocker hits nothing, and the forces on the key."""
    from build123d import CenterOf
    board, caps = board3d()
    hs = handset3d()
    hook_i = [lab for *_, lab in F.SWITCHES].index("HOOK")
    lips, rests = lips3d(), rests3d()
    hw = hardware3d()

    def vol(x, y):
        try:
            return (x & y).volume
        except Exception:
            return 0.0

    bad = []
    fixed = {n: p for n, p in a.items() if n not in ("stem", "ear")}
    for n, p in [*a.items(), *(("lip", p) for p in lips), *(("rest", p) for p in rests),
                 ("board", board), *(("keycap", c) for c in caps)]:
        if vol(hs, p) > 0.01:
            bad.append(f"the handset runs into the {n}")
    if not all(vol(Pos(0, 0, -1.0) * p, hs) > 0 for p in lips):
        bad.append("the lips aren't within 1 mm of the earpiece cup")
    if not all(vol(Pos(0, 0, 0.5) * p, hs) > 0 for p in rests):
        bad.append("the rests don't reach the mouthpiece cup's back")
    ty, tz = stem_tip()
    probe = Pos(HS_X, ty, KEYCAP_TOP + 4.0) * Box(10, 20, 8)
    tip_low = (a["stem"] & probe).bounding_box().min.Z
    if abs(tip_low - KEYCAP_TOP) > 0.05:
        bad.append(f"the stem's tip is {tip_low - KEYCAP_TOP:+.2f} mm off the hook key's cap")
    rocker = [a["stem"], a["ear"], *lips]
    lever = PIVOT[0] - ty
    ang = math.degrees(math.atan2(4.0, lever))     # the key at the bottom of its travel
    axis = Axis((HS_X, PIVOT[0], PIVOT[1]), (1, 0, 0))
    pressed = [r.rotate(axis, ang) for r in rocker]
    if (pressed[0] & probe).bounding_box().min.Z > tip_low:
        pressed = [r.rotate(axis, -ang) for r in rocker]
    others = [*fixed.values(), board, *rests, *(c for i, c in enumerate(caps) if i != hook_i),
              *(h for n, h in hw.items() if n.startswith("column"))]
    if any(vol(r, o) > 0.01 for r in pressed for o in others):
        bad.append("the pressed rocker runs into something")
    # Forces. The cup bears on the prongs; the handset's centre of mass is further out, so its
    # bottom leans on the rests and its top pushes the lips outward.
    seat = Pos(0, -0.4, 0) * hs & a["ear"]
    seat_z = seat.center(CenterOf.MASS).Z if seat.volume > 0 else HS_BASE_Z
    com = hs.center(CenterOf.MASS)
    w = HANDSET_G
    lean = max(0.0, w * (com.Z - seat_z) / ((EAR_Y + T) - RESTS[0][1]))
    torque = w * (seat_z - PIVOT[1]) + lean * (EAR_Y + T + LIP_L / 2 - PIVOT[0])
    on = torque / lever
    acrylic = 1.19e-3                                # g per mm3
    own = 0.0
    for r in rocker[:2]:
        c = r.center(CenterOf.MASS)
        own += r.volume * acrylic * (c.Z - PIVOT[1])
    own += 2 * 1.5 * (LIP_Z - PIVOT[1])              # two short steel standoffs
    own /= lever
    lo, hi = HOOK_SPRING_GF
    if on < hi:
        bad.append(f"the handset presses the hook key with only {on:.0f} gf (want >= {hi:.0f})")
    if own > lo:
        bad.append(f"the empty rocker presses the key with {own:.0f} gf: it would stay down")
    if bad:
        raise SystemExit("switchhook:\n  " + "\n  ".join(bad))
    print(f"switchhook: handset ({w:.0f} g) on: {on:.0f} gf on the hook key, empty: {own:.0f} gf "
          f"(key: {lo:.0f}-{hi:.0f}); pressed rocker clear; the cup sits {seat_z - PIVOT[1]:.0f} mm "
          f"out from the pivot; handset's back {HS_BASE_Z - KEYCAP_TOP:.0f} mm over the caps")


def check_stack():
    """The heights that make the switch plate work (board top = 0)."""
    rim = KEYCAP_TOP - KEYCAP_H - F.MX_TRAVEL          # a cap's rim with the key at the bottom
    spacer = P.STANDOFF_L - FRONT_Z1
    bad = []
    if rim - FRONT_Z1 < 0.5:
        bad.append(f"a pressed keycap's rim comes {rim - FRONT_Z1:.1f} mm from the plate (want >= 0.5)")
    if UNDER_BOARD > -8.0:
        bad.append(f"only {-UNDER_BOARD:.1f} mm under the board for the jack's plug (want >= 8)")
    if abs(spacer - round(spacer)) > 1e-6:
        bad.append(f"the display's M2 spacer would be {spacer:.2f} mm (not a stock length)")
    if bad:
        raise SystemExit("stack:\n  " + "\n  ".join(bad))
    print(f"stack: pressed caps clear the plate by {rim - FRONT_Z1:.1f} mm; {-UNDER_BOARD:.1f} mm under "
          f"the board; display on {spacer:.0f} mm M2 spacers")


if __name__ == "__main__":
    main()
