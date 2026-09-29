# INGHAi GMI6027-2C42DB — 6 mm electret microphone, base mic (MK1)

> **REMOVED in H5 (2026-09-30, owner D15):** no base mic. Its specs remain the *assumed typical handset capsule* in `sim/` b04/b05/b07 (the Opis 60s Micro publishes no mic data). F-25 and F-29 are closed with it.

| | |
|---|---|
| MPN / maker | GMI6027-2C42DB (Ø6.0 × 2.7 mm, solder pads "1033"), Dongguan INGHAI Electronics |
| Function here | Speakerphone mic at (152, 62.5) under a lid pinhole: bias from MICBIAS (through the mute switch, 100 Ω/10 µF, 2.2 kΩ); pseudo-differential into ES7210 CH2 (1 µF each side); 33 pF RF cap; return via a net tie. |
| Requirements | HW-FUNC-05; HW-ELEC-13; HW-PRIV-01; HW-MFG-05 |
| Datasheet | INGHAi specification **V1.0, 2020-01-09**: https://datasheet.lcsc.com/datasheet/pdf/5872a0bccdf594f00205a63a6e86a424.pdf |
| LCSC / JLC | C233885 — LCSC 995, JLC 995 (2026-09-29); $0.33 @1, $0.18 @1k; **extended** |
| Lifecycle | UNVERIFIED |
| Alternates | Other Ø6 × 2.7 mm, −42 dB, 2.2 kΩ electrets with solder pads (UNVERIFIED codes); a MEMS analog mic would be reflowable (footprint change) |
| SPICE (H4) | None. **Behavioural**: JFET current source ≤ 0.5 mA with Zout ≤ 2.2 kΩ, sensitivity −42 dBV/Pa, noise from S/N 58 dB(A). |

## Key specs we rely on

| Spec | Value | Source |
|---|---|---|
| Sensitivity | −42 ± 3 dB (0 dB = 1 V/Pa, 1 kHz) at RL 2.2 kΩ, Vs 2.0 V | [p2] |
| Supply | standard 2.0 V; max 10 V; −3 dB sensitivity change from 1.5 to 3 V | [p2] |
| Current | ≤ 0.5 mA | [p2] |
| S/N | ≥ 58 dB(A) | [p2] |
| Frequency range | 100 Hz – 10 kHz; omnidirectional | [p2] |
| Max SPL | 110 dB | [p2] |
| Temperature | operating −20 … +60 °C [p2] (p5 says −20 … +70 °C); storage −30 … +70 °C [p2] (p5: −40 … +80 °C) | [p2], [p5] |
| Terminals | **Terminal 1 = output (FET drain), Terminal 2 = ground/case** | [p3 drawing], [p4 measurement circuit] |
| Soldering | **iron only**: 90 W iron at 320 ± 10 °C, 2–3 s per terminal, capsule held in a heat-sink block; no reflow profile given | [p5] |
| ESD (test) | 6 kV contact / 8 kV air | [p4] |

## Absolute maximum vs our conditions

| Parameter | Rating | Ours |
|---|---|---|
| Supply | ≤ 10 V | MICBIAS ≈ 2–3 V (ES7210 value UNVERIFIED) through 2.2 kΩ ✓ |
| Operating temperature | −20 … +60 °C | 0 … 40 °C ✓ |

## Pinout vs footprint

Project footprint `Electret_6mm_SMD_pads`: pad 1 (−1.3, 0) = BASEMIC_P (output), pad 2 (+1.3, 0) =
BASEMIC_N (GND via net tie) — **the ground-pad question is resolved: terminal 2 is the case/ground
[p4]**, and pad numbering matches. But the capsule is round and symmetric: nothing on the part
or footprint forces orientation. The terminal drawing is a bottom view [p3], so when the capsule
sits face-up, terminal 1 appears on the **right** in top view — placement must use the ground
terminal's visual cue (the pad connected to the rim), not the drawing's left/right. Add a
silkscreen "GND/case" mark (F-29).

## Recommended application circuit vs ours

| Datasheet measurement circuit [p4] | Ours | Note |
|---|---|---|
| Vs 2.0 V through RL 2.2 kΩ to terminal 1, output via C; internal 10 pF + 33 pF | MICBIAS (≈ 2–3 V) → 2.2 kΩ; 33 pF external RF cap; 1 µF couplers | ✓ |

## Open issues

- F-25: not reflow-rated per its datasheet → JLC PCBA cannot place it as an SMT part without
  risk; hand-solder after reflow (ASSEMBLY.md) or choose a reflowable mic.
- F-29: orientation mark.
- Stock is low (995).
