"""Automated checks: bed fit, board fit, hole/standoff alignment, interference, captive keycaps,
wall parameters, overhangs (support-free printing), hook sensing (field model), spring vs handset
weight, finger clearance, overall height, radar distance. Results -> build/checks.{json,txt}."""

from __future__ import annotations

import json
import math

import numpy as np
from build123d import Pos, Vector

from .common import Geo, union
from . import base_bottom, handset, hook
from .parts import Build, to_bed
from .render import mesh_of

PASS, WARN, FAIL = "PASS", "WARN", "FAIL"


class Report:
    def __init__(self):
        self.rows = []

    def add(self, group, name, status, detail):
        self.rows.append(dict(group=group, check=name, status=status, detail=detail))

    @property
    def failed(self):
        return [r for r in self.rows if r["status"] == FAIL]

    def text(self):
        out = []
        for r in self.rows:
            out.append(f"[{r['status']}] {r['group']}: {r['check']} - {r['detail']}")
        n = {s: sum(1 for r in self.rows if r["status"] == s) for s in (PASS, WARN, FAIL)}
        out.append(f"\n{n[PASS]} pass, {n[WARN]} warn, {n[FAIL]} fail")
        return "\n".join(out)


def _vol(a, b):
    try:
        x = a & b
        return 0.0 if x is None else float(x.volume)
    except Exception:
        return float("nan")


def _u(x):
    return union(x) if isinstance(x, list) else x


def _vertical_hits(T, pts):
    """Lowest z above each (x, y, z0) point where a vertical ray hits the triangles T (n,3,3)."""
    out = np.full(len(pts), np.inf)
    a, b, c = T[:, 0], T[:, 1], T[:, 2]
    v0, v1 = b[:, :2] - a[:, :2], c[:, :2] - a[:, :2]
    den = v0[:, 0] * v1[:, 1] - v1[:, 0] * v0[:, 1]
    good = np.abs(den) > 1e-12
    a, b, c, v0, v1, den = a[good], b[good], c[good], v0[good], v1[good], den[good]
    for k, (x, y, z0) in enumerate(pts):
        w = np.c_[x - a[:, 0], y - a[:, 1]]
        u = (w[:, 0] * v1[:, 1] - v1[:, 0] * w[:, 1]) / den
        v = (v0[:, 0] * w[:, 1] - w[:, 0] * v0[:, 1]) / den
        inside = (u >= 0) & (v >= 0) & (u + v <= 1)
        if inside.any():
            z = a[inside, 2] + u[inside] * (b[inside, 2] - a[inside, 2]) + v[inside] * (c[inside, 2] - a[inside, 2])
            z = z[z >= z0]
            if len(z):
                out[k] = z.min()
    return out


