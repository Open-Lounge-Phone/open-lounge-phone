"""B5 (H5): the hardware privacy chain for the HANDSET mic (owner 2026-09-30): 3V0 -> 100 ohm /
10 uF -> MUTE pole A -> AO3401A (gate pulled by an AO3400A driven by HOOK) -> MIC_VCC -> two mic
lights in parallel (H4 b05 fallback) + 2.2 k -> cord -> handset electret. Checks the capsule
headroom and the lights over LED VF / temperature / capsule corners, that MUTE and hang-up each
darken light and mic together, a single-fault FMEA, and that firmware cannot override it
(IO17 driven high while on-hook, IO10 driven high)."""

from __future__ import annotations

import numpy as np

from benchlib import Bench, Ctx, si, window

TITLE = "Privacy chain: mute AND hook -> handset-mic supply -> two mic lights"
REQS = "HW-PRIV-01, -02, -03; HW-FUNC-09, -11; HW-ELEC-13"

VS_MIN = 1.5        # typical electret: rated 1.5-3 V through 2.2 kOhm (assumption for the handset)
I_VISIBLE = 0.2e-3  # visibility floor, 0603 red behind a light pipe (H4 assumption, EVT to confirm)
T_MUTE, T_HANG = 5e-3, 15e-3

MODELS = """.model AO3401 PMOS(LEVEL=1 VTO=-0.9 KP=4.6 W=1 L=1 RD=0.005 RS=0.005)
.model AO3400 NMOS(LEVEL=1 VTO={vtn} KP=10 W=1 L=1 RD=0.005 RS=0.005)
.model SMUTE SW(RON=0.05 ROFF=1e9 VT=0.5 VH=0.1)
.model SOD SW(RON=100 ROFF=1e9 VT=0.5 VH=0.1)
.model D1N4148 D(IS=2.52n RS=0.568 N=1.752 CJO=4p M=0.4 TT=20n BV=100 IBV=100u)
"""


def mic(node: str, idss: float) -> str:
    """Handset electret JFET: constant current IDSS once VDS > ~0.3 V (typical <= 0.5 mA)."""
    return f"Bmic {node} 0 I = {idss}*tanh(V({node})/0.15)\n"


def chain(led: str, idss: float, open_led: int = 0, short: str = "", vtn: float = 1.05,
          magnet: str = "PWL(0 0 15m 0 15.001m 1)",
          mute: str = "PWL(0 1 5m 1 5.001m 0)", gpio17: str = "") -> str:
    """HOOK is modelled at the net: DRV5032AJ open drain (100 ohm on-resistance behind the 100
    ohm series R) against the 100k pull-up; 'magnet' drives the sensor's switch (1 = magnet
    present = on-hook). GPIO17 reaches HOOK through 47k."""
    d1 = ("" if open_led == 1 else f"D1 mv a1 {led}\n") + "R1 a1 0 1k\n"
    d2 = ("" if open_led == 2 else f"D2 mv a2 {led}\n") + "R2 a2 0 1k\n"
    faults = {"q5": "Rq5f mm mv 0.1\n", "q6": "Rq6f g 0 0.1\n", "led_short": "Rls mv a1 0.1\n"}
    return MODELS.format(vtn=vtn) + f"""V3v0 v3 0 2.94
Rf v3 filt 100
Cf filt 0 8u
Smute filt mm mctl 0 SMUTE
Vmctl mctl 0 {mute}
M5 mv g mm mm AO3401
Cgs5 g mm 590p
Rgs mm g 100k
M6 g hook 0 0 AO3400
Cg6 hook 0 630p
Rpu hook h33 100k
Vh33 h33 0 3.3
Chk hook 0 1n
Rser hook od 100
Sod od 0 hctl 0 SOD
Vhctl hctl 0 {magnet}
{gpio17}Cmv mv 0 100n
{d1}{d2}Rl mv micf 2.2k
Cmf micf 0 100p
Rcord micf s 0.2
{mic("s", idss)}Dsen micf sd D1N4148
Rsd sd sense 100k
Rpd sense 0 1meg
Csn sense 0 10n
{faults.get(short, "")}"""


