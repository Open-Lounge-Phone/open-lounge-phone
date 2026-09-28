"""Front status light line: a clear/white PETG bar pressed into the slot in the top shell's front
wall; its inner flange stops it pushing through. Light comes from LEDs on the deck's front edge
(layout requirement). Print flat in translucent filament."""

from __future__ import annotations

from .common import Geo, box


def build(g: Geo):
    lb = g.p["light"]["bar"]
    c = 0.15
    L, h = lb["length"] - 2 * c, lb["h"] - 2 * c
    x0, x1 = g.xc - L / 2, g.xc + L / 2
    front = box(x0, x1, 0.2, g.W + 0.01, lb["z"] - h / 2, lb["z"] + h / 2)
    flange = box(x0 - 2, x1 + 2, g.W + 0.05, g.W + 0.05 + lb["t"], lb["z"] - h / 2 - 1.0, lb["z"] + h / 2 + 1.0)
    return front + flange
