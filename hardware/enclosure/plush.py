"""The plush series: a fat, cushion-like desk case that lies flat: build/plush/.

Two pillows fused like a sofa cushion: the keypad pillow, whose rounded top is the key face (the
keys and the screen sit right in it), and beside it a taller pillow that is the handset's bed,
with soft-rimmed pockets for the cups. Rigid print, made to look inflated. The keys are captive
caps (a flange under the face, a puffy button through it). The hook key's button rises through
the floor under the handset's lower cup, like a classic cradle's plunger: the cup's weight
presses it and the floor stops it. The status light shows as a jewel on the bed's front through
an angled light pipe; the buzzer sounds out through the bottom plate. The plate drops in on a
locating lip and five screws hide under the rubber feet.

    .venv/bin/python plush.py

Coordinates as faceplate.py: board top-left origin, x right, y up, z = 0 at the board top.
"""
from __future__ import annotations

import math
from pathlib import Path

from build123d import Box, Cylinder, Pos, export_step, export_stl, fillet, Text, extrude, FontStyle

import faceplate as F  # noqa: E402  (sets OLP_DISPLAY=2.13 and the captive-cap stack)
import handset as HS
import proto_box as P

OUT = Path(__file__).resolve().parent / "build" / "plush"

Z_BOT = -10.0              # the case's underside (the bottom plate sits flush in it)
WALL = 3.0
KEY_TOP = F.FACE_Z         # the keypad pillow's top IS the key face: no recessed panel
BED_TOP = 36.0             # the handset bed rises above it
KEY_R, BED_R = 12.0, 19.0  # their puffiness: the rounded top edge
CORNER = 2.0               # corner radius in plan = this x the top radius (fat, round corners)
BOTTOM_R = 2.5             # the soft edge it sits on (under the wall's thickness)
SEAM_Z, SEAM_W, SEAM_D = 2.0, 1.6, 0.8  # a piping seam round each pillow (height, width, depth)
KEY_BOX = (-8.0, 172.0, -8.0, 96.0)     # keypad pillow x0, x1, y0, y1
HS_C = (-8.0, 84.5)        # the handset's centre (x, y): its lower cup over the hook key's row
BED_BOX = (-50.0, 30.0, HS_C[1] - 105.0 - 9.0, HS_C[1] + 105.0 + 9.0)
HOLLOW_TOP = 17.0          # the bed's hollow (cords, plugs) stops here: 3 mm under the lower cup's floor

# The hook: the hook key's captive button rises through the floor under the handset's lower cup,
# like the plunger in a classic cradle. The upper cup's floor is at the button's top, so the
# handset lies level on it; the cup's weight presses the button and the floor (the key face,
# PROUD lower) stops the cup after 3.6 mm, past the switch point (2) and short of the bottom (4).
HS_Z = F.CAP_TOP           # the upper cup's floor (the handset's underside, at rest)
LOW_FLOOR = F.FACE_Z       # the lower cup's floor: the face the hook button comes through
FLARE = 9.0                # the cup pockets' rims flare out this much (a soft, dished lip)
FLARE_H = 8.0

# The status light: an angled light pipe (a 3 mm clear acrylic rod) from the LED to a small jewel
# on the front of the bed, where it shows with the handset hung up.
JEWEL = (-10.0, 18.0)      # x and height of the jewel on the bed's front
CORD_HOLES = ((8.0, 150.0), (7.0, 164.0))   # (diameter, y) through the bed pillow's outer side

# The bottom: one plate on a locating lip, five countersunk M3 screws hidden under the rubber
# feet, up into heat-set inserts in columns from the top shell.
PLATE_T = 3.5
LIP_H, LIP_T = 2.5, 1.6
FEET = ((KEY_BOX[1] - WALL - 4.0, 14.0), (KEY_BOX[1] - WALL - 4.0, 74.0), (-26.0, -12.0),
        (-26.0, 182.0), (12.0, 188.0))
FOOT_D, FOOT_DEPTH = 11.0, 1.0
COLUMN_D = 8.0
SCREW = "M3 x 8 countersunk (ISO 10642)"
INSERT = "M3 x 4 heat-set insert (OD 4.0-4.2)"
GRILLE_AT = (-16.0, 73.0)  # the buzzer's sound leaves through the bottom plate, beside the board


