# HRO TYPE-C-31-M-12 — USB-C receptacle (J1)

| | |
|---|---|
| MPN / maker | TYPE-C-31-M-12 (16 pins, USB 2.0), Korean Hroparts (HRO) |
| Function here | 5 V power in (sink, 5.1 kΩ Rd on CC1 and CC2 = USB default power, no PD) and the ESP32 native USB (D+/D- through D1 to IO20/IO19) for flashing and the console |
| Datasheet | https://datasheet.lcsc.com/datasheet/pdf/9e56b777c022540fcce7c7f67825f55e.pdf |
| LCSC / JLC | C165948; ~$0.19 @1; **extended** (very high stock) |
| Footprint | `Connector_USB:USB_C_Receptacle_HRO_TYPE-C-31-M-12` (official KiCad, pads A1-B12 + shell) |

Both DP pins (A6, B6) and both DN pins (A7, B7) are joined (either plug orientation); SBU1/2
unused; shell to GND. No fuse: a compliant USB source limits its own VBUS current, the board has
no battery, and the LDO has current limiting and thermal shutdown (SGM2212 [p6], [p10]).
