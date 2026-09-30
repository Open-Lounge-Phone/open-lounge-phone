"""Place the minimal board (M2): build hardware/kicad/main/main.kicad_pcb from the SKiDL netlist.

    <KiCad python> place.py            # (make place) board + project files, no routing

Frame: mm, x right, y DOWN from the board's rear-left corner (KiCad's view from the top).
Owner-approved placement defaults (DESIGN.md §9):
  - 2 x 6 MX keys at 19.05 mm (rear 1 2 3 4 5 MENU, front 6 7 8 9 0 BACK); the WeAct 2.9"
    e-paper module between the rows on J3 (2x4 socket) + two M3 standoffs (H5, H6)
  - every SMD part on the BOTTOM (one-sided assembly); switches plug in from the top
  - hook = a 13th MX switch in a hot-swap socket, out of the key rows (left end)
  - USB-C J1 and the 3.5 mm jack J2 on the rear edge; the ESP32 module's U.FL at the left edge
  - 12 mm piezo BZ1 on top (sound holes in the lid), one status LED seen through a board hole
  - 2 layers, 4 x M3, a clear silkscreen area for the logo + "Open Lounge Phone"

Why the electronics band is on the LEFT: a module mounted on the bottom is mirrored. With its
antenna end at the left edge its 12-pin row faces the keys, the pin-1 side faces the rear edge
(the USB pins 13/14 sit at the corner right under the USB-C) and the pin-40 side faces the
front. The rear keys land on the row's upper half, the display on its lower half, the front
keys on the front side: parallel buses, no bus crosses another (see review_placement.py).

Big parts are placed from the table below; resistors and capacitors are placed by a small
search next to the pin they serve (courtyards may not overlap; decoupling within 2 mm).
"""

from __future__ import annotations

import json
import math
import shutil
from pathlib import Path

import kienv  # noqa: F401  (sys.path for yaml)
from kienv import BUILD, KICAD_OUT, LAYOUT, lib_path

import pcbnew  # noqa: E402

import netlist as nl  # noqa: E402

MM = pcbnew.FromMM
ORIGIN = (40.0, 40.0)            # board (0, 0) on the KiCad page
BOARD = "main"

# ---------------------------------------------------------------------------------------------
# geometry (mm)
W, H, CORNER_R = 156.0, 88.0, 3.0
PITCH = 19.05
X0 = 46.0                        # key column 0 (keys 1 / 6)
YR, YF = 13.5, 74.5              # rear row (1..MENU), front row (6..BACK): 61 mm apart
COLS = [X0 + i * PITCH for i in range(6)]
KEY_ORDER = ["1", "2", "3", "4", "5", "MENU", "6", "7", "8", "9", "0", "BACK"]   # SW3..SW14

# WeAct 2.9" e-paper module (drawing: 91.8 x 37.5, holes 86.2 x 31.9 at 2.8 from the edges,
# 2x4 header 1.93 mm from the short edge). Header end on the LEFT, centred over digit columns.
DISP_W, DISP_H = 91.8, 37.5
DISP_X0 = COLS[2] - DISP_W / 2
DISP_Y0 = (YR + YF) / 2 - DISP_H / 2
J3_PIN1 = (DISP_X0 + 1.93, DISP_Y0 + DISP_H / 2 + 1.5 * 2.54)     # BUSY, outer column
STANDOFFS = [(DISP_X0 + DISP_W - 2.8, DISP_Y0 + 2.8), (DISP_X0 + DISP_W - 2.8, DISP_Y0 + DISP_H - 2.8)]

HOOK = (16.0, YF)                # 13th MX switch, band front-left
U1_AT = (10.4, 44.0)             # module: antenna end 0.5 mm from the left edge
HOLES = [(152.5, 3.5), (152.5, 84.5), (3.5, 84.5), (31.0, 31.0)]

