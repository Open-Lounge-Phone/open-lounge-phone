"""Placement review: straight-line wiring metrics, decoupling distances, planned wiring lanes and
the owner-facing image build/review/placement.png (project venv: matplotlib).

    .venv/bin/python layout/review_placement.py [--assign]

Input: build/review/placement.json from layout/dump_parts.py (KiCad's Python) of the placed
board. Nothing is written back to the board: the lanes live only in the image.

Metrics (GND and 3V3 are pours, so they are left out of both):
- wiring length = per net, the minimum spanning tree over its pad centres (pads of one part on
  the same net count as joined), summed: the straight-line ("ratsnest") length.
- crossings = pairs of those straight segments of different nets that cross (segments sharing
  an end do not count).
- decoupling = copper gap from each supply capacitor's pad to the IC pin it serves (<= 2 mm).

--assign searches the GPIO order inside each bus (rear keys, front keys, display, codec) for the
fewest crossings, then the shortest length, and prints it (the pin table is edited by hand).
"""

from __future__ import annotations

import argparse
import itertools
import json
import math
import sys
from pathlib import Path

import yaml

HW = Path(__file__).resolve().parent.parent
REVIEW = HW / "build" / "review"
POURS = {"GND", "3V3"}
V33 = (0.8, 0.8, 32.8, 33.6)     # 3V3 pour island on the top layer over the rear band

# ESP32-S3-WROOM-1U pad number of each GPIO (datasheet v1.8 p9-11; = parts.py)
GPIO_PAD = {4: 4, 5: 5, 6: 6, 7: 7, 15: 8, 16: 9, 17: 10, 18: 11, 8: 12, 19: 13, 20: 14, 3: 15,
            46: 16, 9: 17, 10: 18, 11: 19, 12: 20, 13: 21, 14: 22, 21: 23, 47: 24, 48: 25,
            45: 26, 0: 27, 35: 28, 36: 29, 37: 30, 38: 31, 39: 32, 40: 33, 41: 34, 42: 35,
            44: 36, 43: 37, 2: 38, 1: 39}
PAD_GPIO = {v: k for k, v in GPIO_PAD.items()}

# supply decoupling: capacitor -> the IC pin it serves (DESIGN.md: within 2 mm)
DECOUPLING = {"C1": ("U2", "3"), "C2": ("U2", "2"), "C3": ("U1", "2"), "C4": ("U1", "2"),
              "C6": ("U3", "3"), "C7": ("U3", "4"), "C8": ("U3", "11")}
# reference / filter capacitors at the codec (reported, same 2 mm goal)
REFCAPS = {"C9": ("U3", "16"), "C10": ("U3", "15"), "C11": ("U3", "14"), "C14": ("U3", "18"),
           "C15": ("U3", "17"), "C5": ("U1", "3")}

REAR_KEYS = ["KEY_1", "KEY_2", "KEY_3", "KEY_4", "KEY_5", "KEY_MENU"]
FRONT_KEYS = ["KEY_6", "KEY_7", "KEY_8", "KEY_9", "KEY_0", "KEY_BACK"]
DISPLAY = ["EPD_CLK", "EPD_DIN", "EPD_DC", "EPD_CS", "EPD_BUSY", "EPD_RST"]
CODEC = ["I2S_MCLK", "I2S_BCLK", "I2S_WS", "I2S_DOUT", "I2S_DIN", "I2C_SDA", "I2C_SCL", "JACK_DET"]
USB = ["USB_DP", "USB_DN"]
GROUPS = {  # colour, label
    "rear": ("#1f77b4", "rear keys 1-5, MENU"), "front": ("#2ca02c", "front keys 6-0, BACK"),
    "disp": ("#9467bd", "display SPI"), "codec": ("#ff7f0e", "codec I2S / I2C, jack detect"),
    "usb": ("#d62728", "USB D+/D-"), "vbus": ("#8c564b", "VBUS 5 V"),
    "audio": ("#e377c2", "handset audio (analog)"), "other": ("#555555", "other nets"),
}


