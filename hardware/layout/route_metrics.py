"""Routing metrics and style checks of the routed board (KiCad's Python).

    <KiCad python> route_metrics.py [out.txt]      # (make route) -> build/review/route-metrics.txt

- counts: tracks, vias (signal / GND stitching), total and per-layer track length
- style: every segment at a multiple of 45°, no acute angle where two segments of a net meet
- planes: no top-layer copper of another net under the USB pair or the analog audio lines
  (their return path in the top GND plane stays unbroken)
- widths: VBUS/3V3 >= 0.4 mm except the named short necks
- USB: D+/D- signal path length, receptacle pad -> module pin (stubs to the second receptacle
  pad counted separately), and the difference
Exit status 1 when a style/plane/width check fails.
"""

from __future__ import annotations

import math
import sys
from collections import defaultdict
from pathlib import Path

import kienv  # noqa: F401
import pcbnew
from kienv import BUILD, KICAD_OUT

from place import BOARD, unP

USB = {"USB_DP", "USB_DN"}
AUDIO = {"HS_EAR", "HS_MIC", "EAR_AC", "DAC_OUTP", "MIC1P", "MIC_BIAS"}
POWER_MIN = 0.4
# (net, why): power necks narrower than 0.4 mm, each <= 6 mm
POWER_NECKS = {"VBUS": "0.3 mm link through the USBLC6's pad-row gap to its VBUS pin (no load)",
               "3V3": "codec/pull-up spurs: 0.2-0.25 mm into 0.4 mm-pitch pins and between two vias"}


def segs(board):
    out = []
    for t in board.GetTracks():
        if t.Type() == pcbnew.PCB_VIA_T:
            continue
        a, b = unP(t.GetStart()), unP(t.GetEnd())
        out.append(dict(net=t.GetNetname(), layer=t.GetLayer(), a=a, b=b,
                        w=pcbnew.ToMM(t.GetWidth()), len=math.dist(a, b)))
    return out


def angle_ok(s) -> bool:
    dx, dy = s["b"][0] - s["a"][0], s["b"][1] - s["a"][1]
    ang = math.degrees(math.atan2(dy, dx)) % 45.0
    return min(ang, 45.0 - ang) < 0.05


def acute(ss):
    """Pairs of same-net, same-layer segments sharing an end point at an angle < 90°."""
    ends = defaultdict(list)
    for s in ss:
        for p, q in ((s["a"], s["b"]), (s["b"], s["a"])):
            ends[(s["net"], s["layer"], round(p[0], 3), round(p[1], 3))].append((p, q))
    bad = []
    for (net, layer, x, y), lst in ends.items():
        for i in range(len(lst)):
            for j in range(i + 1, len(lst)):
                (p, q1), (_, q2) = lst[i], lst[j]
                v1 = (q1[0] - p[0], q1[1] - p[1])
                v2 = (q2[0] - p[0], q2[1] - p[1])
                n1, n2 = math.hypot(*v1), math.hypot(*v2)
                if n1 < 1e-6 or n2 < 1e-6:
                    continue
                c = (v1[0] * v2[0] + v1[1] * v2[1]) / (n1 * n2)
                if math.degrees(math.acos(max(-1, min(1, c)))) < 89.9:
                    bad.append((net, x, y))
    return bad


def seg_dist(p1, p2, q1, q2) -> float:
    def pt(p, a, b):
        vx, vy = b[0] - a[0], b[1] - a[1]
        L2 = vx * vx + vy * vy
        t = 0.0 if L2 == 0 else max(0.0, min(1.0, ((p[0] - a[0]) * vx + (p[1] - a[1]) * vy) / L2))
        return math.dist(p, (a[0] + t * vx, a[1] + t * vy))

    def cross(a, b, c, d):
        def o(p, q, r):
            return (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0])
        return o(a, b, c) * o(a, b, d) < 0 and o(c, d, a) * o(c, d, b) < 0

    if cross(p1, p2, q1, q2):
        return 0.0
    return min(pt(p1, q1, q2), pt(p2, q1, q2), pt(q1, p1, p2), pt(q2, p1, p2))


def under(ss, vias, nets, margin=0.3):
    """Top-layer copper of other nets overlapping (plus margin) bottom tracks of `nets`."""
    bot = [s for s in ss if s["net"] in nets and s["layer"] == pcbnew.B_Cu]
    top = [s for s in ss if s["net"] not in nets and s["layer"] == pcbnew.F_Cu]
    hits = set()
    for b in bot:
        for t in top:
            if seg_dist(b["a"], b["b"], t["a"], t["b"]) < b["w"] / 2 + t["w"] / 2 + margin:
                hits.add((b["net"], t["net"], round(t["a"][0], 1), round(t["a"][1], 1)))
        for v in vias:
            if v[2] not in nets and v[2] != "GND" and \
                    seg_dist(b["a"], b["b"], v[:2], v[:2]) < b["w"] / 2 + 0.3 + margin:
                hits.add((b["net"], v[2] + " via", round(v[0], 1), round(v[1], 1)))
    return sorted(hits)