# fixed parts: ref -> (x, y, rotation seen from the top, side)
FIXED = {
    "J1": (19.5, 3.65, 180, "bottom"),        # USB-C, mouth flush with the rear edge
    "J2": (6.5, 9.15, 0, "bottom"),           # 3.5 mm jack, nose flush with the rear edge
    "U3": (10.0, 27.0, 90, "bottom"),         # ES8311: I2S/I2C pins down/left to the module,
                                              # analog pins up/right to the jack
    "D1": (18.9, 18.0, 90, "bottom"),         # USB ESD in line: D+ right, D- left
    "U2": (27.0, 15.0, 90, "bottom"),         # LDO between USB-C and the module (pocket)
    "BZ1": (15.8, 12.5, 270, "top"),          # piezo: pins (15.8, 12.5) VBUS / (15.8, 17.5) drive
    "J3": (J3_PIN1[0], J3_PIN1[1], 180, "top"),
    "SW15": (HOOK[0], HOOK[1], 0, "bottom"),
    "SW2": (35.0, 52.8, 0, "bottom"),         # BOOT: between the display RST lane and the
                                              # front keys, IO0 runs straight to it
    "G1": (84.0, 40.0, 0, "top"),             # signature logo (under the display module)
    "G2": (84.0, 52.0, 0, "top"),             # "Open Lounge Phone"
}

# hand-placed 2-pin parts around the codec: ref -> (x, y, direction of pad 1)
# top of U3: AVDD / DACVREF / ADCVREF caps in a row, the earpiece chain (22 uF, 22 R) up the
# gap between them to the jack's ring-1 pad; right of U3: VMID, MIC1N, then the MIC1P coupling
# cap whose far pad starts the mic line up the right-hand column to the jack sleeve.
PAIRS = {
    "C8": (8.2, 23.3, "down"), "C11": (11.0, 23.3, "down"), "C10": (12.7, 23.3, "down"),
    "C12": (9.6, 19.9, "down"), "R6": (9.6, 16.6, "down"),
    # MIC1P runs straight out of pin 18 into C14 and the mic line leaves C14 northward between
    # C10 and Q1; VMID and MIC1N (AC-grounded reference nodes) reach their caps C9/C15 in the
    # free spot above the codec through a via pair each (M3: the 0.4 mm pin pitch leaves no
    # planar way out for them between the MIC1P and SDA lines)
    "C14": (14.15, 27.0, "right"), "C9": (12.3, 18.95, "left"), "C15": (12.3, 20.95, "left"),
    # I2C pull-ups right above their module pins (IO17 SCL, IO18 SDA)
    "R5": (13.4, 32.4, "down"), "R4": (15.3, 32.4, "down"),
    # mic bias column between the jack and the USB-C: 1k, 10 uF, 2.2k to the sleeve; 22 R's
    # neighbour 4.7k holds the earpiece line at 0 V DC
    "R8": (13.0, 4.0, "up"), "C13": (13.0, 7.3, "down"), "R9": (13.0, 10.7, "up"),
    "R7": (11.2, 16.6, "up"),
}

# auto-placed small parts: ref -> (targets, search box). targets = [(pad, "REF:PAD"), ...]:
# the part goes where the sum of pad-to-target distances is smallest (no courtyard overlap,
# nothing in the planned bus lanes)
BAND = (0.5, 0.5, 36.0, 87.5)
REAR = (0.5, 0.5, 36.0, 34.2)
EAR = (7.0, 9.5, 12.0, 25.0)                  # OUTP -> 22 uF -> 22 R -> jack ring 1
MIC = (11.2, 3.0, 14.4, 26.0)                 # bias + coupling column right of it
DRV = (14.2, 10.0, 17.6, 34.2)                # ringer driver: left of the USB lines
AUTO = [
    # module decoupling at pin 2, EN RC at pin 3; RESET left of the jack-detect line
    ("C4", [("1", "U1:2")], REAR), ("C3", [("1", "U1:2")], REAR),
    ("C5", [("1", "U1:3")], REAR), ("R3", [("1", "U1:3")], REAR),
    ("SW1", [("1", "U1:3")], (0.5, 15.0, 6.4, 27.0)),
    # LDO in / out
    ("C1", [("1", "U2:3")], REAR), ("C2", [("1", "U2:2")], REAR),
    # USB CC resistors at the receptacle
    ("R1", [("1", "J1:A5")], REAR), ("R2", [("1", "J1:B5")], REAR),
    # ringer driver at the piezo
    ("Q1", [("3", "BZ1:2"), ("1", "U1:=BUZZER")], DRV), ("R11", [("1", "BZ1:1"), ("2", "BZ1:2")], DRV),
    ("R12", [("1", "U1:=BUZZER"), ("2", "Q1:1")], DRV),
    # codec supplies (2 mm rule), then the analog chains
    ("C6", [("1", "U3:3")], REAR), ("C7", [("1", "U3:4")], REAR),
    ("R10", [("1", "J2:TN"), ("2", "U1:=JACK_DET")], (5.5, 14.8, 9.0, 24.0)),
    # status LED left of the hook line (its light hole shows through the lid)
    ("D2", [("2", "U1:=STATUS_LED")], (0.5, 57.0, 4.4, 66.0)),
    ("R13", [("1", "U1:=STATUS_LED"), ("2", "D2:2")], (0.5, 53.9, 4.4, 66.0)),
]
# M3 routing adjustments, applied after the automatic placement: ref -> (x, y[, pad-1 side])
# - R1 (CC1 5.1 k) 0.5 mm left so the D- track runs straight down from the receptacle
# - the module's 22 uF (C3) stands in the edge column beside its 100 nF (C4), and the EN
#   capacitor (C5) moves above them: the key-side lanes to module pins 3-5 open up
# - the codec's second supply cap (C7) stands upright beside C6, off the I2S lanes
MOVES = {"R1": (17.75, 10.525), "C3": (1.675, 32.125, "down"), "C4": (3.475, 32.525, "down"),
         "C5": (3.15, 27.9, "right"), "C7": (8.4, 30.75, "up")}