def pillow(x0, x1, y0, y1, z0, z1, r):
    """A puffy pillow: fat round corners in plan, the top edge rounded all round, a soft bottom
    edge and a piping seam round its middle."""
    rc = r * CORNER
    b = F.rrect((x0 + x1) / 2, (y0 + y1) / 2, x1 - x0, y1 - y0, rc, z0, z1)
    b = F.round_top(b, z1, r)
    try:
        b = fillet([e for e in b.edges() if abs(e.center().Z - z0) < 1e-3], BOTTOM_R)
    except Exception:
        pass
    seam = F.rrect((x0 + x1) / 2, (y0 + y1) / 2, x1 - x0 + 2, y1 - y0 + 2, rc + 1, SEAM_Z - SEAM_W / 2, SEAM_Z + SEAM_W / 2)
    seam -= F.rrect((x0 + x1) / 2, (y0 + y1) / 2, x1 - x0 - 2 * SEAM_D, y1 - y0 - 2 * SEAM_D, rc - SEAM_D,
                    SEAM_Z - SEAM_W, SEAM_Z + SEAM_W)
    return b - seam


def inside(x0, x1, y0, y1, r, z0, z1):
    """The room inside a pillow: its outline WALL in, the same rounding less the wall."""
    return F.rrect((x0 + x1) / 2, (y0 + y1) / 2, x1 - x0 - 2 * WALL, y1 - y0 - 2 * WALL, r * CORNER - WALL, z0, z1)


def hook_xy():
    return P.HOOK[0], F.Y(P.HOOK[1])


def lift(a, b):
    """A unit direction and length from point a to b."""
    d = [b[i] - a[i] for i in range(3)]
    n = math.sqrt(sum(v * v for v in d))
    return [v / n for v in d], n


def rod(a, b, d, extra=0.0):
    """A cylinder of diameter d from a to b (and `extra` past b)."""
    from build123d import Align, Plane
    u, n = lift(a, b)
    return Plane(origin=a, z_dir=u) * Cylinder(d / 2, n + extra, align=(Align.CENTER, Align.CENTER, Align.MIN))


def jewel_path():
    lx, ly = P.LED[0], F.Y(P.LED[1])
    return (lx, ly, 2.5), (JEWEL[0], BED_BOX[2], JEWEL[1])


def cup_pocket(x, y, floor):
    """A cup's pocket: a round bore 1 mm roomy, opening into a soft flared rim."""
    from build123d import Cone
    r = HS.CUP_D / 2 + 1.0
    bore = F.cyl(x, y, floor, BED_TOP - FLARE_H + 0.01, 2 * r)
    flare = Pos(x, y, BED_TOP - FLARE_H / 2 + 0.5) * Cone(r, r + FLARE, FLARE_H + 1.0)
    return bore + flare


