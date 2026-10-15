"""The flat-cut case: a laser-cut sandwich for the minimal board, a wall phone on a desk stand.

Every part is cut from one sheet of 3 mm acrylic (or plywood) and held with M3 standoffs,
screws and nuts. Layers, front to back: the front plate (the keys come through two long row
slots, the hook key through its own hole, the e-paper through a window), the board on short
standoffs, and the back plate. Tall standoffs at the corners, outside the board, join the front
and back plates. The handset hangs on the left, beside the keys, never over them:

- its lower cup sits in a V between two "ledge" fins clamped to an M3 threaded-rod axle;
- the handset's weight turns the axle, and a third fin on the same axle presses the hook key;
- the key's own spring lifts the ledge back when the handset is picked up (a heel on the ledge
  fins stops it level);
- a fixed J-hook at the top keeps the handset upright.

Two flat legs, slotted into the back plate, stand the phone up tilted back; without them, two
keyholes in the back plate hang it on a wall.

    .venv/bin/python flatcase.py            # build/flatcase/: cut files (DXF, SVG), STEP, STL

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
BOARD_STANDOFF = 8.0       # M3 standoffs, board to back plate: clears the jack (4.0) and leads
COLUMN = 25.0              # M3 standoffs, back plate to front plate (corners and spine)
KEYCAP_TOP = 20.5          # keycap tops above the board top (measure yours; DSA/relegendable ~20)
BACK_Z1 = -F.BOARD_T - BOARD_STANDOFF            # back plate's front face
BACK_Z0 = BACK_Z1 - T
FRONT_Z0 = BACK_Z1 + COLUMN                      # front plate's back face
FRONT_Z1 = FRONT_Z0 + T

# --- outline --------------------------------------------------------------------------------
MARGIN = 10.0              # plate beyond the board
R_CORNER = 8.0
HS_X = -40.0               # the handset's axis (vertical)
SPINE_X0 = -84.0           # the spine: the tall left part the handset hangs on
SPINE_TOP = 268.0
BODY = (-MARGIN, F.BOARD_W + MARGIN, -MARGIN, F.BOARD_H + MARGIN)
SPINE = (SPINE_X0, 0.0, -MARGIN, SPINE_TOP)

# --- keys and windows -----------------------------------------------------------------------
KEY_CLEAR = 0.8            # keycap (18 mm) to slot edge, each side
KEYCAP = 18.0
SLOT_R = 2.0
VIEW = (54.0, 28.0)        # e-paper window (the 2.13" panel's view area plus a little)

# --- columns (corners and spine) ---------------------------------------------------------------
COLUMNS = [(-5.0, -5.0), (F.BOARD_W + 5.0, -5.0), (F.BOARD_W + 5.0, F.BOARD_H + 5.0),
           (-5.0, F.BOARD_H + 5.0), (SPINE_X0 + 6.0, -4.0), (SPINE_X0 + 6.0, SPINE_TOP - 8.0),
           (-6.0, SPINE_TOP - 8.0)]
M3 = 3.4                   # clearance hole
M2 = 2.4

# --- the hook rocker -------------------------------------------------------------------------
HOOK_KEY = next((x, F.Y(y)) for x, y, lab in F.SWITCHES if lab == "HOOK")
AXLE_Y = HOOK_KEY[1] + 22.0                      # the axle runs along x, above the hook key
AXLE_Z = FRONT_Z1 + 7.6
LEDGE_X = (HS_X - 15.0, HS_X + 15.0)             # two ledge fins: the cup sits between them
EAR_X = (SPINE_X0 + 18.0, -6.5)                  # fixed bearing fins
TAIL_X = HOOK_KEY[0]                             # the tail fin, over the hook key
LEDGE_TOP = AXLE_Y + 6.0
LEDGE_REACH = 44.0                               # forward from the axle
CUP_R = HS.CUP_D / 2
CUP_Y = LEDGE_TOP + math.sqrt(CUP_R**2 - 15.0**2)  # the lower cup's centre, resting in the V
HS_BASE_Z = FRONT_Z1 + 6.0                        # the handset's back (its cup rims' plane)
HS_LIFT = 2.0              # the domed cup rests 2 mm higher than a flat rim would (measured)
CUP_TOP = CUP_Y + HS_LIFT + 2 * (HS.LENGTH / 2 - CUP_R) + CUP_R   # the earpiece's top
LIP_Z = HS_BASE_Z + HS.CUP_H + 2.6                # in front of the earpiece's dome

# --- stand ----------------------------------------------------------------------------------
TILT = 15.0                # back from vertical
LEG_X = (-62.0, F.BOARD_W - 10.0)
LEG_SPAN = (20.0, 150.0)   # along the back plate (y)
TAB = (12.0, T)            # tab length x thickness; slots are cut 0.2 bigger


def rect(x0, x1, y0, y1):
    return Pos((x0 + x1) / 2, (y0 + y1) / 2) * Rectangle(x1 - x0, y1 - y0)


def rrect(x0, x1, y0, y1, r):
    return Pos((x0 + x1) / 2, (y0 + y1) / 2) * RectangleRounded(x1 - x0, y1 - y0, r)


def outline():
    """The plates' shape: the body round the board and the tall spine on the left."""
    return rrect(*BODY, R_CORNER) + rrect(*SPINE, R_CORNER)


