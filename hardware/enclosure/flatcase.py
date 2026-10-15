"""The flat-cut case: a laser-cut sandwich for the minimal board, a wall phone on a desk stand.

Every part is cut from one sheet of 3 mm acrylic (or plywood) and held with M3 standoffs,
screws and nuts. Layers, front to back: the front plate, which is the switch plate (each switch
stands in its own 14 mm opening, the keycaps float above it and the display module stands over
it on its socket), the board hung 2 mm under it, and the back plate. Standoffs outside the
board join the front and back plates. The handset hangs on a tower on the left, its centreline straight above the
hook key:

- its mouthpiece cup sits on the ledge of one rocker that turns on an M3 screw between two fixed
  ears, just above the hook key;
- the handset's weight tips the rocker, and the rocker's tail presses the hook key;
- the key's own spring lifts the tail back when the handset is picked up;
- a fixed J-hook at the top keeps the handset upright.

Two flat legs, slotted into the back plate, stand the phone up tilted back 25 degrees;
without them, two keyholes in the back plate hang it on a wall.

    .venv/bin/python flatcase.py            # build/flatcase/: cut files (DXF, SVG) and STL

Coordinates: the board's, x right, y up (the top edge carries USB-C and the handset jack),
z = 0 the board's top surface, +z toward the user.
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
KEYCAP, KEYCAP_H = 18.0, 10.0      # clear double-layer XDA 1u caps (18 mm square, 10 mm tall)
KEYCAP_TOP = 20.0          # cap tops over the board: MX stem top 16.6 + ~3.4 (measure yours)
FRONT_Z0 = PLATE_GAP                             # front plate's back face (board top = 0)
FRONT_Z1 = FRONT_Z0 + T                          # 5.0: the switches' plate line
BACK_Z1 = FRONT_Z0 - COLUMN                      # back plate's front face
BACK_Z0 = BACK_Z1 - T
UNDER_BOARD = BACK_Z1 + F.BOARD_T                # 8.4 below the board: the jack's plug and leads

PIEZO_HOLE = 13.4          # the piezo (12.2 across, 6.5 tall) stands 1.5 mm out of the plate
M3 = 3.4                   # clearance hole
M2 = 2.4
HOOK_KEY = next((x, F.Y(y)) for x, y, lab in F.SWITCHES if lab == "HOOK")

# --- the hook: one rocker, straight above the hook key -----------------------------------------
HS_X = HOOK_KEY[0]         # the handset's centreline runs through the hook key
AXLE_Y = HOOK_KEY[1] + 16.0                      # the rocker's screw, just above the hook key
AXLE_Z = KEYCAP_TOP + 5.5  # the tail runs out level to the hook key's cap
LEDGE_TOP = AXLE_Y + 5.0   # the mouthpiece cup sits on the rocker's ledge
LEDGE_REACH = 26.0         # forward from the screw, under the cup
CUP_R = HS.CUP_D / 2
HS_BASE_Z = AXLE_Z + 9.0   # the handset's back: its weight lands well in front of the screw
HS_LIFT = 0.0              # how far the domed cup rests above a flat rim's bottom (measured)
CUP_Y = LEDGE_TOP + CUP_R                         # the mouthpiece cup's centre
CUP_TOP = CUP_Y + HS_LIFT + 2 * (HS.LENGTH / 2 - CUP_R) + CUP_R   # the earpiece's top
LIP_Z = HS_BASE_Z + HS.CUP_H + 2.6                # in front of the earpiece's dome
EAR_X = (HS_X - T - 0.5, HS_X + T + 0.5)          # the two fixed ears either side of the rocker

# --- outline --------------------------------------------------------------------------------
MARGIN = 10.0              # plate beyond the board
R_CORNER = 8.0
BODY = (-MARGIN, F.BOARD_W + MARGIN, -MARGIN, F.BOARD_H + MARGIN)
TOWER_TOP = CUP_TOP + 20.0
TOWER = (HS_X - 40.0, HS_X + 40.0, -MARGIN, TOWER_TOP)   # the handset hangs on it
J_Y0 = CUP_TOP - 40.0      # the J-hook's foot on the tower

# --- columns: the body's corners and the tower's top -------------------------------------------
COLUMNS = [(-5.0, -5.0), (F.BOARD_W + 5.0, -5.0), (F.BOARD_W + 5.0, F.BOARD_H + 5.0),
           (TOWER[0] + 5.0, TOWER_TOP - 5.0), (TOWER[1] - 5.0, TOWER_TOP - 5.0),
           (TOWER[0] + 5.0, -5.0)]

# --- stand ----------------------------------------------------------------------------------
TILT = 25.0                # back from vertical (15 tips forward with the handset on)
LEG_X = (TOWER[0] + 10.0, F.BOARD_W - 10.0)
LEG_SPAN = (8.0, 90.0)     # along the back plate (y); both legs fit under the body's top
TAB = (12.0, T)            # tab length x thickness; slots are cut 0.2 bigger
CABLE_SLOT = (0.0, 32.0, F.BOARD_H + 2.0, F.BOARD_H + 8.0)   # USB-C and the cord out the back


def rect(x0, x1, y0, y1):
    return Pos((x0 + x1) / 2, (y0 + y1) / 2) * Rectangle(x1 - x0, y1 - y0)


def rrect(x0, x1, y0, y1, r):
    return Pos((x0 + x1) / 2, (y0 + y1) / 2) * RectangleRounded(x1 - x0, y1 - y0, r)


def outline():
    """The plates' shape: the body round the board and the tower the handset hangs on."""
    return rrect(*BODY, R_CORNER) + rrect(*TOWER, R_CORNER)


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
    bx, by = P.BZ1_C[0], board_y(P.BZ1_C[1])
    s -= Pos(bx, by) * Circle(PIEZO_HOLE / 2)          # the ringer stands through, open to the air
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
    for fx, ys in fin_slots_front():
        for y0, y1 in ys:
            s -= rect(fx - (T + 0.2) / 2, fx + (T + 0.2) / 2, y0 - 0.1, y1 + 0.1)
    for fx, y in fin_screws_front():
        s -= Pos(fx, y) * Circle(M3 / 2)
    return s


