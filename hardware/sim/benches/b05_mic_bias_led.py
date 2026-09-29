"""B5: base-mic supply with the privacy light (decision 1): series LED vs the two-LED parallel
fallback; electret headroom over LED VF spread and temperature; mute switch opening."""

from __future__ import annotations

import numpy as np

from benchlib import Bench, Ctx, si, window

TITLE = "Mic supply + privacy light: series LED vs parallel fallback, mute opening"
REQS = "HW-PRIV-01, -02; HW-FUNC-09, -11; HW-ELEC-13"

VS_MIN = 1.5        # GMI6027 p2: sensitivity within -3 dB for 1.5-3 V supply through 2.2 kOhm
I_VISIBLE = 0.2e-3  # proposed visibility floor: 0603 red, 145-300 mcd @ 20 mA -> >= 1.5 mcd


def mic(node: str, idss: float) -> str:
    """Electret JFET: constant current IDSS once VDS > ~0.3 V (datasheet: <= 0.5 mA)."""
    return f"Bmic {node} 0 I = {idss}*tanh(max(V({node}),0)/0.15)\n"


def series_net(led: str, idss: float) -> str:
    # 3V0 -> 100R/10uF filter -> MUTE pole A -> MIC_VCC (100 nF) -> LED (series) -> 2.2k ->
    # electret; 10k keep-alive after the LED. The filter sits BEFORE the switch, so opening
    # MUTE leaves only 100 nF on the mic side.
    return f"""V3v0 v3 0 2.94
Rf v3 filt 100
Cf filt 0 8u
Smute filt sw ctl 0 SMUTE
Vctl ctl 0 PWL(0 1 5m 1 5.001m 0)
.model SMUTE SW(RON=0.05 ROFF=1e9 VT=0.5 VH=0.1)
Cmv sw 0 100n
D1 sw ka {led}
Rka ka 0 10k
Rl ka mic 2.2k
Cmic mic 0 33p
{mic("mic", idss)}"""


def parallel_net(led: str, idss: float, open_led: int = 0) -> str:
    # 3V0 -> 100R/10uF -> MUTE pole A -> MIC_VCC (100 nF); two LEDs (each 1k) on MIC_VCC;
    # 2.2k -> electret
    d2 = "" if open_led == 2 else f"D2 sw a2 {led}\nR2 a2 0 1k\n"
    d1 = "" if open_led == 1 else f"D1 sw a1 {led}\nR1 a1 0 1k\n"
    return f"""V3v0 v3 0 2.94
Rf v3 filt 100
Cf filt 0 8u
Smute filt sw ctl 0 SMUTE
Vctl ctl 0 PWL(0 1 5m 1 5.001m 0)
.model SMUTE SW(RON=0.05 ROFF=1e9 VT=0.5 VH=0.1)
Cmv sw 0 100n
{d1}{d2}Rl sw mic 2.2k
Cmic mic 0 33p
{mic("mic", idss)}"""


