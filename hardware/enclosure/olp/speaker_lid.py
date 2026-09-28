"""Lid closing the back of the top-firing speaker box (screwed from below into the box's two
inserts; foam pad between lid and speaker magnet presses the speaker onto its gasket).
Print flat."""

from __future__ import annotations

from .common import Geo, cbox, cyl, cut_all


def build(g: Geo):
    sp = g.p["speaker"]
    sx, sy, _ = sp["size"]
    cx, cy = sp["centre"]
    ow, oh = sx + 1.0 + 2 * sp["wall"], sy + 1.0 + 2 * sp["wall"]
    z0 = sp["bottom_z"]
    z1 = z0 + sp["lid_t"]
    lid = cbox(cx, cy + 3.0, ow, oh + 6.0, z0, z1)
    # front locating tongue (sits inside the box's front wall)
    lid = lid + cbox(cx, cy - oh / 2 + sp["wall"] + 1.25, 10.0, 1.5, z1 - 0.01, z1 + 2.5)
    cuts = [cyl(cx + s * 7.0, cy + oh / 2 + 2.5, z0 - 1, z1 + 1, g.fx["clear_d"]) for s in (-1, 1)]
    return cut_all(lid, cuts)
