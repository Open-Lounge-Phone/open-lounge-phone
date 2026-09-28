"""Build a KiCad board from the SKiDL netlist + boards.yaml + placement.yaml (KiCad Python).

    python build_board.py main|deck [--variant kids] [--stage place|route|all]

Stages (all by default):
  place  project files, outline, holes, keep-outs, footprints (all variants' footprints placed,
         DNP from --variant), zones, silkscreen, GND fan-out vias, hand routes (USB pair)
  route  Specctra DSN -> FreeRouting (headless) -> SES import
  all    place + route + zone fill + GND stitching + deterministic save

The board is written to hardware/kicad/<board>/<board>.kicad_pcb (committed). Checks and fab
outputs are separate scripts (checks.py, export.py).
"""

from __future__ import annotations

import argparse
import json
import math
import re
import shutil
import subprocess
import sys
import uuid
from pathlib import Path

import kienv  # noqa: F401  (sets sys.path for yaml)
from kienv import BUILD, FREEROUTING_JAR, JAVA, KICAD_OUT, LAYOUT, lib_path, load_yaml

import pcbnew  # noqa: E402

import netlist as nl  # noqa: E402

MM = pcbnew.FromMM
ORIGIN = (40.0, 40.0)  # board (0,0) on the KiCad page, mm
CU = {"F.Cu": pcbnew.F_Cu, "In1.Cu": pcbnew.In1_Cu, "In2.Cu": pcbnew.In2_Cu, "B.Cu": pcbnew.B_Cu}


def P(x, y) -> pcbnew.VECTOR2I:
    return pcbnew.VECTOR2I(MM(ORIGIN[0] + x), MM(ORIGIN[1] + y))


def unP(v) -> tuple[float, float]:
    return pcbnew.ToMM(v.x) - ORIGIN[0], pcbnew.ToMM(v.y) - ORIGIN[1]


# ---------------------------------------------------------------------------------------------
# project files


def netclass_of(name: str, nodes: list, rules: list) -> str:
    for r in rules:
        if "pattern" in r and re.search(r["pattern"], name):
            return r["class"]
        if "pads" in r and any(p in r["pads"].get(ref, []) for ref, p in nodes):
            return r["class"]
    return "Default"


def write_project(board: str, cfg: dict, net: nl.Netlist, out: Path) -> dict:
    """.kicad_pro (net classes + rules), fp-lib-table, fab-common.kicad_dru. Returns net->class."""
    classes = []
    for name, c in cfg["netclasses"].items():
        dp = c.get("diff_pair", [0.2, 0.25])
        classes.append({
            "bus_width": 12, "clearance": c["clearance"], "diff_pair_gap": dp[1],
            "diff_pair_via_gap": 0.25, "diff_pair_width": dp[0], "line_style": 0,
            "microvia_diameter": 0.3, "microvia_drill": 0.1, "name": name,
            "pcb_color": "rgba(0, 0, 0, 0.000)", "priority": len(classes) if name != "Default" else 2147483647,
            "schematic_color": "rgba(0, 0, 0, 0.000)", "track_width": c["track"],
            "via_diameter": c["via"][0], "via_drill": c["via"][1], "wire_width": 6,
        })
    assign = {}
    for n, nodes in sorted(net.nets.items()):
        cls = netclass_of(n, nodes, cfg["netclass_rules"])
        if cls != "Default":
            assign[n] = cls
    r = cfg["rules"]
    pro = {
        "board": {
            "design_settings": {
                "defaults": {"board_outline_line_width": 0.05, "copper_line_width": 0.2,
                             "silk_line_width": 0.12, "silk_text_size_h": 0.8,
                             "silk_text_size_v": 0.8, "silk_text_thickness": 0.12},
                "diff_pair_dimensions": [{"gap": 0.0, "via_gap": 0.0, "width": 0.0},
                                         {"gap": 0.15, "via_gap": 0.25, "width": 0.27}],
                "rule_severities": {"lib_footprint_issues": "ignore",
                                    "lib_footprint_mismatch": "ignore",
                                    "silk_over_copper": "ignore",
                                    "silk_overlap": "warning",
                                    "silk_edge_clearance": "warning",
                                    "text_height": "warning", "text_thickness": "warning",
                                    "missing_courtyard": "ignore",
                                    "npth_inside_courtyard": "ignore",
                                    "pth_inside_courtyard": "ignore",
                                    "footprint_symbol_mismatch": "ignore",
                                    "extra_footprint": "ignore", "missing_footprint": "ignore",
                                    "isolated_copper": "warning",
                                    "courtyards_overlap": "error",
                                    "starved_thermal": "warning"},
                "rules": {
                    "allow_blind_buried_vias": False, "allow_microvias": False,
                    "max_error": 0.005, "min_clearance": r["min_clearance"],
                    "min_connection": 0.0, "min_copper_edge_clearance": r["edge_clearance"],
                    "min_groove_width": 0.0,
                    "min_hole_clearance": 0.25, "min_hole_to_hole": r["hole_to_hole"],
                    "min_microvia_diameter": 0.2, "min_microvia_drill": 0.1,
                    "min_resolved_spokes": 1, "min_silk_clearance": 0.0,
                    "min_text_height": r["silk_min_text"], "min_text_thickness": 0.1,
                    "min_through_hole_diameter": r["min_hole"],
                    "min_track_width": r["min_track"], "min_via_annular_width": r["min_annular"],
                    "min_via_diameter": r["min_via_diameter"], "solder_mask_clearance": 0.0,
                    "solder_mask_min_width": 0.0, "solder_mask_to_copper_clearance": 0.0,
                    "use_height_for_length_calcs": True,
                },
                "track_widths": [0.0, 0.2, 0.25, 0.27, 0.4, 0.5, 0.6, 0.8],
                "via_dimensions": [{"diameter": 0.0, "drill": 0.0},
                                   {"diameter": 0.6, "drill": 0.3}],
            },
        },
        "boards": [],
        "libraries": {"pinned_footprint_libs": [], "pinned_symbol_libs": []},
        "meta": {"filename": f"{board}.kicad_pro", "version": 3},
        "net_settings": {"classes": classes, "meta": {"version": 4},
                         "netclass_assignments": None,
                         "netclass_patterns": [{"netclass": c, "pattern": n}
                                               for n, c in sorted(assign.items())]},
        "pcbnew": {"page_layout_descr_file": ""},
        "sheets": [], "text_variables": {},
    }
    out.mkdir(parents=True, exist_ok=True)
    (out / f"{board}.kicad_pro").write_text(json.dumps(pro, indent=2, sort_keys=True) + "\n")
    (out / "fp-lib-table").write_text(
        '(fp_lib_table\n\t(version 7)\n\t(lib (name "OpenLoungePhone")(type "KiCad")'
        '(uri "${KIPRJMOD}/../../layout/footprints/openloungephone.pretty")(options "")'
        '(descr "Open Lounge Phone project footprints"))\n)\n')
    shutil.copy(LAYOUT / "fab-common.kicad_dru", out / f"{board}.kicad_dru")
    return assign


def stackup_sexpr(cfg: dict) -> str:
    rows = ['\t\t(stackup',
            '\t\t\t(layer "F.SilkS" (type "Top Silk Screen"))',
            '\t\t\t(layer "F.Paste" (type "Top Solder Paste"))',
            '\t\t\t(layer "F.Mask" (type "Top Solder Mask") (thickness 0.01))']
    d = 0
    for item in cfg["stackup"]["layers"]:
        if item[1] == "copper":
            rows.append(f'\t\t\t(layer "{item[0]}" (type "copper") (thickness {item[2]}))')
        else:
            d += 1
            rows.append(f'\t\t\t(layer "dielectric {d}" (type "{item[0]}") (thickness {item[1]}) '
                        f'(material "FR4") (epsilon_r {item[2]}) (loss_tangent 0.02))')
    rows += ['\t\t\t(layer "B.Mask" (type "Bottom Solder Mask") (thickness 0.01))',
             '\t\t\t(layer "B.Paste" (type "Bottom Solder Paste"))',
             '\t\t\t(layer "B.SilkS" (type "Bottom Silk Screen"))',
             f'\t\t\t(copper_finish "{cfg["stackup"]["finish"]}")',
             '\t\t\t(dielectric_constraints no)', '\t\t)']
    return "\n".join(rows) + "\n"


