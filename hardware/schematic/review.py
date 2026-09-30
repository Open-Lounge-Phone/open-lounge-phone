"""Readable schematic PDF generated from the SKiDL netlist: `make review`.

    ../.venv/bin/python review.py [--out ../build/review/schematic.pdf]

The schematic is code (board_main.py), so there is no drawn sheet. This renders a
"net-label schematic": page 1 is the overview (blocks, power tree, GPIO map); then one page per
block (board_main.build: power, mcu, keys, audio, ui). Every IC/connector/switch is a box with
its pin numbers and names, and each pin's net name sits at the pin end (same name = connected,
as with net labels in KiCad). Repeated parts (the 13 hot-swap sockets) are a table. The
passives of the block are listed on the right with the two nets they join and their note.
"""

from __future__ import annotations

import argparse
import re
import sys
from collections import defaultdict
from pathlib import Path

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402
import yaml  # noqa: E402
from matplotlib.backends.backend_pdf import PdfPages  # noqa: E402
from matplotlib.patches import Rectangle  # noqa: E402

HERE = Path(__file__).resolve().parent
HW = HERE.parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HW / "layout"))

import netlist as nl  # noqa: E402

RAILS = {"GND", "3V3", "VBUS"}
BLOCKS = [
    ("power", "Power: USB-C (5 V sink + native USB), USB ESD, SGM2212 3.3 V LDO"),
    ("mcu", "MCU: ESP32-S3-WROOM-1U-N16R8, EN reset, RESET and BOOT buttons"),
    ("keys", "Keys and hook: 13 MX hot-swap sockets, one GPIO each (internal pull-ups)"),
    ("audio", "Audio: ES8311 codec + 3.5 mm TRRS handset jack (CTIA)"),
    ("ui", "Display header, piezo ringer, status LED, board marking, mounting holes"),
]
PAGE = (16.54, 11.69)   # A3 landscape, inches
REPEATED = {"HOTSWAP"}


def load_pin_names() -> dict:
    import parts  # noqa: F401
    from lib import SPECS

    return {k: {str(n): name for n, name, _ in s.pins} for k, s in SPECS.items()}


def is_passive(c) -> bool:
    return re.match(r"([A-Z]+)", c.ref).group(1) in ("R", "C")


def sort_key(ref):
    m = re.match(r"([A-Z]+)(\d+)", ref)
    return (m.group(1), int(m.group(2))) if m else (ref, 0)


def color(netn: str) -> str:
    return "#a33" if netn in RAILS else ("#888" if netn == "(nc)" else "#1f4e9a")


def draw_box(ax, x, y, c, pins, pin_net, width=2.3):
    """IC box at (x, y) top-left (inches); pins split left/right. Returns height used."""
    half = (len(pins) + 1) // 2
    left, right = pins[:half], pins[half:]
    row = 0.13
    h = max(half, len(right), 1) * row + 0.3
    ax.add_patch(Rectangle((x, y - h), width, h, fill=False, lw=0.8))
    ax.text(x + width / 2, y + 0.06, f"{c.ref}  {c.value}", ha="center", va="bottom",
            fontsize=7, weight="bold")
    for side, group in ((0, left), (1, right)):
        for i, (num, name) in enumerate(group):
            yy = y - 0.22 - i * row
            netn = pin_net.get((c.ref, num), "(nc)")
            if side == 0:
                ax.plot([x - 0.12, x], [yy, yy], lw=0.5, color="k")
                ax.text(x + 0.04, yy, f"{num} {name}", fontsize=5.5, va="center")
                ax.text(x - 0.14, yy, netn, fontsize=5.5, va="center", ha="right",
                        color=color(netn))
            else:
                ax.plot([x + width, x + width + 0.12], [yy, yy], lw=0.5, color="k")
                ax.text(x + width - 0.04, yy, f"{name} {num}", fontsize=5.5, va="center",
                        ha="right")
                ax.text(x + width + 0.14, yy, netn, fontsize=5.5, va="center", color=color(netn))
    return h


