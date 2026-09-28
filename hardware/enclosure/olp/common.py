"""Shared parameters, derived geometry and CAD helpers for the Open Lounge Phone enclosure.

Base frame (mm): x along the length (0 = left end, user facing the front), y front (0) -> rear,
z up from the table. Board frames are KiCad's (x right, y down from the rear-left corner).
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from functools import cached_property
from pathlib import Path

import yaml
from build123d import (
    Align, Box, Cylinder, Face, Kind, Plane, Polygon, Pos, RectangleRounded, Rectangle, Solid, Part,
    Vector, extrude, offset,
)

HERE = Path(__file__).resolve().parent.parent
MIN3 = (Align.MIN, Align.MIN, Align.MIN)
CCM = (Align.CENTER, Align.CENTER, Align.MIN)


def load_params(path: Path | None = None) -> dict:
    return yaml.safe_load((path or HERE / "params.yaml").read_text())


# ---------------------------------------------------------------- primitive helpers
def box(x0, x1, y0, y1, z0, z1) -> Part:
    return Pos(min(x0, x1), min(y0, y1), min(z0, z1)) * Box(abs(x1 - x0), abs(y1 - y0), abs(z1 - z0), align=MIN3)


def cbox(cx, cy, w, h, z0, z1) -> Part:
    return box(cx - w / 2, cx + w / 2, cy - h / 2, cy + h / 2, z0, z1)


def cyl(x, y, z0, z1, d) -> Part:
    return Pos(x, y, min(z0, z1)) * Cylinder(d / 2, abs(z1 - z0), align=CCM)


def rrect_prism(cx, cy, w, h, r, z0, z1) -> Part:
    r = max(0.01, min(r, w / 2 - 0.01, h / 2 - 0.01))
    return extrude(Pos(cx, cy, z0) * RectangleRounded(w, h, r), amount=z1 - z0)


def prism_x(pts_yz, x0, x1) -> Part:
    """Extrude a polygon given in (y, z) along +x from x0 to x1."""
    f = Plane.YZ.offset(x0) * Polygon(*_ccw(list(pts_yz)), align=None)
    return extrude(f, amount=x1 - x0)


def _ccw(pts):
    a = sum(x0 * y1 - x1 * y0 for (x0, y0), (x1, y1) in zip(pts, pts[1:] + pts[:1]))
    return pts if a > 0 else list(reversed(pts))


def prism_z(pts_xy, z0, z1) -> Part:
    return extrude(Pos(0, 0, z0) * Polygon(*_ccw(list(pts_xy)), align=None), amount=z1 - z0)


def union(parts):
    parts = [p for p in parts if p is not None]
    if not parts:
        return None
    out = parts[0]
    for p in parts[1:]:
        out = out + p
    return out


def cut_all(base, tools):
    tools = [t for t in tools if t is not None]
    if not tools:
        return base
    return base - union(tools)


# ---------------------------------------------------------------- derived geometry
@dataclass
class Geo:
    p: dict

    # --- basics
    @property
    def L(self): return self.p["base"]["length"]
    @property
    def D(self): return self.p["base"]["depth"]
    @property
    def H(self): return self.p["base"]["height"]
    @property
    def W(self): return self.p["print"]["wall"]
    @property
    def F(self): return self.p["print"]["floor"]
    @property
    def T(self): return self.p["print"]["top"]
    @property
    def c(self): return self.p["print"]["clearance"]
    @property
    def zs(self): return self.p["base"]["split_z"]
    @property
    def fx(self): return self.p["fasteners"]
    @property
    def boards(self): return self.p["boards"]
    @property
    def xc(self): return self.L / 2

    # --- key stack (captive DSA caps under the skin) -> deck height -> main board height
    @cached_property
    def ks(self):
        k = self.p["keys"]
        d = k["dsa"]
        taper = (d["skirt"] - d["top"]) / d["height"]          # full-width loss per mm of height
        hole = d["skirt"] - 2 * k["overlap"]
        w_at_skin = hole - 2 * k["hole_clearance"]
        g = (d["skirt"] - w_at_skin) / taper                    # skirt below the skin underside
        skin_under = self.H - self.T
        cap_base = skin_under - g
        cap_base_above_pcb = k["plate_top_above_pcb"] + k["cap_top_above_plate"] - d["height"]
        pcb_top = cap_base - cap_base_above_pcb
        plate_top = pcb_top + k["plate_top_above_pcb"]
        pcb_bot = pcb_top - k["pcb_t"]
        return dict(
            taper=taper, hole=hole, w_at_skin=w_at_skin, gap=g, skin_under=skin_under,
            cap_base=cap_base, cap_top=cap_base + d["height"], pcb_top=pcb_top,
            pcb_bot=pcb_bot, plate_top=plate_top, plate_bot=plate_top - k["plate_t"],
            socket_bot=pcb_bot - k["socket_h"],
        )

    @property
    def yc(self): return self.D / 2

    # --- main board: synced from KiCad if it fits the base, else the main_intent requirements
    @cached_property
    def main_overhang(self) -> float:
        parts = self.boards["main"]["parts"]
        ys = [parts[k]["crt"][1] for k in ("usb_c", "rj9") if k in parts and parts[k]["crt"]]
        return max(0.0, -(min(ys) if ys else 0.0) - 0.25)

    @cached_property
    def mb(self) -> dict:
        syn = self.boards["main"]
        w, h = syn["size"]
        inner_w, inner_h = self.L - 2 * self.W - 1.0, self.D - 2 * self.W - self.p["stack"]["rear_gap"] - self.main_overhang
        yrear = self.D - self.W - self.p["stack"]["rear_gap"] - self.main_overhang
        if w <= inner_w and h <= inner_h:
            return dict(source="synced", size=[w, h], holes=syn["holes"], parts=syn["parts"],
                        deck_footprint=syn.get("deck_footprint"), x0=(self.L - w) / 2, yrear=yrear)
        mi = self.p["main_intent"]
        w, h = mi["size"]
        x0 = (self.L - w) / 2
        dw, dh = self.boards["deck"]["size"]
        fp = [round(self.xc - dw / 2 - x0, 3), round(yrear - (self.yc + dh / 2), 3), 0, 0]
        fp[2], fp[3] = round(fp[0] + dw, 3), round(fp[1] + dh, 3)
        to_b = lambda X, Y: [round(X - x0, 3), round(yrear - Y, 3)]
        parts = {}
        for role, v in mi["parts"].items():
            sp = syn["parts"].get(role)
            if v == "post":
                X, Y = self.posts[1]
                bx, by = to_b(X, Y)
            elif v[1] == "rear":
                if sp is None and len(v) > 2:
                    sp = syn["parts"].get(v[2])          # same footprint as another part (e.g. usb_c)
                bx, by = round(v[0] - x0, 3), sp["at"][1]
            else:
                bx, by = to_b(*v)
            crt = None
            if sp and sp.get("crt"):
                ox, oy = sp["at"]
                c = sp["crt"]
                crt = [round(c[0] - ox + bx, 3), round(c[1] - oy + by, 3), round(c[2] - ox + bx, 3), round(c[3] - oy + by, 3)]
            parts[role] = {"ref": (sp["ref"] if sp and role in syn["parts"] else role), "at": [bx, by], "rot": sp["rot"] if sp else 0,
                           "side": "top", "crt": crt}
        # deck-stack holes (hex standoffs) under every deck hole + the shell bolts
        dx0 = x0 + fp[0]
        dyr = yrear - fp[1]
        holes = [to_b(dx0 + hx, dyr - hy) for hx, hy in self.boards["deck"]["holes"]]
        holes += [to_b(*b) for b in mi["bolts"]]
        return dict(source="main_intent (layout requirement: synced board does not fit)", size=[w, h],
                    holes=holes, parts=parts, deck_footprint=fp, x0=x0, yrear=yrear)

    @property
    def main_w(self): return self.mb["size"][0]
    @property
    def main_h(self): return self.mb["size"][1]
    @property
    def main_x0(self): return self.mb["x0"]
    @property
    def main_yrear(self): return self.mb["yrear"]

    @cached_property
    def main_zt(self): return self.ks["pcb_bot"] - self.p["stack"]["hex_standoff"]

    @cached_property
    def main_zb(self): return self.main_zt - self.p["keys"]["pcb_t"]

    def main_xy(self, bx, by):
        return (self.main_x0 + bx, self.main_yrear - by)

    def has_main(self, role):
        return role in self.mb["parts"]

    def main_part_xy(self, role):
        return self.main_xy(*self.mb["parts"][role]["at"])

    def main_part_rect(self, role):
        x0, y0, x1, y1 = self.mb["parts"][role]["crt"]
        a, b = self.main_xy(x0, y0), self.main_xy(x1, y1)
        return (min(a[0], b[0]), max(a[0], b[0]), min(a[1], b[1]), max(a[1], b[1]))

    @property
    def main_holes(self):
        return [self.main_xy(*h) for h in self.mb["holes"]]

    @property
    def main_rect(self):
        return (self.main_x0, self.main_x0 + self.main_w, self.main_yrear - self.main_h, self.main_yrear)

    # --- deck board placement (on the main board's deck footprint)
    @property
    def deck_w(self): return self.boards["deck"]["size"][0]
    @property
    def deck_h(self): return self.boards["deck"]["size"][1]

    @cached_property
    def deck_x0(self):
        fp = self.mb.get("deck_footprint")
        return self.main_x0 + fp[0] if fp else self.xc - self.deck_w / 2

    @cached_property
    def deck_yrear(self):
        fp = self.mb.get("deck_footprint")
        return self.main_yrear - fp[1] if fp else self.yc + self.deck_h / 2

    def deck_xy(self, bx, by):
        return (self.deck_x0 + bx, self.deck_yrear - by)

    def deck_part_xy(self, role):
        return self.deck_xy(*self.boards["deck"]["parts"][role]["at"])

    @property
    def deck_holes(self):
        return [self.deck_xy(*h) for h in self.boards["deck"]["holes"]]

    @property
    def deck_rect(self):
        return (self.deck_x0, self.deck_x0 + self.deck_w, self.deck_yrear - self.deck_h, self.deck_yrear)

    @property
    def keys(self):
        """[(label, x, y)] in protocol order: 1 2 3 4 5 MENU / 6 7 8 9 0 BACK."""
        return [(k[0], *self.deck_xy(k[2], k[3])) for k in self.boards["deck"]["keys"]]

    @cached_property
    def panel_rect(self):
        x0, y0, x1, y1 = self.boards["deck"]["panel"]
        a, b = self.deck_xy(x0, y0), self.deck_xy(x1, y1)
        return (min(a[0], b[0]), max(a[0], b[0]), min(a[1], b[1]), max(a[1], b[1]))

    # --- hook rest: posts at the handset cup centres, handset toward the rear
    @cached_property
    def posts(self):
        h = self.p["hook"]
        y = self.yc + h["handset_y"]
        return [(self.xc - h["post_x_from_centre"], y), (self.xc + h["post_x_from_centre"], y)]

    @cached_property
    def face_z(self):
        """Handset cup-face centre height when on the hook: the handle underside sits
        finger_clearance above the keycap tops."""
        hs = self.p["handset"]["handle"]
        return self.ks["cap_top"] + self.p["hook"]["finger_clearance"] - (hs["top"] - hs["h"])

    @cached_property
    def pl(self):
        """Plunger stack (on-hook). Pin top touches the cup face; the collar inside the tube seats
        the spring and stops against the hub floor off-hook."""
        h = self.p["hook"]
        pp = h["plunger"]
        hall_top = self.main_zt + h["hall"]["package_h"]
        z_mag = hall_top + h["gap_on"]
        pin_top = self.face_z
        hub_bot = self.H + 1.0
        hub_top = pin_top - 1.0
        hub_floor0 = hub_top - 2.0
        collar_top = hub_floor0 - pp["travel"]
        collar_bot = collar_top - 2.0
        floor_top = collar_bot - pp["spring_on"]
        return dict(hall_top=hall_top, z_mag=z_mag, pin_top=pin_top, hub_bot=hub_bot, hub_top=hub_top,
                    hub_floor0=hub_floor0, collar_top=collar_top, collar_bot=collar_bot,
                    sock_floor_top=floor_top, sock_floor_bot=floor_top - 2.0,
                    tube_bot=floor_top, tube_top=hub_floor0, length=pin_top - z_mag,
                    spring_off=pp["spring_on"] + pp["travel"])

    # --- misc
    @cached_property
    def c_i(self):
        """Inner top chamfer that keeps the skin thickness along the 45 deg outer chamfer."""
        ch = self.p["base"]["top_chamfer"]
        return max(0.5, ch - self.T - self.W + self.T * math.sqrt(2))

    def base_outline_prism(self, z0, z1, inset=0.0) -> Part:
        r = self.p["base"]["corner_r"]
        return rrect_prism(self.L / 2, self.D / 2, self.L - 2 * inset, self.D - 2 * inset, max(r - inset, 0.5), z0, z1)


def insert_hole(x, y, z_face, down: bool, g: Geo, depth=None):
    """Heat-set insert hole opening at z_face, going up (down=False) or down into the part."""
    d = depth or g.fx["insert_depth"]
    return cyl(x, y, z_face - d if down else z_face, z_face if down else z_face + d, g.fx["insert_hole_d"])
