"""Scene for the site teaser: build/teaser/scene.glb (mm, z up, the shell's frame).

Named meshes: tray, lid, bezel, board_* (the KiCad board by material, plus stand-ins for the
parts whose 3D models KiCad's library lacks), switch, keycap, module, panel, handset and one
cradle-<style> per cradle (plain styles from build/proto, sculpted ones from build/hands).
The page instances switch/keycap per key and recolours shells, cradles and the handset.

    .venv/bin/python teaser.py      # after make proto (2.9" display) and make hands
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
    stand = {"U1": 3.2, "J1": 3.26, "J2": 4.0}
    metal = []
    for ref, h in stand.items():
        x0, y0, x1, y1 = parts[ref]["crt"]
        wx0, wx1 = P.bx2x(x0) + 0.3, P.bx2x(x1) - 0.3
        wy0, wy1 = sorted((P.by2y(y0), P.by2y(y1)))
        metal.append(trimesh.creation.box(bounds=[[wx0, wy0 + 0.3, P.Z_BB - h], [wx1, wy1 - 0.3, P.Z_BB]]))
    out["board_metal"] = trimesh.util.concatenate(metal)
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
    add("module", trimesh.creation.box(bounds=[[cx - w / 2, cy - hgt / 2, P.Z_DISP],
                                               [cx + w / 2, cy + hgt / 2, P.Z_DISP + P.MODULE_PCB_T]]))
    gx = P.bx2x(P.DISP_X0 + P.DSP["view_cx"])
    add("panel", trimesh.creation.box(bounds=[[gx - 39.5, cy - 15.5, P.Z_DISP + P.MODULE_PCB_T],
                                              [gx + 39.5, cy + 15.5, P.Z_DISP + P.MODULE_PCB_T + 1.0]]))
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