# planned bus lanes (review_placement.py draws them): small parts stay out
LANES = [(20.8, 21.5, 37.0, 27.3), (20.8, 21.5, 27.3, 44.0),     # rear keys
         (20.8, 43.5, 44.0, 50.0),                                # display
         (5.2, 57.5, 37.0, 65.5), (5.2, 52.7, 13.0, 65.5)]        # front keys
GRID = 0.25
GAP = 0.0                        # extra courtyard gap (courtyards already carry 0.25 mm)

RULE_SEVERITIES = {
    "lib_footprint_issues": "ignore", "lib_footprint_mismatch": "ignore",
    "silk_over_copper": "error", "silk_overlap": "error", "silk_edge_clearance": "error",
    "text_height": "warning", "text_thickness": "warning",
    "missing_courtyard": "ignore", "npth_inside_courtyard": "ignore",
    "pth_inside_courtyard": "ignore", "footprint_symbol_mismatch": "ignore",
    "extra_footprint": "ignore", "missing_footprint": "ignore",
    "isolated_copper": "warning", "courtyards_overlap": "error", "starved_thermal": "warning",
}
NETCLASSES = {  # name: (track, clearance), patterns
    "Default": (0.2, 0.15, []),
    "Power": (0.6, 0.2, ["VBUS", "3V3"]),
    "USB": (0.3, 0.15, ["USB_DP", "USB_DN"]),
    "Audio": (0.25, 0.2, ["HS_EAR", "HS_MIC", "EAR_AC", "DAC_OUTP", "MIC1P", "MIC1N", "MIC_BIAS"]),
}


def P(x, y) -> pcbnew.VECTOR2I:
    return pcbnew.VECTOR2I(MM(ORIGIN[0] + x), MM(ORIGIN[1] + y))


def unP(v) -> tuple[float, float]:
    return pcbnew.ToMM(v.x) - ORIGIN[0], pcbnew.ToMM(v.y) - ORIGIN[1]


# ---------------------------------------------------------------------------------------------
# project files


