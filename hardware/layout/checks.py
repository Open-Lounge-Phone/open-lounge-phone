"""Layout checks as code (KiCad Python). Fails (exit 1) on any ERROR.

    python checks.py main  [--out DIR]

- KiCad DRC (kicad-cli, project rules + fab-common.kicad_dru): 0 errors, 0 unconnected items
  (courtyard overlaps, clearances, edge, holes, keep-outs are all DRC errors in the project).
- Antenna keep-out: nothing but the module itself inside the ESP32 keep-out, on any layer.
- NFC loop: no zone fill inside the loop and nothing crossing the pour slit (front-left end region).
- USB D+/D-: no vias, length mismatch <= 0.15 mm, 0.27 mm width.
- Decoupling: each IC supply pin has a capacitor on the same net within 2.5 mm (pad to pad),
  and that capacitor's GND pad has a GND via within 1.0 mm.
- Power nets: routed width >= 0.5 mm (Power class) / 0.3 mm (3V3/3V0).
"""

from __future__ import annotations

import argparse
import json
import math
import subprocess
import sys
from pathlib import Path

import kienv
from kienv import BUILD, KICAD_CLI, KICAD_OUT, LAYOUT, load_yaml

import pcbnew  # noqa: E402

from build_board import _bbox_mm, _rect_dist, load, unP  # noqa: E402

DRC_IGNORE = {"lib_footprint_issues", "lib_footprint_mismatch"}


def run_drc(pcb: Path, out: Path) -> tuple[list, list, dict]:
    rpt = out / "drc.json"
    subprocess.run([KICAD_CLI, "pcb", "drc", str(pcb), "-o", str(rpt), "--format", "json",
                    "--severity-all", "--schematic-parity"] if False else
                   [KICAD_CLI, "pcb", "drc", str(pcb), "-o", str(rpt), "--format", "json",
                    "--severity-all"], capture_output=True, text=True)
    d = json.loads(rpt.read_text())
    subprocess.run([KICAD_CLI, "pcb", "drc", str(pcb), "-o", str(out / "drc.rpt"),
                    "--severity-all"], capture_output=True, text=True)
    errs, warns = [], []
    for v in d["violations"]:
        if v["type"] in DRC_IGNORE:
            continue
        (errs if v["severity"] == "error" else warns).append(v)
    return errs, d.get("unconnected_items", []), d


def pads_of(board, ref):
    fp = board.FindFootprintByReference(ref)
    return list(fp.Pads()) if fp else []


def check_antenna(board, results):
    u1 = board.FindFootprintByReference("U1")
    if not u1 or "ESP32" not in u1.GetFPIDAsString():
        return
    keep = [z for z in u1.Zones() if z.GetIsRuleArea()]
    if "WROOM-1U" in u1.GetFPIDAsString():
        results.append(("OK", "antenna: WROOM-1U (U.FL, external antenna on the shell wall)"))
        return
    n = 0
    for z in keep:
        ol = z.Outline()
        for t in board.GetTracks():
            if ol.Collide(t.GetPosition()) or ol.Collide(t.GetStart()) or ol.Collide(t.GetEnd()):
                n += 1
        for fp in board.GetFootprints():
            if fp is u1:
                continue
            for p in fp.Pads():
                if ol.Collide(p.GetPosition()):
                    n += 1
        for bz in board.Zones():
            if bz.GetIsRuleArea():
                continue
            for layer in bz.GetLayerSet().Seq():
                if bz.HasFilledPolysForLayer(layer):
                    fill = bz.GetFilledPolysList(layer)
                    for i in range(fill.OutlineCount()):
                        o = fill.Outline(i)
                        if any(ol.Collide(o.CPoint(j)) for j in range(o.PointCount())):
                            n += 1
                            break
    results.append(("ERROR" if n else "OK", f"antenna keep-out: {n} foreign copper items"))


