# ESP32-S3-WROOM-1U-N16R8 — MCU module (U1)

| | |
|---|---|
| MPN / maker | ESP32-S3-WROOM-1U-N16R8, Espressif Systems |
| Function here | MCU; Wi-Fi 2.4 GHz + BLE through a U.FL antenna (owner 2026-09-30: a general-purpose, user-upgradable 2.4 GHz antenna; no board-edge keep-out); native USB device on IO19/IO20 (flashing + USB-Serial-JTAG console); I2S + I2C to the ES8311, SPI to the display header, 13 key/hook inputs, buzzer, status LED |
| Datasheet | ESP32-S3-WROOM-1 & WROOM-1U datasheet **v1.8**: https://www.espressif.com/sites/default/files/documentation/esp32-s3-wroom-1_wroom-1u_datasheet_en.pdf |
| LCSC / JLC | C3013946; ~$4.97 @1, $3.43 @1k (JLC); **extended** |
| Alternates | ESP32-S3-WROOM-1-N16R8 (PCB antenna, C2913202, same pinout, needs an edge keep-out); -N8R8 (8 MB flash) |

## Key specs we rely on

| Spec | Value | Source |
|---|---|---|
| Flash / PSRAM | 16 MB flash, 8 MB **octal** PSRAM → IO35-37 not usable | [p3], [p12] |
| Ambient temperature (N16R8) | −40 … +65 °C | [p3] |
| Supply | VDD33 3.0 / 3.3 / 3.6 V; the supply must deliver ≥ 0.5 A | [p27] |
| Wi-Fi TX peak | 355 mA (802.11b, 20.5 dBm); BLE 20 dBm 344 mA | [p28] |
| Strap defaults | GPIO0 weak pull-up (SPI boot); GPIO45 and GPIO46 weak pull-down; GPIO3 floating, read only if EFUSE_STRAP_JTAG_SEL is burned | [p13-15] |
| Boot modes | GPIO0 = 0 and GPIO46 = 0 → joint download (USB-Serial-JTAG, UART0) | [p14] |
| Strap timing | setup 0 ms, hold 3 ms after EN | [p14] |
| Peripheral circuit | 3V3: 22 µF + 0.1 µF; EN: 10 kΩ + 1 µF RC delay | [p41] |
| External antenna | 2.4 GHz, 50 Ω, U.FL (MHF I); the modular certification assumes the same antenna type with gain ≤ 2.33 dBi | [p43-44] |

## Our circuit

22 µF + 100 nF at pin 2, EN 10 kΩ / 1 µF + RESET (SW1), BOOT (SW2) on GPIO0 with the internal
pull-up only. GPIO map: `schematic/pin_table.yaml` (checked by `make build`). Straps: keys on
GPIO3 and GPIO46 can only pull low, which is the required value; GPIO45 (VDD_SPI, must be
low = 3.3 V flash) is left free. IO43 (TXD0) carries key 6 and IO44 (RXD0) key 7. On the board
the module sits on the bottom with its antenna end (U.FL) at the left edge (DESIGN.md §9).

## Open issues

- The shipped antenna is not chosen; a different antenna type than Espressif's certification
  antenna may need extra radio/EMC testing ([p44]).