def write_project(out: Path, net: nl.Netlist) -> None:
    classes = []
    for i, (name, (track, clr, _)) in enumerate(NETCLASSES.items()):
        classes.append({
            "bus_width": 12, "clearance": clr, "diff_pair_gap": 0.15, "diff_pair_via_gap": 0.25,
            "diff_pair_width": 0.3, "line_style": 0, "microvia_diameter": 0.3,
            "microvia_drill": 0.1, "name": name, "pcb_color": "rgba(0, 0, 0, 0.000)",
            "priority": 2147483647 if name == "Default" else i,
            "schematic_color": "rgba(0, 0, 0, 0.000)", "track_width": track,
            "via_diameter": 0.6, "via_drill": 0.3, "wire_width": 6,
        })
    patterns = [{"netclass": c, "pattern": n} for c, (_, _, pats) in NETCLASSES.items()
                for n in pats if n in net.nets]
    pro = {
        "board": {"design_settings": {
            "defaults": {"board_outline_line_width": 0.05, "copper_line_width": 0.2,
                         "silk_line_width": 0.12, "silk_text_size_h": 0.8,
                         "silk_text_size_v": 0.8, "silk_text_thickness": 0.12},
            "rule_severities": dict(RULE_SEVERITIES),
            "rules": {"min_clearance": 0.15, "min_copper_edge_clearance": 0.3,
                      "min_hole_clearance": 0.25, "min_hole_to_hole": 0.5,
                      "min_through_hole_diameter": 0.3, "min_track_width": 0.15,
                      "min_via_annular_width": 0.15, "min_via_diameter": 0.6,
                      "min_text_height": 0.8, "min_text_thickness": 0.12,
                      "min_resolved_spokes": 1, "min_silk_clearance": 0.0},
            "track_widths": [0.0, 0.2, 0.25, 0.3, 0.4, 0.6, 0.8],
            "via_dimensions": [{"diameter": 0.0, "drill": 0.0}, {"diameter": 0.6, "drill": 0.3}],
        }},
        "boards": [], "libraries": {"pinned_footprint_libs": [], "pinned_symbol_libs": []},
        "meta": {"filename": f"{BOARD}.kicad_pro", "version": 3},
        "net_settings": {"classes": classes, "meta": {"version": 4},
                         "netclass_assignments": None, "netclass_patterns": patterns},
        "pcbnew": {"page_layout_descr_file": ""}, "sheets": [], "text_variables": {},
    }
    out.mkdir(parents=True, exist_ok=True)
    (out / f"{BOARD}.kicad_pro").write_text(json.dumps(pro, indent=2, sort_keys=True) + "\n")
    (out / "fp-lib-table").write_text(
        '(fp_lib_table\n\t(version 7)\n\t(lib (name "OpenLoungePhone")(type "KiCad")'
        '(uri "${KIPRJMOD}/../../layout/footprints/openloungephone.pretty")(options "")'
        '(descr "Open Lounge Phone project footprints"))\n)\n')
    shutil.copy(LAYOUT / "fab-common.kicad_dru", out / f"{BOARD}.kicad_dru")


# pads joined inside the part (the Python API cannot set jumper pad groups): USBLC6-2SC6
# I/O1 = pins 1 and 6, I/O2 = pins 3 and 4 (ST datasheet: flow-through, the USB lines are
# routed through the package)
JUMPER_GROUPS = {"D1": '(jumper_pad_groups ("1" "6") ("3" "4"))'}


def mark_jumpers(path: Path) -> None:
    text = path.read_text()
    for ref, groups in JUMPER_GROUPS.items():
        k = text.find(f'(property "Reference" "{ref}"')
        start = text.rfind("\t(footprint ", 0, k)
        end = text.find("\n\t(footprint ", k)
        if "jumper_pad_groups" in text[start:end]:        # KiCad re-saves it in its own layout
            continue
        uuid_end = text.find("\n", text.find("(uuid", start)) + 1
        text = text[:uuid_end] + "\t\t" + groups + "\n" + text[uuid_end:]
    path.write_text(text)


def save_board(board, path: Path) -> None:
    pcbnew.SaveBoard(str(path), board)
    mark_jumpers(path)
    pro = path.with_suffix(".kicad_pro")
    d = json.loads(pro.read_text())
    d.setdefault("board", {}).setdefault("design_settings", {}).setdefault(
        "rule_severities", {}).update(RULE_SEVERITIES)
    pro.write_text(json.dumps(d, indent=2, sort_keys=True) + "\n")
    for junk in path.parent.glob("*.kicad_prl"):
        junk.unlink()


# ---------------------------------------------------------------------------------------------
# board items


def seg(board, layer, a, b, width=0.05):
    s = pcbnew.PCB_SHAPE(board)
    s.SetShape(pcbnew.SHAPE_T_SEGMENT)
    s.SetLayer(layer)
    s.SetWidth(MM(width))
    s.SetStart(P(*a))
    s.SetEnd(P(*b))
    board.Add(s)