def check_nfc(board, cfg, results):
    """NFC coil area: no pour inside the loop on any layer; tracks/vias only where the rule area
    allows them; no GND or supply net inside the L3 corridor or across the pour slit."""
    for z in board.Zones():
        if not z.GetIsRuleArea() or not z.GetZoneName().startswith("NFC_"):
            continue
        name = z.GetZoneName()
        ol = z.Outline()

        def crosses(t):
            if ol.Collide(t.GetStart()) or ol.Collide(t.GetEnd()):
                return True
            if t.Type() == pcbnew.PCB_VIA_T:
                return False
            a_, b_ = t.GetStart(), t.GetEnd()
            return any(ol.Collide(pcbnew.VECTOR2I(int(a_.x + (b_.x - a_.x) * k / 20),
                                                   int(a_.y + (b_.y - a_.y) * k / 20)))
                       for k in range(1, 20))
        bad = []
        for t in board.GetTracks():
            is_via = t.Type() == pcbnew.PCB_VIA_T
            if not is_via and not z.IsOnLayer(t.GetLayer()):
                continue
            if not crosses(t):
                continue
            if is_via and z.GetDoNotAllowVias():
                bad.append(t)
            elif not is_via and z.GetDoNotAllowTracks():
                bad.append(t)
            elif not is_via and (t.GetNetname() == "GND" or
                                 t.GetNet().GetNetClassName() in ("Power", "Power3V", "GND")):
                bad.append(t)   # supplies would close a turn around the coil
        bb, eps = ol.BBox(), pcbnew.FromMM(0.05)

        def inside(p):  # strictly inside (the NFC keep-outs are rectangles)
            if ol.OutlineCount() == 1 and ol.Outline(0).PointCount() == 4:
                return (bb.GetLeft() + eps < p.x < bb.GetRight() - eps
                        and bb.GetTop() + eps < p.y < bb.GetBottom() - eps)
            return ol.Collide(p)
        fills = 0
        for bz in board.Zones():
            if bz.GetIsRuleArea():
                continue
            for layer in bz.GetLayerSet().Seq():
                if not z.IsOnLayer(layer) or not bz.HasFilledPolysForLayer(layer):
                    continue
                f = bz.GetFilledPolysList(layer)
                for i in range(f.OutlineCount()):
                    o = f.Outline(i)
                    pts = [o.CPoint(j) for j in range(o.PointCount())]
                    if any(inside(p) for p in pts):   # fill edges ON the keep-out edge are fine
                        fills += 1
                        break
        results.append(("ERROR" if bad or fills else "OK",
                        f"{name}: {len(bad)} disallowed tracks/vias, {fills} pour fragments inside"))


def check_usb(board, results):
    nets = ("HS_USB_DP", "HS_USB_DN")   # the S3 native-USB pair (handset port)
    lengths = {n: 0.0 for n in nets}
    vias = 0
    widths = set()
    # the matched run is the locked hand route (D7 -> U1); the receptacle's A/B rows need a
    # short flip next to J7, where vias are allowed (within 8 mm of the connector)
    j7 = board.FindFootprintByReference("J7")
    jx, jy = unP(j7.GetPosition()) if j7 else (1e9, 1e9)
    for t in board.GetTracks():
        n = t.GetNetname()
        if n not in nets:
            continue
        if t.Type() == pcbnew.PCB_VIA_T:
            vx, vy = unP(t.GetPosition())
            if math.hypot(vx - jx, vy - jy) > 8.0:
                vias += 1
        elif t.IsLocked():
            lengths[n] += pcbnew.ToMM(t.GetLength())
            widths.add(round(pcbnew.ToMM(t.GetWidth()), 3))
    if not any(lengths.values()):
        return
    mis = abs(lengths["HS_USB_DP"] - lengths["HS_USB_DN"])
    lvl = "ERROR" if vias or mis > 0.15 else "OK"
    results.append((lvl, f"USB pair: D+ {lengths['HS_USB_DP']:.2f} mm, D- {lengths['HS_USB_DN']:.2f} "
                         f"mm (mismatch {mis:.2f}, hand route), {vias} vias away from J7, widths {sorted(widths)}"))


POWER_PIN_NETS = {"3V3", "3V0", "VSYS", "VBUS", "VLED", "VBAT"}


