# Open Lounge Phone hardware requirements (minimal board)

Numbered requirements for the minimal board ([DESIGN.md](DESIGN.md)).

**Verification:** A = analysis, I = inspection, T = test (EVT), S = `make build` check or
`make sim` bench. **Status:** ✓ met in the schematic, △ depends on layout/enclosure/test, ✗ open.

## 1. Functional (HW-FUNC)

| ID | Requirement | Verif. | Status |
|---|---|---|---|
| HW-FUNC-01 | 12 MX-compatible keys in hot-swap sockets, two rows of six at 19.05 mm: `1 2 3 4 5 MENU` (rear), `6 7 8 9 0 BACK` (front); each on its own ESP32 GPIO to GND with the internal pull-up (no expander, no matrix). | S (`check_keys`) | ✓ |
| HW-FUNC-02 | Hook state from one switch pressed by the hook rest (an MX switch in a 13th socket), on an RTC GPIO; low = on hook. | S, T | ✓ / △ plunger |
| HW-FUNC-03 | A 2x4 2.54 mm socket the WeAct 2.9" e-paper module plugs into (its header order BUSY RES DC CS CLK DIN GND VCC, 3.3 V) + two M3 standoff holes at its mounting holes. | I | ✓ |
| HW-FUNC-04 | Handset on a 3.5 mm TRRS jack (CTIA): earpiece on T and R1, mic on S, R2 GND; ES8311 codec with its datasheet reference parts; insertion detect from the jack's normally-closed tip contact. | I, T | ✓ |
| HW-FUNC-05 | Ringer: a piezo buzzer driven by one GPIO through a transistor. | I, T | ✓ / △ loudness |
| HW-FUNC-06 | One status LED on a GPIO. | I | ✓ |
| HW-FUNC-07 | Wi-Fi 2.4 GHz and BLE from a pre-certified module with a U.FL antenna (ESP32-S3-WROOM-1U-N16R8), user-upgradable antenna. | I | ✓ / △ antenna choice |
| HW-FUNC-08 | Firmware flashing and the console over the USB-C port with any cable (native USB, USB-Serial-JTAG), plus RESET and BOOT buttons reachable without opening the case (pinholes). | I, T | ✓ / △ enclosure |

## 2. Electrical (HW-ELEC)

| ID | Requirement | Verif. | Status |
|---|---|---|---|
| HW-ELEC-01 | USB-C sink with a separate 5.1 kΩ Rd on CC1 and CC2, no PD; works from any USB-C source or USB-A to C cable at USB default power (≤ 500 mA). | S (`check_power_budget`) | ✓ |
| HW-ELEC-02 | One 3.3 V regulator rated ≥ 600 mA and ≥ the module's 0.5 A supply requirement (WROOM-1 p27), with ≥ 20 % margin over the 3V3 peak. | S | ✓ (800 mA vs ~450 mA) |
| HW-ELEC-03 | 3V3 at the module stays within 3.0-3.6 V (WROOM-1 p27) during a Wi-Fi TX burst at the lowest USB voltage (4.40 V) and at hot-plug; 3V3 is up before the EN RC releases the chip. | S (`make sim` b01) | ✓ |
| HW-ELEC-04 | The regulator's junction stays ≤ 125 °C at 40 °C ambient with the average call load. | S | ✓ (≈ 86 °C) |
| HW-ELEC-05 | Decoupling and bulk per the module and codec datasheets (WROOM-1 p41: 22 µF + 0.1 µF, EN 10 kΩ/1 µF; ES8311 p4). | I | ✓ |
| HW-ELEC-06 | Strapping pins safe at reset: GPIO0 high (internal pull-up) unless BOOT is held; GPIO45/GPIO46 never pulled high by anything on their nets; GPIO3 only on a key; IO35-37 unconnected. | S (`check_pin_table`) | ✓ |
| HW-ELEC-07 | One USB ESD part at the connector on D+/D-. | I | ✓ |
| HW-ELEC-08 | The USB pair (full speed) is short, length-matched within 0.15 mm and routed over unbroken ground (BOARD_REQUIREMENTS BR-21). | I (layout) | △ M2 |
| HW-ELEC-09 | I2C meets its rise time at 100 kHz (≤ 1 µs) with 4.7 kΩ pull-ups. | A | ✓ |
| HW-ELEC-10 | Earpiece drive AC-coupled with a series resistor (plug-in short); mic bias RC-filtered from 3V3. | I, T | ✓ |

