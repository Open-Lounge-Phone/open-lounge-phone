# Off-board parts (not on the PCB BOM)

Parts a phone needs that are not assembled on the board. Prices are `schematic/cost_model.yaml`
estimates (EST); nothing here has been bought yet.

| Item | What it must be | Notes |
|---|---|---|
| **Display module** | a ready-made 2.9" SPI e-paper module with an 8-pin VCC/GND/DIN/CLK/CS/DC/RST/BUSY header at 3.3 V: **WeAct Studio 2.9" e-Paper** (SSD1680, 296 × 128) or **Waveshare 2.9" e-Paper Module** (V2, SSD1680) | Waveshare's pin order is the board's (J3); other modules connect with jumper wires. Alternatives on the same header style: 1.3" SH1106/SSD1306 SPI OLED modules (7 pins: GND VCC CLK MOSI RES DC CS, no BUSY), 1.54"-2.0" ST7789 SPI TFT modules (GND VCC SCL SDA RES DC CS BLK; BLK to 3V3). Firmware picks the driver (`hello.display`). |
| **MX switches** × 13 | MX-compatible, 3- or 5-pin | 12 keys + the hook switch; the hook one can be heavier (e.g. 60-80 gf) so the plunger returns briskly |
| **Keycaps** × 12 | MX stem, 1u, captive (skirt wider than the lid hole) | printed legends: `1 2 3 4 5 MENU` / `6 7 8 9 0 BACK` |
| **2.4 GHz antenna** | U.FL (MHF I), 50 Ω; same type as Espressif's certification antenna and ≤ 2.33 dBi to stay inside the module grant (WROOM-1 [p44]) | user-upgradable (owner) |
| **Handset** | analog G-style handset on a 3.5 mm TRRS plug, **CTIA** (e.g. Opis 60s Micro) | OMTP plugs are not supported |
| **USB-C cable + 5 V adapter** | any USB-C source; ≥ 500 mA | the board draws ≤ ~460 mA peak |
| **Screws, inserts** | enclosure (M2) | |
