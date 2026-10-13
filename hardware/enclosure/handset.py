"""An Opis 60s Micro-shaped handset, modelled as one closed solid: build/handset/opis.{step,stl}.

For renders (the teaser, the ceramic wall-unit render): two domed cups on a flat base ring, joined
by a broad flat-topped handle on a gentle arch. Lying on its cups (cups down, -z), long axis y,
centred on x = y = 0, base at z = 0. Sizes are the handset's outline (210 mm long), not its inside.

    .venv/bin/python handset.py
"""
from __future__ import annotations

from pathlib import Path

from build123d import (Cylinder, Plane, Pos, RectangleRounded, Sphere, ThreePointArc, Box,
                       export_step, export_stl, fillet, sweep)

OUT = Path(__file__).resolve().parent / "build" / "handset"

LENGTH = 210.0        # end to end
CUP_D = 68.0          # the cups' base ring
RING_T = 5.0          # its thickness
DOME_H = 31.0         # the dome over the ring
HANDLE_W, HANDLE_T, HANDLE_R = 44.0, 22.0, 8.0   # the handle's section: width, thickness, corners
ARCH_END_Z, ARCH_MID_Z = 30.0, 36.0              # the handle's centre line: at the cups, mid-way


def cup(y: float):
    ring = Pos(0, y, 0) * Cylinder(CUP_D / 2, RING_T, align=(None, None, None))
    ring = Pos(0, 0, RING_T / 2) * ring
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


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    h = build()
    export_step(h, str(OUT / "opis.step"))
    export_stl(h, str(OUT / "opis.stl"), tolerance=0.02, angular_tolerance=0.15)
    bb = h.bounding_box()
    print(f"handset {bb.size.X:.1f} x {bb.size.Y:.1f} x {bb.size.Z:.1f} mm, {len(h.solids())} solid(s), "
          f"valid {h.is_valid}")


if __name__ == "__main__":
    main()
