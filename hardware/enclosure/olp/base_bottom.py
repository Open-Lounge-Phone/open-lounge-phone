"""Base bottom tray: floor + walls up to split_z. Carries the main board (and, through M2.5 hex
standoffs, the key deck), rear USB-C / RJ9 openings, radar window (lower half), status light-line
slot, VOL/MUTE access in the right end wall, feet, wall-mount keyholes, bottom text + logo.
Print: floor on the bed, no supports."""

from __future__ import annotations

from build123d import Axis, Plane, Pos, Text, extrude, mirror

from .common import Geo, box, cbox, cyl, cut_all, insert_hole, union
from .logo import logo_face


def _near(a, b, tol=1.0):
    return abs(a[0] - b[0]) < tol and abs(a[1] - b[1]) < tol


def stack_holes(g: Geo):
    """Deck holes (hex-standoff stacks). Each needs a main-board hole right under it."""
    return list(g.deck_holes)


def bolt_holes(g: Geo):
    """Main-board holes outside the deck footprint: M2.5 from below through tray standoff and
    board into a heat-set insert in the top shell (closes the case, clamps the board)."""
    x0, x1, y0, y1 = g.deck_rect
    return [h for h in g.main_holes if not any(_near(h, d) for d in stack_holes(g))
            and not (x0 - 1 < h[0] < x1 + 1 and y0 - 1 < h[1] < y1 + 1)]


def main_only_holes(g: Geo):
    """Remaining holes (under the deck): insert in the standoff, screw from above."""
    b = bolt_holes(g)
    return [h for h in g.main_holes if not any(_near(h, d) for d in stack_holes(g)) and h not in b]


def port_cuts(g: Geo):
    """Rear USB-C openings (power + handset); cut from both halves (they straddle the split)."""
    p = g.p
    out = []
    for role, key in (("usb_c", "usb_c"), ("usb_handset", "usb_handset")):
        if not g.has_main(role):
            continue
        x0, x1, _, _ = g.main_part_rect(role)
        x = (x0 + x1) / 2
        w, h = p[key]["opening"]
        zc = g.main_zt + p[key]["centre_above_pcb"]
        out.append(box(x - w / 2, x + w / 2, g.D - g.W - 1, g.D + 1, zc - h / 2, zc + h / 2))
        if "recess" in p[key]:
            rw, rh, rd = p[key]["recess"]
            out.append(box(x - rw / 2, x + rw / 2, g.D - rd, g.D + 1, zc - rh / 2, zc + rh / 2))
            # cord channel along the rear face to the left end (right-angle plugs lie flush)
            cn = p["cord_notch"]
            out.append(box(-1, x, g.D - cn["depth"] / 2, g.D + 1, zc - cn["w"] / 2, zc + cn["w"] / 2))
    return out


def keyhole_cuts(g: Geo, x, y):
    k = g.p["base"]["wall_mount"]
    F = g.F
    slot = k["slot"]
    # entry at x, slot toward -x (the base slides down = +x when hung deck-end down)
    cuts = [cyl(x, y, -1, F + k["chamber_h"], k["head_d"]),
            box(x - slot, x, y - k["shank_w"] / 2, y + k["shank_w"] / 2, -1, F + 0.01),
            box(x - slot, x, y - k["head_d"] / 2, y + k["head_d"] / 2, F, F + k["chamber_h"]),
            cyl(x - slot, y, F, F + k["chamber_h"], k["head_d"])]
    return union(cuts)


def keyhole_housing(g: Geo, x, y):
    k = g.p["base"]["wall_mount"]
    top = g.F + k["chamber_h"] + k["roof"]
    w = k["head_d"] + 4
    return union([cyl(x, y, 0, top, w), cyl(x - k["slot"], y, 0, top, w),
                  box(x - k["slot"], x, y - w / 2, y + w / 2, 0, top)])


