"""The flat-cut case: a laser-cut desk phone for the minimal board, with the core shell's cradle.

Every part is cut from one sheet of 3 mm acrylic (or plywood) and held with M3 standoffs,
screws and nuts. Layers, top to bottom: the front plate, which is the switch plate (each switch
stands in its own 14 mm opening, the keycaps float above it and the display module stands over
it on its socket), the board hung 2 mm under it, and the back plate on four rubber feet.

The cradle works like the core shell's (proto_box.py): one arm, hinged at the rear-left on an M3
screw between two ears, its round foot on the hook key's cap. The handset lies front to back in
two V catches on the arm; its weight presses the hook key. Lift it and the key's own spring
raises the arm. The arm is a ladder: two fins joined by the two catches (halving joints).

    .venv/bin/python flatcase.py [--render]   # build/flatcase/: cut files (DXF, SVG), STL, PNG

Coordinates: the board's, x right, y toward the rear (the rear edge carries USB-C and the
handset jack), z = 0 the board's top surface, up.
"""
from __future__ import annotations

import argparse
import math
from pathlib import Path

from build123d import (
    Align,
    Axis,
    Box,
    Circle,
    CenterOf,
    Cylinder,
    ExportDXF,
    ExportSVG,
    Plane,
    Polygon,
    Pos,
    Rectangle,
    RectangleRounded,
    Rot,
    export_stl,
    extrude,
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
# hangs under it on four 2 mm spacers. Only the piezo and the display socket (and on the wired
# board the RJ45 and the PoE module) stand up from the board's top; the USB-C, the ESP32, the
# jack and the hot-swap sockets are on the bottom.
PLATE_GAP = 2.0            # M3 spacers, board top to plate (button-head screws fit under it)
COLUMN = 12.0              # M3 standoffs, back plate to front plate, outside the board
SWITCH_HOLE = 14.0         # the MX plate opening (Gateron KS-8 and other MX-size switches)
KEYCAP, KEYCAP_H = P.KEYCAP, P.KEYCAP_H          # clear XDA 1u caps, as the prototype box
FRONT_Z0 = PLATE_GAP                             # front plate's underside (board top = 0)
FRONT_Z1 = FRONT_Z0 + T                          # 5.0: the switches' plate line
KEYCAP_TOP = FRONT_Z1 + P.CAP_TOP                # cap tops over the board (the box's estimate)
BACK_Z1 = FRONT_Z0 - COLUMN                      # back plate's top face
BACK_Z0 = BACK_Z1 - T
UNDER_BOARD = BACK_Z1 + F.BOARD_T                # 8.4 below the board: the jack's plug and leads
FOOT_D, FOOT_H = 12.7, 3.5                       # self-adhesive rubber feet under the back plate
FEET = [(8.0, 2.0), (148.0, 2.0), (8.0, 86.0), (148.0, 86.0)]

PIEZO_HOLE = 13.4          # the piezo (12.2 across, 6.5 tall) stands 1.5 mm out of the plate
M3 = 3.4                   # clearance hole
M3_PIN = 3.2               # the hinge pin's hole in the ears: a close fit, so the arm doesn't wobble
M2 = 2.4
HOOK_KEY = next((x, F.Y(y)) for x, y, lab in F.SWITCHES if lab == "HOOK")
PIEZO = (P.BZ1_C[0], F.Y(P.BZ1_C[1]))

# --- outline: the board and a margin, like the core faceplate --------------------------------
MARGIN = 10.0              # plate beyond the board
R_CORNER = 10.0
BODY = (-MARGIN, F.BOARD_W + MARGIN, -MARGIN, F.BOARD_H + MARGIN)
COLUMNS = [(-5.0, -5.0), (F.BOARD_W + 5.0, -5.0), (F.BOARD_W + 5.0, F.BOARD_H + 5.0),
           (-5.0, F.BOARD_H + 5.0), (40.0, F.BOARD_H + 5.0)]   # outside the board and the plugs
# the wired board (v0.901): the RJ45 and the PoE module stand 13.3 / 8.5 mm on the board's top
# at its right end, under a notch in the front plate; the RJ45's mouth faces right
NOTCH = (P.HOOD[0], F.Y(P.HOOD[2]), F.Y(P.HOOD[1])) if P.NETWORK else None   # x0, y0, y1

# --- the cradle: as the core shell's (proto_box.cradle_geom), cut flat --------------------------
LX, FY = HOOK_KEY          # the arm runs front to back over the hook key
HINGE_Y = P.HINGE_Y - (P.GAP + P.WALL)            # 56.5: the pin, rear-left, in front of the piezo
HZ = KEYCAP_TOP + 7.0      # the pin's height
FOOT_R = P.FOOT_D / 2      # the fins' round ends on the hook key's cap
FIN_X = (P.ARM_W - T) / 2  # the two fins either side of the arm's centreline (12 mm over both)
EAR_GAP = 0.3              # fin to ear
EAR_X = FIN_X + T + EAR_GAP                       # the ears' centres either side of the centreline
EAR_Y = (45.0, 66.0)       # the ears' feet on the front plate
EAR_TAB = (55.0, 64.0)     # their tabs through it
EAR_SCREW = 50.5           # y of each ear's T-slot screw, from under the plate
HUB_R = 6.0
CATCH_Y = (26.0, 42.0)     # the two catches, between the key rows (clear of every key)
V_OPEN, V_WALL = 46.0, 4.0                        # 90 degree V, 46 mm across the top
APEX = 38.0                # the V's bottom
CATCH_Z0 = HZ - 1.0        # the catches' underside
POST_TOP = APEX - 2.0      # the fins' posts under the catches (the halving joints)
JOINT = (CATCH_Z0 + POST_TOP) / 2                 # where the two slots meet
POST_W = 10.0
SLOT = T + 0.2             # the slots for 3 mm parts: tabs and halving joints
HANDSET_G = 180.0          # MEASURE: your handset's weight
HOOK_SPRING_GF = (30.0, 60.0)    # a linear MX switch: at the top of travel and at the bottom
ACRYLIC = 1.19e-3          # g per mm3 (plywood is about half)
HS_CLEAR = 2.0             # the handset over everything but the catches (key down)
ARM_CLEAR = 0.2            # the arm over everything (key down), the ears 0.3 beside it
FINGER = 12.0              # the middle of a keycap a finger presses: nothing over it
MAX_COVERED = 2            # keys the handset may hang over (besides the hook key)


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
    stands up through, one for the display's socket, one over the status light, the board's
    four screws, and the ears' tabs and screws."""
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
    for sg in (-1, 1):                                # the ears' tabs and T-slot screws
        ex = LX + sg * EAR_X
        s -= rect(ex - SLOT / 2, ex + SLOT / 2, EAR_TAB[0] - 0.1, EAR_TAB[1] + 0.1)
        s -= Pos(ex, EAR_SCREW) * Circle(M3 / 2)
    if NOTCH:                                         # the RJ45 and PoE module, open to the right
        x0, y0, y1 = NOTCH
        s -= rect(x0, BODY[1] + 1.0, y0, y1)
    return s


def back_plate_2d():
    s = outline()
    for x, y in COLUMNS:
        s -= Pos(x, y) * Circle(M3 / 2)
    for x, y, _ in P.BUTTONS:                        # pinholes for RESET and BOOT
        s -= Pos(x, board_y(y)) * Circle(1.0)
    return s


# ============================================================================== cradle (flat parts)
def poly(points):
    """A polygon, always counter-clockwise: a clockwise one faces the other way, won't merge with
    the rest of a part and extrudes backwards."""
    area = sum(x0 * y1 - x1 * y0 for (x0, y0), (x1, y1) in zip(points, points[1:] + points[:1]))
    return Polygon(*(points if area > 0 else points[::-1]), align=None)


def t_slot(u, v, toward=(0.0, -1.0), depth=10.0):
    """A T-slot for an M3 screw and nut, cut into a part's edge at (u, v), going `toward`."""
    du, dv = toward
    pu, pv = -dv, du   # perpendicular
    shaft = poly([(u + pu * 1.6, v + pv * 1.6), (u - pu * 1.6, v - pv * 1.6),
                  (u - pu * 1.6 + du * depth, v - pv * 1.6 + dv * depth),
                  (u + pu * 1.6 + du * depth, v + pv * 1.6 + dv * depth)])
    nu, nv = u + du * (depth - 4.5), v + dv * (depth - 4.5)
    nut = poly([(nu + pu * 2.9 - du * 1.3, nv + pv * 2.9 - dv * 1.3), (nu - pu * 2.9 - du * 1.3, nv - pv * 2.9 - dv * 1.3),
                (nu - pu * 2.9 + du * 1.3, nv - pv * 2.9 + dv * 1.3), (nu + pu * 2.9 + du * 1.3, nv + pv * 2.9 + dv * 1.3)])
    return shaft + nut


def bar(p0, p1, w):
    """A straight bar of width w from p0 to p1 with rounded ends."""
    (u0, v0), (u1, v1) = p0, p1
    L = math.hypot(u1 - u0, v1 - v0)
    pu, pv = -(v1 - v0) / L * w / 2, (u1 - u0) / L * w / 2
    body = poly([(u0 + pu, v0 + pv), (u1 + pu, v1 + pv), (u1 - pu, v1 - pv), (u0 - pu, v0 - pv)])
    return body + Pos(u0, v0) * Circle(w / 2) + Pos(u1, v1) * Circle(w / 2)


def foot_centre():
    """(y, z) of the fins' round ends, resting on the hook key's cap."""
    return FY, KEYCAP_TOP + FOOT_R


def ear_2d():
    """A hinge ear (u = y, v = z): a tab through the front plate, a T-slot for the screw that
    holds it down, and the pin's hole at the top."""
    z0 = FRONT_Z1
    body = poly([(EAR_Y[0], z0), (EAR_Y[1], z0), (EAR_Y[1], z0 + 12.0), (HINGE_Y + HUB_R, HZ),
                 (HINGE_Y - HUB_R, HZ), (EAR_Y[0], z0 + 12.0)])
    body += Pos(HINGE_Y, HZ) * Circle(HUB_R)
    body += rect(*EAR_TAB, FRONT_Z0, z0 + 1.0)        # flush with the plate's underside
    body -= Pos(HINGE_Y, HZ) * Circle(M3_PIN / 2)
    body -= t_slot(EAR_SCREW, z0, toward=(0.0, 1.0))
    return body


def fin_2d():
    """One of the arm's two fins (u = y, v = z): the round foot on the hook key's cap, the hub
    round the pin, and a post under each catch with the halving joint's slot."""
    body = bar(foot_centre(), (HINGE_Y, HZ), 2 * FOOT_R)
    body += Pos(HINGE_Y, HZ) * Circle(HUB_R)
    for cy in CATCH_Y:
        body += rect(cy - POST_W / 2, cy + POST_W / 2, KEYCAP_TOP + FOOT_R, POST_TOP)
        body -= rect(cy - SLOT / 2, cy + SLOT / 2, JOINT, POST_TOP + 1.0)
    body -= Pos(HINGE_Y, HZ) * Circle(M3 / 2)         # turns freely on the pin
    return body


def catch_2d():
    """A catch (u = x, v = z): a 90 degree V for the handset's handle, with two slots from below
    that take the fins."""
    h = V_OPEN / 2
    x0, x1, top = LX - h - V_WALL, LX + h + V_WALL, APEX + h
    body = poly([(x0, CATCH_Z0), (x1, CATCH_Z0), (x1, top), (LX + h, top), (LX, APEX),
                 (LX - h, top), (x0, top)])
    for sg in (-1, 1):
        fx = LX + sg * FIN_X
        body -= rect(fx - SLOT / 2, fx + SLOT / 2, CATCH_Z0 - 1.0, JOINT)
    return body


# ============================================================================== 3D placement
def plate3d(face, z0):
    return Pos(0, 0, z0) * extrude(face, amount=T, dir=(0, 0, 1))


def fin3d(face, x):
    """A part drawn in (y, z) placed at x, T thick, centred on x."""
    pl = Plane(origin=(x - T / 2, 0, 0), x_dir=(0, 1, 0), z_dir=(1, 0, 0))
    # a fixed direction: a face built from several pieces may have some wound the other way
    return extrude(pl * face, amount=T, dir=(1, 0, 0))


def catch3d(face, y):
    """A part drawn in (x, z) placed at y, T thick, centred on y."""
    pl = Plane(origin=(0, y - T / 2, 0), x_dir=(1, 0, 0), z_dir=(0, -1, 0))
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
        "fin": fin_2d(),
        "catch": catch_2d(),
        "ear": ear_2d(),
    }