def group_of(net: str) -> str:
    if net in REAR_KEYS:
        return "rear"
    if net in FRONT_KEYS:
        return "front"
    if net in DISPLAY:
        return "disp"
    if net in CODEC:
        return "codec"
    if net in USB:
        return "usb"
    if net == "VBUS":
        return "vbus"
    if net in ("HS_EAR", "HS_MIC", "EAR_AC", "DAC_OUTP", "MIC1P", "MIC1N", "MIC_BIAS", "HS_DET"):
        return "audio"
    return "other"


# ---------------------------------------------------------------------------------------------
# geometry


def load():
    d = json.loads((REVIEW / "placement.json").read_text())
    parts = {p["ref"]: p for p in d["parts"]}
    nets = {}
    for p in d["parts"]:
        for q in p["pads"]:
            if q["net"] and not q["net"].startswith("unconnected"):
                nets.setdefault(q["net"], []).append((p["ref"], q["n"], *q["at"]))
    return d, parts, nets


def joined(a, b) -> bool:
    """Pads of one part on one net are joined inside the part (module, ICs, switches), except
    on connectors (USB-C A6/B6, jack T/R1): those need a trace."""
    return a[0] == b[0] and not a[0].startswith("J")


def mst(nodes):
    """Prim over pad nodes (ref, n, x, y). Returns (length, [segments]); a segment is
    ((x, y), (x, y), ref_a, ref_b)."""
    n = len(nodes)
    if n < 2:
        return 0.0, []
    inside, dist, par = [False] * n, [math.inf] * n, [-1] * n
    dist[0] = 0.0
    total, segs = 0.0, []
    for _ in range(n):
        u = min((i for i in range(n) if not inside[i]), key=lambda i: dist[i])
        inside[u] = True
        if par[u] >= 0 and not joined(nodes[par[u]], nodes[u]):
            total += dist[u]
            a, b = nodes[par[u]], nodes[u]
            segs.append(((a[2], a[3]), (b[2], b[3]), a[0], b[0]))
        for v in range(n):
            if inside[v]:
                continue
            d = 0.0 if joined(nodes[u], nodes[v]) else math.hypot(nodes[u][2] - nodes[v][2],
                                                                   nodes[u][3] - nodes[v][3])
            if d < dist[v]:
                dist[v], par[v] = d, u
    return total, segs


def _orient(a, b, c):
    return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])


def cross(s, t) -> bool:
    (a, b, ra, rb), (c, d, rc, rd) = s, t
    if {a, b} & {c, d} or len({ra, rb, rc, rd}) == 1:   # shared end, or inside one connector
        return False
    return _orient(a, b, c) * _orient(a, b, d) < 0 and _orient(c, d, a) * _orient(c, d, b) < 0


def metrics(nets):
    segs, total = {}, 0.0
    for name, nodes in nets.items():
        if name in POURS:
            continue
        length, s = mst(nodes)
        segs[name] = s
        total += length
    flat = [(n, s) for n, ss in segs.items() for s in ss]
    pairs = [(flat[i][0], flat[j][0]) for i in range(len(flat)) for j in range(i + 1, len(flat))
             if flat[i][0] != flat[j][0] and cross(flat[i][1], flat[j][1])]
    return total, segs, pairs


def pad_gap(parts, a_ref, a_pad, b_ref, b_pad) -> float:
    """Copper-to-copper gap between two pads (bounding boxes)."""
    pa = next(q for q in parts[a_ref]["pads"] if q["n"] == a_pad)
    pb = next(q for q in parts[b_ref]["pads"] if q["n"] == b_pad)
    (ax0, ay0, ax1, ay1), (bx0, by0, bx1, by1) = pa["bb"], pb["bb"]
    dx = max(bx0 - ax1, ax0 - bx1, 0.0)
    dy = max(by0 - ay1, ay0 - by1, 0.0)
    return math.hypot(dx, dy)


def decoupling(parts):
    out = []
    for cap, (ic, pin) in {**DECOUPLING, **REFCAPS}.items():
        out.append((cap, ic, pin, pad_gap(parts, cap, "1", ic, pin), cap in DECOUPLING))
    return out


