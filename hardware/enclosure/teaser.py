"""Scene for the site teaser: build/teaser/scene.glb (mm, z up, the shell's frame).

Named meshes: tray, lid, bezel, board_* (the KiCad board by material, plus stand-ins for the
parts whose 3D models KiCad's library lacks), switch, keycap, module, panel, handset and one
cradle-<style> per cradle (plain styles from build/proto, sculpted ones from build/hands).
The page instances switch/keycap per key and recolours shells, cradles and the handset.

    .venv/bin/python teaser.py      # after make proto (2.9" display) and make hands

The handset is the receiver of "Red Table Phone" by digitaldaydream (OpenGameArt, CC0): its
object "Reciever.001", smoothed with Blender's subdivision (level 2), exported to
build/teaser/handset.stl and scaled here to the Opis 60s Micro's 210 mm. Without that file a
code-built G-style handset is used. KiCad's library here lacks some part models: the ESP32-S3
model comes from KiCad's GitLab (build/teaser/dl/), the display module is WeAct's own STEP.
"""
from __future__ import annotations

import json
import math
import subprocess
from pathlib import Path

import manifold3d as m3d
import numpy as np
import trimesh

import hands as H
import proto_box as P

HERE = Path(__file__).resolve().parent
OUT = HERE / "build" / "teaser"
KICAD = Path.home() / "Applications/KiCad/KiCad.app"
if not KICAD.exists():
    KICAD = Path("/Applications/KiCad/KiCad.app")
FACES = {"tray": 26000, "lid": 16000, "bezel": 4000, "cradle": 7000, "board": 45000}


def tm(man: m3d.Manifold) -> trimesh.Trimesh:
    mesh = man.to_mesh()
    return trimesh.Trimesh(mesh.vert_properties[:, :3], mesh.tri_verts, process=True)


def handset() -> tuple[trimesh.Trimesh, float]:
    """Opis 60s Micro-style handset, 210 x 68 x 60 mm: an arched handle between two round cups
    that face down and slightly in. Lies along y, cups down, the handle's middle underside at
    z = 0 and centred on x = 0, y = 0."""
    m3d.set_circular_segments(56)
    seg = []
    n = 30
    for i in range(n + 1):                     # handle: hulls of ellipsoids along an arc that
        t = -1 + 2 * i / n                     # dips into the backs of the cups at its ends
        y = 76 * t
        z = 12 + 6 * (1 - t * t) - 16 * t ** 6
        w = 14 + 3 * t ** 4                    # widens where it meets the cups
        seg.append(m3d.Manifold.sphere(1.0).scale([w, 6, 10.5]).translate([0, y, z]))
    handle = m3d.Manifold.batch_boolean([m3d.Manifold.batch_hull([a, b]) for a, b in zip(seg, seg[1:])],
                                        m3d.OpType.Add)
    cups = []
    for s in (-1, 1):                          # earpiece (+y) and mouthpiece (-y): rounded pucks
        face = m3d.Manifold.cylinder(1.5, 29, 29)
        dome = m3d.Manifold.sphere(1.0).scale([29, 29, 15]).translate([0, 0, 6])
        cup = m3d.Manifold.batch_hull([face, dome]) ^ m3d.Manifold.cube([80, 80, 40], True).translate([0, 0, 20])
        cup = cup + m3d.Manifold.cylinder(1.2, 29.5, 29.5).translate([0, 0, -0.2])   # seam ring
        cup = cup.rotate([s * 14, 0, 0]).translate([0, s * 74, -12])
        cups.append(cup)
    body = m3d.Manifold.batch_boolean([handle] + cups, m3d.OpType.Add)
    holes = []                                 # earpiece grille: a ring of small dimples
    for k in range(12):
        a = 2 * math.pi * k / 12
        for r in (6, 12):
            holes.append(m3d.Manifold.cylinder(3, 1.1, 1.1).translate([r * math.cos(a), r * math.sin(a), -1.5]))
    grille = m3d.Manifold.batch_boolean(holes, m3d.OpType.Add).rotate([14, 0, 0]).translate([0, 74, -12])
    body = body - grille
    m = tm(body)
    lift = -m.bounds[0][2]
    m.apply_translation([0, 0, lift])          # cups' faces on z = 0
    return m, 7.5 + lift                       # and the handle's middle underside


