"""Placement metrics (KiCad Python): ratsnest length, USB pair lengths, bottom parts, overlaps.

    python metrics.py [board.kicad_pcb] [--json out.json] [--draw LAYER]

- Ratsnest = per net, the minimum spanning tree over its pad centres (Euclidean, ignoring
  copper), summed. Reported with and without GND (GND joins through the pours and vias).
- Signal wiring = every net without a pour (plane nets drop a via into their plane), each in
  bus / daisy-chain order (from the ESP32 pad, nearest neighbour + 2-opt); `crossings` counts
  pairwise crossings of those segments (shared endpoints do not count). The image shows these.
- USB pairs: MST length of HS_USB_DP/DN (handset) and USB_DP/DN + USB_DP_C/DN_C (power port).
- Bottom parts: fitted footprints on B.Cu (mounting holes/logos excluded).
- Courtyard overlaps: pairs of same-side footprints whose courtyard polygons intersect.
- --png OUT: the owner-facing placement image. The MST edges are drawn as 0.15 mm lines on User
  layers (one per group: User.1 power, User.2 USB, User.3 audio, User.4 keys/LEDs, User.9
  other) on a scratch copy of the board, plotted with `kicad-cli pcb export svg` together with
  Edge.Cuts and F/B.Fab (part outlines + references), recoloured per group, and converted to PNG
  (qlmanage, macOS). GND is left out (it joins through the planes).
"""

from __future__ import annotations

import argparse
import json
import math
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

import kienv  # noqa: F401
from kienv import KICAD_CLI, KICAD_OUT

import pcbnew

SUPPLY = {"3V3", "3V0", "VSYS", "VBUS", "VBAT", "HS_VBUS", "HS_VIN", "VLED"}
USB_HS = ("HS_USB_DP", "HS_USB_DN")
USB_PWR = ("USB_DP", "USB_DN", "USB_DP_C", "USB_DN_C")


def pads_by_net(board):
    out = {}
    for fp in board.GetFootprints():
        for p in fp.Pads():
            n = p.GetNetname()
            if n and not n.startswith("unconnected-"):
                x, y = p.GetPosition().x / 1e6, p.GetPosition().y / 1e6
                out.setdefault(n, []).append((x, y, fp.GetReference()))
    return out


def mst(pts):
    """Prim's algorithm; returns (length, edges)."""
    if len(pts) < 2:
        return 0.0, []
    n = len(pts)
    inside = [False] * n
    dist = [math.inf] * n
    par = [-1] * n
    dist[0] = 0
    total, edges = 0.0, []
    for _ in range(n):
        u = min((i for i in range(n) if not inside[i]), key=lambda i: dist[i])
        inside[u] = True
        if par[u] >= 0:
            total += dist[u]
            edges.append((pts[par[u]], pts[u]))
        for v in range(n):
            if not inside[v]:
                d = math.hypot(pts[u][0] - pts[v][0], pts[u][1] - pts[v][1])
                if d < dist[v]:
                    dist[v], par[v] = d, u
    return total, edges


def _cross(p, q, r, s):
    def o(a, b, c):
        return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])
    return o(p, q, r) * o(p, q, s) < 0 and o(r, s, p) * o(r, s, q) < 0


