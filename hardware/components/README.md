# Component files (minimal board, M1)

One file per distinct part of the minimal board (passives grouped by type): what it does here,
the datasheet and page each choice rests on, sourcing, and what is still unverified. The old
board's part files (charger, fuel gauge, expander, LEDs, NFC, radar, speaker amp, ...) were
removed on 2026-09-30 with the parts; git history keeps them.

Conventions: datasheet page numbers are PDF pages (`[p12]`); stock and prices are LCSC/JLCPCB
data from `schematic/lcsc_cache.json` (checked 2026-09-29/30, `make lcsc` refreshes them);
**basic**/**extended** is the JLCPCB library type. Datasheets are linked, not committed.
**UNVERIFIED** marks anything that could not be checked.

| File | Part (MPN) | Refs | Function | LCSC | JLC lib |
|---|---|---|---|---|---|
| [esp32-s3-wroom-1u.md](esp32-s3-wroom-1u.md) | ESP32-S3-WROOM-1U-N16R8 | U1 | MCU, Wi-Fi/BLE (U.FL antenna), native USB | C3013946 | ext |
| [sgm2212.md](sgm2212.md) | SGM2212-3.3XKC3G/TR | U2 | 3.3 V LDO, 800 mA | C3294699 | ext |
| [es8311.md](es8311.md) | ES8311 | U3 | codec: handset mic ADC, earpiece DAC | C962342 | ext |
| [usb-c-type-c-31-m-12.md](usb-c-type-c-31-m-12.md) | TYPE-C-31-M-12 | J1 | USB-C: 5 V in + native USB | C165948 | ext |
| [pj-31060.md](pj-31060.md) | PJ-31060 | J2 | 3.5 mm TRRS handset jack | C2939583 | ext |
| [display-header.md](display-header.md) | HX PM2.54-2x4P ZC | J3 | 2x4 socket for the display module | C32713305 | ext |
| [usblc6-2sc6.md](usblc6-2sc6.md) | USBLC6-2SC6 | D1 | USB D+/D- ESD | C7519 | ext |
| [ltst-c230krkt.md](ltst-c230krkt.md) | LTST-C230KRKT | D2 | status LED (reverse mount) | C125107 | ext |
| [ps1240p02bt.md](ps1240p02bt.md) | PS1240P02BT | BZ1 | piezo ringer | C76871 | ext |
| [mmbt3904.md](mmbt3904.md) | MMBT3904 | Q1 | ringer driver | C20526 | basic |
| [kailh-cpg151101s11.md](kailh-cpg151101s11.md) | CPG151101S11-2 | SW3-SW15 | MX hot-swap sockets: 12 keys + hook | C49352235 | ext |
| [ts-1187a.md](ts-1187a.md) | TS-1187A-B-A-B | SW1, SW2 | RESET, BOOT | C318884 | basic |
| [capacitors.md](capacitors.md) | MLCC | C1-C15 | decoupling, bulk, audio coupling | various | basic |
| [resistors.md](resistors.md) | 0603 thick film | R1-R13 | CC, EN, pull-ups, audio, drivers | various | basic |
| [off-board.md](off-board.md) | — | — | display module, switches, keycaps, antenna, handset | — | — |

The current BOM with every value is `build/main/bom.csv` (`make build`).