def step_solids(path: Path):
    """[(mesh, bbox)] for each solid of a STEP file, in its own frame (mm)."""
    cache = OUT / "cache" / (path.stem + ".npz")       # converting STEP is slow: keep the meshes
    if cache.exists():
        d = np.load(cache)
        return [trimesh.Trimesh(d[f"v{i}"], d[f"f{i}"], process=False) for i in range(int(d["n"]))]
    from build123d import import_step
    out = []
    for so in import_step(str(path)).solids():
        v, f = P.mesh_of(so, tol=0.05, ang=0.3)
        if len(f):
            out.append(trimesh.Trimesh(v, f, process=True))
    cache.parent.mkdir(parents=True, exist_ok=True)
    np.savez_compressed(cache, n=len(out), **{f"v{i}": m.vertices for i, m in enumerate(out)},
                        **{f"f{i}": m.faces for i, m in enumerate(out)})
    return out


def esp32() -> dict[str, trimesh.Trimesh]:
    """KiCad's ESP32-S3-WROOM-1 model cut to the 1U's 19.2 mm (no PCB antenna), on the board's
    underside at U1: shield can down, antenna end at the board edge."""
    src = OUT / "dl" / "ESP32-S3-WROOM-1.step"
    sol = step_solids(src)
    allv = np.vstack([m.vertices for m in sol])
    lo, hi = allv.min(0), allv.max(0)
    ax = int(np.argmax((hi - lo)[:2]))                    # long axis (x or y)
    can = max(sol, key=lambda m: m.bounds[1][2])          # tallest solid: the shield can
    can_c = can.centroid[ax]
    mid = (lo[ax] + hi[ax]) / 2
    keep_from_hi = can_c > mid                            # the antenna is at the other end
    cut = hi[ax] - 19.2 if keep_from_hi else lo[ax] + 19.2
    pcb_col, metal_col = "2b2f3a", "c4c7ca"
    groups = {}
    for m in sol:
        n = np.zeros(3); n[ax] = 1 if keep_from_hi else -1
        m = m.slice_plane([cut if i == ax else 0 for i in range(3)], n, cap=True) or m
        if len(m.faces) == 0:
            continue
        col = metal_col if m is not None and m.bounds[1][2] - m.bounds[0][2] > 1.0 else pcb_col
        groups.setdefault(col, []).append(m)
    meshes = {k: trimesh.util.concatenate(v) for k, v in groups.items()}
    whole = trimesh.util.concatenate(list(meshes.values()))
    b = whole.bounds
    # module frame: cut end (antenna side) at x = 0, length along +x, top (can) along -z
    T = np.eye(4)
    if ax == 1:
        T = trimesh.transformations.rotation_matrix(-math.pi / 2, [0, 0, 1]) @ T
    for k in meshes:
        meshes[k].apply_transform(T)
    whole = trimesh.util.concatenate(list(meshes.values()))
    b = whole.bounds
    flipx = (whole.centroid[0] < (b[0][0] + b[1][0]) / 2) if keep_from_hi else False
    out = {}
    parts = json.loads((P.OUT / "board_parts.json").read_text())["parts"]
    u1 = next(p for p in parts if p["ref"] == "U1")
    x0, y0, x1, y1 = u1["crt"]
    for k, m in meshes.items():
        m = m.copy()
        m.apply_translation(-b[0])
        L, W = b[1][0] - b[0][0], b[1][1] - b[0][1]
        if keep_from_hi:                                  # the kept end is at high x: mirror x
            m.apply_transform(np.diag([-1.0, 1, 1, 1])); m.invert(); m.apply_translation([L, 0, 0])
        m.apply_transform(np.diag([1.0, 1, -1, 1])); m.invert()          # can down
        bx = x0 + 0.5                                                    # antenna end at the edge
        by = (y0 + y1) / 2 - W / 2
        m.apply_translation([P.bx2x(bx), P.by2y(by) - W, P.Z_BB])
        out["board_" + k] = m
    return out


