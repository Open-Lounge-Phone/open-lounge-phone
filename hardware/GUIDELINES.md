# Hardware design guidelines (child-safe, rugged, KISS)

Rules the schematic and layout follow, updated for the minimal board (owner decision
2026-09-30: core only, 2 layers). They combine the owner-supplied "toy hardware" guidance
(2026-09-27) with current practice. Each rule says **adopted**, **adapted** (right idea, applied
differently, with the reason) or **rejected** (with the reason).

## 1. Safety and protection

| Rule | Status | How it's met |
|---|---|---|
| ESD protection on user-reachable conductors | **adapted** | One USB ESD part (USBLC6-2SC6) at the USB-C connector, the only port a user plugs things into often. The jack gets passive protection only (22 Ω earpiece series resistor, AC coupling, 1 kΩ on the detect line); the owner ruled out extra ESD networks. Revisit if EVT ESD tests fail. |
| Series resistance between anything user-facing and a GPIO | **adapted** | Jack insertion contact: 1 kΩ to IO4. Keys and the hook go **straight** to GPIOs (owner decision): an MX switch's contacts sit inside its housing and are not user-reachable. USB D+/D- go to the native USB pins behind the ESD part (USB needs them direct). RESET and BOOT are internal pinhole buttons. |
| Overcurrent protection | **adapted** | No fuse: a compliant USB source limits VBUS, there is no battery, and the LDO current-limits and shuts down on over-temperature (DESIGN.md §2). |
| Reverse-polarity protection | rejected | USB-C is keyed; VBUS and GND are on fixed pins. |
| Toy-safety standards (ASTM F963, EN 71-1, EN IEC 62115) | adopted as a design input | No sharp edges, screws needed to open the base, **captive keycaps** (§4). |

## 2. ESP32-S3 specifics

| Rule | Status | How it's met |
|---|---|---|
| Respect strapping pins | adopted | The S3's straps are **GPIO0, GPIO3, GPIO45, GPIO46** (not the original ESP32's 0/2/5/12/15). `check_pin_table` proves nothing can pull GPIO45/46 high at reset and GPIO0 has no pull-down. |
| Octal PSRAM pins | adopted | GPIO35-37 unconnected (N16R8), enforced by the pin table. |
| Antenna clearance | **adapted** | WROOM-1U with a plug-in U.FL antenna (owner): no board-edge keep-out; the antenna itself goes ≥ 15 mm from metal in the enclosure. |
| Use an expander when GPIOs run out | not needed | 12 keys, the hook, I2S, I2C, SPI, ringer and LED use 32 of the 33 usable GPIOs directly. |

## 3. Power and grounding

| Rule | Status | How it's met |
|---|---|---|
| Decoupling per the datasheets | adopted | Module 22 µF + 100 nF (WROOM-1 p41), codec per ES8311 p4, LDO in/out per SGM2212 p10. Layout: the capacitor sits between the pin and its GND via, ≤ 2 mm away. |
| I2C pull-ups sized for the bus | adopted | One pair of 4.7 kΩ; one device on the bus. |
| "Single-point grounding" | **rejected in favour of a ground pour** | Split grounds create slots that return currents detour around. On 2 layers: the bottom mostly GND, stitched to top GND pours; placement keeps the mic path away from USB, I2S clocks and the piezo drive. |

## 4. Mechanical and assembly

| Rule | Status | How it's met |
|---|---|---|
| Replaceable mechanical inputs | adopted | MX switches in hot-swap sockets for the keys **and** the hook. |
| **Captive keycaps** | adopted | Keycap skirt wider than the lid hole, inserted from inside: no small part to pull off. |
| Hardware RC debounce on every key | rejected | Metal-contact MX switches; firmware debounce (5-10 ms) is reliable and adds no parts. |
| Display: drop-in, not soldered | adopted | A ready-made module on a pin header (cable or jumpers). |
| Mounting holes | adopted | 4 × M3 near the corners and near the connectors, so plug forces go into the case. |
| Through-hole where force is applied | adopted | USB-C with through-hole shell tabs, the jack's locating pegs, THT header. |
| Clear silkscreen | adopted | Key legends, connector labels, J3 pin order, the owner's signature logo, "Open Lounge Phone", "CERN-OHL-S-2.0", revision. |
| Stackup | adopted | **2 layers**, 1.6 mm, the cheapest process at every fab. |

## 5. Layout rules (common 2-layer capability, with margin)

| Net class | Width | Clearance | Notes |
|---|---|---|---|
| Default signal | 0.2 mm (0.15 min) | 0.15 mm | |
| I2S, I2C, SPI | 0.2 mm | 0.2 mm | I2S clocks short, over GND |
| USB D+/D- | pair, matched within 0.15 mm | — | full speed; see BOARD_REQUIREMENTS BR-21 |
| Audio (mic, earpiece) | 0.25 mm | 0.3 mm | short, guarded by GND |
| VBUS, 3V3 | ≥ 0.5 mm or pour | 0.2 mm | |
| Vias | 0.3 mm drill / 0.6 mm pad | | ≥ 2 vias per power transition |

## 6. Review gates before a layout is done

1. `make build` passes; KiCad DRC 0 errors, 0 unconnected items.
2. A written review against the installed `kicad`, `emc` and `pcb-layout-review` skills
   (`hardware/tools/install-skills.sh`), every finding fixed or explained.
3. Rendered top/bottom/3D images inspected by a person or agent.
4. Every rule in this file checked off in the review record.