def board_y(y):
    return F.Y(y)


# ============================================================================== plates
def front_plate_2d():
    s = outline()
    kx = [x for x, _, lab in F.SWITCHES if lab not in ("HOOK",)]
    rows = sorted({board_y(y) for _, y, lab in F.SWITCHES if lab != "HOOK"})
    half = KEYCAP / 2 + KEY_CLEAR
    for ry in rows:                                   # one long slot per row of six
        s -= rrect(min(kx) - half, max(kx) + half, ry - half, ry + half, SLOT_R)
    hx, hy = HOOK_KEY
    s -= rrect(hx - half, hx + half, hy - half, hy + half, SLOT_R)
    (_, _, _, _), (wx, wy, _, _) = F.display()
    s -= rrect(wx - VIEW[0] / 2, wx + VIEW[0] / 2, wy - VIEW[1] / 2, wy + VIEW[1] / 2, 2.0)
    lx, ly = P.LED[0], board_y(P.LED[1])
    s -= Pos(lx, ly) * Circle(1.6)                    # the status light shows through
    bx, by = P.BZ1_C[0], board_y(P.BZ1_C[1])
    for dx in (-4.5, -1.5, 1.5, 4.5):                 # the ringer's sound
        s -= rrect(bx + dx - 0.9, bx + dx + 0.9, by - 5.0, by + 5.0, 0.85)
    for x, y in COLUMNS:
        s -= Pos(x, y) * Circle(M3 / 2)
    for x, y in P.MODULE_FAR_HOLES:                   # the module's far end hangs from the plate
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
    for x, y in F.HOLES:
        s -= Pos(x, board_y(y)) * Circle(M3 / 2)
    for x, y, _ in P.BUTTONS:                        # pinholes for RESET and BOOT
        s -= Pos(x, board_y(y)) * Circle(1.0)
    for lx in LEG_X:                                  # the legs' tabs and screws
        for y0, y1 in leg_tab_spans():
            s -= rect(lx - (T + 0.2) / 2, lx + (T + 0.2) / 2, y0 - 0.1, y1 + 0.1)
        s -= Pos(lx, sum(LEG_SPAN) / 2) * Circle(M3 / 2)
    for x, y in ((HS_X, SPINE_TOP - 40.0), (F.BOARD_W - 20.0, F.BOARD_H - 10.0)):
        s -= keyhole(x, y)                            # hang it on a wall instead
    return s


def keyhole(x, y):
    """A keyhole for a wall screw: head through the round part, slide down onto the neck."""
    return Pos(x, y) * Circle(4.5) + rrect(x - 2.0, x + 2.0, y - 10.0, y, 1.9)


# ============================================================================== fins (in y-z)
def fin_slots_front():
    """(x, [(y0, y1), ...]) of tab slots in the front plate for the fins standing on it."""
    out = []
    for ex in EAR_X:
        out.append((ex, [(AXLE_Y - 12.0, AXLE_Y - 12.0 + TAB[0]), (AXLE_Y + 2.0, AXLE_Y + 2.0 + TAB[0])]))
    out.append((HS_X, [(J_Y0, J_Y0 + TAB[0]), (J_Y0 + 22.0, J_Y0 + 22.0 + TAB[0])]))
    return out


def fin_screws_front():
    out = [(ex, AXLE_Y + 0.5) for ex in EAR_X]
    out.append((HS_X, J_Y0 + 17.0))
    return out


def leg_tab_spans():
    a, b = LEG_SPAN
    return [(a + 5.0, a + 5.0 + TAB[0]), (b - 5.0 - TAB[0], b - 5.0)]


def poly(points):
    return Polygon(*points, align=None)


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
    body = poly([(AXLE_Y - 14.0, z0), (AXLE_Y + 16.0, z0), (AXLE_Y + 6.0, AXLE_Z + 6.0),
                 (AXLE_Y - 6.0, AXLE_Z + 6.0)])
    for y0, y1 in fin_slots_front()[0][1]:
        body += rect(y0, y1, z0 - T, z0 + 0.01)
    body -= Pos(AXLE_Y, AXLE_Z) * Circle(1.8)          # turns freely on the axle
    body -= t_slot(AXLE_Y + 0.5, z0, toward=(0.0, 1.0))
    return body


