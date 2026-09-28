"""Hook rest: two low cradles carrying a G-type handset by its cups, above/behind the keypad.

Per post (i = 0 left, 1 right):
  tube      drop-in metal tube (12 x 1 mm aluminium/brass, straight cut) standing in a socket in
            the top shell; houses the spring and guides the plunger
  cradle    printed crescent seat (outboard half of the cup, tilted like the cup face) + hub that
            caps the tube; the plunger pin pokes through the hub
  plunger   printed Ø6 pin with a Ø9 collar (spring seat + up-stop against the hub floor) and a
            3 x 1.5 mm magnet pressed into its tip, which sits gap_on above the DRV5032 on-hook
The handset face pushes the pin flush with the seat; off-hook the spring lifts it by `travel`.
All builders return parts in the assembled (on-hook) position."""

from __future__ import annotations

import math

from build123d import Pos, Rot

from .common import Geo, box, cyl, cut_all, insert_hole, prism_z, union


def _tilt_sign(i):
    return -1 if i == 0 else 1          # outward direction along x


def tube(g: Geo, i: int):
    t = g.p["hook"]["tube"]
    px, py = g.posts[i]
    return cyl(px, py, g.pl["tube_bot"], g.pl["tube_top"], t["od"]) - cyl(px, py, 0, 200, t["od"] - 2 * t["wall"])


def seat_centre(g: Geo, i: int, model=None):
    from .handset import H, cup_xs
    h = H(g, model)
    xm, xe = cup_xs(h)
    return (g.xc + _tilt_sign(i) * (xe - xm) / 2, g.posts[i][1])


def face_plane(g: Geo, i: int, model=None):
    """Location whose XY plane is the handset cup face (tilted, outer rim lower)."""
    from .handset import H
    cx, cy = seat_centre(g, i, model)
    return Pos(cx, cy, g.face_z) * Rot(0, _tilt_sign(i) * H(g, model)["tilt_deg"], 0)


def cradle(g: Geo, i: int, model=None):
    """Printed saddle insert for one handset family (seat centred on that family's cup)."""
    h = g.p["hook"]
    d = h["dish"]
    px, py = g.posts[i]
    out = _tilt_sign(i)
    pl = g.pl
    cx, cy = seat_centre(g, i, model)
    R = d["d"] / 2
    xin = px - out * 8.0                                   # inboard edge (covers the hub)
    n = 24
    arc = [(cx + out * R * math.cos(a), cy + R * math.sin(a)) for a in [(-math.pi / 2 + math.pi * k / n) for k in range(n + 1)]]
    plan = [(xin, cy - R)] + arc + [(xin, cy + R)]
    slab = prism_z(plan, pl["hub_bot"] - 20, pl["pin_top"] + 20)
    fp = face_plane(g, i, model)
    big = box(-300, 300, -300, 300, -400, 0)
    # solid block from a flat bottom (H + 0.5) up to the seat plane: prints bottom-down, no overhangs
    seat = slab & (fp * big)
    rim = prism_z(plan, 0, 200) - Pos(cx, cy, 0) * cyl(0, 0, -1, 300, 2 * (R - 3))
    rim = rim - box(xin - out * 1 - 50 * (out < 0), xin + 50 * (out > 0) - 0 * out, -300, 300, -1, 300) if False else rim
    rim = rim & (fp * box(-300, 300, -300, 300, -d["t"], d["rim_h"]))
    rim = rim & box(min(cx, cx + out * 400), max(cx, cx + out * 400), -300, 300, -100, 300)   # outboard half only
    hub = cyl(px, py, pl["hub_bot"], pl["hub_top"], 16.0) & (fp * box(-300, 300, -300, 300, -400, -0.5))
    part = seat + rim + hub
    t = h["tube"]
    cuts = [cyl(px, py, pl["hub_bot"] - 1, pl["hub_floor0"], t["od"] + 0.25),       # tube socket
            cyl(px, py, pl["hub_bot"] - 1, pl["pin_top"] + 30, h["plunger"]["bore"])]
    zi = (pl["hub_bot"] + pl["hub_floor0"]) / 2
    cuts.append(Pos(px, py, zi) * Rot(90, 0, 0) * cyl(0, 0, 3.0, 9.0, g.fx["insert_hole_d"]))
    part = part - box(-300, 500, -300, 300, -50, g.H + 0.5)
    return cut_all(part, cuts)


