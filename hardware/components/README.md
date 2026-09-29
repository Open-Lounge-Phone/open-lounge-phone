# Component files (H2)

One file per distinct part of the board (passives grouped by type), checked against the vendor
datasheet and our footprints, traced to [../REQUIREMENTS.md](../REQUIREMENTS.md). The ranked list of
problems found is [FINDINGS.md](FINDINGS.md) (input for H5); the SPICE coverage for H4 is at its end.

Conventions: datasheet page numbers are PDF pages (`[p12]`); stock and prices are LCSC/JLCPCB data
fetched on **2026-09-29** (JLC assembly price at quantity 1 and at 1 000); **basic**/**extended** is
the JLCPCB library type. Datasheets are linked, not committed. **UNVERIFIED** marks anything that
could not be checked.

| File | Part (MPN) | Refs | Function | LCSC | JLC lib | Stock | Lifecycle | Vendor SPICE | Findings |
|---|---|---|---|---|---|---|---|---|---|
| [esp32-s3-wroom-1u.md](esp32-s3-wroom-1u.md) | ESP32-S3-WROOM-1U-N16R8 | U1 | MCU, Wi-Fi/BLE, USB host | C3013946 | ext | 17 k | active | no | F-01, F-02, F-03 |
| [es8311.md](es8311.md) | ES8311 | U6 | DAC (speaker, AEC ref) | C962342 | ext | 101 k | UNVERIFIED | no | F-06 |
| [es7210.md](es7210.md) | ES7210 | U7 | 4-ch ADC (mic, AEC ref) | C365743 | ext | 33 k | UNVERIFIED | no | F-09, F-14 |
| [ns4150b.md](ns4150b.md) | NS4150B | U9 | class-D speaker amp | C189961 | ext | 148 k | UNVERIFIED | no | F-06 |
| [bq24074.md](bq24074.md) | BQ24074RGTR | U2 | charger + power path | C54313 | ext | **432** | active | no | F-07, F-10, F-11, F-24 |
| [tlv62569.md](tlv62569.md) | TLV62569DBVR | U3 | 3V3 buck | C141836 | ext | 246 k | active | **yes** | F-03, F-19 |
| [lp5907.md](lp5907.md) | LP5907MFX-3.0/NOPB | U4 | 3V0 analog LDO | C475492 | ext | 29 k | active | **yes** | F-08 |
| [max17048.md](max17048.md) | MAX17048G+T10 | U14 | fuel gauge | C2682616 | ext | 24 k | UNVERIFIED | no | — |
| [sy6280.md](sy6280.md) | SY6280AAC | U15 | handset VBUS switch | C55136 | ext | 135 k | UNVERIFIED | no | F-04, F-05 |
| [ch340c.md](ch340c.md) | CH340C | U16 | USB-UART (queued for removal) | C84681 | ext | 140 k | active | n/a | F-01 |
| [aw9523b.md](aw9523b.md) | AW9523BTQR | U17 | I/O expander (keys) | C148077 | ext | 77 k | UNVERIFIED | n/a | F-20 |
| [sn74lv1t125.md](sn74lv1t125.md) | SN74LV1T125DBVR | U5 | LED data level shift | C473338 | ext | 213 k | active | **yes** | — |
| [drv5032.md](drv5032.md) | DRV5032FADBZR | U10 | hook Hall switch | C140921 | ext | 27 k | active | no | F-04, F-13, F-26 |
| [lis2dh12.md](lis2dh12.md) | LIS2DH12TR | U12 | accelerometer | C110926 | ext | **0** | UNVERIFIED | n/a | F-16 |
| [ltr-303als.md](ltr-303als.md) | LTR-303ALS-01 | U18 | ambient light | C364577 | ext | 16 k | UNVERIFIED | n/a | — |
| [st25dv04k.md](st25dv04k.md) | ST25DV04K-IER6S3 | U19 | NFC tag | C155601 | ext | 5 k | **NRND** | no | F-17, F-18, F-27 |
| [nfc-coil.md](nfc-coil.md) | PCB coil (custom) | L2 | 13.56 MHz antenna | — | — | — | — | calc | F-18 |
| [sk6812mini-e.md](sk6812mini-e.md) | SK6812MINI-E | D5, D6, D10–D20 | key/status RGB LEDs | C5149201 | ext | 228 k | UNVERIFIED | no | F-25 |
| [kt-0603r.md](kt-0603r.md) | KT-0603R | D21 | mic light (red) | C2286 | basic | 4.9 M | UNVERIFIED | no | F-09, F-28 |
| [usblc6-2sc6.md](usblc6-2sc6.md) | USBLC6-2SC6 | D1, D2 | USB/CC ESD (power port) | C7519 | ext | 25 k | active? | likely | — |
| [srv05-4.md](srv05-4.md) | SRV05-4.TCT | D4, D7 | 4-line TVS (handset, side keys) | C13612 | ext | 49 k | active? | likely | F-04 |
| [smf5.0a.md](smf5.0a.md) | SMF5.0A | D3 | VBUS TVS | C151296 | ext | 36 k | active? | likely | F-07 |
| [smd1206p150tf.md](smd1206p150tf.md) | SMD1206P150TFT | F1 | input PTC | C495353 | ext | 3 k | UNVERIFIED | no | F-07 |
| [b5819w.md](b5819w.md) | B5819W SL | D8, D9 | handset supply diode-OR | C8598 | basic | 547 k | active | generic | F-05 |
| [mbr0530.md](mbr0530.md) | MBR0530T1G | D22–D24 | e-ink boost diodes | C82046 | ext | 337 k | active? | likely | — |
| [mmbt3904.md](mmbt3904.md) | MMBT3904 | Q1, Q5, Q6 | NPN (mic light, auto-reset) | C20526 | basic | 267 k | active | generic | F-09 |
| [ao3400a.md](ao3400a.md) | AO3400A | Q3, Q4 | N-FET switches | C20917 | basic | 1.0 M | active | likely | — |
| [ao3401a.md](ao3401a.md) | AO3401A | Q2 | LED power P-FET | C15127 | basic | 812 k | active | likely | — |
| [si1308edl.md](si1308edl.md) | Si1308EDL-T1-GE3 | Q7 | e-ink boost FET | C469327 | ext | 42 k | active | no | — |
| [usb-c-type-c-31-m-12.md](usb-c-type-c-31-m-12.md) | TYPE-C-31-M-12 | J1, J7 | USB-C receptacles | C165948 | ext | 441 k | UNVERIFIED | n/a | F-01, F-22 |
| [jst-ph-sm4-tb.md](jst-ph-sm4-tb.md) | S2B-/S3B-PH-SM4-TB | J4, J2 | speaker / battery | C295747, C265101 | ext | 22 k / 4.6 k | active | n/a | F-10 |
| [fpc-05f-24ph20.md](fpc-05f-24ph20.md) | FPC-05F-24PH20 | J6 | e-ink ZIF | C2856805 | ext | 111 k | UNVERIFIED | n/a | F-12 |
| [kailh-cpg151101s11.md](kailh-cpg151101s11.md) | CPG151101S11-16 | SW6–SW17 | MX hot-swap sockets | C5156480 | ext | **0** | UNVERIFIED | n/a | F-24 |
| [skrtlae010.md](skrtlae010.md) | SKRTLAE010 | SW3, SW4 | VOL−/VOL+ | C110293 | ext | 89 k | active? | n/a | — |
| [js202011aqn.md](js202011aqn.md) | JS202011AQN | SW5 | MUTE slide (DPDT) | C221662 | ext | 7 k | active? | n/a | F-15, F-30 |
| [ts-1187a.md](ts-1187a.md) | TS-1187A-B-A-B | SW1, SW2 | RESET / BOOT | C318884 | basic | 523 k | active | n/a | — |
| [gmi6027-electret.md](gmi6027-electret.md) | GMI6027-2C42DB | MK1 | base microphone | C233885 | ext | **995** | UNVERIFIED | no | F-25, F-29 |
| [gdey029t94.md](gdey029t94.md) | GDEY029T94 | (panel) | e-ink strip | — | — | — | UNVERIFIED | no | F-12 |
| [resistors.md](resistors.md) | UNI-ROYAL 0603WAF series | R1–R65 | 21 values | various | mostly basic | ≥ 132 k | active | ideal | F-03, F-06, F-14, F-20 |
| [capacitors.md](capacitors.md) | Samsung CL / Yageo CC0603 | C1–C88 | 12 values | various | basic | ≥ 783 k | active | vendor tools | F-05, F-08, F-11, F-19 |
| [inductors-ferrites.md](inductors-ferrites.md) | SWPA4020S2R2MT, SWPA4020S470MT, BLM18PG121SN1D | L1, L3, FB1, FB2 | buck, boost, speaker EMI | C83423, C83427, C14709 | ext / ext / basic | 34 k / **1.5 k** / 2.0 M | UNVERIFIED | Murata | F-24 |
| [off-board.md](off-board.md) | antenna, handset, speaker, switches, keycaps, battery, magnet, posts | — | parts outside the PCB BOM | — | — | — | — | — | F-02, F-10, F-13, F-21, F-26 |

"active?" = believed active from the vendor's mainstream status, vendor page not reachable from this
environment (UNVERIFIED). "likely" = the vendor is known to publish SPICE models for this family,
not confirmed for this part.

**Counts:** 42 part files — 38 for individual parts (the JST file covers both header sizes; the
custom NFC coil and the e-ink panel included), 3 grouped passive files (21 resistor values, 12
capacitor values, 3 inductor/bead parts) and 1 off-board file — plus this index and FINDINGS.md.
