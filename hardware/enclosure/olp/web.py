"""Web GLBs for the site's three.js configurator (build/web/*.glb + manifest.json).

Units: metres. Axes: three.js Y-up; +Z points out of the phone's front (toward the viewer),
+X to the right. Origin: centre of the base footprint on the table. Every GLB is in its part's
local frame; manifest instances give the assembled position (rotation is identity for all parts
except where stated). Materials are single PBR materials so colours can be swapped."""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import trimesh
from build123d import Pos

from .common import Geo, union
from . import handset, hook, refparts
from .parts import Build
from .render import mesh_of

S = 0.001


def to_three(g: Geo, V, origin=(0.0, 0.0, 0.0)):
    V = np.asarray(V, float) - np.asarray(origin, float)
    return np.c_[V[:, 0], V[:, 2], -V[:, 1]] * S


def pos_three(g: Geo, p):
    return [round((p[0] - g.xc) * S, 6), round(p[2] * S, 6), round(-(p[1] - g.yc) * S, 6)]


def _hex(c):
    c = c.lstrip("#")
    return [int(c[i:i + 2], 16) / 255 for i in (0, 2, 4)] + [1.0]


def _mesh(g, shape, origin, color, metallic=0.0, rough=0.6, tol=0.12):
    V, F = mesh_of(shape, tol, 0.3)
    m = trimesh.Trimesh(to_three(g, V, origin), F, process=True)
    mat = trimesh.visual.material.PBRMaterial(baseColorFactor=_hex(color), metallicFactor=metallic, roughnessFactor=rough)
    m.visual = trimesh.visual.TextureVisuals(material=mat)
    return m


def write_glb(path: Path, nodes):
    sc = trimesh.Scene()
    for name, m in nodes:
        sc.add_geometry(m, node_name=name, geom_name=name)
    path.write_bytes(sc.export(file_type="glb"))
    return sum(len(m.faces) for _, m in nodes)


def origin_of(shape):
    bb = shape.bounding_box()
    return ((bb.min.X + bb.max.X) / 2, (bb.min.Y + bb.max.Y) / 2, bb.min.Z)