def back_plate_2d():
    s = outline()
    for x, y in COLUMNS:
        s -= Pos(x, y) * Circle(M3 / 2)
    for x, y, _ in P.BUTTONS:                        # pinholes for RESET and BOOT
        s -= Pos(x, board_y(y)) * Circle(1.0)
    for lx in LEG_X:                                  # the legs' tabs and screws
        for y0, y1 in leg_tab_spans():
            s -= rect(lx - (T + 0.2) / 2, lx + (T + 0.2) / 2, y0 - 0.1, y1 + 0.1)
        s -= Pos(lx, sum(LEG_SPAN) / 2) * Circle(M3 / 2)
    for x, y in ((HS_X, TOWER_TOP - 25.0), (F.BOARD_W - 20.0, F.BOARD_H - 10.0)):
        s -= keyhole(x, y)                            # hang it on a wall instead
    s -= rrect(*CABLE_SLOT, 2.0)                      # USB-C and the handset cord out the back
    return s


def keyhole(x, y):
    """A keyhole for a wall screw: head through the round part, slide down onto the neck."""
    return Pos(x, y) * Circle(4.5) + rrect(x - 2.0, x + 2.0, y - 10.0, y, 1.9)


# ============================================================================== fins (in y-z)
def fin_slots_front():
    """(x, [(y0, y1), ...]) of tab slots in the front plate for the fins standing on it."""
    out = []
    for ex in EAR_X:
        out.append((ex, [(AXLE_Y - 3.0, AXLE_Y + 7.0), (AXLE_Y + 14.0, AXLE_Y + 24.0)]))
    out.append((HS_X, [(J_Y0, J_Y0 + TAB[0]), (J_Y0 + 22.0, J_Y0 + 22.0 + TAB[0])]))
    return out


def fin_screws_front():
    out = [(ex, AXLE_Y + 10.5) for ex in EAR_X]
    out.append((HS_X, J_Y0 + 17.0))
    return out


def leg_tab_spans():
    a, b = LEG_SPAN
    return [(a + 5.0, a + 5.0 + TAB[0]), (b - 5.0 - TAB[0], b - 5.0)]


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


