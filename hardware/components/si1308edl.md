# Si1308EDL-T1-GE3 — 30 V N-MOSFET, e-ink boost switch (Q7)

| | |
|---|---|
| MPN / maker | Si1308EDL-T1-GE3 (SOT-323 / SC-70-3), Vishay Siliconix |
| Function here | Boost switch of the Good Display reference circuit: gate = GDR (SSD1680), drain = SW (47 µH to 3V3), source = RESE (2.2 Ω sense to GND); 1 MΩ gate pull-down. |
| Requirements | HW-FUNC-03 |
| Datasheet | Vishay Si1308EDL, document **63399, S14-1997 Rev C (06-Oct-14)**: https://www.vishay.com/docs/63399/si1308edl.pdf |
| LCSC / JLC | C469327 — LCSC 41 515, JLC 42 201 (2026-09-29); $0.30 @1, $0.18 @1k; **extended** |
| Lifecycle | Active (product page https://www.vishay.com/en/product/63399/, 2026-09-29) |
| Alternates | Any logic-level N-FET ≥ 30 V in SC-70 with Qg ≲ 2 nC (UNVERIFIED candidates); AO3400A (SOT-23 footprint change) |
| SPICE (H4) | None listed on the Vishay product page (checked 2026-09-29). **Behavioural**: generic NMOS with RDS(on) 0.144 Ω at 4.5 V, Qg 1.4 nC. |

## Key specs we rely on

| Spec | Value | Source |
|---|---|---|
| VDS / VGS | 30 V / ±12 V | [p1] |
| RDS(on) | 0.132 Ω at 10 V, 0.144 Ω at 4.5 V, 0.185 Ω at 2.5 V | [p1] |
| Qg | 1.4 nC typ | [p1] |
| ID | 1.5 A (TA 25 °C) | [p1] |
| Pinout | SC-70-3 top view: **1 G, 2 S, 3 D** | [p1 figure] |

## Absolute maximum vs our conditions

VDS: the switch node rises to PREVGH + VF (≈ 20–25 V, UNVERIFIED exact rail) < 30 V ✓ (the
Good Display reference uses the same part [GDEY029T94 p29]).

## Pinout vs footprint

KiCad `SOT-323_SC-70` 1 = G, 2 = S, 3 = D; Q7: 1 EPD_GDR, 2 EPD_RESE, 3 EPD_SW ✓. **Resolved.**

## Open issues

- None.
