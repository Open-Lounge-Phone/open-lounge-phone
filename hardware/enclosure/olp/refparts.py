"""Reference (non-printed) parts for fit checks, renders and the web configurator: boards,
key plate (FR4), MX switches, DSA keycaps, e-ink panel, speaker, USB-C bodies, radar module,
hex standoffs. Envelope models, not detailed CAD."""

from __future__ import annotations

from build123d import Pos, RectangleRounded, loft

from .common import Geo, box, cbox, cyl, rrect_prism, union


def main_pcb(g: Geo):
    x0, x1, y0, y1 = g.main_rect
    r = g.p["main_intent"].get("corner_r", 1.5)
    return rrect_prism((x0 + x1) / 2, (y0 + y1) / 2, x1 - x0, y1 - y0, r, g.main_zb, g.main_zt)


def deck_pcb(g: Geo):
    x0, x1, y0, y1 = g.deck_rect
    return rrect_prism((x0 + x1) / 2, (y0 + y1) / 2, x1 - x0, y1 - y0, 1.5, g.ks["pcb_bot"], g.ks["pcb_top"])


def keycap_local(p, dz=0.0):
    """DSA 1u envelope, base at z=0 (hollow skirt, stem socket)."""
    d = p["keys"]["dsa"]
    outer = loft([Pos(0, 0, 0) * RectangleRounded(d["skirt"], d["skirt"], d["corner_r"]),
                  Pos(0, 0, d["height"]) * RectangleRounded(d["top"], d["top"], 2.0)])
    inner = loft([Pos(0, 0, -0.01) * RectangleRounded(d["skirt"] - 2.4, d["skirt"] - 2.4, 1.0),
                  Pos(0, 0, d["height"] - 1.6) * RectangleRounded(d["top"] - 2.4, d["top"] - 2.4, 1.0)])
    stem = cyl(0, 0, 1.0, d["height"] - 1.5, 5.5) - (box(-2.1, 2.1, -0.65, 0.65, 0, 20) + box(-0.65, 0.65, -2.1, 2.1, 0, 20))
    return Pos(0, 0, dz) * (outer - inner + stem)


def keycaps(g: Geo, dz=0.0):
    k = g.ks
    return [Pos(x, y, k["cap_base"] + dz) * keycap_local(g.p) for _, x, y in g.keys]


def mx_switch_local(stem_only=False):
    """MX switch envelope: plate top at z=0 (bottom housing below, top housing + stem above)."""
    bottom = cbox(0, 0, 13.9, 13.9, -5.0, 0.0) + cbox(0, 0, 15.6, 15.6, -0.01, 1.0)
    top = loft([Pos(0, 0, 1.0) * RectangleRounded(15.6, 15.6, 1.0), Pos(0, 0, 6.6) * RectangleRounded(11.0, 11.6, 1.0)])
    stem = box(-2.0, 2.0, -0.6, 0.6, 6.6, 10.2) + box(-0.6, 0.6, -2.0, 2.0, 6.6, 10.2) + cyl(0, 0, 5.0, 6.7, 5.5)
    return stem if stem_only else (bottom + top)


def switches(g: Geo):
    z = g.ks["plate_top"]
    return [Pos(x, y, z) * mx_switch_local() for _, x, y in g.keys]


def fr4_plate(g: Geo):
    from . import key_plate
    return key_plate.build(g)


def eink_panel(g: Geo):
    x0, x1, y0, y1 = g.panel_rect
    t = g.p["eink"]["panel_t"]
    z1 = g.ks["skin_under"]
    return box(x0, x1, y0, y1, z1 - t, z1)


def speaker(g: Geo):
    sp = g.p["speaker"]
    sx, sy, sh = sp["size"]
    cx, cy = sp["centre"]
    z1 = g.ks["skin_under"]
    return cbox(cx, cy, sx, sy, z1 - sh, z1)


def usb_bodies(g: Geo):
    out = []
    w, d, h = g.p["ref"]["usb_body"]
    for role in ("usb_c", "usb_handset"):
        if g.has_main(role):
            x0, x1, _, _ = g.main_part_rect(role)
            x = (x0 + x1) / 2
            out.append(box(x - w / 2, x + w / 2, g.D - g.W - g.p["stack"]["rear_gap"] - d, g.D - g.W - g.p["stack"]["rear_gap"], g.main_zt, g.main_zt + h))
    return out


def radar_module(g: Geo):
    r = g.p["radar"]
    if not g.has_main("radar"):
        return None
    x0, x1, y0, y1 = g.main_part_rect("radar")
    w, t, h = r["module"]
    x = (x0 + x1) / 2
    yf = y0 - 0.5                        # module face just ahead of the socket
    return box(x - w / 2, x + w / 2, yf, yf + t, g.main_zt + 1.0, g.main_zt + 1.0 + h)


def hex_standoffs(g: Geo):
    return [cyl(x, y, g.main_zt, g.ks["pcb_bot"], 5.0) for x, y in g.deck_holes]