# ---------------------------------------------------------------------------------------------
# GPIO order search


def assign(parts, nets):
    """For each bus: the permutation of its nets over its current GPIOs with the fewest
    crossings (against everything else and inside the bus), then the shortest length."""
    u1 = {q["n"]: tuple(q["at"]) for q in parts["U1"]["pads"]}
    for label, group in (("rear keys", REAR_KEYS), ("front keys", FRONT_KEYS),
                         ("display", DISPLAY), ("codec + ringer", CODEC + ["BUZZER"])):
        pins = [next(q["n"] for q in parts["U1"]["pads"] if q["net"] == n) for n in group]
        fixed = [s for n, nodes in nets.items() if n not in POURS and n not in group
                 for s in mst(nodes)[1]]
        opts = {}
        for n in group:
            others = [nd for nd in nets[n] if nd[0] != "U1"]
            for pin in pins:
                nodes = others + [("U1", pin, *u1[pin])]
                length, segs = mst(nodes)
                c = sum(cross(s, f) for s in segs for f in fixed)
                opts[(n, pin)] = (c, length, segs)
        best = None
        for perm in itertools.permutations(pins):
            c = sum(opts[(n, p)][0] for n, p in zip(group, perm))
            length = sum(opts[(n, p)][1] for n, p in zip(group, perm))
            segs = [opts[(n, p)][2] for n, p in zip(group, perm)]
            c += sum(cross(s, t) for i in range(len(segs)) for j in range(i + 1, len(segs))
                     for s in segs[i] for t in segs[j])
            if best is None or (c, length) < best[:2]:
                best = (c, length, perm)
        now = [next(q["n"] for q in parts["U1"]["pads"] if q["net"] == n) for n in group]
        print(f"{label}: best {best[0]} crossings, {best[1]:.1f} mm"
              + ("  (= current)" if list(best[2]) == now else ""))
        for n, p in zip(group, best[2]):
            print(f"  GPIO{PAD_GPIO[int(p)]:<3} {n}")


# ---------------------------------------------------------------------------------------------
# planned lanes (drawn only; buses as parallel tracks, not a straight-line star)


def lanes(parts, nets):
    """[(net, [(x, y), ...], layer)] polylines. Rear keys: drop from the socket pad to a lane
    under the rear sockets, run left, turn down beside the module row. Front keys: rise to a
    lane above the front sockets, run left, turn up into the module's front side. Display: from
    J3 left to the row (RST passes under the module on the top layer). Everything else: short
    direct lines between the parts it joins."""
    u1 = {q["net"]: tuple(q["at"]) for q in parts["U1"]["pads"] if q["net"]}
    pad = {(p["ref"], q["net"]): tuple(q["at"]) for p in parts.values() for q in p["pads"]
           if q["net"]}
    out = []
    # rear keys
    rear = sorted(REAR_KEYS, key=lambda n: next(x for (r, nn), (x, y) in pad.items()
                                               if nn == n and r.startswith("SW")))
    for i, n in enumerate(rear):      # i = 0 nearest the module: top track, last to turn
        sx, sy = next(v for (r, nn), v in pad.items() if nn == n and r.startswith("SW"))
        px, py = u1[n]
        ty = 22.0 + i * 0.9
        tx = px + 2.0 + i * 0.9
        out.append((n, [(sx, sy), (sx, ty), (tx, ty), (tx, py), (px, py)], "B"))
    # front keys
    front = sorted(FRONT_KEYS, key=lambda n: next(x for (r, nn), (x, y) in pad.items()
                                                 if nn == n and r.startswith("SW")))
    for i, n in enumerate(front):     # i = 0 nearest: lowest track
        sx, sy = next(v for (r, nn), v in pad.items() if nn == n and r.startswith("SW"))
        px, py = u1[n]
        ty = 64.5 - i * 0.9
        out.append((n, [(sx, sy), (sx, ty), (px, ty), (px, py)], "B"))
    # hook: straight down left of the front-key lanes, across below them to its socket pad
    hx, hy = next(v for (r, nn), v in pad.items() if nn == "HOOK" and r.startswith("SW"))
    px, py = u1["HOOK"]
    out.append(("HOOK", [(px, py), (px, hy - 4.0), (hx, hy - 4.0), (hx, hy)], "B"))
    # display
    for n in DISPLAY:
        jx, jy = pad[("J3", n)]
        px, py = u1[n]
        if abs(px - parts["U1"]["crt"][2]) < 2.0:          # row pin (faces right)
            mx = px + 3.0 + (jy - 42.0) * 0.4
            out.append((n, [(jx, jy), (mx + 6.0, jy), (mx, py), (px, py)], "B"))
        else:                                               # front-side pin: under the module
            out.append((n, [(jx, jy), (jx - 4.0, jy + 3.0), (24.0, jy + 3.0), (px, py + 0.0)],
                        "F"))
    drawn = {n for n, _, _ in out}
    for name, nodes in nets.items():
        if name in POURS or name in drawn:
            continue
        for a, b, _, _ in mst(nodes)[1]:
            out.append((name, [a, b], "B"))
    return out