def crossings(edges) -> int:
    """Pairwise crossings between the ratsnest (MST) segments of all non-GND nets; segments
    that share an endpoint do not count. Grid-bucketed so it stays fast."""
    segs = []
    for n, es in edges.items():
        if n == "GND":
            continue
        for a, b in es:
            segs.append((a, b))
    cell = 10.0
    grid = {}
    for i, (a, b) in enumerate(segs):
        x0, x1 = sorted((a[0], b[0]))
        y0, y1 = sorted((a[1], b[1]))
        for gx in range(int(x0 // cell), int(x1 // cell) + 1):
            for gy in range(int(y0 // cell), int(y1 // cell) + 1):
                grid.setdefault((gx, gy), []).append(i)
    seen = set()
    for ids in grid.values():
        for k, i in enumerate(ids):
            for j in ids[k + 1:]:
                if (i, j) in seen:
                    continue
                seen.add((i, j))
    n = 0
    for i, j in seen:
        (a, b), (c, d) = segs[i], segs[j]
        if {a, b} & {c, d}:
            continue
        if _cross(a, b, c, d):
            n += 1
    return n


def courtyard_overlaps(board):
    fps = [fp for fp in board.GetFootprints() if not fp.GetReference().startswith(("H", "G"))]
    polys = []
    for fp in fps:
        lay = pcbnew.B_CrtYd if fp.IsFlipped() else pcbnew.F_CrtYd
        poly = fp.GetCourtyard(lay)
        if poly.OutlineCount():
            polys.append((fp, fp.IsFlipped(), poly, poly.BBox()))
    hits = []
    for i, (a, sa, pa, ba) in enumerate(polys):
        for b, sb, pb, bb in polys[i + 1:]:
            if sa != sb or not ba.Intersects(bb):
                continue
            inter = pcbnew.SHAPE_POLY_SET(pa)
            inter.BooleanIntersection(pb)
            if inter.OutlineCount() and inter.Area() > 1e6 * 0.001:  # > 0.001 mm2
                hits.append((a.GetReference(), b.GetReference()))
    return hits


def decoupling(board, limit=2.0):
    """Every 100 nF cap between a supply net and GND: pad-edge gap to the nearest pad of an IC
    (U*) on the same supply net. Returns [(cap, ic.pad, gap_mm)] sorted by gap, worst first."""
    def box(p):
        bb = p.GetBoundingBox()
        return bb.GetX() / 1e6, bb.GetY() / 1e6, bb.GetRight() / 1e6, bb.GetBottom() / 1e6

    def gap(a, b):
        dx = max(b[0] - a[2], a[0] - b[2], 0)
        dy = max(b[1] - a[3], a[1] - b[3], 0)
        return math.hypot(dx, dy)

    ic_pads = {}
    for fp in board.GetFootprints():
        if fp.GetReference().startswith("U"):
            for p in fp.Pads():
                ic_pads.setdefault(p.GetNetname(), []).append((f"{fp.GetReference()}.{p.GetNumber()}", box(p)))
    out = []
    for fp in board.GetFootprints():
        if not fp.GetReference().startswith("C") or not fp.GetValue().startswith("100nF"):
            continue
        nets = {p.GetNetname(): p for p in fp.Pads()}
        sup = [n for n in nets if n != "GND"]
        if "GND" not in nets or len(sup) != 1 or sup[0] not in ic_pads or sup[0] not in SUPPLY:
            continue
        cb = box(nets[sup[0]])
        best = min(((gap(cb, b), name) for name, b in ic_pads[sup[0]]), default=None)
        if best:
            out.append((fp.GetReference(), best[1], round(best[0], 2)))
    return sorted(out, key=lambda t: -t[2])


def netclass(board, name):
    ni = board.FindNet(name)
    return ni.GetNetClassName() if ni else "Default"


def plane_nets(board) -> set:
    """Nets that have a copper pour (GND on L2, 3V3/VSYS/3V0 on L3): their pins just drop a
    via into the plane, so they are not wiring and stay out of the chain metrics/image."""
    return {z.GetNetname() for z in board.Zones() if not z.GetIsRuleArea() and z.GetNetname()}


def chain(pts):
    """Bus / daisy-chain order: start at the ESP32 pad if the net has one (the driver), else
    at the pad farthest from the net's centroid, then nearest neighbour, then 2-opt."""
    if len(pts) < 2:
        return 0.0, []
    start = next((i for i, p in enumerate(pts) if p[2] == "U1"), None)
    if start is None:
        cx = sum(p[0] for p in pts) / len(pts)
        cy = sum(p[1] for p in pts) / len(pts)
        start = max(range(len(pts)), key=lambda i: math.hypot(pts[i][0] - cx, pts[i][1] - cy))
    order, left = [start], set(range(len(pts))) - {start}
    while left:
        a = pts[order[-1]]
        nxt = min(left, key=lambda i: math.hypot(pts[i][0] - a[0], pts[i][1] - a[1]))
        order.append(nxt)
        left.discard(nxt)
    d = lambda i, j: math.hypot(pts[i][0] - pts[j][0], pts[i][1] - pts[j][1])  # noqa: E731
    improved = len(order) > 3
    while improved:
        improved = False
        for i in range(1, len(order) - 2):
            for j in range(i + 1, len(order) - 1):
                a, b, c, e = order[i - 1], order[i], order[j], order[j + 1]
                if d(a, c) + d(b, e) < d(a, b) + d(c, e) - 1e-6:
                    order[i:j + 1] = reversed(order[i:j + 1])
                    improved = True
    segs = [((pts[a][0], pts[a][1]), (pts[b][0], pts[b][1])) for a, b in zip(order, order[1:])]
    return sum(math.hypot(q[0] - p_[0], q[1] - p_[1]) for p_, q in segs), segs


def signal_chains(board, by=None):
    by = by or pads_by_net(board)
    planes = plane_nets(board)
    out = {}
    for n, pts in by.items():
        if n not in planes:
            out[n] = chain(pts)
    return out


def metrics(board):
    by = pads_by_net(board)
    per, edges = {}, {}
    for n, pts in by.items():
        per[n], edges[n] = mst([(x, y) for x, y, _ in pts])
    total = sum(per.values())
    no_gnd = total - per.get("GND", 0.0)
    sig = signal_chains(board, by)
    sig_edges = {n: e for n, (_, e) in sig.items()}
    bottom = sorted(fp.GetReference() for fp in board.GetFootprints() if fp.IsFlipped()
                    and not fp.GetReference().startswith(("H", "G", "FID")))
    return {
        "ratsnest_mm": round(total, 1),
        "ratsnest_no_gnd_mm": round(no_gnd, 1),
        "signal_mm": round(sum(v for v, _ in sig.values()), 1),
        "crossings": crossings(sig_edges),
        "planes": sorted(plane_nets(board)),
        "net_mm": {k: round(v, 1) for k, v in per.items()},
        "hs_usb_mm": {n: round(per.get(n, 0), 1) for n in USB_HS},
        "pwr_usb_mm": {n: round(per.get(n, 0), 1) for n in USB_PWR if n in per},
        "bottom_parts": len(bottom),
        "bottom_refs": bottom,
        "courtyard_overlaps": courtyard_overlaps(board),
        "decoupling_over_2mm": [d for d in decoupling(board) if d[2] > 2.0],
        "top_nets": sorted(((round(v, 1), k) for k, (v, _) in sig.items()), reverse=True)[:25],
    }, sig_edges


GROUPS = [  # (User layer, colour, label)
    ("User.1", "#d62728", "power"), ("User.2", "#1f77b4", "USB"), ("User.3", "#2ca02c", "audio"),
    ("User.4", "#ff7f0e", "keys / LEDs"), ("User.9", "#8c8c8c", "other"),
]


def group_of(board, name):
    if re.match(r"^(KEY_|LED_D)", name):
        return 3
    c = netclass(board, name)
    return {"Power": 0, "Power3V": 0, "USB": 1, "Audio": 2, "Speaker": 2}.get(c, 4)


def _pads(board, net, skip=("R", "C", "FB", "TP", "NT")):
    out = []
    for fp in board.GetFootprints():
        if fp.GetReference().startswith(skip):
            continue
        for p_ in fp.Pads():
            if p_.GetNetname() == net:
                out.append((p_.GetPosition().x / 1e6 - 40, p_.GetPosition().y / 1e6 - 40,
                            fp.GetReference()))
    return out


def _manhattan(pts, dy=0.0):
    poly = []
    for (ax, ay, *_), (bx, by, *_) in zip(pts, pts[1:]):
        poly += [(ax, ay + dy), (bx, ay + dy), (bx, by)]
    return poly


def channels(board):
    """Planned wiring channels for the review image (board mm): [(colour, width, poly, label)].
    Keys run as parallel row buses into the AW9523B (lanes in row order), the other buses as
    Manhattan links in bus / daisy-chain order; every other non-plane net as a thin grey link."""
    planes = plane_nets(board)
    out, drawn = [], set()
    orange, blue, green, red, grey, dark = "#ff7f0e", "#1f77b4", "#2ca02c", "#d62728", "#b0b0b0", "#555555"
    aw = {p_.GetNetname(): (p_.GetPosition().x / 1e6 - 40, p_.GetPosition().y / 1e6 - 40)
          for p_ in board.FindFootprintByReference("U17").Pads()}
    rear = ["MENU", "5", "4", "3", "2", "1"]
    front = ["BACK", "0", "9", "8", "7", "6"]
    for i, k in enumerate(rear):
        n = f"KEY_{k}"
        sx, sy, _ = next(q for q in _pads(board, n) if q[2].startswith("SW"))
        ax, ay = aw[n]
        ly, xv = 23.2 + 0.45 * i, 141.0 - 0.45 * i
        out.append((orange, 0.25, [(sx, sy), (sx, ly), (xv, ly), (xv, ay), (ax, ay)],
                    "rear key bus (L4)" if i == 0 else None))
        drawn.add(n)
    for i, k in enumerate(front):
        n = f"KEY_{k}"
        sx, sy, _ = next(q for q in _pads(board, n) if q[2].startswith("SW"))
        ax, ay = aw[n]
        ly = 65.4 - 0.45 * i
        poly = [(sx, sy), (sx, ly)]
        poly += [(ax + 1.2, ly), (ax + 1.2, ay), (ax, ay)] if k == "BACK" else [(ax, ly), (ax, ay)]
        out.append((orange, 0.25, poly, "front key bus (L4)" if i == 5 else None))
        drawn.add(n)
    buses = [
        (r"^(LED_D\d+|LED_DATA|LED_DATA_BUF)$", orange, 0.25, "LED chain"),
        (r"^I2C_SDA$", dark, 0.3, "I2C spine"), (r"^I2C_SCL$", dark, 0.3, None),
        (r"^I2S_", dark, 0.3, "I2S bundle"),
        (r"^EPD_(CS|MOSI|SCK|DC|RST|BUSY)$", dark, 0.3, "EPD SPI bundle"),
        (r"^HS_USB_D[PN]$", blue, 0.35, "handset USB pair"),
        (r"^USB_D[PN](_C)?$", blue, 0.35, "power USB pair"),
        (r"^(VOL_|MUTE_SENSE)", orange, 0.25, "side controls"),
    ]
    by = pads_by_net(board)
    for pat, col, wid, label in buses:
        nets = sorted(n for n in by if re.match(pat, n))
        for j, n in enumerate(nets):
            pts = _pads(board, n) or [(x - 40, y - 40, r) for x, y, r in by[n]]
            _, segs = chain([(x + 40, y + 40, r) for x, y, r in pts])
            order = [(a[0] - 40, a[1] - 40) for a, _ in segs] + ([(segs[-1][1][0] - 40, segs[-1][1][1] - 40)] if segs else [])
            out.append((col, wid, _manhattan(order, dy=0.4 * j), label if j == 0 else None))
            drawn.add(n)
    for n, pts in by.items():
        if n in drawn or n in planes or n == "GND" or len(pts) < 2:
            continue
        _, segs = chain(pts)
        order = [(a[0] - 40, a[1] - 40) for a, _ in segs] + [(segs[-1][1][0] - 40, segs[-1][1][1] - 40)]
        c = netclass(board, n)
        col = red if c in ("Power", "Power3V") else green if c in ("Audio", "Speaker") else grey
        out.append((col, 0.15, _manhattan(order), None))
    return out


def placement_png(board, edges, m, out: Path) -> None:
    tmp = Path(tempfile.mkdtemp(prefix="olp-placement-"))
    try:
        chans = channels(board)
        for fp in board.GetFootprints():  # references only: values would bury the ratsnest
            fp.Value().SetVisible(False)
            for g in fp.GraphicalItems():
                if isinstance(g, pcbnew.PCB_TEXT) and g.GetLayer() in (pcbnew.F_Fab, pcbnew.B_Fab) \
                        and "REFERENCE" not in g.GetText():
                    g.SetVisible(False)
        pcb = tmp / "placement.kicad_pcb"
        pcbnew.SaveBoard(str(pcb), board)
        layers = ["B.Fab", "F.Fab", "Edge.Cuts"]
        subprocess.run([KICAD_CLI, "pcb", "export", "svg", str(pcb), "-o", str(tmp), "--mode-multi",
                        "--fit-page-to-board", "--exclude-drawing-sheet", "-l", ",".join(layers)],
                       check=True, capture_output=True)
        colour = {"B.Fab": "#c8d2ea", "F.Fab": "#9a9a9a", "Edge.Cuts": "#000000"}
        head, bodies = None, []
        for lay in layers:
            f = tmp / f"placement-{lay.replace('.', '_')}.svg"
            txt = f.read_text()
            i = txt.index("<desc>")
            i = txt.index("</desc>", i) + len("</desc>")
            head = head or txt[:i]
            body = txt[i:txt.rindex("</svg>")]
            bodies.append(re.sub(r"(stroke|fill):#[0-9A-Fa-f]{6}", rf"\1:{colour[lay]}", body))
        w, h = 180.0, 88.0
        head = re.sub(r'width="[^"]+" height="[^"]+" viewBox="[^"]+"',
                      f'width="{w + 4}mm" height="{h + 16}mm" viewBox="-2 -2 {w + 4} {h + 16}"', head)
        legend = "".join(
            f'<rect x="{2 + 30 * k}" y="{h + 4.2}" width="6" height="1.2" fill="{c}"/>'
            f'<text x="{9 + 30 * k}" y="{h + 5.6}" font-family="Helvetica" font-size="3" '
            f'fill="#222">{lab}</text>' for k, (_, c, lab) in enumerate(GROUPS))
        usb = m["hs_usb_mm"]
        info = (f"Planned channels (Manhattan lanes; planes {'/'.join(m['planes'])} omitted). "
                f"Straight-line: {m['signal_mm']:.0f} mm signal wiring, {m['crossings']} "
                f"crossings; handset USB {usb['HS_USB_DP']:.1f}/{usb['HS_USB_DN']:.1f} mm; "
                f"{m['bottom_parts']} bottom parts, {len(m['courtyard_overlaps'])} courtyard overlaps.")
        lines, labels = [], []
        for col, wid, poly, label in chans:
            if len(poly) < 2:
                continue
            pts = " ".join(f"{x:.2f},{y:.2f}" for x, y in poly)
            lines.append(f'<polyline points="{pts}" fill="none" stroke="{col}" stroke-width="{wid}" '
                         'stroke-linejoin="round" stroke-opacity="0.9"/>')
            if label:
                x, y = poly[len(poly) // 2]
                labels.append(f'<text x="{x + 0.8:.1f}" y="{y - 0.8:.1f}" font-family="Helvetica" '
                              f'font-size="2.2" font-weight="bold" fill="{col}" stroke="#fff" '
                              f'stroke-width="0.35" paint-order="stroke">{label}</text>')
        svg = (head + f'<rect x="-2" y="-2" width="{w + 4}" height="{h + 16}" fill="#ffffff"/>'
               + "".join(bodies) + "".join(lines) + "".join(labels) + legend
               + f'<text x="2" y="{h + 11}" font-family="Helvetica" font-size="2.6" fill="#222">'
               + info + "</text></svg>\n")
        sp = tmp / "placement.svg"
        sp.write_text(svg)
        subprocess.run(["qlmanage", "-t", "-s", "2400", "-o", str(tmp), str(sp)], check=True,
                       capture_output=True)
        out.parent.mkdir(parents=True, exist_ok=True)
        shutil.move(str(tmp / "placement.svg.png"), str(out))
        # qlmanage pads to a square: crop to the drawn content (bounding box of non-white pixels)
        try:
            from PIL import Image  # optional; KiCad's Python may not have it
            im = Image.open(out).convert("RGB")
            bbox = Image.eval(im, lambda v: 255 - v).getbbox()
            if bbox:
                im.crop(bbox).save(out)
        except ImportError:  # KiCad's Python has no PIL: use the hardware venv (matplotlib's)
            crop = ("import sys; from PIL import Image, ImageOps; im = Image.open(sys.argv[1])"
                    ".convert('RGB'); im.crop(ImageOps.invert(im).getbbox()).save(sys.argv[1])")
            subprocess.run([str(kienv.HW / ".venv" / "bin" / "python"), "-c", crop, str(out)],
                           check=True)
        print(f"wrote {out}")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("pcb", nargs="?", default=str(KICAD_OUT / "main" / "main.kicad_pcb"))
    ap.add_argument("--json")
    ap.add_argument("--png", help="write the placement review image (ratsnest by net group)")
    a = ap.parse_args()
    board = pcbnew.LoadBoard(a.pcb)
    m, edges = metrics(board)
    print(json.dumps({k: v for k, v in m.items() if k not in ("bottom_refs", "top_nets", "net_mm")},
                     indent=1))
    if a.json:
        Path(a.json).write_text(json.dumps(m, indent=1))
    if a.png:
        placement_png(board, edges, m, Path(a.png))
    return 0


if __name__ == "__main__":
    sys.exit(main())