def insert_stackup(pcb: Path, cfg: dict) -> None:
    text = pcb.read_text()
    text = re.sub(r"\t\t\(stackup\n.*?\n\t\t\)\n", "", text, flags=re.S)
    text = text.replace("\t(setup\n", "\t(setup\n" + stackup_sexpr(cfg), 1)
    pcb.write_text(text)


# ---------------------------------------------------------------------------------------------
# geometry


def add_shape(board, layer, kind, pts, width=0.05, fill=False):
    s = pcbnew.PCB_SHAPE(board)
    s.SetLayer(layer)
    s.SetWidth(MM(width))
    if kind == "seg":
        s.SetShape(pcbnew.SHAPE_T_SEGMENT)
        s.SetStart(P(*pts[0]))
        s.SetEnd(P(*pts[1]))
    elif kind == "arc":
        s.SetShape(pcbnew.SHAPE_T_ARC)
        s.SetArcGeometry(P(*pts[0]), P(*pts[1]), P(*pts[2]))
    elif kind == "rect":
        s.SetShape(pcbnew.SHAPE_T_RECT)
        s.SetStart(P(*pts[0]))
        s.SetEnd(P(*pts[1]))
        s.SetFilled(fill)
    elif kind == "circle":
        s.SetShape(pcbnew.SHAPE_T_CIRCLE)
        s.SetCenter(P(*pts[0]))
        s.SetEnd(P(pts[0][0] + pts[1], pts[0][1]))
        s.SetFilled(fill)
    board.Add(s)
    return s


def rounded_outline(board, w, h, r, notches=()):
    """Rectangle with rounded corners; notches = [x0, 0, x1, depth] cut into the top edge."""
    L = pcbnew.Edge_Cuts
    top = [(r, 0)]
    for x0, _, x1, d in sorted(notches):
        top += [(x0, 0), (x0, d), (x1, d), (x1, 0)]
    top += [(w - r, 0)]
    for a, b in zip(top, top[1:]):
        if a != b:
            add_shape(board, L, "seg", [a, b])
    k = r * (1 - math.sqrt(0.5))
    add_shape(board, L, "arc", [(w - r, 0), (w - k, k), (w, r)])
    add_shape(board, L, "seg", [(w, r), (w, h - r)])
    add_shape(board, L, "arc", [(w, h - r), (w - k, h - k), (w - r, h)])
    add_shape(board, L, "seg", [(w - r, h), (r, h)])
    add_shape(board, L, "arc", [(r, h), (k, h - k), (0, h - r)])
    add_shape(board, L, "seg", [(0, h - r), (0, r)])
    add_shape(board, L, "arc", [(0, r), (k, k), (r, 0)])


def slot(board, x0, y0, x1, y1):
    """Rounded slot (stadium) cut-out on Edge.Cuts."""
    L = pcbnew.Edge_Cuts
    if (x1 - x0) < (y1 - y0):  # vertical
        r = (x1 - x0) / 2
        cx = x0 + r
        add_shape(board, L, "seg", [(x0, y0 + r), (x0, y1 - r)])
        add_shape(board, L, "seg", [(x1, y0 + r), (x1, y1 - r)])
        add_shape(board, L, "arc", [(x0, y0 + r), (cx, y0), (x1, y0 + r)])
        add_shape(board, L, "arc", [(x1, y1 - r), (cx, y1), (x0, y1 - r)])
    else:
        r = (y1 - y0) / 2
        cy = y0 + r
        add_shape(board, L, "seg", [(x0 + r, y0), (x1 - r, y0)])
        add_shape(board, L, "seg", [(x0 + r, y1), (x1 - r, y1)])
        add_shape(board, L, "arc", [(x0 + r, y1), (x0, cy), (x0 + r, y0)])
        add_shape(board, L, "arc", [(x1 - r, y0), (x1, cy), (x1 - r, y1)])


def all_copper():
    ls = pcbnew.LSET()
    for layer in CU.values():
        ls.AddLayer(layer)
    return ls


def add_zone(board, net, layer, poly, priority, name=""):
    z = pcbnew.ZONE(board)
    z.SetLayer(CU[layer])
    if net:
        z.SetNet(board.FindNet(net))
    ol = z.Outline()
    ol.NewOutline()
    for x, y in poly:
        ol.Append(MM(ORIGIN[0] + x), MM(ORIGIN[1] + y))
    z.SetAssignedPriority(priority)
    z.SetMinThickness(MM(0.2))
    z.SetLocalClearance(MM(0.25))
    z.SetThermalReliefGap(MM(0.3))
    z.SetThermalReliefSpokeWidth(MM(0.35))
    z.SetPadConnection(pcbnew.ZONE_CONNECTION_THERMAL)
    z.SetIslandRemovalMode(pcbnew.ISLAND_REMOVAL_MODE_ALWAYS)
    if name:
        z.SetZoneName(name)
    board.Add(z)
    return z


def add_rule_area(board, poly, name, tracks=False, vias=False, pours=False, pads=True,
                  footprints=True, layers=None):
    z = pcbnew.ZONE(board)
    z.SetIsRuleArea(True)
    if layers:
        ls = pcbnew.LSET()
        for ln in layers:
            ls.AddLayer(CU[ln])
        z.SetLayerSet(ls)
    else:
        z.SetLayerSet(all_copper())
    ol = z.Outline()
    ol.NewOutline()
    for x, y in poly:
        ol.Append(MM(ORIGIN[0] + x), MM(ORIGIN[1] + y))
    z.SetDoNotAllowTracks(not tracks)
    z.SetDoNotAllowVias(not vias)
    z.SetDoNotAllowZoneFills(not pours)
    z.SetDoNotAllowPads(not pads)
    z.SetDoNotAllowFootprints(not footprints)
    z.SetZoneName(name)
    board.Add(z)
    return z


def circle_poly(cx, cy, r, n=24):
    return [(cx + r * math.cos(2 * math.pi * i / n), cy + r * math.sin(2 * math.pi * i / n))
            for i in range(n)]


def rect_poly(x0, y0, x1, y1):
    return [(x0, y0), (x1, y0), (x1, y1), (x0, y1)]


# ---------------------------------------------------------------------------------------------
# footprints


_FP_CACHE: dict = {}


def load_fp(fpid: str) -> pcbnew.FOOTPRINT:
    lib, name = fpid.split(":")
    fp = pcbnew.FootprintLoad(str(lib_path(lib)), name)
    if fp is None:
        raise SystemExit(f"footprint {fpid} not found in {lib_path(lib)}")
    fp.SetFPID(pcbnew.LIB_ID(lib, name))
    return fp


def place(fp, x, y, rot=0.0, side="top"):
    """rot is the angle as seen from the top; bottom parts are rotated, then mirrored L-R."""
    fp.SetPosition(P(x, y))
    fp.SetOrientationDegrees(rot)
    if side == "bottom" and not fp.IsFlipped():
        fp.Flip(fp.GetPosition(), pcbnew.FLIP_DIRECTION_LEFT_RIGHT)


