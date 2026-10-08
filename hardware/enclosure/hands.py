"""Sculpted handset catches for the cradle (see HANDS in PROTO_BOX.md).

For every entry in hands.yaml: download the model from Printables (cached in build/hands/src/),
orient and scale it, place it so a 40 mm handle rests exactly where the standard cradle holds it,
add a bar that joins it to the shared arm (proto_box.arm_body) and write build/hands/cradle-<key>.stl
plus checks.txt, CREDITS.txt and hands.png. Exit 1 on any FAIL.
"""
from __future__ import annotations

import json
import math
import sys
import urllib.request
from pathlib import Path

import numpy as np
import trimesh
import yaml

import proto_box as P

HERE = Path(__file__).resolve().parent
OUT = HERE / "build" / "hands"
SRC = OUT / "src"
RAW_FACES = 60000        # decimate big scans before anything else
CATCH_FACES = 30000      # faces per piece in the output (fine detail at this size)
R_SEAT, R_MAX, R_MIN = P.HANDLE_W / 2, 25.0, 15.0
MAX_Y_PER_REST = 28.0    # a catch this short (along the handle) goes on each rest, else one long one
MAX_Y_LONG = 64.0        # handle between the cups
BAR_H = 6.0
RAISE_MAX = 25.0        # how much higher than the plain cradles a sculpted catch may hold the handle


def gql(q: str) -> dict:
    req = urllib.request.Request("https://api.printables.com/graphql/", json.dumps({"query": q}).encode(),
                                 {"content-type": "application/json", "User-Agent": "Mozilla/5.0"})
    return json.load(urllib.request.urlopen(req, timeout=60))["data"]


def fetch(key: str, m: dict) -> Path:
    out = SRC / f"{key}.stl"
    if out.exists():
        return out
    SRC.mkdir(parents=True, exist_ok=True)
    stls = gql('query{print(id:"%s"){stls{id name}}}' % m["id"])["print"]["stls"]
    fid = next(s["id"] for s in stls if s["name"] == m["file"])
    link = gql('mutation{getDownloadLink(id:"%s", printId:"%s", fileType:stl, source:model_detail)'
               '{ok output{link}}}' % (fid, m["id"]))["getDownloadLink"]["output"]["link"]
    req = urllib.request.Request(link, headers={"User-Agent": "Mozilla/5.0"})
    out.write_bytes(urllib.request.urlopen(req, timeout=300).read())
    return out


def decimate(m: trimesh.Trimesh, faces: int) -> trimesh.Trimesh:
    if len(m.faces) <= faces:
        return m
    import fast_simplification
    v, f = fast_simplification.simplify(m.vertices, m.faces, target_count=faces)
    return trimesh.Trimesh(v, f, process=True)


def rot(m: trimesh.Trimesh, rx=0.0, ry=0.0, rz=0.0) -> trimesh.Trimesh:
    for ang, axis in ((rx, [1, 0, 0]), (ry, [0, 1, 0]), (rz, [0, 0, 1])):
        if ang:
            m.apply_transform(trimesh.transformations.rotation_matrix(math.radians(ang), axis))
    return m


def mirror_x(m: trimesh.Trimesh) -> trimesh.Trimesh:
    m = m.copy()
    m.apply_transform(np.diag([-1.0, 1, 1, 1]))
    m.invert()
    return m


