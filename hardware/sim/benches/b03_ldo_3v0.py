"""B3: LP5907-3.0 analog rail: PSRR from VSYS (TI vendor model), codec load step, output
capacitance window and noise into the codecs / mic supply."""

from __future__ import annotations

import numpy as np

from benchlib import Bench, Ctx, at, si, window

TITLE = "LP5907 3V0 analog rail: PSRR, load step, C_OUT window, noise"
REQS = "HW-ELEC-09, -13"

# 3V0 capacitance (nominal µF): current schematic vs proposal (FINDINGS-H4)
# pre-H5: LDO 1 + 10 uF, ES8311 1 + 0.1, ES7210 2 x 1; H5: LDO 1, ES8311 1 + 0.1 (the mic
# filter's 10 uF sits behind 100 ohm and is not LDO output capacitance)
CAPS = {"current": [1, 10, 1, 0.1, 1, 1], "proposed": [1, 1, 0.1]}
DERATE_3V = 0.8          # 0603 X5R 1 uF/50 V and 10 uF/10 V at 3 V (assumption, see B1)


def run(ctx: Ctx) -> Bench:
    from models import vendor
    import spice

    lib, prov = vendor.fetch("lp5907", ctx.models)
    native = ctx.models / "LP5907_3P0_native.lib"
    native.write_text(spice.native_switches(lib.read_text(errors="replace")))
    b = Bench("b03", TITLE, REQS,
              provenance=[
                  "TI LP5907 3.0 V unencrypted PSpice transient model (SNVMAP8, rev A), "
                  "downloaded at run time (TI copyright, no redistribution grant): " + prov,
                  "Transformation: its three VSWITCH models are rewritten as ngspice `SW` switches "
                  "(same Ron/Roff/thresholds, `spice.native_switches`). Without it ngspice maps "
                  "them to XSPICE `aswitch`, which drops the small-signal path (PSRR read "
                  "−160 dB).",
                  "The model has no noise sources and no output-capacitor stability (ideal 10 mΩ "
                  "output, header: 'temperature effects & quiescent current not modelled'): "
                  "noise and C_OUT are checked against the datasheet (SNVS798Q p5 PSRR/eN table, "
                  "p6 C_OUT 0.7–10 µF, https://www.ti.com/lit/ds/symlink/lp5907.pdf).",
              ],
              assumptions=[
                  "VSYS disturbances: 50 mV p-p at 1 kHz (LED PWM / ringer, B1/B9) and 100 mV p-p "
                  "at 1 MHz (buck/e-ink boost switching band); ES8311 + handset mic + earpiece 25 mA.",
                  "MLCC DC-bias: 80 % of nominal left at 3 V.",
              ])

    net = f""".include {native}
Vin vsys 0 DC 4.4 AC 1
X1 vsys vsys out nc 0 LP5907_3P0_TRANS
Cout out 0 {2.1e-6 * DERATE_3V}
Rl out 0 120
"""
    r = ctx.sim("b03", "psrr_ac", net, "ac dec 40 10 3meg", ["vdb(out)"])
    ds = {100: 90, 1e3: 82, 10e3: 65, 100e3: 60}
    for f, lim in ((100, 90), (1e3, 82), (10e3, 65), (100e3, 60), (1e6, None)):
        v = float(np.interp(np.log10(f), np.log10(r["x"]), r["vdb(out)"]))
        note = f"datasheet typ {ds[f]} dB (p5)" if f in ds else "boost / buck switching band"
        b.add(f"PSRR at {si(f, 'Hz')}", f"{-v:.1f} dB", "≥ 40 dB", -v >= 40, "HW-ELEC-09", note)
    p1k = -float(np.interp(3, np.log10(r["x"]), r["vdb(out)"]))
    p1m = -float(np.interp(6, np.log10(r["x"]), r["vdb(out)"]))
    rip = 0.025 / np.sqrt(2) * 10 ** (-p1k / 20)
    b.add("3V0 in-band ripple from a 50 mV p-p 1 kHz VSYS disturbance", si(rip, "Vrms"),
          "≤ 10 µVrms (HW-ELEC-09 noise budget)", rip <= 10e-6, "HW-ELEC-09")
    rip_m = 0.05 / np.sqrt(2) * 10 ** (-p1m / 20)
    b.add("3V0 ripple from a 100 mV p-p 1 MHz VSYS ripple", si(rip_m, "Vrms"),
          "INFO: far above the audio band; removed by the codecs' decimation filters", None,
          "HW-ELEC-09", "switching band of the buck / e-ink boost")

    # load step 1 -> 25 mA (codecs waking up + mic supply), 1 µs edge
    net = f""".include {native}
Vin vsys 0 PWL(0 0 50u 4.4)
X1 vsys vsys out nc 0 LP5907_3P0_TRANS
Cout out 0 {2.1e-6 * DERATE_3V}
Iload out 0 PWL(0 1m 1m 1m 1.001m 25m 2m 25m 2.001m 1m 3m 1m)
"""
    r = ctx.sim("b03", "loadstep", net, "tran 0.2u 3m 0 0.2u", ["v(out)"])
    v = window(r, "v(out)", 0.5e-3, 3e-3)
    lo, hi = float(v.min()), float(v.max())
    b.add("3V0 during a 1 → 25 → 1 mA step", f"{lo:.3f}–{hi:.3f} V", "2.94–3.06 V (±2 %, p5)",
          lo >= 2.94 and hi <= 3.06, "HW-ELEC-09")
    t_on = r["x"][np.argmax(r["v(out)"] > 2.85)]
    b.add("start-up to 95 % after VIN ramp", si(t_on, "s"), "INFO (datasheet tON 80–150 µs, p6)",
          None, "HW-ELEC-09")

    for design, cs in CAPS.items():
        nom = sum(cs)
        eff = nom * DERATE_3V
        b.add(f"3V0 output capacitance ({design})", f"{nom:.1f} µF nominal, {eff:.1f} µF effective",
              "0.7–10 µF (SNVS798Q p6)", 0.7 <= eff and nom <= 10, "HW-ELEC-09",
              "the 10 µF on 3V0 goes (FINDINGS-H4 P-12)" if design == "current" else "")
    b.add("output noise, 10 Hz–100 kHz (datasheet)", "10 µVrms at 1 mA, 6.5 µVrms at 250 mA",
          "≤ 10 µVrms (HW-ELEC-09)", True, "HW-ELEC-09",
          "SNVS798Q p5; at our 25 mA between the two; the mic supply adds an RC filter (B5/B7)")
    return b
