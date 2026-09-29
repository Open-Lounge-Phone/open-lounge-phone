# Resistors — 0603 thick film (all R)

| | |
|---|---|
| Maker / series | UNI-ROYAL (Uniroyal Electronics) 0603WAF…T5E thick-film chip resistors |
| Requirements | HW-MFG-02, -05 (0603 minimum for hand assembly); per-use requirements below |
| Datasheet | Uniohm "Thick Film Chip Resistors" **V.3, Feb 12 2019** (LCSC copy for C25804): https://datasheet.lcsc.com/datasheet/pdf/0a975aaa49b7c97f38a963127be4a823.pdf |
| Common ratings (0603) | 1/10 W at ≤ 70 °C, derated linearly above 70 °C [p5 §9]; max working voltage 75 V, overload 150 V [p5 §7]; operating −55 … +155 °C [p5]; TCR (0603, 10 Ω–1 MΩ) ±100 ppm/°C (UNVERIFIED row — [p6] table text truncated); tolerance 1 % (F) except the 47 Ω (J code, but LCSC lists ±1 %) |
| Lifecycle | Active, JLC basic library for most values |
| Alternates | Any 0603 1 % thick-film resistor (Yageo RC0603FR-07, …) |
| SPICE (H4) | ideal resistors (tolerance ±1 % in Monte Carlo) |

## BOM lines (LCSC/JLC data 2026-09-29)

| Value | Qty | LCSC | JLC stock | Library | $ @1k | Key uses (refs) | Stress check |
|---|---|---|---|---|---|---|---|
| 0 Ω | 2 | C21189 | 24.1 M | basic | 0.0018 | R5/R6 USB D± links (power port) | 1 A jumper rating [p5] ✓ |
| 2.2 Ω | 1 | C22939 | 231 k (LCSC 0) | basic | 0.0026 | R65 e-ink boost current sense | average boost current ≈ 3 mA (panel Iopr 3 mA [GDEY029T94 p10]) → µW; peak pulses ≤ 0.5 A × short duty ✓ |
| 47 Ω | 1 | C23182 | 1.23 M | basic | 0.0030 | R24 TDM data series | ✓ |
| 100 Ω | 1 | C22775 | 11.8 M | basic | 0.0025 | R28 mic-bias RC filter | ✓ |
| 330 Ω | 1 | C23138 | 3.3 M | basic | 0.0020 | R22 LED data series | ✓ |
| 470 Ω | 1 | C23179 | 6.5 M | basic | 0.0018 | R63 mic-light current (≈ 2.5 mA) | 3 mW ✓ |
| 1 kΩ | 2 | C21190 | 22.3 M | basic | 0.0020 | R3/R4 CC sense series (HW-ELEC-02) | ✓ |
| **1.1 kΩ** | 1 | C22764 | 215 k | **extended** | 0.0014 | R7 BQ24074 ILIM (minimum allowed value [BQ24074 p12]) | must stay 1 % |
| 1.8 kΩ | 1 | C4177 | 405 k | basic | 0.0030 | R8 BQ24074 ISET (494 mA) | ✓ |
| 2.2 kΩ | 1 | C4190 | 7.7 M | basic | 0.0014 | R31 electret load | ✓ |
| **4.3 kΩ** | 1 | C23159 | 180 k | **extended** | 0.0018 | R34 AEC divider shunt | could be 4.7 k basic (LAYOUT §12), tuned in EVT (F-14) |
| 4.7 kΩ | 2 | C23162 | 22.7 M | basic | 0.0022 | R18/R19 I2C pull-ups | F-20 (rise time) |
| 5.1 kΩ | 2 | C23186 | 25.6 M | basic | 0.0012 | R1/R2 USB-C Rd (HW-ELEC-01) | Type-C Rd 5.1 kΩ ± 10 % (UNVERIFIED clause) ✓ |
| 10 kΩ | 27 | C25804 | 21.2 M | basic | 0.0015 | pull-ups (keys, side switches, EN, BOOT, /PGOOD, /CHG, IRQ, RSTN), CE/AD straps, auto-reset bases | ✓ |
| 15 kΩ | 1 | C22809 | 4.6 M | basic | 0.0022 | R40 SY6280 ISET (0.45 A) | F-05 (limit tolerance) |
| 20 kΩ | 2 | C4184 | 8.1 M | basic | 0.0018 | R32/R33 AEC divider legs | ✓ |
| 22 kΩ | 2 | C31850 | 3.7 M | basic | 0.0031 | R13 buck FB bottom; R29 privacy NPN base | F-03 (FB ratio sets 3.327 V) |
| 33 kΩ | 2 | C4216 | 3.3 M | basic | 0.0017 | R38/R39 handset-port Rp (HW-ELEC-20) | ✓ |
| 100 kΩ | 11 | C25803 | 22.4 M | basic | 0.0024 | pull-downs (GPIO3, PA_EN, LED data/enable, INT1), bleeds, HS_VBUS divider, buck FB top, P-FET gate | ✓ |
| **150 kΩ** | 2 | C22807 | 635 k | basic | 0.0034 | R35/R36 NS4150B input (gain 1.6) | F-06 |
| 1 MΩ | 1 | C22935 | 6.7 M | basic | 0.0015 | R64 e-ink GDR pull-down | ✓ |

(Extended lines marked in bold where JLC lists them as extended: 1.1 k and 4.3 k. 150 k shows as
basic in today's data.)

## Open issues

- F-03 and F-06 change R13/R12 and R35/R36 values; F-14 may change R32–R34; F-20 may change R18/R19.
