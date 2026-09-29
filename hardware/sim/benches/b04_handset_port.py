"""B4 (H5): the analog handset jack J7 — earpiece drive from the ES8311 through the hook-gated
TS5A3166 switch, the handset-mic bias, the inline-button / plug-type sense on IO10 (ADC1) and
the insertion detect on IO12. Replaces the H4 USB-C handset-port bench (owner 2026-09-30: the
USB host port, its 5 V boost and VBUS switch are gone)."""

from __future__ import annotations

import numpy as np

from benchlib import Bench, Ctx, si, window

TITLE = "Handset jack: earpiece drive and hook gate, mic bias, button and insertion sense"
REQS = "HW-FUNC-06, -18; HW-ELEC-17, -26, -27; HW-PRIV-03"

FS_SE = 3.0 / 3.3 / 2        # ES8311 full scale AVDD/3.3 Vrms differential [DS p9] -> OUTP alone
VMID = 1.5                   # AVDD/2 (assumption: the output common mode sits at VMID)
R_CODEC = 1.0                # ES8311 output resistance: not published (UNVERIFIED, assumed 1 ohm)
R_EAR, L_EAR = 32.0, 20e-6   # typical 32 ohm dynamic receiver (assumption)
SENS_MW = 95.0               # dB SPL at 1 mW, ear simulator: typical 32 ohm mobile-accessory
#                              receiver (ASSUMPTION: Opis publishes no receiver data)
R_SER, R_BYP, C_CPL = 22.0, 22e3, 2 * 22e-6 * 0.9   # 2 x 22 uF 0805/25 V, ~90 % left at 1.5 V
MIC_VCC = 2.90               # b05: worst MIC_VCC with 3V0 at -2 % and the filter/P-FET drops
IDSS = (0.1e-3, 0.5e-3)      # typical handset electret drain current (assumption, <= 0.5 mA)
R_BUTTON = 70.0              # CTIA/Android headset "play/pause" button: 0-70 ohm (assumption)
VIL, VIH = 0.25 * 3.3, 0.75 * 3.3   # ESP32-S3 digital input thresholds (datasheet v2.2 p60)


def ear_net(src: str, t_close: float) -> str:
    """t_close: 0 = closed (off-hook), < 0 = open (on-hook), > 0 = closes at that time.
    OUTP (VMID + signal) -> TS5A3166 (0.9 ohm) || 22k ->
    2 x 22 uF -> 22 ohm per contact -> receiver on T (R1 open: mono handset on the tip) -> GND."""
    if t_close <= 0:        # AC: fixed state (ngspice's SW starts open at the OP point)
        sw = f"Rsw outp earsw {0.9 if t_close == 0 else 1e9}"
    else:
        sw = (f"Ssw outp earsw hk 0 SWE\nVhk hk 0 PWL(0 0 {t_close:g} 0 {t_close + 1e-6:g} 3.3)\n"
              ".model SWE SW(RON=0.9 ROFF=1e9 VT=1.65 VH=0.1)")
    return f"""Vout outp0 0 {src}
Rcod outp0 outp {R_CODEC}
{sw}
Rbyp outp earsw {R_BYP}
Ccpl earsw earac {C_CPL}
Rt earac hst {R_SER}
Rr earac hsr1 {R_SER}
Ct hst 0 100p
Cr hsr1 0 100p
Rbl hst 0 10k
Rcord hst ear 0.2
Rear ear earl {R_EAR}
Lear earl 0 {L_EAR}
Rr1 hsr1 0 1meg
"""


def mic_net(state: str, idss: float, gpio: str = "") -> str:
    """MIC_VCC -> 2.2k -> bead -> S; capsule (JFET current source) or button short or open;
    sense branch: 1N4148W -> 100k -> MIC_SENSE (1M + 10 nF)."""
    if state == "mic":
        load = f"Bmic s 0 I = {idss}*tanh(V(s)/0.15)\n"
    elif state == "button":
        load = f"Rbtn s 0 {R_BUTTON}\nBmic s 0 I = {idss}*tanh(V(s)/0.15)\n"
    elif state == "omtp":   # OMTP plug in a CTIA jack: S meets the plug's GND ring
        load = "Romtp s 0 0.2\n"
    else:
        load = ""
    return f"""Vmv mv 0 {MIC_VCC}
Rb mv micf 2.2k
Rfb micf s 0.05
Cf micf 0 100p
{load}Dsen micf sd D1N4148
Rsd sd sense 100k
Rpd sense 0 1meg
Csn sense 0 10n
{gpio}.model D1N4148 D(IS=2.52n RS=0.568 N=1.752 CJO=4p M=0.4 TT=20n BV=100 IBV=100u)
"""


