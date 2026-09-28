"""G-type handset (Western Electric G1/G3 proportions, see ENCLOSURE.md for sources/estimates):
octagonal faceted handle with 45 deg end facets, domed cups whose faces are angled toward each
other, 4P4C jack in the mouth-end facet. Split lengthwise on y = 0 into two halves printed flat on
the split face (every outer surface then leans inward: no supports). Receiver ring + grille in the
ear cup, electret ring + ports in the mouth cup, M2.5 screws across the split into heat-set inserts.

Handset coords: x along the length (0 = mouth end), y across, z up; each cup face centre is at
z = 0 (faces tilted by tilt_deg, outer rim lower)."""

from __future__ import annotations

import math

from build123d import Align, Axis, Cylinder, Plane, Polygon, Pos, Rot, extrude, revolve

from .common import Geo, box, cyl, cut_all, prism_x, union


def _dome(R, cyl_h, dome_h, bevel, inset=0.0):
    """Cup body of revolution about z: bevelled face, straight band, elliptical dome."""
    R = R - inset
    z0 = inset
    pts = [(0, z0), (R - bevel, z0), (R, z0 + bevel), (R, cyl_h)]
    n = 16
    H = dome_h - inset
    for k in range(1, n + 1):
        a = (math.pi / 2) * k / n
        pts.append((R * math.cos(a), cyl_h + H * math.sin(a)))
    pts.append((0, cyl_h + H))
    prof = Plane.XZ * Polygon(*[(r, z) for r, z in pts], align=None)
    return Rot(0, 0, 45) * revolve(prof, Axis.Z, 360)      # seam off the y = 0 split plane


def _octagon(w, z0, z1, f):
    hw = w / 2
    return [(-hw + f, z0), (hw - f, z0), (hw, z0 + f), (hw, z1 - f), (hw - f, z1), (-hw + f, z1), (-hw, z1 - f), (-hw, z0 + f)]


def H(g: Geo, model=None) -> dict:
    """Handset family params: default reference model (params.handset) or 'g1'/'pop'."""
    if model is None or model == g.p["handset"]["model"]:
        return g.p["handset"]
    return g.p["handset_alt"]


def cup_xs(h: dict):
    return h["cup_from_end"], h["length"] - h["cup_from_end"]


def cup_tf(h: dict, which: int):
    """Transform placing a cup-local solid (face at z=0, axis +z) at the mouth (0) / ear (1) cup."""
    xm, xe = cup_xs(h)
    x = xm if which == 0 else xe
    a = h["tilt_deg"] * (-1 if which == 0 else 1)          # face normals lean toward each other
    return Pos(x, 0, 0) * Rot(0, a, 0)


def body(h: dict, inset=0.0):
    L = h["length"]
    hd = h["handle"]
    parts = []
    zb = hd["top"] - hd["h"]
    for which, d in ((0, h["mouth_d"]), (1, h["ear_d"])):
        tf = cup_tf(h, which)
        parts.append(tf * _dome(d / 2, h["cup_cyl_h"], h["dome_h"], h["face_bevel"], inset))
        # neck: cone from the dome up into the handle
        from build123d import Cone
        z0 = h["cup_cyl_h"] + 0.45 * h["dome_h"]
        parts.append(tf * (Pos(0, 0, z0) * Rot(0, 0, 45) * Cone(d * 0.40 - inset, hd["w"] * 0.48 - inset, zb + 6 - z0,
                                                             align=(Align.CENTER, Align.CENTER, Align.MIN))))
    # handle: octagonal prism over the full length, 45 deg facets at both top ends
    z1 = hd["top"] - inset
    z0 = hd["top"] - hd["h"] + inset
    bar = prism_x(_octagon(hd["w"] - 2 * inset, z0, z1, max(hd["facet"] - inset * 0.4, 1.0)), inset, L - inset)
    ec = hd["end_chamfer"]
    side = [(inset - 1, z0 - 30), (L - inset + 1, z0 - 30), (L - inset + 1, z1 - ec), (L - inset - ec, z1 + 0.01),
            (inset + ec, z1 + 0.01), (inset - 1, z1 - ec)]
    side_prism = extrude(Plane.XZ * Polygon(*side, align=None), amount=-40, both=True)
    parts.append(bar & side_prism)
    return union(parts)


def shell(h: dict):
    outer = body(h)
    inner = body(h, h["wall"])
    return outer, outer - inner


RECEIVER = {"d": 32.6, "ring_t": 1.5, "ring_h": 3.0, "holes_d": 1.8, "hole_rings": [0, 6.0, 11.0]}
MIC = {"d": 6.4, "ring_t": 1.5, "ring_h": 3.0, "holes_d": 1.2}
USB_PCB = {"size": [30.0, 20.0, 1.6], "rail": 1.6, "port": [9.4, 3.6], "plug_recess": [12.8, 6.8, 1.2]}