def new_page(title, sub=""):
    fig = plt.figure(figsize=PAGE)
    ax = fig.add_axes([0, 0, 1, 1])
    ax.set_xlim(0, PAGE[0])
    ax.set_ylim(0, PAGE[1])
    ax.axis("off")
    ax.text(0.4, PAGE[1] - 0.45, title, fontsize=14, weight="bold", va="top")
    if sub:
        ax.text(0.4, PAGE[1] - 0.8, sub, fontsize=8, va="top", color="#444")
    ax.text(PAGE[0] - 0.4, 0.25, "Open Lounge Phone minimal board (M1) - generated from the "
            "SKiDL netlist by hardware/schematic/review.py. Blue = signal net, red = supply "
            "rail; same name = connected. CERN-OHL-S-2.0.", fontsize=6.5, ha="right",
            color="#666")
    return fig, ax


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=str(HW / "build" / "review" / "schematic.pdf"))
    a = ap.parse_args()
    net = nl.read(HW / "build" / "main" / "main.net")
    names = load_pin_names()
    pin_net = net.pin_net()
    out = Path(a.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    pins_of = {}
    for ref, c in net.comps.items():
        pmap = names.get(c.fields.get("SpecKey", ""), {})
        nums = sorted({p for r, p in pin_net if r == ref} | set(pmap),
                      key=lambda p: (not p.isdigit(), int(p) if p.isdigit() else 0, p))
        pins_of[ref] = [(p, pmap.get(p, "")) for p in nums]
    by_block = defaultdict(list)
    for ref, c in net.comps.items():
        by_block[c.fields.get("Block", "")].append(ref)

    from config import DESIGN

    with PdfPages(out) as pdf:
        # ---- page 1: overview
        w, h = DESIGN.board_mm
        fig, ax = new_page("Open Lounge Phone - minimal board, schematic review",
                           f"{DESIGN.layers}-layer board, proposed {w:.0f} x {h:.0f} mm. Pages "
                           "2-6: one page per block. Hardware docs: hardware/DESIGN.md.")
        y = PAGE[1] - 1.3
        ax.text(0.4, y, "Blocks", fontsize=11, weight="bold")
        for i, (key, title) in enumerate(BLOCKS):
            refs = by_block[key]
            bom = [r for r in refs if net.comps[r].fields.get("BOM") != "exclude"]
            y -= 0.3
            ax.text(0.5, y, f"{i + 2}.  {title}  ({len(bom)} parts)", fontsize=8.5)
        y -= 0.55
        ax.text(0.4, y, "Power tree", fontsize=11, weight="bold")
        for line in [
            "USB-C J1 VBUS (5 V, 5.1k Rd on CC1/CC2 = USB default power, no PD) -> 10 uF",
            "  -> SGM2212-3.3 U2 (800 mA LDO) -> 3V3: ESP32 module, ES8311, display module, "
            "mic bias, pull-ups, LED",
            "  -> piezo ringer BZ1 (through Q1, from VBUS directly)",
            "USB-C D+/D- -> USBLC6-2SC6 D1 -> ESP32 native USB (IO19/IO20): flashing + console",
            "No fuse (compliant USB sources current-limit), no battery, one regulator.",
        ]:
            y -= 0.27
            ax.text(0.5, y, line, fontsize=8)
        pt = yaml.safe_load((HERE / "pin_table.yaml").read_text())["gpio"]
        ax.text(8.6, PAGE[1] - 1.3, "ESP32-S3 GPIO map (pin_table.yaml)", fontsize=11,
                weight="bold")
        yy = PAGE[1] - 1.58
        for g in sorted(pt):
            e = pt[g]
            netn = str(e.get("net") or "(unconnected)")
            ax.text(8.7, yy, f"GPIO{g:<3} {netn:<12} {e.get('note', '')}"[:112], fontsize=6.4,
                    family="monospace")
            yy -= 0.205
        pdf.savefig(fig)
        plt.close(fig)

        # ---- one page per block
        for i, (key, title) in enumerate(BLOCKS):
            refs = sorted(by_block[key], key=sort_key)
            comps = [r for r in refs if not is_passive(net.comps[r])]
            pas = [r for r in refs if is_passive(net.comps[r])]
            fig, ax = new_page(f"{i + 2}. {title}")
            x, y = 1.9, PAGE[1] - 1.35
            reps = [r for r in comps if net.comps[r].fields.get("SpecKey") in REPEATED]
            items = [r for r in comps if r not in reps]
            for r in items:
                pins = pins_of[r]
                if not pins:  # pinless: mounting holes, silkscreen marking
                    continue
                hh = max((len(pins) + 1) // 2, 1) * 0.13 + 0.3
                if y - hh < 0.7:
                    x, y = x + 4.3, PAGE[1] - 1.35
                y -= draw_box(ax, x, y, net.comps[r], pins, pin_net) + 0.5
            pinless = [r for r in items if not pins_of[r]]
            if pinless:
                ax.text(x - 1.5, max(y, 0.9), "No-pin items (layout only): " + ", ".join(
                    f"{r} {net.comps[r].value}" for r in pinless), fontsize=7, color="#444")
            if reps:
                ax.text(0.5, PAGE[1] - 1.35, "Socket  pin 1 net     pin 2 net   note",
                        fontsize=8, family="monospace", weight="bold")
                yy = PAGE[1] - 1.6
                for r in reps:
                    c = net.comps[r]
                    ns = [pin_net.get((r, p), "nc") for p, _ in pins_of[r]]
                    ax.text(0.5, yy, f"{r:<7} {ns[0]:<13} {ns[1]:<11} {c.fields.get('Note', '')}",
                            fontsize=8, family="monospace")
                    yy -= 0.24
            if pas:
                xx, yy = 9.3, PAGE[1] - 1.35
                ax.text(xx, yy, "Passives  (ref, value, nets, note)", fontsize=9, weight="bold")
                yy -= 0.28
                for r in pas:
                    c = net.comps[r]
                    ns = " - ".join(pin_net.get((r, p), "nc") for p, _ in pins_of[r])
                    ax.text(xx, yy, f"{r:<5} {c.value[:14]:<14} {ns[:26]:<26} "
                                    f"{c.fields.get('Note', '')[:62]}", fontsize=6.6,
                            family="monospace")
                    yy -= 0.2
            pdf.savefig(fig)
            plt.close(fig)
    print(f"wrote {out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
