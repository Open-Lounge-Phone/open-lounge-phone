"""An Opis 60s Micro-shaped handset, modelled as one closed solid: build/handset/opis.{step,stl}.

For renders and printing: two turned cups (a soft base edge rising into a full dome) joined by a
handle lofted through oval sections, fuller for the palm, flaring into the domes with no seam. Lying on its cups (cups down, -z), long axis y,
centred on x = y = 0, base at z = 0. Sizes are the handset's outline (210 mm long), not its inside.

    .venv/bin/python handset.py
"""
from __future__ import annotations

from pathlib import Path

import math

from build123d import (Cylinder, Plane, Pos, Rot, ThreePointArc, export_step, export_stl, fillet)

OUT = Path(__file__).resolve().parent / "build" / "handset"

LENGTH = 210.0        # end to end
CUP_D = 68.0          # the cups' base
CUP_H = 34.0          # a cup's height: a soft base edge rising into a full dome
BASE_R = 3.0          # the cup's base edge
SIDE_H = 8.0          # the straight bit of the cup's side before the dome
ARCH_END_Z, ARCH_MID_Z = 12.0, 37.0   # the handle's centre line: deep in the cups, and mid-way
# the handle's oval sections along its length (t from one cup to the other): width x thickness.
# Its ends sit deep inside the domes; a wide neck flares into each dome; the middle swells a
# little for the palm, gently, so the surface stays smooth.
SECTIONS = ((0.00, 34.0, 20.0), (0.10, 46.0, 30.0), (0.30, 38.0, 24.0), (0.50, 39.5, 25.0),
            (0.70, 38.0, 24.0), (0.90, 46.0, 30.0), (1.00, 34.0, 20.0))
HANDLE_W = 40.0       # the handle at the palm (the plush bed's notes use it)


def _cup_face(r0: float, h: float, base_z: float = 0.0):
    """A cup's half profile in the XZ plane, revolved later: flat base, rounded edge, a short
    straight side, then a dome tangent to it that meets the axis level."""
    from build123d import Face, Line, Spline, Wire
    br = min(BASE_R, r0 / 4)
    p0, p1 = (0.0, 0.0, base_z), (r0 - br, 0.0, base_z)
    p2 = (r0, 0.0, base_z + br)
    mid = (r0 - br + br * math.sin(math.radians(45)), 0.0, base_z + br - br * math.cos(math.radians(45)))
    p3 = (r0, 0.0, max(base_z + br, SIDE_H))
    # the dome ends in a tiny flat at its apex (a point there leaves the mesh open)
    flat, top = (2.0, 0.0, h), (0.0, 0.0, h)
    edges = [Line(p0, p1), ThreePointArc(p1, mid, p2), Line(p2, p3),
             Spline(p3, (r0 * 0.72, 0.0, h * 0.86), flat, tangents=((0, 0, 1), (-1, 0, 0))),
             Line(flat, top), Line(top, p0)]
    return Face(Wire(edges))


def cup(y: float, r0: float = CUP_D / 2, h: float = CUP_H, base_z: float = 0.0):
    from build123d import Axis, revolve
    return Pos(0, y, 0) * revolve(_cup_face(r0, h, base_z), Axis.Z, 360)


def _path():
    yc = LENGTH / 2 - CUP_D / 2
    return ThreePointArc((0, -yc, ARCH_END_Z), (0, 0, ARCH_MID_Z), (0, yc, ARCH_END_Z))


def handle(less: float = 0.0):
    """The handle: a smooth loft through oval sections along the arch (`less` thins every
    section by that much each side, for the hollow inside)."""
    from build123d import Ellipse, loft
    path = _path()
    secs = []
    for t, w, th in SECTIONS:
        pl = Plane(origin=path @ t, x_dir=(1, 0, 0), z_dir=path % t)
        secs.append(pl * Ellipse(w / 2 - less, th / 2 - less))
    return loft(secs)


def build():
    yc = LENGTH / 2 - CUP_D / 2
    return cup(-yc) + cup(yc) + handle()


# ---------------------------------------------------------------- the printable handset
# One smooth shell (the top you hold and see: no seams, no screws) hollow from the mouthpiece to
# the earpiece, and two caps under the cups, each held by three M2.5 x 6 screws into bosses inside
# the cup, like the screw-off caps of a classic handset. The earpiece cap seats a small speaker
# (up to 30 mm), the mouthpiece cap a 9.7 mm electret capsule; the cord leaves through the end of
# the mouthpiece cup. Print the shell on its back (SLS/MJF; FDM with supports inside the cups).
WALL = 2.4
CAP_T, LIP_H = 2.5, 2.0
BOSS_R, BOSS_D, BOSS_H, SCREW_HOLE = 29.0, 6.5, 9.0, 2.1    # M2.5 self-tapping; each boss meets the wall
SPEAKER_D, MIC_D = 30.0, 10.0
CORD_D = 5.5
EAR_Y = 1                  # +y cup = earpiece, -y = mouthpiece (the cord end)