QTY = {"front-plate": 1, "back-plate": 1, "fin": 2, "catch": 2, "ear": 2}
ARM = ("fin-1", "fin-2", "catch-1", "catch-2")   # the moving part


def assembly(p2):
    a = {
        "front-plate": plate3d(p2["front-plate"], FRONT_Z0),
        "back-plate": plate3d(p2["back-plate"], BACK_Z0),
    }
    for i, sg in enumerate((-1, 1)):
        a[f"ear-{i + 1}"] = fin3d(p2["ear"], LX + sg * EAR_X)
        a[f"fin-{i + 1}"] = fin3d(p2["fin"], LX + sg * FIN_X)
    for i, cy in enumerate(CATCH_Y):
        a[f"catch-{i + 1}"] = catch3d(p2["catch"], cy)
    return a


def hardware3d():
    """Standoffs, spacers, screws and feet, for checks and renders (not cut)."""
    h = {}
    for x, y in COLUMNS:
        h[f"column {x:.0f},{y:.0f}"] = Pos(x, y, BACK_Z1) * Cylinder(3.0, COLUMN, align=(Align.CENTER, Align.CENTER, Align.MIN))
    for x, y in F.HOLES:
        h[f"spacer {x:.0f}"] = Pos(x, board_y(y), 0) * Cylinder(3.0, PLATE_GAP, align=(Align.CENTER, Align.CENTER, Align.MIN))
        h[f"board screw {x:.0f}"] = Pos(x, board_y(y), FRONT_Z1) * Cylinder(2.85, 1.65, align=(Align.CENTER, Align.CENTER, Align.MIN))
    for x, y in FEET:
        h[f"foot {x:.0f},{y:.0f}"] = Pos(x, y, BACK_Z0) * Cylinder(FOOT_D / 2, FOOT_H, align=(Align.CENTER, Align.CENTER, Align.MAX))
    return h


