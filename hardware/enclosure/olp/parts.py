"""Part registry: every printed part, its print orientation, and the reference parts used for
checks, renders and the web configurator. Built once per run and cached."""

from __future__ import annotations

from dataclasses import dataclass, field
from functools import cached_property

from build123d import Pos, Rot

from .common import Geo
from . import base_bottom, base_top, handset, hook, key_plate, light_bar, refparts, speaker_lid


@dataclass
class P:
    name: str
    shape: object                 # assembled (on-hook) position, base frame, mm
    printed: bool = True
    orient: object = None         # Location applied before dropping to the bed (None = as is)
    color: str = "#e8e1d1"
    role: str = ""
    recolourable: bool = True
    qty: int = 1
    note: str = ""
    material: str = "PETG"
    supports: bool = False        # True only for the optional DIY handset (inner cavity ceilings)


def _flip():
    return Rot(180, 0, 0)


class Build:
    def __init__(self, g: Geo, with_diy_handset=True):
        self.g = g
        self.with_diy_handset = with_diy_handset

    @cached_property
    def printed(self) -> list[P]:
        g = self.g
        out = [
            P("base_top", base_top.build(g, "eink"), orient=_flip(), role="base_top",
              note="skin down; e-ink window"),
            P("base_top_lite", base_top.build(g, "lite"), orient=_flip(), role="base_top_lite",
              note="skin down; Kids Lite (no window)"),
            P("base_bottom", base_bottom.build(g), color="#8e8a82", role="base_bottom", note="floor down"),
            P("speaker_lid", speaker_lid.build(g), color="#8e8a82", role="speaker_lid", recolourable=False),
            P("light_bar", light_bar.build(g), orient=Rot(-90, 0, 0), color="#f4f4ee", role="light_bar",
              recolourable=False, note="translucent PETG, flange face down", material="PETG clear"),
            P("key_plate_printed", key_plate.build(g), color="#3a3a3a", role="key_plate", recolourable=False,
              note="alternative to the FR4 plate; 100 % infill", material="PETG/PLA"),
        ]
        for m in g.p["hook"]["inserts"]:
            for i, side in ((0, "left"), (1, "right")):
                out.append(P(f"saddle_{m}_{side}", hook.cradle(g, i, m), color="#2e2e30", role=f"hook_rest_saddle_{m}",
                             note=f"saddle insert for {m} handsets, bottom down"))
        out.append(P("plunger", hook.plunger(g, 1), color="#b8412a", role="plunger", qty=2, recolourable=True,
                     note="tip (magnet end) down"))
        if self.with_diy_handset:
            l, r = handset.build(g, "g1")
            out.append(P("handset_diy_g1_left", l, orient=Rot(-90, 0, 0), role="handset_diy_left", supports=True,
                         note="OPTIONAL DIY G1 handset, split face down, tree supports inside"))
            out.append(P("handset_diy_g1_right", r, orient=Rot(90, 0, 0), role="handset_diy_right", supports=True,
                         note="OPTIONAL DIY G1 handset, split face down, tree supports inside"))
        return out

    @cached_property
    def refs(self) -> dict:
        g = self.g
        return {
            "main_pcb": refparts.main_pcb(g),
            "deck_pcb": refparts.deck_pcb(g),
            "key_plate": key_plate.build(g),
            "switches": refparts.switches(g),
            "keycaps": refparts.keycaps(g),
            "eink": refparts.eink_panel(g),
            "speaker": refparts.speaker(g),
            "usb": refparts.usb_bodies(g),
            "radar": refparts.radar_module(g),
            "hex_standoffs": refparts.hex_standoffs(g),
            "tubes": [hook.tube(g, i) for i in (0, 1)],
            "plungers": [hook.plunger(g, i) for i in (0, 1)],
            "magnets": [hook.magnet(g, i) for i in (0, 1)],
            "springs": [hook.spring_solid(g, i) for i in (0, 1)],
            "handset_pop": handset.placed(g, handset.reference(g, "pop"), "pop"),
            "handset_g1": handset.placed(g, handset.reference(g, "g1"), "g1"),
        }

    def part(self, name) -> P:
        return next(p for p in self.printed if p.name == name)


def to_bed(shape, orient):
    """Apply the print orientation and drop the part onto z = 0 at the origin."""
    s = orient * shape if orient is not None else shape
    bb = s.bounding_box()
    return Pos(-(bb.min.X + bb.max.X) / 2, -(bb.min.Y + bb.max.Y) / 2, -bb.min.Z) * s