def arc(board, layer, a, mid, b, width=0.05):
    s = pcbnew.PCB_SHAPE(board)
    s.SetShape(pcbnew.SHAPE_T_ARC)
    s.SetLayer(layer)
    s.SetWidth(MM(width))
    s.SetArcGeometry(P(*a), P(*mid), P(*b))
    board.Add(s)


def outline(board) -> None:
    L, r, k = pcbnew.Edge_Cuts, CORNER_R, CORNER_R * (1 - math.sqrt(0.5))
    seg(board, L, (r, 0), (W - r, 0))
    arc(board, L, (W - r, 0), (W - k, k), (W, r))
    seg(board, L, (W, r), (W, H - r))
    arc(board, L, (W, H - r), (W - k, H - k), (W - r, H))
    seg(board, L, (W - r, H), (r, H))
    arc(board, L, (r, H), (k, H - k), (0, H - r))
    seg(board, L, (0, H - r), (0, r))
    arc(board, L, (0, r), (k, k), (r, 0))


def text(board, layer, s, x, y, size=1.0, thick=0.15, mirror=False):
    t = pcbnew.PCB_TEXT(board)
    t.SetText(s)
    t.SetLayer(layer)
    t.SetPosition(P(x, y))
    t.SetTextSize(pcbnew.VECTOR2I(MM(size), MM(size)))
    t.SetTextThickness(MM(thick))
    if mirror:
        t.SetMirrored(True)
    board.Add(t)


def load_fp(fpid: str) -> pcbnew.FOOTPRINT:
    lib, name = fpid.split(":")
    fp = pcbnew.FootprintLoad(str(lib_path(lib)), name)
    if fp is None:
        raise SystemExit(f"footprint {fpid} not found in {lib_path(lib)}")
    fp.SetFPID(pcbnew.LIB_ID(lib, name))
    return fp


def place(fp, x, y, rot=0.0, side="top"):
    """rot = the angle as seen from the top; bottom parts are rotated, then mirrored L-R."""
    if fp.IsFlipped():
        fp.Flip(fp.GetPosition(), pcbnew.FLIP_DIRECTION_LEFT_RIGHT)
    fp.SetPosition(P(x, y))
    fp.SetOrientationDegrees(rot)
    if side == "bottom":
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
    fp.SetExcludedFromPosFiles(exclude)
    fp.SetDNP(comp.dnp)
    fp.Value().SetVisible(False)
    ref = fp.Reference()
    ref.SetTextSize(pcbnew.VECTOR2I(MM(0.8), MM(0.8)))
    ref.SetTextThickness(MM(0.12))
    for pad in fp.Pads():
        n = pin_net.get((comp.ref, pad.GetNumber()))
        if n:
            pad.SetNet(nets[n])
    board.Add(fp)
    return fp


def fix_fine_vias(fp, min_drill=0.3) -> None:
    """The WROOM footprint's pad 41 carries 0.2 mm thermal vias (below the 0.3 mm fab-common
    drill): keep the ones >= 1.4 mm apart, enlarged to 0.3 / 0.6 mm."""
    fine = [p for p in fp.Pads() if p.GetAttribute() == pcbnew.PAD_ATTRIB_PTH
            and pcbnew.ToMM(p.GetDrillSize().x) < min_drill - 1e-6]
    keep = []
    for p in sorted(fine, key=lambda p: (p.GetPosition().y, p.GetPosition().x)):
        if all((p.GetPosition() - k.GetPosition()).EuclideanNorm() >= MM(1.39) for k in keep):
            keep.append(p)
    for p in fine:
        if p in keep:
            p.SetDrillSize(pcbnew.VECTOR2I(MM(min_drill), MM(min_drill)))
            p.SetSize(pcbnew.VECTOR2I(MM(0.6), MM(0.6)))
        else:
            fp.Remove(p)


# ---------------------------------------------------------------------------------------------
# auto placement of small parts


def crt_box(fp):
    cy = fp.GetCourtyard(pcbnew.B_CrtYd if fp.IsFlipped() else pcbnew.F_CrtYd)
    bb = cy.BBox() if cy.OutlineCount() else fp.GetBoundingBox(False)
    (x0, y0), (x1, y1) = unP(bb.GetOrigin()), unP(bb.GetEnd())
    return (x0, y0, x1, y1)


