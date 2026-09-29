"""B7 (H5): handset electret (through the 2 m cord and the jack) into the ES8311 ADC (MIC1P/N):
frequency response, RF filtering, A-weighted noise / SNR at 94 dB SPL (HW-ELEC-13). Replaces the
H4 base-mic -> ES7210 bench: there is no base mic and no ES7210 since the owner decisions of
2026-09-30.

The capsule is the handset's, not ours: the Opis 60s Micro class publishes no microphone data,
so a TYPICAL handset electret is assumed (-42 dBV/Pa at 2.2 kOhm, S/N 58 dBA). The SNR result
can never exceed the capsule's own S/N; the board requirement is therefore also stated as the
degradation the board adds (<= 1 dB)."""

from __future__ import annotations

import numpy as np

from benchlib import Bench, Ctx, a_weight_db

TITLE = "Handset mic into ES8311: response, RF filter, A-weighted SNR"
REQS = "HW-ELEC-13, -09; HW-FUNC-06"

K_T = 1.380649e-23 * 300
SENS = 10 ** (-42 / 20)            # V/Pa at RL 2.2 kOhm: TYPICAL handset electret (ASSUMPTION)
SNR_MIC = 58.0                     # dBA, same assumption (GMI6027-class capsule, INGHAi V1.0 p2)
ADC_FS = 3.0 / 3.3                 # ES8311 ADC full scale AVDD/3.3 Vrms (datasheet rev 7.0 p8)
ADC_SNR = (100.0, 95.0)            # ES8311 ADC SNR typ / min, A-weighted, PGA 0 dB (p8)
PGA_DB = 18.0                      # firmware setting (PGA 0-30 dB, User Guide rev 1.11 p19-20)
PGA_NOISE_DB = 3.0                 # "noise only increases slightly even if gain of PGA is set to
#                                    maximum" (UG p20): taken as +3 dB output noise (ASSUMPTION)
E_LDO = 10e-6 / np.sqrt(100e3 - 10)  # LP5907 10 uVrms 10 Hz-100 kHz (SNVS798Q p5), flat


def net(ac_sig: float, ac_ldo: float, ac_r: float) -> str:
    return f"""V3v0 v3 0 DC 2.94 AC {ac_ldo}
Rf v3 filt 100
Cf filt 0 8u
Rsw filt mv 0.15
Cmv mv 0 100n
D1 mv a1 LED_RED_TYP
R1 a1 0 1k
D2 mv a2 LED_RED_TYP
R2 a2 0 1k
Rl mv micf 2.2k
Irn mv micf DC 0 AC {ac_r}
Cmf micf 0 100p
Rcord micf s 0.2
Ccord s 0 100p
Idss s 0 DC 0.3m AC {ac_sig}
Ro s 0 100k
Dsen micf sd D1N4148
Rsd sd sense 100k
Rpd sense 0 1meg
Csn sense 0 10n
Cc1 micf p 1u
Rinp p vmid 6k
Cc2 0 n 1u
Rinn n vmid 6k
Vmid vmid 0 1.5
.model D1N4148 D(IS=2.52n RS=0.568 N=1.752 CJO=4p M=0.4 TT=20n BV=100 IBV=100u)
"""