def run(g: Geo, B: Build) -> Report:
    R = Report()
    p = g.p
    c = g.c
    top = B.part("base_top").shape
    bot = B.part("base_bottom").shape
    refs = B.refs

    # ---- bed fit (print orientation)
    bx, by, bz = p["print"]["bed"]
    for part in B.printed:
        s = to_bed(part.shape, part.orient)
        bb = s.bounding_box()
        dims = sorted([bb.size.X, bb.size.Y])
        ok = dims[1] <= max(bx, by) and dims[0] <= min(bx, by) and bb.size.Z <= bz
        R.add("bed", part.name, PASS if ok else FAIL, f"{bb.size.X:.1f} x {bb.size.Y:.1f} x {bb.size.Z:.1f} mm on {bx} x {by}")

    # ---- boards inside the walls
    ix0, ix1, iy0, iy1 = g.W, g.L - g.W, g.W, g.D - g.W
    for nm, (x0, x1, y0, y1) in (("main board", g.main_rect), ("deck board", g.deck_rect)):
        m = min(x0 - ix0, ix1 - x1, y0 - iy0, iy1 - y1)
        R.add("fit", f"{nm} inside walls", PASS if m >= c else FAIL,
              f"min gap to inner wall {m:.2f} mm (>= {c}); board {x1 - x0:.1f} x {y1 - y0:.1f}")
    R.add("fit", "main board source", PASS if g.mb["source"] == "synced" else WARN, g.mb["source"])
    R.add("fit", "parts allowed under the deck", PASS,
          f"<= {g.ks['socket_bot'] - g.main_zt - 0.5:.1f} mm tall (deck sockets at z {g.ks['socket_bot']:.2f}, main top {g.main_zt:.2f})")

    # ---- holes vs standoffs / bosses (probe the solids)
    def inside(s, x, y, z):
        try:
            return s.is_inside(Vector(x, y, z))
        except Exception:
            return False
    bad = []
    for x, y in g.main_holes:
        z = g.main_zb - 0.6
        if not inside(bot, x + 2.9, y, z) or inside(bot, x, y, z):
            bad.append(f"tray@({x:.1f},{y:.1f})")
    for x, y in base_bottom.bolt_holes(g):
        z = g.main_zt + 0.6
        if not inside(top, x + 3.0, y, z) or inside(top, x, y, z):
            bad.append(f"shell@({x:.1f},{y:.1f})")
    R.add("holes", "board holes land on standoffs / bosses (probe)", PASS if not bad else FAIL,
          f"{len(g.main_holes)} main holes, {len(base_bottom.bolt_holes(g))} shell bolts" + (f"; bad: {bad}" if bad else ""))
    miss = [h for h in g.deck_holes if not any(abs(h[0] - m[0]) < 0.3 and abs(h[1] - m[1]) < 0.3 for m in g.main_holes)]
    R.add("holes", "deck holes have a main-board hole below (hex standoffs)", PASS if not miss else FAIL,
          "all 5 aligned" if not miss else f"missing under {miss}")

    # ---- interference (assembled, on-hook)
    tol = 0.5
    pairs = [
        ("top shell", top, "bottom tray", bot),
        ("top shell", top, "main PCB", refs["main_pcb"]), ("bottom tray", bot, "main PCB", refs["main_pcb"]),
        ("top shell", top, "deck PCB", refs["deck_pcb"]), ("bottom tray", bot, "deck PCB", refs["deck_pcb"]),
        ("top shell", top, "key plate", refs["key_plate"]),
        ("top shell", top, "MX switches", _u(refs["switches"])),
        ("top shell", top, "keycaps (rest)", _u(refs["keycaps"])),
        ("top shell", top, "e-ink panel", refs["eink"]),
        ("top shell", top, "speaker", refs["speaker"]),
        ("top shell", top, "USB-C bodies", _u(refs["usb"])), ("bottom tray", bot, "USB-C bodies", _u(refs["usb"])),
        ("top shell", top, "radar module", refs["radar"]), ("bottom tray", bot, "radar module", refs["radar"]),
        ("top shell", top, "hex standoffs", _u(refs["hex_standoffs"])),
        ("top shell", top, "tubes", _u(refs["tubes"])),
        ("top shell", top, "plungers", _u(refs["plungers"])),
        ("top shell", top, "speaker lid", B.part("speaker_lid").shape),
        ("main PCB", refs["main_pcb"], "speaker lid", B.part("speaker_lid").shape),
        ("top shell", top, "light bar", B.part("light_bar").shape),
    ]
    for m in p["hook"]["inserts"]:
        sad = union([B.part(f"saddle_{m}_left").shape, B.part(f"saddle_{m}_right").shape])
        pairs += [("top shell", top, f"saddles {m}", sad), (f"saddles {m}", sad, f"handset {m}", refs[f"handset_{m}"]),
                  (f"saddles {m}", sad, "plungers", _u(refs["plungers"])), (f"saddles {m}", sad, "tubes", _u(refs["tubes"]))]
        pairs += [("top shell", top, f"handset {m}", refs[f"handset_{m}"]),
                  ("keycaps", _u(refs["keycaps"]), f"handset {m}", refs[f"handset_{m}"])]
    for a, sa, b, sb in pairs:
        if sa is None or sb is None:
            continue
        v = _vol(sa, sb)
        R.add("interference", f"{a} x {b}", PASS if v <= tol else FAIL, f"{v:.2f} mm^3")
    # plungers off-hook (lifted by travel) must still clear the saddles
    tr = p["hook"]["plunger"]["travel"]
    up = _u([hook.plunger(g, i, lift=tr) for i in (0, 1)])
    for m in p["hook"]["inserts"]:
        sad = union([B.part(f"saddle_{m}_left").shape, B.part(f"saddle_{m}_right").shape])
        v = _vol(up, sad)
        R.add("interference", f"plungers off-hook x saddles {m}", PASS if v <= tol else FAIL, f"{v:.2f} mm^3")

    # ---- captive keycaps
    d = p["keys"]["dsa"]
    k = g.ks
    R.add("keys", "skin hole < DSA skirt (captive)", PASS if k["hole"] < d["skirt"] else FAIL,
          f"hole {k['hole']:.2f} mm square vs skirt {d['skirt']:.2f} mm ({p['keys']['overlap']:.2f} mm lip/side); "
          f"cap width at skin {k['w_at_skin']:.2f}; skirt sits {k['gap']:.2f} mm under the skin")
    pressed = _u(__import__("olp.refparts", fromlist=["x"]).keycaps(g, dz=-p["keys"]["travel"]))
    v = _vol(top, pressed)
    R.add("keys", "keycaps pressed (-travel) clear the skin", PASS if v <= tol else FAIL, f"{v:.2f} mm^3")
    lifted = __import__("olp.refparts", fromlist=["x"]).keycaps(g, dz=k["gap"] + 0.3)
    caught = sum(1 for cap in lifted if _vol(top, cap) > 1.0)
    R.add("keys", "keycap pulled up hits the skin (captive, geometric)", PASS if caught == len(lifted) else FAIL,
          f"{caught}/{len(lifted)} caps caught after {k['gap'] + 0.3:.2f} mm lift")
    R.add("keys", "key stack", PASS,
          f"deck PCB top {k['pcb_top']:.2f}, plate top {k['plate_top']:.2f}, cap base {k['cap_base']:.2f}, cap top {k['cap_top']:.2f}, "
          f"skin {g.H - g.T:.1f}-{g.H:.1f}; pressed cap top {k['cap_top'] - p['keys']['travel']:.2f} "
          f"({'above' if k['cap_top'] - p['keys']['travel'] >= g.H else 'below'} skin by {abs(k['cap_top'] - p['keys']['travel'] - g.H):.2f})")

    # ---- walls
    mw = p["print"]["min_wall"]
    for nm, v in (("wall", g.W), ("floor", g.F), ("top skin", g.T), ("handset wall", p["handset"]["wall"])):
        R.add("walls", nm, PASS if v >= mw else FAIL, f"{v} mm (min {mw})")
    R.add("walls", "intentional thin features", WARN,
          f"radar window {p['radar']['thickness']} mm, VOL flexure tabs {p['side_buttons']['tab_t']} mm, "
          f"lip {p['base']['lip']['t']} mm, e-ink rim {p['eink']['rim_t']} mm (not structural)")

    # ---- overhangs in print orientation (support-free printing)
    lim = math.cos(math.radians(p["print"]["max_overhang_deg"]))
    for part in B.printed:
        s = to_bed(part.shape, part.orient)
        V, F = mesh_of(s, 0.2, 0.3)
        tri = V[F]
        n = np.cross(tri[:, 1] - tri[:, 0], tri[:, 2] - tri[:, 0])
        area = np.linalg.norm(n, axis=1) / 2
        nz = n[:, 2] / np.maximum(np.linalg.norm(n, axis=1), 1e-12)
        zmin = tri[:, :, 2].min(axis=1)
        off_bed = zmin > 0.2
        steep = off_bed & (nz < -lim) & (nz > -0.985)
        bridge = off_bed & (nz <= -0.985)
        sa, ba = float(area[steep].sum()), float(area[bridge].sum())
        lvl = PASS if sa < 60 else (WARN if sa < 200 else FAIL)
        if part.supports and lvl == FAIL:
            lvl = WARN
        R.add("overhang", part.name + (" (needs supports inside - optional part)" if part.supports else ""), lvl,
              f">{p['print']['max_overhang_deg']} deg overhang {sa:.0f} mm^2 (holes/text edges), bridges {ba:.0f} mm^2")

    # ---- hook sensing (on-axis magnet model) + spring
    h = p["hook"]
    mg = h["magnet"]
    for m in h["inserts"]:
        for i in (0, 1):
            press = hook.pin_press(g, i, m)
            z_on = h["gap_on"] + press
            z_off = h["gap_on"] + tr
            b_on = hook.magnet_field_mT(mg["br"], mg["d"], mg["h"], z_on)
            b_off = hook.magnet_field_mT(mg["br"], mg["d"], mg["h"], z_off)
            ok = b_on >= h["hall"]["bop_max_mT"] and b_off <= h["hall"]["brp_min_mT"]
            if i == 1 or m == h["inserts"][0]:
                R.add("hook", f"hall field, {m} handset, {'right' if i else 'left'} post",
                      PASS if ok else FAIL,
                      f"on-hook {z_on:.1f} mm -> {b_on:.1f} mT (need >= {h['hall']['bop_max_mT']}), "
                      f"off-hook {z_off:.1f} mm -> {b_off:.2f} mT (need <= {h['hall']['brp_min_mT']}); "
                      f"{mg['d']} x {mg['h']} mm, Br {mg['br']} T; thresholds UNVERIFIED")
    sp = h["spring"]
    f_on = sp["rate_N_per_mm"] * (sp["free_len"] - h["plunger"]["spring_on"])
    f_off = sp["rate_N_per_mm"] * (sp["free_len"] - g.pl["spring_off"])
    for m in h["inserts"]:
        w = handset.H(g, m)["mass_g"] * 9.81e-3 / 2
        R.add("hook", f"spring vs {m} handset weight per post", PASS if f_on < 0.7 * w and f_off > 0.05 else FAIL,
              f"spring {f_on:.2f} N on-hook / {f_off:.2f} N off-hook vs {w:.2f} N per cup")

    # ---- finger clearance and overall height (rays straight up from each keycap top)
    import trimesh
    Vc, Fc = mesh_of(_u(refs["keycaps"]), 0.3, 0.5)
    cap_top = float(Vc[:, 2].max())
    half = p["keys"]["dsa"]["top"] / 2 - 0.5
    origins = np.array([[x + dx, y + dy, cap_top] for _, x, y in g.keys for dx in (-half, 0, half) for dy in (-half, 0, half)])
    dirs = np.tile([0.0, 0.0, 1.0], (len(origins), 1))
    for m in h["inserts"]:
        V, F = mesh_of(refs[f"handset_{m}"], 0.3, 0.4)
        zhit = _vertical_hits(V[F], origins)
        ok_ = np.isfinite(zhit)
        clr = float((zhit[ok_] - cap_top).min()) if ok_.any() else float("inf")
        covered = len(set(int(i) // 9 for i in np.nonzero(ok_)[0]))
        want = h["finger_clearance"]
        R.add("hook", f"finger clearance under the {m} handset", PASS if clr >= want - 1.5 else FAIL,
              f"{clr:.1f} mm from keycap tops (z {cap_top:.1f}) to the handset (target {want}); "
              f"handset is above {covered}/12 keys")
        R.add("hook", f"overall height with the {m} handset", PASS if V[:, 2].max() <= 100 else WARN,
              f"{V[:, 2].max():.1f} mm (owner target 95-100)")

    # ---- radar
    r = p["radar"]
    rm = refs["radar"]
    if rm is not None:
        dist = rm.bounding_box().min.Y - r["thickness"]
        ok = abs(dist - r["target_distance"]) <= r["tolerance"]
        R.add("radar", "antenna face to radome", PASS if ok else FAIL,
              f"{dist:.1f} mm (target {r['target_distance']} +- {r['tolerance']}; module geometry UNVERIFIED)")
    R.add("rf", "ESP32 antenna keep-out", WARN,
          "antenna position not in the intent block; layout must keep it >= 15 mm from the metal tubes "
          f"at {[(round(x), round(y)) for x, y in g.posts]}, hex standoffs and brass inserts")
    return R


def write(R: Report, out_dir):
    (out_dir / "checks.json").write_text(json.dumps(R.rows, indent=1))
    (out_dir / "checks.txt").write_text(R.text() + "\n")
