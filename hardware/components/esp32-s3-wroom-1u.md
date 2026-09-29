# ESP32-S3-WROOM-1U-N16R8 — MCU, Wi-Fi/BLE module (U1)

> **H5 (2026-09-30):** native USB (IO19/20) is a **device** on the power USB-C J1 (flashing, USB-Serial-JTAG console; F-01 closed); 3V3 = 3.19 V (F-03 closed). Pins: IO10 MIC_SENSE (ADC1), IO12 JACK_DET, IO13 recording light, IO17 HOOK_IN (via 47 kΩ); IO3/IO9/IO46 free. Antenna: a general-purpose U.FL/IPEX 2.4 GHz antenna — same type and ≤ 2.33 dBi to stay inside the modular grant (owner D19, F-02: caveat documented, shipped antenna to choose).

| | |
|---|---|
| MPN / maker | ESP32-S3-WROOM-1U-N16R8, Espressif Systems |
| Function here | Main MCU; Wi-Fi 2.4 GHz + BLE through a U.FL cable antenna; native USB OTG = full-speed **host** for the handset port (GPIO19/20); I2S to the codecs, SPI to the e-ink, I2C bus, RMT LED data |
| Requirements | HW-FUNC-06, -14, -15; HW-ELEC-07, -08, -11, -18; HW-PRIV-06; HW-MECH-04; HW-ENV-01; HW-REG-01, -03; HW-MFG-07 |
| Datasheet | ESP32-S3-WROOM-1 & WROOM-1U datasheet **v1.8, 2026-03-02**: https://www.espressif.com/sites/default/files/documentation/esp32-s3-wroom-1_wroom-1u_datasheet_en.pdf ; chip: ESP32-S3 Series datasheet **v2.2**: https://www.espressif.com/sites/default/files/documentation/esp32-s3_datasheet_en.pdf |
| LCSC / JLC | C3013946 — LCSC stock 7 996, JLC stock 17 314 (2026-09-29); JLC price $4.97 @1, $3.43 @1k; **extended** |
| Lifecycle | Active (listed as current in datasheet v1.8, p3). |
| Alternates | ESP32-S3-WROOM-1-N16R8 (PCB antenna, C2913202, same pinout — needs a 15 mm edge clearance, GUIDELINES §2); ESP32-S3-WROOM-1U-N8R8 (8 MB flash, same pinout, p3) |
| SPICE (H4) | None from Espressif; no IBIS model found (https://esp32.com/viewtopic.php?f=12&t=26366). **Behavioural**: a 3V3 current-profile source (idle 40 mA, 355 mA TX bursts, 500 mA design step). |

## Key specs we rely on

| Spec | Value | Source |
|---|---|---|
| Flash / PSRAM | 16 MB quad flash, 8 MB **octal** PSRAM | [WROOM p3] |
| Ambient temperature, N16R8 | **−40 … +65 °C** (octal-PSRAM variants) | [WROOM p3] |
| Supply VDD33 | 3.0 / 3.3 / 3.6 V min/typ/max; supply must deliver ≥ 0.5 A | [WROOM p27, Table 6-2] |
| Wi-Fi TX peak current | 355 mA (802.11b 1 Mbps, 20.5 dBm); 297 mA 11g; BLE 20 dBm 344 mA | [WROOM p28, Tables 6-4/6-5] |
| IO35–37 | wired to the octal PSRAM, not usable | [WROOM p12, note b] |
| Strap defaults | GPIO0 weak pull-up; GPIO3 floating; GPIO45, GPIO46 weak pull-down; setup 0 ms, hold 3 ms after EN | [WROOM p13-14, Tables 4-1/4-2] |
| Boot modes | GPIO0 = 0 and GPIO46 = 0 → joint download (USB-Serial-JTAG, USB-OTG, UART0) | [WROOM p14, Table 4-3] |
| USB | Full-speed OTG (host: 8 channels, bulk/iso/interrupt) and a USB-Serial-JTAG device sharing the internal PHY by time multiplexing | [chip p55-56] |
| eFuse burning | VDD3P3_CPU **≤ 3.3 V** while writing eFuses | [chip p64, note 3] |
| ESD (chip) | HBM ±2000 V, CDM ±1000 V | [chip p69] |
| External antenna | 2.4 GHz, 50 Ω, gain ≤ **2.33 dBi**, same as the certification antenna (monopole TFPD05H08750011); other types may need extra testing | [WROOM p44] |
| Antenna connector | 1st-generation U.FL / MHF I / AMC compatible | [WROOM p43] |
| MSL | 3 (solder within 168 h after opening) | [WROOM p47] |

## Absolute maximum vs our conditions

| Parameter | Abs max | Ours |
|---|---|---|
| VDD33 | −0.3 … 3.6 V [WROOM p27] | 3.327 V nominal (TLV62569, 100 k/22 k, VFB 0.6 V); worst case with VFB max 0.612 V [TLV62569 p4] and 1 % resistors ≈ 3.41 V — below 3.6 V but **above 3.3 V for eFuse writing** (F-03) |
| Storage | −40 … +105 °C [WROOM p27] | −20 … +60 °C (HW-ENV-02) |
| Cumulative IO output | 1500 mA [chip p64] | < 30 mA (logic loads only) |

## Pinout vs footprint

KiCad `RF_Module:ESP32-S3-WROOM-1U` pad numbers equal the module pin numbers of Table 3-1
[WROOM p11-12]. Pad nets from `kicad/main/main.kicad_pcb` (2026-09-29):

| Pin | Name | Net | Pin | Name | Net |
|---|---|---|---|---|---|
| 1 | GND | GND | 21 | IO13 | — (free) |
| 2 | 3V3 | 3V3 | 22 | IO14 | I2S_BCLK |
| 3 | EN | EN | 23 | IO21 | LED_DATA |
| 4 | IO4 | I2S_DIN | 24 | IO47 | EPD_MOSI |
| 5 | IO5 | IRQ | 25 | IO48 | EPD_DC |
| 6 | IO6 | CC2_SENSE (ADC1_CH5) | 26 | IO45 | CHG_CE (strap, 10 k pull-down) |
| 7 | IO7 | I2C_SCL | 27 | IO0 | BOOT (strap, 10 k pull-up) |
| 8 | IO15 | I2C_SDA | 28–30 | IO35–37 | unconnected (PSRAM) ✓ |
| 9 | IO16 | PGOOD | 31 | IO38 | PA_EN |
| 10 | IO17 | HOOK | 32 | IO39 | EPD_BUSY |
| 11 | IO18 | CHG_STAT | 33 | IO40 | EPD_RST |
| 12 | IO8 | CC1_SENSE (ADC1_CH7) | 34 | IO41 | EPD_CS |
| 13 | IO19 | HS_USB_DN (USB_D−) ✓ | 35 | IO42 | EPD_SCK |
| 14 | IO20 | HS_USB_DP (USB_D+) ✓ | 36 | RXD0 (GPIO44) | U0RXD |
| 15 | IO3 | HS_VBUS_EN (strap, 100 k pull-down) | 37 | TXD0 (GPIO43) | U0TXD |
| 16 | IO46 | — (strap, internal pull-down) | 38 | IO2 | I2S_WS |
| 17 | IO9 | — (free) | 39 | IO1 | I2S_DOUT |
| 18 | IO10 | HS_VBUS_SENSE (ADC1_CH9) | 40, 41 | GND, EPAD | GND |
| 19 | IO11 | I2S_MCLK | | | |
| 20 | IO12 | — (free) | | | |

Verified: every pin matches Table 3-1 and `schematic/pin_table.yaml`; analog inputs are on ADC1
(IO6/IO8/IO10 [WROOM p11]); wake inputs IO5/IO17 are RTC GPIOs [WROOM p11]. Free: IO9, IO12,
IO13 (useful for the queued hook-gating and CC-role changes, F-01/F-04).

## Recommended application circuit vs ours

| Datasheet / Espressif practice | Ours | Note |
|---|---|---|
| EN: RC delay (10 kΩ + 1 µF) so EN rises after the supply | 10 kΩ + 1 µF + RESET button | ✓ |
| 3V3 bulk + 0.1 µF at the module | 22 µF + 100 nF at pin 2 | ✓ |
| USB D± direct to IO19/IO20 | via SRV05-4 at J7, no series R | ✓ (no CMC; tune in EVT if needed) |
| External antenna per p44 | FPC antenna on the shell wall, type not chosen | ✗ F-02 |
| Flash/console: USB-Serial-JTAG on IO19/20 | IO19/20 used as **host**; flashing through CH340C on the power port (to be removed) | △ F-01 |

## Open issues

- F-01: flashing through the handset port needs the port to act as a USB **device** in download
  mode (Rd, not Rp, and VBUS switch off) — see FINDINGS.
- F-02: FPC antenna ≠ certification antenna type → possible additional EMC/radio testing.
- F-03: 3V3 up to ≈ 3.41 V > 3.3 V eFuse-write limit.
- The module operates only to +65 °C ambient (fine for HW-ENV-01, but keep it away from the
  charger and amplifier).
