#!/usr/bin/env python3
"""Re-sync board geometry into params.yaml (the SYNCED block) - one command after a layout change.

    .venv/bin/python sync_params.py            # or: make sync

Reads hardware/kicad/{main,deck}/*.kicad_pcb with KiCad's bundled Python (pcbnew): board
outline, M2.5 mounting holes, and the positions/courtyards of every part the enclosure has
to meet (USB-C, RJ9, hall sensor, radar socket, pinhole buttons, key switches, LEDs, light
sensor, side switches, FFCs). The e-ink panel pocket and FPC slot come from
hardware/layout/boards.yaml (they are not footprints). Board-relative mm, y down.

If KiCad is not installed the existing block is kept (or, if empty, the DESIGN.md numbers
below are written) and a warning is printed.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

import yaml

HERE = Path(__file__).resolve().parent
HW = HERE.parent
PARAMS = HERE / "params.yaml"
BEGIN = "# >>> SYNCED BOARD GEOMETRY (sync_params.py; do not edit by hand) >>>"
END = "# <<< SYNCED BOARD GEOMETRY <<<"

KICAD_APP = os.environ.get("KICAD_APP") or next(
    (p for p in [Path.home() / "Applications/KiCad/KiCad.app", Path("/Applications/KiCad/KiCad.app")] if p.exists()),
    None,
)

# role -> (board, ref, footprint substring that must match); refs are the netlist's
ROLES = {
    "main": {
        "usb_c": ("J1", "USB_C"),
        "rj9": ("J3", "RJ9"),
        "hall": ("U10", "SOT-23"),
        "ir": ("U11", "ITR8307"),
        "radar": ("J5", "PinSocket_1x05"),
        "ffc": ("J6", "FFC"),
        "reset": ("SW1", "TS-1187A"),
        "boot": ("SW2", "TS-1187A"),
        "mic": ("MK1", "Electret"),
        "speaker_conn": ("J4", "JST_PH"),
        "esp32": ("U1", "ESP32-S3"),
        "supercap": ("C7", "Supercap"),
        "battery_conn": ("J2", "JST_PH"),
    },
    "deck": {
        "ffc": ("J1", "FFC"),
        "eink_fpc": ("J2", "FFC"),
        "als": ("U2", "LTR-303"),
        "status_led": ("D14", "SK6812"),
        "privacy_led": ("D15", "LED_0603"),
        "vol_minus": ("SW13", "SKRTLAE010"),
        "vol_plus": ("SW14", "SKRTLAE010"),
        "mute": ("SW15", "JS202011"),
    },
}

EXTRACT = r"""
import json, sys, pcbnew
roles = json.loads(sys.argv[1]); hw = sys.argv[2]
out = {}
for name in ("main", "deck"):
    b = pcbnew.LoadBoard(f"{hw}/kicad/{name}/{name}.kicad_pcb")
    bb = b.GetBoardEdgesBoundingBox()
    ox, oy = pcbnew.ToMM(bb.GetX()), pcbnew.ToMM(bb.GetY())
    mm = lambda v: round(pcbnew.ToMM(v), 3)
    # edge-cut width is 0.05: the outline itself is bbox shrunk by half the line width
    lw = 0.05
    d = {"size": [round(pcbnew.ToMM(bb.GetWidth()) - lw, 3), round(pcbnew.ToMM(bb.GetHeight()) - lw, 3)],
         "holes": [], "parts": {}, "keys": []}
    ox += lw / 2; oy += lw / 2
    for fp in b.GetFootprints():
        ref = fp.GetReference(); fid = fp.GetFPIDAsString(); p = fp.GetPosition()
        x, y = round(mm(p.x) - ox, 3), round(mm(p.y) - oy, 3)
        if "MountingHole" in fid:
            d["holes"].append([x, y]); continue
        side = "bottom" if fp.IsFlipped() else "top"
        try:
            cy = fp.GetCourtyard(pcbnew.B_CrtYd if fp.IsFlipped() else pcbnew.F_CrtYd).BBox()
            crt = [round(mm(cy.GetLeft()) - ox, 3), round(mm(cy.GetTop()) - oy, 3),
                   round(mm(cy.GetRight()) - ox, 3), round(mm(cy.GetBottom()) - oy, 3)]
        except Exception:
            crt = None
        if "Hotswap" in fid:
            d["keys"].append([ref, x, y]); continue
        for role, (r, sub) in roles[name].items():
            if ref == r:
                if sub not in fid:
                    print(f"WARN {name} {ref}: footprint {fid} does not match role {role} ({sub})", file=sys.stderr)
                d["parts"][role] = {"ref": ref, "at": [x, y], "rot": round(fp.GetOrientationDegrees(), 1),
                                    "side": side, "crt": crt}
    d["holes"].sort()
    out[name] = d