def ledge_2d():
    """A ledge fin, clamped to the axle: the cup sits on its top edge; a heel stops it level."""
    top = LEDGE_TOP
    pts = [(AXLE_Y - 6.0, AXLE_Z - 6.0), (AXLE_Y - 6.0, AXLE_Z + LEDGE_REACH),
           (top, AXLE_Z + LEDGE_REACH), (top, AXLE_Z - 2.0), (AXLE_Y + 14.0, AXLE_Z - 2.0),
           (AXLE_Y + 14.0, FRONT_Z1 + 0.0), (AXLE_Y + 6.0, FRONT_Z1 + 0.0), (AXLE_Y + 6.0, AXLE_Z - 6.0)]
    body = poly(pts)
    body -= Pos(AXLE_Y, AXLE_Z) * Circle(M3 / 2 - 0.2)  # tight: nuts clamp it to the rod
    # a shallow V so the cup's rim can't slide forward or back off the ledge
    body -= poly([(top + 0.01, AXLE_Z + 10.0), (top - 2.5, AXLE_Z + 22.0), (top + 0.01, AXLE_Z + 34.0)])
    return body


def tail_2d():
    """The tail fin, clamped to the axle: its rounded tip rests on the hook key's cap."""
    tip_y, tip_z = HOOK_KEY[1] + 3.0, KEYCAP_TOP + 2.0
    body = poly([(AXLE_Y - 5.0, AXLE_Z - 5.0), (AXLE_Y + 5.0, AXLE_Z - 5.0), (AXLE_Y + 5.0, AXLE_Z + 5.0),
                 (tip_y + 4.0, tip_z + 4.0), (tip_y - 4.0, tip_z + 0.5), (tip_y - 1.0, tip_z - 2.0),
                 (AXLE_Y - 5.0, AXLE_Z - 2.0)])
    body += Pos(tip_y, tip_z) * Circle(2.0)
    body -= Pos(AXLE_Y, AXLE_Z) * Circle(M3 / 2 - 0.2)
    return body


J_Y0 = SPINE_TOP - 62.0


def jhook_2d():
    """The J-hook at the top: an arm over the earpiece and a short lip in front of its dome, so
    the handset can't tip forward out of the ledges."""
    z0 = FRONT_Z1
    arm_y0 = CUP_TOP + 2.0                            # just above the earpiece
    lip_y0 = CUP_TOP - 16.0                           # the dome is narrow up here (z < 57)
    lip_z1 = LIP_Z + 6.0
    foot = HS_BASE_Z - 1.0 - z0                       # the foot stays under the handset's back
    pts = [(J_Y0, z0), (arm_y0 + 8.0, z0), (arm_y0 + 8.0, lip_z1), (lip_y0, lip_z1),
           (lip_y0, LIP_Z), (arm_y0, LIP_Z), (arm_y0, z0 + foot), (J_Y0, z0 + foot)]
    body = poly(pts)
    for y0, y1 in fin_slots_front()[-1][1]:
        body += rect(y0, y1, z0 - T, z0 + 0.01)
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
    if inner.area > 100:
        body -= inner
    for t0, t1 in leg_tab_spans():
        body += rect(t0, t1, zb, zb + T + 0.01)
    body -= t_slot(sum(LEG_SPAN) / 2, zb, toward=(0.0, -1.0))
    return body


# ============================================================================== 3D placement
def plate3d(face, z0):
    return Pos(0, 0, z0) * extrude(face, amount=T)


def fin3d(face, x):
    """A fin drawn in (y, z) placed at x, T thick, centred on x."""
    pl = Plane(origin=(x - T / 2, 0, 0), x_dir=(0, 1, 0), z_dir=(1, 0, 0))
    return extrude(pl * face, amount=T)


def parts_2d():
    return {
        "front-plate": front_plate_2d(),
        "back-plate": back_plate_2d(),
        "ear": ear_2d(),
        "ledge": ledge_2d(),
        "tail": tail_2d(),
        "j-hook": jhook_2d(),
        "leg": leg_2d(),
    }


QTY = {"front-plate": 1, "back-plate": 1, "ear": 2, "ledge": 2, "tail": 1, "j-hook": 1, "leg": 2}


