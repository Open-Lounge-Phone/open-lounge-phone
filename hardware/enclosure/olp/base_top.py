"""Base top cover: skin over the key deck (12 captive-keycap holes, e-ink window + panel rim,
light tubes), soft 45 deg top chamfer, top-firing speaker box + grille, the two hook-post
mounts (plunger sleeves, rod sockets with grub-screw inserts, printed-post screw holes),
pinholes, mic port, radar window (upper part). Variant 'lite' has no e-ink window.
Print: skin on the bed (upside down), no supports."""

from __future__ import annotations

import math

from build123d import Axis, Pos, Rot

from .common import Geo, box, cbox, cyl, cut_all, insert_hole, rrect_prism, union
from .base_bottom import radar_pocket, port_cuts, bolt_holes
from . import hook


def shell(g: Geo):
    b = g.p["base"]
    zs, H = g.zs, g.H
    outer = g.base_outline_prism(zs, H)
    outer = outer.solids()[0].chamfer(b["top_chamfer"], None, list(outer.edges().group_by(Axis.Z)[-1]))
    cav = g.base_outline_prism(zs - 5, H - g.T, inset=g.W)
    cav = cav.solids()[0].chamfer(g.c_i, None, list(cav.edges().group_by(Axis.Z)[-1]))
    return outer, cav


def inner_clip(g: Geo):
    """Region inside the cover's outer envelope (for clipping bosses that reach the skin)."""
    b = g.p["base"]
    o = g.base_outline_prism(0, g.H)
    return o.solids()[0].chamfer(b["top_chamfer"], None, list(o.edges().group_by(Axis.Z)[-1]))