print("JSON" + json.dumps(out))
"""


def extract_pcb() -> dict | None:
    if not KICAD_APP:
        return None
    kpy = Path(KICAD_APP) / "Contents/Frameworks/Python.framework/Versions/3.9/bin/python3"
    if not kpy.exists():
        return None
    roles = {b: {k: list(v) for k, v in r.items()} for b, r in ROLES.items()}
    res = subprocess.run([str(kpy), "-c", EXTRACT, json.dumps(roles), str(HW)], capture_output=True, text=True)
    for line in res.stderr.splitlines():
        if line.startswith("WARN"):
            print(line)
    js = [l for l in res.stdout.splitlines() if l.startswith("JSON")]
    if res.returncode != 0 or not js:
        print(res.stderr[-2000:])
        return None
    return json.loads(js[-1][4:])


def key_order(keys: list) -> list:
    """Two rows of six: rear row (smaller board y) 1 2 3 4 5 MENU, front row 6 7 8 9 0 BACK."""
    ys = sorted({round(k[2], 1) for k in keys})
    rear = sorted([k for k in keys if round(k[2], 1) == ys[0]], key=lambda k: k[1])
    front = sorted([k for k in keys if round(k[2], 1) == ys[-1]], key=lambda k: k[1])
    labels_r = ["1", "2", "3", "4", "5", "MENU"]
    labels_f = ["6", "7", "8", "9", "0", "BACK"]
    if len(rear) != 6 or len(front) != 6:
        print(f"WARN: expected 2 x 6 keys, got {len(rear)} + {len(front)}")
    out = [[labels_r[i] if i < 6 else f"R{i}", k[0], k[1], k[2]] for i, k in enumerate(rear)]
    out += [[labels_f[i] if i < 6 else f"F{i}", k[0], k[1], k[2]] for i, k in enumerate(front)]
    return out


def fallback() -> dict:
    """DESIGN.md / boards.yaml numbers, used only when pcbnew is unavailable."""
    keys = [[f"SW{i}", 10.9 + (i % 6) * 19.05, 13.0 if i < 6 else 71.0] for i in range(12)]
    return {
        "main": {"size": [144, 80], "holes": [[17.5, 4.5], [140.0, 4.0], [4.0, 57.0], [128.5, 75.5], [141.0, 53.0]],
                 "parts": {}, "keys": []},
        "deck": {"size": [117, 84], "holes": [[3.2, 3.2], [113.8, 3.2], [3.2, 80.8], [113.8, 80.8], [113.6, 27.6]],
                 "parts": {}, "keys": keys},
    }


def placement_positions(board: str) -> dict:
    """ref -> [x, y, rot, side] from hardware/layout/placement.yaml (groups flattened)."""
    pl = yaml.safe_load((HW / "layout/placement.yaml").read_text()).get(board, {}) or {}
    out = {}
    for grp in pl.values():
        if isinstance(grp, dict):
            for ref, v in grp.items():
                if isinstance(v, list) and len(v) >= 2:
                    out[ref] = v
    return out


def apply_layout_intent(geo: dict, by: dict) -> list[str]:
    """If a .kicad_pcb is stale (outline differs from boards.yaml), take the outline, holes and
    part positions from the layout sources; courtyards keep their offsets from the old footprint."""
    notes = []
    for name in ("main", "deck"):
        want = by[name]["size"]
        have = geo[name]["size"]
        if abs(want[0] - have[0]) < 0.05 and abs(want[1] - have[1]) < 0.05:
            continue
        notes.append(f"{name}: .kicad_pcb is {have}, boards.yaml says {want} -> using boards.yaml + placement.yaml")
        geo[name]["size"] = want
        geo[name]["holes"] = sorted(by[name]["holes"])
        pos = placement_positions(name)
        for role, v in geo[name]["parts"].items():
            ref = v["ref"]
            if ref not in pos:
                notes.append(f"{name}: {ref} ({role}) not in placement.yaml, keeping .kicad_pcb position")
                continue
            nx, ny = float(pos[ref][0]), float(pos[ref][1])
            nrot = float(pos[ref][2]) if len(pos[ref]) > 2 else 0.0
            ox, oy = v["at"]
            if v["crt"] and abs(((nrot - v["rot"]) + 180) % 360 - 180) < 0.1:
                x0, y0, x1, y1 = v["crt"]
                v["crt"] = [round(x0 - ox + nx, 3), round(y0 - oy + ny, 3), round(x1 - ox + nx, 3), round(y1 - oy + ny, 3)]
            elif v["crt"]:
                notes.append(f"{name}: {ref} rotation changed, courtyard approximated as a 6 mm square")
                v["crt"] = [nx - 3, ny - 3, nx + 3, ny + 3]
            v["at"] = [nx, ny]
            v["rot"] = nrot
            v["source"] = "placement.yaml"
        geo[name]["stale_pcb"] = True
    return notes


def main() -> int:
    text = PARAMS.read_text()
    if BEGIN not in text or END not in text:
        print("params.yaml has no SYNCED block markers")
        return 1
    geo = extract_pcb()
    source = "hardware/kicad/*/*.kicad_pcb via pcbnew"
    if geo is None:
        cur = yaml.safe_load(text).get("boards")
        if cur:
            print("WARN: KiCad/pcbnew not available - keeping the existing SYNCED block")
            return 0
        print("WARN: KiCad/pcbnew not available - writing DESIGN.md fallback numbers")
        geo, source = fallback(), "DESIGN.md fallback (pcbnew unavailable)"
    by = yaml.safe_load((HW / "layout/boards.yaml").read_text())
    notes = apply_layout_intent(geo, by)
    for n in notes:
        print("NOTE", n)
    geo["main"]["deck_footprint"] = by["main"].get("deck_footprint")
    geo["deck"]["keys"] = key_order(geo["deck"]["keys"])
    geo["deck"]["panel"] = by["deck"].get("panel")
    geo["deck"]["slots"] = by["deck"].get("slots", [])
    geo["deck"]["plate_light_holes"] = by.get("plate", {}).get("light_holes", [])
    geo["main"]["notches"] = by["main"].get("notches", [])
    geo["source"] = source

    lines = [BEGIN, "boards:"]
    lines.append(f"  source: {json.dumps(geo['source'])}")
    for name in ("main", "deck"):
        d = geo[name]
        lines.append(f"  {name}:")
        for k in ("size", "stale_pcb", "holes", "notches", "deck_footprint", "panel", "slots", "plate_light_holes"):
            if k in d:
                lines.append(f"    {k}: {json.dumps(d[k])}")
        if d.get("keys"):
            lines.append("    keys:   # [label, ref, x, y] in protocol order")
            for k in d["keys"]:
                lines.append(f"      - {json.dumps(k)}")
        lines.append("    parts:")
        for role, v in sorted(d["parts"].items()):
            lines.append(f"      {role}: {json.dumps(v)}")
    lines.append(END)
    pre, rest = text.split(BEGIN, 1)
    post = rest.split(END, 1)[1]
    PARAMS.write_text(pre + "\n".join(lines) + post)
    n = {b: (len(geo[b]["holes"]), len(geo[b]["parts"])) for b in ("main", "deck")}
    print(f"synced from {source}: main {geo['main']['size']} holes/parts {n['main']}, "
          f"deck {geo['deck']['size']} holes/parts {n['deck']}, keys {len(geo['deck']['keys'])}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