def assembly(p2):
    a = {
        "front-plate": plate3d(p2["front-plate"], FRONT_Z0),
        "back-plate": plate3d(p2["back-plate"], BACK_Z0),
        "j-hook": fin3d(p2["j-hook"], HS_X),
        "tail": fin3d(p2["tail"], TAIL_X),
    }
    for i, ex in enumerate(EAR_X):
        a[f"ear-{i + 1}"] = fin3d(p2["ear"], ex)
    for i, lx in enumerate(LEDGE_X):
        a[f"ledge-{i + 1}"] = fin3d(p2["ledge"], lx)
    for i, lx in enumerate(LEG_X):
        a[f"leg-{i + 1}"] = fin3d(p2["leg"], lx)
    return a


def hardware3d():
    """Standoffs, the axle and a stand-in board, for checks and renders (not cut)."""
    h = {}
    for x, y in COLUMNS:
        h[f"column {x:.0f},{y:.0f}"] = Pos(x, y, BACK_Z1) * Cylinder(3.0, COLUMN, align=(Align.CENTER, Align.CENTER, Align.MIN))
    for x, y in F.HOLES:
        h[f"standoff {x:.0f}"] = Pos(x, board_y(y), BACK_Z1) * Cylinder(2.75, BOARD_STANDOFF, align=(Align.CENTER, Align.CENTER, Align.MIN))
    x0, x1 = min(EAR_X) - 6.0, TAIL_X + 6.0
    h["axle"] = Pos((x0 + x1) / 2, AXLE_Y, AXLE_Z) * Rot(0, 90, 0) * Cylinder(1.5, x1 - x0)
    return h


def board3d():
    """A stand-in board: PCB, switch bodies, keycaps, the display module (for checks)."""
    from build123d import Align
    b = Pos(F.BOARD_W / 2, F.BOARD_H / 2, -F.BOARD_T) * Box(F.BOARD_W, F.BOARD_H, F.BOARD_T, align=(Align.CENTER, Align.CENTER, Align.MIN))
    caps = []
    for x, y, _ in F.SWITCHES:
        yy = board_y(y)
        b += Pos(x, yy, 0) * Box(14.0, 14.0, F.MX_HOUSING_TOP, align=(Align.CENTER, Align.CENTER, Align.MIN))
        caps.append(Pos(x, yy, KEYCAP_TOP - 8.0) * Box(KEYCAP, KEYCAP, 8.0, align=(Align.CENTER, Align.CENTER, Align.MIN)))
    (mx, my, mw, mh), _ = F.display()
    b += Pos(mx, my, P.STANDOFF_L) * Box(mw, mh, P.MODULE_PCB_T + 1.2, align=(Align.CENTER, Align.CENTER, Align.MIN))
    return b, caps


def handset3d():
    """The handset hanging: axis along y, its lower cup in the ledges' V."""
    from build123d import Rot as R
    hs = HS.build()
    # handset.py builds it lying along y with its cups' rims on z = 0, centred at the origin.
    return Pos(HS_X, CUP_Y + HS_LIFT + (HS.LENGTH / 2 - CUP_R), HS_BASE_Z) * hs


SHEET = (600.0, 300.0)     # one standard sheet holds every part
GAP = 4.0                  # between parts (the laser's kerf is ~0.2)


def sheet_layout(p2):
    """Every part, in its quantity, placed on one SHEET: the two L-shaped plates side by side, a
    leg in the empty corner above each plate's key body, the fins in the gaps."""
    def at(face, x, y):
        b = face.bounding_box()
        return Pos(x - b.min.X, y - b.min.Y) * face

    plate_w = BODY[1] - SPINE_X0
    pocket_x = 0.0 - SPINE_X0 + GAP                 # right of the spine
    pocket_y = BODY[3] - SPINE[2] + GAP             # above the key body
    placed = []
    for i, name in enumerate(("front-plate", "back-plate")):
        x0 = 5.0 + i * (plate_w + GAP)
        placed.append((name, at(p2[name], x0, 5.0)))
        placed.append(("leg", at(p2["leg"], x0 + pocket_x, 5.0 + pocket_y)))
    strip = 5.0 + 2 * (plate_w + GAP)
    placed.append(("j-hook", at(p2["j-hook"], strip, 5.0)))
    ledge_h = p2["ledge"].bounding_box().size.Y
    for j in range(2):
        placed.append(("ledge", at(p2["ledge"], strip + j * (p2["ledge"].bounding_box().size.X + GAP), 5.0 + 52.0 + GAP)))
    y = 5.0 + 52.0 + GAP + ledge_h + GAP
    for name in ("ear", "ear", "tail"):
        placed.append((name, at(p2[name], strip, y)))
        y += p2[name].bounding_box().size.Y + GAP
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
          f"keycaps {KEYCAP_TOP - FRONT_Z1:.1f} mm proud of the front")


if __name__ == "__main__":
    main()