def speaker_box(g: Geo):
    sp = g.p["speaker"]
    sx, sy, _ = sp["size"]
    cx, cy = sp["centre"]
    iw, ih = sx + 1.0, sy + 1.0
    ow, oh = iw + 2 * sp["wall"], ih + 2 * sp["wall"]
    z0 = sp["bottom_z"] + sp["lid_t"]
    walls = cbox(cx, cy, ow, oh, z0, g.H - 0.5) - cbox(cx, cy, iw, ih, z0 - 1, g.H)
    by_ = cy + oh / 2 + 2.5                              # two screws on the rear side of the box
    bosses = [cyl(cx + s * 7.0, by_, z0, g.H - 0.5, 6.5) for s in (-1, 1)]
    holes = [insert_hole(cx + s * 7.0, by_, z0, down=False, g=g) for s in (-1, 1)]
    # grille through the skin over the cone
    grille = []
    pt = sp["grille_pitch"]
    nx, ny = int((sx - 2) // pt), int((sy - 2) // pt)
    for i in range(nx + 1):
        for j in range(ny + 1):
            x = cx - (nx * pt) / 2 + i * pt
            y = cy - (ny * pt) / 2 + j * pt + (pt / 2 if i % 2 else 0)
            if abs(y - cy) <= sy / 2 - 1.5:
                grille.append(cyl(x, y, g.H - g.T - 1, g.H + 1, sp["grille_d"]))
    wire = Pos(cx + ow / 2 - sp["wall"] / 2, cy + ih / 2 - 4, z0 + 3) * Rot(0, 90, 0) * cyl(0, 0, -3, 3, sp["wire_hole_d"])
    return union([walls] + bosses), holes + grille + [wire], dict(cx=cx, cy=cy, ow=ow, oh=oh, z0=z0)


def port_labels(g: Geo):
    from build123d import Plane, Text, extrude
    pl = g.p["port_labels"]
    out = []
    for role, txt in (("usb_c", pl["power"]), ("usb_handset", pl["handset"])):
        if not g.has_main(role):
            continue
        x0, x1, _, _ = g.main_part_rect(role)
        x = (x0 + x1) / 2
        plane = Plane(origin=(x, g.D, pl["z"]), x_dir=(-1, 0, 0), z_dir=(0, 1, 0))
        out.append(extrude(plane * Text(txt, pl["size"]), amount=-pl["depth"]))
    return out


def build(g: Geo, variant: str = "eink"):
    p = g.p
    k = g.ks
    H, T, zs = g.H, g.T, g.zs
    outer, cav = shell(g)
    top = outer - cav
    adds, cuts = [], []

    # lip clearance is built in (cavity is inset by the wall; the tray lip sits inside it)

    # bolt bosses: insert at the bottom (on the main board), screw from below through the tray
    for x, y in bolt_holes(g):
        adds.append(cyl(x, y, g.main_zt, H - 0.5, p["fasteners"]["boss_d"]))
        cuts.append(insert_hole(x, y, g.main_zt, down=False, g=g))

    # key holes: rounded squares, smaller than the DSA skirt -> captive caps
    kk = p["keys"]
    for _, x, y in g.keys:
        cuts.append(rrect_prism(x, y, k["hole"], k["hole"], kk["hole_r"], H - T - 1, H + 1))

    # e-ink: view window through the skin + a locating rim for the panel under it
    e = p["eink"]
    x0, x1, y0, y1 = g.panel_rect
    pw, ph = x1 - x0 + 2 * e["pocket_clear"], y1 - y0 + 2 * e["pocket_clear"]
    pcx, pcy = (x0 + x1) / 2, (y0 + y1) / 2
    if variant == "eink":
        rim = cbox(pcx, pcy, pw + 2 * e["rim_t"], ph + 2 * e["rim_t"], k["skin_under"] - e["rim_h"], k["skin_under"] + 0.01) \
            - cbox(pcx, pcy, pw, ph, k["skin_under"] - e["rim_h"] - 1, k["skin_under"] + 1) \
            - cbox(x1 + e["rim_t"] / 2, pcy, e["rim_t"] * 3, e["fpc_notch"], k["skin_under"] - e["rim_h"] - 1, k["skin_under"] + 1)
        adds.append(rim)
        vx, vy = e["view"]
        vcx, vcy = pcx + e["view_offset"][0], pcy + e["view_offset"][1]
        cuts.append(cbox(vcx, vcy, vx, vy, H - T - 1, H + 1))
        # outward 45 deg chamfer on the window edge so the skin doesn't shadow the panel
        ch = e["view_chamfer"]
        cuts.append(cbox(vcx, vcy, vx + 2 * ch, vy + 2 * ch, H - ch, H + 1))

    # light tubes: status LED, privacy LED, ambient-light sensor
    L = p["light"]
    for role, dk in (("status_led", "status_d"), ("privacy_led", "privacy_d"), ("als", "als_d")):
        if role in g.boards["deck"]["parts"]:
            x, y = g.deck_part_xy(role)
            d = L[dk]
            adds.append(cyl(x, y, k["plate_top"] + L["gap_to_plate"], H - 0.5, d + 2 * L["tube_wall"]))
            cuts.append(cyl(x, y, k["plate_top"], H + 1, d))

    # top-firing speaker box (lid screwed from below)
    sb, sc, _ = speaker_box(g)
    adds.append(sb)
    cuts += sc

    # hook posts: tube sockets (floor + plunger bore + grub-screw insert)
    for i in (0, 1):
        a, c_ = hook.socket_features(g, i)
        adds += a
        cuts += c_

    # reset / boot pinholes with guide tubes down to the tact switches
    ph_ = p["pinholes"]
    for role in ("reset", "boot"):
        if g.has_main(role):
            x, y = g.main_part_xy(role)
            zb = g.main_zt + ph_["switch_h"] + ph_["gap"]
            adds.append(cyl(x, y, zb, H - 0.5, ph_["tube_d"]))
            cuts.append(cyl(x, y, zb - 1, H + 1, ph_["d"]))

    # base microphone port: tube from the skin down to just above the capsule
    mp = p["mic_port"]
    if g.has_main("mic"):
        x, y = g.main_part_xy("mic")
        zb = g.main_zt + mp["capsule_h"] + mp["gap"]
        adds.append(cyl(x, y, zb, H - 0.5, mp["tube_d"]))
        cuts.append(cyl(x, y, zb - 1, H + 1, mp["d"]))

    # radar window (upper part), rear ports (upper part), front status light line
    cuts.append(radar_pocket(g))
    cuts += port_cuts(g)
    lb = p["light"]["bar"]
    cuts.append(box(g.xc - lb["length"] / 2, g.xc + lb["length"] / 2, -1, g.W + 1, lb["z"] - lb["h"] / 2, lb["z"] + lb["h"] / 2))
    # port labels debossed in the rear face above each port
    cuts += port_labels(g)

    top = top + (union(adds) & inner_clip(g))
    top = cut_all(top, cuts)
    return top