def features(h: dict):
    wl = h["wall"]
    adds, cuts = [], []
    rc = RECEIVER
    tf = cup_tf(h, 1)
    adds.append(tf * (cyl(0, 0, wl - 0.01, wl + rc["ring_h"], rc["d"] + 2 * rc["ring_t"]) - cyl(0, 0, 0, 20, rc["d"])))
    for r in rc["hole_rings"]:
        n = 1 if r == 0 else int(round(2 * math.pi * r / 5.5))
        for k in range(n):
            a = 2 * math.pi * k / n + 0.3
            cuts.append(tf * cyl(r * math.cos(a), r * math.sin(a), -1, wl + 0.5, rc["holes_d"]))
    mc = MIC
    tm = cup_tf(h, 0)
    adds.append(tm * (cyl(0, 0, wl - 0.01, wl + mc["ring_h"], mc["d"] + 2 * mc["ring_t"]) - cyl(0, 0, 0, 20, mc["d"])))
    for dx, dy in ((0, 0.9), (1.8, 0.9), (-1.8, 0.9), (0.9, 2.6), (-0.9, -1.2)):
        cuts.append(tm * cyl(dx, dy, -1, wl + 0.5, mc["holes_d"]))
    # USB-C receptacle on a 30 x 20 mm USB-audio PCB in the mouth end of the handle: the PCB slides
    # into rails on both halves; the port opens in the mouth-end facet with a plug-seat recess
    hd = h["handle"]
    pl, pw, pt = USB_PCB["size"]
    zp = hd["top"] - hd["h"] / 2 - 2.0                 # PCB bottom face
    for s_ in (-1, 1):
        for dz in (-1.0 - USB_PCB["rail"], pt + 0.3):
            adds.append(box(wl, wl + pl, s_ * (pw / 2 - 1.0), s_ * (hd["w"] / 2), zp + dz, zp + dz + USB_PCB["rail"]))
    zc = zp + pt + 1.63
    pw_, ph_ = USB_PCB["port"]
    cuts.append(box(-5, wl + 1, -pw_ / 2, pw_ / 2, zc - ph_ / 2, zc + ph_ / 2))
    rw, rh, rd = USB_PCB["plug_recess"]
    cuts.append(box(-5, rd, -rw / 2, rw / 2, zc - rh / 2, zc + rh / 2))
    return adds, cuts


def bosses(h: dict, fx: dict, side: int):
    """side -1: screw-head half (counterbores); +1: insert half."""
    adds, cuts = [], []
    for x, z in h.get("bosses", []):
        adds.append(Pos(x, 0, z) * Rot(90, 0, 0) * cyl(0, 0, -40, 40, fx["boss_d"]))
        if side < 0:
            cuts.append(Pos(x, 0, z) * Rot(90, 0, 0) * cyl(0, 0, -1, 40, fx["clear_d"]))
            cuts.append(Pos(x, 0, z) * Rot(90, 0, 0) * cyl(0, 0, 6.0, 60, fx["cbore_d"]))
        else:
            cuts.append(Pos(x, 0, z) * Rot(90, 0, 0) * cyl(0, 0, -fx["insert_depth"], 0.5, fx["insert_hole_d"]))
    return adds, cuts


def reference(g: Geo, model=None):
    """Solid reference model of an off-the-shelf handset (renders, fit checks, configurator)."""
    h = H(g, model)
    return body(h)


def build(g: Geo, model="g1"):
    """Optional printable DIY halves (left = y < 0, carries the screw heads)."""
    h = dict(H(g, model))
    h.setdefault("bosses", [[62.0, h["handle"]["top"] - h["handle"]["h"] / 2], [108.0, h["handle"]["top"] - h["handle"]["h"] / 2],
                            [h["length"] - 62.0, h["handle"]["top"] - h["handle"]["h"] / 2], [20.0, 22.0], [h["length"] - 20.0, 22.0]])
    outer, sh = shell(h)
    fa, fc = features(h)
    out = []
    for side in (-1, 1):
        ba, bc = bosses(h, g.fx, side)
        half_box = box(-50, 400, 0 if side > 0 else -100, 100 if side > 0 else 0, -50, 150)
        part = (sh + (union(fa + ba) & outer)) & half_box
        part = cut_all(part, fc + bc)
        out.append(part)
    return out[0], out[1]


def rest_location(g: Geo, model=None):
    """Handset coords -> base frame when on the hook (cup faces on the saddle inserts)."""
    h = H(g, model)
    xm, xe = cup_xs(h)
    x0 = g.xc - (xm + xe) / 2
    return Pos(x0, g.posts[0][1], g.face_z)


def placed(g: Geo, part, model=None):
    return rest_location(g, model) * part


def cord_point(g: Geo, model=None):
    """Cable exit (outer end of the mouth cup, low), handset coords."""
    h = H(g, model)
    return (-h["mouth_d"] * 0.02, 0.0, h["cup_cyl_h"] + 4.0)
