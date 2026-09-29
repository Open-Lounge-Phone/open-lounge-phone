# Hardware design guidelines (child-safe, rugged, KISS)

Rules the schematic and layout follow. They combine the owner-supplied "toy hardware" guidance
(2026-09-27) with DESIGN.md and current best practice. Each rule says **adopted**, **adapted**
(the idea is right but applied differently for this design, with the reason), or **rejected**
(with the reason). Layout work must satisfy every adopted/adapted rule; reviewers check them.

## 1. Safety and protection

| Rule | Status | How it's met |
|---|---|---|
| ESD protection on every user-reachable conductor | adopted | Power USB-C D+/D−/CC: USBLC6-2SC6 ×2; VBUS: SMF5.0A TVS. Handset 3.5 mm jack (H5): 2 × PESD5V0S2BT, bidirectional (the AC-coupled earpiece swings below GND), on T, R1, S and the insertion contact. Side switches (VOL±, MUTE) at the main board edge: SRV05-4. Place every TVS **at the connector**, ground via ≤ 1 mm to the GND plane, before anything else on the line. |
| Series resistance between anything user-facing and a GPIO | adopted | CC sense: 1 kΩ. Handset jack (H5): insertion contact 1 kΩ to GPIO12, mic-line sense through a diode + 100 kΩ to GPIO10, hook read through 47 kΩ; the power port's D+/D− go to the native USB pins behind the USBLC6 (USB needs them direct). Keys/side switches reach the AW9523B expander, **never a bare ESP32 pin**. The only ESP32-direct buttons (RESET, BOOT) are internal pinhole buttons. `checks.py` should flag any connector/switch net that reaches the ESP32 without a TVS or ≥ 100 Ω series R (to add). |
| Overcurrent protection | adopted | 2 A-hold PTC (1812, H5) on VBUS, plus BQ24074 input current limit (1.35 A guaranteed); budget enforced by `check_power_budget`. |
| Reverse-polarity P-MOSFET | **rejected** | USB-C is reversible and keyed, with VBUS/GND on fixed pins: a USB-C source can't present reverse polarity. The TVS + PTC handle faulty chargers. An extra FET would add a part and ~50 mV drop for no failure mode. (Revisit only for a barrel-jack or battery-terminal variant; the battery option uses a keyed, polarized JST-PH.) |
| Toy-safety standards (ASTM F963, EN 71-1, EN 18031-2) | adopted as a design input | Whether the Kids phone is legally a "toy" is an open owner question, but design as if it is: no sharp edges, screws needed to reach electronics/battery, and **captive keycaps** (§4). |
| Battery safety | adopted | Battery is an option, not the default. When fitted: protected 1S pack, NTC to the charger's TS pin, polarized latching connector, screwed compartment. |

## 2. ESP32-S3 specifics

| Rule | Status | How it's met |
|---|---|---|
| Respect strapping pins | **adapted** | The advice lists GPIO 0/2/5/12/15. Those are the *original ESP32's* straps. The ESP32-S3's are **GPIO0, GPIO3, GPIO45, GPIO46**; each has the required pull in `pin_table.yaml`, checked by `check_pin_table`. |
| Octal PSRAM pins | adopted | GPIO35–37 left unconnected (N16R8), enforced by the pin table. |
| Antenna ≥ 15 mm from metal, keep-out on all layers | **adapted** | In the compact base no board edge is ≥ 15 mm from the metal hook tubes and brass inserts, so the module is the **ESP32-S3-WROOM-1U** (U.FL) and a small adhesive FPC antenna sits on the inside of the shell wall, ≥ 15 mm from metal (placement in LAYOUT.md and the enclosure). Reverting to the PCB-antenna WROOM-1 needs a board edge with that clearance. |
| Pin allocation via expander when GPIOs run out | adopted | AW9523B (16 I/O, I2C) handles keys, side switches and LED power; the ESP32 keeps the timing-critical signals (I2S, SPI, RMT, UART). |

## 3. Power, sensors, grounding

| Rule | Status | How it's met |
|---|---|---|
| Decoupling: 100 nF at every supply pin + bulk (≥ 10 µF) per rail/IC group | adopted | Present in the schematic. Layout rule: **the 100 nF goes between the pin and the via to GND**, ≤ 2 mm from the pin, via-in-pad or a short direct via. |
| Power-gate sensors that draw real current | adopted where it matters | The LED chain via `LED_PWR_EN` (the LD2410C radar and its switch were removed 2026-09-28). The other sensors draw µA and have their own sleep modes; adding switches for them would only add parts (KISS). |
| Low-noise supply for analog | adopted | LP5907 3.0 V (6.5 µVrms) feeds the codecs and mic bias only. |
| I2C pull-ups sized for the bus | adopted | One shared pair on the board (4.7 kΩ, SCHEMATIC.md). Check total bus capacitance after layout; don't add more pull-ups. |
| "Single-point grounding" | **rejected in favour of a solid ground plane** | On a 4-layer board, splitting ground or star-grounding creates slots that return currents detour around, which *increases* noise and emissions. Current best practice (and Espressif's and TI's layout guides) is **one unbroken GND plane (L2)**, with *placement* doing the isolation: keep the class-D amp, buck and LEDs away from the codecs, mic inputs and handset lines, and never route across a plane gap. |