def build_case():
    zt, zu = F.FACE_Z, F.FACE_Z - F.FACE_T
    kx0, kx1, ky0, ky1 = KEY_BOX
    bx0, bx1, by0, by1 = BED_BOX
    body = pillow(kx0, kx1, ky0, ky1, Z_BOT, KEY_TOP, KEY_R) + pillow(bx0, bx1, by0, by1, Z_BOT, BED_TOP, BED_R)

    # inside: the board's room up to under the face, the bed hollowed below its floors
    body -= F.rrect(F.BOARD_W / 2, F.BOARD_H / 2, F.BOARD_W + 0.6, F.BOARD_H + 0.6, F.BOARD_R + 0.3, Z_BOT - 1, zu)
    hollow = inside(bx0, bx1, by0, by1, BED_R, Z_BOT - 1, HOLLOW_TOP)
    hollow -= F.rrect(F.BOARD_W / 2, F.BOARD_H / 2, F.BOARD_W + 0.6 + 2 * WALL, F.BOARD_H + 0.6 + 2 * WALL,
                      F.BOARD_R + 3.0, zu - 0.01, 20.0)        # over the board the room stops under the face
    body -= hollow
    body -= inside(kx0, kx1, ky0, ky1, KEY_R, Z_BOT - 1, 0.0)

    # captive caps: openings through the face (the hook's in the lower cup's floor), and room for
    # every flange to travel
    for x, y, _ in F.SWITCHES:
        body -= F.rrect(x, F.Y(y), F.HOLE, F.HOLE, F.BUTTON_R + 0.3, zu - 1, zt + 1)
        body -= F.rrect(x, F.Y(y), F.FLANGE + 0.8, F.FLANGE + 0.8, F.FLANGE_R + 0.4, F.MX_HOUSING_TOP, zu)

    # display: window, lens and frame, far-end posts (as the faceplate)
    (mx, my, mw, mh), (wx, wy, ww, wh) = F.display()
    module_top = P.STANDOFF_L + P.MODULE_PCB_T
    lw, lh, _ = F.LENS
    body += F.rrect(wx, wy, lw + 0.4 + 2 * F.HOOD_WALL, lh + 0.4 + 2 * F.HOOD_WALL, F.HOOD_R, F.DISP_TOP + 0.2, zu + 0.01)
    for x, y in P.MODULE_FAR_HOLES:
        body += F.cyl(x, F.Y(y), module_top + 0.1, zu + 0.01, F.FAR_POST_D)
        body += F.cyl(x, F.Y(y), module_top + 0.1 - F.FAR_PIN_L, module_top + 0.11, F.FAR_PIN_D)
    body -= F.rrect(wx, wy, lw + 0.4, lh + 0.4, 1.5, F.DISP_TOP, zt - F.LENS_LIP)
    body -= F.rrect(wx, wy, ww, wh, F.WIN_R, F.DISP_TOP, zt + 1)
    body -= F.rrect(wx, wy, ww + 2 * F.WIN_BEVEL, wh + 2 * F.WIN_BEVEL, F.WIN_R + F.WIN_BEVEL, zt - F.WIN_BEVEL, zt + 1)

    # board screws: insert bosses down to the board at H1-H4
    for x, y in F.HOLES:
        body += F.cyl(x, F.Y(y), 0.0, zu + 0.01, F.BOSS_D)
        body -= F.cyl(x, F.Y(y), -0.01, F.INSERT_L, F.INSERT_D)

    # the handset's bed: soft-rimmed pockets; the lower one's floor is the face with the hook button
    yc = HS.LENGTH / 2 - HS.CUP_D / 2
    body -= cup_pocket(HS_C[0], HS_C[1] + yc, HS_Z)
    body -= cup_pocket(HS_C[0], HS_C[1] - yc, LOW_FLOOR)

    # the status light: a guide tube from over the board out to the jewel on the bed's front
    a, b = jewel_path()
    u, n = lift(a, b)
    t0 = 0.35                                            # the tube starts clear of the board's parts
    g0 = tuple(a[i] + u[i] * n * t0 for i in range(3))
    body += rod(g0, b, F.LIGHT_PIPE + 3.0, -1.0)
    body -= rod(a, b, F.LIGHT_PIPE + 0.3, 2.0)
    body -= rod(tuple(b[i] - u[i] * 1.2 for i in range(3)), b, F.LIGHT_PIPE + 3.0, 2.0)   # the jewel's seat

    # cords out through the bed pillow's outer side
    for d, y in CORD_HOLES:
        body -= Pos(bx0 + WALL / 2, y, -3.0) * F.Rot(0, 90, 0) * Cylinder(d / 2, WALL * 3)

    # columns for the bottom plate's screws (hidden under the feet)
    for x, y in FEET:
        top = 0.5 if x > F.BOARD_W else HOLLOW_TOP + 0.01
        body += F.cyl(x, y, Z_BOT + PLATE_T, top, COLUMN_D)
        body -= F.cyl(x, y, Z_BOT + PLATE_T - 0.01, Z_BOT + PLATE_T + 5.0, F.INSERT_D)
    return body


def _outline(inset, z0, z1):
    kx0, kx1, ky0, ky1 = KEY_BOX
    bx0, bx1, by0, by1 = BED_BOX
    o = F.rrect((kx0 + kx1) / 2, (ky0 + ky1) / 2, kx1 - kx0 - 2 * inset, ky1 - ky0 - 2 * inset, KEY_R * CORNER - inset, z0, z1)
    o += F.rrect((bx0 + bx1) / 2, (by0 + by1) / 2, bx1 - bx0 - 2 * inset, by1 - by0 - 2 * inset, BED_R * CORNER - inset, z0, z1)
    return o


