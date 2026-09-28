"""Pin assignment that follows the geometry (KiCad Python): swap ESP32 GPIOs and AW9523B ports
where it is electrically free, so each signal leaves its IC on the side facing what it
connects to and the buses fan out in order.

    python pinswap.py [board.kicad_pcb] [--out pinswap.json]

Only ICs and connectors count (passives are re-placed next to whatever pin they end up on);
a series resistor is looked through (LD_TX -> 1k -> radar socket counts as LD_TX -> socket).
Cost = 5 x crossings + wiring length of the signal nets in bus / daisy-chain order
(metrics.signal_chains). Pairwise swaps until nothing improves (deterministic).

Rules (schematic/pin_table.yaml, GUIDELINES §2): straps (GPIO0/3/45/46), octal PSRAM
(35-37), native USB (19/20) and UART0 (43/44, ROM download) stay; analog
nets stay on ADC1 (GPIO1-10); deep-sleep wake nets stay on RTC GPIOs (0-21). AW9523B:
LED_PWR_EN needs a push-pull output, so it stays on port 1; keys and side controls are
plain inputs and may use any port.
The result is written back by hand into schematic/pin_table.yaml, board_main.PIN_TABLE and
ui.AW_PORTS (then `make build` checks it).
"""

from __future__ import annotations

import argparse
import json
import math
import sys

import kienv  # noqa: F401
from kienv import KICAD_OUT

import pcbnew

import metrics as M

# WROOM-1(U) pad -> GPIO
ESP_PAD = {39: 1, 38: 2, 4: 4, 5: 5, 6: 6, 7: 7, 8: 15, 9: 16, 10: 17, 11: 18, 12: 8, 17: 9, 18: 10, 19: 11,
           20: 12, 21: 13, 22: 14, 23: 21, 24: 47, 25: 48, 31: 38, 32: 39, 33: 40, 34: 41,
           35: 42}
ADC1 = set(range(1, 11))
RTC = set(range(0, 22))
NEEDS_ADC1 = {"HS_VBUS_SENSE", "CC1_SENSE", "CC2_SENSE"}
NEEDS_RTC = {"HOOK", "LD_OUT", "IRQ"}
# AW9523B pad -> port
AW_PAD = {1: "P1_0", 2: "P1_1", 3: "P1_2", 4: "P1_3", 5: "P0_0", 6: "P0_1", 7: "P0_2",
          8: "P0_3", 10: "P0_4", 11: "P0_5", 12: "P0_6", 13: "P0_7", 14: "P1_4", 15: "P1_5",
          16: "P1_6", 17: "P1_7"}
PASSIVE = ("R", "C", "FB", "TP", "NT", "H", "G")


def allowed(group, pad, net):
    if group == "U1":
        g = ESP_PAD[pad]
        return (net not in NEEDS_ADC1 or g in ADC1) and (net not in NEEDS_RTC or g in RTC)
    return net != "LED_PWR_EN" or AW_PAD[pad].startswith("P1_")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("pcb", nargs="?", default=str(KICAD_OUT / "main" / "main.kicad_pcb"))
    ap.add_argument("--out", default="pinswap.json")
    a = ap.parse_args()
    board = pcbnew.LoadBoard(a.pcb)
    planes = M.plane_nets(board) | {"VBUS", "VBAT", "HS_VIN", "HS_VBUS", "VLED", "SCAP"}
    pads = []            # (net, x, y, ref, padnum) for ICs / connectors
    series = {}          # net -> other nets reached through a 2-pin series R
    for fp in board.GetFootprints():
        ref = fp.GetReference()
        ps = [p for p in fp.Pads() if p.GetNetname()]
        if ref.startswith(PASSIVE):
            nets = {p.GetNetname() for p in ps}
            if ref.startswith("R") and len(nets) == 2 and not nets & planes and "GND" not in nets:
                n1, n2 = sorted(nets)
                series.setdefault(n1, set()).add(n2)
                series.setdefault(n2, set()).add(n1)
            continue
        for p in ps:
            n = p.GetNetname()
            if n.startswith("unconnected-"):
                continue
            pads.append([n, p.GetPosition().x / 1e6, p.GetPosition().y / 1e6, ref, p.GetNumber()])
    group_pads = {("U1", k) for k in ESP_PAD} | {("U17", k) for k in AW_PAD}
    idx = {(p[3], int(p[4])): i for i, p in enumerate(pads) if p[4].isdigit()
           and (p[3], int(p[4])) in group_pads}

    def cost():
        by = {}
        for n, x, y, ref, _ in pads:
            if n in planes or n == "GND":
                continue
            by.setdefault(n, []).append((x, y, ref))
        eff = {}
        for n, pts in by.items():  # look through series resistors
            extra = [q for m in series.get(n, ()) for q in by.get(m, []) if len(by.get(n, [])) < 3]
            eff[n] = pts + extra
        chains = {n: M.chain(pts) for n, pts in eff.items()}
        length = sum(v for v, _ in chains.values())
        cr = M.crossings({n: e for n, (_, e) in chains.items()})
        return 5 * cr + length, cr, length

    best, cr0, len0 = cost()
    print(f"start: {cr0} crossings, {len0:.0f} mm (IC/connector pins, series R looked through)")
    keys = sorted(idx)
    improved = True
    sweeps = 0
    while improved and sweeps < 8:
        improved, sweeps = False, sweeps + 1
        for i, ka in enumerate(keys):
            for kb in keys[i + 1:]:
                if ka[0] != kb[0]:
                    continue
                pa, pb = pads[idx[ka]], pads[idx[kb]]
                if not (allowed(ka[0], ka[1], pb[0]) and allowed(kb[0], kb[1], pa[0])):
                    continue
                pa[0], pb[0] = pb[0], pa[0]
                c, cr, ln = cost()
                if c < best - 1e-6:
                    best, improved = c, True
                else:
                    pa[0], pb[0] = pb[0], pa[0]
        _, cr, ln = cost()
        print(f"sweep {sweeps}: {cr} crossings, {ln:.0f} mm")
    out = {"U1": {}, "U17": {}}
    for (ref, pad), i in sorted(idx.items()):
        n = pads[i][0]
        if ref == "U1":
            out["U1"][f"GPIO{ESP_PAD[pad]}"] = n
        else:
            out["U17"][AW_PAD[pad]] = n
    with open(a.out, "w") as f:
        json.dump(out, f, indent=1, sort_keys=True)
    print(json.dumps(out, indent=1, sort_keys=True))
    return 0


if __name__ == "__main__":
    sys.exit(main())