def add_footprint(board, comp: nl.Comp, nets: dict, pin_net: dict):
    fp = load_fp(comp.footprint)
    fp.SetReference(comp.ref)
    fp.SetValue(comp.value)
    for key in ("MPN", "Manufacturer", "LCSC"):
        if comp.fields.get(key):
            fp.SetField(key, comp.fields[key])
            f = fp.GetField(key)
            f.SetVisible(False)
            f.SetLayer(pcbnew.F_Fab)
    exclude = comp.fields.get("BOM") == "exclude"
    fp.SetExcludedFromBOM(exclude)
    if exclude:
        fp.SetExcludedFromPosFiles(True)
    fp.SetDNP(comp.dnp)
    ref_t = fp.Reference()
    ref_t.SetTextSize(pcbnew.VECTOR2I(MM(0.8), MM(0.8)))
    ref_t.SetTextThickness(MM(0.12))
    for pad in fp.Pads():
        n = pin_net.get((comp.ref, pad.GetNumber()))
        if n:
            pad.SetNet(nets[n])
    board.Add(fp)
    return fp


def fix_fine_vias(fp, min_drill: float) -> None:
    """Some official footprints (ESP32-S3-WROOM-1 pad 41) carry 0.2 mm thermal vias, below the
    fab-common 0.3 mm drill. Keep every other one (>= 1.4 mm pitch) enlarged to 0.3/0.6."""
    fine = [p for p in fp.Pads() if p.GetAttribute() == pcbnew.PAD_ATTRIB_PTH
            and pcbnew.ToMM(p.GetDrillSize().x) < min_drill - 1e-6]
    if not fine:
        return
    keep = []
    for p in sorted(fine, key=lambda p: (p.GetPos0().y if hasattr(p, "GetPos0") else 0,
                                         p.GetPosition().x)):
        pos = p.GetPosition()
        if all((pos - k.GetPosition()).EuclideanNorm() >= MM(1.39) for k in keep):
            keep.append(p)
    for p in fine:
        if p in keep:
            p.SetDrillSize(pcbnew.VECTOR2I(MM(min_drill), MM(min_drill)))
            p.SetSize(pcbnew.VECTOR2I(MM(0.6), MM(0.6)))
        else:
            fp.Remove(p)


def add_board_fp(board, fpid, ref, x, y, rot=0.0, side="top", net=None, value=None):
    fp = load_fp(fpid)
    fp.SetReference(ref)
    fp.SetValue(value or fpid.split(":")[1])
    fp.SetExcludedFromBOM(True)
    fp.SetExcludedFromPosFiles(True)
    fp.SetBoardOnly(True)
    if net:
        for pad in fp.Pads():
            if pad.GetNumber():
                pad.SetNet(net)
    board.Add(fp)
    place(fp, x, y, rot, side)
    return fp


# ---------------------------------------------------------------------------------------------
# key grid (deck)


def key_positions(cfg_keys: dict, names: list[str]) -> dict:
    """name -> (x, y). Rear row: first half of the digits (dialling order 1..9, 0) + MENU;
    front row: the other digits + BACK (owner layout 2026-09-27)."""
    order = [str((i + 1) % 10) for i in range(10)]
    digits = sorted((n for n in names if n not in ("MENU", "BACK")), key=order.index)
    half = len(digits) // 2
    x = lambda i: cfg_keys["x0"] + i * cfg_keys["pitch"]  # noqa: E731
    pos = {}
    for i, n in enumerate(digits[:half] + ["MENU"]):
        pos[n] = (x(i), cfg_keys["y_rear"])
    for i, n in enumerate(digits[half:] + ["BACK"]):
        pos[n] = (x(i), cfg_keys["y_front"])
    return pos


key_labels: dict = {}


def key_placements(cfg: dict, net: nl.Netlist) -> dict:
    """ref -> [x, y, rot, side] for hot-swap sockets, key LEDs, their decoupling caps and the
    key pull-ups, derived from the netlist notes and the key grid."""
    keys = cfg["keys"]
    socket_of, led_of = {}, {}
    for ref, c in net.comps.items():
        note = c.fields.get("Note", "")
        m = re.fullmatch(r"key (\w+)", note)
        if m and c.fields.get("SpecKey") == "HOTSWAP":
            socket_of[m.group(1)] = ref
        m = re.fullmatch(r"LED (\d+): (\w+)", note)
        if m and c.fields.get("SpecKey") == "SK6812MINI-E":
            led_of[m.group(2)] = (ref, int(m.group(1)))
    names = [n for n in socket_of]
    pos = key_positions(keys, names)
    width = cfg["size"][0]
    if max(p[0] for p in pos.values()) + keys["pitch"] / 2 > width:
        raise SystemExit(f"{len(names)} keys do not fit the {width} mm deck (config n_keys)")
    out = {}
    key_labels.clear()
    key_labels.update(pos)
    lx, ly = keys["led_offset"]
    pin_net = net.pin_net()
    for name, (x, y) in pos.items():
        out[socket_of[name]] = [x, y, 0, "bottom"]
        led_ref, idx = led_of[name]
        out[led_ref] = [x + lx, y + ly, 0, "bottom"]
        # LED decoupling cap (note "LED i") beside the LED; key pull-up beside the socket
        for ref, c in net.comps.items():
            if c.fields.get("Note") == f"LED {idx}" and ref.startswith("C"):
                out[ref] = [x + 5.6, y + ly, 90, "bottom"]
        knet = f"KEY_{name}"
        for ref, pin in net.nets.get(knet, []):
            if ref.startswith("R") and net.comps[ref].fields.get("SpecKey", "").startswith("_R"):
                out[ref] = [x - 5.6, y + ly, 90, "bottom"]
    return out, led_of


# ---------------------------------------------------------------------------------------------
# automatic placement of the small parts (placement.yaml lists ICs, connectors and anything
# position-critical; resistors/capacitors/beads follow the pin they serve)

SUPPLY = {"GND", "3V3", "3V0", "VSYS", "VBUS", "VBUS_C", "VBAT", "VLED", "HS_VIN", "HS_VBUS"}
NOTE_HINTS = [  # decoupling-cap note keyword -> reference of the part it belongs to
    ("module 3V3", "U1"), ("buck input", "U3"), ("NS4150B", "U9"), ("SN74LV1T125", "U5"),
    ("ES8311", "U6"), ("ES7210", "U7"), ("DRV5032", "U10"), ("LIS2DH12", "U12"),
    ("ATECC608B", "U13"), ("MAX17048", "U14"), ("CH340C", "U16"), ("handset VBUS", "U15"),
    ("AW9523B", "U17"), ("LTR-303", "U18"), ("ST25DV", "U19"), ("EPD", "J6"), ("boost", "L3"),
]


def _crtyd(fp):
    lay = pcbnew.B_CrtYd if fp.IsFlipped() else pcbnew.F_CrtYd
    poly = fp.GetCourtyard(lay)
    bb = poly.BBox() if poly.OutlineCount() else fp.GetBoundingBox(False)
    x0, y0 = unP(bb.GetOrigin())
    x1, y1 = unP(bb.GetEnd())
    return x0, y0, x1, y1


