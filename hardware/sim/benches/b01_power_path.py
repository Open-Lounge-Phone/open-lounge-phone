"""B1: USB-C -> PTC/TVS -> BQ24074 power path: start-up, hot-plug, input limit, VSYS with and
without the battery, PTC hold current."""

from __future__ import annotations

import numpy as np

from benchlib import Bench, Ctx, at, si, window

TITLE = "USB-C → BQ24074 power path: start-up, hot-plug, input limit, VSYS"
REQS = "HW-ELEC-03, -04, -05, -10, -11; HW-FUNC-13; HW-SAFE-03"

# DC-bias derating (fraction of nominal left at the rail voltage). Samsung publishes curves only
# through its online tool (not reachable here), so these are typical class-II values used as an
# ASSUMPTION; every check is run with nominal and derated capacitance.
DERATE = {"10u0603@4.4": 0.55, "10u0603@5": 0.5, "100u1206@4.4": 0.4, "22u0805@4.4": 0.7,
          "1u0603@5": 0.8}

# VSYS loads (W at the rail) for the worst firmware-capped scenario (power_budget.yaml row
# worst_case_capped, re-split per rail). H5: the analog handset replaces the USB handset + boost.
P_BUCK_TX = 3.3 * 0.355 / 0.88    # ESP32 TX burst through the buck (355 mA, WROOM p28)
P_BUCK_IDLE = 3.3 * 0.06 / 0.88
P_LED_CAP = 4.4 * 0.142           # LEDs capped (budget row ringing_max)
P_AMP_RING = 1.0 / 0.88           # ringer: 1 W into the SP-2040 (its rating; B6 shows 0.63 W
                                  # meets 75 dBA at 1 m), class-D efficiency 88 % (NS4150B p3)
P_HANDSET = 3.0 * 0.015          # analog handset (H5): earpiece <= 14 mA rms + mic bias from 3V0


def caps(design: str, derated: bool) -> str:
    d = (lambda k: DERATE[k]) if derated else (lambda k: 1.0)
    if design == "current":   # schematic today: BQ OUT 2x10u, buck in 10u, LDO 1u, amp 100u+10u
        c = 20e-6 * d("10u0603@4.4") + 10e-6 * d("10u0603@4.4") + 1e-6 + \
            100e-6 * d("100u1206@4.4") + 10e-6 * d("10u0603@4.4") + 0.5e-6
    else:                      # proposal (FINDINGS-H4): BQ OUT 1x10u, buck in 10u, LDO 1u,
        #                        amp bulk 100u 1206 -> 22u 0805/25 V, amp 10u -> 1u (datasheet 1u)
        c = 10e-6 * d("10u0603@4.4") + 10e-6 * d("10u0603@4.4") + 1e-6 + \
            22e-6 * d("22u0805@4.4") + 1e-6 + 0.5e-6
    return f"Cvsys vsys 0 {c:.4g} ic=0\n"


def nominal_uF(design: str) -> float:
    return (20 + 10 + 1 + 100 + 10 + 0.5) if design == "current" else (10 + 10 + 1 + 22 + 1 + 0.5)


def front(vsrc: str, ptc: float, lcable: float = 0.6e-6, rcable: float = 0.1) -> str:
    return f"""Vsrc src 0 {vsrc}
Rsrc src c1 {0.05 + rcable}
Lcab c1 vbusc {lcable}
Cesd vbusc 0 {1e-6 * 0 + 10e-12}
Rptc vbusc vbus {ptc}
Dtvs 0 vbus SMF5V0A
Cin1 vbus 0 {10e-6 * DERATE['10u0603@5']} ic=0
Cin2 vbus 0 {1e-6 * DERATE['1u0603@5']} ic=0
Resr vbus vbusr 0.005
"""


def loads(profile: str) -> str:
    """Constant-power VSYS loads with a 3.0 V UVLO (below it the rail parts are off)."""
    on = "(V(vsys) > 3.0 ? 1 : 0)"
    if profile == "idle":
        p = P_BUCK_IDLE + 4.4 * 0.032
        return f"Bload vsys 0 I = {on}*{p:.4g}/max(V(vsys),1)\n"
    # worst capped: steady base + ringing amp (|sin| power at 2 kHz) + 1 ms TX bursts every 3 ms
    base = P_BUCK_IDLE + P_LED_CAP + P_HANDSET
    tx = P_BUCK_TX - P_BUCK_IDLE
    return (f"Bbase vsys 0 I = {on}*{base:.4g}/max(V(vsys),1)\n"
            f"Bamp vsys 0 I = {on}*(time > 4m ? 1 : 0)*{2 * P_AMP_RING:.4g}"
            f"*pow(sin(6.2832*1000*time),2)/max(V(vsys),1)\n"
            f"Btx vsys 0 I = {on}*(time > 5m ? 1 : 0)*((time - 5m) - 3m*floor((time-5m)/3m) < 1m ? 1 : 0)"
            f"*{tx:.4g}/max(V(vsys),1)\n")