def export(g: Geo, B: Build, out: Path):
    out.mkdir(parents=True, exist_ok=True)
    man = {"units": "m", "up": "+Y", "front": "+Z",
           "origin": "centre of the base footprint on the table",
           "note": "GLB meshes are in part-local frames; place each instance at its position (rotation [0,0,0] unless given).",
           "parts": [], "anchors": {}}

    def add(name, role, shape, color, recolourable, printed, metallic=0.0, rough=0.6, instances=None, extra=None, tol=0.12):
        o = origin_of(shape)
        m = _mesh(g, shape, o, color, metallic, rough, tol)
        tris = write_glb(out / f"{name}.glb", [(name, m)])
        e = {"file": f"{name}.glb", "role": role, "recolourable": recolourable, "default_color": color,
             "printed": printed, "triangles": tris,
             "instances": instances or [{"name": name, "position": pos_three(g, o), "rotation_deg": [0, 0, 0]}]}
        if extra:
            e.update(extra)
        man["parts"].append(e)
        return o

    P = {p.name: p for p in B.printed}
    add("base_top", "base_top", P["base_top"].shape, "#e8e1d1", True, True, extra={"variant": "e-ink"})
    add("base_top_lite", "base_top", P["base_top_lite"].shape, "#e8e1d1", True, True, extra={"variant": "lite (no display)", "alternative_to": "base_top"})
    add("base_bottom", "base_bottom", P["base_bottom"].shape, "#8e8a82", True, True)
    add("light_bar", "light_bar", P["light_bar"].shape, "#f4f4ee", False, True, rough=0.2)
    add("key_plate", "key_plate", B.refs["key_plate"], "#3a3a3a", False, False)
    add("deck_pcb", "pcb_deck", B.refs["deck_pcb"], "#1f5130", False, False)
    add("main_pcb", "pcb_main", B.refs["main_pcb"], "#1f5130", False, False)
    add("eink_panel", "eink", B.refs["eink"], "#d9dad2", False, False, rough=0.9)
    for m in g.p["hook"]["inserts"]:
        for side in ("left", "right"):
            add(f"hook_rest_saddle_{m}_{side}", "hook_rest", P[f"saddle_{m}_{side}"].shape, "#2e2e30", True, True,
                extra={"handset_family": m, "side": side})
    # tube + plunger: one mesh each, two instances
    for nm, role, shp, col, met, rough in (("hook_rest_tube", "hook_rest_post", B.refs["tubes"][0], "#b9bec4", 1.0, 0.35),
                                           ("plunger", "plunger", B.refs["plungers"][0], "#b8412a", 0.0, 0.5)):
        o0 = origin_of(shp)
        insts = []
        for i in (0, 1):
            dx = g.posts[i][0] - g.posts[0][0]
            insts.append({"name": f"{nm}_{i}", "position": pos_three(g, (o0[0] + dx, o0[1], o0[2])), "rotation_deg": [0, 0, 0]})
        add(nm, role, shp, col, nm == "plunger" or True, nm == "plunger", metallic=met, rough=rough, instances=insts,
            extra={"travel_m": g.p["hook"]["plunger"]["travel"] * S, "travel_axis": "+Y"} if nm == "plunger" else
            {"finish_options": ["brushed aluminium", "brass", "black anodised"]})
    # handsets (reference models of off-the-shelf products; local frame = handset coords)
    for m in g.p["hook"]["inserts"]:
        hs = handset.reference(g, m)
        rl = handset.rest_location(g, m)
        V, F = mesh_of(hs, 0.2, 0.3)
        mesh = trimesh.Trimesh(to_three(g, V), F, process=True)
        col = "#5f7472" if m == "pop" else "#e4dcc6"
        mesh.visual = trimesh.visual.TextureVisuals(material=trimesh.visual.material.PBRMaterial(baseColorFactor=_hex(col), metallicFactor=0.0, roughnessFactor=0.3))
        tris = write_glb(out / f"handset_{m}.glb", [(f"handset_{m}", mesh)])
        rp = rl.position
        man["parts"].append({"file": f"handset_{m}.glb", "role": "handset", "recolourable": True, "default_color": col,
                             "printed": False, "triangles": tris, "model": m,
                             "instances": [{"name": f"handset_{m}", "position": pos_three(g, (rp.X, rp.Y, rp.Z)), "rotation_deg": [0, 0, 0]}],
                             "local_frame": "x along the handset (0 = mouthpiece end), cup-face centre at y=0"})
    # keycap + MX switch (local frames)
    cap = refparts.keycap_local(g.p)
    Vk, Fk = mesh_of(cap, 0.08, 0.2)
    km = trimesh.Trimesh(to_three(g, Vk), Fk, process=True)
    km.visual = trimesh.visual.TextureVisuals(material=trimesh.visual.material.PBRMaterial(baseColorFactor=_hex("#f6f3ec"), roughnessFactor=0.5))
    tris = write_glb(out / "keycap_1u.glb", [("keycap_1u", km)])
    inst = [{"name": f"key_{lbl}", "label": lbl, "position": pos_three(g, (x, y, g.ks["cap_base"])), "rotation_deg": [0, 0, 0]}
            for lbl, x, y in g.keys]
    man["parts"].append({"file": "keycap_1u.glb", "role": "keycap_1u", "recolourable": True, "default_color": "#f6f3ec",
                         "printed": False, "triangles": tris, "profile": "DSA 1u", "instances": inst,
                         "press_travel_m": g.p["keys"]["travel"] * S, "press_axis": "-Y"})
    hsg = refparts.mx_switch_local()
    stem = refparts.mx_switch_local(stem_only=True)
    Vh, Fh = mesh_of(hsg, 0.08, 0.2)
    Vs, Fs = mesh_of(stem, 0.05, 0.2)
    hm = trimesh.Trimesh(to_three(g, Vh), Fh, process=True)
    hm.visual = trimesh.visual.TextureVisuals(material=trimesh.visual.material.PBRMaterial(baseColorFactor=_hex("#26262a"), roughnessFactor=0.6))
    sm = trimesh.Trimesh(to_three(g, Vs), Fs, process=True)
    sm.visual = trimesh.visual.TextureVisuals(material=trimesh.visual.material.PBRMaterial(baseColorFactor=_hex("#8a5a2b"), roughnessFactor=0.5))
    tris = write_glb(out / "mx_switch.glb", [("housing", hm), ("stem", sm)])
    inst = [{"name": f"switch_{lbl}", "label": lbl, "position": pos_three(g, (x, y, g.ks["plate_top"])), "rotation_deg": [0, 0, 0]}
            for lbl, x, y in g.keys]
    man["parts"].append({"file": "mx_switch.glb", "role": "mx_switch", "recolourable": True, "default_color": "#8a5a2b",
                         "recolourable_nodes": ["stem"], "printed": False, "triangles": tris, "instances": inst,
                         "local_frame": "origin at the plate top, switch centre"})

    # anchors
    k = g.ks
    man["anchors"]["keys"] = [{"label": lbl, "cap_base": pos_three(g, (x, y, k["cap_base"])),
                               "cap_top": pos_three(g, (x, y, k["cap_top"]))} for lbl, x, y in g.keys]
    for m in g.p["hook"]["inserts"]:
        rl = handset.rest_location(g, m).position
        cp = handset.cord_point(g, m)
        man["anchors"][f"handset_rest_pose_{m}"] = {"position": pos_three(g, (rl.X, rl.Y, rl.Z)), "rotation_deg": [0, 0, 0]}
        man["anchors"][f"handset_cord_attach_{m}"] = {"local": to_three(g, [cp])[0].round(6).tolist(),
                                                      "world": pos_three(g, (rl.X + cp[0], rl.Y + cp[1], rl.Z + cp[2]))}
    if g.has_main("usb_handset"):
        x0, x1, _, _ = g.main_part_rect("usb_handset")
        man["anchors"]["base_cord_attach"] = {"world": pos_three(g, ((x0 + x1) / 2, g.D, g.main_zt + 1.63)),
                                              "direction": [0, 0, -1], "connector": "USB-C receptacle (handset)"}
        x0, x1, _, _ = g.main_part_rect("usb_c")
        man["anchors"]["base_power_port"] = {"world": pos_three(g, ((x0 + x1) / 2, g.D, g.main_zt + 1.63)), "direction": [0, 0, -1]}
    man["anchors"]["posts"] = [pos_three(g, (x, y, g.pl["pin_top"])) for x, y in g.posts]
    man["anchors"]["eink_view_centre"] = pos_three(g, ((g.panel_rect[0] + g.panel_rect[1]) / 2, (g.panel_rect[2] + g.panel_rect[3]) / 2, g.H))
    (out / "manifest.json").write_text(json.dumps(man, indent=1))
    total = sum((out / e["file"]).stat().st_size for e in man["parts"])
    return man, total