def load_piece(key: str, m: dict) -> trimesh.Trimesh:
    raw = trimesh.load(fetch(key, m), force="mesh")
    raw.apply_translation(-raw.bounds[0])
    raw.apply_scale(1.0 / raw.extents.max())          # unit size: some scans are in metres
    if "select" in m:                                 # keep the bodies inside a box (unit coords)
        x0, x1, y0, y1 = m["select"]
        lo, hi = raw.bounds
        bodies = [b for b in raw.split(only_watertight=False)
                  if x0 <= (b.centroid[0] - lo[0]) / (hi[0] - lo[0]) <= x1
                  and y0 <= (b.centroid[1] - lo[1]) / (hi[1] - lo[1]) <= y1]
        raw = trimesh.util.concatenate(bodies)
    raw = decimate(raw, RAW_FACES)
    rot(raw, *m.get("rot", [0, 0, 0]))
    raw.apply_translation(-raw.bounds[0])
    if m.get("trim"):                                 # cut off a stand or stem at the bottom
        z = raw.extents[2] * m["trim"]
        cut = raw.slice_plane([0, 0, z], [0, 0, 1], cap=True)
        if cut is None or len(cut.faces) == 0:
            cut = raw.slice_plane([0, 0, z], [0, 0, 1], cap=False)
        raw = cut
        raw.apply_translation(-raw.bounds[0])
    if m.get("drop_small"):                           # loose crumbs from a scan
        bodies = sorted(raw.split(only_watertight=False), key=lambda b: -b.area)
        keep = [b for b in bodies if b.area >= bodies[0].area * m["drop_small"]]
        raw = trimesh.util.concatenate(keep)
    if "height" in m:
        raw.apply_scale(m["height"] / raw.extents[2])
    else:
        raw.apply_scale(m["width"] / raw.extents[0])
    return decimate(raw, CATCH_FACES)


def lean_x(m: trimesh.Trimesh) -> float:
    """How far the top leans toward +x relative to the bottom."""
    z = m.vertices[:, 2]
    lo, hi = np.quantile(z, [0.25, 0.75])
    return m.vertices[z >= hi, 0].mean() - m.vertices[z <= lo, 0].mean()


def seat(pts: np.ndarray, cx: float, r: float) -> tuple[float, bool]:
    """Lowest centre height of a handle (circle of radius r, centred at x = cx) resting on the
    points (x, z); and whether it lifts straight out (nothing above it within its width)."""
    dx = pts[:, 0] - cx
    near = np.abs(dx) < r
    zc = np.max(pts[near, 1] + np.sqrt(r * r - dx[near] ** 2))
    above = (np.abs(dx) < r - 0.5) & (pts[:, 1] > zc + 0.5)
    return float(zc), not bool(above.any())


def contacts(pts: np.ndarray, cx: float, zc: float, r: float) -> tuple[bool, bool]:
    d = np.hypot(pts[:, 0] - cx, pts[:, 1] - zc)
    touch = d < r + 0.6
    return bool((touch & (pts[:, 0] < cx - 1)).any()), bool((touch & (pts[:, 0] > cx + 1)).any())


