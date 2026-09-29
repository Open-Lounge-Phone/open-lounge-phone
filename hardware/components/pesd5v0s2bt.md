# PESD5V0S2BT — dual bidirectional ESD diode, handset jack (D7, D8)

| | |
|---|---|
| MPN / maker | PESD5V0S2BT,215 (SOT-23), Nexperia |
| Function here | ESD at the handset jack J7: D7 on T/R1 (earpiece), D8 on S/TN (mic, insertion contact). **Bidirectional** because the AC-coupled earpiece lines swing ≈ ±0.64 V around GND; a unidirectional array (SRV05-4) would clip the negative half. |
| Requirements | HW-ELEC-22, -23 |
| Datasheet | Nexperia product data sheet, 23 August 2018: https://assets.nexperia.com/documents/data-sheet/PESD5V0S2BT.pdf |
| LCSC / JLC | C49338 — LCSC 30 570, JLC 30 572 (2026-09-30); **extended** |
| Lifecycle | active (Nexperia), AEC-Q101 |

## Key specs we rely on

| Spec | Value | Source |
|---|---|---|
| VRWM | 5 V (both polarities) | p1, p4 |
| IRM | 5 nA typ, 100 nA max at 5 V | p1, p4 |
| Cd | 35 pF typ, 45 pF max at 0 V | p1, p4 |
| ESD | IEC 61000-4-2 level 4, up to 30 kV | p1 |
| Surge | IPPM 12 A, 130 W (8/20 µs), VCL 14 V at 12 A | p1 |

## Pinout vs footprint

Table 2 [p2]: 1 = K1 (line 1), 2 = K2 (line 2), 3 = common → GND.
`Package_TO_SOT_SMD:SOT-23`: pads 1/2/3 match ✓.

## Notes

35 pF on the mic line and 35 pF on the tip are negligible against the 100 pF RF shunts there;
5 nA leakage is far below anything that could bias the handset electret.