def run(ctx: Ctx) -> Bench:
    b = Bench("b01", TITLE, REQS,
              provenance=[
                  "BQ24074: behavioural model `BQ24074_BEH` (models/olp_behavioural.lib) from "
                  "TI SLUS810N p12 (VO(REG), VDO, K_ILIM, VBSUP1, VO(SC1), VDPPM) and p19 "
                  "(start-up sequence) — https://www.ti.com/lit/ds/symlink/bq24074.pdf; TI lists no "
                  "SPICE model for the part (https://www.ti.com/product/BQ24074, checked 2026-09-29).",
                  "SMF5.0A: diode with BV 6.7 V, RS 0.115 Ω (VBR 6.4–7.0 V @ 10 mA, VC 9.2 V @ "
                  "21.7 A, Littelfuse SMF datasheet p2).",
                  "PTC SMD1206P150TF: 0.04–0.12 Ω; hold 1.34 A at 40 °C (PTTC rev K p2, p4).",
              ],
              assumptions=[
                  "USB-C cable 1 m: 0.6 µH loop inductance, 0.1 Ω (VBUS+GND, AWG28-class); source "
                  "output resistance 50 mΩ; hot-plug is an ideal 1 ns step (worst case).",
                  "MLCC DC-bias derating (assumption, Samsung curves not reachable): 10 µF/0603/10 V "
                  "55 % left at 4.4 V, 50 % at 5 V; 100 µF/1206/6.3 V 40 %; 22 µF/0805/25 V 70 %.",
                  "VSYS loads are constant-power (buck and boost regulate), 3.0 V UVLO; worst "
                  "capped profile = ESP32 TX 355 mA bursts (1 ms every 3 ms) + ringing amp "
                  "(1 kHz tone, 2.07 W average) + LEDs 142 mA + analog handset 15 mA from 3V0.",
                  "Pack: 3.7 V, 150 mΩ internal (603040-class incl. protection FETs).",
              ])

    # --- 1. cold start, no battery, 5.0 V source, ILIM typ, both capacitor designs --------------
    for design in ("current", "proposed"):
        net = (front("PWL(0 0 100u 5.0)", 0.08) + caps(design, True) +
               "Xbq vbus vsys bat 0 BQ24074_BEH PARAMS: ILIM=1.46 CHG=0\n"
               "Cbat bat 0 4.7u ic=0\nRbat bat 0 1meg\n" + loads("idle"))
        r = ctx.sim("b01", f"start_{design}", net, "tran 1u 12m 0 1u uic",
                    ["v(vsys)", "v(vbus)", "i(vsrc)"])
        t_up = r["x"][np.argmax(r["v(vsys)"] > 4.3)] if (r["v(vsys)"] > 4.3).any() else np.inf
        b.add(f"start-up to VSYS ≥ 4.3 V, no pack ({design} caps)", si(t_up, "s"), "≤ 10 ms",
              t_up <= 10e-3, "HW-ELEC-10, -11",
              "includes the 100 mA short-circuit phase until OUT > 0.9 V (SLUS810N p19)")
        ipk = float(np.max(-r["i(vsrc)"]))
        b.add(f"attach inrush peak from the source ({design} caps)", si(ipk, "A"),
              "INFO (input MLCCs charge before the charger starts)", None, "HW-ELEC-05")

    cin = 10e-6 * DERATE["10u0603@5"] + 1e-6 * DERATE["1u0603@5"]
    b.add("VBUS input capacitance seen at attach (effective at 5 V)", si(cin, "F"),
          "≤ 10 µF (USB 2.0 §7.2.4.1 attach load)", cin <= 10e-6, "HW-ELEC-01, -05",
          "nominal 11 µF; the charger input is gated until the 100 mA soft start (p19)")

    # --- 2. hot-plug overshoot at VBUS (5.25 V step into the input caps) ------------------------
    for l, r_ in ((0.6e-6, 0.1), (1.5e-6, 0.05)):
        net = front("PWL(0 0 1n 5.25)", 0.04, l, r_) + caps("proposed", True) + \
            "Xbq vbus vsys bat 0 BQ24074_BEH PARAMS: ILIM=1.56 CHG=0\nCbat bat 0 4.7u ic=0\n"
        rr = ctx.sim("b01", f"hotplug_{int(l * 1e9)}n", net, "tran 2n 60u 0 2n uic",
                     ["v(vbus)", "v(vbusc)"])
        pk = float(np.max(rr["v(vbus)"]))
        b.add(f"hot-plug peak at VBUS, cable {l * 1e6:.1f} µH / {r_} Ω", si(pk, "V"),
              "< 10 V (C19702 10 V rating; BQ24074 OVP 10.2 V min, p12)", pk < 10.0,
              "HW-ELEC-04", "SMF5.0A clamps; the input MLCC is the lowest-rated part on VBUS")

    # --- 3. worst capped load, no battery, 4.75 V source, ILIM min corner ----------------------
    for design in ("current", "proposed"):
        net = (front("PWL(0 0 100u 4.75)", 0.12) + caps(design, True) +
               "Xbq vbus vsys bat 0 BQ24074_BEH PARAMS: ILIM=1.36 VOREG=4.3 RDO=0.475 CHG=0\n"
               "Cbat bat 0 4.7u ic=0\nRbat bat 0 1meg\n" + loads("worst"))
        r = ctx.sim("b01", f"worst_{design}", net, "tran 2u 20m 0 2u uic",
                    ["v(vsys)", "i(vsrc)"])
        vmin = float(np.min(window(r, "v(vsys)", 6e-3, 20e-3)))
        tt = np.arange(6e-3, 20e-3, 2e-6)
        ii = -np.interp(tt, r["x"], r["i(vsrc)"])
        iin = float(np.max(np.convolve(ii, np.ones(500) / 500, mode="valid")))  # 1 ms average
        ipk = float(np.max(ii))
        b.add(f"VSYS min, worst capped load, no pack, 4.75 V source ({design} caps)", si(vmin, "V"),
              "≥ 3.7 V (SK6812 VDD min [R17 p5]; buck headroom)", vmin >= 3.7, "HW-ELEC-10",
              key=design == "proposed")
        b.add(f"input current, 1 ms average, worst capped load ({design} caps)", si(iin, "A"),
              "≤ 1.36 A × 0.9 (ILIM guaranteed min − 10 %)", iin <= 1.36 * 0.9, "HW-ELEC-04, -05",
              f"instantaneous peak {si(ipk, 'A')}: short excursions are carried by the VSYS caps "
              "(VSYS min check above)")

    # --- 4. battery present: unplug at 6 ms, replug at 12 ms, worst load -----------------------
    net = (front("PWL(0 0 100u 5.0 6m 5.0 6.001m 0 12m 0 12.001m 5.0)", 0.08) + caps("proposed", True) +
           "Xbq vbus vsys bat 0 BQ24074_BEH PARAMS: ILIM=1.46 CHG=1\n"
           "Vpack pk 0 3.7\nRpack pk bat 0.15\nCbat bat 0 4.7u\n" + loads("worst"))
    r = ctx.sim("b01", "unplug", net, "tran 2u 20m 0 2u uic", ["v(vsys)", "i(vpack)"])
    vmin = float(np.min(window(r, "v(vsys)", 5.5e-3, 20e-3)))
    b.add("VSYS min across unplug/replug with a 3.7 V pack, worst load", si(vmin, "V"),
          "≥ 3.3 V (firmware shutdown threshold, tlv62569.md)", vmin >= 3.3, "HW-FUNC-13")
    ichg = float(np.mean(window(r, "i(vpack)", 2e-3, 4e-3)))
    b.add("pack current before the worst load starts (charging)", si(ichg, "A"),
          "INFO: ≈ −0.49 A = charging at ISET (K_ISET/R_ISET, p8)", None, "HW-FUNC-13")

    # --- 5. PTC: sustained charger input at the ILIM max corner vs hold current at 40 °C -------
    net = (front("PWL(0 0 100u 5.25)", 0.04) + caps("proposed", False) +
           "Xbq vbus vsys bat 0 BQ24074_BEH PARAMS: ILIM=1.56 CHG=1\n"
           "Vpack pk 0 3.6\nRpack pk bat 0.15\nCbat bat 0 4.7u\n"
           "Bl vsys 0 I = 6.0/max(V(vsys),1)\n")   # uncapped load (budget worst_case_uncapped)
    r = ctx.sim("b01", "ptc", net, "tran 5u 6m 0 5u uic", ["i(vsrc)"])
    iptc = float(np.mean(window(r, "i(vsrc)", 4e-3, 6e-3)) * -1)
    b.add("PTC current, uncapped load + charging, ILIM max corner (current: 1206 1.5 A)",
          si(iptc, "A"), "≤ 1.34 A (SMD1206P150 hold at 40 °C, PTTC p4)", iptc <= 1.34,
          "HW-ELEC-04, HW-SAFE-03", "F-07", key=True)
    b.add("PTC current vs hold at 40 °C (proposed: SMD1812P200TF16, C20812)", si(iptc, "A"),
          "≤ 1.80 A (hold at 40 °C, Ruilon SMD1812 SP-PTC-008 rev A6 p6)",
          iptc <= 1.80, "HW-ELEC-04, HW-SAFE-03", "16 V rated, 2 A hold / 4 A trip (p4), 29.9 k at JLC")

    # --- 6. OUT capacitance vs the datasheet range ---------------------------------------------
    for design in ("current", "proposed"):
        c = nominal_uF(design)
        b.add(f"BQ24074 OUT capacitance, nominal ({design})", f"{c:.1f} µF",
              "4.7–47 µF (SLUS810N p8)", 4.7 <= c <= 47, "HW-ELEC-10",
              "the 44 µF VLED bank adds when the LED switch is on (B9 proposes 10 µF)")
    return b