def pin3d():
    """The hinge pin: an M3 screw through both ears and both fins, a nyloc nut on the far side."""
    span = 2 * (EAR_X + T / 2)
    return Pos(LX - span / 2 - 2.0, HINGE_Y, HZ) * Rot(0, 90, 0) * Cylinder(1.5, span + 6.0, align=(Align.CENTER, Align.CENTER, Align.MIN))


def board3d():
    """A stand-in board: PCB, switch bodies, piezo, display module (and the RJ45 and the PoE
    module on the wired board); and the keycaps (for checks)."""
    b = Pos(F.BOARD_W / 2, F.BOARD_H / 2, -F.BOARD_T) * Box(F.BOARD_W, F.BOARD_H, F.BOARD_T, align=(Align.CENTER, Align.CENTER, Align.MIN))
    caps = {}
    for x, y, lab in F.SWITCHES:
        yy = board_y(y)
        b += Pos(x, yy, 0) * Box(14.0, 14.0, F.MX_HOUSING_TOP, align=(Align.CENTER, Align.CENTER, Align.MIN))
        caps[lab] = Pos(x, yy, KEYCAP_TOP - KEYCAP_H) * Box(KEYCAP, KEYCAP, KEYCAP_H, align=(Align.CENTER, Align.CENTER, Align.MIN))
    b += Pos(*PIEZO, 0) * Cylinder(P.BZ1_D / 2, P.BZ1_H, align=(Align.CENTER, Align.CENTER, Align.MIN))
    (mx, my, mw, mh), _ = F.display()
    b += Pos(mx, my, P.STANDOFF_L) * Box(mw, mh, P.MODULE_PCB_T + 1.2, align=(Align.CENTER, Align.CENTER, Align.MIN))
    if NOTCH:
        jx, jy = P.J4_AT[0], board_y(P.J4_AT[1])
        b += Pos(P.RJ45_FRONT - P.RJ45_D / 2, jy, 0) * Box(P.RJ45_D, P.RJ45_W, P.RJ45_H, align=(Align.CENTER, Align.CENTER, Align.MIN))
        x0, by0, x1, by1 = P.PS1_BODY
        b += Pos((x0 + x1) / 2, board_y((by0 + by1) / 2), 0) * Box(x1 - x0, by1 - by0, P.PS1_H, align=(Align.CENTER, Align.CENTER, Align.MIN))
    return b, caps


