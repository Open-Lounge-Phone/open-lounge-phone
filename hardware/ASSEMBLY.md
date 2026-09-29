# Open Lounge Phone: building the board (PCBA or by hand)

There is **one board** (180 × 88 mm, 4 layers, parts on both sides) and one BOM — no build
variants (owner decision 2026-09-28). JLCPCB is the reference path (cheapest, BOM/CPL formats and
LCSC codes in every BOM), but nothing locks the design to it. The board's folder
`build/main/layout/` has Gerber X2 + Excellon, IPC-2581, a generic BOM (MPN + manufacturer + LCSC
+ DigiKey/Mouser search links) and a generic pick-and-place file, so any fab or PCBA service
works (PCBWay, OSH Park, Eurocircuits, Aisler, Seeed Fusion, NextPCB, MacroFab, ...). Design
rules stay inside common 4-layer capability (0.15/0.15 mm, 0.3 mm drill, 0.6 mm via, 1.6 mm
FR4, ENIG). See [LAYOUT.md](LAYOUT.md) for the cost of each path.

**Status:** the board is placed but **not routed yet** (LAYOUT.md), so there is nothing to order
today. This page describes how it will be built.

## Three ways to build one

1. **Full PCBA (easiest, reference).** Upload `main-gerbers.zip`, `bom-jlc.csv` and
   `cpl-jlc.csv` to JLCPCB (standard PCBA, two-sided). Check the rotation preview. You then
   only plug in the switches, keycaps, e-ink panel, speaker, battery (optional) and handset.
2. **Hybrid (recommended for makers without hot air).** Order PCBA for the fine-pitch parts
   only (the "needs hot air / stencil" list below) and hand-solder the rest. In the JLC BOM,
   delete the lines you will solder yourself; the CPL can stay as is.
3. **All by hand (bare board + your own parts).** Possible with a hot-air station, a stencil
   (order it with the board) and solder paste for the QFN/LGA parts. Budget an evening. Start
   from the dev-kit stage in DESIGN.md §14.1 if you want firmware before hardware: it mirrors
   this architecture on off-the-shelf boards.

## Hand-solder difficulty per part

| Rating | Parts | Tools |
|---|---|---|
| Easy: 0603 passives, SOD-123, SOT-23(-5/-6) | all R/C/FB, PTC F1, TVS D3, diodes, MOSFETs, BJTs, LDO U4, buck U3, LED buffer U5, ESD arrays, hall U10, handset VBUS switch U15 | iron, fine tip, flux. All passives are 0603 or larger (no 0402) |
| Easy: SOIC-8 / SOIC-16 | ST25DV04K NFC tag (U19), CH340C USB-UART (U16) | iron |
| Moderate: 0.65 mm pitch / SC-70 | NS4150B MSOP-8 (U9), Si1308 SC-70 (Q7) | iron + flux, magnification |
| Moderate: connectors and switches | JST-PH J2 (battery) / J4 (speaker), side-push VOL−/VOL+ (SW3/SW4), MUTE slide (SW5), RESET/BOOT tacts, SK6812MINI-E key LEDs (reverse mount, heat-sensitive: 260 °C max, short dwell), MX hot-swap sockets | iron |
| Hard: 0.5 mm pitch | the e-ink panel's 24-pin FPC connector (J6), two USB-C receptacles (J1 power, J7 handset; shell tabs are through-hole) | drag soldering with flux + wick, or hot air |
| **Needs hot air or stencil + reflow** | ES8311 QFN-20 0.4 mm (U6), ES7210 QFN-32 0.4 mm (U7), BQ24074 VQFN-16 (U2), AW9523B TQFN-24 (U17), LIS2DH12 LGA-12 (U12), LTR-303ALS (U18), MAX17048 DFN-8 (U14), ESP32-S3-WROOM-1U (castellated, but the centre GND pad needs paste + hot air) | stencil, paste, hot air or hot plate |

The fine-pitch parts are the minimum the function needs: the two Everest codecs, the charger
and the I/O expander only come in QFN; the accelerometer and light sensor only in LGA/ChipLED.

## Assembly notes

- **Two sides.** On the bottom (LAYOUT.md §2): the 12 MX hot-swap sockets and 13 SK6812MINI-E
  LEDs (reverse mount, lens up through the board; the keys are on top), the JST-PH connectors,
  the VOL−/VOL+/MUTE side controls and the test pads (for a pogo fixture). LAYOUT.md has the
  height rules per side and the placement of everything else.
- **Every part is fitted** except the NFC tuning capacitor (its value is set during EVT).
- **Antenna:** stick the FPC 2.4 GHz antenna to the inside of the shell wall at the marked spot
  (≥ 15 mm from the metal posts and inserts) and snap its U.FL onto U1.
- **Handset:** any USB-C UAC handset/headset plugs into J7 (rear edge); a short right-angle or
  coiled C-to-C cable also works. There is no RJ9 jack.
- **Switches** go into the key plate first, then the plate + switches press into the sockets.
- **Battery (optional):** a 1S pack ≤ 40 × 30 × 6 mm on the tray floor under the board, leads to
  J2. Without one the phone runs from USB-C.
- **First power-up:** current-limited 5 V (200 mA) on the VBUS test pad; check VSYS 4.4 V, 3V3
  and 3V0 at their test pads before connecting the e-ink panel, battery and handset.
