"""Schematic review sheets (PDF) generated from the SKiDL netlist.

    ../.venv/bin/python review.py [--variant lounge] [--out ../build/review/schematic.pdf]

The schematic is code (board_main.py, ui.py), so there is no drawn sheet. This renders a
"net-label schematic" per subsystem instead: every IC/connector/switch is a box with its pin
numbers and names, and each pin's net name sits at the pin end (same name = connected, as with
net labels in KiCad). Passives, which make up most of the part count, are listed per subsystem
with the two nets they join. Page 1 is the block overview and the GPIO map (pin_table.yaml).

The lounge variant is the default because it fits the most parts; DNP parts are marked.
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

RAILS = {"GND", "3V3", "3V0", "VSYS", "VBUS", "VBUS_C", "VBAT", "VLED", "HS_VIN", "HS_VBUS"}

# Subsystems: anchor parts (by reference or SpecKey). Passives follow the anchor they touch
# through a non-rail net; the rest land in "Power" (rail-only decoupling).
BLOCKS = [
    ("Power in: USB-C sink, protection, charger, 3V3 buck, 3V0 LDO, battery, supercap",
     {"J1", "D1", "D2", "F1", "D3", "U2", "U3", "L1", "U4", "J2", "U14", "D4"}, {"SUPERCAP"}),
    ("MCU: ESP32-S3-WROOM-1U, reset/boot, USB-UART (CH340C), LED-data buffer, secure element",
     {"U1", "SW1", "SW2", "U16", "Q5", "Q6", "U5", "U13"}, set()),
    ("Audio: ES8311 DAC, ES7210 ADC, NS4150B amp, base mic, mic bias + privacy sense",
     {"U6", "U7", "U9", "J4", "MK1", "Q1"}, {"FB220_2A"}),
    ("Handset port: USB-C host (UAC), VBUS switch, ESD", {"J7", "D7", "U15", "D8", "D9"}, set()),
    ("Sensors and radar: hall hook, IR hook option, accelerometer, LD2410C",
     {"U10", "U11", "U12", "Q4", "J5", "Q2", "Q3"}, set()),
    ("Side controls: VOL-, VOL+, MUTE (+ ESD)", {"SW3", "SW4", "SW5", "D5"}, set()),
    ("Keys and LEDs: AW9523B, 12 hot-swap keys, 13 SK6812MINI-E, LED power gate",
     {"U17"}, {"HOTSWAP", "SK6812MINI-E", "AO3401A", "AO3400A"}),
    ("E-ink strip: 24-pin FPC + SSD1680 boost (DNP on display = none)",
     {"J6"}, {"L47u", "EPD_NFET", "MBR0530"}),
    ("NFC tag, ambient light, privacy LED, Qwiic port", {"U18", "U19", "J3"},
     {"NFC_COIL", "LED_RED"}),
]


def load_pin_names() -> dict:
    """SpecKey -> {pin number: pin name} from parts.py (imports SKiDL)."""
    import parts  # noqa: F401
    from lib import SPECS

    return {k: {str(n): name for n, name, _ in s.pins} for k, s in SPECS.items()}


def is_passive(c) -> bool:
    return re.match(r"([A-Z]+)", c.ref).group(1) in ("R", "C", "TP", "NT", "JP", "SJ")


def assign(net: nl.Netlist) -> dict:
    """ref -> block index."""
    out = {}
    pin_net = net.pin_net()
    for ref, c in net.comps.items():
        key = c.fields.get("SpecKey", "")
        for i, (_, refs, keys) in enumerate(BLOCKS):
            if ref in refs or key in keys:
                out[ref] = i
                break
    # the LED gate FETs live in ui.py but AO3400A is also used elsewhere: pin anchors win above;
    # passives and leftovers: follow a non-rail net to an assigned part
    for _ in range(3):
        for ref, c in net.comps.items():
            if ref in out:
                continue
            nets = [n for (r, p), n in pin_net.items() if r == ref and n not in RAILS]
            for n in nets:
                owners = {out[r] for r, _ in net.nets[n] if r in out and r != ref}
                if owners:
                    out[ref] = min(owners)
                    break
    for ref in net.comps:
        out.setdefault(ref, 0)
    return out


def sort_key(ref):
    m = re.match(r"([A-Z]+)(\d+)", ref)
    return (m.group(1), int(m.group(2))) if m else (ref, 0)


def draw_box(ax, x, y, c, pins, pin_net, width=2.2):
    """IC box at (x, y) top-left (inches); pins split left/right. Returns height used."""
    n = len(pins)
    half = (n + 1) // 2
    left, right = pins[:half], pins[half:]
    row = 0.115
    h = max(half, len(right)) * row + 0.35
    ax.add_patch(Rectangle((x, y - h), width, h, fill=False, lw=0.8))
    title = f"{c.ref}  {c.value}" + ("  (DNP)" if c.dnp else "")
    ax.text(x + width / 2, y + 0.06, title, ha="center", va="bottom", fontsize=6.5,
            weight="bold", color="#999" if c.dnp else "black")
    for i, (num, name) in enumerate(left):
        yy = y - 0.25 - i * row
        netn = pin_net.get((c.ref, num), "(nc)")
        ax.plot([x - 0.12, x], [yy, yy], lw=0.5, color="k")
        ax.text(x + 0.04, yy, f"{num} {name}", fontsize=4.8, va="center")
        ax.text(x - 0.14, yy, netn, fontsize=4.8, va="center", ha="right",
                color="#1f4e9a" if netn not in RAILS else "#a33")
    for i, (num, name) in enumerate(right):
        yy = y - 0.25 - i * row
        netn = pin_net.get((c.ref, num), "(nc)")
        ax.plot([x + width, x + width + 0.12], [yy, yy], lw=0.5, color="k")
        ax.text(x + width - 0.04, yy, f"{name} {num}", fontsize=4.8, va="center", ha="right")
        ax.text(x + width + 0.14, yy, netn, fontsize=4.8, va="center",
                color="#1f4e9a" if netn not in RAILS else "#a33")
    return h


PAGE = (16.54, 11.69)   # A3 landscape, inches


def new_page(pdf, title, sub=""):
    fig = plt.figure(figsize=PAGE)
    ax = fig.add_axes([0, 0, 1, 1])
    ax.set_xlim(0, PAGE[0])
    ax.set_ylim(0, PAGE[1])
    ax.axis("off")
    ax.text(0.4, PAGE[1] - 0.45, title, fontsize=13, weight="bold", va="top")
    if sub:
        ax.text(0.4, PAGE[1] - 0.78, sub, fontsize=7.5, va="top", color="#444")
    ax.text(PAGE[0] - 0.4, 0.25, "Open Lounge Phone r0.1 - generated from the SKiDL netlist "
            "(hardware/schematic/review.py). Blue = signal net, red = supply rail; same name = "
            "connected.", fontsize=6, ha="right", color="#666")
    return fig, ax


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--variant", default="lounge")
    ap.add_argument("--out", default=str(HW / "build" / "review" / "schematic.pdf"))
    a = ap.parse_args()
    net = nl.read(HW / "build" / "main" / "main.net")
    names = load_pin_names()
    pin_net = net.pin_net()
    blocks = assign(net)
    out = Path(a.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    pins_of = {}
    for ref, c in net.comps.items():
        key = c.fields.get("SpecKey", "")
        pmap = names.get(key, {})
        nums = sorted({p for r, p in pin_net if r == ref} | set(pmap),
                      key=lambda p: (not p.isdigit(), int(p) if p.isdigit() else 0, p))
        pins_of[ref] = [(p, pmap.get(p, "")) for p in nums]

    with PdfPages(out) as pdf:
        # ---- page 1: overview + GPIO map
        fig, ax = new_page(pdf, "Open Lounge Phone - schematic review (single board, "
                           f"variant {a.variant})",
                           "One 180 x 88 mm 4-layer board (owner decision 2026-09-27). Pages 2+: "
                           "one sheet per subsystem; ICs as boxes with net labels, then the "
                           "passives of that subsystem.")
        y = PAGE[1] - 1.3
        ax.text(0.4, y, "Subsystems", fontsize=10, weight="bold")
        count = defaultdict(int)
        for ref in net.comps:
            count[blocks[ref]] += 1
        for i, (title, _, _) in enumerate(BLOCKS):
            y -= 0.28
            ax.text(0.5, y, f"{i + 2:>2}.  {title}  ({count[i]} parts)", fontsize=8)
        y -= 0.5
        ax.text(0.4, y, "Rails", fontsize=10, weight="bold")
        for line in [
            "USB-C VBUS_C -> PTC F1 -> VBUS (TVS D3) -> BQ24074 U2 -> VSYS 4.4 V (battery "
            "B-option on VBAT, supercap on SCAP for Lounge)",
            "VSYS -> TLV62569 buck U3 -> 3V3 (digital, ESP32, sensors) ; VSYS -> LP5907 U4 -> 3V0 "
            "(codecs, mic bias)",
            "VSYS -> P-FET gate -> VLED (13 x SK6812MINI-E) ; VBUS/VSYS diode-OR -> HS_VIN -> "
            "SY6280 U15 -> HS_VBUS (handset)",
        ]:
            y -= 0.26
            ax.text(0.5, y, line, fontsize=7.5)
        pt = yaml.safe_load((HERE / "pin_table.yaml").read_text())
        gp = pt.get("gpio") or {}
        ax.text(8.6, PAGE[1] - 1.3, "ESP32-S3 GPIO map (pin_table.yaml)", fontsize=10,
                weight="bold")
        yy = PAGE[1] - 1.55
        for g in sorted(gp, key=lambda k: int(k) if str(k).isdigit() else 999):
            e = gp[g]
            note = e.get("note", "") if isinstance(e, dict) else ""
            netn = str((e.get("net") if isinstance(e, dict) else e) or "(unconnected)")
            ax.text(8.7, yy, f"GPIO{g:<3} {netn:<16} {note}"[:110], fontsize=6.3,
                    family="monospace")
            yy -= 0.19
        pdf.savefig(fig)
        plt.close(fig)

        # ---- one or more pages per block
        for i, (title, _, _) in enumerate(BLOCKS):
            refs = sorted([r for r in net.comps if blocks[r] == i], key=sort_key)
            ics = [r for r in refs if not is_passive(net.comps[r])]
            pas = [r for r in refs if is_passive(net.comps[r])]
            # collapse repeated identical parts (keys, LEDs) after the first two
            shown, seen = [], defaultdict(int)
            for r in ics:
                k = net.comps[r].fields.get("SpecKey", "")
                seen[k] += 1
                if k in ("HOTSWAP", "SK6812MINI-E") and seen[k] > 2:
                    continue
                shown.append(r)
            reps = {k: n for k, n in seen.items() if k in ("HOTSWAP", "SK6812MINI-E") and n > 2}
            fig, ax = new_page(pdf, f"{i + 2}. {title}")
            x, y, col_h = 1.6, PAGE[1] - 1.3, 0.0
            colw = 4.1
            for r in shown:
                pins = pins_of[r]
                h = (len(pins) + 1) // 2 * 0.115 + 0.35
                if y - h < 0.6:
                    x += colw
                    y = PAGE[1] - 1.3
                if x + colw > PAGE[0]:
                    pdf.savefig(fig)
                    plt.close(fig)
                    fig, ax = new_page(pdf, f"{i + 2}. {title} (cont.)")
                    x, y = 1.6, PAGE[1] - 1.3
                used = draw_box(ax, x, y, net.comps[r], pins, pin_net)
                y -= used + 0.45
            if reps:
                txt = "; ".join(f"{n} x {k} in total (2 drawn): see the passives/refs list"
                                for k, n in reps.items())
                ax.text(0.4, 0.55, txt, fontsize=7, color="#444")
                lines = []
                for k in reps:
                    rs = [r for r in ics if net.comps[r].fields.get("SpecKey") == k]
                    for r in rs:
                        lines.append(f"{r}: " + ", ".join(
                            f"{p}={pin_net.get((r, p), 'nc')}" for p, _ in pins_of[r]))
                pdf.savefig(fig)
                plt.close(fig)
                fig, ax = new_page(pdf, f"{i + 2}. {title}: every repeated part")
                yy = PAGE[1] - 1.2
                for ln in lines:
                    ax.text(0.5, yy, ln[:200], fontsize=6.3, family="monospace")
                    yy -= 0.2
            pdf.savefig(fig)
            plt.close(fig)
            if pas:
                fig, ax = new_page(pdf, f"{i + 2}. {title}: passives and test points")
                yy, xx = PAGE[1] - 1.2, 0.5
                for r in pas:
                    c = net.comps[r]
                    ns = [pin_net.get((r, p), "nc") for p, _ in pins_of[r]]
                    note = c.description[:60] if c.description else ""
                    ln = f"{r:<6} {c.value[:14]:<14} {' - '.join(ns)[:52]:<52}" + \
                         (" DNP" if c.dnp else "    ")
                    ax.text(xx, yy, ln, fontsize=6.0, family="monospace",
                            color="#999" if c.dnp else "black")
                    yy -= 0.17
                    if yy < 0.6:
                        yy, xx = PAGE[1] - 1.2, xx + 8.0
                        if xx > PAGE[0] - 7:
                            pdf.savefig(fig)
                            plt.close(fig)
                            fig, ax = new_page(pdf, f"{i + 2}. {title}: passives (cont.)")
                            yy, xx = PAGE[1] - 1.2, 0.5
                pdf.savefig(fig)
                plt.close(fig)
    print(f"wrote {out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
