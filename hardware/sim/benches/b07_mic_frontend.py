"""B7: base-mic front end into ES7210 CH2: frequency response, RF/anti-alias filtering and
A-weighted noise / SNR at 94 dB SPL (HW-ELEC-13)."""

from __future__ import annotations

import numpy as np

from benchlib import Bench, Ctx, a_weight_db

TITLE = "Base-mic front end into ES7210: response, RF filter, A-weighted SNR"
REQS = "HW-ELEC-13, -09; HW-FUNC-05"

K_T = 1.380649e-23 * 300
SENS = 10 ** (-42 / 20)            # V/Pa at RL 2.2 kΩ (GMI6027 p2)
SNR_MIC = 58.0                     # dBA (GMI6027 p2)
ADC_FS, ADC_SNR = 3.0 / 3.3, 102.0  # ES7210 full scale AVDD/3.3 Vrms, SNR typ (min 95) dBA [ES7210 p7-8]
E_LDO = 10e-6 / np.sqrt(100e3 - 10)  # LP5907 10 µVrms 10 Hz–100 kHz at 1 mA (SNVS798Q p5), flat


def net(ac_sig: float, ac_ldo: float, ac_r: float) -> str:
    return f"""V3v0 v3 0 DC 2.94 AC {ac_ldo}
Rf v3 filt 100
Cf filt 0 8u
Rsw filt sw 0.05
Cmv sw 0 100n
D1 sw a1 LED_RED_TYP
R1 a1 0 1k
D2 sw a2 LED_RED_TYP
R2 a2 0 1k
Rl sw mic 2.2k
Irn sw mic DC 0 AC {ac_r}
Cmic mic 0 33p
Idss mic 0 DC 0.3m AC {ac_sig}
Ro mic 0 100k
Cc1 mic p 1u
Rinp p vmid 6k
Cc2 0 n 1u
Rinn n vmid 6k
Vmid vmid 0 1.5
"""


def run(ctx: Ctx) -> Bench:
    b = Bench("b07", TITLE, REQS,
              provenance=[
                  "GMI6027-2C42DB electret: −42 ± 3 dBV/Pa at RL 2.2 kΩ, S/N ≥ 58 dBA, "
                  "100 Hz–10 kHz (INGHAi V1.0 p2); modelled as a signal current source "
                  "(sensitivity / 2.2 kΩ) with a 100 kΩ JFET output resistance (assumption).",
                  "ES7210: 6 kΩ input impedance per pin (datasheet rev 9.1 p8), full scale "
                  "AVDD/3.3 Vrms, SNR 102 dBA typ / 95 min (p7), PGA 0 dB assumed for the ADC "
                  "noise (conservative: a higher PGA lowers the input-referred ADC noise).",
                  "3V0 noise: LP5907 10 µVrms (10 Hz–100 kHz at 1 mA, SNVS798Q p5) as a flat "
                  "31.6 nV/√Hz density; resistor thermal noise 4kTR; A-weighting IEC 61672-1.",
                  "Topology: the H5 proposal from B5 (3V0 → 100 Ω/10 µF → MUTE → MIC_VCC with two "
                  "LEDs → 2.2 kΩ → capsule; pseudo-differential into CH2 through 1 µF each).",
              ],
              assumptions=[
                  "Mic self-noise is taken as its S/N spec: 94 − 58 = 36 dBA SPL equivalent.",
                  "Noise sources are uncorrelated and add in power; the analog chain is linear.",
              ])

    f_lo, f_hi = 20, 20e3
    ana = "ac dec 50 10 3meg"
    rs = ctx.sim("b07", "sig", net(1.0, 0, 0), ana, ["mag(v(p,n))"])
    rl = ctx.sim("b07", "ldo", net(0, 1.0, 0), ana, ["mag(v(p,n))"])
    rr = ctx.sim("b07", "r2k2", net(0, 0, 1.0), ana, ["mag(v(p,n))"])
    f = rs["x"]
    hs = rs["mag(v(p,n))"]                  # V per A of capsule signal current
    h1k = float(np.interp(1e3, f, hs))
    band = (f >= 100) & (f <= 7e3)
    dev = 20 * np.log10(hs[band] / h1k)
    b.add("analog path response 100 Hz–7 kHz, re 1 kHz", f"{dev.min():+.2f} … {dev.max():+.2f} dB",
          "within ±3 dB (capsule itself: 100 Hz–10 kHz)", bool(np.all(np.abs(dev) <= 3)),
          "HW-ELEC-13", key=True)
    f3 = float(f[np.argmax(hs > h1k / np.sqrt(2))])
    b.add("low-frequency −3 dB corner (1 µF into 6 kΩ)", f"{f3:.1f} Hz", "≤ 50 Hz", f3 <= 50,
          "HW-ELEC-13")
    att = 20 * np.log10(float(np.interp(1e6, f, hs)) / h1k)
    b.add("attenuation at 1 MHz (RF cap + source impedance)", f"{att:.1f} dB",
          "INFO: the ES7210 decimation filter removes out-of-band energy; the 33 pF is an RF "
          "(GSM/Wi-Fi demodulation) cap, not an anti-alias filter", None, "HW-ELEC-13")
    load = 20 * np.log10(h1k / 2.2e3)
    b.add("signal loss from the 6 kΩ ADC inputs loading the 2.2 kΩ bias resistor", f"{load:.1f} dB",
          "INFO (applied to the SNR below)", None, "HW-ELEC-13")

    # ---- A-weighted noise budget at 94 dB SPL -------------------------------------------------
    fb = np.logspace(np.log10(f_lo), np.log10(f_hi), 2000)
    aw = 10 ** (a_weight_db(fb) / 20)

    def integ(h, dens):
        hh = np.interp(fb, f, h)
        return float(np.sqrt(np.trapezoid((hh * dens * aw) ** 2, fb)))

    sig = SENS / 2.2e3 * h1k                                # 94 dB SPL = 1 Pa
    n_ldo = integ(rl["mag(v(p,n))"], E_LDO)
    n_r = integ(rr["mag(v(p,n))"], np.sqrt(4 * K_T / 2.2e3))
    n_mic = SENS * 10 ** (-SNR_MIC / 20) * h1k / 2.2e3      # already A-weighted
    for snr_adc, lab in ((ADC_SNR, "typ"), (95.0, "min")):
        n_adc = ADC_FS * 10 ** (-snr_adc / 20)
        tot = np.sqrt(n_ldo ** 2 + n_r ** 2 + n_mic ** 2 + n_adc ** 2)
        snr = 20 * np.log10(sig / tot)
        b.add(f"SNR at 94 dB SPL, 1 kHz, A-weighted (ES7210 SNR {lab}, PGA 0 dB)",
              f"{snr:.2f} dBA (mic {n_mic * 1e6:.1f}, ADC {n_adc * 1e6:.1f}, 3V0 {n_ldo * 1e6:.2f}, "
              f"2.2k {n_r * 1e6:.2f} µVrms)", "≥ 55 dBA (HW-ELEC-13)" if lab == "typ" else
              "INFO (a PGA gain ≥ 12 dB recovers it)", (snr >= 55) if lab == "typ" else None,
              "HW-ELEC-13", key=lab == "typ")
    b.add("3V0 noise share at the ADC input (after the 100 Ω/10 µF filter)", f"{n_ldo * 1e6:.2f} µVrms",
          "≤ 1/3 of the mic self-noise", n_ldo <= n_mic / 3, "HW-ELEC-09, -13")
    return b
