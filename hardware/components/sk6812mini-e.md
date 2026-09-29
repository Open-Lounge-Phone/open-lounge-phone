# SK6812MINI-E — reverse-mount RGB LED with driver (D5, D6, D10–D20; 13 pcs)

| | |
|---|---|
| MPN / maker | SK6812MINI-E (3.2 × 2.8 × 1.78 mm, reverse mount), Dongguan Opsco Optoelectronics |
| Function here | One per key + one status pixel, on the bottom side shining up through a board cut-out and the MX switch LED window. VDD = VLED (VSYS switched by AO3401A Q2, driven by AO3400A Q3 from LED_PWR_EN); data from SN74LV1T125 via 330 Ω; 100 nF per LED. |
| Requirements | HW-FUNC-02, -11; HW-ELEC-05, -10; HW-MFG-07 |
| Datasheet | SK6812MINI-E specification **Rev 02 (2019-01-18)**: https://cdn-shop.adafruit.com/product-files/4960/4960_SK6812MINI-E_REV02_EN.pdf ; LCSC copy: https://datasheet.lcsc.com/datasheet/pdf/0907a34a701b4aef568078003f6e9eae.pdf |
| LCSC / JLC | C5149201 — LCSC 190 830, JLC 227 911 (2026-09-29); $0.080 @1, $0.050 @1k; **extended** |
| Lifecycle | UNVERIFIED (vendor gives none); high stock. |
| Alternates | None verified: other reverse-mount addressable RGB LEDs exist but none was checked for pinout, footprint and timing compatibility (UNVERIFIED). |
| SPICE (H4) | None. **Behavioural**: 1 mA static + up to 3 × 12 mA constant-current load per LED on VLED, for the VLED inrush/droop simulation. |

## Key specs we rely on

| Spec | Value | Source |
|---|---|---|
| Supply VDD | +3.7 … +5.5 V (range); IC parameters characterized at 4.5–5.5 V, TA −20 … +70 °C | [p5], [p6] |
| Input threshold | VIH ≥ 0.7 × VDD, VIL ≤ 0.3 × VDD (at 5 V) | [p6] |
| Static current | 1 mA typ | [p6] |
| LED current | 12 mA per colour (SK6812MINI-E) | [p5] |
| Data | 800 kHz, DIN→DOUT delay ≤ 500 ns | [p6] |
| Pins (top view) | 1 VDD, 2 DOUT, 3 GND, 4 DIN | [p4] |
| Operating temperature | −40 … +85 °C (rating table) | [p5] |
| Moisture sensitivity | **MSL 5a**; reflow 260 °C 10 s, max 3 times | [p1], [p12] |
| ESD | 4 kV HBM, 200 V MM | [p5] |

At VLED = 4.4 V, VIH = 3.08 V: the buffer drives rail-to-rail from VSYS ✓. On battery below
3.7 V the LEDs are outside their supply range — firmware blanks them (HW-ELEC-10).

## Absolute maximum vs our conditions

| Parameter | Limit [p5] | Ours |
|---|---|---|
| VDD | 3.7 … 5.5 V | 4.3–4.5 V on USB ✓; 3.0–4.2 V on battery ✗ below 3.7 V → blank |
| Logic input | −0.5 … VDD + 0.5 V | buffered from the same VSYS, 330 Ω series ✓ |

## Pinout vs footprint

Datasheet top view [p4]: 1 VDD upper left, 2 DOUT lower left, 3 GND lower right (chamfered
corner), 4 DIN upper right. KiCad `LED_SK6812MINI-E_3.2x2.8mm_P1.5mm_ReverseMount` pads:
1 (−2.725, +0.75), 2 (−2.725, −0.75), 3 (+2.725, −0.75), 4 (+2.725, +0.75) — the datasheet
pattern mirrored top-to-bottom, which is what a part mounted upside-down (lens through the
board) requires. ✓ Pin numbers and nets: 1 VLED, 2 LED_Dn (next DIN), 3 GND, 4 previous DOUT ✓
(e.g. D5: 4 = LED_DATA_BUF, 2 = LED_D1). Pad pitch 1.5 mm and span 5.45 mm vs the part's
5.88 mm terminal span [p4] ✓.

## Recommended application circuit vs ours

Typical application [p9]: 100 nF per LED near VDD — ours 100 nF each ✓. Series resistor in the
first data line — ours 330 Ω ✓.

## Open issues

- F-25: MSL 5a — the reels must be baked/dry-packed per J-STD-033 before reflow (JLC handles this
  for its own stock; hand/hybrid builders must bake) — to add to ASSEMBLY.md.
- Characterization at 4.5–5.5 V vs our 4.4 V is marginally outside the EC table (brightness/colour
  may shift slightly; functional range is 3.7–5.5 V).
