# 2x4 2.54 mm female socket — display module port (J3)

| | |
|---|---|
| MPN / maker | HX PM2.54-2x4P ZC (through-hole, vertical, 8.5 mm), HX (Hanxia) |
| Function here | the WeAct Studio 2.9" e-Paper module plugs straight in; pin order = its 2x4 header (WeAct schematic, P1): 1 BUSY (IO48), 2 RES (IO38), 3 D/C (IO21), 4 CS (IO47), 5 SCL = CLK (IO13), 6 SDA = DIN (IO14), 7 GND, 8 VCC (3V3) |
| Datasheet | https://datasheet.lcsc.com/datasheet/pdf/482b54eeb534f75792299da9df2c4b10.pdf |
| LCSC / JLC | C32713305; **extended**. Any 2x4 2.54 mm female header fits (hand-solder). |
| Footprint | `Connector_PinSocket_2.54mm:PinSocket_2x04_P2.54mm_Vertical` |

Placed at the module's header end (DESIGN.md §6, §9); the far end rests on two M3 × 11 mm
standoffs (H5, H6) at the module's own holes. 8.5 mm socket + 2.5 mm header plastic = 11 mm.
[UNVERIFIED] which end of the module's header is pin 1 seen from the panel side: confirm on a
sample. Other modules connect with female-male jumpers ([off-board.md](off-board.md)).