def run(ctx: Ctx) -> Bench:
    b = Bench("b07", TITLE, REQS,
              provenance=[
                  "Handset electret: TYPICAL capsule −42 ± 3 dBV/Pa at RL 2.2 kΩ, S/N 58 dBA "
                  "(ASSUMPTION: no data for the Opis 60s Micro; values of the GMI6027 class, "
                  "INGHAi V1.0 p2); signal current source (sensitivity / 2.2 kΩ), 100 kΩ JFET "
                  "output resistance; 2 m cord 0.2 Ω / 100 pF.",
                  "ES8311 ADC: 6 kΩ input impedance per pin, full scale AVDD/3.3 Vrms, SNR "
                  "100 dBA typ / 95 min at PGA 0 dB (datasheet rev 7.0 p8); PGA 0–30 dB with "
                  "'noise only increases slightly' at maximum gain (User Guide rev 1.11 p19-20).",
                  "3V0 noise: LP5907 10 µVrms (SNVS798Q p5) behind the 100 Ω / 10 µF filter; "
                  "resistor thermal noise 4kTR; A-weighting IEC 61672-1.",
                  "Topology: the H5 schematic (3V0 → 100 Ω/10 µF → MUTE → hook P-FET → MIC_VCC "
                  "with two mic lights → 2.2 kΩ → bead → jack S; 1 µF into MIC1P, MIC1N via 1 µF "
                  "to the jack ground; the mic-sense diode branch as a load).",
              ],
              assumptions=[
                  "Mic self-noise is its S/N spec: 94 − 58 = 36 dBA SPL equivalent.",
                  f"Firmware runs the PGA at {PGA_DB:.0f} dB (1 Pa → −23 dBFS, 20 dB headroom for "
                  "a shout at the handset); PGA output noise +3 dB over PGA 0 dB.",
                  "Noise sources are uncorrelated and add in power; the analog chain is linear.",
              ])

    ana = "ac dec 50 10 3meg"
    rs = ctx.sim("b07", "sig", net(1.0, 0, 0), ana, ["mag(v(p,n))"])
    rl = ctx.sim("b07", "ldo", net(0, 1.0, 0), ana, ["mag(v(p,n))"])
    rr = ctx.sim("b07", "r2k2", net(0, 0, 1.0), ana, ["mag(v(p,n))"])
    f = rs["x"]
    hs = rs["mag(v(p,n))"]
    h1k = float(np.interp(1e3, f, hs))
    band = (f >= 100) & (f <= 7e3)
    dev = 20 * np.log10(hs[band] / h1k)
    b.add("analog path response 100 Hz–7 kHz, re 1 kHz", f"{dev.min():+.2f} … {dev.max():+.2f} dB",
          "within ±3 dB", bool(np.all(np.abs(dev) <= 3)), "HW-ELEC-13", key=True)
    f3 = float(f[np.argmax(hs > h1k / np.sqrt(2))])
    b.add("low-frequency −3 dB corner (1 µF into 6 kΩ)", f"{f3:.1f} Hz", "≤ 50 Hz", f3 <= 50,
          "HW-ELEC-13")
    att = 20 * np.log10(float(np.interp(1e6, f, hs)) / h1k)
    b.add("attenuation at 1 MHz (bead, 100 pF, cord)", f"{att:.1f} dB",
          "INFO: RF (Wi-Fi burst demodulation) filtering; the ADC decimation removes the rest",
          None, "HW-ELEC-13")

    fb = np.logspace(np.log10(20), np.log10(20e3), 2000)
    aw = 10 ** (a_weight_db(fb) / 20)

    def integ(h, dens):
        hh = np.interp(fb, f, h)
        return float(np.sqrt(np.trapezoid((hh * dens * aw) ** 2, fb)))

    sig = SENS / 2.2e3 * h1k                                 # 94 dB SPL = 1 Pa
    n_ldo = integ(rl["mag(v(p,n))"], E_LDO)
    n_r = integ(rr["mag(v(p,n))"], np.sqrt(4 * K_T / 2.2e3))
    n_mic = SENS * 10 ** (-SNR_MIC / 20) * h1k / 2.2e3
    board = np.sqrt(n_ldo ** 2 + n_r ** 2)
    res = {}
    for pga, extra in ((0.0, 0.0), (PGA_DB, PGA_NOISE_DB)):
        for snr_adc, lab in zip(ADC_SNR, ("typ", "min")):
            n_adc = ADC_FS * 10 ** (-snr_adc / 20) * 10 ** (extra / 20) / 10 ** (pga / 20)
            tot = np.sqrt(n_mic ** 2 + board ** 2 + n_adc ** 2)
            res[(pga, lab)] = (20 * np.log10(sig / tot), n_adc)
    for (pga, lab), (snr, n_adc) in res.items():
        main = pga == PGA_DB and lab == "typ"
        b.add(f"SNR at 94 dB SPL, 1 kHz, A-weighted: PGA {pga:.0f} dB, ES8311 ADC SNR {lab}",
              f"{snr:.2f} dBA (mic {n_mic * 1e6:.1f}, ADC {n_adc * 1e6:.2f} input-referred, "
              f"board {board * 1e6:.2f} µVrms)", "≥ 55 dBA (HW-ELEC-13)" if main else "INFO",
              (snr >= 55) if main else None, "HW-ELEC-13", key=main)
    deg = SNR_MIC - res[(PGA_DB, "min")][0]
    b.add(f"SNR the board and ADC take from the capsule (PGA {PGA_DB:.0f} dB, ADC SNR min)",
          f"{deg:.2f} dB below the capsule's {SNR_MIC:.0f} dBA",
          "≤ 1.5 dB (the board must not be the limit)", deg <= 1.5, "HW-ELEC-13")
    b.add("3V0 + bias-resistor noise at the ADC input", f"{board * 1e6:.2f} µVrms",
          "≤ 1/3 of the mic self-noise", board <= n_mic / 3, "HW-ELEC-09, -13")
    for c in b.checks:
        if c.scope == "both":
            c.scope = "proposal"
    b.notes.append("Honest limits: the absolute SNR is set by the handset capsule we do not "
                   "choose (assumed 58 dBA; a 55 dBA capsule gives ≈ 53 dBA whatever the board "
                   "does) and by the PGA noise, which Everest describes only qualitatively. At "
                   "PGA 0 dB the ES8311 ADC noise alone costs ≈ 4 dB. Measure with the Opis 60s "
                   "Micro and one generic handset in EVT.")
    return b
