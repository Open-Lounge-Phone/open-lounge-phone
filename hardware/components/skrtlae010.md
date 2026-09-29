# Alps SKRTLAE010 — side-push SMD tactile switch (SW3 VOL−, SW4 VOL+)

| | |
|---|---|
| MPN / maker | SKRTLAE010, Alps Alpine |
| Function here | VOL− (SW3, y 70.8) and VOL+ (SW4, y 62.8) on the bottom side at the right edge, actuator through the shell; 10 k pull-ups, SRV05-4 (D4), to the AW9523B. |
| Requirements | HW-FUNC-10; HW-ELEC-22; HW-MECH-03 |
| Datasheet | Alps SKRT series web datasheet, **printed 2017-04-26**: https://datasheet.lcsc.com/datasheet/pdf/776a4001117146b9aca9bcb4d41038c0.pdf (source page http://www.alps.com/prod/info/E/HTML/Tact/SurfaceMount/SKRT/SKRTLAE010.html) |
| LCSC / JLC | C110293 — LCSC 88 415, JLC 88 599 (2026-09-29); $0.14 @1, $0.091 @1k; **extended** |
| Lifecycle | Active (UNVERIFIED — Alps page not fetched) |
| Alternates | K2-1114SA-A4SW-06 (C136662, 3 160 stock, 4.8 × 3.5 mm — land UNVERIFIED vs this footprint) |
| SPICE (H4) | n/a |

## Key specs we rely on

| Spec | Value | Source |
|---|---|---|
| Operating force / travel | 1.6 N / 0.2 mm, side push | [p1] |
| Life | 100 000 cycles (5 mA 5 V DC) | [p1] |
| Rating | 50 mA 12 V DC max; 10 µA 1 V DC min | [p1] |
| Contact resistance | ≤ 500 mΩ initial | [p1] |
| Temperature | −30 … +85 °C | [p1] |
| Soldering | reflow only; "please use reflow process" (flux ingress with an iron) | [p4] |

## Pad pairing (resolved)

The circuit diagram [p3] shows terminals **① and ③ joined internally**, with ② the other contact.
The land drawing [p3] has three front pads (0.75 / 0.6 / 0.75 mm wide, 3.2 mm overall, a
**copper-prohibited area** between them) and two rear frame pads next to the Ø0.9 guide-boss
holes (4.25 mm apart).

KiCad `SW_Push_1P1T-MP_NO_Horizontal_Alps_SKRTLAE010`: pads "1" at x ±1.225 (the outer terminals
①/③ — same number because they are internally common), pad "2" at x 0 (terminal ②), "MP" at
(±1.85, 1.05) (frame), NPTH Ø0.9 at ±2.125 ✓. Nets: pads 1 = VOL_x, pad 2 = GND, MP = GND ✓ — a
press shorts VOL_x to GND as intended. Rear pad height: KiCad 0.9 mm vs ≈ 1.2 mm on the Alps land
(read from the drawing, UNVERIFIED) — minor.

## Absolute maximum vs our conditions

3.3 V / 0.33 mA inside 1–12 V, 10 µA–50 mA ✓.

## Recommended application circuit vs ours

Keep copper tracks out of the prohibited area between the front pads [p3] (layout rule to add).

## Open issues

- Hand builders: reflow or hot air only (the datasheet discourages iron soldering, [p4]).