def ear_2d():
    """A fixed bearing fin (u = y, v = z): two tabs into the front plate, the axle hole on top."""
    z0 = FRONT_Z1
    # up to the screw; the handset hangs in front of it (its back is at HS_BASE_Z)
    body = poly([(AXLE_Y - 3.0, z0), (AXLE_Y + 24.0, z0), (AXLE_Y + 14.0, AXLE_Z + 4.5),
                 (AXLE_Y - 3.0, AXLE_Z + 4.5)])
    for y0, y1 in fin_slots_front()[0][1]:
        body += rect(y0, y1, z0 - T, z0 + 1.0)
    body -= Pos(AXLE_Y, AXLE_Z) * Circle(M3 / 2)        # the rocker's screw
    body -= t_slot(AXLE_Y + 10.5, z0, toward=(0.0, 1.0))
    return body


def bar(p0, p1, w):
    """A straight bar of width w from p0 to p1 with rounded ends."""
    (u0, v0), (u1, v1) = p0, p1
    L = math.hypot(u1 - u0, v1 - v0)
    pu, pv = -(v1 - v0) / L * w / 2, (u1 - u0) / L * w / 2
    body = poly([(u0 + pu, v0 + pv), (u1 + pu, v1 + pv), (u1 - pu, v1 - pv), (u0 - pu, v0 - pv)])
    return body + Pos(u0, v0) * Circle(w / 2) + Pos(u1, v1) * Circle(w / 2)


def rocker_2d():
    """The rocker (u = y, v = z), on one screw straight above the hook key: the mouthpiece cup
    sits on its ledge and its tail rests on the hook key's cap. Lift the handset and the key's
    spring pushes the tail up to the key's top, which leaves the ledge level."""
    tip_y, tip_z = HOOK_KEY[1] + 3.0, KEYCAP_TOP + 3.5     # the bar's round end rests on the cap
    ledge = poly([(AXLE_Y - 6.0, AXLE_Z - 6.0), (AXLE_Y - 6.0, AXLE_Z + LEDGE_REACH),
                  (LEDGE_TOP, AXLE_Z + LEDGE_REACH), (LEDGE_TOP, AXLE_Z - 6.0)])
    tail = bar((AXLE_Y, AXLE_Z), (tip_y, tip_z), 7.0)  # a straight bar to a rounded tip
    body = ledge + tail
    body -= Pos(AXLE_Y, AXLE_Z) * Circle(1.8)          # turns freely on the screw
    return body


def jhook_2d():
    """The J-hook at the top: an arm over the earpiece and a short lip in front of its dome, so
    the handset can't tip forward off the rocker."""
    z0 = FRONT_Z1
    arm_y0 = CUP_TOP + 2.0                            # just above the earpiece
    lip_y0 = CUP_TOP - 16.0                           # the dome is narrow up here (z < 57)
    lip_z1 = LIP_Z + 6.0
    foot = HS_BASE_Z - 1.0 - z0                       # the foot stays under the handset's back
    pts = [(J_Y0, z0), (arm_y0 + 8.0, z0), (arm_y0 + 8.0, lip_z1), (lip_y0, lip_z1),
           (lip_y0, LIP_Z), (arm_y0, LIP_Z), (arm_y0, z0 + foot), (J_Y0, z0 + foot)]
    body = poly(pts)
    for y0, y1 in fin_slots_front()[-1][1]:
        body += rect(y0, y1, z0 - T, z0 + 1.0)
    body -= t_slot(J_Y0 + 17.0, z0, toward=(0.0, 1.0))
    return body


def leg_2d():
    """A leg (u = y, v = z): a triangle behind the back plate, its foot flat on the desk."""
    a = math.radians(TILT)
    zb = BACK_Z0
    y0, y1 = LEG_SPAN
    # The phone rests on the back plate's bottom edge and the legs' feet. In the phone's frame
    # the desk is the line through (y = -MARGIN, z = zb) tilted by TILT: points on it satisfy
    # (y + MARGIN) * cos(a) + (z - zb) * sin(a) = 0 in world height.
    def on_desk(z):
        return -MARGIN - (z - zb) * math.tan(a)
    zf = zb - 110.0                                    # the foot reaches this far back
    pts = [(y0, zb), (y1, zb), (on_desk(zf) + 12.0, zf), (on_desk(zf), zf), (on_desk(zb - 20.0), zb - 20.0),
           (y0 - 2.0, zb - 10.0)]
    body = poly(pts)
    # a frame, not a sail: cut the inside out, leaving 10 mm struts
    inner = offset(body, amount=-10.0)
    inner -= rect(-500.0, 500.0, zb - 16.0, zb + 50.0)   # a wider top strut round the T-slot
    if inner.area > 100:
        body -= inner
    for t0, t1 in leg_tab_spans():
        body += rect(t0, t1, zb - 1.0, zb + T)        # overlaps the strut: one piece
    body -= t_slot(sum(LEG_SPAN) / 2, zb, toward=(0.0, -1.0))
    return body