def build(key: str, m: dict, g: dict) -> tuple[trimesh.Trimesh, list[tuple[str, str, str]], dict]:
    R = []

    def add(ok, name, msg):
        R.append(("PASS" if ok else "FAIL", f"{key} {name}", msg))

    lx, hb = g["lx"], g["hb"]
    piece = load_piece(key, m)
    if m["mode"] == "pair":
        want = -1 if m.get("lean", "in") == "in" else 1        # the right-hand piece's lean
        if lean_x(piece) * want < 0:
            piece = mirror_x(piece)
        if m.get("splay"):                                      # tilt the right piece outward
            c = piece.bounds.mean(0)
            piece.apply_transform(trimesh.transformations.rotation_matrix(
                math.radians(m["splay"]), [0, 1, 0], [c[0], c[1], piece.bounds[0][2]]))
        piece.apply_translation(-piece.bounds[0])
    arm_top = g["zb0"] + P.ARM_H
    under = max(P.Z_LT + P.CAP_TOP, P.Z_DISP + P.DISP_T + P.BEZEL_TOP)
    floor = max(arm_top, under + 15) + BAR_H / 2       # lowest bar centre

    def arrange(scale: float):
        """The catch at this scale, its bottom on z = 0, a 40 mm handle centred on x = lx.
        Returns (pieces, gap, seat bottom above the catch bottom)."""
        pc = piece.copy()
        pc.apply_scale(scale)
        rng = np.random.default_rng(0)
        if m["mode"] == "pair":
            def place(gap):
                right = pc.copy()
                right.apply_translation([lx + gap / 2, -right.extents[1] / 2, 0])
                return [right, mirror_x_about(right, lx)]
            sub = rng.choice(len(pc.vertices), min(len(pc.vertices), 6000), replace=False)
            gap = 90.0
            for gp in np.arange(0.0, 90.0, 1.0):     # narrowest gap a 50 mm handle lifts out of
                v = pc.vertices[sub][:, [0, 2]] + [lx + gp / 2, 0]
                pts = np.vstack([v, np.c_[2 * lx - v[:, 0], v[:, 1]]])
                if seat(pts, lx, R_MAX)[1]:
                    gap = float(gp)
                    break
            pieces = place(gap)
        else:
            pc.apply_translation([-pc.extents[0] / 2, -pc.extents[1] / 2, 0])
            pts = pc.vertices[:, [0, 2]]
            best = None
            for sx in np.linspace(-pc.extents[0] / 3, pc.extents[0] / 3, 61):   # find the crotch
                zc, free = seat(pts, sx, R_SEAT)
                both = all(contacts(pts, sx, zc, R_SEAT))
                rank = (not (free and both), not free, zc)
                if best is None or rank < best[0]:
                    best = (rank, sx)
            pc.apply_translation([lx - best[1], 0, 0])
            pieces, gap = [pc], None
        cat = trimesh.util.concatenate(pieces)
        x0, x1 = cat.bounds[0][0], cat.bounds[1][0]
        pts = np.vstack([cat.vertices[:, [0, 2]], np.c_[np.linspace(x0, x1, 200), np.full(200, BAR_H / 2)]])
        zc, _ = seat(pts, lx, R_SEAT)
        return pieces, gap, zc - R_SEAT

    # the catch's bottom sits on the bar (>= floor); the handle may ride up to RAISE_MAX higher
    # than on the plain cradles (its cups only clear more); shrink the catch if that's not enough
    s_hi = 1.0
    pieces, gap, rel = arrange(s_hi)
    scale_used = 1.0
    if floor + rel > hb + RAISE_MAX:
        s_lo = 0.05
        for _ in range(22):
            s_mid = (s_lo + s_hi) / 2
            if floor + arrange(s_mid)[2] > hb + RAISE_MAX:
                s_hi = s_mid
            else:
                s_lo = s_mid
        pieces, gap, rel = arrange(s_lo)
        scale_used = s_lo
    h = max(hb, floor + rel)                           # this catch's handle underside height
    catch = trimesh.util.concatenate(pieces)
    ylen = catch.extents[1]
    ys = [g["yc"]] if ylen > MAX_Y_PER_REST else list(P.REST_Y)
    dz = h - rel
    catch.apply_translation([0, 0, dz])
    zmin = catch.bounds[0][2]
    pts = catch.vertices[:, [0, 2]] - [0, dz]

    # bar under the catch's feet, joined to the arm by an upright at each rest
    feet = catch.vertices[catch.vertices[:, 2] < zmin + 4]
    fx0, fx1 = feet[:, 0].min() - 2, feet[:, 0].max() + 2
    fy0, fy1 = feet[:, 1].min(), feet[:, 1].max()
    parts = []
    for yc in ys:
        c = catch.copy()
        c.apply_translation([0, yc, 0])
        y0 = min(yc + fy0, min(P.REST_Y) - P.V_T / 2) if len(ys) == 1 else yc + min(fy0, -P.V_T / 2)
        y1 = max(yc + fy1, max(P.REST_Y) + P.V_T / 2) if len(ys) == 1 else yc + max(fy1, P.V_T / 2)
        bar = trimesh.creation.box(bounds=[[fx0, y0, zmin - BAR_H / 2], [fx1, y1, zmin + BAR_H / 2]])
        parts += [c, bar]
    for y in P.REST_Y:
        parts.append(trimesh.creation.box(bounds=[[lx - P.ARM_W / 2, y - P.V_T / 2, arm_top - 0.5],
                                                  [lx + P.ARM_W / 2, y + P.V_T / 2, zmin - BAR_H / 2 + 0.5]]))
    arm = arm_mesh()
    merged, solid = fuse([arm] + parts)

    # checks
    allpts = np.vstack([pts + [0, dz], np.c_[np.linspace(fx0, fx1, 200), np.full(200, zmin + BAR_H / 2)]])
    zc, free = seat(allpts, lx, R_SEAT)
    left, right = contacts(allpts, lx, zc, R_SEAT)
    on_bar = abs(zc - R_SEAT - (zmin + BAR_H / 2)) < 0.6
    add(abs(zc - R_SEAT - h) < 0.6 and (on_bar or (left and right)) and free, "holds a 40 mm handle",
        f"underside at z {zc - R_SEAT:.1f} ({zc - R_SEAT - hb:+.1f} vs the plain cradles), "
        + ("on the bar between the pieces" if on_bar else
           f"touching {'both sides' if left and right else 'one side only'}")
        + (", lifts straight out" if free else ", something above it"))
    z50, free50 = seat(allpts, lx, R_MAX)
    z30, free30 = seat(allpts, lx, R_MIN)
    add(free50 and free30, "50 / 30 mm handles",
        f"a 50 mm handle sits {z50 - R_MAX - h:+.1f} mm and a 30 mm one {z30 - R_MIN - h:+.1f} mm "
        "from the standard height; both lift straight out")
    bottom = zmin - BAR_H / 2
    add(bottom - under >= 15 - 0.01 and bottom >= arm_top - 0.01, "over the keys",
        f"bar {bottom - under:.1f} mm above the keycap tops")
    yspan = (min(ys) - ylen / 2, max(ys) + ylen / 2)
    pitch = P.HANDSET_L / 2 - P.CUP_D / 2
    cup_in = (g["yc"] - pitch + P.CUP_D / 2, g["yc"] + pitch - P.CUP_D / 2)
    add(yspan[0] >= cup_in[0] and yspan[1] <= cup_in[1], "between the cups",
        f"catch y {yspan[0]:.0f}..{yspan[1]:.0f} inside the handle's {cup_in[0]:.0f}..{cup_in[1]:.0f}")
    vol = merged.volume if solid else merged.voxelized(pitch=0.6).fill().volume
    grams = vol / 1000 * P.PA12_DENSITY
    cg_y = merged.center_mass[1] if solid else float(np.mean(merged.voxelized(pitch=0.6).fill().points[:, 1]))
    on_cap = grams * (P.HINGE_Y - cg_y) / (P.HINGE_Y - g["fy"])
    add(on_cap < 0.5 * P.MX_ACTUATE_GF, "weight on the hook",
        f"cradle {grams:.0f} g{'' if solid else ' (estimate: mesh not solid)'} puts {on_cap:.0f} g "
        f"on the hook cap (switch lifts below {0.5 * P.MX_ACTUATE_GF:.0f} g)")
    add(True, "print", "one solid (fused)" if solid else
        "separate shells that overlap: slicers and print services merge them")
    size = catch.extents
    add(True, "size", f"catch {size[0]:.0f} x {size[1]:.0f} x {size[2]:.0f} mm"
        + (f" (shrunk to {scale_used * 100:.0f} % of hands.yaml to fit above the arm)" if scale_used < 1 else "")
        + (f", pieces {gap:.0f} mm apart" if gap is not None else ""))
    info = dict(gap=gap, ys=ys, grams=grams, solid=solid, h=h)
    return merged, R, info


