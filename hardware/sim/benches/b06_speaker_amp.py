"""B6: NS4150B into the 8 Ω speaker: output level vs the ringer (≥ 75 dBA at 1 m) and
voice-prompt level (no speakerphone since H5), clipping, and VSYS droop while ringing."""

from __future__ import annotations

import numpy as np

from benchlib import Bench, Ctx, si, window
from benches.b01_power_path import P_BUCK_IDLE, P_HANDSET, P_LED_CAP

TITLE = "NS4150B class-D into 8 Ω: ringer SPL, prompt level, clipping, VSYS droop"
REQS = "HW-ELEC-14, -05, -10; HW-FUNC-04"

DAC_FS = 3.0 / 3.3        # ES8311 full scale AVDD/3.3 Vrms at AVDD 3.0 V (es8311.md, [ES8311 p9])
SENS_05 = 86.0            # SP-2040 SPL 86 dB (1 W / 0.5 m) ± 3 dB, avg 0.8-1.5 kHz
SENS_1M = SENS_05 - 20 * np.log10(2)
RSPK = 8.0
FW_CAP_W = 1.0            # firmware power cap = the speaker's rated noise power (SP-2040)


def spl(p_w: float, dist_1m: bool = True, worst: bool = True) -> float:
    s = (SENS_1M if dist_1m else SENS_05) - (3 if worst else 0)
    return s + 10 * np.log10(max(p_w, 1e-9))


