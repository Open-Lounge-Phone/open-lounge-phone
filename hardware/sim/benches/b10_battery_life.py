"""B10: battery-life estimate (analysis, not SPICE) against decision 9: ≥ 8 h idle + 1 h talk on
the ~700 mAh 1S pack."""

from __future__ import annotations

from benchlib import Bench, Ctx

TITLE = "Battery life: 8 h idle + 1 h talk on a 700 mAh pack (analysis)"
REQS = "HW-ELEC-06; HW-FUNC-13"

PACK_MAH, V_NOM = 700, 3.7
USABLE = 0.85            # to the firmware cut-off (≈ 3.4 V) and after protection/aging margin
ETA_BUCK = 0.88          # TLV62569 at 40-150 mA, 3.7 -> 3.2 V (SLVSDG1C p9-10 efficiency curves)
V3 = 3.19                # proposed 3V3 set point (B2)


def p_rail(i33=0.0, i3v0=0.0, ivsys=0.0, v=V_NOM) -> float:
    """Battery-side power in W for loads on 3V3 (A), 3V0 (A, linear from VSYS) and VSYS (A).
    H5: the analog handset (earpiece + mic bias) is a 3V0 load; there is no handset boost."""
    return (i33 * V3 / ETA_BUCK + i3v0 * v + ivsys * v
            + 35e-6 * v + 23e-6 * v + 6.5e-6 * v)   # buck Iq, MAX17048, BQ24074 BAT sleep


SCEN = {
    # name: (idle W, talk W, note)
    "budget as written (DESIGN §9.2 idle, LED rail on)": (
        p_rail(i33=0.040 + 0.0005, i3v0=0.001, ivsys=0.013),
        p_rail(i33=0.140 + 0.0005, i3v0=0.010 + 0.010, ivsys=0.013 + 0.010),
        "ESP32 modem-sleep 40 mA, 13 × 1 mA LED quiescent, analog handset 10 mA from 3V0"),
    "proposed battery policy (LED rail off, Wi-Fi power save)": (
        p_rail(i33=0.015 + 0.0005, i3v0=0.0005, ivsys=0.0),
        p_rail(i33=0.120 + 0.0005, i3v0=0.010 + 0.010, ivsys=0.013 + 0.005),
        "ESP32 automatic light sleep, DTIM3 ≈ 15 mA average (UNVERIFIED, EVT); LEDs on only "
        "during the call"),
}


def run(ctx: Ctx) -> Bench:
    b = Bench("b10", TITLE, REQS,
              provenance=[
                  "Pack: 603040-class 1S, 700 mAh, 3.7 V nominal (LAYOUT.md battery pocket); 85 % "
                  "usable to the firmware cut-off.",
                  "Loads: DESIGN.md §9.2 budget rows (ESP32 idle 40 mA / call 140 mA at 3V3, "
                  "codecs + mic 25 mA, SK6812 1 mA quiescent each [R17 p6]); quiescent currents: "
                  "TLV62569 35 µA (SLVSDG1C p1), MAX17048 23 µA (max17048.md), BQ24074 BAT sleep "
                  "6.5 µA (SLUS810N p12); converter efficiencies from the TI curves.",
                  "Handset (H5): analog TRRS handset, earpiece ≈ 7 mA rms average speech + mic "
                  "bias ≤ 1.4 mA → 10 mA from 3V0 (b04); measure with the Opis 60s Micro.",
              ],
              assumptions=["Idle = on-hook, Wi-Fi associated, e-ink static, codecs powered down, "
                           "amp off; talk = handset call over Wi-Fi."])
    e_use = PACK_MAH / 1000 * V_NOM * USABLE
    b.add("usable pack energy", f"{e_use:.2f} Wh", "INFO", None, "HW-ELEC-06")
    for name, (pi, pt, note) in SCEN.items():
        need = 8 * pi + 1 * pt
        ok = need <= e_use
        hours_idle_after_talk = (e_use - pt) / pi
        b.add(f"{name}: idle {pi * 1e3:.0f} mW, talk {pt * 1e3:.0f} mW",
              f"8 h + 1 h needs {need:.2f} Wh; idle after 1 h talk {hours_idle_after_talk:.1f} h",
              f"≤ {e_use:.2f} Wh (decision 9)", ok, "HW-ELEC-06", note,
              scope="current" if name.startswith("budget") else "proposal", key=True)
    pt = SCEN["proposed battery policy (LED rail off, Wi-Fi power save)"][1]
    b.add("largest average idle power that still meets 8 h + 1 h", f"{(e_use - pt) / 8 * 1e3:.0f} mW",
          "INFO: firmware power budget on battery", None, "HW-ELEC-06")
    return b