def handset_on(catches):
    """The handset lying front to back in the catches, earpiece to the rear: lowered until it
    touches them."""
    hs = HS.build()                                  # lying on its cups along y, cups' base at z = 0
    yc = sum(CATCH_Y) / 2
    z = APEX + 60.0
    for _ in range(60):
        d = min((Pos(LX, yc, z) * hs).distance_to(c) for c in catches)
        if d < 0.005:
            break
        z -= d
    return Pos(LX, yc, z) * hs


SHEET = (380.0, 160.0)     # one sheet holds every part (checked)
GAP = 4.0                  # between parts (the laser's kerf is ~0.2)


def sheet_layout(p2):
    """Every part, in its quantity, on one SHEET: the two plates side by side, the cradle's parts
    in a row under them."""
    def at(face, x, y):
        b = face.bounding_box()
        return Pos(x - b.min.X, y - b.min.Y) * face

    placed, x = [], 5.0
    for name in ("front-plate", "back-plate"):
        placed.append((name, at(p2[name], x, 5.0)))
        x += BODY[1] - BODY[0] + GAP
    x, y = 5.0, 5.0 + BODY[3] - BODY[2] + GAP
    for n in ("fin", "fin", "catch", "catch", "ear", "ear"):
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
    ap = argparse.ArgumentParser()
    ap.add_argument("--render", action="store_true", help="also write build/flatcase/assembled.png")
    args = ap.parse_args()
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
    check_stack()
    hs, pressed = check_cradle(a)
    bb = a["front-plate"].bounding_box()
    top = max(hs.bounding_box().max.Z, KEYCAP_TOP)
    print(f"size: {bb.size.X:.0f} x {bb.size.Y:.0f} mm, {top - (BACK_Z0 - FOOT_H):.0f} mm tall with the "
          f"handset on ({KEYCAP_TOP - (BACK_Z0 - FOOT_H):.0f} to the keycaps' tops)")
    if args.render:
        render(a, hs, pressed)


