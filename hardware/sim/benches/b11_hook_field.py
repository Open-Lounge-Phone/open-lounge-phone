"""B11 (analysis): hook magnet field at the Hall sensor vs the DRV5032 thresholds, decision 3:
≥ 2× margin both ways (on-hook field ≥ 2 × BOP max, off-hook field ≤ BRP min / 2)."""

from __future__ import annotations

import math

from benchlib import Bench, Ctx, si

TITLE = "Hook magnet vs DRV5032 thresholds (≥ 2× margin both ways)"
REQS = "HW-FUNC-08; HW-PRIV-03; HW-MECH-07"

BR = (1.17, 1.21)            # N35 remanence, T (IEC 60404-8-1 grade range; supplier data sheets)
DEPTH, DEPTH_TOL = 0.65, 0.08  # SOT-23 Hall element below the package top (SLVSDC7H p15 Fig. 7-8)
POS_TOL = 0.3                  # mm, plunger/hook-rest stack-up (assumption)
VARIANTS = {  # BOP max, BRP min (mT), SLVSDC7H p6 §6.6
    "DRV5032FA (current)": (4.8, 0.5),
    "DRV5032AJ (proposed)": (9.5, 3.0),
}


def b_axial(z_mm: float, d_mm: float, l_mm: float, br: float) -> float:
    """On-axis flux density of a cylindrical magnet at z from its face (standard closed form)."""
    r, z, l = d_mm / 2, z_mm, l_mm
    return br / 2 * ((z + l) / math.hypot(r, z + l) - z / math.hypot(r, z))


def run(ctx: Ctx) -> Bench:
    b = Bench("b11", TITLE, REQS,
              provenance=["DRV5032 SLVSDC7H p6 (BOP/BRP per variant), p15 (Hall element 0.65 ± "
                          "0.08 mm below the SOT-23 top); on-axis field of a cylindrical magnet "
                          "(closed form); PROTO_BOX: Ø3 × 1.5 mm N35, 2.0 mm above the sensor "
                          "on-hook; H5 captive plunger: 10 mm travel (proto_box.py)."],
              assumptions=["±0.3 mm mechanical stack-up on both positions; N35 Br 1.17–1.21 T; "
                           "the magnet is on the sensor axis (lateral offset lowers both fields)."])
    for travel in (8.0, 10.0):
        z_on = 2.0 + DEPTH + DEPTH_TOL + POS_TOL
        z_off = 2.0 + travel + DEPTH - DEPTH_TOL - POS_TOL
        b_on = b_axial(z_on, 3, 1.5, BR[0]) * 1e3
        b_off = b_axial(z_off, 3, 1.5, BR[1]) * 1e3
        for name, (bop, brp) in VARIANTS.items():
            m_on, m_off = b_on / bop, brp / b_off
            scope = "current" if "current" in name else "proposal"
            if travel == 8.0 and scope == "proposal":
                scope = "alt"
            if travel == 10.0 and scope == "current":
                scope = "alt"
            b.add(f"{name}, Ø3×1.5 N35, {travel:.0f} mm travel: on-hook / off-hook margins",
                  f"on {b_on:.1f} mT → {m_on:.1f}×, off {b_off:.2f} mT → {m_off:.1f}×",
                  "both ≥ 2× (decision 3)", m_on >= 2 and m_off >= 2, "HW-FUNC-08", scope=scope,
                  key=scope == "proposal")
    b.notes.append("DRV5032AJ is open-drain (needs a pull-up; 100 kΩ to 3V3) and still 20 Hz; "
                   "LCSC C266120, 32 k in stock (2026-09-29).")
    return b
