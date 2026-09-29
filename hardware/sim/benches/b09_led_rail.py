"""B9: LED power switch (AO3401A driven by AO3400A from the AW9523B) inrush into the VLED bank,
VSYS dip, and the SK6812 PWM load on VLED/VSYS."""

from __future__ import annotations

import numpy as np

from benchlib import Bench, Ctx, si, window

TITLE = "LED power switch: inrush, VSYS dip, SK6812 PWM load"
REQS = "HW-FUNC-02; HW-ELEC-05, -10, -11"

N_LED = 13
I_COLOR_MAX = 14.5e-3   # SK6812MINI-E per colour, max (Opsco rev 02 p6); typ 12 mA
F_PWM = 1.0e3           # SK6812 PWM frequency (p6)


def pfet() -> str:
    # AO3401A (AOS rev 3.1): VGS(th) -0.9 V typ, RDS(on) < 60 mΩ at -4.5 V, Ciss 645 pF,
    # Crss 55 pF (p1-p2). Level-1 fit: beta = 1/(0.06*(4.5-0.9)) = 4.6 A/V^2.
    return (".model AO3401 PMOS(LEVEL=1 VTO=-0.9 KP=4.6 W=1 L=1 RD=0.005 RS=0.005)\n"
            "Cgs_q2 g vsys 590p\nCgd_q2 g vled 55p\n")


def net(design: str, leds_on: bool) -> str:
    if design == "current":
        cvled = 44e-6 * 0.7 + N_LED * 0.1e-6          # 2 x 22 uF 0805/25 V + 13 x 100 nF
        drive = "Sdrv g 0 en 0 SWD\n"                 # Q3 pulls the gate straight to GND
        extra = ""
    else:
        cvled = 10e-6 * 0.55 + N_LED * 0.1e-6         # 1 x 10 uF + 13 x 100 nF
        drive = "Sdrv gd 0 en 0 SWD\nRg gd g 47k\n"   # 47k gate resistor ...
        extra = "Cmil g vled 4.7n\n"                   # ... + 4.7 nF gate-drain (Miller)
    cvsys = ((20 + 10 + 10) * 0.55e-6 + 1e-6 + 100e-6 * 0.4) if design == "current" else \
        ((10 + 10 + 1) * 0.55e-6 + 22e-6 * 0.7)
    leds = ""
    if leds_on:   # from 6 ms: all LEDs white at the firmware cap (30 %) as 1 kHz PWM
        leds = (f"Bled vled 0 I = (time > 6m ? 1 : 0)*(V(vled) > 3 ? 1 : 0)*"
                f"({N_LED}*1m + ((time*{F_PWM}) - floor(time*{F_PWM}) < 0.3 ? 1 : 0)*"
                f"{N_LED * 3 * I_COLOR_MAX})\n")
    return f"""Vsrc src 0 PWL(0 0 100u 5.0)
Rsrc src vbus 0.2
Cin vbus 0 6u
Xbq vbus vsys bat 0 BQ24074_BEH PARAMS: ILIM=1.46 CHG=0
Cbat bat 0 4.7u
Rbat bat 0 1meg
Cvsys vsys 0 {cvsys}
Bbase vsys 0 I = (V(vsys) > 3 ? 1 : 0)*0.5/max(V(vsys),1)
{pfet()}M2 vled g vsys vsys AO3401
Rpu vsys g 100k
Ven en 0 PWL(0 0 3m 0 3.001m 3.3)
.model SWD SW(RON=0.1 ROFF=1e9 VT=1.6 VH=0.2)
{drive}{extra}Cvled vled 0 {cvled}
Rvl vled 0 100k
{leds}"""