def check_cradle(a):
    """The cradle: the foot on the hook key's cap, the handset in the catches and clear of the
    rest, the arm with the key pressed clear of everything, the forces on the key, and the keys
    the handset leaves free reachable. Returns the handset and the arm, key pressed."""
    board, caps = board3d()
    hw = hardware3d()
    bad = []

    # the foot on the cap, key up
    fy, _ = foot_centre()
    probe = Pos(LX, fy, KEYCAP_TOP + 4.0) * Box(2 * FIN_X + T + 2.0, 2 * FOOT_R + 4.0, 8.0)
    lows = [(a[f] & probe).bounding_box().min.Z for f in ("fin-1", "fin-2")]
    for low in lows:
        if abs(low - KEYCAP_TOP) > 0.05:
            bad.append(f"a fin's foot is {low - KEYCAP_TOP:+.2f} mm off the hook key's cap")

    # the arm with the hook key at the bottom of its travel, and the handset on it
    lever = HINGE_Y - fy
    ang = math.degrees(math.asin(F.MX_TRAVEL / lever))
    axis = Axis((LX, HINGE_Y, HZ), (1, 0, 0))
    pressed = {n: a[n].rotate(axis, ang) for n in ARM}
    if (pressed["fin-1"] & probe).bounding_box().min.Z > lows[0]:
        ang = -ang
        pressed = {n: a[n].rotate(axis, ang) for n in ARM}
    hs = handset_on([a["catch-1"], a["catch-2"]]).rotate(axis, ang)
    hook_down = Pos(0, 0, -F.MX_TRAVEL) * caps["HOOK"]
    fixed = {n: p for n, p in a.items() if n not in ARM}
    fixed.update({"board": board, "pin": pin3d(), **{f"{k} keycap": c for k, c in caps.items() if k != "HOOK"},
                  **{n: h for n, h in hw.items() if not n.startswith("foot")}})

    seats = [hs.distance_to(pressed[c]) for c in ("catch-1", "catch-2")]
    if max(seats) > 0.02:
        bad.append(f"the handset doesn't sit in both catches ({seats[0]:.2f}, {seats[1]:.2f} mm off)")
    near = min(((hs.distance_to(p), n) for n, p in [*fixed.items(), ("hook keycap", hook_down),
                                                    ("fin-1", pressed["fin-1"]), ("fin-2", pressed["fin-2"])]))
    if near[0] < HS_CLEAR:
        bad.append(f"the handset comes {near[0]:.1f} mm from the {near[1]} (want >= {HS_CLEAR:g})")

    arm_near = min(((pressed[r].distance_to(p), n, r) for r in ARM for n, p in fixed.items() if n != "pin"))
    if arm_near[0] < ARM_CLEAR:
        bad.append(f"the pressed {arm_near[2]} comes {arm_near[0]:.2f} mm from the {arm_near[1]}")

    # forces: torques about the pin, key down; the foot's lever is the same both ways
    com = hs.center(CenterOf.MASS)
    on_hs = HANDSET_G * (HINGE_Y - com.Y) / lever
    own = sum(pressed[r].volume * ACRYLIC * (HINGE_Y - pressed[r].center(CenterOf.MASS).Y) for r in ARM) / lever
    lo, hi = HOOK_SPRING_GF
    if on_hs + own < hi:
        bad.append(f"the handset presses the hook key with only {on_hs + own:.0f} gf (want >= {hi:.0f})")
    if own > lo:
        bad.append(f"the empty arm presses the key with {own:.0f} gf: it would stay down")

    # the keys the handset doesn't hang over: nothing over the middle of their caps
    covered, blocked = [], []
    cradle = [*pressed.values(), *(a[f"ear-{i}"] for i in (1, 2)), pin3d()]
    for x, y, lab in F.SWITCHES:
        if lab == "HOOK":
            continue
        yy = board_y(y)
        shadow = Pos(x, yy, KEYCAP_TOP) * Box(FINGER, FINGER, 300.0, align=(Align.CENTER, Align.CENTER, Align.MIN))
        if hs.distance_to(shadow) == 0:
            covered.append(lab)
        elif any(c.distance_to(shadow) == 0 for c in cradle):
            blocked.append(lab)
    if blocked:
        bad.append(f"the cradle is over key(s) {', '.join(blocked)}")
    if len(covered) > MAX_COVERED:
        bad.append(f"the handset hangs over {len(covered)} keys ({', '.join(covered)}; want <= {MAX_COVERED})")

    if bad:
        raise SystemExit("cradle:\n  " + "\n  ".join(bad))
    print(f"cradle: foot on the hook key's cap; handset ({HANDSET_G:.0f} g) on: {on_hs + own:.0f} gf on the "
          f"hook key, empty: {own:.0f} gf (key: {lo:.0f}-{hi:.0f}); the handset {near[0]:.1f} mm over the "
          f"{near[1]}; pressed arm {arm_near[0]:.1f} mm from the {arm_near[1]}; "
          f"{12 - len(covered)} of 12 keys free" + (f" (under the handset: {', '.join(covered)})" if covered else ""))
    return hs, pressed


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