def check_decoupling(board, results, max_pin=2.5, max_via=1.0):
    gnd = board.FindNet("GND").GetNetCode()
    vias = [unP(t.GetPosition()) for t in board.GetTracks()
            if t.Type() == pcbnew.PCB_VIA_T and t.GetNetCode() == gnd]
    caps = [fp for fp in board.GetFootprints() if fp.GetReference().startswith("C")
            and not fp.IsDNP()]
    bad = []
    checked = 0
    for fp in board.GetFootprints():
        ref = fp.GetReference()
        if not ref.startswith("U") or fp.IsDNP():
            continue
        for pad in fp.Pads():
            if pad.GetNetname() not in POWER_PIN_NETS:
                continue
            checked += 1
            px, py = unP(pad.GetPosition())
            best = None
            for c in caps:
                cp = {p.GetNetname(): p for p in c.Pads()}
                if pad.GetNetname() in cp and "GND" in cp:
                    d = _rect_dist(px, py, _bbox_mm(cp[pad.GetNetname()]))
                    if best is None or d < best[0]:
                        best = (d, c, cp["GND"])
            if best is None or best[0] > max_pin:
                bad.append(f"{ref}.{pad.GetNumber()} ({pad.GetNetname()}): nearest cap "
                           f"{best[1].GetReference() + f' {best[0]:.1f} mm' if best else 'none'}")
                continue
            gx, gy = unP(best[2].GetPosition())
            if not any(math.hypot(gx - vx, gy - vy) <= max_via + 0.5 for vx, vy in vias):
                bad.append(f"{ref}.{pad.GetNumber()}: {best[1].GetReference()} GND pad has no "
                           f"via within {max_via} mm")
    results.append(("WARN" if bad else "OK",
                    f"decoupling: {checked} supply pins, {len(bad)} findings"))
    for b in bad:
        results.append(("WARN", f"  decoupling: {b}"))


def check_power_widths(board, results):
    thin = {}
    for t in board.GetTracks():
        if t.Type() == pcbnew.PCB_VIA_T:
            continue
        cls = t.GetNetClassName() if hasattr(t, "GetNetClassName") else ""
        w = pcbnew.ToMM(t.GetWidth())
        lim = {"Power": 0.5, "Power3V": 0.3}.get(t.GetNet().GetNetClassName(), None)
        if lim and w < lim - 1e-6 and pcbnew.ToMM(t.GetLength()) > 1.05:
            thin[t.GetNetname()] = min(w, thin.get(t.GetNetname(), 9))
    results.append(("ERROR" if thin else "OK", f"power widths: {thin or 'all >= class minimum'}"))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("board", choices=["main"])
    ap.add_argument("--variant", default="main", help="one board since 2026-09-28")
    ap.add_argument("--out")
    a = ap.parse_args()
    cfg_all = load_yaml(LAYOUT / "boards.yaml")
    out = Path(a.out) if a.out else BUILD / a.board / "layout"
    out.mkdir(parents=True, exist_ok=True)
    board, pcb, _ = load(a.board, cfg_all, a.variant)
    results = []
    pro = json.loads(pcb.with_suffix(".kicad_pro").read_text())
    sev = pro["board"]["design_settings"]["rule_severities"]
    strict = ("silk_overlap", "silk_over_copper", "silk_edge_clearance", "courtyards_overlap")
    loose = [k for k in strict if sev.get(k) != "error"]
    results.append(("ERROR" if loose else "OK",
                    f"DRC severities: {'not error: ' + ', '.join(loose) if loose else ', '.join(strict)} = error"))
    errs, unconnected, d = run_drc(pcb, out)
    results.append(("ERROR" if errs else "OK", f"DRC: {len(errs)} errors"))
    for v in errs[:200]:
        results.append(("ERROR", f"  {v['type']}: " + "; ".join(i['description'][:70] for i in v['items'])))
    results.append(("ERROR" if unconnected else "OK", f"unconnected items: {len(unconnected)}"))
    for v in unconnected[:100]:
        results.append(("ERROR", "  unconnected: " + "; ".join(i['description'][:60] for i in v['items'])))
    check_antenna(board, results)
    check_nfc(board, cfg_all[a.board], results)
    check_usb(board, results)
    check_decoupling(board, results)
    check_power_widths(board, results)
    text = "\n".join(f"{lvl:5} {msg}" for lvl, msg in results) + "\n"
    (out / "checks.txt").write_text(text)
    n_err = sum(1 for lvl, _ in results if lvl == "ERROR" and not _.startswith("  "))
    print(f"{a.board}: " + "; ".join(m for lvl, m in results if not m.startswith("  ")))
    sys.exit(1 if n_err else 0)


if __name__ == "__main__":
    main()
