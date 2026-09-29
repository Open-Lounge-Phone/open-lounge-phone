# LTR-303ALS-01 — ambient light sensor (U18)

| | |
|---|---|
| MPN / maker | LTR-303ALS-01 (ChipLED 2 × 2 × 0.7, 6 pins), Lite-On |
| Function here | Lux reading for LED dimming / night mode; polled over I2C (0x29); INT unused. Sits under a Ø2 light hole in the lid. |
| Requirements | HW-FUNC-12; HW-PRIV-04; HW-ENV-01 |
| Datasheet | LTR-303ALS-01 datasheet **DS86-2013-0004, revision A, effective 07/09/2014**: https://datasheet.lcsc.com/datasheet/pdf/e082d25eee9d8954f5ed8e86defb8a71.pdf |
| LCSC / JLC | C364577 — LCSC 16 008, JLC 16 008 (2026-09-29); $0.54 @1, $0.28 @1k; **extended** |
| Lifecycle | UNVERIFIED (Lite-On lifecycle not published); in stock. |
| Alternates | LTR-329ALS-01 (same package family, UNVERIFIED pinout); VEML7700 (different package); BH1750 (different package). |
| SPICE (H4) | None needed. |

## Key specs we rely on

| Spec | Value | Source |
|---|---|---|
| Supply | VDD 2.4–3.6 V; I/O bus 1.7–3.6 V | [p6] |
| Current | 220 µA active, 5 µA standby | [p6] |
| I2C levels | VIH ≥ 1.2 V, VIL ≤ 0.6 V; pull-ups 1–10 kΩ recommended | [p5], [p6] |
| Operating temperature | **−30 … +70 °C** | [p6] |
| Output | two-channel lux (visible + IR) — no imaging (HW-PRIV-04) | [p2] |

## Absolute maximum vs our conditions

| Parameter | Abs max [p6] | Ours |
|---|---|---|
| VDD | 3.8 V | 3.3 V (≤ 3.41 V) ✓ |
| SCL, SDA, INT | −0.5 … 3.8 V | 3.3 V ✓ |
| Storage | −40 … +100 °C | ✓ |

## Pinout vs footprint

I/O pin table [p5] vs KiCad `OptoDevice:Lite-On_LTR-303ALS-01` (U18): 1 VDD = 3V3, 2 NC = open,
3 GND, 4 SCL, 5 INT = open (open drain), 6 SDA. ✓

## Recommended application circuit vs ours

| Datasheet [p5] | Ours | Note |
|---|---|---|
| C1 1 µF X7R/X5R at VDD | 1 µF | ✓ |
| Rp 1–10 kΩ on SCL/SDA/INT | shared 4.7 kΩ; INT unused (no pull-up needed) | ✓ |
| Optional 10 pF on signals in noisy environments | none | ✓ (add only if EVT shows I2C errors) |

## Open issues

- None.
