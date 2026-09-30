# LTST-C230KRKT — red 1206 reverse-mount LED, status light (D2)

| | |
|---|---|
| MPN / maker | LTST-C230KRKT (1206, reverse mount, water clear, AlInGaP red), Lite-On |
| Function here | the one status LED: IO1 → 1 kΩ → LED → GND (~1.5 mA) |
| Datasheet | https://datasheet.lcsc.com/datasheet/pdf/cf37e35ae11a8ff066e5cc002dd1bf84.pdf |
| LCSC / JLC | C125107; **extended** |
| Footprint | `LED_SMD:LED_1206_3216Metric_ReverseMount_Hole1.8x2.4mm` |

Why reverse mount: every SMD part is on the bottom (one-sided assembly). A reverse-mount LED is
soldered on the bottom and shines up through the footprint's board cut-out, and a Ø3 lid hole
shows it. Vf 2.0 V typ at 20 mA, 54 mcd, 130° [p3]. Polarity: [p1] marks the cathode end;
KiCad's footprint has pad 1 = K. The pads end at the cut-out by design of the land pattern:
a narrow DRC waiver in `layout/fab-common.kicad_dru`. IO1 is an input at boot, so the LED stays
dark until firmware lights it.