def run(ctx: Ctx) -> Bench:
    b = Bench("b06", TITLE, REQS,
              provenance=[
                  "NS4150B: behavioural `NS4150B_BEH` — A_V = 240 kΩ/R_IN on the differential "
                  "input (Nsiway V1.1 p7 §9.9; whether the gain is defined single-ended or "
                  "differential is UNVERIFIED: Chinese text only), BTL swing clipped at VCC − "
                  "0.3 V, supply current = P_out/η + 3 mA (η 88 %, p1/p3), "
                  "https://datasheet.lcsc.com/datasheet/pdf/75c9de26d1ce6a24e56ace3c6df586e7.pdf.",
                  "Speaker: Soberton SP-2040, 20 × 40 mm, 8 Ω ± 15 %, 1 W rated / 2 W max, "
                  "SPL 86 dB ± 3 dB at 1 W / 0.5 m (average of 0.8/1.0/1.2/1.5 kHz), F0 650 Hz "
                  "(SP-2040 spec rev B p1, https://www.soberton.com/wp-content/uploads/2020/03/"
                  "SP-2040-June-2018.pdf). It is 8.4 mm deep (p1): the H5 proto box grew to take it.",
                  "DAC: ES8311 full scale 0.91 Vrms differential at AVDD 3.0 V (es8311.md).",
                  "VSYS source: `BQ24074_BEH` at the ILIM-min / 4.75 V corner, no pack (as B1).",
              ],
              assumptions=[
                  "Free-field sensitivity; 1 m value = 0.5 m value − 6 dB; the ringer tone is in the "
                  "0.8–1.5 kHz band where A-weighting is 0 … +1 dB, so dB SPL ≈ dB(A). Enclosure "
                  "and grille losses are not modelled (EVT measures them): keep ≥ 2 dB margin.",
                  "Worst case uses the −3 dB sensitivity tolerance; speaker modelled as 8 Ω + "
                  "40 µH (voice-coil inductance, typical for this size: assumption).",
                  f"Firmware caps the ringer at {FW_CAP_W} W (the speaker's rating).",
              ])

    # ---- analysis per input resistor ------------------------------------------------------------
    for label, rin in (("current R_IN 150 kΩ", 150e3), ("proposed R_IN 68 kΩ", 68e3)):
        for vcc in (4.3, 3.7, 3.3):
            vclip = (vcc - 0.3) / np.sqrt(2)
            v = min(DAC_FS * 240e3 / rin, vclip)
            p = min(v * v / RSPK, FW_CAP_W)
            ring = spl(p)
            tag = f"[{label}] VCC {vcc} V"
            ok = ring >= 75 if vcc >= 4.3 else None
            b.add(f"{tag}: max clean power → ringer SPL at 1 m (−3 dB unit)",
                  f"{p:.2f} W → {ring:.1f} dBA", "≥ 75 dBA at 1 m on USB (decision 9)" if ok is not None
                  else "INFO (battery)", ok, "HW-ELEC-14", key=(vcc == 4.3 and rin == 68e3))
        p_sp = min((DAC_FS * 240e3 / rin) ** 2 / RSPK, FW_CAP_W)
        b.add(f"[{label}] voice-prompt headroom at 0.5 m (−3 dB unit)", f"{spl(p_sp, False):.1f} dBA",
              "INFO: prompts only (no speakerphone since H5, owner 2026-09-30)", None, "HW-ELEC-14")
    p_need = 10 ** ((75 - (SENS_1M - 3)) / 10)
    b.add("electrical power needed for 75 dBA at 1 m (worst unit)", f"{p_need:.2f} W",
          "INFO: ≤ 1 W rating", None, "HW-ELEC-14")

    # ---- transient: ringing at the firmware cap, VSYS from the charger (no pack) ---------------
    amp = np.sqrt(FW_CAP_W * RSPK) * np.sqrt(2) / (240e3 / 68e3)    # diff. DAC peak for 1 W
    net = f"""Vsrc src 0 PWL(0 0 100u 4.75)
Rsrc src vbus 0.27
Cin vbus 0 6u
Xbq vbus vsys bat 0 BQ24074_BEH PARAMS: ILIM=1.36 VOREG=4.3 RDO=0.475 CHG=0
Cbat bat 0 4.7u
Rbat bat 0 1meg
Cvsys vsys 0 {(10 + 10 + 1) * 0.55e-6 + 22e-6 * 0.7}
Bbase vsys 0 I = (V(vsys) > 3 ? 1 : 0)*{P_BUCK_IDLE + P_LED_CAP + P_HANDSET:.4g}/max(V(vsys),1)
Vdp dp 0 SIN(1.5 {amp / 2} 1k 3m)
Vdn dn 0 SIN(1.5 {-amp / 2} 1k 3m)
Cip dp ip 100n
Cin2 dn in 100n
Rip ip 0 68k
Rin3 in 0 68k
Vctl ctl 0 PWL(0 0 2m 0 2.1m 3.3)
Xa ip in vop von vsys ctl 0 NS4150B_BEH PARAMS: RIN=68k EFF=0.88
Rs vop sl {RSPK}
Ls sl von 40u
"""
    r = ctx.sim("b06", "ring", net, "tran 2u 25m 0 2u uic", ["v(vop,von)", "v(vsys)", "i(vsrc)"])
    vo = window(r, "v(vop,von)", 10e-3, 25e-3)
    t = r["x"][(r["x"] >= 10e-3) & (r["x"] <= 25e-3)]
    vrms = float(np.sqrt(np.trapezoid(vo ** 2, t) / (t[-1] - t[0])))
    p = vrms ** 2 / RSPK * 0.99
    b.add("simulated ringing at the firmware cap (68 kΩ, 1 kHz)", f"{vrms:.2f} Vrms, {p:.2f} W",
          "≥ 0.63 W (75 dBA at 1 m, worst unit)", p >= p_need, "HW-ELEC-14", scope="proposal")
    vmin = float(np.min(window(r, "v(vsys)", 5e-3, 25e-3)))
    b.add("VSYS min while ringing (no pack, 4.75 V source, ILIM min)", si(vmin, "V"),
          "≥ 3.7 V (SK6812 min; buck headroom)", vmin >= 3.7, "HW-ELEC-10")
    iavg = -float(np.mean(window(r, "i(vsrc)", 10e-3, 25e-3)))
    b.add("average input current while ringing at the cap", si(iavg, "A"),
          "INFO: power_budget.yaml ringing_max row is 703 mA", None, "HW-ELEC-05")
    return b