def _path():
    yc = LENGTH / 2 - CUP_D / 2
    return ThreePointArc((0, -yc, ARCH_END_Z), (0, 0, ARCH_MID_Z), (0, yc, ARCH_END_Z))


def _boss_xy(y):
    return [(BOSS_R * math.cos(math.radians(a)), y + BOSS_R * math.sin(math.radians(a))) for a in (90, 210, 330)]


def build_shell():
    """The handset body, hollow throughout, open under each cup for its cap."""
    yc = LENGTH / 2 - CUP_D / 2
    outer = build()
    inner = handle(WALL)
    for y in (-yc, yc):
        inner += cup(y, CUP_D / 2 - WALL, CUP_H - WALL, base_z=-4.0)   # its rounded edge below the base: straight inside where the caps sit
    shell = outer - inner
    for y in (-yc, yc):                      # screw bosses inside each cup
        for x, by in _boss_xy(y):
            boss = Pos(x, by, BOSS_H / 2) * Cylinder(BOSS_D / 2, BOSS_H)
            shell += boss - Pos(x, by, BOSS_H / 2 - 1) * Cylinder(SCREW_HOLE / 2, BOSS_H)
    # the cord leaves through the mouthpiece cup's end
    shell -= Pos(0, -yc - CUP_D / 2, 4.5) * Rot(90, 0, 0) * Cylinder(CORD_D / 2, WALL * 4)
    return shell


def build_cap(ear: bool):
    """A cap under a cup: a rounded face, a lip that locates it in the cup, three screw holes,
    sound holes, and a seat for the speaker (earpiece) or the mic capsule (mouthpiece)."""
    face = Pos(0, 0, -CAP_T / 2) * Cylinder(CUP_D / 2 - 0.5, CAP_T)
    try:
        face = fillet(face.edges().sort_by()[:1], 1.2)
    except Exception:
        pass
    ro = CUP_D / 2 - WALL - 0.2
    lip = Pos(0, 0, LIP_H / 2) * (Cylinder(ro, LIP_H) - Cylinder(ro - 1.6, LIP_H + 1))
    for x, y in _boss_xy(0):
        lip -= Pos(x, y, LIP_H / 2) * Cylinder(BOSS_D / 2 + 0.6, LIP_H + 2)
    cap = face + lip
    if ear:
        seat = Pos(0, 0, 1.25) * (Cylinder(SPEAKER_D / 2 + 1.2, 2.5) - Cylinder(SPEAKER_D / 2 + 0.2, 3))
        cap += seat
        holes = [(0.0, 0.0)] + [(6 * math.cos(math.radians(a)), 6 * math.sin(math.radians(a))) for a in range(0, 360, 60)]
        hd = 2.2
    else:
        holder = Pos(0, 0, 3.0) * (Cylinder(MIC_D / 2 + 1.4, 6.0) - Cylinder(MIC_D / 2 - 0.15, 7.0))
        cap += holder
        holes = [(0.0, 0.0)] + [(rr * math.cos(math.radians(a)), rr * math.sin(math.radians(a)))
                                for rr, n in ((3.2, 6), (6.5, 12)) for a in range(0, 360, 360 // n)]
        hd = 1.6
    for x, y in holes:
        cap -= Pos(x, y, -CAP_T / 2) * Cylinder(hd / 2, CAP_T + 2)
    for x, y in _boss_xy(0):
        cap -= Pos(x, y, 0) * Cylinder(1.4, 10)
        cap -= Pos(x, y, -CAP_T + 0.6) * Cylinder(2.8, 1.2)          # screw head recess
    return cap


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    h = build()
    for name, part in (("handset-shell", build_shell()), ("handset-cap-earpiece", build_cap(True)),
                       ("handset-cap-mouthpiece", build_cap(False))):
        export_step(part, str(OUT / f"{name}.step"))
        export_stl(part, str(OUT / f"{name}.stl"), tolerance=0.02, angular_tolerance=0.15)
        bb = part.bounding_box()
        print(f"{name}: {bb.size.X:.1f} x {bb.size.Y:.1f} x {bb.size.Z:.1f} mm, {part.volume / 1000:.1f} cm3, "
              f"{len(part.solids())} solid(s), valid {part.is_valid}")
    export_step(h, str(OUT / "opis.step"))
    export_stl(h, str(OUT / "opis.stl"), tolerance=0.02, angular_tolerance=0.15)
    bb = h.bounding_box()
    print(f"handset {bb.size.X:.1f} x {bb.size.Y:.1f} x {bb.size.Z:.1f} mm, {len(h.solids())} solid(s), "
          f"valid {h.is_valid}")


if __name__ == "__main__":
    main()
