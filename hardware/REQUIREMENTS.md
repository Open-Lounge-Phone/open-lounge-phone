# Open Lounge Phone hardware requirements (H1)

Status: **draft 1, 2026-09-29.** Phase H1 of the hardware process: numbered, traceable
requirements for the one 180 × 88 mm board and the parts of the base it interacts with. Phase H2
(`components/`) documents every part against these IDs, and `components/FINDINGS.md` lists every
place where the current schematic or board does not yet meet them. Nothing here changes the
schematic or layout; it is the yardstick for H3 (test plan), H4 (simulation) and H5 (changes).

Sources: owner decisions in [DESIGN.md](DESIGN.md) (top box), [GUIDELINES.md](GUIDELINES.md),
[SCHEMATIC.md](SCHEMATIC.md), [LAYOUT.md](LAYOUT.md),
[enclosure/PROTO_BOX.md](enclosure/PROTO_BOX.md), [../docs/security-model.md](../docs/security-model.md)
and [../docs/device-lifecycle.md](../docs/device-lifecycle.md). Datasheet facts carry a reference
`[Rn pX]` (list at the end); anything that could not be checked is marked **UNVERIFIED**.
Values marked **(owner)** are proposals the owner still has to confirm.

## How to read this

- **ID** — `HW-<area>-<nn>`, never reused. Areas: FUNC (function), ELEC (electrical), PRIV
  (privacy and trust guarantees), SAFE (safety), MECH (mechanical), ENV (environmental), REG
  (regulatory intent), MFG (manufacturing and cost).
- **Shall** is a requirement; **should** is a goal that may be waived with a recorded reason.
- **Verification**: **I** inspection (schematic, netlist, BOM, drawing), **A** analysis
  (calculation, datasheet argument), **S** simulation (SPICE / field / thermal, phase H4),
  **T** test (bench, EVT/DVT, phase H3). The first letter listed is the primary method.
- **Status** — ✓ met by the current design (by I/A only; nothing is built), **△** partly met or
  unproven, **✗** not met: see the finding `F-nn` in [components/FINDINGS.md](components/FINDINGS.md).

## 1. Functional (HW-FUNC)

