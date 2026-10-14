"""An Opis 60s Micro-shaped handset, modelled as one closed solid: build/handset/opis.{step,stl}.

For renders (the teaser, the ceramic wall-unit render): two domed cups on a flat base ring, joined
by a broad flat-topped handle on a gentle arch. Lying on its cups (cups down, -z), long axis y,
centred on x = y = 0, base at z = 0. Sizes are the handset's outline (210 mm long), not its inside.

    .venv/bin/python handset.py
"""
from __future__ import annotations

from pathlib import Path

import math

from build123d import (Cylinder, Plane, Pos, Rot, RectangleRounded, Sphere, ThreePointArc, Box,
                       export_step, export_stl, fillet, sweep)

OUT = Path(__file__).resolve().parent / "build" / "handset"

LENGTH = 210.0        # end to end
CUP_D = 68.0          # the cups' base ring
RING_T = 5.0          # its thickness
DOME_H = 31.0         # the dome over the ring
HANDLE_W, HANDLE_T, HANDLE_R = 44.0, 22.0, 8.0   # the handle's section: width, thickness, corners
ARCH_END_Z, ARCH_MID_Z = 30.0, 36.0              # the handle's centre line: at the cups, mid-way


def cup(y: float):
    ring = Pos(0, y, RING_T / 2) * Cylinder(CUP_D / 2, RING_T)       # base at z = 0
    try:
        ring = fillet(ring.edges().sort_by()[-1:], 1.5)
    except Exception:
        pass
    # the dome: a sphere cap whose base is the ring's top, DOME_H high
    a = (CUP_D / 2 - 2.0)
    r = (a * a + DOME_H * DOME_H) / (2 * DOME_H)
    dome = Pos(0, y, RING_T + DOME_H - r) * Sphere(r)
    dome &= Pos(0, y, RING_T + DOME_H / 2) * Box(CUP_D, CUP_D, DOME_H)
    return ring + dome


def build():
    yc = LENGTH / 2 - CUP_D / 2
    body = cup(-yc) + cup(yc)
    path = ThreePointArc((0, -yc, ARCH_END_Z), (0, 0, ARCH_MID_Z), (0, yc, ARCH_END_Z))
    start = Plane(origin=path @ 0, x_dir=(1, 0, 0), z_dir=path % 0)
    handle = sweep(start * RectangleRounded(HANDLE_W, HANDLE_T, HANDLE_R), path=path)
    return body + handle


# ---------------------------------------------------------------- the printable handset
# One smooth shell (the top you hold and see: no seams, no screws) hollow from the mouthpiece to
# the earpiece, and two caps under the cups, each held by three M2.5 x 6 screws into bosses inside
# the cup, like the screw-off caps of a classic handset. The earpiece cap seats a small speaker
# (up to 30 mm), the mouthpiece cap a 9.7 mm electret capsule; the cord leaves through the end of
# the mouthpiece cup. Print the shell on its back (SLS/MJF; FDM with supports inside the cups).
WALL = 2.4
CAP_T, LIP_H = 2.5, 2.0
BOSS_R, BOSS_D, BOSS_H, SCREW_HOLE = 28.2, 6.5, 9.0, 2.1    # M2.5 self-tapping
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
    a = (CUP_D / 2 - 2.0)
    r = (a * a + DOME_H * DOME_H) / (2 * DOME_H)
    inner = None
    for y in (-yc, yc):
        # the ring's cavity stops just under the ring's top (the dome is narrower than the ring)
        c = Pos(0, y, (RING_T - 0.3 - 1.0) / 2) * Cylinder(CUP_D / 2 - WALL, RING_T - 0.3 + 1.0)
        d = Pos(0, y, RING_T + DOME_H - r) * Sphere(r - WALL)
        d &= Pos(0, y, RING_T - 1.0 + (DOME_H - WALL + 1.0) / 2) * Box(CUP_D, CUP_D, DOME_H - WALL + 1.0)
        inner = (c + d) if inner is None else inner + c + d
    path = _path()
    start = Plane(origin=path @ 0, x_dir=(1, 0, 0), z_dir=path % 0)
    inner += sweep(start * RectangleRounded(HANDLE_W - 2 * WALL, HANDLE_T - 2 * WALL, HANDLE_R - WALL), path=path)
    shell = outer - inner
    for y in (-yc, yc):                      # screw bosses inside each cup
        for x, by in _boss_xy(y):
            boss = Pos(x, by, BOSS_H / 2) * Cylinder(BOSS_D / 2, BOSS_H)
            shell += boss - Pos(x, by, BOSS_H / 2 - 1) * Cylinder(SCREW_HOLE / 2, BOSS_H)
    # the cord leaves through the mouthpiece cup's end
    shell -= Pos(0, -yc - CUP_D / 2, 3.6) * Rot(90, 0, 0) * Cylinder(CORD_D / 2, WALL * 4)
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