def build_plate():
    """The bottom: flush inside the walls on a locating lip; five countersunk M3 screws into the
    columns, each under a rubber foot; a grille for the buzzer beside the board."""
    g = WALL + 0.3
    plate = _outline(g, Z_BOT, Z_BOT + PLATE_T)
    lip = _outline(g, Z_BOT + PLATE_T - 0.01, Z_BOT + PLATE_T + LIP_H) - _outline(g + LIP_T, Z_BOT, Z_BOT + PLATE_T + LIP_H + 1)
    for x, y in FEET:
        lip -= F.cyl(x, y, Z_BOT, Z_BOT + 20, COLUMN_D + 2.0)
    lip -= F.rrect(F.BOARD_W / 2, F.BOARD_H / 2, F.BOARD_W + 1.0, F.BOARD_H + 1.0, F.BOARD_R + 0.5, Z_BOT, Z_BOT + 20)
    plate += lip
    for x, y in FEET:
        plate -= F.cyl(x, y, Z_BOT - 1, Z_BOT + PLATE_T + 1, 3.4)
        plate -= F.cyl(x, y, Z_BOT - 0.01, Z_BOT + FOOT_DEPTH, FOOT_D)                  # the foot
        plate -= F.Pos(x, y, Z_BOT + FOOT_DEPTH - 0.01) * F.Cylinder(3.2, 1.75, align=(F.Align.CENTER, F.Align.CENTER, F.Align.MIN))
    gx, gy = GRILLE_AT
    for i in range(-3, 4):
        half = math.sqrt(max(0.0, 11.0 ** 2 - (i * 3.0) ** 2))
        plate -= F.rrect(gx, gy + i * 3.0, 2 * half, 1.6, 0.79, Z_BOT - 1, Z_BOT + PLATE_T + 1)
    return plate


def build_puffy_cap(label: str):
    """A captive cap with a puffy, marshmallow top and an engraved legend."""
    btn = F.rrect(0, 0, F.BUTTON, F.BUTTON, 4.0, F.FLANGE_Z1 - 0.01, F.CAP_TOP)
    try:
        btn = fillet([e for e in btn.edges() if e.center().Z > F.CAP_TOP - 0.1], 3.2)
    except Exception:
        pass
    cap = F.round_top(F.rrect(0, 0, F.FLANGE, F.FLANGE, F.FLANGE_R, F.FLANGE_Z0, F.FLANGE_Z1), F.FLANGE_Z1, 0.6)
    cap = cap + btn + F.cyl(0, 0, F.POST_Z0, F.FLANGE_Z0 + 0.01, F.POST_D)
    for w, l in ((F.CROSS_W, F.CROSS_L), (F.CROSS_L, F.CROSS_W)):
        cap -= F.bx(-w / 2, w / 2, -l / 2, l / 2, F.POST_Z0 - 1, F.POST_Z0 + F.SOCKET_DEPTH + 0.4)
    text = F.LEGENDS.get(label, label)
    if text:
        size = 6.5 if len(text) == 1 else 2.7
        t = extrude(Text(text, font_size=size, font_style=FontStyle.BOLD), amount=3.0)
        cap -= Pos(0, 0, F.CAP_TOP - 0.7) * t
    return cap


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / "caps").mkdir(exist_ok=True)
    parts = {"plush-case": build_case(), "plush-bottom": build_plate()}
    for name, part in parts.items():
        export_step(part, str(OUT / f"{name}.step"))
        export_stl(part, str(OUT / f"{name}.stl"), tolerance=0.02, angular_tolerance=0.15)
        bb = part.bounding_box()
        print(f"{name}: {bb.size.X:.1f} x {bb.size.Y:.1f} x {bb.size.Z:.1f} mm, {part.volume / 1000:.1f} cm3, "
              f"{len(part.solids())} solid(s) {[round(x.volume) for x in part.solids()][:5]}")
    for _, _, lab in F.SWITCHES:
        cap = build_puffy_cap(lab) if lab != "HOOK" else F.build_cap("HOOK")
        export_stl(cap, str(OUT / "caps" / f"puffy-{lab.lower()}.stl"), tolerance=0.01, angular_tolerance=0.1)
        export_step(cap, str(OUT / "caps" / f"puffy-{lab.lower()}.step"))
    yc = HS.LENGTH / 2 - HS.CUP_D / 2
    print(f"hook: the lower cup rests on the hook button (top {F.CAP_TOP:.1f}) and stops on the face at "
          f"{LOW_FLOOR:.1f}: {F.CAP_TOP - LOW_FLOOR:.1f} mm of travel (switches at 2, bottoms at 4)")
    print(f"screws: {len(FEET)} x {SCREW} under the feet, into {INSERT}s; light pipe ~{lift(*jewel_path())[1]:.0f} mm")


if __name__ == "__main__":
    main()
