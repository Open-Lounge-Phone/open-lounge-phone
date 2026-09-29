"""B4: handset port power: TPS61023 5 V boost from VSYS -> SY6280 switch -> HS_VBUS, enabled by
(hook off) AND (HS_MODE GPIO); boot defaults, current limit, short circuit, back-feed."""

from __future__ import annotations

import numpy as np

from benchlib import Bench, Ctx, si, window

TITLE = "Handset port: 5 V boost, hook-AND-GPIO VBUS switch, limits, boot state"
REQS = "HW-ELEC-19, -17, -06; HW-PRIV-03; HW-FUNC-06, -15; HW-SAFE-03"

VREF = (0.580, 0.595, 0.610)      # TPS61023 SLVSF14B p5 (PWM mode)
R1, R2, TOL = 820e3, 110e3, 0.01  # proposed divider (E24): 5.03 V nominal
RSET = 13e3                       # proposed SY6280 R_SET (was 15k)


def vout(v, t1, t2):
    return v * (1 + R1 * (1 + t1) / (R2 * (1 + t2)))


def run(ctx: Ctx) -> Bench:
    b = Bench("b04", TITLE, REQS,
              provenance=[
                  "TPS61023: TI's unencrypted PSpice model (SLVMD68 rev A) does not start in "
                  "ngspice 45.2 (output stays at 0 V: enable/UVLO block never releases), so the "
                  "averaged `CONV_AVG` (BOOST=1) is used: VREF 0.580/0.595/0.610 V, soft start "
                  "700 µs, valley current limit 2.7 A min, 1 MHz, efficiency ≈ 90 % at 3.6 → 5 V "
                  "(SLVSF14B p1, p5, p6 Figure 6-1; https://www.ti.com/lit/ds/symlink/tps61023.pdf). "
                  "LCSC C919459 (TPS61023DRLR, JLC extended, 46 k in stock 2026-09-29).",
                  "SY6280: behavioural `SY6280_BEH` (RON 80 mΩ, I_LIM = 6800/R_SET ± 25 %, 50 % "
                  "fold-back into a short, no reverse current when off, 150 Ω discharge; "
                  "AN_SY6280 rev 0.1 p1-p5).",
                  "AND gate (74LVC1G08-class) and DRV5032 push-pull output as ideal logic; GPIO3 "
                  "floats at reset (WROOM-1U datasheet p13, Table 4-1) and has the 100 kΩ "
                  "pull-down.",
              ],
              assumptions=[
                  "Handset: 100 mA in a call, 10 µF input capacitance (USB 2.0 §7.2.4.1 limit), "
                  "attached after VBUS is up; short = 50 mΩ.",
                  "VSYS 4.4 V (USB) or 3.3 V (battery at the firmware cut-off), 50 mΩ source.",
                  "Boost output 22 µF (+10 µF at the SY6280 input, datasheet 'strongly "
                  "recommended'); 10 µF on HS_VBUS; 60 mΩ of copper/connector to the handset.",
              ])

    # ---- DC set-point window (analysis) -------------------------------------------------------
    lo = vout(VREF[0], -TOL, TOL) - 0.45 * (0.08 + 0.06)
    hi = vout(VREF[2], TOL, -TOL)
    b.add("HS_VBUS window at the receptacle: VREF/resistor corners, 450 mA",
          f"{lo:.3f}–{hi:.3f} V (nominal {vout(VREF[1], 0, 0):.3f} V)",
          "4.75–5.25 V (USB 2.0 host port)", lo >= 4.75 and hi <= 5.25, "HW-ELEC-19",
          f"divider {R1 / 1e3:.0f}k/{R2 / 1e3:.0f}k 1 %")
    # current schematic for comparison: diode-OR of VBUS (after the PTC) and VSYS, B5819W
    v_usb = 4.75 - 0.12 * 1.2 - 0.45 - 0.45 * 0.08     # source min, PTC max, Schottky 0.45 V
    v_bat = 3.3 - 0.45 - 0.45 * 0.08
    b.add("current schematic (diode-OR, no boost): worst VBUS at 450 mA", 
          f"{v_usb:.2f} V on USB, {v_bat:.2f} V on battery", "≥ 4.75 V", False,
          "HW-ELEC-19, -06", "F-05; B5819W VF 0.45 V at 0.45 A (b5819w.md), PTC 0.12 Ω",
          scope="current")
    ilo, ihi = 0.75 * 6800 / RSET, 1.25 * 6800 / RSET
    b.add(f"SY6280 current limit spread, R_SET {RSET / 1e3:.0f} kΩ", f"{ilo:.2f}–{ihi:.2f} A",
          "≥ 0.35 A and ≤ 0.70 A (HW-ELEC-19 as amended)", ilo >= 0.35 and ihi <= 0.70,
          "HW-ELEC-19, HW-SAFE-03", "15 kΩ today gives 0.34–0.57 A (below the part's 0.4 A range)")

    for vsys in (4.4, 3.3):
        net = f"""Vsys src 0 {vsys}
Rsys src vsys 0.05
Cvsys vsys 0 20u
* GPIO3 (HS_MODE): hi-Z until 2 ms (boot), then driven high; 100k pull-down
Bgpio 0 gpio I = (time > 2m ? 1 : 0)*(3.3 - V(gpio))/100
Rpd gpio 0 100k
* DRV5032 OUT: high = no magnet = off-hook. On-hook 12-16 ms.
Vhook hook 0 PWL(0 3.3 12m 3.3 12.001m 0 16m 0 16.001m 3.3)
Band en 0 V = 3.3*stp(V(hook)-1.65,0.05)*stp(V(gpio)-1.65,0.05)
Xbst vsys hsvin fbb en 0 CONV_AVG PARAMS: VREF=0.595 KP=10 FZ=1k IMAX=1.8 EFF=0.9 TSS=0.7m BOOST=1 L=1u
Cb hsvin 0 {32e-6 * 0.6}
R1 hsvin fbb {R1}
R2 fbb 0 {R2}
Xsw hsvin hsvbus en 0 SY6280_BEH PARAMS: RSET={RSET} K=1
Chs hsvbus 0 {10e-6 * 0.6}
Vcu hsvbus cum 0
Rcu cum port 0.06
* handset: 10 uF + 100 mA from 8 ms; short 20-22 ms
Chand port 0 10u ic=0
Swh port hl sh 0 SWT
Vsh sh 0 PWL(0 0 8m 0 8.001m 1)
Rhand hl 0 50
Sws port 0 ss 0 SWT
Vss ss 0 PWL(0 0 20m 0 20.001m 1 22m 1 22.001m 0)
.model SWT SW(RON=0.05 ROFF=1e9 VT=0.5 VH=0.1)
"""
        r = ctx.sim("b04", f"seq_{vsys}", net, "tran 1u 26m 0 1u uic",
                    ["v(port)", "v(en)", "v(hsvin)", "i(vsys)", "i(vcu)"])
        boot = float(np.max(np.abs(window(r, "v(port)", 0, 1.99e-3))))
        b.add(f"[VSYS {vsys} V] HS_VBUS during boot (GPIO3 floating, off-hook)", si(boot, "V"),
              "< 0.5 V (handset unpowered in boot/download mode)", boot < 0.5,
              "HW-PRIV-03, HW-FUNC-15")
        t_up = r["x"][(r["x"] > 2e-3) & (r["v(port)"] > 4.75)]
        t_up = float(t_up[0] - 2e-3) if len(t_up) else np.inf
        b.add(f"[VSYS {vsys} V] VBUS up after enable", si(t_up, "s"), "≤ 5 ms (HW-ELEC-17 budget 1 s)",
              t_up <= 5e-3, "HW-ELEC-17")
        vcall = float(np.min(window(r, "v(port)", 9e-3, 11.9e-3)))
        b.add(f"[VSYS {vsys} V] VBUS at the port, handset in a call", si(vcall, "V"),
              "≥ 4.75 V", vcall >= 4.75, "HW-ELEC-19, HW-FUNC-06", scope="proposal", key=vsys == 3.3)
        dip = float(np.min(window(r, "v(port)", 8e-3, 9e-3)))
        b.add(f"[VSYS {vsys} V] VBUS dip when the handset (10 µF) attaches", si(dip, "V"),
              "≥ 4.1 V (USB 2.0 droop allowance, 330 mV → INFO-grade)", dip >= 4.1, "HW-ELEC-19")
        off = float(np.max(window(r, "v(port)", 15e-3, 15.9e-3)))
        b.add(f"[VSYS {vsys} V] VBUS 3 ms after hang-up (hook on)", si(off, "V"),
              "< 0.5 V (hardware gate: hook AND GPIO)", off < 0.5, "HW-PRIV-03", scope="proposal",
          key=vsys == 4.4)
        ish = float(np.mean(window(r, "i(vcu)", 21e-3, 22e-3)))
        b.add(f"[VSYS {vsys} V] current into a shorted port (fold-back)", si(ish, "A"),
              "≤ 0.70 A (and self-protecting: SY6280 thermal cycling)", ish <= 0.70,
              "HW-SAFE-03")
        isys = -float(np.mean(window(r, "i(vsys)", 21e-3, 22e-3)))
        b.add(f"[VSYS {vsys} V] VSYS current during the short", si(isys, "A"),
              "INFO: counts against the charger ILIM (B1)", None, "HW-ELEC-05")
        rec = float(np.min(window(r, "v(port)", 24e-3, 26e-3)))
        b.add(f"[VSYS {vsys} V] recovery after the short is removed", si(rec, "V"), "≥ 4.75 V",
              rec >= 4.75, "HW-ELEC-19")

    # ---- back-feed: a PC drives 5.25 V into the port while the switch is off ------------------
    net = f"""Vsys vsys 0 4.4
Ven en 0 0
Xbst vsys hsvin fbb en 0 CONV_AVG PARAMS: VREF=0.595 KP=10 FZ=1k IMAX=1.8 EFF=0.9 TSS=0.7m BOOST=1 L=1u
Cb hsvin 0 19u
R1 hsvin fbb {R1}
R2 fbb 0 {R2}
Xsw hsvin hsvbus en 0 SY6280_BEH PARAMS: RSET={RSET} K=1
Chs hsvbus 0 6u
Vcu hsvbus cum 0
Rcu cum port 0.06
Vpc pc 0 PWL(0 0 100u 5.25)
Rpc pc port 0.1
Rs1 hsvbus sense 100k
Rs2 sense 0 100k
"""
    r = ctx.sim("b04", "backfeed", net, "tran 1u 2m 0 1u uic", ["i(vpc)", "v(hsvin)", "v(sense)"])
    into = float(np.max(r["i(vpc)"]))     # SPICE sign: > 0 = current flowing INTO the PC's source
    b.add("current pushed into a PC's VBUS while our switch is off", si(max(into, 0), "A"),
          "≤ 0 (never source into a host)", into <= 1e-6, "HW-ELEC-19, HW-FUNC-15",
          f"the PC only sees the 150 Ω discharge + sense divider: "
          f"{si(-float(np.mean(window(r, 'i(vpc)', 1.5e-3, 2e-3))), 'A')} steady")
    leak = float(np.max(window(r, "v(hsvin)", 1e-3, 2e-3)))
    b.add("boost output (switch input) with the PC at 5.25 V", si(leak, "V"),
          "< 0.5 V (no reverse path through the SY6280)", leak < 0.5, "HW-ELEC-19")
    b.add("HS_VBUS_SENSE seen by firmware with a PC attached", si(at_end(r, "v(sense)"), "V"),
          "INFO: firmware must refuse to enable VBUS when ≥ 1 V (foreign source)", None,
          "HW-ELEC-19")
    for c in b.checks:           # everything simulated here is the new (H5) architecture
        if c.scope == "both":
            c.scope = "proposal"
    return b


def at_end(r, v):
    return float(r[v][-1])
