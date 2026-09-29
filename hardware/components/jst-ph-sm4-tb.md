# JST PH S2B-/S3B-PH-SM4-TB — SMD right-angle headers (J4 speaker, J2 battery)

| | |
|---|---|
| MPN / maker | S2B-PH-SM4-TB(LF)(SN) (2-pin) and S3B-PH-SM4-TB(LF)(SN) (3-pin), J.S.T. Mfg. |
| Function here | J4 (bottom, (108, 60)): speaker, 1 SPK_VOP, 2 SPK_VON. J2 (bottom, (150, 46)): 1S battery, **1 VBAT, 2 BQ_TS (pack NTC), 3 GND**. |
| Requirements | HW-FUNC-04, -13; HW-SAFE-02; HW-MECH-02, -03 |
| Datasheet | JST PH connector catalogue pages (LCSC copies): S3B https://datasheet.lcsc.com/datasheet/pdf/6c6fce4367275d84ec6a99bf09f1250f.pdf (PDF 2012-12); S2B https://datasheet.lcsc.com/datasheet/pdf/2474e9261ed7c5f86b55d373e724589d.pdf (PDF 2019-08); JST master: https://www.jst-mfg.com/product/pdf/eng/ePH.pdf |
| LCSC / JLC | S2B: C295747 — LCSC 21 910, JLC 21 912; $0.24 @1, $0.15 @1k. S3B: C265101 — LCSC 4 640, JLC 4 642; $0.28 @1, $0.18 @1k (2026-09-29); both **extended** |
| Lifecycle | Active (JST standard series; UNVERIFIED lifecycle page) |
| Alternates | JST-compatible clones (e.g. "PH2.0" SMD headers on LCSC) — mating fit UNVERIFIED |
| SPICE (H4) | n/a |

## Key specs we rely on

| Spec | Value | Source |
|---|---|---|
| Current / voltage | 2 A AC/DC (AWG 24) / 100 V | [S3B p1] |
| Temperature | −25 … +85 °C (incl. temperature rise) | [S3B p1] |
| Wire | AWG 32–24 | [S3B p1] |
| Pitch | 2.0 mm | [S3B p3] |

## Absolute maximum vs our conditions

Speaker ≤ 0.9 A rms at 3 W into 4 Ω (budget) < 2 A ✓; battery charge 0.5 A / discharge ≤ 1.3 A < 2 A ✓.

## Pinout vs footprint

KiCad `JST_PH_S2B-PH-SM4-TB_1x02-1MP` / `…S3B…_1x03-1MP`: pads 1…n at 2.0 mm pitch, two MP
(mounting) pads to GND ✓. Nets as above.

## Recommended application circuit vs ours

n/a. **Battery pinout**: JST fixes the housing, not the signal assignment. Hobby LiPo packs with a
3-pin PH plug use several pin orders (some put GND in the middle); a pack with a different order
would reverse-bias the BQ24074 BAT pin (abs min −0.3 V [BQ24074 p10]). F-10.

## Open issues

- F-10: specify the pack (pinout, NTC 10 kΩ β, protection) in the BOM/assembly notes and mark
  the pin order on the silkscreen.
