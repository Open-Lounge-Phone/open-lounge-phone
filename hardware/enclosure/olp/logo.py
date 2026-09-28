"""Owner signature logo as a build123d face, reused from the traced silkscreen footprint
(hardware/art/make_logo.py -> layout/footprints/openloungephone.pretty/openloungephone_logo_F).
The footprint is a raster of merged rectangles on a 0.05 mm grid at 16 mm width; scaled up for
FDM (at 40 mm the thinnest stroke is ~0.5 mm, printable as a bed-side deboss)."""

from __future__ import annotations

import re
from functools import lru_cache
from pathlib import Path

from build123d import Pos, Rectangle, Sketch

FP = Path(__file__).resolve().parents[2] / "layout/footprints/openloungephone.pretty/openloungephone_logo_F.kicad_mod"


@lru_cache(maxsize=4)
def logo_face(width: float):
    if not FP.exists():
        return None
    rects = []
    for m in re.finditer(r"\(fp_poly \(pts ((?:\(xy [-\d.]+ [-\d.]+\) ?)+)\)", FP.read_text()):
        pts = [(float(a), float(b)) for a, b in re.findall(r"\(xy ([-\d.]+) ([-\d.]+)\)", m.group(1))]
        xs, ys = [q[0] for q in pts], [q[1] for q in pts]
        rects.append((min(xs), min(ys), max(xs), max(ys)))
    if not rects:
        return None
    x0 = min(r[0] for r in rects); x1 = max(r[2] for r in rects)
    y0 = min(r[1] for r in rects); y1 = max(r[3] for r in rects)
    s = width / (x1 - x0)
    cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
    faces = []
    for a, b, c, d in rects:
        w, h = (c - a) * s, (d - b) * s
        # KiCad y is down: flip so the logo reads correctly in the base frame (y up)
        faces.append(Pos(((a + c) / 2 - cx) * s, -((b + d) / 2 - cy) * s) * Rectangle(w + 0.02, h + 0.02))
    sk = faces[0].fuse(*faces[1:]).clean()
    return Sketch() + sk.faces()