def run(ctx: Ctx) -> Bench:
    b = Bench("b04", TITLE, REQS,
              provenance=[
                  "ES8311: full scale AVDD/3.3 Vrms differential (datasheet rev 7.0 p9) → "
                  "0.455 Vrms on OUTP alone; 'the fully differential output ... has a capability "
                  "to drive 16 Ω or 32 Ω headphone load' (User Guide rev 1.11 p2, "
                  "https://files.waveshare.com/wiki/common/ES8311.user.Guide.pdf); the output "
                  "resistance is not published (1 Ω assumed).",
                  "TS5A3166: RON 0.9 Ω, IN connects COM to NO, signal range 0..V+ (TI SCDS186E "
                  "p3-4, https://www.ti.com/lit/ds/symlink/ts5a3166.pdf).",
                  "1N4148W: standard 1N4148 SPICE parameters (IS 2.52 nA, N 1.752); the LCSC part "
                  "C81598 guarantees IR ≤ 1 µA at 75 V (its datasheet p1).",
                  "PJ-31060 jack (HOOYA, C2939583): TN is the normally-closed tip-spring contact "
                  "(drawing p1 schematic).",
              ],
              assumptions=[
                  "Handset (Opis 60s Micro class; no electrical data published): 32 Ω dynamic "
                  "receiver on the tip, 95 dB SPL at 1 mW on an ear simulator; electret "
                  "0.1–0.5 mA; inline button 0–70 Ω from S to GND (CTIA headset practice); 2 m "
                  "cord 0.2 Ω per conductor.",
                  "Coupling capacitors 2 × 22 µF 0805/25 V keep ~90 % at the 1.5 V VMID bias.",
                  "Firmware keeps the codec (VMID) powered from boot, so the coupling caps are "
                  "pre-charged through the 22 kΩ bypass long before a hand lifts the handset.",
              ])

    # ---- earpiece: response and level ----------------------------------------------------------
    r = ctx.sim("b04", "ear_ac", ear_net(f"DC {VMID} AC 1", 0.0), "ac dec 40 10 100k",
                ["mag(v(ear))"])
    f, h = r["x"], r["mag(v(ear))"]
    h1k = float(np.interp(1e3, f, h))
    band = (f >= 100) & (f <= 7e3)
    dev = 20 * np.log10(h[band] / h1k)
    b.add("earpiece response 100 Hz–7 kHz re 1 kHz (switch closed)",
          f"{dev.min():+.2f} … {dev.max():+.2f} dB", "within ±3 dB (wideband voice)",
          bool(np.all(np.abs(dev) <= 3)), "HW-ELEC-26")
    v_ear = FS_SE * h1k
    p_mw = v_ear ** 2 / R_EAR * 1e3
    spl = SENS_MW + 10 * np.log10(p_mw)
    b.add("earpiece at DAC full scale, 1 kHz: voltage, power, level (assumed receiver)",
          f"{v_ear:.3f} Vrms, {p_mw:.2f} mW → {spl:.1f} dB SPL", "≥ 90 dB SPL (HW-ELEC-26; "
          "firmware caps the listening level)", spl >= 90, "HW-ELEC-26", key=True)
    i_pk = FS_SE * np.sqrt(2) / (R_SER + R_EAR)
    i_pk2 = FS_SE * np.sqrt(2) / ((R_SER + R_EAR) / 2)
    b.add("ES8311 peak output current: one receiver / stereo headset (both contacts loaded)",
          f"{si(i_pk, 'A')} / {si(i_pk2, 'A')}", "≤ 40 mA (the rated 16 Ω load at full scale)",
          i_pk2 <= 40e-3, "HW-ELEC-26")
    i_sh = FS_SE * np.sqrt(2) / R_SER * 2
    b.add("peak output current if T and R1 both short to GND while playing (plug insertion "
          "off-hook)", si(i_sh, "A"), "INFO: brief, current-limited by the 22 Ω resistors; on-hook "
          "the switch is open", None, "HW-ELEC-26")

    # ---- earpiece off on-hook (switch open, only the 22k anti-pop bypass) ---------------------
    r = ctx.sim("b04", "ear_off", ear_net(f"DC {VMID} AC 1", -1.0), "ac dec 40 10 100k", ["mag(v(ear))"])
    h_off = float(np.interp(1e3, r["x"], r["mag(v(ear))"]))
    att = 20 * np.log10(h_off / h1k)
    spl_off = SENS_MW + 10 * np.log10((FS_SE * h_off) ** 2 / R_EAR * 1e3)
    b.add("on-hook: earpiece level while the speaker rings at DAC full scale (switch open)",
          f"{att:.1f} dB → {spl_off:.0f} dB SPL at the receiver", "≤ −50 dB (ringer inaudible in "
          "the earpiece; hardware gate = HOOK)", att <= -50, "HW-ELEC-26, HW-PRIV-03", key=True)

    # ---- pop when the hook switch closes -------------------------------------------------------
    r = ctx.sim("b04", "ear_pop", ear_net(f"PWL(0 0 10m {VMID})", 8.0),
                "tran 2m 8.2 0 2m", ["v(ear)"])
    pop = float(np.max(np.abs(window(r, "v(ear)", 7.99, 8.2))))
    b.add("click at the receiver when the handset is lifted 8 s after the codec powered up",
          si(pop, "V"), "≤ 2 mV (≈ 20 nW: inaudible)", pop <= 2e-3, "HW-ELEC-26")

    # ---- mic bias, button, plug type ------------------------------------------------------------
    senses = {}
    for state in ("open", "mic", "button", "omtp"):
        for idss in IDSS:
            rr = ctx.sim("b04", f"mic_{state}_{idss * 1e6:.0f}", mic_net(state, idss),
                         "tran 1m 300m 0 1m", ["v(s)", "v(sense)"])
            senses[(state, idss)] = (float(rr["v(s)"][-1]), float(rr["v(sense)"][-1]))
    vmic = [senses[("mic", i)][0] for i in IDSS]
    b.add("handset capsule supply (S) with MIC_VCC at its worst 2.90 V",
          f"{min(vmic):.2f}–{max(vmic):.2f} V (IDSS 0.5 / 0.1 mA)", "≥ 1.5 V (typical electret "
          "rating range 1.5–3 V through 2.2 kΩ)", min(vmic) >= 1.5, "HW-FUNC-06")
    s_mic = min(senses[("mic", i)][1] for i in IDSS)
    s_btn = max(max(senses[("button", i)][1] for i in IDSS),
                max(senses[("omtp", i)][1] for i in IDSS))
    s_open = min(senses[("open", i)][1] for i in IDSS)
    s_mic_hi = max(senses[("mic", i)][1] for i in IDSS)
    b.add("MIC_SENSE (IO10): mic present vs button pressed / OMTP plug",
          f"mic ≥ {s_mic:.2f} V, button/OMTP ≤ {s_btn:.2f} V", "separation ≥ 0.5 V (ADC1 "
          "threshold in firmware)", s_mic - s_btn >= 0.5, "HW-FUNC-18", key=True)
    b.add("MIC_SENSE with no plug (mic line at MIC_VCC)", f"{s_open:.2f} V (mic ≤ {s_mic_hi:.2f} V)",
          "INFO: plug presence comes from JACK_DET; open vs mic differs by only ~0.2 V", None,
          "HW-FUNC-18")
    # button press response
    net = mic_net("mic", IDSS[0]) + \
        "Sb s 0 bc 0 SWB\nVbc bc 0 PWL(0 0 100m 0 100.1m 1)\n.model SWB SW(RON=70 ROFF=1e9 VT=0.5 VH=0.1)\n"
    rr = ctx.sim("b04", "button_step", net, "tran 0.1m 300m 0 0.1m", ["v(sense)"])
    thr = (s_mic + s_btn) / 2
    t_det = rr["x"][(rr["x"] > 0.1) & (rr["v(sense)"] < thr)]
    t_det = float(t_det[0] - 0.1) if len(t_det) else np.inf
    b.add("button press → MIC_SENSE below the mid threshold", si(t_det, "s"),
          "≤ 50 ms (debounce budget)", t_det <= 50e-3, "HW-FUNC-18")

    # ---- privacy: IO10 driven high while the mic is unpowered ----------------------------------
    net = mic_net("mic", IDSS[1], gpio="Vgpio g10 0 3.3\nRgp g10 sense 25\n").replace(
        f"Vmv mv 0 {MIC_VCC}", "Vmv mv 0 0")
    rr = ctx.sim("b04", "gpio_high", net, "tran 1m 200m 0 1m", ["i(vmv)", "v(s)", "v(micf)"])
    i_leak = float(np.max(np.abs(window(rr, "v(micf)", 0.1, 0.2)))) / 2.2e3
    b.add("IO10 driven high with the mic supply off: current pushed into the mic line",
          si(i_leak, "A"), "≤ 1 µA (an electret needs ≥ 0.1 mA to work; HW-PRIV-02/-03)",
          i_leak <= 1e-6, "HW-PRIV-03", key=True)

    # ---- insertion detect (analysis) -----------------------------------------------------------
    v_noplug = 3.3 * 10e3 / (1e6 + 10e3)
    v_plug = 3.3 - 1e6 * 50e-9     # ESP32 input leakage <= 50 nA (datasheet v2.2 p60)
    b.add("JACK_DET (IO12): no plug (TN closed onto the 10 k tip bleed) / plug inserted",
          f"{v_noplug * 1e3:.0f} mV / {v_plug:.2f} V", f"< VIL {VIL:.2f} V / > VIH {VIH:.2f} V",
          v_noplug < VIL and v_plug > VIH, "HW-FUNC-18")
    b.add("tip DC step when a plug is inserted (TN leaves the tip)", f"{v_noplug * 1e3:.0f} mV",
          "≤ 50 mV (no audible click)", v_noplug <= 50e-3, "HW-ELEC-26")
    b.add("mic-supply current into a shorted S (button held, OMTP plug)",
          si(MIC_VCC / 2.2e3, "A"), "≤ 2 mA (the 2.2 kΩ is the limit; no other current-limited "
          "output remains on the jack)", MIC_VCC / 2.2e3 <= 2e-3, "HW-ELEC-27, HW-SAFE-03")
    for c in b.checks:           # everything here is the H5 jack; the pre-H5 USB-C port is gone
        if c.scope == "both":
            c.scope = "proposal"
    return b