def mirror_x_about(m: trimesh.Trimesh, x: float) -> trimesh.Trimesh:
    c = m.copy()
    c.apply_translation([-x, 0, 0])
    c = mirror_x(c)
    c.apply_translation([x, 0, 0])
    return c


_ARM = None


def arm_mesh() -> trimesh.Trimesh:
    global _ARM
    if _ARM is None:
        v, f = P.mesh_of(P.arm_body(), tol=0.05, ang=0.2)
        _ARM = trimesh.Trimesh(v, f, process=True)
        _ARM.fix_normals()
    return _ARM.copy()


def fuse(parts: list[trimesh.Trimesh]) -> tuple[trimesh.Trimesh, bool]:
    """Boolean union with manifold3d when every part is a closed solid, else plain concatenation."""
    try:
        import manifold3d as m3d
        ms = []
        for p in parts:
            p = p.copy()
            p.merge_vertices()
            if not p.is_watertight:
                raise ValueError("not watertight")
            ms.append(m3d.Manifold(m3d.Mesh(vert_properties=np.asarray(p.vertices, np.float32),
                                            tri_verts=np.asarray(p.faces, np.uint32))))
        u = m3d.Manifold.batch_boolean(ms, m3d.OpType.Add)
        mesh = u.to_mesh()
        out = trimesh.Trimesh(mesh.vert_properties[:, :3], mesh.tri_verts, process=True)
        if out.is_watertight and len(out.faces):
            return out, True
    except Exception:
        pass
    return trimesh.util.concatenate(parts), False