def build(g: Geo):
    p = g.p
    b = p["base"]
    W, F, zs, c = g.W, g.F, g.zs, g.c
    fx = g.fx

    outer = g.base_outline_prism(0, zs)
    outer = outer.solids()[0].chamfer(b["bottom_chamfer"], None, list(outer.edges().group_by(Axis.Z)[0]))
    tray = outer - g.base_outline_prism(F, zs + 5, inset=W)

    adds, cuts = [], []

    # lip along the long walls (registers the top cover)
    lp = b["lip"]
    ring = g.base_outline_prism(zs, zs + lp["h"], inset=W + c) - g.base_outline_prism(zs - 1, zs + lp["h"] + 1, inset=W + c + lp["t"])
    adds.append(ring & box(b["corner_r"], g.L - b["corner_r"], -1, g.D + 1, zs - 1, zs + lp["h"] + 1))

    # bolts: tray standoff -> board -> top-shell insert (screw from below)
    for x, y in bolt_holes(g):
        adds.append(cyl(x, y, F - 0.1, g.main_zb, p["stack"]["main_standoff_d"]))
        cuts.append(cyl(x, y, -1, g.main_zb + 1, fx["clear_d"]))
        cuts.append(cyl(x, y, -1, fx["cbore_h"], fx["cbore_d"]))
    # main-board standoffs: inserts at the top (screw from above)
    for x, y in main_only_holes(g):
        adds.append(cyl(x, y, F - 0.1, g.main_zb, p["stack"]["main_standoff_d"]))
        cuts.append(insert_hole(x, y, g.main_zb, down=True, g=g, depth=min(fx["insert_depth"], g.main_zb - 0.8)))
    # deck stacks: tray standoff -> main board -> 7 mm hex standoff -> deck; screw from below
    for x, y in stack_holes(g):
        adds.append(cyl(x, y, F - 0.1, g.main_zb, p["stack"]["main_standoff_d"]))
        cuts.append(cyl(x, y, -1, g.main_zb + 1, fx["clear_d"]))
        cuts.append(cyl(x, y, -1, fx["cbore_h"], fx["cbore_d"]))

    # cover towers: screw from below into inserts in the cover bosses
    for x, y in b["towers"]:
        adds.append(cyl(x, y, F - 0.1, zs, 6.4))
        cuts.append(cyl(x, y, -1, zs + 1, fx["clear_d"]))
        cuts.append(cyl(x, y, -1, zs - 6.0, fx["cbore_d"]))

    # wall-mount keyholes (optional)
    wm = b["wall_mount"]
    if wm.get("enabled"):
        for x in wm["x"]:
            adds.append(keyhole_housing(g, x, wm["y"]))
            cuts.append(keyhole_cuts(g, x, wm["y"]))

    # rubber-foot recesses
    ft = b["feet"]
    for x, y in ft["at"]:
        cuts.append(cyl(x, y, -1, ft["depth"], ft["d"]))

    # rear wall: USB-C power + USB-C handset ports
    cuts += port_cuts(g)

    # radar window (lower part; the cover carries the rest): wall thinned from inside
    cuts.append(radar_pocket(g))

    # right end wall: VOL-/VOL+ flexure tabs, MUTE slot
    cuts += side_button_cuts(g)
    adds += side_button_nubs(g)

    # bottom text (mirrored so it reads from below) + owner logo
    tx = b["text"]
    t1 = Pos(tx["at"][0], tx["at"][1] + 5, 0) * Text(tx["line1"], tx["size1"])
    t2 = Pos(tx["at"][0], tx["at"][1] - 5, 0) * Text(tx["line2"], tx["size2"])
    for t in (t1, t2):
        cuts.append(mirror(extrude(t, amount=tx["depth"] + 0.01), Plane.YZ.offset(tx["at"][0])))
    lg = b["logo"]
    if lg.get("enabled"):
        f = logo_face(lg["width"])
        if f is not None:
            f = Pos(lg["at"][0], lg["at"][1], 0) * f
            cuts.append(mirror(extrude(f, amount=lg["depth"] + 0.01), Plane.YZ.offset(lg["at"][0])))

    tray = tray + union(adds)
    tray = cut_all(tray, cuts)
    # nothing may stick out of the outline (lip excepted, it stays inside)
    return tray


def radar_pocket(g: Geo, z_range=None):
    r = g.p["radar"]
    if not g.has_main("radar"):
        return None
    x0, x1, _, _ = g.main_part_rect("radar")
    x = (x0 + x1) / 2
    w, h = r["window"]
    zc = g.main_zt + 1 + r["module"][2] / 2
    return box(x - w / 2, x + w / 2, r["thickness"], g.W + 0.5, zc - h / 2, zc + h / 2)


def side_button_cuts(g: Geo):
    sb = g.p["side_buttons"]
    xw0, xw1 = g.L - g.W, g.L
    zc = g.main_zt + 1.5
    out = []
    tw, th = sb["tab"]
    s = sb["slot"]
    for name, y in sb["at"]:
        if name == "MUTE":
            mw, mh = sb["mute_slot"]
            out.append(box(xw0 - 1, xw1 + 1, y - mw / 2, y + mw / 2, zc - mh / 2, zc + mh / 2))
            continue
        # U-slot around a tab hinged at the bottom
        out.append(box(xw0 - 1, xw1 + 1, y - tw / 2 - s, y - tw / 2, zc - th / 2, zc + th / 2 + s))
        out.append(box(xw0 - 1, xw1 + 1, y + tw / 2, y + tw / 2 + s, zc - th / 2, zc + th / 2 + s))
        out.append(box(xw0 - 1, xw1 + 1, y - tw / 2 - s, y + tw / 2 + s, zc + th / 2, zc + th / 2 + s))
        # thin the tab from outside
        out.append(box(xw0 + sb["tab_t"], xw1 + 1, y - tw / 2, y + tw / 2, zc - th / 2, zc + th / 2))
    return out


def side_button_nubs(g: Geo):
    sb = g.p["side_buttons"]
    zc = g.main_zt + 1.5
    out = []
    for name, y in sb["at"]:
        if name != "MUTE":
            out.append(box(g.L - g.W - sb["nub"], g.L - g.W + 0.01, y - 1.5, y + 1.5, zc + 0.5, zc + 2.5))
    return out