def hole_boxes(fp):
    """Through holes (PTH/NPTH) of a footprint: they block both sides."""
    out = []
    for p in fp.Pads():
        if p.GetAttribute() in (pcbnew.PAD_ATTRIB_PTH, pcbnew.PAD_ATTRIB_NPTH):
            bb = p.GetBoundingBox()
            (x0, y0), (x1, y1) = unP(bb.GetOrigin()), unP(bb.GetEnd())
            out.append((x0 - 0.3, y0 - 0.3, x1 + 0.3, y1 + 0.3))
    return out


def overlap(a, b, gap=0.0) -> bool:
    return not (a[2] + gap <= b[0] or b[2] + gap <= a[0] or a[3] + gap <= b[1] or b[3] + gap <= a[1])


def pad_xy(board, spec):
    ref, pad = spec.split(":")
    fp = board.FindFootprintByReference(ref)
    if pad.startswith("="):       # "U1:=NET": the pad of that part on that net
        pts = [unP(p.GetPosition()) for p in fp.Pads() if p.GetNetname() == pad[1:]]
    else:
        pts = [unP(p.GetPosition()) for p in fp.Pads() if p.GetNumber() == pad]
    return pts[0]


POURS = {"GND", "3V3"}
CROSS_MM = 4.0                   # one straight-line crossing costs as much as 4 mm of wire


def _orient(a, b, c):
    return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])


def _cross(s, t) -> bool:
    (a, b), (c, d) = s, t
    if {a, b} & {c, d}:
        return False
    return _orient(a, b, c) * _orient(a, b, d) < 0 and _orient(c, d, a) * _orient(c, d, b) < 0


def net_pads(fps, placed):
    """net -> [(ref, (x, y))] over the placed parts (pour nets left out)."""
    out = {}
    for ref in placed:
        for p in fps[ref].Pads():
            n = p.GetNetname()
            if n and n not in POURS and not n.startswith("unconnected"):
                out.setdefault(n, []).append((ref, unP(p.GetPosition())))
    return out


def straight_segments(pads):
    """Nearest-neighbour chain per net (a cheap ratsnest) of the placed pads."""
    segs = []
    for n, nodes in pads.items():
        rest = list(nodes)
        tree = [rest.pop(0)]
        while rest:
            i, j = min(((i, j) for i in range(len(tree)) for j in range(len(rest))),
                       key=lambda ij: math.dist(tree[ij[0]][1], rest[ij[1]][1]))
            a, b = tree[i], rest.pop(j)
            if a[0] != b[0] or a[0].startswith("J"):
                segs.append((n, (a[1], b[1])))
            tree.append(b)
    return segs


def auto_place(board, fp, targets, box, obstacles, pads, segs):
    """Grid search in `box`: the pose with the smallest pad-to-target distance plus the
    straight-line crossings its pads would add to the nets placed so far."""
    tgt = [(pad, pad_xy(board, spec)) for pad, spec in targets]
    cands = []
    for rot in (0, 90, 180, 270):
        place(fp, 0, 0, rot, "bottom")
        c = crt_box(fp)
        offs = {p.GetNumber(): unP(p.GetPosition()) for p in fp.Pads()}
        nets = [(unP(p.GetPosition()), p.GetNetname()) for p in fp.Pads()
                if p.GetNetname() and p.GetNetname() not in POURS]
        holes = hole_boxes(fp)
        xs = [box[0] - c[0] + i * GRID for i in range(int((box[2] - box[0] - (c[2] - c[0])) / GRID) + 1)]
        ys = [box[1] - c[1] + j * GRID for j in range(int((box[3] - box[1] - (c[3] - c[1])) / GRID) + 1)]
        for x in xs:
            for y in ys:
                cb = (c[0] + x, c[1] + y, c[2] + x, c[3] + y)
                if any(overlap(cb, o, GAP) for o in obstacles):
                    continue
                if any(overlap((h[0] + x, h[1] + y, h[2] + x, h[3] + y), o) for h in holes
                       for o in obstacles):
                    continue
                cost = sum(math.hypot(x + offs[p][0] - tx, y + offs[p][1] - ty) for p, (tx, ty) in tgt)
                cands.append((cost, x, y, rot, nets))
    if not cands:
        raise SystemExit(f"no room for {fp.GetReference()} in {box}")
    cands.sort(key=lambda c: c[0])
    best = None
    for cost, x, y, rot, nets in cands[:400]:
        new = []
        for (px, py), n in nets:
            others = [q for q in pads.get(n, [])]
            if others:
                q = min(others, key=lambda q: math.dist(q[1], (x + px, y + py)))
                new.append((n, ((x + px, y + py), q[1])))
        crossings = sum(_cross(s, t) for n, s in new for m, t in segs if m != n)
        total = cost + CROSS_MM * crossings
        if best is None or total < best[0]:
            best = (total, x, y, rot)
    _, x, y, rot = best
    place(fp, x, y, rot, "bottom")


