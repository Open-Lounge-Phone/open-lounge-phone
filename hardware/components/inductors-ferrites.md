# Inductors and ferrite beads (L1, L3, FB1, FB2)

> **H5 (2026-09-30):** a third BLM18PG121SN1D (FB3) sits on the handset mic line.

| | |
|---|---|
| Requirements | HW-ELEC-07 (buck), HW-FUNC-03 (e-ink boost), HW-FUNC-04 / HW-REG-01 (speaker EMI) |
| SPICE (H4) | Sunlord: none found (UNVERIFIED); use L + DCR + Isat soft-saturation behavioural model. Murata BLM18PG: Murata SimSurfing provides SPICE netlists for BLM-series beads (https://ds.murata.co.jp/simsurfing/ — UNVERIFIED for this exact part). |

## Power inductors — Sunlord SWPA4020S series

Datasheet: Sunlord "SWPA series of SMD Power Inductor", **revised 2012/07/04** (PDF modified
2015-07-15), copy: https://static.chipdip.ru/lib/821/DOC012821225.pdf (not an official Sunlord URL;
LCSC has no PDF for C83423/C83427). Values from the SWPA4020S table [p7].

| Ref | MPN | L | DCR | Isat | Irms | Use | Check |
|---|---|---|---|---|---|---|---|
| L1 | SWPA4020S2R2MT (C83423, JLC 33 535, $0.061 @1, $0.044 @1k, extended) | 2.2 µH (table lists ±30 % "NT"; our MT suffix = ±20 %, UNVERIFIED) | 40 mΩ | 3.40 A | 1.85 A | TLV62569 buck | Isat 3.4 A > buck high-side limit 3 A typ [TLV62569 p5] (≈ 13 % margin); Irms ≫ 0.6 A load ✓ |
| L3 | SWPA4020S470MT (C83427, JLC 1 495, $0.056 @1, $0.040 @1k, extended) | 47 µH ± 20 % | 710 mΩ (LCSC: 923 mΩ max) | 0.74 A | 0.44 A | e-ink boost (GD reference: 47 µH / 500 mA [GDEY029T94 p29]) | Irms 0.44 A is below the reference's 500 mA rating; the average current is ≈ 3 mA and peaks are set by the SSD1680 (2.2 Ω sense) — acceptable, low JLC stock (1 495) |

Footprint `Inductor_SMD:L_Sunlord_SWPA4020S` (4 × 4 mm), two pads, non-polar ✓.
Lifecycle: UNVERIFIED. Alternates: other 4 × 4 mm shielded 2.2 µH / 47 µH inductors with ≥ the
same Isat/Irms (e.g. Sunlord SWPA4018S, Chilisin — UNVERIFIED codes).

## Ferrite beads — Murata BLM18PG121SN1D (FB1, FB2)

| | |
|---|---|
| MPN / use | BLM18PG121SN1D (0603), speaker outputs VOP/VON (with 220 pF to GND) |
| Datasheet | Murata chip ferrite bead catalogue C31E12 (2004, alldatasheet copy via LCSC): https://datasheet.lcsc.com/datasheet/pdf/fa365b03943947af82e802e86ce28761.pdf ; product page https://www.murata.com/en-us/products/productdetail?partno=BLM18PG121SN1D |
| Ratings | 120 Ω at 100 MHz, 2 A, DCR 50 mΩ (parts.py description; row in the catalogue [p5] not column-verified — UNVERIFIED) |
| LCSC / JLC | C14709 — LCSC 1 570 400, JLC 2 020 461; $0.015 @1, $0.012 @1k; **basic** |
| Check | speaker current ≤ 0.87 A rms (3 W / 4 Ω) and far less with the current gain (F-06) < 2 A ✓ |
| Lifecycle | Active (Murata mainstream; UNVERIFIED) |

## Open issues

- L3 JLC stock is low (1 495) — list an alternate before a production order (HW-MFG-03).
