"""B8: NFC coil (26 × 42 mm, 9 turns, 0.3/0.3 mm): inductance from the geometry, resonance with
the ST25DV tuning capacitance, the external tuning cap, and a sensitivity analysis."""

from __future__ import annotations

import itertools

import numpy as np

from benchlib import Bench, Ctx

TITLE = "NFC coil: inductance from geometry, resonance with ST25DV, tuning, sensitivity"
REQS = "HW-FUNC-07; HW-MECH-08"

MU0_4PI = 1e-7
N, W, S, T = 9, 0.30e-3, 0.30e-3, 35e-6        # turns, track, space, copper (1 oz outer)
OUT_W, OUT_H = 26.0e-3, 42.0e-3
CTUN = (26.5e-12, 28.5e-12, 30.5e-12)           # ST25DV SO8N, f = 13.56 MHz [ST25DV p181, Table 214]
F_TARGET = 13.56e6


def segments(n=N):
    """Concentric-rectangle approximation of the spiral: turn i centre-line, 4 straight sides
    with the current direction (counter-clockwise), as (axis, fixed coord, start, end, sign)."""
    segs = []
    for i in range(n):
        inset = W / 2 + i * (W + S)
        x0, x1, y0, y1 = inset, OUT_W - inset, inset, OUT_H - inset
        segs += [("x", y0, x0, x1), ("y", x1, y0, y1), ("x", y1, x1, x0), ("y", x0, y1, y0)]
    return segs


def self_l(length: float) -> float:
    """Partial self-inductance of a straight rectangular bar (Ruehli / Grover; Greenhouse 1974
    eq. 2): L = 2e-7 l [ln(2l/(w+t)) + 0.50049 + (w+t)/(3l)]."""
    return 2e-7 * length * (np.log(2 * length / (W + T)) + 0.50049 + (W + T) / (3 * length))


def mutual_parallel(a0, a1, b0, b1, d):
    """Mutual partial inductance of two parallel filaments along the same axis, spans [a0,a1]
    and [b0,b1] (signed by direction), distance d (Grover, 'Inductance Calculations', ch. 7)."""
    def f(z):
        return z * np.arcsinh(z / d) - np.sqrt(z * z + d * d)
    sa = np.sign(a1 - a0)
    sb = np.sign(b1 - b0)
    a0, a1 = sorted((a0, a1))
    b0, b1 = sorted((b0, b1))
    m = MU0_4PI * (f(b1 - a0) + f(b0 - a1) - f(b1 - a1) - f(b0 - a0))
    return sa * sb * m


def coil_l(n=N) -> float:
    segs = segments(n)
    total = 0.0
    for i, (ax, c, s0, s1) in enumerate(segs):
        total += self_l(abs(s1 - s0))
        for j, (bx, c2, t0, t1) in enumerate(segs):
            if j <= i or ax != bx:
                continue
            d = abs(c - c2)
            if d < 1e-9:
                continue
            total += 2 * mutual_parallel(s0, s1, t0, t1, d)
    return total


def wheeler(n=N) -> float:
    """Modified Wheeler (Mohan et al., IEEE JSSC 34(10) 1999, K1 2.34, K2 2.75) with the
    rectangle's mean side as d_out: an independent sanity check."""
    d_out = (OUT_W + OUT_H) / 2
    d_in = d_out - 2 * n * (W + S) + 2 * S
    rho = (d_out - d_in) / (d_out + d_in)
    d_avg = (d_out + d_in) / 2
    return 2.34 * 4e-7 * np.pi * n * n * d_avg / (1 + 2.75 * rho)


def r_ac(f=F_TARGET) -> float:
    length = sum(abs(s1 - s0) for _, _, s0, s1 in segments())
    delta = np.sqrt(1.72e-8 / (np.pi * f * 4e-7 * np.pi))
    t_eff = delta * (1 - np.exp(-T / delta))
    return 1.72e-8 * length / (W * t_eff), 1.72e-8 * length / (W * T), length