# ---------------------------------------------------------------------------------------------


def build() -> Path:
    net = nl.read(BUILD / BOARD / f"{BOARD}.net")
    out = KICAD_OUT / BOARD
    write_project(out, net)
    board = pcbnew.BOARD()
    ds = board.GetDesignSettings()
    ds.SetCopperLayerCount(2)
    board.SetCopperLayerCount(2)
    nets = {}
    for name in sorted(net.nets):
        ni = pcbnew.NETINFO_ITEM(board, name)
        board.Add(ni)
        nets[name] = ni
    pin_net = net.pin_net()
    outline(board)

    fps = {}
    for ref in sorted(net.comps, key=lambda r: (r.rstrip("0123456789"), int(r[len(r.rstrip("0123456789")):] or 0))):
        fps[ref] = add_footprint(board, net.comps[ref], nets, pin_net)
    fix_fine_vias(fps["U1"])

    # keys, hook, holes, module
    for i, legend in enumerate(KEY_ORDER):
        x, y = COLS[i % 6], (YR if i < 6 else YF)
        place(fps[f"SW{3 + i}"], x, y, 0, "bottom")
    for ref, (x, y, rot, side) in FIXED.items():
        place(fps[ref], x, y, rot, side)
    holes = sorted(r for r in fps if r.startswith("H"))
    main_holes = [r for r in holes if net.comps[r].value.startswith("M3 mounting")]
    stand = [r for r in holes if "standoff" in net.comps[r].value]
    for ref, (x, y) in zip(main_holes, HOLES):
        place(fps[ref], x, y)
    for ref, (x, y) in zip(stand, STANDOFFS):
        place(fps[ref], x, y)
    place_module(fps["U1"])

    # obstacles on the bottom: courtyards of bottom parts + every through hole
    for ref, (x, y, d) in PAIRS.items():
        place_pad1(fps[ref], x, y, d)
    placed_auto = {r for r, _, _ in AUTO}
    obstacles = list(LANES)
    for ref, fp in fps.items():
        if ref in placed_auto:
            continue
        if fp.IsFlipped():
            obstacles.append(crt_box(fp))
        obstacles += hole_boxes(fp)
    placed = [r for r in fps if r not in placed_auto]
    for ref, targets, box in AUTO:
        pads = net_pads(fps, placed)
        auto_place(board, fps[ref], targets, box, obstacles, pads, straight_segments(pads))
        placed.append(ref)
        obstacles.append(crt_box(fps[ref]))
        obstacles += hole_boxes(fps[ref])

    for ref, (x, y, *side) in MOVES.items():
        if side:
            place_pad1(fps[ref], x, y, side[0])
        else:
            fps[ref].SetPosition(P(x, y))
    tidy_refs(fps)
    marking(board)
    pcb = out / f"{BOARD}.kicad_pcb"
    save_board(board, pcb)
    # route.py starts from this untouched copy (removing copper through the Python API
    # corrupts SWIG's object table in KiCad 10)
    (out / "route").mkdir(exist_ok=True)
    shutil.copy(pcb, out / "route" / "placed.kicad_pcb")
    print(f"placed {len(fps)} footprints -> {pcb.relative_to(KICAD_OUT.parent)}")
    return pcb


def place_pad1(fp, x, y, direction) -> None:
    """A 2-pin part on the bottom with its pad 1 toward `direction` (up = toward the rear)."""
    for rot in (0, 90, 180, 270):
        place(fp, x, y, rot, "bottom")
        px, py = next(unP(p.GetPosition()) for p in fp.Pads() if p.GetNumber() == "1")
        if {"up": py < y - 0.1, "down": py > y + 0.1, "left": px < x - 0.1,
                "right": px > x + 0.1}[direction]:
            return
    raise SystemExit(f"cannot orient {fp.GetReference()}")