# ============================================================================== 3D placement
def plate3d(face, z0):
    return Pos(0, 0, z0) * extrude(face, amount=T, dir=(0, 0, 1))


def fin3d(face, x):
    """A fin drawn in (y, z) placed at x, T thick, centred on x."""
    pl = Plane(origin=(x - T / 2, 0, 0), x_dir=(0, 1, 0), z_dir=(1, 0, 0))
    # a fixed direction: a face built from several pieces may have some wound the other way
    return extrude(pl * face, amount=T, dir=(1, 0, 0))


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
        "ear": ear_2d(),
        "rocker": rocker_2d(),
        "j-hook": jhook_2d(),
        "leg": leg_2d(),
    }


QTY = {"front-plate": 1, "back-plate": 1, "ear": 2, "rocker": 1, "j-hook": 1, "leg": 2}


def assembly(p2):
    a = {
        "front-plate": plate3d(p2["front-plate"], FRONT_Z0),
        "back-plate": plate3d(p2["back-plate"], BACK_Z0),
        "j-hook": fin3d(p2["j-hook"], HS_X),
        "rocker": fin3d(p2["rocker"], HS_X),
    }
    for i, ex in enumerate(EAR_X):
        a[f"ear-{i + 1}"] = fin3d(p2["ear"], ex)
    for i, lx in enumerate(LEG_X):
        a[f"leg-{i + 1}"] = fin3d(p2["leg"], lx)
    return a


def hardware3d():
    """Standoffs, the axle and a stand-in board, for checks and renders (not cut)."""
    h = {}
    for x, y in COLUMNS:
        h[f"column {x:.0f},{y:.0f}"] = Pos(x, y, BACK_Z1) * Cylinder(3.0, COLUMN, align=(Align.CENTER, Align.CENTER, Align.MIN))
    for x, y in F.HOLES:
        h[f"spacer {x:.0f}"] = Pos(x, board_y(y), 0) * Cylinder(3.0, PLATE_GAP, align=(Align.CENTER, Align.CENTER, Align.MIN))
    x0, x1 = min(EAR_X) - 4.0, max(EAR_X) + 4.0
    h["screw"] = Pos((x0 + x1) / 2, AXLE_Y, AXLE_Z) * Rot(0, 90, 0) * Cylinder(1.5, x1 - x0)
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
    """The handset hanging: axis along y through the hook key, its mouthpiece on the rocker."""
    from build123d import Rot as R
    hs = HS.build()
    # handset.py builds it lying along y with its cups' rims on z = 0, centred at the origin.
    return Pos(HS_X, CUP_Y + HS_LIFT + (HS.LENGTH / 2 - CUP_R), HS_BASE_Z) * hs


SHEET = (450.0, 300.0)     # one sheet holds every part (checked)
GAP = 4.0                  # between parts (the laser's kerf is ~0.2)


def sheet_layout(p2):
    """Every part, in its quantity, on one SHEET: the two plates side by side, a leg in each
    plate's empty corner (right of the tower, above the key body), the fins in a column."""
    def at(face, x, y):
        b = face.bounding_box()
        return Pos(x - b.min.X, y - b.min.Y) * face

    plate_w = BODY[1] - TOWER[0]
    placed, x = [], 5.0
    for name in ("front-plate", "back-plate"):
        placed.append((name, at(p2[name], x, 5.0)))
        placed.append(("leg", at(p2["leg"], x + TOWER[1] - TOWER[0] + GAP, 5.0 + BODY[3] - BODY[2] + GAP)))
        x += plate_w + GAP
    y = 5.0
    for n in ("j-hook", "rocker", "ear", "ear"):
        placed.append((n, at(p2[n], x, y)))
        y += p2[n].bounding_box().size.Y + GAP
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
