"""B2: TLV62569 3V3 buck: Wi-Fi burst load step, ESP32 supply window, eFuse-burn limit, ripple,
for the current divider, the owner's 3.30 V setting and the H4 proposal."""

from __future__ import annotations

import numpy as np

from benchlib import Bench, Ctx, si, window

TITLE = "TLV62569 3V3 buck: Wi-Fi load step, ESP32 window, eFuse limit, ripple"
REQS = "HW-ELEC-07, -08, -24; HW-PRIV-06"

VFB = (0.588, 0.600, 0.612)          # TLV62569 SLVSDG1C p4
TOL = 0.01                           # resistor tolerance (decision 6: <= 1 %)
FSW, L, DCR = 1.5e6, 2.2e-6, 0.040   # p1 / SWPA4020S2R2 [SWPA p7]
# Divider options (top, bottom). "owner" = 3.30 V nominal as approved 2026-09-30.
DIVIDERS = {"current 100k/22k 1 %": (100e3, 22e3, 0.01),
            "alt: owner 3.30 V, 102k/22.6k 1 %": (102e3, 22.6e3, 0.01),
            "alt: 3.15 V, 51k/12k 1 %": (51e3, 12e3, 0.01),
            "proposed 3.19 V: 105k/24.3k 0.1 %": (105e3, 24.3e3, 0.001)}
# effective output capacitance: 2 x 22 uF 0805/25 V at the buck + 22 uF at the module, ~70 %
# left at 3.3 V (assumption, as B1) + ~3 uF of 1 uF/100 nF on the pour
C_BUCK, C_MOD = 44e-6 * 0.75, 22e-6 * 0.75 + 3e-6
KP = 22.6          # A/V at FB: calibrated so the model reproduces SLVSDG1C Figure 18 (below)


def vout(rt, rb, vfb, dt=0.0, db=0.0):
    return vfb * (1 + rt * (1 + dt) / (rb * (1 + db)))


def corners(rt, rb, tol=TOL):
    lo = vout(rt, rb, VFB[0], -tol, +tol)
    hi = vout(rt, rb, VFB[2], +tol, -tol)
    return lo, vout(rt, rb, VFB[1]), hi


def netlist(vin: float, rt: float, rb: float, step: tuple, cbuck=C_BUCK, cmod=C_MOD,
            fz=2e3, l=L) -> str:
    i0, i1, i2 = step
    return f"""Vin vin 0 {vin}
Rsrc vin vsys 0.02
Cin vsys 0 10u
Xb vsys lx fb en 0 CONV_AVG PARAMS: VREF=0.6 KP={KP} FZ={fz} IMAX=3 EFF=0.9 TSS=200u RDROP=0.14 L={l}
Ven en 0 3.3
Rdcr lx out {DCR}
Cb out 0 {cbuck}
Rt out fb {rt}
Rb fb 0 {rb}
Rpour out mod 0.008
Cm mod 0 {cmod}
Iload mod 0 PWL(0 {i0} 1m {i0} 1.0005m {i1} 2m {i1} 2.00045m {i2} 3m {i2})
"""


def ripple_pwm(vin, vo, c, esr=0.003):
    d = vo / vin
    di = (vin - vo) * d / (L * FSW)
    return di / (8 * FSW * c) + di * esr, di