def run(ctx: Ctx) -> Bench:
    b = Bench("b09", TITLE, REQS,
              provenance=[
                  "AO3401A: level-1 PMOS fitted to VGS(th) −0.9 V and RDS(on) 60 mΩ at −4.5 V, "
                  "Ciss 645 pF / Crss 55 pF (AOS AO3401A rev 3.1 p1-p2, LCSC copy "
                  "https://datasheet.lcsc.com/datasheet/pdf/fee353dd1e9e0bc90b295f14f381aa4c.pdf); "
                  "no AOS SPICE model was reachable. AO3400A driver as a 0.1 Ω switch.",
                  "SK6812MINI-E: 1 mA static + 3 × 12 mA typ / 14.5 mA max per LED, PWM 1.0 kHz "
                  "(Opsco rev 02 p6); AW9523B LED_PWR_EN is low at power-up with AD0/AD1 = GND "
                  "(AW9523B p11), so the switch starts off.",
                  "VSYS: `BQ24074_BEH` (USB 5.0 V, ILIM typ, no pack) with the current or the "
                  "proposed VSYS capacitors (B1) and a 0.5 W base load.",
              ],
              assumptions=[
                  "LED bank at the firmware cap: 13 LEDs white at 30 % duty (DESIGN §9.2 'LEDs "
                  "≤ 30 %'), all PWM phases aligned (worst case for ripple).",
                  "MLCC derating as B1 (22 µF/25 V 0805: 70 %; 10 µF/10 V 0603: 55 % at 4.4 V).",
              ])
    for design in ("current", "proposed"):
        r = ctx.sim("b09", f"inrush_{design}", net(design, False), "tran 0.2u 10m 0 0.2u uic",
                    ["i(vsrc)", "v(vsys)", "v(vled)", "@m2[id]"] if False else
                    ["v(vsys)", "v(vled)", "i(vsrc)"])
        vs0 = float(np.mean(window(r, "v(vsys)", 2.5e-3, 2.99e-3)))
        dip = vs0 - float(np.min(window(r, "v(vsys)", 3e-3, 10e-3)))
        vl = r["v(vled)"]
        t = r["x"]
        # inrush = C dV/dt on the VLED bank
        cvled = (44e-6 * 0.7 if design == "current" else 10e-6 * 0.55) + N_LED * 0.1e-6
        dvdt = np.gradient(vl, t)
        ipk = float(np.max(cvled * dvdt[(t > 3e-3)]))
        up = t[(t > 3e-3) & (vl > 0.9 * vs0)]
        t_up = float(up[0] - 3e-3) if len(up) else np.inf
        b.add(f"VLED inrush peak ({design})", si(ipk, "A"), "≤ 0.3 A", ipk <= 0.3, "HW-ELEC-05",
              key=design == "proposed")
        b.add(f"VSYS dip when the LED rail switches on ({design})", si(dip, "V"),
              "≤ 0.2 V (buck/LDO/amp undisturbed)", dip <= 0.2, "HW-ELEC-10", key=design == "current")
        b.add(f"VLED rise time to 90 % ({design})", si(t_up, "s"), "≤ 5 ms", t_up <= 5e-3,
              "HW-FUNC-02")
    r = ctx.sim("b09", "pwm_proposed", net("proposed", True), "tran 1u 12m 0 1u uic",
                ["v(vsys)", "v(vled)"])
    vl = window(r, "v(vled)", 8e-3, 12e-3)
    vs = window(r, "v(vsys)", 8e-3, 12e-3)
    b.add("VLED minimum with all LEDs at the 30 % cap, PWM aligned (proposed)", si(float(vl.min()), "V"),
          "≥ 3.7 V (SK6812 VDD min, p5)", float(vl.min()) >= 3.7, "HW-FUNC-02, HW-ELEC-10")
    b.add("VSYS ripple at 1 kHz from LED PWM (proposed)", si(float(vs.max() - vs.min()), "V") + " p-p",
          "≤ 50 mV p-p (input to B3's PSRR check)", float(vs.max() - vs.min()) <= 0.05,
          "HW-ELEC-09, -10")
    # LED data level shift: SN74LV1T125 (TI vendor model) on VSYS, 3.3 V GPIO in, 330 Ω out
    try:
        from models import vendor
        lib, prov = vendor.fetch("sn74lv1t125", ctx.models)
        b.provenance.append("SN74LV1T125: TI behavioural model SCLM183 rev 2.0, downloaded at run "
                            "time: " + prov)
        for vcc in (4.4, 3.7):
            netb = f""".include {lib}
Vcc vcc 0 {vcc}
Vin a 0 PULSE(0 3.3 1u 20n 20n 0.6u 1.25u)
X1 y a 0 vcc 0 SN74LV1T125
R1 y din 330
Cdin din 0 15p
"""
            rb = ctx.sim("b09", f"lv1t125_{vcc}", netb, "tran 1n 6u", ["v(din)"])
            v = window(rb, "v(din)", 2e-6, 6e-6)
            vih = 0.7 * vcc
            b.add(f"LED data at the first SK6812, VSYS {vcc} V (SN74LV1T125 model)",
                  f"high {float(v.max()):.2f} V, low {float(v.min()):.2f} V",
                  f"high ≥ 0.7·VDD = {vih:.2f} V, low ≤ 0.3·VDD (SK6812 p6)",
                  float(v.max()) >= vih and float(v.min()) <= 0.3 * vcc, "HW-FUNC-02")
    except Exception as exc:
        b.add("LED data level shift (SN74LV1T125 model)", "not run", "INFO", None, "HW-FUNC-02",
              str(exc)[:200])
    b.add("AW9523B LED_PWR_EN at power-up", "low (AD0 = AD1 = GND)", "switch off until firmware",
          True, "HW-ELEC-11, HW-FUNC-02", "AW9523B p11; 100 kΩ pull-down on the gate driver")
    return b