# ---------------------------------------------------------------------------------------------
# image


def render(d, parts, nets, total, pairs, dec, path: Path):
    import matplotlib

    matplotlib.use("Agg")
    import matplotlib.patches as mp
    import matplotlib.pyplot as plt

    W, H = d["size"]
    lanes_ = lanes(parts, nets)
    fig = plt.figure(figsize=(26, 17.5), dpi=110)
    outer = fig.add_gridspec(2, 1, height_ratios=[H, 64], left=0.01, right=0.995, top=0.955,
                             bottom=0.01, hspace=0.06)
    row0 = outer[0].subgridspec(1, 2, width_ratios=[W, W], wspace=0.03)
    row1 = outer[1].subgridspec(1, 2, width_ratios=[1.0, 1.25], wspace=0.02)
    ax_top, ax_bot = fig.add_subplot(row0[0]), fig.add_subplot(row0[1])
    ax_zoom, ax_leg = fig.add_subplot(row1[0]), fig.add_subplot(row1[1])
    ax_leg.axis("off")

    def board(ax, pour=None):
        ax.add_patch(mp.FancyBboxPatch((0, 0), W, H, boxstyle="round,pad=0,rounding_size=3",
                                       fc=pour or "#f4f1e8", ec="#222", lw=1.2, zorder=0))
        ax.set_xlim(-2, W + 2)
        ax.set_ylim(H + 2, -2)
        ax.set_aspect("equal")
        ax.axis("off")

    def rect(ax, bb, **kw):
        ax.add_patch(mp.Rectangle((bb[0], bb[1]), bb[2] - bb[0], bb[3] - bb[1], **kw))

    # ---- top view
    ax = ax_top
    board(ax, "#e6eef6")
    ax.set_title("TOP side (keys, display, piezo)  -  top copper: GND pour + 3V3 island", fontsize=13)
    ax.add_patch(mp.FancyBboxPatch(V33[:2], V33[2] - V33[0], V33[3] - V33[1],
                                   boxstyle="round,pad=0,rounding_size=1.5", fc="#ffd8d8",
                                   ec="#e08080", lw=0.8, alpha=0.8))
    ax.text(V33[0] + 1.0, V33[3] - 2.2, "3V3 pour (top):\nLDO -> module, codec;\ntrack on to J3 VCC",
            fontsize=7, color="#a03030")
    for p in parts.values():
        ref, (x, y) = p["ref"], p["at"]
        if "Hotswap" in p["fp"]:
            ax.add_patch(mp.Rectangle((x - 9.0, y - 9.0), 18, 18, fc="none", ec="#999", ls="--", lw=0.8))
            ax.add_patch(mp.Rectangle((x - 7.0, y - 7.0), 14, 14, fc="#fbfaf6", ec="#444", lw=1.0))
            label = {"SW15": "HOOK"}.get(ref, "")
            if not label:
                i = int(ref[2:]) - 3
                label = ["1", "2", "3", "4", "5", "MENU", "6", "7", "8", "9", "0", "BACK"][i]
            ax.text(x, y, f"{label}\n{ref}", ha="center", va="center", fontsize=9, color="#222")
        elif ref.startswith("H"):
            ax.add_patch(mp.Circle((x, y), 1.6, fc="white", ec="#333", lw=1))
            ax.text(x, y + 3.4, ref, ha="center", va="center", fontsize=7.5)
        elif p["side"] == "top" and ref == "J3":
            rect(ax, p["crt"], fc="#fff3c4", ec="#8a6d00", lw=1)
            ax.text((p["crt"][0] + p["crt"][2]) / 2, p["crt"][1] - 0.8, ref, ha="center", fontsize=8)
    bz = parts["BZ1"]
    cx = (bz["crt"][0] + bz["crt"][2]) / 2
    cy = (bz["crt"][1] + bz["crt"][3]) / 2
    ax.add_patch(mp.Circle((cx, cy), 6.1, fc="#fff3c4", ec="#8a6d00", lw=1))
    ax.text(cx, cy, "BZ1\npiezo 12 mm", ha="center", va="center", fontsize=8)
    x0 = parts["J3"]["pads"][0]["at"][0] - 1.93
    y0 = (parts["H5"]["at"][1] + parts["H6"]["at"][1]) / 2 - 18.75
    ax.add_patch(mp.Rectangle((x0, y0), 91.8, 37.5, fc="none", ec="#6a3d9a", ls="--", lw=1.4))
    ax.text(x0 + 46, y0 + 3.2, "WeAct 2.9\" e-paper module 91.8 x 37.5 (on J3 + standoffs H5, H6)",
            ha="center", fontsize=9, color="#6a3d9a")
    for g in ("G1", "G2"):
        rect(ax, parts[g]["crt"] if g == "G1" else [70, 50.5, 98, 53.5], fc="none", ec="#999", lw=0.6)
    ax.text(84, 47, "logo + \"Open Lounge Phone\" (silkscreen)", ha="center", fontsize=8, color="#555")
    led = parts["D2"]
    ax.add_patch(mp.Circle(tuple(led["at"]), 1.4, fc="#ff4d4d", ec="#900", lw=1))
    ax.text(led["at"][0] + 2.0, led["at"][1], "status LED\n(light hole)", fontsize=7.5, va="center")
    u1 = parts["U1"]
    ax.annotate("U.FL on the module (bottom side):\nantenna cable to the left wall", xy=(1.0, u1["at"][1] - 6),
                xytext=(7, 52), fontsize=7.5, arrowprops=dict(arrowstyle="->", lw=0.7))
    for ref, lbl in (("J1", "USB-C"), ("J2", "3.5 mm jack")):
        p = parts[ref]
        ax.annotate(lbl, xy=((p["crt"][0] + p["crt"][2]) / 2, 0), xytext=((p["crt"][0] + p["crt"][2]) / 2, -1.5),
                    ha="center", fontsize=7.5)

    # ---- bottom view (seen through the board from the top, not mirrored)
    def bottom(ax, zoom=False):
        board(ax, "#eaf0e6")
        for p in parts.values():
            if p["side"] != "bottom" and not any(q["hole"] for q in p["pads"]):
                continue
            ref = p["ref"]
            if p["side"] == "bottom" and not ref.startswith(("H", "G")):
                fc = "#dfe9f7" if not ref.startswith("SW") or ref in ("SW1", "SW2") else "#eeeeee"
                rect(ax, p["crt"], fc=fc, ec="#4a6fa5", lw=0.8)
            for q in p["pads"]:
                bb = q["bb"]
                if q["hole"]:
                    ax.add_patch(mp.Circle(tuple(q["at"]), max(q["drill"], 0.8) / 2,
                                           fc="#bbbbbb" if not q["net"] else "#d4a017", ec="#666", lw=0.4))
                elif p["side"] == "bottom":
                    col = "#d4a017"
                    rect(ax, bb, fc=col, ec="none")
            if p["side"] == "bottom" and not ref.startswith(("H", "G")):
                c = p["crt"]
                big = (c[2] - c[0]) > 8 or (c[3] - c[1]) > 8
                fs = (11 if big else 8) if zoom else (8 if big else 5.2)
                if ref.startswith("SW") and ref not in ("SW1", "SW2"):
                    tx, ty = (c[0] + c[2]) / 2, c[3] + 1.1
                else:
                    tx, ty = (c[0] + c[2]) / 2, (c[1] + c[3]) / 2
                ax.text(tx, ty, ref, ha="center", va="center", fontsize=fs, color="#102a54",
                        weight="bold", zorder=6)
        for n, pts, layer in lanes_:
            col = GROUPS[group_of(n)][0]
            xs, ys = zip(*pts)
            ax.plot(xs, ys, color=col, lw=(1.6 if zoom else 1.0), ls="--" if layer == "F" else "-",
                    alpha=0.9, zorder=5, solid_capstyle="round")

    ax_bot.set_title("BOTTOM side (all SMD, sockets) seen from the top, not mirrored  -  planned lanes",
                     fontsize=13)
    bottom(ax_bot)
    bottom(ax_zoom, zoom=True)
    ax_zoom.set_xlim(-1, 45)
    ax_zoom.set_ylim(57, -1)
    ax_zoom.set_title("bottom side, electronics band (zoom): jack, USB-C, codec, LDO, ringer, module",
                      fontsize=13)

    # legend + numbers
    handles = [mp.Patch(color=c, label=l) for c, l in GROUPS.values()]
    handles += [mp.Patch(fc="#ffd8d8", ec="#e08080", label="3V3 pour island (top, rear band)"),
                mp.Patch(fc="#e6eef6", label="GND pour (top, rest of the board)"),
                mp.Patch(fc="#eaf0e6", label="GND fill between tracks (bottom)")]
    ax_leg.legend(handles=handles, loc="upper left", ncol=2, fontsize=12, frameon=False)
    worst = max((g for c, _, _, g, dc in dec if dc), default=0.0)
    lines = [
        f"straight-line wiring (MST, GND/3V3 = pours): {total:.0f} mm",
        f"straight-line crossings: {len(pairs)}" + (f"  ({', '.join(f'{a} x {b}' for a, b in pairs)})" if pairs else ""),
        f"supply decoupling: worst cap-to-pin gap {worst:.2f} mm (goal <= 2 mm)",
        f"board {W:.0f} x {H:.0f} mm, 2 layers, every SMD part on the bottom",
        "dashed lane = top layer (passes under the module); lanes are planned, not routed",
    ]
    ax_leg.text(0.0, 0.42, "\n".join(lines), fontsize=12, va="top", family="monospace",
                transform=ax_leg.transAxes, wrap=True)
    fig.suptitle("Open Lounge Phone minimal board - M2 placement (unrouted)", fontsize=17, y=0.99)
    fig.savefig(path, facecolor="white")
    plt.close(fig)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--assign", action="store_true")
    ap.add_argument("--png", default=str(REVIEW / "placement.png"))
    a = ap.parse_args()
    d, parts, nets = load()
    if a.assign:
        assign(parts, nets)
        return 0
    total, segs, pairs = metrics(nets)
    dec = decoupling(parts)
    lines = [f"straight-line wiring length: {total:.1f} mm (MST per net, GND/3V3 excluded)",
             f"crossings: {len(pairs)}"]
    lines += [f"  {a} x {b}" for a, b in pairs]
    for cap, ic, pin, gap, is_dec in dec:
        lines.append(f"{'decoupling' if is_dec else 'reference '} {cap} -> {ic} pin {pin}: "
                     f"{gap:.2f} mm{'' if gap <= 2.0 else '  > 2 mm'}")
    (REVIEW / "placement-metrics.txt").write_text("\n".join(lines) + "\n")
    print("\n".join(lines))
    render(d, parts, nets, total, pairs, dec, Path(a.png))
    print(f"wrote {a.png}")
    bad = [c for c, _, _, g, dc in dec if dc and g > 2.0]
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