def run(ctx: Ctx) -> Bench:
    b = Bench("b08", TITLE, REQS,
              provenance=[
                  "Inductance: partial-inductance (Greenhouse) method — self terms of straight "
                  "bars (Ruehli/Grover) plus mutual terms of every parallel pair (Grover, "
                  "'Inductance Calculations', ch. 7; H. M. Greenhouse, 'Design of planar "
                  "rectangular microelectronic inductors', IEEE Trans. PHP-10(2), 1974); the "
                  "spiral is approximated by 9 concentric rectangles. Cross-check: modified Wheeler "
                  "(Mohan et al., IEEE JSSC 34(10), 1999).",
                  "ST25DV04K: C_TUN 26.5 / 28.5 / 30.5 pF at 13.56 MHz, SO8N (datasheet "
                  "DocID027603 rev 4 p181, Table 214).",
                  "Resonance, Q and bandwidth: RLC AC analysis in ngspice.",
              ],
              assumptions=[
                  "Coil self-capacitance 1–4 pF (turn-to-turn, 0.3 mm gaps on FR-4: estimate); "
                  "the ST25DV's RF input loss as 15 kΩ in parallel (loaded Q ≈ 20–30: estimate, "
                  "ST gives no value).",
                  "Detuning by the e-ink glass, key switches and the reading phone is not "
                  "modelled — the DNP tuning cap stays the EVT knob (VNA).",
                  "Fabrication spread on L ±5 %; C0G tuning cap ±5 %.",
              ])
    L = coil_l()
    lw = wheeler()
    rac, rdc, length = r_ac()
    b.add("coil inductance (Greenhouse partial inductances)", f"{L * 1e6:.2f} µH",
          "INFO; H2 estimates 4.5–4.8 µH", None, "HW-FUNC-07", key=True)
    b.add("cross-check: modified Wheeler", f"{lw * 1e6:.2f} µH",
          "within 15 % of the Greenhouse value", abs(lw / L - 1) <= 0.15, "HW-FUNC-07")
    b.add("coil resistance (DC / 13.56 MHz, skin effect)", f"{rdc:.2f} Ω / {rac:.2f} Ω "
          f"(trace {length * 1e3:.0f} mm)", "INFO", None, "HW-FUNC-07")

    def f0(l, c):
        return 1 / (2 * np.pi * np.sqrt(l * c))

    nom = f0(L, CTUN[1] + 2.5e-12)
    b.add("current schematic, 9 turns: resonance with no external cap (C_TUN 28.5 + 2.5 pF self)",
          f"{nom / 1e6:.2f} MHz",
          "13.56–14.5 MHz (slightly high is usual: the phone detunes it down)",
          13.56e6 <= nom <= 14.5e6, "HW-FUNC-07", key=True)
    # external cap needed for 13.56 / 13.8 MHz
    for ft in (13.56e6, 13.8e6):
        cneed = 1 / ((2 * np.pi * ft) ** 2 * L) - CTUN[1] - 2.5e-12
        b.add(f"external tuning cap for {ft / 1e6:.2f} MHz (nominal L, C_TUN)",
              f"{cneed * 1e12:.1f} pF", "INFO: ≥ 0 means a cap can tune it (C78 value in EVT)",
              None, "HW-FUNC-07")
    # sensitivity: all corners
    fs = []
    for lf, ct, cs in itertools.product((0.95, 1.0, 1.05), CTUN, (1e-12, 4e-12)):
        fs.append(f0(L * lf, ct + cs))
    b.add("current schematic, 9 turns: resonance spread over L ±5 %, C_TUN 26.5–30.5 pF, C_self 1–4 pF",
          f"{min(fs) / 1e6:.2f}–{max(fs) / 1e6:.2f} MHz",
          "low corner ≥ 13.56 MHz (a parallel cap can only tune down)",
          min(fs) >= 13.56e6, "HW-FUNC-07")
    sl = (f0(L * 1.01, CTUN[1]) / f0(L, CTUN[1]) - 1) * 100
    sc = (f0(L, CTUN[1] * 1.01) / f0(L, CTUN[1]) - 1) * 100
    b.add("sensitivity df/f per +1 % L and per +1 % C", f"{sl:.2f} % / {sc:.2f} %", "INFO", None,
          "HW-FUNC-07")

    # SPICE: RLC with loss, Q and -3 dB bandwidth
    net = f"""Iin 0 top AC 1m
Lc top m {L}
Rc m 0 {rac}
Cs top 0 {CTUN[1] + 2.5e-12}
Rchip top 0 15k
"""
    r = ctx.sim("b08", "rlc", net, "ac lin 4001 10meg 18meg", ["mag(v(top))"])
    f, v = r["x"], r["mag(v(top))"]
    fr = float(f[np.argmax(v)])
    above = f[v >= v.max() / np.sqrt(2)]
    q = fr / float(above[-1] - above[0])
    # ---- proposal: fewer turns so the external cap can always tune DOWN to 13.56 MHz ---------
    for n in (8, 7):
        ln = coil_l(n)
        lo = f0(ln * 1.05, CTUN[2] + 4e-12)
        hi = f0(ln * 0.95, CTUN[0] + 1e-12)
        cn = 1 / ((2 * np.pi * 13.56e6) ** 2 * ln) - CTUN[1] - 2.5e-12
        label = "proposed" if n == 7 else "alt"
        b.add(f"[{label}] {n} turns: L, resonance spread without C78, nominal C78 for 13.56 MHz",
              f"{ln * 1e6:.2f} µH, {lo / 1e6:.2f}–{hi / 1e6:.2f} MHz, C78 ≈ {cn * 1e12:.1f} pF",
              "low corner ≥ 13.56 MHz (every board tunable down with C78)", lo >= 13.56e6,
              "HW-FUNC-07", scope="proposal" if n == 7 else "alt", key=n == 7)
    b.add("simulated resonance and loaded Q", f"{fr / 1e6:.2f} MHz, Q ≈ {q:.0f}",
          "Q 10–60 (typical passive-tag range; EVT confirms read range)",
          10 <= q <= 60, "HW-FUNC-07")
    return b