def run(ctx: Ctx) -> Bench:
    b = Bench("b05", TITLE, REQS,
              provenance=[
                  "Electret GMI6027-2C42DB: ≤ 0.5 mA, rated 2.0 V through RL 2.2 kΩ, "
                  "sensitivity within −3 dB from 1.5 to 3 V supply (INGHAi spec V1.0 p2, "
                  "https://datasheet.lcsc.com/datasheet/pdf/5872a0bccdf594f00205a63a6e86a424.pdf); "
                  "modelled as a JFET current source 0.1–0.5 mA.",
                  "LED KT-0603R: VF 1.8–2.4 V at 20 mA (KENTO spec A.0 p3); diode fits "
                  "LED_RED_MIN/TYP/MAX (N = 2, RS = 10 Ω, EG 1.9 eV → ≈ −1.8 mV/K), "
                  "models/olp_behavioural.lib.",
                  "3V0 at its −2 % corner, 2.94 V (LP5907 p5). The mic supply is taken from 3V0 "
                  "through MUTE pole A (the ES7210 MICBIAS voltage/current is unspecified, "
                  "es7210.md, so it is not used).",
              ],
              assumptions=[
                  "Visibility floor for the 0603 red LED behind a Ø2 light pipe: 0.2 mA "
                  "(≈ 1.5–3 mcd scaled linearly from 145–300 mcd at 20 mA); owner/EVT to confirm.",
                  "Filter capacitor 10 µF 0603 X5R at 3 V → 8 µF effective.",
                  "'Mic live with the light off' is judged as supply at the capsule ≥ 1.0 V while "
                  "every LED carries < 20 µA.",
              ])

    corners = [(led, t, idss) for led in ("LED_RED_MIN", "LED_RED_MAX") for t in (0, 40)
               for idss in (0.1e-3, 0.5e-3)]
    # ---- series LED --------------------------------------------------------------------------
    worst_vs, worst_i = 9.0, 9.0
    for led, t, idss in corners:
        r = ctx.sim("b05", f"series_{led}_{t}_{idss * 1e6:.0f}", series_net(led, idss),
                    ["option temp=%d" % t, "tran 10u 4.9m 0 10u"], ["v(ka)", "i(v3v0)", "v(mic)"])
        vs = float(r["v(ka)"][-1])
        iled = -float(r["i(v3v0)"][-1])
        worst_vs, worst_i = min(worst_vs, vs), min(worst_i, iled)
    b.add("series LED: worst supply at the electret (top of 2.2 kΩ)", si(worst_vs, "V"),
          f"≥ {VS_MIN} V (GMI6027 p2)", worst_vs >= VS_MIN, "HW-PRIV-02, HW-ELEC-13",
          "corners: LED VF min/max × 0/40 °C × IDSS 0.1/0.5 mA", scope="alt", key=True)
    b.add("series LED: worst LED current", si(worst_i, "A"), f"≥ {si(I_VISIBLE, 'A')} visible",
          worst_i >= I_VISIBLE, "HW-FUNC-11", scope="alt")
    series_ok = worst_vs >= VS_MIN

    # ---- parallel fallback (two LEDs, each with its own 1 kΩ) --------------------------------
    worst_vs, worst_i, worst_i1 = 9.0, 9.0, 9.0
    for led, t, idss in corners:
        r = ctx.sim("b05", f"par_{led}_{t}_{idss * 1e6:.0f}", parallel_net(led, idss),
                    ["option temp=%d" % t, "tran 10u 4.9m 0 10u"], ["v(mic)", "v(a1)", "v(sw)"])
        vs = float(r["v(sw)"][-1])
        worst_vs = min(worst_vs, vs)
        worst_i = min(worst_i, float(r["v(a1)"][-1]) / 1e3)
    b.add("parallel fallback: worst supply at the electret", si(worst_vs, "V"),
          f"≥ {VS_MIN} V", worst_vs >= VS_MIN, "HW-PRIV-02, HW-ELEC-13", key=True,
          scope="proposal")
    b.add("parallel fallback: worst current per LED", si(worst_i, "A"),
          f"≥ {si(I_VISIBLE, 'A')} visible", worst_i >= I_VISIBLE, "HW-FUNC-11", scope="proposal")
    # single fault: one LED open -> the other still lit
    r = ctx.sim("b05", "par_open_led1", parallel_net("LED_RED_MAX", 0.5e-3, open_led=1),
                ["option temp=40", "tran 10u 4.9m 0 10u"], ["v(a2)"])
    i2 = float(r["v(a2)"][-1]) / 1e3
    b.add("FMEA: one LED open, the other still lit", si(i2, "A"), f"≥ {si(I_VISIBLE, 'A')}",
          i2 >= I_VISIBLE, "HW-PRIV-02", scope="proposal")

    # ---- mute opening (at 5 ms): does the light go out before the mic loses power? ----------
    for name, net, probes in (
            ("series", series_net("LED_RED_MIN", 0.1e-3), ["v(ka)", "v(mic)"]),
            ("parallel", parallel_net("LED_RED_MIN", 0.1e-3), ["v(sw)", "v(a1)"])):
        r = ctx.sim("b05", f"mute_{name}", net, "tran 10u 150m 0 10u", probes)
        t = r["x"]
        vs = r[probes[0]]
        il = (r["v(ka)"] / 10e3 + (r["v(ka)"] - r["v(mic)"]) / 2.2e3) if name == "series" \
            else r["v(a1)"] / 1e3
        dark_live = (t > 5e-3) & (vs >= 1.0) & (il < 20e-6)
        dt = float(np.sum(np.diff(t)[dark_live[1:]])) if dark_live.any() else 0.0
        t_off = t[(t > 5e-3) & (vs < 0.5)]
        t_off = float(t_off[0] - 5e-3) if len(t_off) else np.inf
        sc = "alt" if name == "series" else "proposal"
        b.add(f"mute opens ({name}): time the mic is live (≥ 1.0 V) with the light off",
              si(dt, "s"), "≤ 10 ms (imperceptible)", dt <= 10e-3, "HW-PRIV-01, -02", scope=sc)
        b.add(f"mute opens ({name}): capsule supply below 0.5 V after", si(t_off, "s"),
              "≤ 100 ms", t_off <= 100e-3, "HW-PRIV-01", scope=sc)
    b.add("current schematic: LED fed from 3V3, sunk by an NPN sensing the bias", "LED/R/Q1 open "
          "→ mic powered, light off", "single fault must not hide a live mic", False,
          "HW-PRIV-02", "F-09 (FMEA, no simulation needed)", scope="current")
    b.notes.append("Decision from the data: " + (
        "the series LED keeps ≥ 1.5 V at the electret in every corner — keep it." if series_ok else
        "a red LED in series leaves < 1.5 V for the electret from a 3.0 V rail at the "
        "VF/temperature corners, so the approved fallback applies: two LEDs in parallel on the "
        "switched mic supply MIC_VCC (each with 1 kΩ). The light is powered only from the mic's "
        "own supply, one open LED leaves the other lit, and with the RC filter moved in front "
        "of the MUTE switch the mic side holds only 100 nF, so light and mic go dark together."))
    return b
