# Off-board parts (not on the PCB BOM)

Parts the base needs that are not assembled on the board. None has an LCSC code in the
schematic; prices are `schematic/cost_model.yaml` estimates (dated 2026-09-27, marked EST there).
All are **UNVERIFIED** until a specific product is chosen — this file lists the requirements each
choice must meet.

| Item | Requirement IDs | What the choice must satisfy | Status |
|---|---|---|---|
| **2.4 GHz antenna** (U.FL, on the shell wall) | HW-FUNC-14, HW-MECH-04, HW-REG-01, -03 | 2.4 GHz, 50 Ω, 1st-gen U.FL/MHF I, gain ≤ 2.33 dBi, **same type as the certification antenna** (monopole TFPD05H08750011) or accept extra EMC/radio tests [WROOM-1U datasheet v1.8 p43-44]; ≥ 15 mm from metal | ✗ F-02: an adhesive FPC antenna is planned — a different type |
| **USB-C UAC handset** (Native Union POP class) or any USB-C headset | HW-FUNC-06, HW-ELEC-17, -19 | USB Audio Class 1.0, full speed, bus-powered within 450 mA at ≥ 4.4 V; works with a C-to-C cable ≤ 2 m; formats 16/48 kHz | △ no model qualified; F-05 (VBUS level), F-04 (power gating) |
| **Speaker** 20 × 40 mm, ≤ 5 mm thick | HW-FUNC-04, HW-ELEC-14 | 4 Ω (or 8 Ω), ≥ 1 W rated, sensitivity ≥ 85 dB/1 W/1 m (to meet the ringer target with the available power, F-06), JST-PH-2 lead | △ not chosen |
| **MX switches** × 12 | HW-FUNC-01, HW-ENV-04 | MX-compatible, 3-pin or 5-pin, tactile ~55 gf, ≥ 1 M presses, LED window for the reverse-mount SK6812 | △ not chosen |
| **Keycaps** × 12 | HW-FUNC-01, HW-SAFE-04 | MX stem, 1u, shine-through or relegendable; **captive** (skirt wider than the lid hole) | △ enclosure |
| **1S battery pack** (optional) | HW-FUNC-13, HW-SAFE-02, HW-REG-06 | ≤ 40 × 30 × 6 mm (603040 ≈ 700 mAh), protection circuit, 10 kΩ NTC (β ≈ 3435, UNVERIFIED match to the BQ24074 window [BQ24074 p13]), **JST-PH 3-pin with pin 1 VBAT, 2 NTC, 3 GND**, UN 38.3 + IEC 62133-2 documents | ✗ F-10 (pinout/NTC not specified) |
| **Hook magnet** (N35 Ø3 × 1.5 mm in the plunger) | HW-FUNC-08, HW-SAFE-04 | off-hook field < 0.5 mT at the sensor (F-26); captive in the base (toy magnet rules) | ✗ F-21, F-26 |
| **Hook posts** (metal rod/tube, owner decision) | HW-MECH-04, HW-ELEC-22 | ≥ 15 mm from the antenna; ESD path defined (grounded or insulated with a gap) | ✗ F-13 |
| **Heat-set inserts, screws** | HW-MECH-06, HW-SAFE-04 | M2.5; screws required to open the base and battery compartment | ✓ (PROTO_BOX) |
| **USB-C power adapter** (shipped) | HW-ELEC-03 | 5 V, advertises ≥ 1.5 A (owner: ship 5 V / 3 A) | △ not chosen |

## Open issues

- F-02, F-10, F-13, F-21, F-26 (see FINDINGS).