def pin_press(g: Geo, i: int, model=None):
    """How far the handset face sits above the nominal pin top at the pin (mm; >0 = less pressed)."""
    from .handset import H
    cx, _ = seat_centre(g, i, model)
    px, _ = g.posts[i]
    return abs(cx - px) * math.tan(math.radians(H(g, model)["tilt_deg"]))


def plunger(g: Geo, i: int, lift=0.0):
    h = g.p["hook"]
    pp = h["plunger"]
    mg = h["magnet"]
    px, py = g.posts[i]
    pl = g.pl
    pin = cyl(px, py, pl["z_mag"], pl["pin_top"], pp["d"])
    from build123d import Cone, Align
    collar = cyl(px, py, pl["collar_bot"], pl["collar_top"], pp["collar_d"])
    cone_h = (pp["collar_d"] - pp["d"]) / 2                 # 45 deg underside (prints tip-down)
    collar = collar + Pos(px, py, pl["collar_bot"] - cone_h) * Cone(pp["d"] / 2, pp["collar_d"] / 2, cone_h,
                                                                     align=(Align.CENTER, Align.CENTER, Align.MIN))
    part = (pin + collar) - cyl(px, py, pl["z_mag"] - 1, pl["z_mag"] + mg["h"], mg["d"] + 0.05)
    # small dome-ish chamfer on the pin tip (touches the cup face)
    part = part - (cyl(px, py, pl["pin_top"] - 0.6, pl["pin_top"] + 1, pp["d"] + 2) - cyl(px, py, pl["pin_top"] - 1, pl["pin_top"] + 2, pp["d"] - 1.2))
    return Pos(0, 0, lift) * part if lift else part


def magnet(g: Geo, i: int, lift=0.0):
    mg = g.p["hook"]["magnet"]
    px, py = g.posts[i]
    return cyl(px, py, g.pl["z_mag"] + lift, g.pl["z_mag"] + mg["h"] + lift, mg["d"])


def spring_solid(g: Geo, i: int, off_hook=False):
    sp = g.p["hook"]["spring"]
    px, py = g.posts[i]
    z0 = g.pl["sock_floor_top"]
    L = g.pl["spring_off"] if off_hook else g.p["hook"]["plunger"]["spring_on"]
    return cyl(px, py, z0, z0 + L, sp["od"]) - cyl(px, py, z0 - 1, z0 + L + 1, sp["od"] - 2 * sp["wire"])


def socket_features(g: Geo, i: int):
    """(adds, cuts) for the top shell: tube socket boss with a floor, plunger bore, grub insert."""
    t = g.p["hook"]["tube"]
    pl = g.pl
    px, py = g.posts[i]
    out = _tilt_sign(i)
    adds = [cyl(px, py, pl["sock_floor_bot"], g.H - 0.5, t["od"] + 5.0)]
    cuts = [cyl(px, py, pl["sock_floor_top"], g.H + 1, t["od"] + 0.25),
            cyl(px, py, pl["sock_floor_bot"] - 1, pl["sock_floor_top"] + 0.1, g.p["hook"]["plunger"]["bore"])]
    zi = pl["sock_floor_top"] + 4.0
    cuts.append(Pos(px + out * 0.0, py, zi) * Rot(90, 0, 0) * cyl(0, 0, -9.0, -3.0, g.fx["insert_hole_d"]))
    return adds, cuts


# ---------------------------------------------------------------- models
def magnet_field_mT(br_T, d, h, z):
    """On-axis field of a cylindrical magnet at distance z from its face (mT)."""
    R, L = d / 2, h
    return 1000 * br_T / 2 * ((z + L) / math.sqrt(R * R + (z + L) ** 2) - z / math.sqrt(R * R + z * z))


def cut_list(g: Geo) -> dict:
    t = g.p["hook"]["tube"]
    return dict(tube_od=t["od"], tube_wall=t["wall"], tube_len=round(g.pl["tube_top"] - g.pl["tube_bot"], 1), qty=2)