def weact_module() -> dict[str, trimesh.Trimesh]:
    """WeAct's 2.9" module (their STEP: board, header, parts; no panel) where it plugs into J3:
    header end at the module's low x, its back (parts, header) facing down."""
    sol = step_solids(OUT.parent / "weact" / "WeAct-EpaperModule-2.9_Board_3D.step")
    pcb = max(sol, key=lambda m: m.extents[0] * m.extents[1])
    hdr = [m for m in sol if abs(m.extents[0] - 5.08) < 0.2 and abs(m.extents[1] - 10.16) < 0.2]
    b = pcb.bounds
    hx = (hdr[0].bounds[0][0] + hdr[0].bounds[1][0]) / 2 if hdr else b[0][0]
    header_at_low = hx < (b[0][0] + b[1][0]) / 2
    out = {}
    for m in sol:
        col = "141414" if m is pcb else ("1d1d1d" if any(m is h for h in hdr) else "3a3a3a")
        if m is not pcb and not any(m is h for h in hdr) and m.extents.max() < 1.0:
            col = "8a8f94"
        m = m.copy()
        m.apply_translation([-b[0][0], -b[0][1], -b[1][2]])            # board top at z = 0
        if not header_at_low:
            m.apply_transform(np.diag([-1.0, 1, 1, 1])); m.invert(); m.apply_translation([b[1][0] - b[0][0], 0, 0])
        m.apply_transform(np.diag([1.0, 1, -1, 1])); m.invert()          # back side (parts) down
        thick = b[1][2] - b[0][2]
        m.apply_translation([P.bx2x(P.DISP_X0), P.by2y(P.DISP_MID) - (b[1][1] - b[0][1]) / 2,
                             P.Z_DISP + thick])
        out.setdefault("module_" + col, []).append(m)
    return {k: trimesh.util.concatenate(v) for k, v in out.items()}


def switch() -> trimesh.Trimesh:
    """MX switch above the plate: top housing and stem (the part you see under a clear cap)."""
    top = m3d.Manifold.batch_hull([m3d.Manifold.cube([15.6, 15.6, 0.1], True).translate([0, 0, 0.05]),
                                   m3d.Manifold.cube([11.6, 11.6, 0.1], True).translate([0, 0, 6.5])])
    stem = (m3d.Manifold.cube([4.1, 1.2, 4.0], True) + m3d.Manifold.cube([1.2, 4.1, 4.0], True)).translate([0, 0, 8.4])
    return tm(top + m3d.Manifold.cylinder(2.0, 3.2, 3.2).translate([0, 0, 6.5]) + stem)


def keycap() -> trimesh.Trimesh:
    """Clear XDA 1u cap, 18.2 square at the base, 9 tall, a shallow dish on top."""
    m3d.set_circular_segments(32)
    r = 1.6
    corners = []
    for w, z in ((18.2, 0.0), (14.4, 8.4)):
        for sx in (-1, 1):
            for sy in (-1, 1):
                corners.append(m3d.Manifold.sphere(r).translate([sx * (w / 2 - r), sy * (w / 2 - r), z + r * 0.2]))
    cap = m3d.Manifold.batch_hull(corners)
    cap = cap ^ m3d.Manifold.cube([30, 30, 9.0], True).translate([0, 0, 4.5])
    dish = m3d.Manifold.sphere(60).translate([0, 0, 9.0 + 60 - 0.7])
    return tm(cap - dish)