def auto_place(board, cfg, fps, net, placed, log=print):
    """Place every footprint not in `placed` next to the pad it serves (first legal spot on
    growing rings, 0/90 degrees, same side), deterministic. Test pads go to the pogo grid."""
    w, h = cfg["size"]
    boxes = {r: _crtyd(fps[r]) for r in placed if r in fps}
    for fp in board.GetFootprints():
        if fp.GetReference() not in fps:
            boxes[fp.GetReference()] = _crtyd(fp)
    # routing room: keep passives `fine_pitch_gap` away from fine-pitch ICs (their pins need
    # escape channels) and `place_gap` from each other
    fg = cfg.get("fine_pitch_gap", 0.0)
    for r in list(boxes):
        fp = fps.get(r) or board.FindFootprintByReference(r)
        if fg and fp is not None and _fine_pitch(fp):
            x0, y0, x1, y1 = boxes[r]
            boxes[r] = (x0 - fg, y0 - fg, x1 + fg, y1 + fg)
    for k, t in enumerate(board.GetTracks()):  # hand routes laid before auto placement
        x0, y0 = unP(t.GetStart())
        x1, y1 = unP(t.GetEnd())
        m = pcbnew.ToMM(t.GetWidth()) / 2 + 0.4
        boxes[f"_track{k}"] = (min(x0, x1) - m, min(y0, y1) - m, max(x0, x1) + m, max(y0, y1) + m)
    no_parts = [k["rect"] for k in cfg.get("keepouts", []) if k.get("footprints") is False]
    no_parts += [n[:4] for n in cfg.get("notches", [])]
    no_parts += [(x0 - 0.4, y0 - 0.4, x1 + 0.4, y1 + 0.4) for x0, y0, x1, y1 in cfg.get("slots", [])]
    zones = [z for z in board.Zones() if z.GetIsRuleArea() and z.GetDoNotAllowFootprints()]
    for fp in board.GetFootprints():
        zones += [z for z in fp.Zones() if z.GetIsRuleArea() and z.GetDoNotAllowFootprints()]

    def free(box, ref):
        x0, y0, x1, y1 = box
        if x0 < 0.4 or y0 < 0.4 or x1 > w - 0.4 or y1 > h - 0.4:
            return False
        for b in list(boxes.values()) + no_parts:
            if x0 < b[2] and x1 > b[0] and y0 < b[3] and y1 > b[1]:
                return False
        for z in zones:
            for px, py in ((x0, y0), (x1, y0), (x0, y1), (x1, y1), ((x0 + x1) / 2, (y0 + y1) / 2)):
                if z.Outline().Contains(P(px, py)):
                    return False
        return True

    pin_net = net.pin_net()
    by_net = {}
    for (r, p_), n in pin_net.items():
        by_net.setdefault(n, []).append((r, p_))
    tp_cfg = cfg.get("testpoints", {})
    tps = [r for r in sorted(fps, key=nl_sort) if r not in placed and r.startswith("TP")]
    top_tp = set(tp_cfg.get("top_nets", []))
    gx, gy = tp_cfg.get("origin", [2.0, 2.0])
    cols, pitch = tp_cfg.get("cols", 6), tp_cfg.get("pitch", 2.54)
    k = 0
    for r in tps:
        n = pin_net.get((r, "1"))
        if n in top_tp:
            continue  # placed like a passive, on top, next to its net
        place(fps[r], gx + (k % cols) * pitch, gy + (k // cols) * pitch, 0,
              tp_cfg.get("side", "bottom"))
        boxes[r] = _crtyd(fps[r])
        placed.add(r)
        k += 1
    todo = [r for r in sorted(fps, key=nl_sort) if r not in placed]
    assigned = {}
    for _pass in range(4):
        left = [r for r in todo if r not in placed]
        if not left:
            break
        final = _pass == 3
        _auto_pass(left, fps, net, placed, boxes, free, pin_net, by_net, assigned, board,
                   w, final, log, gap=cfg.get("place_gap", 0.1))


def _fine_pitch(fp, limit=0.8):
    """True for footprints with >= 8 pads and a pin pitch below `limit` mm (QFN, TSSOP, FFC)."""
    smd = [p for p in fp.Pads() if p.GetAttribute() == pcbnew.PAD_ATTRIB_SMD]
    sizes = {}
    for p in smd:  # pitch of the signal pins = the most common pad size (not EP/thermal grid)
        k = tuple(sorted((round(pcbnew.ToMM(p.GetSize().x), 2), round(pcbnew.ToMM(p.GetSize().y), 2))))
        sizes.setdefault(k, []).append(unP(p.GetPosition()))
    pads = max(sizes.values(), key=len) if sizes else []
    if len(pads) < 8:
        return False
    best = min(math.hypot(a[0] - b[0], a[1] - b[1]) for i, a in enumerate(pads)
               for b in pads[i + 1:])
    return best < limit


def _auto_pass(todo, fps, net, placed, boxes, free, pin_net, by_net, assigned, board, w,
               final, log, gap=0.1):
    for r in todo:
        fp = fps[r]
        nets = sorted({n for (rr, _), n in pin_net.items() if rr == r})
        comp = net.comps[r]
        anchor = None
        sig = [n for n in nets if n not in SUPPLY]
        cands = []
        for n in sig:
            for rr, pn in by_net.get(n, []):
                if rr in placed and rr != r:
                    cands.append((len(by_net[n]), not rr.startswith(("U", "J")), nl_sort(rr), rr, pn))
        if cands:
            cands.sort()
            _, _, _, rr, pn = cands[0]
            anchor = (rr, pn)
        else:
            note = comp.fields.get("Note", "")
            want = next((ref for kw, ref in NOTE_HINTS if kw in note and ref in placed), None)
            m_led = re.fullmatch(r"LED (\d+)", note)
            if m_led:  # per-LED decoupling cap: the LED with that chain index
                want = next((rr for rr, cc in net.comps.items()
                             if cc.fields.get("Note", "").startswith(f"LED {m_led.group(1)}:")),
                            want)
            supply = [n for n in nets if n != "GND"]
            for n in supply:
                pads = [(rr, pn) for rr, pn in by_net.get(n, []) if rr in placed
                        and rr.startswith(("U", "J", "Q", "D", "L")) and (want is None or rr == want)]
                if pads:
                    pads.sort(key=lambda x: (assigned.get(x, 0), nl_sort(x[0]), x[1]))
                    anchor = pads[0]
                    assigned[anchor] = assigned.get(anchor, 0) + 1
                    break
        if anchor is None:
            if final:
                log(f"auto_place: no anchor for {r}; parked beside the board")
                place(fp, w + 5, 5 + 3 * len([x for x in todo if x < r]), 0, "top")
            continue
        afp = fps.get(anchor[0]) or board.FindFootprintByReference(anchor[0])
        ax, ay = next(unP(p_.GetPosition()) for p_ in afp.Pads() if p_.GetNumber() == anchor[1])
        side = "bottom" if afp.IsFlipped() else "top"
        cx, cy = unP(afp.GetPosition())
        base = math.atan2(ay - cy, ax - cx)
        done = False
        for rad in [1.6 + 0.6 * i for i in range(32)]:
            for kk in range(16):
                ang = base + (1 if kk % 2 else -1) * ((kk + 1) // 2) * math.pi / 8
                x, y = ax + rad * math.cos(ang), ay + rad * math.sin(ang)
                x, y = round(x * 10) / 10, round(y * 10) / 10
                for rot in ((0, 90) if abs(math.cos(ang)) > 0.7 else (90, 0)):
                    place(fps[r], x, y, rot, side)
                    box = _crtyd(fps[r])
                    box = (box[0] - gap, box[1] - gap, box[2] + gap, box[3] + gap)
                    if free(box, r):
                        boxes[r] = box
                        placed.add(r)
                        done = True
                        break
                if done:
                    break
            if done:
                break
        if not done:
            log(f"auto_place: no room for {r} near {anchor[0]}.{anchor[1]}; parked beside the board")
            place(fp, w + 5, 5 + 3 * len([x for x in todo if x < r]), 0, "top")


def text(board, s, x, y, size=1.0, layer=pcbnew.F_SilkS, rot=0, bold=False, mirror=None):
    t = pcbnew.PCB_TEXT(board)
    t.SetText(s)
    t.SetPosition(P(x, y))
    t.SetLayer(layer)
    t.SetTextSize(pcbnew.VECTOR2I(MM(size), MM(size)))
    t.SetTextThickness(MM(size * (0.2 if bold else 0.15)))
    t.SetTextAngleDegrees(rot)
    if mirror or (mirror is None and layer in (pcbnew.B_SilkS, pcbnew.B_Fab)):
        t.SetMirrored(True)
    board.Add(t)
    return t


def build_place(board_name: str, variant: str, cfg_all: dict, placement: dict, out: Path,
                stage_unplaced: bool = False) -> Path:
    cfg = dict(cfg_all[board_name])
    cfg.update({k: cfg_all[k] for k in ("rules", "netclasses", "netclass_rules", "stackup")})
    net = nl.read(BUILD / f"{board_name}-{variant}" / f"{cfg['netlist']}.net")
    write_project(board_name, cfg, net, out)
    pcb_path = out / f"{board_name}.kicad_pcb"

    board = pcbnew.BOARD()
    board.SetCopperLayerCount(4)
    board.SetFileName(str(pcb_path))
    tb = board.GetTitleBlock()
    tb.SetTitle(cfg["title"])
    tb.SetRevision("r0.1")
    tb.SetCompany("Open Lounge Phone - CERN-OHL-S-2.0")
    tb.SetComment(0, f"generated by hardware/layout/build_board.py from build/{board_name}-*/")

    nets = {}
    for name in sorted(net.nets):
        ni = pcbnew.NETINFO_ITEM(board, name)
        board.Add(ni)
        nets[name] = ni
    w, h = cfg["size"]
    rounded_outline(board, w, h, cfg["corner_radius"], cfg.get("notches", []))
    for s in cfg.get("slots", []):
        slot(board, *s)

    pin_net = net.pin_net()
    fps = {}
    for ref in sorted(net.comps):
        fps[ref] = add_footprint(board, net.comps[ref], nets, pin_net)
        fix_fine_vias(fps[ref], cfg["rules"]["min_hole"])

    pl = {}
    for block, items in (placement.get(board_name) or {}).items():
        for ref, v in (items or {}).items():
            if ref in pl:
                raise SystemExit(f"{ref} placed twice in placement.yaml")
            pl[ref] = list(v) + [0, "top"][len(v) - 2:] if len(v) < 4 else list(v)
    if "keys" in cfg:
        kp, _ = key_placements(cfg, net)
        for ref, v in kp.items():
            pl.setdefault(ref, v)
    for ref, (x, y, rot, side) in pl.items():
        if ref not in fps:
            raise SystemExit(f"placement.yaml names {ref}, which is not in the {board_name} netlist")
        place(fps[ref], x, y, rot, side)

    gnd = nets.get("GND")
    for i, (x, y) in enumerate(cfg.get("holes", [])):
        add_board_fp(board, "MountingHole:MountingHole_2.7mm_M2.5_Pad", f"H{i + 1}", x, y,
                     net=gnd, value="M2.5")
        add_rule_area(board, circle_poly(x, y, cfg["hole_keepout_d"] / 2), f"HOLE_H{i + 1}",
                      tracks=False, vias=True, pours=True, pads=True, footprints=True)
    if "keys" in cfg:  # MX switch bodies sit on the top side: no top parts under them
        half = cfg["keys"].get("body", 14.0) / 2
        for name, (x, y) in key_labels.items():
            add_rule_area(board, rect_poly(x - half, y - half, x + half, y + half),
                          f"KEYBODY_{name}", tracks=True, vias=True, pours=True, pads=True,
                          footprints=False, layers=["F.Cu"])
    for k in cfg.get("keepouts", []):
        poly = rect_poly(*k["rect"]) if "rect" in k else k["poly"]
        add_rule_area(board, poly, k.get("name", "KEEPOUT"), tracks=k.get("tracks", False),
                      vias=k.get("vias", False), pours=k.get("pours", False),
                      footprints=k.get("footprints", True), layers=k.get("layers"))
    for i, (x, y, side) in enumerate(cfg.get("fiducials", [])):
        add_board_fp(board, "Fiducial:Fiducial_1mm_Mask2mm", f"FID{i + 1}", x, y, side=side)

    apply_netclasses(board, cfg, net)
    hand_routes(board, (placement.get("routes") or {}).get(board_name))
    auto_place(board, cfg, fps, net, set(pl))
    add_zones(board, cfg, only_plane=True)
    for i, (fpname, x, y, side) in enumerate(cfg.get("logos", [])):
        fp = load_fp(f"OpenLoungePhone:{fpname}")
        fp.SetReference(f"G{i + 1}")
        fp.SetBoardOnly(True)
        fp.SetExcludedFromBOM(True)
        fp.SetExcludedFromPosFiles(True)
        board.Add(fp)
        fp.SetPosition(P(x, y))  # the _B footprint is already drawn on B.SilkS, mirrored
    for name, (x, y) in key_labels.items():  # key legends (assembly aid; under the plate)
        text(board, name, x, y + 9.0 if y > h / 2 else y - 8.4, size=1.0)
    for t in cfg.get("texts", []):
        text(board, t[0], t[1], t[2], size=t[3] if len(t) > 3 else 1.0,
             layer=pcbnew.B_SilkS if (len(t) > 4 and t[4] == "bottom") else pcbnew.F_SilkS,
             rot=t[5] if len(t) > 5 else 0)

    print(f"escape stubs: {escape_stubs(board)}")
    n = fanout_gnd(board, cfg)
    print(f"GND fan-out: {n} vias")
    pcbnew.SaveBoard(str(pcb_path), board)
    insert_stackup(pcb_path, cfg)
    return pcb_path


def add_zones(board, cfg, only_plane=False):
    """The L2 GND plane exists from the start (FreeRouting fans GND out to it); the L1/L3/L4
    pours are added after routing so the router sees free layers."""
    w, h = cfg["size"]
    outline = rect_poly(0, 0, w, h)
    for znet, layer, poly, prio in cfg.get("zones", []):
        is_plane = layer == "In1.Cu"
        if is_plane != only_plane:
            continue
        add_zone(board, znet, layer, outline if poly == "board" else poly, prio,
                 name=f"{znet}_{layer}")


def apply_netclasses(board, cfg_all: dict, net: nl.Netlist) -> dict:
    """Standalone pcbnew does not read net classes from the .kicad_pro: set them here too."""
    ns = board.GetDesignSettings().m_NetSettings
    for name, c in cfg_all["netclasses"].items():
        nc = ns.GetDefaultNetclass() if name == "Default" else pcbnew.NETCLASS(name)
        nc.SetTrackWidth(MM(c["track"]))
        nc.SetClearance(MM(c["clearance"]))
        nc.SetViaDiameter(MM(c["via"][0]))
        nc.SetViaDrill(MM(c["via"][1]))
        if "diff_pair" in c:
            nc.SetDiffPairWidth(MM(c["diff_pair"][0]))
            nc.SetDiffPairGap(MM(c["diff_pair"][1]))
        if name != "Default":
            ns.SetNetclass(name, nc)
    assign = {}
    for n, nodes in net.nets.items():
        cls = netclass_of(n, nodes, cfg_all["netclass_rules"])
        if cls != "Default":
            ns.SetNetclassPatternAssignment(n, cls)
            assign[n] = cls
    board.SynchronizeNetsAndNetClasses(True)
    return assign


def load(board_name: str, cfg_all: dict, variant: str):
    pcb = KICAD_OUT / board_name / f"{board_name}.kicad_pcb"
    board = pcbnew.LoadBoard(str(pcb))
    net = nl.read(BUILD / f"{board_name}-{variant}" / f"{cfg_all[board_name]['netlist']}.net")
    apply_netclasses(board, cfg_all, net)
    return board, pcb, net


def autoroute(board_name: str, cfg_all: dict, variant: str, passes: int = 100,
              threads: int = 1) -> None:
    board, pcb, _ = load(board_name, cfg_all, variant)
    work = KICAD_OUT / board_name / "route"
    work.mkdir(exist_ok=True)
    dsn, ses = work / f"{board_name}.dsn", work / f"{board_name}.ses"
    if not pcbnew.ExportSpecctraDSN(board, str(dsn)):
        raise SystemExit("DSN export failed")
    # L2 is the solid GND plane: tell FreeRouting it is a power layer (no signal routing there)
    text = dsn.read_text()
    text = re.sub(r"\(layer In1\.Cu\s*\(type signal\)", "(layer In1.Cu\n      (type power)", text)
    dsn.write_text(text)
    if ses.exists():
        ses.unlink()
    cmd = [JAVA, "-Djava.awt.headless=true", "-jar", str(FREEROUTING_JAR), "-de", str(dsn),
           "-do", str(ses), "-mp", str(passes), "-mt", str(threads), "--gui.enabled=false"]
    print(" ".join(cmd), flush=True)
    with (work / "freerouting.log").open("w") as logf:
        subprocess.run(cmd, stdout=logf, stderr=subprocess.STDOUT, timeout=4 * 3600)
    if not ses.exists():
        raise SystemExit(f"FreeRouting produced no SES (see {work}/freerouting.log)")
    if not pcbnew.ImportSpecctraSES(board, str(ses)):
        raise SystemExit("SES import failed")
    pcbnew.SaveBoard(str(pcb), board)


def build_plate(cfg_all: dict, variant: str) -> Path:
    """FR4 key plate (no copper): MX cut-outs at the deck key grid, the e-ink pocket, screw
    clearance holes and light-pipe holes. Written as its own 2-layer KiCad board + DXF."""
    main, pc = cfg_all["main"], cfg_all["plate"]
    ox, oy = pc.get("origin", [0.0, 0.0])
    out = KICAD_OUT / "plate"
    out.mkdir(parents=True, exist_ok=True)
    board = pcbnew.BOARD()
    board.SetCopperLayerCount(2)
    tb = board.GetTitleBlock()
    tb.SetTitle(pc["title"])
    tb.SetRevision("r0.1")
    tb.SetCompany("Open Lounge Phone - CERN-OHL-S-2.0")
    w, h = pc["size"]
    rounded_outline(board, w, h, pc["corner_radius"])
    net = nl.read(BUILD / f"main-{variant}" / "main.net")
    names = [re.fullmatch(r"key (\w+)", c.fields.get("Note", "")).group(1)
             for c in net.comps.values() if c.fields.get("SpecKey") == "HOTSWAP"]
    half = pc["cutout"] / 2
    for x, y in key_positions(main["keys"], names).values():
        x, y = x - ox, y - oy
        for a_, b_ in zip([(x - half, y - half), (x + half, y - half), (x + half, y + half),
                           (x - half, y + half)],
                          [(x + half, y - half), (x + half, y + half), (x - half, y + half),
                           (x - half, y - half)]):
            add_shape(board, pcbnew.Edge_Cuts, "seg", [a_, b_])
    x0, y0, x1, y1 = main["panel"]
    x0, y0, x1, y1 = x0 - ox, y0 - oy, x1 - ox, y1 - oy
    c = pc["pocket_clearance"]
    for a_, b_ in zip([(x0 - c, y0 - c), (x1 + c, y0 - c), (x1 + c, y1 + c), (x0 - c, y1 + c)],
                      [(x1 + c, y0 - c), (x1 + c, y1 + c), (x0 - c, y1 + c), (x0 - c, y0 - c)]):
        add_shape(board, pcbnew.Edge_Cuts, "seg", [a_, b_])
    for x, y in pc["holes"]:
        add_shape(board, pcbnew.Edge_Cuts, "circle", [(x, y), pc["holes_d"] / 2])
    for x, y, d in pc.get("light_holes", []):
        add_shape(board, pcbnew.Edge_Cuts, "circle", [(x, y), d / 2])
    text(board, "Open Lounge Phone key plate r0.1  FR4 1.5 mm, no copper  CERN-OHL-S-2.0",
         w / 2, 82.2, size=1.0)
    pcb = out / "plate.kicad_pcb"
    pcbnew.SaveBoard(str(pcb), board)
    (out / "plate.kicad_pro").write_text(json.dumps({"meta": {"filename": "plate.kicad_pro",
                                                              "version": 3}}, indent=2) + "\n")
    return pcb


# ---------------------------------------------------------------------------------------------
# GND fan-out, hand routes, finishing


def _bbox_mm(item):
    bb = item.GetBoundingBox()
    x0, y0 = unP(bb.GetOrigin())
    x1, y1 = unP(bb.GetEnd())
    return x0, y0, x1, y1


def _rect_dist(px, py, r):
    x0, y0, x1, y1 = r
    dx = max(x0 - px, 0, px - x1)
    dy = max(y0 - py, 0, py - y1)
    return math.hypot(dx, dy)


def _seg_rect_dist(a, b, r, n=8):
    return min(_rect_dist(a[0] + (b[0] - a[0]) * i / n, a[1] + (b[1] - a[1]) * i / n, r)
               for i in range(n + 1))


_EDGE_CACHE: dict = {}


def edge_segments(board):
    """Edge.Cuts (board outline, slots, footprint cut-outs) as line segments in board mm."""
    key = id(board)
    if key in _EDGE_CACHE:
        return _EDGE_CACHE[key]
    shapes = [d for d in board.GetDrawings() if d.GetLayer() == pcbnew.Edge_Cuts]
    for fp in board.GetFootprints():
        shapes += [g for g in fp.GraphicalItems() if g.GetLayer() == pcbnew.Edge_Cuts
                   and g.GetClass() == "PCB_SHAPE"]
    segs = []
    for sh in shapes:
        t = sh.GetShape()
        if t == pcbnew.SHAPE_T_SEGMENT:
            segs.append((unP(sh.GetStart()), unP(sh.GetEnd())))
        elif t in (pcbnew.SHAPE_T_ARC, pcbnew.SHAPE_T_CIRCLE, pcbnew.SHAPE_T_RECT,
                   pcbnew.SHAPE_T_POLY):
            poly = sh.GetEffectiveShape() if False else None
            pts = []
            if t == pcbnew.SHAPE_T_ARC:
                c = unP(sh.GetCenter())
                r = pcbnew.ToMM(sh.GetRadius())
                a0 = math.atan2(unP(sh.GetStart())[1] - c[1], unP(sh.GetStart())[0] - c[0])
                ang = math.radians(sh.GetArcAngle().AsDegrees())
                pts = [(c[0] + r * math.cos(a0 + ang * k / 16), c[1] + r * math.sin(a0 + ang * k / 16))
                       for k in range(17)]
            elif t == pcbnew.SHAPE_T_CIRCLE:
                c = unP(sh.GetCenter())
                r = pcbnew.ToMM(sh.GetRadius())
                pts = [(c[0] + r * math.cos(2 * math.pi * k / 32), c[1] + r * math.sin(2 * math.pi * k / 32))
                       for k in range(33)]
            elif t == pcbnew.SHAPE_T_RECT:
                (x0, y0), (x1, y1) = unP(sh.GetStart()), unP(sh.GetEnd())
                pts = [(x0, y0), (x1, y0), (x1, y1), (x0, y1), (x0, y0)]
            segs += list(zip(pts, pts[1:]))
    _EDGE_CACHE[key] = segs
    return segs


def edge_distance(board, x, y) -> float:
    best = 1e9
    for (ax, ay), (bx, by) in edge_segments(board):
        vx, vy = bx - ax, by - ay
        L2 = vx * vx + vy * vy
        t = 0.0 if L2 == 0 else max(0.0, min(1.0, ((x - ax) * vx + (y - ay) * vy) / L2))
        best = min(best, math.hypot(ax + t * vx - x, ay + t * vy - y))
    return best


def _in_rule_area(board, x, y, what="vias"):
    pt = P(x, y)
    for z in board.Zones():
        if not z.GetIsRuleArea():
            continue
        if what == "vias" and not z.GetDoNotAllowVias():
            continue
        if what == "tracks" and not z.GetDoNotAllowTracks():
            continue
        if z.Outline().Contains(pt):
            return True
    return False


def add_via(board, x, y, net, d=0.6, drill=0.3):
    v = pcbnew.PCB_VIA(board)
    v.SetPosition(P(x, y))
    v.SetWidth(MM(d))
    v.SetDrill(MM(drill))
    v.SetViaType(pcbnew.VIATYPE_THROUGH)
    v.SetLayerPair(pcbnew.F_Cu, pcbnew.B_Cu)
    v.SetNet(net)
    board.Add(v)
    return v


def add_track(board, a, b, net, width, layer=pcbnew.F_Cu):
    t = pcbnew.PCB_TRACK(board)
    t.SetStart(P(*a))
    t.SetEnd(P(*b))
    t.SetWidth(MM(width))
    t.SetLayer(layer)
    t.SetNet(net)
    board.Add(t)
    return t


def fanout_gnd(board, cfg) -> int:
    """Give every SMD GND pad its own via to the L2 plane (decoupling caps: the via sits at the
    cap's GND pad, so the cap is between the IC pin and its GND via). Exposed pads get vias
    inside. Candidate positions are collision-checked against other nets' pads, holes, vias,
    rule areas and the board edge; a pad with no legal spot is left to FreeRouting."""
    gnd = board.FindNet("GND")
    w, h = cfg["size"]
    obstacles = []  # (rect, netcode)
    for fp in board.GetFootprints():
        for pad in fp.Pads():
            obstacles.append((_bbox_mm(pad), pad.GetNetCode(), pad))
    vias = []
    holes = [unP(pad.GetPosition()) + (pcbnew.ToMM(pad.GetDrillSize().x) / 2,)
             for fp in board.GetFootprints() for pad in fp.Pads() if pad.HasHole()]
    for t in board.GetTracks():
        obstacles.append((_bbox_mm(t), t.GetNetCode(), t))
    edge = 0.8
    placed = 0

    def ok(x, y, pad_rect, own):
        if not (edge < x < w - edge and edge < y < h - edge):
            return False
        for x0, _, x1, d in cfg.get("notches", []):
            if x0 - edge < x < x1 + edge and y < d + edge:
                return False
        if _in_rule_area(board, x, y):
            return False
        if edge_distance(board, x, y) < 0.3 + 0.3 + 0.02:
            return False
        for r, code, item in obstacles:
            if item is own:
                continue
            if code == gnd.GetNetCode():
                continue
            if _rect_dist(x, y, r) < 0.3 + 0.2:
                return False
        for hx, hy, hr in holes:
            if math.hypot(x - hx, y - hy) < hr + 0.15 + 0.5:
                return False
        for vx, vy in vias:
            if math.hypot(x - vx, y - vy) < 0.8 + 0.1:
                return False
        return True

    for fp in sorted(board.GetFootprints(), key=lambda f: f.GetReference()):
        if fp.GetReference().startswith(("H", "FID", "TP")) or \
                fp.GetFPIDAsString().startswith("OpenLoungePhone:NFC"):
            continue
        cx, cy = unP(fp.GetPosition())
        for pad in fp.Pads():
            if pad.GetNetCode() != gnd.GetNetCode() or pad.HasHole():
                continue
            if pad.GetAttribute() != pcbnew.PAD_ATTRIB_SMD:
                continue
            r = _bbox_mm(pad)
            px, py = (r[0] + r[2]) / 2, (r[1] + r[3]) / 2
            pw, ph = r[2] - r[0], r[3] - r[1]
            layer = pcbnew.B_Cu if fp.IsFlipped() else pcbnew.F_Cu
            # exposed/thermal pads (and big GND pads): vias inside the pad
            if pw * ph > 2.0 and min(pw, ph) > 1.2:
                n = 1 if pw * ph < 4 else 2
                pts = [(px, py)] if n == 1 else [(px - pw / 4, py), (px + pw / 4, py)]
                for vx, vy in pts:
                    if ok(vx, vy, r, pad):
                        add_via(board, vx, vy, gnd)
                        vias.append((vx, vy))
                        placed += 1
                continue
            # away from the footprint centre first, then the other directions
            ang0 = math.atan2(py - cy, px - cx) if (px, py) != (cx, cy) else 0.0
            dirs = sorted(range(8), key=lambda k: abs(math.remainder(k * math.pi / 4 - ang0,
                                                                       2 * math.pi)))
            done = False
            for dist_extra in (0.45, 0.7, 1.0):
                for k in dirs:
                    a_ = k * math.pi / 4
                    ux, uy = math.cos(a_), math.sin(a_)
                    reach = abs(ux) * pw / 2 + abs(uy) * ph / 2
                    vx, vy = px + ux * (reach + dist_extra), py + uy * (reach + dist_extra)
                    if not ok(vx, vy, r, pad) or _in_rule_area(board, (px + vx) / 2,
                                                                (py + vy) / 2, "tracks"):
                        continue
                    if any(_seg_rect_dist((px, py), (vx, vy), rr) < 0.2 + 0.2
                           for rr, code, item in obstacles
                           if code != gnd.GetNetCode() and item is not pad):
                        continue
                    add_via(board, vx, vy, gnd)
                    add_track(board, (px, py), (vx, vy), gnd, min(0.4, pw, ph), layer)
                    vias.append((vx, vy))
                    placed += 1
                    done = True
                    break
                if done:
                    break
    return placed


POWER_CLASSES = ("Power", "Power3V", "Speaker")


def escape_stubs(board, fine_pitch=0.8, beyond=0.6, beyond_power=1.6) -> int:
    """FreeRouting routes a net at its class width from the pad itself, which cannot leave a
    0.4-0.65 mm pitch pin with a 0.25-0.6 mm track. Give every fine-pitch signal/power pin a
    short stub at the pad's own width, ending `beyond` mm outside the pad, pointing away from
    the package centre; FreeRouting then continues from the stub end at full width (standard
    neck-down at the pin). GND pins are handled by fanout_gnd."""
    gnd = board.FindNet("GND").GetNetCode()
    n = 0
    obstacles = []
    for f_ in board.GetFootprints():
        for p_ in f_.Pads():
            lays = [pcbnew.F_Cu, pcbnew.B_Cu] if p_.HasHole() else \
                [pcbnew.B_Cu if f_.IsFlipped() else pcbnew.F_Cu]
            for lay in lays:
                obstacles.append((_bbox_mm(p_), p_.GetNetCode(), lay))
    for fp in board.GetFootprints():
        pads = [p_ for p_ in fp.Pads() if p_.GetAttribute() == pcbnew.PAD_ATTRIB_SMD]
        if len(pads) < 4:
            continue
        cx, cy = unP(fp.GetPosition())
        layer = pcbnew.B_Cu if fp.IsFlipped() else pcbnew.F_Cu
        centers = [(unP(p_.GetPosition()), p_.GetNetCode()) for p_ in pads]
        for pad in pads:
            code = pad.GetNetCode()
            if code in (0, gnd):
                continue
            (px, py) = unP(pad.GetPosition())
            near = min((math.hypot(px - x, py - y) for (x, y), c in centers
                        if c != code and (x, y) != (px, py)), default=9)
            if near >= fine_pitch:
                continue
            r = _bbox_mm(pad)
            pw, ph = r[2] - r[0], r[3] - r[1]
            if abs(pw - ph) < 0.05:
                continue  # square pad: no obvious escape direction
            d = (1 if px > cx else -1, 0) if pw > ph else (0, 1 if py > cy else -1)
            half = pw / 2 if d[0] else ph / 2
            width = min(pw, ph)
            # supply pins get a longer stub so the full-width trace starts clear of the
            # neighbouring pins' stubs (staggered escape); adjacent same-net pins are bridged
            ext = beyond_power if pad.GetNet().GetNetClassName() in POWER_CLASSES else beyond
            same = [(x, y) for (x, y), c in centers if c == code and (x, y) != (px, py)
                    and math.hypot(px - x, py - y) < 0.7]
            if same and (px, py) > min(same):
                add_track(board, (px, py), min(same), pad.GetNet(), width, layer)
                continue  # the other pad of the pair carries the stub
            for e in (ext, (ext + beyond) / 2, beyond):
                end = (px + d[0] * (half + e), py + d[1] * (half + e))
                if not any(_seg_rect_dist((px, py), end, r_) < 0.15 + width / 2 - 1e-3
                           for r_, c_, lay in obstacles if c_ != code and lay == layer):
                    add_track(board, (px, py), end, pad.GetNet(), width, layer)
                    n += 1
                    break
    return n


def resolve_point(board, pt):
    if isinstance(pt, str):
        ref, pad = pt.split(".")
        fp = board.FindFootprintByReference(ref)
        for p_ in fp.Pads():
            if p_.GetNumber() == pad:
                return unP(p_.GetPosition())
        raise SystemExit(f"route point {pt}: pad not found")
    return tuple(pt)


def hand_routes(board, routes) -> None:
    for r in routes or []:
        net = board.FindNet(r["net"])
        if net is None:
            raise SystemExit(f"route net {r['net']} not in board")
        pts = [resolve_point(board, p_) for p_ in r["pts"]]
        layer = CU[r.get("layer", "F.Cu")]
        for a_, b_ in zip(pts, pts[1:]):
            t = add_track(board, a_, b_, net, r["width"], layer)
            t.SetLocked(True)


def route_lengths(board, nets) -> dict:
    out = {}
    for t in board.GetTracks():
        if t.GetNetname() in nets and t.Type() == pcbnew.PCB_TRACE_T:
            out[t.GetNetname()] = out.get(t.GetNetname(), 0) + pcbnew.ToMM(t.GetLength())
    return out


def finish(board_name: str, cfg_all: dict, variant: str) -> None:
    """Pours on L1/L3/L4 (+L3 power), fill, GND stitching along edges/grid, save."""
    board, pcb, _ = load(board_name, cfg_all, variant)
    cfg = cfg_all[board_name]
    add_zones(board, cfg, only_plane=False)
    fill(board)
    n = stitch(board, cfg)
    fill(board)
    pcbnew.SaveBoard(str(pcb), board)
    deterministic(pcb)
    print(f"finished {pcb} ({n} stitching vias)")


def fill(board):
    filler = pcbnew.ZONE_FILLER(board)
    filler.Fill(board.Zones())


def stitch(board, cfg) -> int:
    """GND stitching vias on a grid (and along the edges) wherever all four layers are GND
    copper at that point and no rule area forbids vias."""
    gnd = board.FindNet("GND")
    w, h = cfg["size"]
    pitch = cfg.get("stitch_pitch", 5.0)
    zones = [z for z in board.Zones() if not z.GetIsRuleArea() and z.GetNetname() == "GND"]
    others = [z for z in board.Zones() if not z.GetIsRuleArea() and z.GetNetname() != "GND"]
    n = 0
    pts = []
    x = 1.2
    while x < w - 1.0:
        y = 1.2
        while y < h - 1.0:
            pts.append((x, y))
            y += pitch
        x += pitch
    for x in [1.2 + i * pitch / 2 for i in range(int((w - 2.4) / (pitch / 2)) + 1)]:
        pts += [(x, 1.2), (x, h - 1.2)]
    for y in [1.2 + i * pitch / 2 for i in range(int((h - 2.4) / (pitch / 2)) + 1)]:
        pts += [(1.2, y), (w - 1.2, y)]
    for x, y in pts:
        pt = P(x, y)
        if _in_rule_area(board, x, y):
            continue
        layers_ok = 0
        for layer in CU.values():
            inside = [z for z in zones if z.IsOnLayer(layer) and z.HitTestFilledArea(layer, pt, MM(0.45))]
            if inside:
                layers_ok += 1
        if layers_ok < 4:
            continue
        # keep clear of every other-net copper and holes
        if not _via_clear(board, x, y, gnd):
            continue
        add_via(board, x, y, gnd)
        n += 1
    return n


def _via_clear(board, x, y, gnd) -> bool:
    if edge_distance(board, x, y) < 0.3 + 0.3 + 0.02:
        return False
    for t in board.GetTracks():
        if t.GetNetCode() == gnd.GetNetCode():
            if t.Type() == pcbnew.PCB_VIA_T and math.hypot(*(a - b for a, b in zip(unP(t.GetPosition()), (x, y)))) < 1.0:
                return False
            continue
        if _rect_dist(x, y, _bbox_mm(t)) < 0.3 + 0.3:
            return False
    for fp in board.GetFootprints():
        for pad in fp.Pads():
            if _rect_dist(x, y, _bbox_mm(pad)) < 0.3 + 0.35:
                return False
    return True


_UUID_RE = re.compile(r'\((uuid|tstamp) "?([0-9a-fA-F-]{36})"?\)')


def deterministic(pcb: Path) -> None:
    """Replace random UUIDs with name-based ones in file order so rebuilds diff cleanly."""
    text = pcb.read_text()
    counter = iter(range(10 ** 9))
    ns = uuid.UUID("6f1c7a52-9d0e-4c1b-8a51-0d7e0f7a1c11")
    mapping = {}

    def repl(m):
        old = m.group(2)
        if old not in mapping:
            mapping[old] = str(uuid.uuid5(ns, f"{pcb.name}:{next(counter)}"))
        return f'({m.group(1)} "{mapping[old]}")'

    pcb.write_text(_UUID_RE.sub(repl, text))


def sync_fields(board_name: str, cfg_all: dict, variant: str) -> None:
    """Refresh values and sourcing fields from the netlist without touching copper."""
    board, pcb, net = load(board_name, cfg_all, variant)
    for fp in board.GetFootprints():
        c = net.comps.get(fp.GetReference())
        if c is None:
            continue
        fp.SetValue(c.value)
        for key in ("MPN", "Manufacturer", "LCSC"):
            if c.fields.get(key):
                fp.SetField(key, c.fields[key])
                f = fp.GetField(key)
                f.SetVisible(False)
                f.SetLayer(pcbnew.F_Fab)
        fp.SetDNP(c.dnp)
    pcbnew.SaveBoard(str(pcb), board)
    deterministic(pcb)


def grid_route(board_name: str, cfg_all: dict, variant: str) -> list:
    """Route with the project's deterministic grid router (router.py)."""
    import time

    import router as rt

    board, pcb, _ = load(board_name, cfg_all, variant)
    t0 = time.time()
    r = rt.Router(board, ORIGIN, cfg_all[board_name]["size"], cfg_all["netclasses"])
    unrouted = r.route_all(skip_nets=("GND",))  # GND: fan-out vias + pours
    print(f"grid router: {time.time() - t0:.0f} s, unrouted: {unrouted or 'none'}", flush=True)
    for line in r.fail_log[-40:]:
        print("  fail:", line)
    pcbnew.SaveBoard(str(pcb), board)
    (KICAD_OUT / board_name / "unrouted.txt").write_text(
        "".join(f"{n}\t{k}\n" for n, k in unrouted))
    return unrouted


def nl_sort(ref: str):
    m = re.match(r"([A-Z]+)(\d+)", ref)
    return (m.group(1), int(m.group(2))) if m else (ref, 0)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("board", choices=["main", "plate"])
    ap.add_argument("--variant", default="kids")
    ap.add_argument("--passes", type=int, default=100)
    ap.add_argument("--threads", type=int, default=1)
    ap.add_argument("--router", default="grid", choices=["grid", "freerouting"])
    ap.add_argument("--stage", default="place", choices=["place", "route", "all", "sync"])
    ap.add_argument("--stage-unplaced", action="store_true",
                    help="park unplaced parts beside the board instead of failing (debug)")
    a = ap.parse_args()
    cfg = load_yaml(LAYOUT / "boards.yaml")
    placement = load_yaml(LAYOUT / "placement.yaml") or {}
    out = KICAD_OUT / a.board
    if a.board == "plate":
        print(f"wrote {build_plate(cfg, a.variant)}")
        return
    if a.stage == "sync":
        sync_fields(a.board, cfg, a.variant)
        return
    if a.stage in ("place", "all"):
        pcb = build_place(a.board, a.variant, cfg, placement, out, a.stage_unplaced)
        print(f"wrote {pcb}")
    if a.stage in ("route", "all"):
        if a.router == "freerouting":
            autoroute(a.board, cfg, a.variant, passes=a.passes, threads=a.threads)
        else:
            grid_route(a.board, cfg, a.variant)
        finish(a.board, cfg, a.variant)


if __name__ == "__main__":
    main()
