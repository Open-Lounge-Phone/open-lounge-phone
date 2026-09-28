# OpenLoungePhone: building boards (PCBA or by hand)

JLCPCB is the reference path (cheapest, BOM/CPL formats and LCSC codes in every BOM), but
nothing locks the design to it. Every board/variant folder in `build/<board>-<variant>/layout/`
has Gerber X2 + Excellon, IPC-2581, a generic BOM (MPN + manufacturer + LCSC + DigiKey/Mouser
search links) and a generic pick-and-place file, so any fab or PCBA service works
(PCBWay, OSH Park, Eurocircuits, Aisler, Seeed Fusion, NextPCB, MacroFab, ...).
Design rules stay inside common 4-layer capability (0.15/0.15 mm, 0.3 mm drill, 0.6 mm via,
1.6 mm FR4, ENIG). See [LAYOUT.md](LAYOUT.md) for the cost of each path.

## Three ways to build one

1. **Full PCBA (easiest, reference).** Upload `<board>-<variant>-gerbers.zip`,
   `bom-jlc.csv`, `cpl-jlc.csv` to JLCPCB (standard PCBA; the deck is double-sided).
   Check the rotation preview. You then only plug in the switches, keycaps, FFC, speaker,
   handset and (e-ink variants) the panel.
2. **Hybrid (recommended for makers without hot air).** Order PCBA for the fine-pitch parts
   only (the "needs hot air / stencil" list below) and hand-solder the rest. In the JLC BOM,
   delete the lines you will solder yourself; the CPL can stay as is.
3. **All by hand (bare boards + your own parts).** Possible with a hot-air station, a
   stencil (order it with the boards) and solder paste for the QFN/LGA parts. Budget an
   evening per board. Start from the dev-kit stage in DESIGN.md §14.1 if you want firmware
   before hardware: it mirrors this architecture on off-the-shelf boards.

## Hand-solder difficulty per part

| Rating | Parts | Tools |
|---|---|---|
| Easy: through-hole | MUTE slide SW5, supercap C7 (Lounge), LD2410C socket J5 (Lounge), mounting holes | iron |
| Easy: 0603 / 0805 / 1206 passives, SOD-123, SOT-23(-5/-6) | all R/C/FB, PTC F1, TVS D3, diodes, MOSFETs, BJT, LDO U4, buck U3, LED buffer U5, ESD arrays D1/D2/D5 (main) and D1 (deck), hall U10, handset VBUS switch SY6280 (U15) | iron, fine tip, flux. All passives are 0603 or larger (no 0402 on either board) |
| Easy: SOIC-8 / SOIC-16 | ST25DV04K (deck U3), CH340C (U16), ATECC608B (DNP) | iron |
| Moderate: 0.65 mm pitch / SC-70 | NS4150B MSOP-8 (U9), Si1308 SC-70 (deck Q3) | iron + flux, magnification |
| Moderate: connectors | JST-PH J2/J4, JST-SH J3 (deck, DNP), VOL-/VOL+ right-angle tacts (main SW3/SW4), tact switches, SK6812MINI-E (reverse mount, heat-sensitive: 260 C max, short dwell), hot-swap sockets | iron |
| Hard: 0.5 mm pitch connectors | Hirose FH12 24-pin FFC/FPC (main J6, deck J1, J2), two USB-C HRO TYPE-C-31-M-12 (J1 power, J7 handset; shell tabs are through-hole) | drag soldering with flux + wick, or hot air |
| **Needs hot air or stencil + reflow** | ES8311 QFN-20 0.4 mm (U6), ES7210 QFN-32 0.4 mm (U7), BQ24074 VQFN-16 (U2), AW9523B TQFN-24 (deck U1), LIS2DH12 LGA-12 (U12), LTR-303ALS (deck U2), MAX17048 DFN-8 (B-option), ESP32-S3-WROOM-1U (castellated, but the centre GND pad needs paste + hot air) | stencil, paste, hot air or hot plate |

The fine-pitch parts are the minimum the function needs: the two Everest codecs, the charger
and the I/O expander only come in QFN; the accelerometer and light sensor only in LGA/ChipLED.

## Assembly notes

- **Main board:** all parts on the top side (single-sided assembly); VOL-/VOL+/MUTE sit on
  its right edge, levers outward. Test pads are on the
  bottom (copper only, 2.54 mm grid for a pogo fixture).
- **Deck board:** hot-swap sockets, key LEDs (reverse mount, lens up through the board
  cut-out), FFC/ZIF connectors, NFC chip and I/O expander on the **bottom**;
  the e-ink boost parts, light sensor, privacy LED and the optional Qwiic port on the **top**
  (all under 2.1 mm, below the key plate). Two-sided PCBA.
- **Antenna:** stick the FPC 2.4 GHz antenna to the inside of the shell wall at the marked
  spot (≥ 15 mm from the metal posts, standoffs and inserts) and snap its U.FL onto U1.
- **Handset:** any USB-C UAC handset/headset plugs into J7 (rear edge); a short right-angle or
  coiled C-to-C extension also works.
- **Variants** differ only by DNP: `kids` leaves the e-ink connector and boost parts off,
  `lounge` adds the radar socket and supercap, `kids-batt` the battery connector and fuel
  gauge.
- **Switches** go into the key plate first, then the plate + switches press into the sockets.
  Deck screws 1-5 go in before the plate.
- **FFC orientation:** pin n on the main connector must reach pin n on the deck connector;
  choose the cable type (same-side / opposite-side contacts) for the connector orientation
  (both FH12 are bottom-contact). Verify with a continuity check before power-up.
- **First power-up:** current-limited 5 V (200 mA) on VBUS test pad, check VSYS 4.4 V, 3V3,
  3V0 at their test pads before plugging the deck and the radar.