| ID | Requirement | Rationale | Verification | Status |
|---|---|---|---|---|
| HW-FUNC-01 | The board shall carry 12 MX-compatible keys in Kailh hot-swap sockets, two rows of six at 19.05 mm pitch: `1 2 3 4 5 MENU` (rear) and `6 7 8 9 0 BACK` (front). Each key shall be read through the I2C expander (active low, external pull-up) with its state available to firmware within 20 ms of actuation, including 10 ms software debounce. | Owner key decision 2026-09-27 (CLAUDE.md); hot-swap = parent-repairable (DESIGN §0 #5). Keys never reach an ESP32 pin (GUIDELINES §1). | I (netlist), T (press-to-event timing) | ✓ |
| HW-FUNC-02 | Every key shall have an RGB LED under its switch window, plus one status pixel (13 total), on one data line, with the chain order fixed in `ui.led_chain`. The LED supply shall be switchable and **off** from power-up until firmware enables it. | Keys are the primary status surface (DESIGN §6.3); ~1 mA quiescent per SK6812 [R17 p6]. | I, T | ✓ (AW9523B outputs low at power-up with AD0/AD1 = GND [R11 p11]) |
| HW-FUNC-03 | The board shall drive a Good Display GDEY029T94 2.9" e-ink strip (296 × 128, SSD1680) through a 24-pin 0.5 mm FPC connector and the Good Display reference boost, 4-wire SPI (BS1 low). The panel shall be replaceable without soldering. | Owner display decision (e-ink standard, one BOM 2026-09-28); reference circuit [R20 p29]; BS1 = L selects 4-wire SPI [R20 p9]. | I (vs [R20 p8, p29]), T | △ F-12 (FPC contact side, sample check) |
| HW-FUNC-04 | The board shall drive a base speaker (20 × 40 mm, 4 Ω or 8 Ω, ≤ 3 W) for ringing, prompts and speakerphone through a class-D amplifier that is off during reset and boot (no pop). | DESIGN §3; NS4150B CTRL low = shutdown [R4 p7]. | I, T | △ F-06 (gain limits output power) |
| HW-FUNC-05 | The board shall have one base (speakerphone) electret microphone on an ADC channel, and a sample-synchronous analog loopback of the speaker drive signal on a second ADC channel as the AEC reference. | Espressif AEC topology (ESP32-S3-Korvo-2 [R21 sheet 4]); DESIGN §3.2. | I, T (ERLE, HW-ELEC-13) | ✓ |
| HW-FUNC-06 | The handset port shall be a USB-C receptacle on the rear edge where the ESP32-S3 native USB OTG acts as a **full-speed host** for off-the-shelf USB Audio Class 1.0 handsets and headsets. The port shall be a USB-C source (Rp, Default USB) with current-limited VBUS. | Owner handset decision 2026-09-27 (no RJ9); S3 OTG supports FS host with isochronous pipes [R2 p55-56]. | I, T (≥ 3 different UAC handsets/headsets, 2 m C-to-C cable) | △ F-04, F-05 |
| HW-FUNC-07 | An NFC Forum Type 5 tag (ST25DV family) with a PCB coil shall be readable by current iPhone and Android phones through the closed enclosure at ≥ 20 mm, and writable by firmware over I2C. | Setup/claim/lounge takeover by tap (device-lifecycle.md, DESIGN §8); ST25DV is NFC Forum Type 5 certified [R16 p1]. | T (EVT, tune the DNP cap) | △ F-18 (coil L calculated only), F-17 (part NRND) |
| HW-FUNC-08 | Hook state shall be sensed without contacts: a Hall switch under one hook-rest post detects the magnet in the hook plunger (on-hook ⇔ plunger down) for **any** handset, with ≤ 100 ms latency: on-hook field above the sensor's maximum operate point and off-hook field below its minimum release point, over magnet and part tolerances. | Owner form-factor decision 2026-09-27; DRV5032FA samples at 20 Hz (50 ms typ, 75 ms max) [R10 p5]; hysteresis 0.8–3 mT, BRP 0.5–3 mT [R10 p6]. Off-hook field shall be below BRP min. | A (field vs BOP/BRP), T | ✗ F-26 (off-hook 1.6 mT > BRP min 0.5 mT [R10 p6]) |
| HW-FUNC-09 | A physical mute slide switch on the right edge shall break the base-microphone supply with one pole and report its position to firmware with the other. | security-model.md "physical mute switch"; DESIGN §6.4. | I, T | △ F-15 (pole-B polarity to confirm) |
| HW-FUNC-10 | VOL− and VOL+ keys on the right edge shall be readable by firmware, ESD-protected at the edge. | DESIGN §3.5, GUIDELINES §1. | I, T | ✓ |
| HW-FUNC-11 | The board shall have (a) a firmware-driven RGB status pixel, (b) a hardwired red **mic light** (HW-PRIV-02) and (c) a **recording light** distinct from both (HW-PRIV-05). | security-model.md "Trust signals" #2. | I, T | ✗ F-09 (no separate recording light) |
| HW-FUNC-12 | An ambient-light sensor shall let firmware dim or blank the LEDs at night. | DESIGN §6.3, §8. | I, T | ✓ |
| HW-FUNC-13 | Battery option: a 1S Li-ion/LiPo pack (≤ 40 × 30 × 6 mm, protected, 10 kΩ NTC) shall be optional. With a pack the phone shall run from it when USB is removed and charge it from USB; without a pack it shall run from USB normally. A fuel gauge shall report state of charge. | Owner 2026-09-28 (charger + gauge fitted, pack optional); LAYOUT battery pocket. | I, T | △ F-10, F-11 |
| HW-FUNC-14 | Wi-Fi 2.4 GHz and BLE shall come from a pre-certified module with an external antenna on the shell wall. | GUIDELINES §2 (WROOM-1U); modular certification (DESIGN §4). | I | △ F-02 (antenna type) |
| HW-FUNC-15 | Firmware shall be flashable and the console reachable over USB-C **without opening the base**; a bricked board shall be recoverable through pads (EN, GPIO0, UART0). | DESIGN §11.3; queued change: flash through the handset port's native USB. | I, T | △ F-01 |
| HW-FUNC-16 | Internal RESET and BOOT buttons shall be reachable only through pinholes. | GUIDELINES §1 (no user-facing line straight to an ESP32 pin). | I | ✓ |
| HW-FUNC-17 | Motion sensing (accelerometer, tamper/knock-over) **should** be available if it has a current software use; otherwise it may be removed (KISS). | DESIGN §8; Lounge features deferred 2026-09-28. | I | △ F-16 (LIS2DH12 out of stock; owner decision) |

## 2. Electrical (HW-ELEC)

### 2.1 Supply, power budget and rails

| ID | Requirement | Rationale | Verification | Status |
|---|---|---|---|---|
| HW-ELEC-01 | The power USB-C port shall be a sink with a separate 5.1 kΩ Rd on CC1 and CC2, no USB PD, and shall accept any USB-C source or USB-A-to-C cable at 4.75–5.25 V. | Owner power decision; separate Rd are required for C-to-C chargers (DESIGN §9.1). | I | ✓ |
| HW-ELEC-02 | Firmware shall be able to read the source's advertisement (Default / 1.5 A / 3 A) on both CC pins through ADC1 inputs protected by ≥ 1 kΩ series resistance. | ≥ 1.5 A policy (below); ADC2 is unusable with Wi-Fi (DESIGN §5). | I, T (three sources) | ✓ |
| HW-ELEC-03 | **≥ 1.5 A policy:** full features shall require a source advertising ≥ 1.5 A. On a Default source the phone shall run in *reduced mode* (LEDs ≤ 10 %, ringer ≤ 0.5 W, charging off, peak ≤ 500 mA at VBUS), report `status.power {source, reduced}` and show `USE 1.5A CHARGER`. | Owner decision 2026-09-27 (DESIGN §9.2a); enforced by `check_power_budget`. | A (`power_budget.yaml`), T | ✓ (by analysis) |
| HW-ELEC-04 | Input protection: TVS at the connector, resettable fuse, charger OVP ≥ 6 V, and an input current limit whose **guaranteed minimum** covers every firmware-capped scenario with ≥ 10 % margin. The fuse shall **not** trip at the charger's **maximum** input limit plus the handset port's current limit at 40 °C ambient. | BQ24074 OVP 10.2–10.8 V, K_ILIM 1500–1720 AΩ [R5 p12]; PTC hold 1.34 A at 40 °C [R24 p4]. | A, T (40 °C soak at max load) | ✗ F-07 |
| HW-ELEC-05 | Power budget at the 5 V input (mA): idle 109, handset call 266, speakerphone 326, ringing 703, worst capped 1113; Default-USB reduced mode ≤ 491. Every scenario shall stay within the source limit and the charger's guaranteed input limit. | `schematic/power_budget.yaml` (numbers from DESIGN §9.2). | A (build check), T (measure each scenario) | ✓ (analysis) |
| HW-ELEC-06 | Battery life **(owner)**: with a 700 mAh 1S pack (603040 class) the phone **should** run ≥ 4 h idle with LEDs dimmed and ≥ 1.5 h in a handset call, and shall shut down cleanly (state saved) before the pack's protection trips. | Estimate: 2.6 Wh × 0.85 usable ÷ ~0.5 W idle ≈ 4.4 h; ÷ 1.33 W call ≈ 1.7 h (budget rows above, not yet measured). | A, T | △ F-05 (handset VBUS on battery) |
| HW-ELEC-07 | **3V3 rail:** the module supply shall stay within 3.0–3.6 V at the module pins under every load, including a 0 → 500 mA step (Wi-Fi TX bursts, 355 mA 802.11b peak for the module alone), and shall be able to deliver ≥ 500 mA continuous. | WROOM-1U VDD33 3.0–3.6 V, supply ≥ 0.5 A, TX peak 355 mA [R1 p27-28]. | S (TLV62569 PSpice model, H4), T (scope at pin 2 during TX) | △ (untested; F-19 cap range) |
| HW-ELEC-08 | **3V3 during eFuse burning:** the module supply shall be ≤ 3.3 V while eFuses are written (production security provisioning). | "If writing to eFuses, VDD3P3_CPU should not exceed 3.3 V" [R2 p64 note 3]. | A, T (fixture) | ✗ F-03 |
| HW-ELEC-09 | **3V0 analog rail:** ≤ 10 µVrms noise (10 Hz–100 kHz), 3.0 V ± 2 %, and output capacitance inside the LDO's stability range. | Codec AVDD and mic bias source (GUIDELINES §3); LP5907 6.5–10 µVrms, ±2 %, COUT 0.7–10 µF [R7 p1, p5-6]. | A, S | ✗ F-08 |
| HW-ELEC-10 | **VSYS** shall stay ≤ 4.5 V (below the 5.25 V amplifier and 5.5 V LDO/buck/LED ratings) and every VSYS load shall tolerate the battery range 3.0–4.2 V or be switched off by firmware below its minimum (SK6812 3.7 V). | BQ24074 VO(REG) 4.3–4.5 V [R5 p12]; NS4150B VDD abs max 5.25 V [R4 p2]; SK6812MINI-E VDD 3.7–5.5 V [R17 p5]. | A (build check), T | ✓ (LED blanking is a firmware duty) |
| HW-ELEC-11 | Default-safe strapping and reset states: GPIO0/3/45/46 shall have defined levels at reset; the amplifier, LED supply and handset VBUS shall be off and charging enabled until firmware decides. | S3 straps and defaults [R1 p13-14]; GUIDELINES §2. | I (pin table check), T | ✓ |
| HW-ELEC-12 | No part shall exceed its rated junction or ambient temperature at 40 °C enclosure ambient in the worst sustained scenario (ringing max while charging). | Charger Tj estimate ≈ 77 °C (SCHEMATIC deviation 8), θJA 44.5 °C/W [R5 p11]. | A, T (thermal camera) | △ (analysis only) |

### 2.2 Audio

| ID | Requirement | Rationale | Verification | Status |
|---|---|---|---|---|
| HW-ELEC-13 | Base-mic path: A-weighted SNR ≥ 55 dB at 94 dB SPL, 1 kHz, measured at the ADC output; frequency response within ±3 dB from 100 Hz to 7 kHz at 16 kHz sampling. | Wideband (16 kHz) voice, AFE sample rate (DESIGN §3.2); capsule S/N ≥ 58 dBA, 100 Hz–10 kHz [R19 p2]; ES7210 SNR 102 dB [R3 p7]. | A, T | △ |
| HW-ELEC-14 | Speaker: the ringer **(owner)** shall reach ≥ 75 dB(A) SPL at 0.5 m on a ≥ 1.5 A source; speakerphone level ≥ 70 dB(A) at 0.5 m with THD+N ≤ 3 %; the amplifier gain shall let the DAC's full scale reach the intended electrical power. | Ringer loudness depends on the supply (DESIGN §15 Q10); NS4150B gain = 240 kΩ/Rin [R4 p7]; ES8311 full scale AVDD/3.3 Vrms [R12 p9]. | A, T | ✗ F-06 |
| HW-ELEC-15 | AEC reference: ES7210 CH3 shall receive the speaker drive signal at −20 … −6 dBFS for a full-scale DAC signal (with the chosen PGA gain), linear (THD ≤ −60 dB) and sample-synchronous with the mic channels; speakerphone ERLE ≥ 25 dB in EVT. | ESP-SR AFE "MR" input (DESIGN §3.2); EVT exit criterion (DESIGN §14.2). | A, S, T | △ F-14 (divider differs from Korvo-2) |
| HW-ELEC-16 | Unused codec inputs shall be terminated as the vendor or a vendor reference design does, and unused channels powered down in firmware. | ES8311/ES7210 datasheets give no rule [R12, R3]; Korvo-2 leaves ES8311 MIC1 on test pads and AC-couples ES7210 MIC4 [R21 sheet 4]. | I | ✓ (resolved, see components/es7210.md) |
| HW-ELEC-17 | Handset readiness: after lifting the handset, the USB handset shall be powered, enumerated and passing audio within 1.0 s (with HW-PRIV-03 gating VBUS). | Answering must feel instant; enumeration + UAC setup time is not bounded by any datasheet (UNVERIFIED). | T (3 handsets) | △ |

### 2.3 USB signal integrity and handset power

| ID | Requirement | Rationale | Verification | Status |
|---|---|---|---|---|
| HW-ELEC-18 | Both USB 2.0 pairs shall be routed as 90 Ω ± 15 % differential pairs over the solid L2 plane, length-matched within 0.15 mm, no vias, ESD at the connector; full-speed enumeration shall pass with a 2 m C-to-C cable and a USB-A-to-C cable. | USB 2.0 FS; LAYOUT §3 (≈ 90 Ω on JLC04161H-7628); GUIDELINES §5. | I (layout checks), T | △ (not routed) |
| HW-ELEC-19 | Handset VBUS at the receptacle shall be 4.75–5.25 V from 0 to 450 mA on USB power, current-limited between 0.4 A and 0.6 A, off by default, and shall not back-feed when a PC supplies VBUS into the port. | USB 2.0 host port range; SY6280 ILIM 6800/Rset ±25 %, reverse blocking when off [R9 p1-3]. | A, T | ✗ F-05 |
| HW-ELEC-20 | The handset port shall present Rp for a Default-USB source (36 kΩ to 3.3 V nominal) on both CC pins. | USB Type-C specification Rp table (UNVERIFIED page; https://www.usb.org/document-library/usb-type-cr-cable-and-connector-specification-release-24). | I | ✓ (33 kΩ, −8 %) |
| HW-ELEC-21 | The shared I2C bus shall meet its rise-time limit at the chosen speed (≤ 300 ns at 400 kHz, ≤ 1000 ns at 100 kHz) with every device fitted and the ST25DV branch at the far end, and every address shall be unique. | I2C timing [R11 p7, R12 p10]; addresses checked by `checks.py`. | A, T (scope) | △ F-20 |

### 2.4 ESD and transients

| ID | Requirement | Rationale | Verification | Status |
|---|---|---|---|---|
| HW-ELEC-22 | Every user-reachable conductor (both USB-C shells and pins, side switches, key gaps, metal hook posts, screws/inserts) shall withstand IEC 61000-4-2 **±8 kV contact / ±15 kV air** without damage (criterion B: self-recovering), and **±4 kV contact / ±8 kV air** without loss of function (criterion A). | GUIDELINES §1; EN 55035 levels are ±4 kV/±8 kV (UNVERIFIED clause); DVT target in DESIGN §14.2. Protectors rated level 4: USBLC6-2 [R13 p1], SRV05-4 [R14 p1], SMF5.0A 30 kV [R15 p1]. | I (TVS at every entry), T (ESD gun, DVT) | ✗ F-13 (metal hook posts) |
| HW-ELEC-23 | No connector or switch net shall reach an ESP32 pin without a TVS at the connector or ≥ 100 Ω series resistance (native USB D± excepted, TVS only). | GUIDELINES §1. | I (to add to `checks.py`) | ✓ (by inspection of the netlist) |

## 3. Privacy and trust guarantees (HW-PRIV)

These are the hardware guarantees promised in [security-model.md](../docs/security-model.md):
they must hold **even if the firmware is compromised**, so each is verified by inspection of the
circuit and a fault analysis, not just by a test.

| ID | Requirement | Rationale | Verification | Status |
|---|---|---|---|---|
| HW-PRIV-01 | The mute switch shall physically open the only supply path of the base microphone. No firmware-controlled path may bypass it. | security-model "Physical mute switch cuts power to the base microphone". | I, A (single-fault) | ✓ |
| HW-PRIV-02 | **Mic light = mic power.** The mic light shall be powered from the base microphone's own supply, so it is lit whenever — and only when — the mic can be powered. A single open or short fault in the light circuit shall not leave the mic powered with the light off without detection. | security-model "Mic light is wired to the mic's power" (queued circuit change). | I, A (FMEA), T | ✗ F-09 |
| HW-PRIV-03 | **Handset unpowered while hung up.** Handset-port VBUS shall be enabled only when the hook sensor reports off-hook **AND** firmware enables it, in hardware logic firmware cannot override. | security-model "Handset is unpowered while hung up" (queued circuit change). | I, A, T | ✗ F-04 |
| HW-PRIV-04 | No camera, radar, or other sensor able to image or record a person shall be on the board; the light sensor shall be a lux sensor without imaging. | security-model "No camera, no radar". | I (BOM) | ✓ (radar removed 2026-09-28) |
| HW-PRIV-05 | A **recording light**, separate from the mic light and the status pixel, shall be available to firmware. | security-model trust signal #2 and recording design. | I | ✗ F-09 |
| HW-PRIV-06 | Production locking shall be possible on this board: secure boot, flash encryption, NVS HMAC keys and JTAG disable burned in eFuse (HW-ELEC-08), while signed updates and secure download mode keep working over the chosen USB path. | security-model "Firmware guarantees"; DESIGN §10.1. | A, T (fixture) | △ F-01, F-03 |
| HW-PRIV-07 | The board shall be marked "Open Lounge Phone", the owner's signature logo, "CERN-OHL-S-2.0" and its revision, with a pointer (QR planned) to the public design files. | CLAUDE.md board marking; security-model trust signal #3–4. | I (silkscreen) | ✓ (logo/name/licence in `boards.yaml`; QR planned) |

## 4. Safety (HW-SAFE)

| ID | Requirement | Rationale | Verification | Status |
|---|---|---|---|---|
| HW-SAFE-01 | The product shall be powered only by USB (≤ 5.25 V, ≤ 15 W) and the optional 1S pack; no mains inside. The e-ink boost's internal gate rails (≈ ±20 V, 50 V-rated caps) shall stay inside the enclosure. | DESIGN §9.4; SSD1680 VGH/VGL on the FPC [R20 p8]. | I | ✓ |
| HW-SAFE-02 | Battery: only protected 1S packs with a 10 kΩ NTC on TS; charging only at 0–45 °C; the connector keyed and polarized with a **specified pinout** (pin 1 VBAT, 2 NTC, 3 GND); the pack in a screwed compartment. | GUIDELINES §1; BQ24074 TS window VHOT/VCOLD [R5 p13]. | I, T | △ F-10 |
| HW-SAFE-03 | Overcurrent protection on the input (fuse + charger limit) and on the handset port (≤ 0.6 A limit, thermal shutdown). | GUIDELINES §1; SY6280 [R9 p3]. | I, A | △ F-07 |
| HW-SAFE-04 | Toy-safety design intent (EN 71-1, EN IEC 62115, ASTM F963): no part a child can remove without a tool may be a small part or a loose magnet; keycaps captive; electronics and battery behind screws; no sharp edges. | GUIDELINES §1 (design as if it is a toy); DESIGN §15 Q4 is still open. | I, T (small-parts cylinder, torque/tension) | ✗ F-21 (removable magnet plunger) |
| HW-SAFE-05 | Accessible surfaces shall rise ≤ 15 °C above ambient in the worst sustained scenario. | DESIGN §14.2 EVT criterion. | T | △ |

## 5. Mechanical (HW-MECH)

| ID | Requirement | Rationale | Verification | Status |
|---|---|---|---|---|
| HW-MECH-01 | Board outline 180 × 88 mm, R8.5 corners, 1.6 mm 4-layer, nine M2.5 plated holes at (34.7, 5.0) (145.3, 5.0) (34.7, 82.6) (145.3, 82.6) (145.1, 29.4) (5.0, 29.8) (26.0, 29.8) (154.0, 29.8) (176.0, 29.8) with a 6 mm keep-out. | `layout/boards.yaml`; LAYOUT §2 (board frame: x right, y down from the rear edge). | I | ✓ |
| HW-MECH-02 | Height budget: top-side parts ≤ 3.0 mm under the lid, ≤ 3.8 mm where the lid has a pocket (USB-C 3.26 mm [R22 drawing], WROOM-1U); bottom parts ≤ 6.0 mm (7.0 mm to the floor); ≤ 1.0 mm on the bottom under the speaker (x 59–102, y 32.5–55); switch plate top = board top + 5.0 mm. | PROTO_BOX geometry; `proto_box.py` checks. | I (`make proto` checks) | ✓ |
| HW-MECH-03 | Connector and control positions (board coordinates): handset USB-C J7 on the rear edge at x 153.8; power USB-C J1 on the right edge at y 40; VOL− y 70.8, VOL+ y 62.8, MUTE y 51.3 on the right edge (bottom side); battery JST J2 (150, 46) bottom; speaker JST J4 (108, 60) bottom; e-ink ZIF J6 (119.4, 43.8) with the tail folded under the panel; RESET/BOOT pinholes (158.5, 12.5)/(158.5, 20.8); mic MK1 (152, 62.5) under a lid pinhole. | `layout/placement.yaml`, `proto_box.py`. | I | △ F-22 (PROTO_BOX.md text is stale) |
| HW-MECH-04 | **Antenna rule:** the external 2.4 GHz antenna (on the shell wall) shall be ≥ 15 mm from any metal (hook posts, inserts, screws, speaker magnet, battery), and of the same type with gain ≤ 2.33 dBi as the antenna used for the module's certification; no metallic paint or plating on the base. | GUIDELINES §2; WROOM-1U datasheet external-antenna rules [R1 p44]. | I (enclosure CAD), T (RSSI within 3 dB of a DevKit) | ✗ F-02 |
| HW-MECH-05 | Keys at x 42.4 + 19.05 i, rows y 14.8 and 72.8; sockets on the bottom; the printed lid is the switch plate and takes keystroke force; keycaps captive. | LAYOUT §2, GUIDELINES §4. | I | ✓ |
| HW-MECH-06 | Every connector and switch cluster shall have a mounting hole within 10 mm; force-bearing parts shall have through-hole or hold-down tabs. | GUIDELINES §4. | I | ✓ (USB-C shell tabs through-hole [R22]) |
| HW-MECH-07 | Hook geometry: plunger magnet ≤ 2 mm above the Hall sensor on-hook, ≥ 8 mm travel; no ferrous parts within 15 mm of the sensor. | PROTO_BOX; DESIGN §11.3. | I, T | ✓ |
| HW-MECH-08 | NFC coil region: no copper inside the loop on any layer; the ST25DV within 20 mm of the coil. | DESIGN §11.3; LAYOUT §7 NFC check. | I (layout check) | ✓ |

## 6. Environmental (HW-ENV)

| ID | Requirement | Rationale | Verification | Status |
|---|---|---|---|---|
| HW-ENV-01 | Operating ambient **0 … +40 °C** (indoor). Every fitted part shall be rated for at least this range; charging only 0 … 45 °C. | Narrowest parts: e-ink 0 … +50 °C [R20 p9], LTR-303 −30 … +70 °C [R18 p6], electret −20 … +60 °C [R19 p2], WROOM-1U-N16R8 −40 … +65 °C [R1 p3]. | A (this table), T | ✓ |
| HW-ENV-02 | Storage and transport **−20 … +60 °C** (without the battery pack; packs per their datasheet). | e-ink storage −25 … +70 °C [R20 p9]; electret −30 … +70 °C [R19 p2]; USB-C −30 … +80 °C [R22]. | A | ✓ |
| HW-ENV-03 | Humidity: operating 20–80 % RH non-condensing; storage ≤ 85 % RH. | Indoor product; e-ink optimal storage 55 ± 10 % RH [R20 p9]. | A, T (damp-heat soak at DVT) | △ |
| HW-ENV-04 | Mechanical robustness: the base shall survive a 0.9 m drop onto hardwood on each face without loss of function; keys ≥ 1 M presses; handset cable plug ≥ 5 000 cycles. | Kids' use (DESIGN §14.2); USB-C receptacle 10 000 cycles [R22]. | T (DVT) | △ |

## 7. Regulatory intent (HW-REG)

The product is not being certified yet; these requirements make the design certifiable.

| ID | Requirement | Rationale | Verification | Status |
|---|---|---|---|---|
| HW-REG-01 | **FCC Part 15 Subpart B, Class B** (unintentional radiator, digital device) for the host; the radio relies on the WROOM-1U's Part 15C modular grant, so the host label shall read "Contains FCC ID: …" and the module integration rules (antenna type, gain) shall be followed. | 47 CFR 15.101/15.109, 15.212 (https://www.ecfr.gov/current/title-47/chapter-I/subchapter-A/part-15); module certificates [R1 p2]. | T (pre-scan at DVT), I (label) | △ F-02 |
| HW-REG-02 | **ISED** ICES-003 Class B and module IC ID on the label. | Canada equivalent (UNVERIFIED clause). | I, T | △ |
| HW-REG-03 | **CE, Radio Equipment Directive 2014/53/EU** via the module's radio reports: Art 3.1(a) EN IEC 62368-1 + EN 62311/EN 62479 (RF exposure); 3.1(b) EN 301 489-1/-17 with EN 55032/EN 55035; 3.2 EN 300 328 (module report reusable only with the same antenna type/gain); 3.3(d)(e)(f) EN 18031-1/-2 (cybersecurity; -2 for toys/childcare and personal data). | DESIGN top risks; RED delegated regulation 2022/30 applies from 1 Aug 2025 (https://eur-lex.europa.eu/eli/reg_del/2022/30/oj). | I, T | △ F-02 |
| HW-REG-04 | **RoHS** (2011/65/EU as amended by 2015/863), REACH SVHC declaration and WEEE marking; every BOM line RoHS-compliant. | Market access; vendor RoHS statements in each component file. | I (BOM declarations) | ✓ (all listed parts state RoHS) |
| HW-REG-05 | **Toy safety as design input** (not a certification decision): EN 71-1/-2/-3, **EN IEC 62115** (electric toys) and ASTM F963 (incl. its magnet and battery clauses). | GUIDELINES §1; DESIGN §15 Q4 open. | I (design review), T (DVT pre-test) | ✗ F-21 |
| HW-REG-06 | **Battery**: the pack shall have a UN 38.3 test summary (transport) and IEC 62133-2 certification (UL 2054/UL 1642 for US retail); the design shall meet the EU Battery Regulation (EU) 2023/1542 marking and end-user removability rules (screws with commercially available tools). | GUIDELINES §1; https://eur-lex.europa.eu/eli/reg/2023/1542/oj (Art. 11). | I (supplier documents) | △ (no pack chosen) |

## 8. Manufacturing and cost (HW-MFG)

| ID | Requirement | Rationale | Verification | Status |
|---|---|---|---|---|
| HW-MFG-01 | The board shall be orderable as standard JLCPCB 4-layer PCBA (two-sided) and portable to any fab: ≥ 0.15/0.15 mm track/space, ≥ 0.3 mm drill, Gerber X2 + Excellon + IPC-2581, generic BOM (MPN + LCSC) and pick-and-place. | Owner manufacturing decision 2026-09-27. | I (`make layout` outputs) | △ (not routed) |
| HW-MFG-02 | Prefer JLC *basic* parts: extended parts **should** be ≤ 25 distinct lines (each adds a setup fee on small orders). | Owner cost decision; current count 35 (`build/summary.txt`). | I (`cost.py`) | ✗ F-23 |
| HW-MFG-03 | Every fitted part shall have ≥ 1 000 units in stock at JLCPCB/LCSC at design freeze, or a checked drop-in alternate listed in its component file. | One-off and small-batch buildability. | I (`make lcsc`) | ✗ F-16, F-24 |
| HW-MFG-04 | Cost per phone: ≤ $40 at 1 k and ≤ $38 at 10 k (including the handset), and **affordable one-off** (current ≈ $204 per phone for a JLC minimum order, to report each build). | Owner cost goal $28–40 (CLAUDE.md). | A (`cost.py`) | ✓ ($39.63 / $37.88) |
| HW-MFG-05 | Hand-assembly feasibility: no part smaller than 0603 and no BGA; fine-pitch QFN/LGA parts listed with the tools they need; parts that cannot be reflowed identified. | Owner: hobbyist builds (ASSEMBLY.md). | I | △ F-25 (electret is iron-only) |
| HW-MFG-06 | Test points on the bottom on a 2.54 mm grid: VBUS, VSYS, 3V3, 3V0, HS_VBUS, GND × 2, U0TXD, U0RXD, EN, BOOT; first power-up with a current-limited 5 V on the VBUS pad. | Owner audit 2026-09-28 (LAYOUT). | I | ✓ |
| HW-MFG-07 | Moisture-sensitive parts shall be handled per their MSL (SK6812MINI-E MSL 5a, WROOM-1U MSL 3: solder within 168 h of opening) and the assembly notes shall say so. | [R17 p1], [R1 p47]. | I (ASSEMBLY.md) | △ F-25 |

## References

Datasheet revisions are those fetched on 2026-09-29; page numbers are PDF pages.

| Ref | Document |
|---|---|
| R1 | Espressif, ESP32-S3-WROOM-1 & WROOM-1U datasheet v1.8 (2026-03-02), https://www.espressif.com/sites/default/files/documentation/esp32-s3-wroom-1_wroom-1u_datasheet_en.pdf |
| R2 | Espressif, ESP32-S3 Series datasheet v2.2, https://www.espressif.com/sites/default/files/documentation/esp32-s3_datasheet_en.pdf |
| R3 | Everest, ES7210 datasheet rev 9.1 (Jan 2019), LCSC copy https://datasheet.lcsc.com/datasheet/pdf/b2218921f0e93d1326ae3dc181140a27.pdf |
| R4 | Nsiway, NS4150B datasheet V1.1 (Mar 2021), https://datasheet.lcsc.com/datasheet/pdf/75c9de26d1ce6a24e56ace3c6df586e7.pdf |
| R5 | TI, BQ2407x datasheet SLUS810N (Oct 2021), https://www.ti.com/lit/ds/symlink/bq24074.pdf |
| R6 | TI, TLV62569 datasheet rev C, https://www.ti.com/lit/ds/symlink/tlv62569.pdf |
| R7 | TI, LP5907 datasheet SNVS798Q (Jul 2025), https://www.ti.com/lit/ds/symlink/lp5907.pdf |
| R9 | Silergy, AN_SY6280 rev 0.1 (2011), https://datasheet.lcsc.com/datasheet/pdf/0271e5b2ca2a46b8bb16f65855f12fe2.pdf |
| R10 | TI, DRV5032 datasheet SLVSDC7H (Dec 2024), https://www.ti.com/lit/ds/symlink/drv5032.pdf |
| R11 | Awinic, AW9523B datasheet V1.1.1 (May 2016), https://datasheet.lcsc.com/datasheet/pdf/e93efb0c474849b5ba24f26b50803eb9.pdf |
| R12 | Everest, ES8311 datasheet rev 7.0 (Jan 2020), https://dl.espressif.com/dl/schematics/Audio_ES8311.pdf |
| R13 | ST, USBLC6-2 datasheet rev 5 (Oct 2011), https://datasheet.lcsc.com/datasheet/pdf/0d3a2ab954b34651a0695e7ccf534db0.pdf |
| R14 | Semtech, SRV05-4 datasheet (08/11/04), https://datasheet.lcsc.com/datasheet/pdf/4abe760a30bb447e9c1dddced46e8df7.pdf |
| R15 | Littelfuse, SMF series (rev 06/07/17), https://datasheet.lcsc.com/datasheet/pdf/72868a41320942b18a109aa69d362751.pdf |
| R16 | ST, ST25DV04K/16K/64K datasheet DocID027603 rev 4 (Dec 2017), https://datasheet.lcsc.com/datasheet/pdf/ce116a756a0243a590825dacea97af3c.pdf |
| R17 | Opsco, SK6812MINI-E spec rev 02 (2019-01-18), https://cdn-shop.adafruit.com/product-files/4960/4960_SK6812MINI-E_REV02_EN.pdf |
| R18 | Lite-On, LTR-303ALS-01 DS86-2013-0004 rev A, https://datasheet.lcsc.com/datasheet/pdf/e082d25eee9d8954f5ed8e86defb8a71.pdf |
| R19 | INGHAi, GMI6027-2C42DB specification V1.0 (2020-01-09), https://datasheet.lcsc.com/datasheet/pdf/5872a0bccdf594f00205a63a6e86a424.pdf |
| R20 | Good Display, GDEY029T94 spec rev 1.0 (2021/03/15), https://files.seeedstudio.com/wiki/Other_Display/29-epaper/GDEY029T94.pdf |
| R21 | Espressif, ESP32-S3-Korvo-2 V3.1.2 schematic (2024-01-16), https://dl.espressif.com/dl/schematics/SCH_ESP32-S3-Korvo-2_V3.1.2_20240116.pdf |
| R22 | HRO, TYPE-C-31-M-12 drawing (2020-12-08), https://datasheet.lcsc.com/datasheet/pdf/9e56b777c022540fcce7c7f67825f55e.pdf |
| R24 | PTTC, SMD1206 series datasheet rev K (2017-01-03), https://datasheet.lcsc.com/datasheet/pdf/c142bd6abe50067c0e2abbe967f2fcb5.pdf |

(R8 and R23 are unused numbers; part-specific references are in each `components/` file.)