def run(ctx: Ctx) -> Bench:
    b = Bench("b05", TITLE, REQS,
              provenance=[
                  "Handset electret: typical capsule, IDSS 0.1–0.5 mA, rated 1.5–3 V through "
                  "2.2 kΩ (ASSUMPTION: the Opis 60s Micro publishes no mic data; same class as "
                  "the GMI6027, INGHAi V1.0 p2).",
                  "LED KT-0603R: VF 1.8–2.4 V at 20 mA (KENTO spec A.0 p3), diode fits "
                  "LED_RED_MIN/TYP/MAX (models/olp_behavioural.lib, as H4).",
                  "AO3401A: level-1 PMOS, VGS(th) −0.9 V, 60 mΩ at −4.5 V, Ciss 645 pF (AOS rev "
                  "3.1 p1-p2, as b09). AO3400A: level-1 NMOS, VGS(th) 0.65–1.45 V (1.05 typ), "
                  "Ciss 630 pF (AOS AO3400A datasheet p1-p2); both corners of VGS(th) are run.",
                  "DRV5032AJ: open-drain output, modelled as a 100 Ω switch to GND when the "
                  "magnet is present (the datasheet gives VOL at 1 mA; SLVSDC7H p5).",
                  "3V0 at its −2 % corner (2.94 V, LP5907 p5); 10 µF 0603 → 8 µF effective.",
              ],
              assumptions=[
                  "Visibility floor 0.2 mA per LED (H4 b05 assumption; EVT to confirm).",
                  "'Mic live with the lights dark' = capsule supply ≥ 1.0 V while every LED "
                  "carries < 20 µA.",
                  "Only single faults are analysed (FMEA); the ES8311 input (6 kΩ to VMID behind "
                  "the 1 µF coupling cap) is outside the chain unless that cap shorts (see notes).",
              ])

    corners = [(led, t, idss) for led in ("LED_RED_MIN", "LED_RED_MAX") for t in (0, 40)
               for idss in (0.1e-3, 0.5e-3)]
    worst_vs, worst_i = 9.0, 9.0
    for led, t, idss in corners:
        r = ctx.sim("b05", f"dc_{led}_{t}_{idss * 1e6:.0f}", chain(led, idss),
                    ["option temp=%d" % t, "tran 10u 4.9m 0 10u"], ["v(s)", "v(a1)", "v(a2)"])
        worst_vs = min(worst_vs, float(r["v(s)"][-1]))
        worst_i = min(worst_i, float(r["v(a1)"][-1]) / 1e3, float(r["v(a2)"][-1]) / 1e3)
    b.add("worst supply at the handset capsule (unmuted, off-hook)", si(worst_vs, "V"),
          f"≥ {VS_MIN} V", worst_vs >= VS_MIN, "HW-PRIV-02, HW-ELEC-13", key=True,
          note="corners: LED VF min/max × 0/40 °C × IDSS 0.1/0.5 mA")
    b.add("worst current per mic light", si(worst_i, "A"), f"≥ {si(I_VISIBLE, 'A')} visible",
          worst_i >= I_VISIBLE, "HW-FUNC-11")

    # ---- transients: MUTE opens at 5 ms (hook off); then separately, hang-up at 15 ms ----------
    for name, kw, t0 in (("mute", dict(magnet="PWL(0 0)"), T_MUTE),
                         ("hang-up", dict(mute="PWL(0 1)"), T_HANG)):
        net = chain("LED_RED_MIN", 0.1e-3, **kw)
        r = ctx.sim("b05", f"tr_{name}", net, "tran 5u 60m 0 5u", ["v(s)", "v(a1)", "v(a2)"])
        t, vs = r["x"], r["v(s)"]
        il = np.maximum(r["v(a1)"], r["v(a2)"]) / 1e3
        dark_live = (t > t0) & (vs >= 1.0) & (il < 20e-6)
        dt = float(np.sum(np.diff(t)[dark_live[1:]])) if dark_live.any() else 0.0
        t_off = t[(t > t0) & (vs < 0.5)]
        t_off = float(t_off[0] - t0) if len(t_off) else np.inf
        b.add(f"{name}: time the mic is live (≥ 1.0 V) with both lights dark", si(dt, "s"),
              "≤ 10 ms (imperceptible)", dt <= 10e-3, "HW-PRIV-01, -02, -03", key=name == "hang-up")
        b.add(f"{name}: capsule supply below 0.5 V after", si(t_off, "s"), "≤ 100 ms",
              t_off <= 100e-3, "HW-PRIV-01, -03")
    b.add("hook sensor latency (DRV5032, 20 Hz sampling)", "≤ 75 ms (SLVSDC7H p5)",
          "INFO: adds to the hang-up time above; the lights follow the mic either way", None,
          "HW-FUNC-08")

    # ---- single-fault FMEA: can any single fault leave the mic powered with the lights dark? --
    faults = [("LED 1 open", dict(open_led=1)), ("LED 1 shorted", dict(short="led_short")),
              ("hook P-FET Q5 D–S short (hook bypassed)", dict(short="q5",
                                                               magnet="PWL(0 1)")),
              ("hook N-FET Q6 D–S short (hook bypassed)", dict(short="q6", magnet="PWL(0 1)"))]
    for label, kw in faults:
        r = ctx.sim("b05", "fmea_" + label.split()[0] + label.split()[1],
                    chain("LED_RED_MAX", 0.5e-3, **{**kw, "mute": kw.get("mute", "PWL(0 1)")}),
                    ["option temp=40", "tran 10u 4.9m 0 10u"], ["v(s)", "v(a1)", "v(a2)", "v(mv)"])
        vs = float(r["v(s)"][-1])
        il = max(float(r["v(a1)"][-1]) if "open" not in label else 0.0, float(r["v(a2)"][-1])) / 1e3
        live = vs >= 1.0
        ok = (not live) or il >= I_VISIBLE
        b.add(f"FMEA: {label}", f"capsule {vs:.2f} V, brightest light {si(il, 'A')}",
              "mic live ⇒ a light ≥ 0.2 mA (HW-PRIV-02)", ok, "HW-PRIV-02, -03",
              note="the fault is visible: the lights show the mic powered" if live else "")

    # ---- firmware cannot override ---------------------------------------------------------------
    for vtn in (0.65, 1.05):
        net = chain("LED_RED_TYP", 0.5e-3, magnet="PWL(0 1)", mute="PWL(0 1)", vtn=vtn,
                    gpio17="Vg17 g17 0 3.3\nRg17 g17 hook 47k\n")
        r = ctx.sim("b05", f"gpio17_high_{vtn}", net, "tran 10u 4.9m 0 10u",
                    ["v(hook)", "v(s)", "v(mv)"])
        vh, vs = float(r["v(hook)"][-1]), float(r["v(s)"][-1])
        b.add(f"on-hook, IO17 driven high through 47 kΩ (AO3400A VGS(th) {vtn} V corner)",
              f"HOOK {si(vh, 'V')}, capsule {si(vs, 'V')}", "HOOK < VGS(th) min 0.65 V and mic "
              "unpowered (< 0.1 V)", vh < 0.65 and vs < 0.1, "HW-PRIV-03", key=vtn == 0.65)
    net = chain("LED_RED_TYP", 0.5e-3, mute="PWL(0 0)") + "Vg10 g10 0 3.3\nRg10 g10 sense 25\n"
    r = ctx.sim("b05", "gpio10_high_muted", net, "tran 10u 4.9m 0 10u", ["v(s)", "v(micf)"])
    vs = float(r["v(s)"][-1])
    b.add("muted, IO10 (mic sense) driven high", f"capsule {si(vs, 'V')}",
          "< 0.1 V (the 1N4148W blocks current into the mic line)", vs < 0.1, "HW-PRIV-01")
    for c in b.checks:
        if c.scope == "both":
            c.scope = "proposal"
    b.add("pre-H5 schematic: base-mic light fed from 3V3 and sunk by an NPN sensing the bias; "
          "handset VBUS gated by GPIO only", "LED/R/Q1 open → mic powered, light off; firmware "
          "could power the handset on-hook", "single fault / firmware must not hide a live mic",
          False, "HW-PRIV-02, -03", "F-09, F-04", scope="current")
    b.notes.append("Residual single-fault path outside the chain: if the 1 µF MIC1P coupling "
                   "capacitor shorts, the ES8311 input (6 kΩ to its internal VMID ≈ 1.5 V) could "
                   "weakly bias the capsule with the lights dark. That needs a component fault "
                   "and firmware enabling the ADC; a 2 × 2.2 µF series pair would close it "
                   "(H6 option, owner).")
    b.notes.append("At power-up HOOK is pulled high until the DRV5032 takes its first sample "
                   "(tens of µs), so the mic and the lights may blink together once at boot.")
    return b
