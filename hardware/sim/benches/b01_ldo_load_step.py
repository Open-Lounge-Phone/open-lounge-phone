"""B01: SGM2212-3.3 3V3 rail: USB hot-plug start-up vs the EN delay, and the ESP32 Wi-Fi TX
burst load step at the lowest USB voltage, with the board's real capacitors."""

from __future__ import annotations

import numpy as np

from benchlib import Bench, Ctx, si, window

TITLE = "3V3 LDO: start-up vs EN, Wi-Fi burst load step, dropout at low VBUS"

# Board values (schematic/board_main.py). Effective MLCC capacitance at DC bias (assumption):
# 0603 10 uF/10 V at 5 V ~ 45 %, 0603 2.2 uF/16 V at 3.3 V ~ 70 %, 0805 22 uF/25 V at 3.3 V
# ~ 55 %, 1 uF/100 nF ~ 85 %.
C_IN = 10e-6 * 0.45
C_OUT_LDO = 2.2e-6 * 0.70
C_MODULE = 22e-6 * 0.55 + 0.1e-6 * 0.85
C_OTHER = (1e-6 * 0.85) + 2 * 0.1e-6 * 0.85   # ES8311 AVDD 1 uF, PVDD/DVDD 100 nF
TRACE_R = 0.02            # LDO -> module 3V3 pin
V_MIN, V_MAX = 3.0, 3.6   # ESP32-S3-WROOM-1 VDD33, datasheet v1.8 p27
I_IDLE, I_BURST = 0.060, 0.355 + 0.045   # TX 802.11b 20.5 dBm 355 mA (p28) + codec/display


def netlist(vbus: float, r_cable: float, gm: float, load: str, fp: float = 300e3) -> str:
    return f"""
Vsrc src 0 PWL(0 0 100u {vbus})
Rcab src vbus_c {r_cable}
Lcab vbus_c vbus 1u
Cin vbus 0 {C_IN}
X1 vbus v3 0 SGM2212_BEH PARAMS: GM={gm} FP={fp}
Cout v3 0 {C_OUT_LDO}
Rtr v3 vm {TRACE_R}
Cmod vm 0 {C_MODULE}
Coth v3 0 {C_OTHER}
Iload vm 0 {load}
* ESP32 EN: 10 k to 3V3, 1 uF to GND (WROOM-1 p41)
Ren vm en 10k
Cen en 0 1u
"""


def run(ctx: Ctx) -> Bench:
    b = Bench("b01", TITLE,
              provenance=[
                  "SGM2212_BEH (models/olp_behavioural.lib), built from SG Micro SGM2212 rev A.2: "
                  "output 3.251-3.349 V (p5), dropout 380 mV max at 500 mA (p6), current limit "
                  ">= 810 mA (p6), load-transient plot p7 (~160 mV for ~800 mA with 10 uF) -> "
                  "GM ~ 5 A/V. SG Micro publishes no SPICE model.",
                  "Load: ESP32-S3-WROOM-1 TX peak 355 mA (datasheet v1.8 p28) + 45 mA codec, "
                  "earpiece and display; VDD33 window 3.0-3.6 V (p27).",
              ],
              assumptions=[
                  "VBUS 4.40 V at the receptacle (USB 2.0 low-power port minimum) and a 5.0 V "
                  "source behind a 0.3 ohm / 1 uH cable (hot-plug).",
                  "Effective MLCC capacitance after DC bias: 10 uF@5 V 45 %, 2.2 uF 70 %, "
                  "22 uF 55 %; 20 mohm LDO-to-module trace.",
                  "Loop GM 5 A/V (from p7) with a 300 kHz loop pole, and a pessimistic corner "
                  "GM 2.5 A/V with a 100 kHz pole; VREF at the low accuracy limit 3.251 V for "
                  "the dip checks.",
              ])

    # 1) hot-plug start-up: 3V3 must be inside the window before EN releases the chip
    load = f"PWL(0 0 1m 0 1.001m {I_IDLE})"
    r = ctx.sim("b01", "startup", netlist(5.0, 0.3, 5, load).replace(
        "SGM2212_BEH PARAMS: GM=5", "SGM2212_BEH PARAMS: GM=5 VREF=3.3"),
        "tran 1u 30m 0 1u", ["v(vm)", "v(en)"])
    t_ok = r["x"][np.argmax(r["v(vm)"] > V_MIN)]
    t_en = r["x"][np.argmax(r["v(en)"] > 0.75 * 3.3)]   # VIH_nRST = 0.75 VDD (p28)
    b.add("3V3 inside 3.0 V before EN releases the chip", f"3V3 at {si(t_ok, 's')}, EN at "
          f"{si(t_en, 's')}", "3V3 first (tSU >= 0, WROOM-1 p14)", bool(t_ok < t_en))
    vmax = float(r["v(vm)"].max())
    b.add("3V3 overshoot at hot-plug", f"{vmax:.3f} V", f"<= {V_MAX} V", vmax <= V_MAX)

    # 2) Wi-Fi TX burst at the lowest VBUS, nominal and pessimistic loop gain
    burst = (f"PWL(0 {I_IDLE} 2m {I_IDLE} 2.001m {I_BURST} 3m {I_BURST} 3.001m {I_IDLE} "
             f"4m {I_IDLE})")
    for gm, fp in ((5, 300e3), (2.5, 100e3)):
        net = netlist(4.40, 0.0, gm, burst, fp).replace(
            f"SGM2212_BEH PARAMS: GM={gm}", f"SGM2212_BEH PARAMS: GM={gm} VREF=3.251")
        r = ctx.sim("b01", f"burst_gm{gm}", net, "tran 0.1u 4m 0 0.1u", ["v(vm)", "v(vbus)"])
        v = window(r, "v(vm)", 1.5e-3, 4e-3)
        lo, hi = float(v.min()), float(v.max())
        b.add(f"3V3 at the module during a {si(I_IDLE, 'A')} -> {si(I_BURST, 'A')} burst, VBUS "
              f"4.40 V, GM {gm} A/V, loop pole {si(fp, 'Hz')}", f"{lo:.3f}-{hi:.3f} V", f"{V_MIN}-{V_MAX} V",
              lo >= V_MIN and hi <= V_MAX)
        head = float(window(r, "v(vbus)", 2.5e-3, 2.9e-3).mean()) - float(
            window(r, "v(vm)", 2.5e-3, 2.9e-3).mean())
        if gm == 5:
            b.add("LDO headroom during the burst (VIN - 3V3)", f"{head * 1000:.0f} mV",
                  ">= 380 mV (dropout max at 500 mA, p6)", head >= 0.38)
    return b