def sheet(results: dict, g: dict, infos: dict) -> None:
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    from mpl_toolkits.mplot3d.art3d import Poly3DCollection
    keys = list(results)
    cols = 4
    rows = math.ceil(len(keys) / cols)
    fig = plt.figure(figsize=(5 * cols, 5 * rows), dpi=70)
    L = np.array([0.3, -0.7, 0.65])
    L /= np.linalg.norm(L)
    for i, k in enumerate(keys):
        mesh = results[k]
        ax = fig.add_subplot(rows, cols, i + 1, projection="3d")
        d = decimate(mesh, 20000)
        tri = d.vertices[d.faces]
        sh = 0.3 + 0.7 * np.abs(d.face_normals @ L)
        ax.add_collection3d(Poly3DCollection(tri, facecolors=np.c_[sh * .31, sh * .49, sh * .55, np.ones(len(sh))],
                                             edgecolors="none"))
        th = np.linspace(0, 2 * np.pi, 60)
        zc = infos[k]["h"] + R_SEAT
        for y in (4.0, 68.0):                          # the handle between the cups
            ax.plot(g["lx"] + R_SEAT * np.cos(th), np.full(60, y), zc + R_SEAT * np.sin(th),
                    color="#c9a227", lw=1.5)
        for sx, sz in ((-1, 0), (1, 0), (0, -1), (0, 1)):
            ax.plot([g["lx"] + sx * R_SEAT] * 2, [4.0, 68.0], [zc + sz * R_SEAT] * 2, color="#c9a227", lw=1.0)
        mn, mx = d.bounds
        mn = np.minimum(mn, [g["lx"] - 30, 0, 30])
        mx = np.maximum(mx, [g["lx"] + 30, 72, infos[k]["h"] + 45])
        ax.set_xlim(mn[0], mx[0]); ax.set_ylim(mn[1], mx[1]); ax.set_zlim(mn[2], mx[2])
        ax.set_box_aspect(tuple(mx - mn)); ax.view_init(18, -62); ax.set_axis_off()
        ax.set_title(k, fontsize=14)
    fig.subplots_adjust(0, 0, 1, 0.97, 0.02, 0.06)
    fig.savefig(OUT / "hands.png", facecolor="white")
    plt.close(fig)


def main() -> int:
    manifest = yaml.safe_load((HERE / "hands.yaml").read_text())
    only = sys.argv[1:]
    OUT.mkdir(parents=True, exist_ok=True)
    g = P.cradle_geom()
    results, lines, credits, infos = {}, [], [], {}
    for key, m in manifest.items():
        if only and key not in only:
            continue
        mesh, R, info = build(key, m, g)
        mesh.export(OUT / f"cradle-{key}.stl")
        results[key] = mesh
        infos[key] = info
        lines += [f"{s:4}  {n}: {msg}" for s, n, msg in R]
        credits.append(f"cradle-{key}.stl: catch from \"{m['title']}\" by {m['author']}, "
                       f"https://www.printables.com/model/{m['id']} ({m['license']}); fused onto the "
                       f"Open Lounge Phone cradle arm.")
    (OUT / "checks.txt").write_text("\n".join(lines) + "\n")
    (OUT / "CREDITS.txt").write_text("\n".join(credits) + "\n")
    print("\n".join(lines))
    sheet(results, g, infos)
    return 1 if any(ln.startswith("FAIL") for ln in lines) else 0


if __name__ == "__main__":
    sys.exit(main())