def render(a, hs, pressed) -> None:
    """build/flatcase/assembled.png: the phone on its feet with the handset in the cradle."""
    from build123d import fillet
    board, _ = board3d()
    cap = Box(KEYCAP, KEYCAP, KEYCAP_H, align=(Align.CENTER, Align.CENTER, Align.MIN))
    cap = fillet(cap.edges().group_by(Axis.Z)[-1], 1.8)
    acrylic, arm = "#cfd8d6", "#9fb4b0"
    items = [(*P.mesh_of(a["front-plate"]), acrylic), (*P.mesh_of(a["back-plate"]), acrylic),
             (*P.mesh_of(board), "#2f6b3a"), (*P.mesh_of(hs), "#e9e3d3"), (*P.mesh_of(pin3d()), "#888888")]
    items += [(*P.mesh_of(a[f"ear-{i}"]), arm) for i in (1, 2)]
    items += [(*P.mesh_of(p), arm) for p in pressed.values()]
    for n, h in hardware3d().items():
        items.append((*P.mesh_of(h), "#222222" if n.startswith("foot") else "#b8b8b8"))
    for x, y, lab in F.SWITCHES:
        z = KEYCAP_TOP - KEYCAP_H - (F.MX_TRAVEL if lab == "HOOK" else 0.0)
        items.append((*P.mesh_of(Pos(x, board_y(y), z) * cap), "#3d4744"))
    P.raster(items, OUT / "assembled.png", elev=32, azim=-30, width=1800)
    print(f"render: {OUT / 'assembled.png'}")


if __name__ == "__main__":
    main()
