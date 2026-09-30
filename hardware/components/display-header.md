# 1x8 2.54 mm pin header — display module port (J3)

| | |
|---|---|
| MPN / maker | HX PZ2.54-1x8P ZZ (through-hole, vertical), HX |
| Function here | connects a ready-made SPI display module; pin order = the Waveshare 2.9" e-Paper module's: 1 VCC (3V3), 2 GND, 3 DIN (IO38), 4 CLK (IO39), 5 CS (IO40), 6 DC (IO41), 7 RST (IO42), 8 BUSY (IO48) |
| Datasheet | https://datasheet.lcsc.com/datasheet/pdf/85243369e68f3858b37abf71bad9b29e.pdf |
| LCSC / JLC | C32713274; ~$0.06; **extended**. Any 1x8 2.54 mm header fits (hand-solder). |
| Footprint | `Connector_PinHeader_2.54mm:PinHeader_1x08_P2.54mm_Vertical` |

A male header takes the module's 8-wire cable (Waveshare ships a PH2.0-to-Dupont cable) or
female-female jumpers, so the module can sit in the lid window wherever the enclosure wants it.
Modules and alternatives: [../DESIGN.md](../DESIGN.md) §6 and [off-board.md](off-board.md).
