# USBLC6-2SC6 — 2-line low-capacitance ESD protection (D1, D2)

> **H5 (2026-09-30):** D1 now protects the D+/D− that go straight to the ESP32 native USB (no CH340C in between).

| | |
|---|---|
| MPN / maker | USBLC6-2SC6 (SOT-23-6L), STMicroelectronics |
| Function here | D1: power-port USB D+/D− (to the CH340C); D2: power-port CC1/CC2. VBUS pin = VBUS_C (connector side), GND. |
| Requirements | HW-ELEC-18, -22, -23 |
| Datasheet | USBLC6-2 datasheet **Doc ID 11265 Rev 5 (Oct 2011)**, LCSC copy: https://datasheet.lcsc.com/datasheet/pdf/0d3a2ab954b34651a0695e7ccf534db0.pdf ; current official: https://www.st.com/resource/en/datasheet/usblc6-2.pdf (not reachable 2026-09-29) |
| LCSC / JLC | C7519 — LCSC 25 130, JLC 25 133 (2026-09-29); $0.18 @1, $0.098 @1k; **extended** |
| Lifecycle | Active (ST mainstream part; UNVERIFIED — st.com not reachable) |
| Alternates | Many "USBLC6-2SC6" second sources on LCSC (e.g. UMW, Techcode — pin-compatible by name, UNVERIFIED), SRV05-4 (4 lines, SOT-23-6, different pinout) |
| SPICE (H4) | ST provides SPICE models for its ESD protection (UNVERIFIED for this exact part; product page not reachable). **Behavioural**: steering diodes + 6.1 V TVS, Rd ≈ 0.5 Ω [p4]. |

## Key specs we rely on

| Spec | Value | Source |
|---|---|---|
| IEC 61000-4-2 level 4 | ±15 kV air, ±8 kV contact (device level) | [p1], [p2] |
| Line capacitance | 3.5 pF max | [p1] |
| Leakage | 150 nA max at VRM 5.25 V | [p1], [p2] |
| VBR (VBUS–GND) | ≈ 6.1 V (example calculation) | [p4] |
| Pinout (SOT-23-6) | 1 I/O1, 2 GND, 3 I/O2, 4 I/O2, 5 VBUS, 6 I/O1 | [p1 Figure 1] |

## Absolute maximum vs our conditions

| Parameter | Datasheet | Ours |
|---|---|---|
| VRM | 5.25 V | D+/D− ≤ 3.6 V; CC ≤ 5.25 V (a source's Rp to 5 V) ✓ |
| ESD | level 4 | user-reachable USB-C pins ✓ |

## Pinout vs footprint

`Package_TO_SOT_SMD:SOT-23-6` nets — D1: 1 USB_DP_C, 2 GND, 3 USB_DN_C, 4 USB_DN_C, 5 VBUS_C,
6 USB_DP_C; D2: 1 CC1, 2 GND, 3 CC2, 4 CC2, 5 VBUS_C, 6 CC1. ✓ Both lines are routed through the
package (in at 1/3, out at 6/4) as the datasheet layout recommends.

## Recommended application circuit vs ours

VBUS pin to the protected supply for the steering diodes' reference — ours to VBUS_C (before the
PTC) ✓; place at the connector with short GND (LAYOUT rule) ✓.

## Open issues

- If the CH340C is removed (F-01), D1 and the 0 Ω links R5/R6 can go too (D2 stays for CC).