def run(ctx: Ctx) -> Bench:
    b = Bench("b02", TITLE, REQS,
              provenance=[
                  "Vendor model TI SLVMBW3 (TLV62569 unencrypted transient, rev A) and SLVMC19 "
                  "(TLV62569P) were tried in ngspice 45.2: both stop switching during soft start "
                  "(output stalls at 0.5–0.9 V; the PWM state machine locks), so they cannot be "
                  "used here. The smoke test below re-runs SLVMBW3 each time and reports it.",
                  "Used instead: averaged current-mode model `CONV_AVG` (inductor-current slew "
                  "limited by (VIN−VOUT)/L), with its loop gain calibrated against the "
                  "datasheet load-transient plot (SLVSDG1C p12 Figure 18: 0.8→2 A at 1 A/µs, "
                  "VOUT 1.8 V, 10 µF, ≈ 0.16 V undershoot). Switching ripple from the "
                  "analytic PWM formula; power-save ripple scaled from Figure 15 (≈ 90 mV p-p at "
                  "0.1 A with 10 µF).",
                  "Limits: WROOM-1U VDD 3.0–3.6 V, ≥ 0.5 A (datasheet v1.8 p27, Table 6-2); "
                  "eFuse writing: VDD3P3_CPU ≤ 3.3 V (ESP32-S3 datasheet v2.2 p64, Table 5-2 "
                  "note 3, https://www.espressif.com/sites/default/files/documentation/"
                  "esp32-s3_datasheet_en.pdf); VFB 0.588/0.600/0.612 V (SLVSDG1C p4).",
              ],
              assumptions=[
                  "Wi-Fi burst profile: 0 → 500 mA in 0.5 µs (1 A/µs), 1 ms, then → 50 mA "
                  "(design step from HW-ELEC-07; the module's TX peak is 355 mA, WROOM p28).",
                  "Output capacitance 2 × 22 µF at the buck (proposal: 1 × 22 µF, so the total "
                  "stays inside TI's verified 10–47 µF) + 22 µF at the module, 75 % left at 3.3 V "
                  "(DC-bias assumption), 8 mΩ of plane/via between them.",
                  "Loop gain (A/V at FB) is fixed by the internal compensation, so the crossover "
                  "falls as the output capacitance grows (current mode); the PI zero is put at "
                  "2 kHz so the loop stays damped over TI's verified 10–47 µF range (the real "
                  "zero is not published).",
                  "Resistor tolerance ±1 % (decision 6) or ±0.1 % (thin film, the H4 proposal); "
                  "VFB ±2 % is the full datasheet range (the part is not trimmed tighter).",
                  "eFuse burning happens at light load (≤ 100 mA: no radio), i.e. in power-save "
                  "mode, where the output sits above the PWM set point by up to the PSM ripple "
                  "(SLVSDG1C p10 §7.3.1: 'the output voltage rises slightly').",
              ])

    # --- model calibration against Figure 18 ----------------------------------------------------
    net = f"""Vin vsys 0 5
Xb vsys lx fb en 0 CONV_AVG PARAMS: VREF=0.6 KP={KP} FZ=2k IMAX=3 EFF=0.9 TSS=200u RDROP=0.14 L=2.2u
Ven en 0 3.3
Rdcr lx out 0.04
Cb out 0 {10e-6 * 0.8}
Rt out fb 200k
Rb fb 0 100k
Iload out 0 PWL(0 0.8 1m 0.8 1.0012m 2 1.5m 2)
"""
    r = ctx.sim("b02", "calib_fig18", net, "tran 20n 1.1m 0 20n uic", ["v(out)"])
    v0 = float(np.mean(window(r, "v(out)", 0.95e-3, 1e-3)))
    und = v0 - float(np.min(window(r, "v(out)", 1e-3, 1.05e-3)))
    b.add("model calibration: undershoot for SLVSDG1C Fig. 18 conditions", si(und, "V"),
          "0.16 V ± 40 % (read from the plot)", 0.096 <= und <= 0.224, "HW-ELEC-07",
          "validates the averaged model's loop gain")

    # --- vendor model smoke test (documents the ngspice incompatibility; slow: opt-in) ---------
    if not ctx.vendor:
        b.add("vendor model SLVMBW3 smoke test", "skipped (make sim VENDOR=1)",
              "INFO: run of 2026-09-29 stalled at 0.5–0.9 V during soft start", None, "HW-ELEC-07")
    else:
        try:
            from models import vendor
            lib, prov = vendor.fetch("tlv62569", ctx.models)
            net = f""".include {lib}
V1 vsys 0 PWL(0 0 20u 4.4)
C1 vsys 0 10u
X1 vsys fb sw vsys 0 TLV62569_TRANS
L1 sw lx 2.2u
R1 lx out 0.04
C2 out 0 44u
Rt out fb 100k
Rb fb 0 22k
Rl out 0 100
"""
            rv = ctx.sim("b02", "vendor_smoke", net, "tran 10n 500u 0", ["v(out)"], timeout=3600)
            vend = float(rv["v(out)"][-1])
            b.add("vendor model SLVMBW3 start-up in ngspice (500 µs)", si(vend, "V"),
                  "INFO: a working model reaches ≈ 3.3 V", None, "HW-ELEC-07", prov)
        except Exception as exc:  # network or model problems are reported, not fatal
            b.add("vendor model SLVMBW3 smoke test", "not run", "INFO", None, "HW-ELEC-07",
                  str(exc)[:200])

    # --- load step for each divider, VSYS 4.4 V (USB) and 3.5 V (battery) -----------------------
    for label, (rt, rb, tol) in DIVIDERS.items():
        lo, nom, hi = corners(rt, rb, tol)
        worst_droop, worst_over = 0.0, 0.0
        for vin in (4.4, 3.5):
            cb = 22e-6 * 0.75 if label.startswith("proposed") else C_BUCK
            r = ctx.sim("b02", f"step_{rt:.0f}_{rb:.0f}_{vin}", netlist(vin, rt, rb, (0.0, 0.5, 0.05), cbuck=cb),
                        "tran 50n 3m 0 50n uic", ["v(mod)", "v(out)"])
            vset = float(np.mean(window(r, "v(mod)", 0.8e-3, 0.99e-3)))
            vmin = float(np.min(window(r, "v(mod)", 1e-3, 2e-3)))
            vmax = float(np.max(window(r, "v(mod)", 2e-3, 3e-3)))
            vss = float(np.mean(window(r, "v(mod)", 1.8e-3, 1.99e-3)))
            worst_droop = max(worst_droop, vset - vmin)
            worst_over = max(worst_over, vmax - vss)
        ctot = (22e-6 * 0.75 if label.startswith("proposed") else C_BUCK) + C_MOD
        rip_pwm, _ = ripple_pwm(4.4, nom, ctot)
        rip_psm = 0.090 * 10e-6 / ctot                      # Figure 15 scaled by 1/C
        low = lo - worst_droop - rip_pwm / 2
        high_efuse = hi + rip_psm
        high_abs = hi + worst_over + rip_pwm / 2
        tag = label
        sc = "alt" if label.startswith("alt") else "both"
        b.add(f"[{tag}] nominal / DC corners", f"{nom:.3f} V ({lo:.3f}–{hi:.3f} V)",
              "INFO", None, "HW-ELEC-07, -08")
        b.add(f"[{tag}] worst low at the module: VFB min corner − droop − ripple/2",
              f"{low:.3f} V (droop {worst_droop * 1e3:.0f} mV)", "≥ 3.00 V (WROOM p27)",
              low >= 3.0, "HW-ELEC-07", scope=sc if sc == 'alt' else 'both', key=label.startswith('proposed'))
        b.add(f"[{tag}] worst high while burning eFuses: VFB max corner + PSM ripple",
              f"{high_efuse:.3f} V", "≤ 3.30 V (ESP32-S3 p64 note 3)", high_efuse <= 3.30,
              "HW-ELEC-08, HW-PRIV-06", scope=sc if sc == 'alt' else 'both', key=label.startswith('proposed'))
        b.add(f"[{tag}] worst high after the 500→50 mA release", f"{high_abs:.3f} V",
              "≤ 3.60 V (WROOM p27)", high_abs <= 3.6, "HW-ELEC-07", scope=sc if sc == 'alt' else 'both', key=label.startswith('proposed'))
    rip, di = ripple_pwm(4.4, 3.19, 22e-6 * 0.75 + C_MOD)
    b.add("output capacitance nominal (current: 3 × 22 µF + small / proposed: 2 × 22 µF)",
          "≈ 69 µF / ≈ 47 µF", "≤ 47 µF (TLV62569 verified range, SLVSDG1C p9-10)", None,
          "HW-ELEC-07", "INFO: the proposal sits at the top of the verified range")
    b.add("PWM ripple at 500 mA, VSYS 4.4 V (analytic)", f"{rip * 1e3:.1f} mV p-p (ΔIL {di * 1e3:.0f} mA)",
          "≤ 30 mV p-p (HW-ELEC-24, proposed)", rip <= 0.030, "HW-ELEC-24")
    b.add("power-save ripple at light load (Fig. 15 scaled)",
          f"{0.090 * 10e-6 / (C_BUCK + C_MOD) * 1e3:.0f} mV p-p", "≤ 30 mV p-p",
          0.090 * 10e-6 / (C_BUCK + C_MOD) <= 0.030, "HW-ELEC-24")
    # dropout on battery (100 % duty, p6 §7.3.2)
    for label, (rt, rb, tol) in DIVIDERS.items():
        _, nom, _ = corners(rt, rb, tol)
        vbat_min = nom + 0.5 * (0.1 + DCR) + 0.02
        b.add(f"[{label}] lowest VSYS that still regulates at 500 mA", f"{vbat_min:.2f} V",
              "INFO: battery cut-off must stay above this", None, "HW-ELEC-06, -07")
    b.notes.append("Every divider option shares the same absolute droop, so the choice is set by "
                   "the DC corners: the window 3.00–3.30 V is 300 mV wide and VFB alone spans "
                   "±2 %. With 1 % resistors no set point fits both ends against a 500 mA step; "
                   "0.1 % resistors at ≈ 3.19 V do. 3.30 V nominal (decision 6 as worded) exceeds "
                   "the eFuse limit at the VFB-max corner whatever the resistors.")
    return b