def usb_paths(board, ss):
    """Receptacle pad -> module pin along the net's tracks (Dijkstra over segment ends)."""
    def pad(ref, num):
        fp = board.FindFootprintByReference(ref)
        return next(unP(p.GetPosition()) for p in fp.Pads() if p.GetNumber() == num)

    res = {}
    for net, starts, end, jumps in (("USB_DP", ("A6", "B6"), "14", [("1", "6")]),
                                    ("USB_DN", ("A7", "B7"), "13", [("3", "4")])):
        g = defaultdict(list)
        for s in ss:
            if s["net"] != net:
                continue
            a, b = (round(s["a"][0], 3), round(s["a"][1], 3)), (round(s["b"][0], 3), round(s["b"][1], 3))
            g[a].append((b, s["len"]))
            g[b].append((a, s["len"]))
        # the TVS passes the line through the package: join its two pads
        for p1, p2 in jumps:
            a, b = pad("D1", p1), pad("D1", p2)
            a, b = (round(a[0], 3), round(a[1], 3)), (round(b[0], 3), round(b[1], 3))
            g[a].append((b, 0.0))
            g[b].append((a, 0.0))
        tgt = pad("U1", end)
        tgt = (round(tgt[0], 3), round(tgt[1], 3))
        lens = {}
        for st in starts:
            p = pad("J1", st)
            src = (round(p[0], 3), round(p[1], 3))
            dist = {src: 0.0}
            todo = [src]
            while todo:
                todo.sort(key=lambda n: dist[n])
                n = todo.pop(0)
                for m, w in g[n]:
                    if dist[n] + w < dist.get(m, 1e9):
                        dist[m] = dist[n] + w
                        todo.append(m)
            lens[st] = dist.get(tgt, float("nan"))
        res[net] = lens
    return res


def main() -> int:
    out = Path(sys.argv[1]) if len(sys.argv) > 1 else BUILD / "review" / "route-metrics.txt"
    board = pcbnew.LoadBoard(str(KICAD_OUT / BOARD / f"{BOARD}.kicad_pcb"))
    ss = segs(board)
    vias = [(*unP(t.GetPosition()), t.GetNetname()) for t in board.GetTracks()
            if t.Type() == pcbnew.PCB_VIA_T]
    lines, fail = [], False
    tot = sum(s["len"] for s in ss)
    top = sum(s["len"] for s in ss if s["layer"] == pcbnew.F_Cu)
    gnd_v = sum(1 for v in vias if v[2] == "GND")
    lines.append(f"tracks: {len(ss)} segments, {tot:.0f} mm total ({tot - top:.0f} mm bottom, "
                 f"{top:.0f} mm top)")
    lines.append(f"vias: {len(vias)} ({len(vias) - gnd_v} signal/supply, {gnd_v} GND: "
                 "ground pads + stitching)")
    bad = [s for s in ss if not angle_ok(s)]
    lines.append(f"segments not at a multiple of 45°: {len(bad)}")
    lines += [f"  {s['net']} {s['a']} -> {s['b']}" for s in bad[:20]]
    ac = acute(ss)
    lines.append(f"acute junctions (< 90°): {len(ac)}")
    lines += [f"  {n} at ({x}, {y})" for n, x, y in ac[:20]]
    fail |= bool(bad) or bool(ac)
    for label, nets in (("USB pair", USB), ("analog audio", AUDIO)):
        h = under(ss, vias, nets)
        lines.append(f"top-layer copper under the {label}: {len(h)}")
        lines += [f"  {a} under {b} at ({x}, {y})" for a, b, x, y in h[:20]]
        fail |= bool(h)
    thin = defaultdict(float)
    for s in ss:
        if s["net"] in ("VBUS", "3V3") and s["w"] < POWER_MIN - 1e-6:
            thin[s["net"]] += s["len"]
    for net, ln in sorted(thin.items()):
        ok = net in POWER_NECKS and ln <= 12.0
        lines.append(f"{net} below {POWER_MIN} mm: {ln:.1f} mm ({POWER_NECKS.get(net, 'not allowed')})")
        fail |= not ok
    for z in board.Zones():
        for L in (pcbnew.F_Cu, pcbnew.B_Cu):
            if not z.IsOnLayer(L):
                continue
            ps = z.GetFilledPolysList(L)
            area = ps.Area() / 1e12                   # nm^2 -> mm^2
            lines.append(f"zone {z.GetZoneName()!r} ({z.GetNetname()}, {board.GetLayerName(L)}): "
                         f"{area:.0f} mm2 filled in {ps.OutlineCount()} piece(s)")
            if z.GetNetname() == "3V3" and area < 100.0:
                lines.append("  < 100 mm2 heat copper on the LDO tab (BR-13)")
                fail = True
    widths = sorted({round(s["w"], 3) for s in ss})
    lines.append(f"track widths used: {widths}")
    up = usb_paths(board, ss)
    dp, dn = min(up["USB_DP"].values()), min(up["USB_DN"].values())
    lines.append("USB signal path J1 -> module: D+ " + ", ".join(f"{k} {v:.2f}" for k, v in up["USB_DP"].items())
                 + " mm; D- " + ", ".join(f"{k} {v:.2f}" for k, v in up["USB_DN"].items())
                 + f" mm; shortest D+ {dp:.2f} vs D- {dn:.2f}: difference {abs(dp - dn):.2f} mm")
    text = "\n".join(lines) + "\n"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(text)
    print(text, end="")
    return 1 if fail else 0


if __name__ == "__main__":
    sys.exit(main())