def board() -> dict[str, trimesh.Trimesh]:
    """The KiCad board in the shell's frame, merged by material; stand-ins for the ESP32 module,
    USB-C and the jack (on the bottom side; their STEP models aren't in KiCad's library here)."""
    glb = OUT / "board.glb"
    cli = KICAD / "Contents/MacOS/kicad-cli"
    subprocess.run([str(cli), "pcb", "export", "glb", "-f", "--include-silkscreen", "--include-soldermask",
                    "--include-pads", "-D", f"KICAD10_3DMODEL_DIR={KICAD}/Contents/SharedSupport/3dmodels",
                    "-o", str(glb), str(HERE.parent / "kicad/main/main.kicad_pcb")],
                   check=True, capture_output=True)
    sc = trimesh.load(glb)
    # glTF y-up metres, KiCad page offset 40 mm -> shell frame mm, z up, board bottom at Z_BB
    T = np.array([[1000, 0, 0, P.GAP + P.WALL - 40], [0, 0, -1000, P.GAP + P.WALL + P.BOARD_H + 40],
                  [0, 1000, 0, P.Z_BB], [0, 0, 0, 1]], dtype=float)
    groups: dict[str, list[trimesh.Trimesh]] = {}
    for node in sc.graph.nodes_geometry:
        M, gname = sc.graph[node]
        g = sc.geometry[gname].copy()
        g.apply_transform(T @ M)
        col = getattr(g.visual, "material", None)
        try:
            rgba = np.array(col.baseColorFactor if col.baseColorFactor is not None else [200, 200, 200, 255])
        except AttributeError:
            rgba = np.array([200, 200, 200, 255])
        if rgba.max() <= 1.0:
            rgba = rgba * 255
        if "Buzzer" in gname:                  # long leads in the model: trim them at the floor
            g = g.slice_plane([0, 0, P.Z_FLOOR + 1], [0, 0, 1], cap=False) or g
        key = "board_" + "%02x%02x%02x" % tuple(int(v) for v in rgba[:3])
        g.visual = trimesh.visual.ColorVisuals(g)
        groups.setdefault(key, []).append(g)
    out = {k: trimesh.util.concatenate(v) for k, v in groups.items()}
    parts = {p["ref"]: p for p in json.loads((P.OUT / "board_parts.json").read_text())["parts"]}
    stand = {"J1": 3.26, "J2": 4.0}
    metal = []
    for ref, h in stand.items():
        x0, y0, x1, y1 = parts[ref]["crt"]
        wx0, wx1 = P.bx2x(x0) + 0.3, P.bx2x(x1) - 0.3
        wy0, wy1 = sorted((P.by2y(y0), P.by2y(y1)))
        metal.append(trimesh.creation.box(bounds=[[wx0, wy0 + 0.3, P.Z_BB - h], [wx1, wy1 - 0.3, P.Z_BB]]))
    out["board_metal"] = trimesh.util.concatenate(metal)
    x0, y0, x1, y1 = parts["U3"]["crt"]                  # the codec: a 3 x 3 QFN
    cxq, cyq = P.bx2x((x0 + x1) / 2), P.by2y((y0 + y1) / 2)
    out["board_161616"] = trimesh.util.concatenate([out.get("board_161616", trimesh.Trimesh()),
        trimesh.creation.box(bounds=[[cxq - 1.5, cyq - 1.5, P.Z_BB - 0.9], [cxq + 1.5, cyq + 1.5, P.Z_BB]])])
    out.update(esp32())
    whole = sum(len(m.faces) for m in out.values())
    for k, m in out.items():                   # keep the board's share of faces
        target = max(200, int(FACES["board"] * len(m.faces) / whole))
        out[k] = H.decimate(m, target)
    return out


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    scene = trimesh.Scene()

    def add(name, mesh):
        mesh = mesh.copy()
        mesh.visual = trimesh.visual.ColorVisuals(mesh)
        scene.add_geometry(mesh, node_name=name, geom_name=name)

    zc = P.Z_LT + P.CAP_TOP
    for name in ("tray", "lid", "bezel"):      # print-posed STLs back to their assembled place
        m = trimesh.load(P.OUT / f"{name}.stl")
        if name == "lid":
            m.apply_translation([0, 0, P.Z_LU])
        if name == "bezel":
            h = m.extents[2]
            m.apply_transform(trimesh.transformations.rotation_matrix(math.pi, [1, 0, 0]))
            m.apply_translation([P.bx2x(P.DISP_X0 + P.STD_W / 2), P.by2y(P.DISP_MID), P.Z_LT + h])
        add(name, H.decimate(m, FACES[name]))
    rides = {}
    for st in P.CRADLE_STYLES:
        m = trimesh.load(P.OUT / f"cradle-{st}.stl")
        m.apply_translation([0, 0, zc - m.bounds[0][2]])
        add(f"cradle-{st}", H.decimate(m, FACES["cradle"]))
        rides[st] = 0.0
    for line in (H.OUT / "checks.txt").read_text().splitlines():
        if " holds a 40 mm handle:" in line:
            key = line.split()[1]
            rides[key] = float(line.split("(")[1].split(" vs")[0])
            m = trimesh.load(H.OUT / f"cradle-{key}.stl", force="mesh")
            m.apply_translation([0, 0, zc - m.bounds[0][2]])
            add(f"cradle-{key}", H.decimate(m, FACES["cradle"]))
    for k, m in board().items():
        add(k, m)
    add("switch", switch())
    add("keycap", keycap())
    w, hgt = P.DISP_W, P.DISP_H                # display module (2.9"): green board + panel
    cx, cy = P.bx2x(P.DISP_X0 + w / 2), P.by2y(P.DISP_MID)
    for k, m in weact_module().items():
        add(k, H.decimate(m, 6000))
    gx = P.bx2x(P.DISP_X0 + P.DSP["view_cx"])
    add("panel", trimesh.creation.box(bounds=[[gx - 39.5, cy - 15.5, P.Z_DISP + P.MODULE_PCB_T],
                                              [gx + 39.5, cy + 15.5, P.Z_DISP + P.MODULE_PCB_T + 1.0]]))
    own = OUT / "handset.stl"                  # a receiver model (CC0 Red Table Phone's, smoothed)
    if own.exists():
        hs = trimesh.load(own, force="mesh")
        e = hs.extents
        order = np.argsort(e)                  # longest -> y, shortest -> z (lying, cups down)
        R = np.zeros((4, 4)); R[3, 3] = 1
        R[1, order[2]] = R[0, order[1]] = R[2, order[0]] = 1
        hs.apply_transform(R)
        hs.apply_scale(210.0 / hs.extents[1])
        hs.apply_translation([-hs.centroid[0], -hs.centroid[1], -hs.bounds[0][2]])
        hs = H.decimate(hs, 20000)
        v = hs.vertices                        # the handle's underside, mid-length
        mid = np.abs(v[:, 1]) < 12
        under_mid = float(v[mid, 2].min()) if mid.any() else hs.extents[2] * 0.55
    else:
        hs, under_mid = handset()
    g = P.cradle_geom()                        # handle's middle underside on the plain cradles
    hs.apply_translation([g["lx"], g["yc"], g["hb"] - under_mid])
    add("handset", hs)
    scene.export(OUT / "scene.glb")
    keys = [{"x": P.bx2x(bx), "y": P.by2y(by), "label": lab} for bx, by, lab in P.keys()]
    meta = {"keys": keys, "rides": rides, "plate": P.Z_LT, "cap_z": P.Z_LT + 6.6,
            "center": [P.OUT_W / 2, P.OUT_H / 2], "panel": [gx, cy, P.Z_DISP + P.MODULE_PCB_T + 1.01, 79, 31],
            "explode": {"tray": 0, "board": 34, "switch": 62, "lid": 56, "module": 86, "panel": 86,
                        "keycap": 104, "bezel": 122, "cradle": 150, "handset": 200}}
    (OUT / "scene.json").write_text(json.dumps(meta))
    print("scene.glb", round((OUT / "scene.glb").stat().st_size / 1e6, 2), "MB;", len(scene.geometry), "meshes")


if __name__ == "__main__":
    main()