## 3. Safety (HW-SAFE)

| ID | Requirement | Verif. | Status |
|---|---|---|---|
| HW-SAFE-01 | Powered only by USB (≤ 5.25 V); no mains, no battery inside. | I | ✓ |
| HW-SAFE-02 | No fuse is required: the USB source limits VBUS current, and the regulator current-limits and shuts down on over-temperature (SGM2212 p6, p10). Revisit if anything that stores energy is added. | A | ✓ |
| HW-SAFE-03 | Toy-safety design intent for the Kids phone (EN 71-1, EN IEC 62115, ASTM F963; not certified): no part removable without a tool, captive keycaps, screws to open the base. | I (enclosure) | △ |

## 4. Mechanical (HW-MECH)

| ID | Requirement | Verif. | Status |
|---|---|---|---|
| HW-MECH-01 | 2-layer board, proposed 160 × 88 mm, 1.6 mm; four M3 mounting holes. | I | △ M2 |
| HW-MECH-02 | The board carries the owner's signature logo, "Open Lounge Phone", "CERN-OHL-S-2.0" and its revision in a clear silkscreen area. | I | ✓ (G1, G2 in the netlist) / △ placement |
| HW-MECH-03 | Keys: sockets on the bottom, switch pitch 19.05 mm; the enclosure's switch plate takes keystroke force. | I | △ M2 |
| HW-MECH-04 | Hook plunger: ≥ 2 mm and ≤ 4 mm travel onto the hook switch, captive. | I | △ enclosure |

## 5. Environmental (HW-ENV)

| ID | Requirement | Verif. | Status |
|---|---|---|---|
| HW-ENV-01 | Operating ambient 0 … +40 °C indoors (module rated to +65 °C, WROOM-1 p3). | A | ✓ |
| HW-ENV-02 | Storage −20 … +60 °C. | A | ✓ |

## 6. Regulatory intent (HW-REG)

| ID | Requirement | Verif. | Status |
|---|---|---|---|
| HW-REG-01 | FCC Part 15 B / ICES-003 / CE (RED) for the host, relying on the module's radio certification; the antenna must match the certified type and ≤ 2.33 dBi or get extra testing (WROOM-1 p44). | A | △ antenna |
| HW-REG-02 | RoHS: every BOM line RoHS-compliant. | I | △ |

## 7. Manufacturing and cost (HW-MFG)

| ID | Requirement | Verif. | Status |
|---|---|---|---|
| HW-MFG-01 | Orderable at JLCPCB (reference) and portable to any fab: 2 layers, ≥ 0.15/0.15 mm, ≥ 0.3 mm drill; Gerber X2 + Excellon + IPC-2581, generic BOM and pick-and-place. | I | △ M2 |
| HW-MFG-02 | Prefer JLC basic parts; every extended line must be needed for function. | S (BOM "JLC library" column) | ✓ (9 extended) |
| HW-MFG-03 | Every LCSC code exists and is in stock at JLCPCB at design freeze. | S (`check_sourcing`, `make lcsc`) | ✓ |
| HW-MFG-04 | Cost: affordable one-off (a hobbyist's minimum JLCPCB order) and cheap at scale; the phone's electronics ≤ $28-40. | S (`cost.py`) | ✓ ($6.07 board + ~$14.50 off-board at 1k) |
| HW-MFG-05 | Hand-assembly possible: 0603 and larger, no BGA; the only fine-pitch parts are the ES8311 (QFN-20) and the module's ground pad. | I | ✓ |
