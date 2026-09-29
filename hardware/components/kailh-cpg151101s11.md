# Kailh CPG151101S11-16 — MX hot-swap socket (SW6–SW17, 12 pcs)

| | |
|---|---|
| MPN / maker | CPG151101S11-16, Kailh (Dongguan City Kaihua Electronics) |
| Function here | Bottom-side sockets for the 12 MX switches; pin 1 = KEY_x (10 k pull-up to 3V3, to the AW9523B), pin 2 = GND. Project footprint `OpenLoungePhone:Kailh_MX_Hotswap_CPG151101S11` (sockets on the bottom, switch PCB holes through). |
| Requirements | HW-FUNC-01; HW-MECH-05; HW-MFG-03 |
| Datasheet | Kailh product specification **KH-PS2206-43 rev A (2022-06-27)** with drawing **KHA-PG1511-388EN (2022-06-01)**: https://datasheet.lcsc.com/datasheet/pdf/5ea75d84e431b4d0c68ab6e4e17d332c.pdf |
| LCSC / JLC | C5156480 — **LCSC 0, JLC 0** (2026-09-29); $0.15 @1, $0.084 @1k; **extended** |
| Lifecycle | UNVERIFIED (Kailh gives none); out of stock at LCSC/JLC. |
| Alternates | **C49352235 "CPG151101S11-2", HanElectricity** (LCSC 26 000, JLC 28 352; $0.046 @1, $0.032 @1k) — see below; Kailh sockets from keyboard retailers (hand-solder). |
| SPICE (H4) | n/a |

## Key specs we rely on

| Spec | Kailh -16 | HanElectricity -2 | Source |
|---|---|---|---|
| Body | 14.50 × 5.89 mm incl. terminals, 11.30 mm body, 1.85 mm high | identical dimensions | [Kailh p1], [Han p1] |
| Switch pin holes | Ø2.90 ± 0.05, 6.35 / 2.54 mm apart | Ø2.90 ± 0.05, 6.35 / 2.54 | same |
| Recommended PCB layout | Ø3.00 holes 6.35 × 2.54 apart, pads 2.55 × 2.5 mm outboard | identical | same |
| Rating | 12 V / 10 mA max, 2 V / 10 µA min; contact R ≤ 100 mΩ | same | same |
| Mating force / life | ≤ 3.0 kgf / 5 000 cycles | same | same |
| Materials | nylon base **black**, copper-alloy contact **gold-plated** | nylon **white**, contact **tin-plated** | [Kailh p1 BOM], [Han p1 BOM] |
| Drawing date | 2022-06-01 | 2015-05-03 (rev A) | title blocks |

## Alternative verdict (resolved)

The HanElectricity **CPG151101S11-2 has the same body, pin holes and recommended land pattern**
as the Kailh -16 (both drawings, p1), so it fits our footprint and the MX switches. Differences:
it is a **different manufacturer** using Kailh's part number (not Kailh), with **tin** instead of
gold contact plating (lower long-term contact reliability at 10 µA-level wetting currents; our
key current is 0.33 mA). Acceptable for EVT/JLC builds; buy Kailh for hand builds when available.

## Absolute maximum vs our conditions

Key contact: 3.3 V / 0.33 mA — inside 2–12 V, 10 µA–10 mA ✓.

## Pinout vs footprint

Project footprint (front view, placed on the bottom and mirrored): NPTH Ø3.0 at (3.81, −2.54) and
(−2.54, −5.08); pads 1 at (7.085, −2.54), 2 at (−5.842, −5.08), 2.55 × 2.5 mm; plus the MX centre
Ø4.0 and PCB-mount Ø1.75 holes. Pad-to-hole offsets: 3.275 mm (pad 1) and 3.302 mm (pad 2) vs
3.275 mm derived from the drawing (7.25 half-length − 3.175 half hole spacing, [p1]) → pad 2 is
0.027 mm off, inside the ±0.05 mm layout tolerance. After flipping to the bottom the holes are at
the standard MX pin positions (−3.81, −2.54) and (2.54, −5.08) ✓. Nets: pin 1 KEY_x, pin 2 GND ✓.

## Recommended application circuit vs ours

n/a.

## Open issues

- F-24: no stock of the Kailh part; the HanElectricity equivalent is footprint-compatible
  (tin-plated). Record the choice in the BOM.
- Pad-2 offset 0.027 mm: cosmetic; fix when the footprint is next regenerated.