def place_module(fp) -> None:
    """ESP32-S3-WROOM-1U on the bottom, antenna end to the left edge, pin 14 (USB D+) at the
    rear-right corner: the one mirrored pose that puts the 12-pin row toward the keys."""
    for rot in (0, 90, 180, 270):
        place(fp, *U1_AT, rot, "bottom")
        p1 = next(unP(p.GetPosition()) for p in fp.Pads() if p.GetNumber() == "1")
        p14 = next(unP(p.GetPosition()) for p in fp.Pads() if p.GetNumber() == "14")
        p26 = next(unP(p.GetPosition()) for p in fp.Pads() if p.GetNumber() == "26")
        if p14[0] > U1_AT[0] and p14[1] < U1_AT[1] and p1[0] < U1_AT[0] and p26[0] > U1_AT[0] \
                and p26[1] > U1_AT[1]:
            return
    raise SystemExit("no module pose puts pin 14 at the rear-right")


def tidy_refs(fps) -> None:
    """References on the Fab layers (the review image draws its own labels); silkscreen stays
    clear for the marking. Keys keep a silkscreen legend on the top."""
    for ref, fp in fps.items():
        r = fp.Reference()
        r.SetLayer(pcbnew.B_Fab if fp.IsFlipped() else pcbnew.F_Fab)
        r.SetPosition(fp.GetPosition())
        r.SetTextAngleDegrees(0)
    for fp in fps.values():
        fab = pcbnew.B_Fab if fp.IsFlipped() else pcbnew.F_Fab
        for item in fp.GraphicalItems():
            if item.GetLayer() not in (pcbnew.F_SilkS, pcbnew.B_SilkS):
                continue
            bb = item.GetBoundingBox()
            (x0, y0), (x1, y1) = unP(bb.GetOrigin()), unP(bb.GetEnd())
            # edge connectors overhang the rear edge: their outline silk stops at the edge
            at_edge = x0 < 0.3 or y0 < 0.3 or x1 > W - 0.3 or y1 > H - 0.3
            if at_edge or fp.GetReference().startswith(("C", "R")):
                item.SetLayer(fab)


REV = "rev A (M3)"
# J3 = the WeAct module's header order (DESIGN.md §6): odd pins in the outer column
J3_NAMES = {"1": "BUSY", "2": "RES", "3": "DC", "4": "CS", "5": "SCL", "6": "SDA", "7": "GND",
            "8": "VCC"}


def marking(board) -> None:
    F, Bk = pcbnew.F_SilkS, pcbnew.B_SilkS
    text(board, F, f"CERN-OHL-S-2.0  {REV}", 84.0, 58.5, 0.9, 0.15)
    for i, legend in enumerate(KEY_ORDER):
        x, y = COLS[i % 6], (YR if i < 6 else YF)
        text(board, F, legend, x, y + (8.2 if i < 6 else -8.2), 1.0, 0.15)
    text(board, F, "HOOK", HOOK[0], HOOK[1] - 8.2, 1.0, 0.15)
    # connectors: the USB-C and the handset jack sit under the rear edge (bottom side)
    text(board, F, "USB-C 5V", FIXED["J1"][0], 1.35, 0.8, 0.15)
    text(board, F, "HANDSET", FIXED["J2"][0], 1.35, 0.8, 0.15)
    # display socket: name + pin order beside each column
    jx, jy = J3_PIN1
    text(board, F, "J3 DISPLAY", jx + 1.27, jy - 3 * 2.54 - 2.3, 0.8, 0.15)
    for k in range(4):
        y = jy - k * 2.54
        text(board, F, f"{J3_NAMES[str(2 * k + 1)]} {2 * k + 1}", jx - 4.1, y, 0.8, 0.15)
        text(board, F, f"{2 * k + 2} {J3_NAMES[str(2 * k + 2)]}", jx + 2.54 + 4.1, y, 0.8, 0.15)
    # pinhole buttons (bottom side, read from below)
    text(board, Bk, "RESET", 3.3, 18.3, 0.8, 0.15, mirror=True)
    text(board, Bk, "BOOT", FIXED["SW2"][0], 57.4, 0.8, 0.15, mirror=True)


if __name__ == "__main__":
    build()