## 4. Mechanical and assembly

| Rule | Status | How it's met |
|---|---|---|
| Replaceable mechanical inputs | adopted | MX-compatible switches in Kailh hot-swap sockets (no soldering to replace). |
| **Captive keycaps** (new) | adopted | A pulled-off keycap is a small part and gets lost. Keycaps sit under the enclosure skin with a retaining lip (keycap skirt wider than the 19.5 mm skin hole, inserted from inside), so they can't be pulled out without opening the case. Replacing a switch means removing the case screws. Record in the enclosure spec; the PCB impact is none. |
| Hardware RC debounce on every key | **rejected** | These are metal-contact MX switches read through the AW9523B's interrupt; software debounce (5–10 ms) is reliable and standard for keyboards. RC filters would add 20 parts and slow the interrupt edge. Keep a 100 nF footprint (DNP) only on the hook/mute lines if field testing shows problems. |
| E-ink strip: drop-in, not soldered | adopted | FPC into a 24-pin 0.5 mm ZIF connector; replaceable without tools. |
| Mounting holes | **adapted** | The advice says M3/M4. Board space under the handset trough is tight, so **M2.5 plated holes with generous copper keep-out** (5.5 mm) and **plastite screws into bosses**, one within 10 mm of every connector and switch cluster so impact loads go into the case, not solder joints. The switch plate (the prototype box lid), not the PCB, takes keystroke force. |
| Through-hole where force is applied | adopted | USB-C receptacles (power and handset) with through-hole shell tabs, right-angle through-hole MUTE slide, ZIF/FFC connectors with hold-down tabs. Plain SMD pads are not used for anything a user pulls on. |
| Clear silkscreen for maintenance | adopted | Label connectors, test points, the DNP tuning cap, key numbers, board name/revision, the owner's signature logo and "Open Lounge Phone", and "CERN-OHL-S-2.0" on the board. |
| Stackup | adopted | 4-layer JLCPCB standard (1.6 mm): L1 signal + parts, L2 **solid GND**, L3 power pours (3V3, VSYS, 3V0, VLED) + slow signals, L4 signal. |

## 5. Layout rules (JLCPCB 4-layer standard capability, with margin)

| Net class | Width | Clearance | Notes |
|---|---|---|---|
| Default signal | 0.15 mm (6 mil) min, 0.2 mm preferred | 0.15 mm | |
| I2C, SPI, I2S, LED data | 0.2 mm | 0.2 mm | Keep I2S MCLK/BCLK short, over solid GND, away from the analog section. |
| USB D+/D− | 90 Ω differential (~0.2 mm/0.15 mm gap on L1 over L2; use the JLC impedance calculator) | — | Length-matched within 0.15 mm, no vias, ESD right at the connector. |
| Analog audio (mic, earpiece, AEC reference) | 0.25 mm | 0.3 mm | Short, guarded with GND, away from the amp/buck/LEDs. |
| Power 3V3/3V0 | 0.4 mm (16 mil) min or pour | 0.2 mm | |
| Power VSYS/VBUS/VBAT, speaker out | **0.6 mm (24 mil) min** or pour; speaker out 0.5 mm pair | 0.25 mm | ≥ 1.2 A peak. Never below 0.5 mm (20 mil) for any power path. |
| GND | pour on L2 (solid) + L1/L4 fills stitched every ~5 mm and along board edges | — | |
| Vias | 0.3 mm drill / 0.6 mm pad (JLC standard; no extra cost) | | Use ≥ 2 vias for every power transition. |

## 6. Review gates before calling a layout done

1. `make build` (schematic checks) and `make layout` pass: 0 DRC errors, 0 unconnected items,
   no courtyard overlaps.
2. A written review against the installed `kicad`, `emc` and `pcb-layout-review` skills (see
   `hardware/tools/install-skills.sh`), with every finding fixed or explained.
3. Rendered top/bottom/3D images inspected by a person or agent. ERC/DRC don't replace looking.
4. Every rule in this file checked off in the review record.
