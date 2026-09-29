# Open Lounge Phone hardware requirements (H1)

Status: **draft 3, 2026-09-30** (H5: the second batch of owner decisions of 2026-09-30, D14–D21 in §0, and the schematic built to them; draft 2 2026-09-30, draft 1 2026-09-29). Phase H1 of the hardware process: numbered, traceable
requirements for the one 180 × 88 mm board and the parts of the base it interacts with. Phase H2
(`components/`) documents every part against these IDs, and `components/FINDINGS.md` lists every
place where the current schematic or board does not yet meet them. Nothing here changes the
schematic or layout; it is the yardstick for H3 (the layout checklist, [BOARD_REQUIREMENTS.md](BOARD_REQUIREMENTS.md)), H4 (simulation, [sim/](sim/README.md)) and H5 (changes, [sim/FINDINGS-H4.md](sim/FINDINGS-H4.md)).

Sources: owner decisions in [DESIGN.md](DESIGN.md) (top box), [GUIDELINES.md](GUIDELINES.md),
[SCHEMATIC.md](SCHEMATIC.md), [LAYOUT.md](LAYOUT.md),
[enclosure/PROTO_BOX.md](enclosure/PROTO_BOX.md), [../docs/security-model.md](../docs/security-model.md)
and [../docs/device-lifecycle.md](../docs/device-lifecycle.md). Datasheet facts carry a reference
`[Rn pX]` (list at the end); anything that could not be checked is marked **UNVERIFIED**.
Values marked **(owner)** are proposals the owner still has to confirm.

## 0. Owner decisions 2026-09-30 (resolved)

The owner approved these on 2026-09-30. They answer "What H3/H4 need from the owner" in
[components/FINDINGS.md](components/FINDINGS.md); the H4 benches ([sim/](sim/README.md)) quantified
each one and [sim/FINDINGS-H4.md](sim/FINDINGS-H4.md) turns them into schematic changes (P-nn).

| # | Decision | Requirements | H4 result / proposal |
|---|---|---|---|
| D1 | **Mic light fail-safe:** the LED goes **in series** with the base-mic supply (no light = no mic power); if H4 shows too little headroom, **two parallel LEDs** on the mic's own switched supply. Add a separate **red recording LED** on its own GPIO. | HW-PRIV-02, -05, HW-FUNC-11 | b05: series leaves 0.89 V for the electret (needs 1.5 V) → **parallel fallback** (P-01); recording LED on GPIO13 (P-02) |
| D2 | ~~**Handset VBUS** = hall hook sensor **AND** GPIO (on-hook ⇒ handset unpowered).~~ **Superseded by D16** (the mic supply is gated instead). | HW-PRIV-03 | b04: AND gate (P-03) |
| D3 | **Off-hook detection margin** fixed with numbers (weaker magnet, longer travel or another DRV5032 variant), **≥ 2× both ways**. | HW-FUNC-08, HW-MECH-07 | b11: **DRV5032AJ** + 10 mm travel, 3.3× / 3.3× (P-06) |
| D4 | **Flashing without the CH340C:** ~~USB 2.0 analog switch; native USB on the **power port** (device: flashing, USB-Serial-JTAG console) when a host is there, else on the handset port (host). Default and boot state = power port; handset VBUS off in boot mode.~~ **Superseded by D14:** native USB goes straight to the power port. | HW-FUNC-15, HW-ELEC-25, HW-PRIV-06 | FSUSB42MUX, SEL = HS_MODE (P-04) |
| D5 | ~~**5 V boost for the handset port** (TPS61023-class) feeding the handset VBUS switch.~~ **Superseded by D14** (no USB handset). | HW-ELEC-19, -06 | b04: 5.02 V at the port on USB and at 3.3 V battery (P-03) |
| D6 | **Retune 3V3 to 3.30 V nominal with ≤ 1 % resistors so the worst case stays ≤ the eFuse-burn limit** (VDD3P3_CPU ≤ 3.3 V while writing eFuses, ESP32-S3 datasheet v2.2 p64, Table 5-2 note 3). | HW-ELEC-07, -08 | b02: **the two halves conflict** — 3.30 V nominal reaches 3.45 V at the VFB-max corner; H4 proposes **3.19 V with 0.1 %** resistors (P-05). **Confirmed: D17 (3.19 V).** |
| D7 | **Antenna:** same **type** as the certification antenna of the WROOM-1U (monopole, TFPD05H08750011) with gain ≤ the certified **2.33 dBi** (WROOM-1U datasheet v1.8 p44; FCC ID 2AC7Z-ESPS3WROOM1U; 47 CFR 15.204(c)(4) allows a same-type antenna of equal or lower gain, https://www.ecfr.gov/current/title-47/chapter-I/subchapter-A/part-15/subpart-A/section-15.204); a JLC- or DigiKey-available part. | HW-MECH-04, HW-FUNC-14, HW-REG-01, -03 | candidate Molex 204281 family (1.4–2.2 dBi) — type and MHF I variant still to confirm (FINDINGS-H4) |
| D8 | **Captive plunger and magnet** (toy-safety requirement for the enclosure). | HW-SAFE-04, HW-MECH-09, HW-REG-05 | enclosure item |
| D9 | **Targets:** battery **≥ 8 h idle + 1 h talk** on the ≈ 700 mAh pack; ringer **≥ 75 dBA at 1 m**, ~~speakerphone ≥ 70 dBA~~ (no speakerphone, D15). | HW-ELEC-06, -14 | b10 (needs ≤ 137 mW idle), b06 (R_IN 68 kΩ: 77 dBA) |
| D10 | **Drop the LIS2DH12** accelerometer. | HW-FUNC-17 | P-13 |
| D11 | **Toy safety:** design to EN 71 / ASTM F963 intent, not certified yet. | HW-SAFE-04, HW-REG-05 | — |
| D12 | **Test handsets:** ~~Native Union POP plus one generic USB-C handset~~ → the **Opis 60s Micro plus one generic analog TRRS handset** (D14). | HW-FUNC-06, HW-ELEC-17 | — |
| D13 | **Simulator:** ngspice. | (H4 tooling) | `make sim` |

### Second batch, 2026-09-30 (H5): analog handset, no speakerphone (supersede D2, D4, D5, D12 and the USB handset)

| # | Decision | Supersedes | H5 result (schematic, [SCHEMATIC_REVIEW.md](SCHEMATIC_REVIEW.md)) |
|---|---|---|---|
| D14 | **Handset = an analog 3.5 mm TRRS jack** on the base (e.g. the Opis 60s Micro plugs straight in). No USB host, no handset USB-C, no 5 V boost, no USB switch, no hook-gated VBUS, no CH340C. The **power USB-C** carries the ESP32 native USB (device: flashing + USB-Serial-JTAG console) with ESD. CTIA wiring, insertion detect, inline-button detect; OMTP detection if cheap. | the USB-C handset (2026-09-27), D2, D4, D5, D12 | J7 HOOYA PJ-31060 (TN contact = insertion detect, IO12); button and plug type on IO10 (ADC1) through a one-way diode; OMTP = "S at GND" is detected (not switched); b04 |
| D15 | **No base mic, no speakerphone.** The ES8311 records the handset mic and drives the earpiece; the NS4150B speaker is for ringing and prompts only. Earpiece vs speaker by amp enable or routing. AEC confirmed unnecessary and simplified. | HW-FUNC-05, HW-ELEC-15, the speakerphone part of HW-ELEC-14 | ES7210, base electret and AEC loopback removed; ES8311 drives 16/32 Ω (User Guide rev 1.11 p2) — no headphone driver; earpiece switch TS5A3166 on HOOK; b04, b07 |
| D16 | **Hardware privacy re-based on the handset mic:** MUTE and the hall hook sensor both cut the handset-mic bias (mute-off AND off-hook); two parallel mic lights on that supply; separate red recording LED on its own GPIO; firmware cannot override. | D1 (base mic), D2 | MIC_VCC chain (Q5/Q6 on HOOK after MUTE pole A); `checks.check_privacy` on the netlist; b05 |
| D17 | **3V3 = 3.19 V nominal** (105 k / 24.3 k, 0.1 %). | D6 wording | built; b02 |
| D18 | **Speaker:** the right part for ≥ 75 dBA at 1 m (b06), the prototype box adapted to its real depth; loudness not compromised. | — | Soberton SP-2040 (20 × 40 × **8.4** mm, 8 Ω 1 W, 86 dB/1 W/0.5 m, spec rev B p1); box floor space 7 → 10 mm |
| D19 | **Antenna:** a general-purpose 2.4 GHz U.FL/IPEX antenna, user-upgradable; the docs state the certification caveat (same type, gain ≤ the certified antenna). | D7 | DESIGN §4, HW-MECH-04 |
| D20 | **Current-limit window 0.35–0.70 A** approved where a current-limited output remains (Qwiic, LED rail, jack); otherwise not applicable. | HW-ELEC-19 amendment | **not applicable**: no Qwiic port, the LED rail has a soft start but no limit, the jack's only supply is the 2.2 kΩ mic bias (≤ 1.4 mA) |
| D21 | **Apply the rest of the H4/H2 change list:** DRV5032AJ + captive plunger/magnet, 2 A PTC, fewer VSYS caps, LED soft start, speaker R_IN, 7-turn NFC coil, 3V0 caps, drop the LIS2DH12, remaining FINDINGS. | — | P-05 … P-13 built; F-17 (ST25DV04KC), F-24 (socket alternate), F-27 done; the coil footprint changes in H6 |

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
| HW-FUNC-04 | The board shall drive a base speaker (20 × 40 mm, 8 Ω, ≤ 3 W) for **ringing and voice prompts only** (no speakerphone, D15) through a class-D amplifier that is off during reset and boot (no pop). | DESIGN §3; NS4150B CTRL low = shutdown [R4 p7]; D15. | I, T | ✓ (H5: R_IN 68 kΩ, P-10; PA_EN 100 kΩ pull-down) |
| HW-FUNC-05 | ~~One base (speakerphone) electret microphone on an ADC channel, and a sample-synchronous analog loopback of the speaker drive signal as the AEC reference.~~ — **superseded** (D15, 2026-09-30): no base mic, no speakerphone, no ES7210. With a handset only, echo is the handset's own receiver-to-mic coupling; if EVT measures too much, firmware AEC uses the playback stream as its reference (same I2S clock as the ES8311 ADC, so sample-synchronous). | D15. | I (BOM) | ✓ removed |
| HW-FUNC-06 | The handset port shall be a **3.5 mm TRRS jack** (CTIA: T/R1 earpiece, R2 GND, S mic) on the rear edge for off-the-shelf analog handsets (Opis 60s Micro class): earpiece from the ES8311 DAC, electret mic into the ES8311 ADC with bias from the switched mic supply (HW-PRIV-03). ~~USB-C receptacle, ESP32 native USB OTG as a full-speed UAC host, current-limited VBUS~~ (superseded, D14). | D14; ES8311 drives 16/32 Ω headphone loads (User Guide rev 1.11 p2). | I, S (b04), T (Opis 60s Micro + one generic TRRS handset) | ✓ (H5) |
| HW-FUNC-07 | An NFC Forum Type 5 tag (ST25DV family) with a PCB coil shall be readable by current iPhone and Android phones through the closed enclosure at ≥ 20 mm, and writable by firmware over I2C. | ST25DV04KC: NFC Forum Type 5, CTUN 28.5 pF (DS13519 rev 4 p1). | T (EVT, trim C62) | △ (H5: KC part, 12 pF fitted; the coil footprint goes to 7 turns in H6) |
| HW-FUNC-08 | Hook state shall be sensed without contacts: a Hall switch under one hook-rest post detects the magnet in the hook plunger (on-hook ⇔ plunger down) for **any** handset, with ≤ 100 ms latency, and with **≥ 2× margin both ways** over magnet, position (±0.3 mm) and part tolerances: on-hook field ≥ 2 × BOP max and off-hook field ≤ BRP min / 2 (D3). | D3; DRV5032**AJ** (BOP ≤ 9.5 mT, BRP ≥ 3.0 mT [R10 p6]); b11: 3.3× / 3.3× with 10 mm travel. | A (b11), T | ✓ (H5: U10 DRV5032AJ, 100 kΩ pull-up) |
| HW-FUNC-09 | A physical mute slide switch on the right edge shall break the **handset-mic** supply with one pole and report its position to firmware with the other. | security-model.md; D16. | I, T | △ F-15 (pole-B polarity to confirm) |
| HW-FUNC-10 | VOL− and VOL+ keys on the right edge shall be readable by firmware, ESD-protected at the edge. | DESIGN §3.5, GUIDELINES §1. | I, T | ✓ |
| HW-FUNC-11 | The board shall have (a) a firmware-driven RGB status pixel, (b) **two** red **mic lights** in parallel, powered from the handset mic's own switched supply (HW-PRIV-02) and (c) a separate **red recording light** on its own GPIO (HW-PRIV-05, D1, D16). | security-model.md "Trust signals" #2; D1, D16. | I, T | ✓ (H5: D21/D22 on MIC_VCC, D23 on GPIO13) |
| HW-FUNC-12 | An ambient-light sensor shall let firmware dim or blank the LEDs at night. | DESIGN §6.3, §8. | I, T | ✓ |
| HW-FUNC-13 | Battery option: a 1S Li-ion/LiPo pack (≤ 40 × 30 × 6 mm, protected, 10 kΩ NTC) shall be optional. With a pack the phone shall run from it when USB is removed and charge it from USB; without a pack it shall run from USB normally. A fuel gauge shall report state of charge. | Owner 2026-09-28 (charger + gauge fitted, pack optional); LAYOUT battery pocket. | I, T | △ F-10, F-11 |
| HW-FUNC-14 | Wi-Fi 2.4 GHz and BLE shall come from a pre-certified module with an external antenna on the shell wall. | GUIDELINES §2 (WROOM-1U); modular certification (DESIGN §4). | I | △ (antenna: HW-MECH-04) |
| HW-FUNC-15 | Firmware shall be flashable and the console reachable over the **power USB-C** with any C-to-C or A-to-C cable **without opening the base**: J1's D+/D− go straight (ESD, 0 Ω links) to the ESP32 native USB (IO19/20, device mode, USB-Serial-JTAG) (D14; ~~USB analog switch~~ superseded). A bricked board shall be recoverable through pads (EN, GPIO0, UART0). | D14; USB-Serial-JTAG download on IO19/20 [R1 p14]. | I, T | ✓ (H5) |
| HW-FUNC-16 | Internal RESET and BOOT buttons shall be reachable only through pinholes. | GUIDELINES §1 (no user-facing line straight to an ESP32 pin). | I | ✓ |
| HW-FUNC-17 | ~~Motion sensing (accelerometer)~~ — **removed** (D10, 2026-09-30): no accelerometer on the board. | No current software use; LIS2DH12 out of stock. | I (BOM) | ✓ (H5: U12 removed) |

| HW-FUNC-18 | **Handset sensing (new, D14):** insertion detect on a GPIO (plug in / out, also on-hook); inline-button detect on an ADC1 input (button shorts S to GND, 0–70 Ω); an OMTP plug (S meets the plug's ground) shall be recognisable (not switched). No sense path may be able to power the mic (HW-PRIV-03). | D14. | I, S (b04), T | ✓ (H5: TN → IO12; S → 1N4148W → 100 k → IO10; button/OMTP only readable while the mic is powered) |

## 2. Electrical (HW-ELEC)

### 2.1 Supply, power budget and rails

| ID | Requirement | Rationale | Verification | Status |
|---|---|---|---|---|
| HW-ELEC-01 | The power USB-C port shall be a sink with a separate 5.1 kΩ Rd on CC1 and CC2, no USB PD, and shall accept any USB-C source or USB-A-to-C cable at 4.75–5.25 V. | Owner power decision; separate Rd are required for C-to-C chargers (DESIGN §9.1). | I | ✓ |
| HW-ELEC-02 | Firmware shall be able to read the source's advertisement (Default / 1.5 A / 3 A) on both CC pins through ADC1 inputs protected by ≥ 1 kΩ series resistance. | ≥ 1.5 A policy (below); ADC2 is unusable with Wi-Fi (DESIGN §5). | I, T (three sources) | ✓ |
| HW-ELEC-03 | **≥ 1.5 A policy:** full features shall require a source advertising ≥ 1.5 A. On a Default source the phone shall run in *reduced mode* (LEDs ≤ 10 %, ringer ≤ 0.5 W, charging off, peak ≤ 500 mA at VBUS), report `status.power {source, reduced}` and show `USE 1.5A CHARGER`. | Owner decision 2026-09-27 (DESIGN §9.2a); enforced by `check_power_budget`. | A (`power_budget.yaml`), T | ✓ (by analysis) |
| HW-ELEC-04 | Input protection: TVS at the connector, resettable fuse, charger OVP ≥ 6 V, and an input current limit whose **guaranteed minimum** covers every firmware-capped scenario with ≥ 10 % margin. The fuse shall **not** trip at the charger's **maximum** input limit at 40 °C ambient. | BQ24074 OVP 10.2–10.8 V, K_ILIM 1500–1720 AΩ [R5 p12]; SMD1812P200TF/16 hold 1.80 A at 40 °C (Ruilon SP-PTC-008 rev A6 p6) vs 1.56 A ILIM max (b01). | A, T (40 °C soak at max load) | ✓ (H5: 2 A PTC, P-07) |
| HW-ELEC-05 | Power budget at the 5 V input (mA, H5): idle 79, handset call 176, ringing 600 (1 W cap), worst capped 992; Default-USB reduced mode ≤ 491. Every scenario shall stay within the source limit and the charger's guaranteed input limit. | `schematic/power_budget.yaml` (H5: no VBUS-direct handset load). | A (build check), T (measure each scenario) | ✓ (analysis) |
| HW-ELEC-06 | Battery life (D9): with a ≈ 700 mAh 1S pack (603040 class) one charge shall cover **≥ 8 h idle followed by 1 h of handset talk**, and the phone shall shut down cleanly (state saved) before the pack's protection trips. | D9. H4 b10: 2.20 Wh usable; needs ≤ 137 mW average idle (DESIGN §9.2 idle 199 mW fails; LED rail off + Wi-Fi power save ≈ 58 mW passes). | A (b10), T | △ (firmware power policy + H5 P-03) |
| HW-ELEC-07 | **3V3 rail:** the module supply shall stay within 3.0–3.6 V at the module pins under every load, including a 0 → 500 mA step (Wi-Fi TX bursts, 355 mA 802.11b peak for the module alone), and shall be able to deliver ≥ 500 mA continuous. | WROOM-1U VDD33 3.0–3.6 V, supply ≥ 0.5 A, TX peak 355 mA [R1 p27-28]. | S (b02: averaged model; the TI model does not run in ngspice), T (scope at pin 2 during TX) | △ b02 passes with the H5 set point and 44 µF (P-05); EVT scope |
| HW-ELEC-08 | **3V3 during eFuse burning:** the module supply shall be ≤ 3.3 V while eFuses are written (worst case: VFB max, resistor tolerance, power-save offset), while staying ≥ 3.0 V at the module under a 500 mA Wi-Fi step (HW-ELEC-07). | [R2 p64, Table 5-2 note 3]; D6, D17. b02: 3.19 V with 0.1 % → 3.022–3.287 V. | A, S (b02), T (fixture) | ✓ (H5: 105 k / 24.3 k 0.1 %) |
| HW-ELEC-09 | **3V0 analog rail:** ≤ 10 µVrms noise (10 Hz–100 kHz), 3.0 V ± 2 %, and output capacitance inside the LDO's stability range. | Codec AVDD and handset-mic supply; LP5907 6.5–10 µVrms, ±2 %, COUT 0.7–10 µF [R7 p1, p5-6]. | A, S (b03) | ✓ (H5: 2.1 µF nominal) |
| HW-ELEC-10 | **VSYS** shall stay ≤ 4.5 V (below the 5.25 V amplifier and 5.5 V LDO/buck/LED ratings) and every VSYS load shall tolerate the battery range 3.0–4.2 V or be switched off by firmware below its minimum (SK6812 3.7 V). | BQ24074 VO(REG) 4.3–4.5 V [R5 p12]; NS4150B VDD abs max 5.25 V [R4 p2]; SK6812MINI-E VDD 3.7–5.5 V [R17 p5]. | A (build check), T | ✓ (LED blanking is a firmware duty) |
| HW-ELEC-11 | Default-safe strapping and reset states: GPIO0/45/46 (and 3, now free) shall have defined levels at reset; the amplifier and LED supply shall be off and charging enabled until firmware decides; the earpiece and the handset mic are off whenever the hook sensor reads on-hook. | S3 straps and defaults [R1 p13-14]; GUIDELINES §2. | I (pin table check), T | ✓ |
| HW-ELEC-12 | No part shall exceed its rated junction or ambient temperature at 40 °C enclosure ambient in the worst sustained scenario (ringing max while charging). | Charger Tj estimate ≈ 77 °C (SCHEMATIC deviation 8), θJA 44.5 °C/W [R5 p11]. | A, T (thermal camera) | △ (analysis only) |
| HW-ELEC-24 | **3V3 ripple and transient:** PWM and power-save ripple ≤ 30 mV p-p at the module; the 0 → 500 mA (1 A/µs) step and the release keep 3.00–3.60 V at the module pins (and ≤ 3.30 V at light load, HW-ELEC-08). | H4 b02 (proposed spec; Espressif gives no ripple number: this is ours). | S (b02), T (scope) | ✓ by simulation (1.4 / 17 mV p-p) |
| HW-ELEC-25 | ~~USB 2.0 analog switch between the power and handset ports~~ — **superseded** (D14): native USB goes straight to J1. | D14. | — | N/A |

### 2.2 Audio

| ID | Requirement | Rationale | Verification | Status |
|---|---|---|---|---|
| HW-ELEC-13 | **Handset-mic path** (D15): A-weighted SNR ≥ 55 dBA at 94 dB SPL, 1 kHz, at the ES8311 ADC output with the assumed typical handset capsule (−42 dBV/Pa, 58 dBA), and the board + ADC shall take ≤ 1.5 dB from the capsule's own S/N; response ±3 dB 100 Hz–7 kHz at 16 kHz sampling. | ES8311 ADC SNR 100 dBA typ / 95 min, PGA 0–30 dB [R12 p8; ES8311 User Guide rev 1.11 p19-20]. | A, S (b07), T (EVT with the Opis 60s Micro) | △ b07: 57.8 dBA at PGA 18 dB (53.8 at PGA 0 dB); depends on the capsule and the PGA noise (assumptions) |
| HW-ELEC-14 | Speaker (D9, D18): the ringer shall reach **≥ 75 dB(A) SPL at 1 m** on a ≥ 1.5 A source with THD+N ≤ 3 %; the amplifier gain shall let the DAC's full scale reach the intended electrical power. ~~Speakerphone ≥ 70 dB(A)~~ (no speakerphone, D15). | D9; NS4150B gain = 240 kΩ/R_in [R4 p7]; SP-2040 86 dB/1 W/0.5 m (spec rev B p1). b06: 68 kΩ → 77 dBA (1 W cap). | A (b06), T | ✓ (H5: R_IN 68 kΩ, SP-2040) |
| HW-ELEC-15 | ~~AEC reference on ES7210 CH3~~ — **superseded** (D15): no speakerphone, no hardware AEC reference. | D15. | — | N/A |
| HW-ELEC-16 | Unused codec inputs shall be terminated as the vendor or a vendor reference design does. | H5: the ES8311's only input (MIC1) is used; the ES7210 is gone. | I | N/A (no unused inputs) |
| HW-ELEC-17 | Handset readiness: after lifting the handset, earpiece and mic shall be live within **100 ms** of the hook sensor switching (≤ 75 ms sampling). ~~USB enumeration within 1.0 s~~ (D14). | DRV5032 20 Hz [R10 p5]; b05: supply up in < 1 ms, b04: no pop. | S (b04, b05), T | ✓ |

### 2.3 USB signal integrity and the handset jack

| ID | Requirement | Rationale | Verification | Status |
|---|---|---|---|---|
| HW-ELEC-18 | The one USB 2.0 pair (J1 ↔ ESP32 IO19/20) shall be routed as a 90 Ω ± 15 % differential pair over the solid L2 plane, length-matched within 0.15 mm, no vias, ESD at the connector; full-speed enumeration shall pass with a 2 m C-to-C cable and a USB-A-to-C cable. | USB 2.0 FS; LAYOUT §3. | I (layout checks), T | △ (not routed) |
| HW-ELEC-19 | ~~Handset VBUS 4.75–5.25 V, current-limited 0.35–0.70 A~~ — **superseded** (D14, D20): there is no handset VBUS; see HW-ELEC-27. | D14, D20. | — | N/A |
| HW-ELEC-20 | ~~Handset-port Rp~~ — **superseded** (D14). | D14. | — | N/A |
| HW-ELEC-21 | The shared I2C bus shall meet its rise-time limit at the chosen speed (≤ 300 ns at 400 kHz, ≤ 1000 ns at 100 kHz) with every device fitted and the ST25DV branch at the far end, and every address shall be unique. | I2C timing [R11 p7, R12 p10]; addresses checked by `checks.py`. | A, T (scope) | △ F-20 |

| HW-ELEC-26 | **Earpiece (new, D15):** ≥ 90 dB SPL at DAC full scale with the assumed receiver (32 Ω, 95 dB SPL/mW), response ±3 dB 100 Hz–7 kHz, ES8311 peak current ≤ its rated 16 Ω load; on-hook the earpiece shall be disconnected in hardware (≤ −50 dB while the speaker rings); no audible click when the handset is lifted. | ES8311 16/32 Ω [User Guide p2]; TS5A3166 [SCDS186E p3]. | S (b04), T | ✓ (b04: 98 dB SPL, −52 dB, 91 µV click) |
| HW-ELEC-27 | **Jack outputs (new, D20):** every jack contact that carries a supply or a drive shall be current-limited by passive parts: mic bias ≤ 2 mA into a short (2.2 kΩ), earpiece lines 22 Ω each. The 0.35–0.70 A window of D20 does not apply (no current-limited supply output remains on the board). | D20. | A (b04) | ✓ |

### 2.4 ESD and transients

| ID | Requirement | Rationale | Verification | Status |
|---|---|---|---|---|
| HW-ELEC-22 | Every user-reachable conductor (USB-C shell and pins, the jack contacts, side switches, key gaps, metal hook posts, screws/inserts) shall withstand IEC 61000-4-2 **±8 kV contact / ±15 kV air** without damage (criterion B), and **±4 kV contact / ±8 kV air** without loss of function (criterion A). | GUIDELINES §1; protectors USBLC6-2 [R13 p1], SRV05-4 [R14 p1], SMF5.0A [R15 p1], PESD5V0S2BT (Nexperia 2018 p1, bidirectional: the earpiece swings below GND). | I (TVS at every entry), T (ESD gun, DVT) | △ F-13 (posts: HOOK RC fitted, grounding is layout/enclosure) |
| HW-ELEC-23 | No connector or switch net shall reach an ESP32 pin without a TVS at the connector or ≥ 100 Ω series resistance (native USB D± excepted, TVS only). | GUIDELINES §1. | I | ✓ (H5: JACK_DET 1 kΩ, MIC_SENSE 100 kΩ + diode, HOOK 47 kΩ) |

## 3. Privacy and trust guarantees (HW-PRIV)

These are the hardware guarantees promised in [security-model.md](../docs/security-model.md):
they must hold **even if the firmware is compromised**, so each is verified by inspection of the
circuit and a fault analysis, not just by a test.

| ID | Requirement | Rationale | Verification | Status |
|---|---|---|---|---|
| HW-PRIV-01 | The mute switch shall physically open the only supply path of the **handset microphone** (D16). No firmware-controlled path may bypass it. | security-model "Physical mute switch"; D16. | I (`checks.check_privacy`), A (single-fault), S (b05) | ✓ |
| HW-PRIV-02 | **Mic lights = mic power.** Two mic lights in parallel, each with its own resistor, hang on the handset mic's own switched supply MIC_VCC, so they are lit whenever — and only when — the mic can be powered. A single open or short fault in the light circuit shall not leave the mic powered with the lights off; muting or hanging up darkens lights and mic together (mic live with the lights off ≤ 10 ms). | security-model; D1, D16. b05: ≥ 1.54 V at the capsule, ≥ 0.71 mA per light, 30 µs dark-but-live, FMEA pass. | I, A (FMEA), S (b05), T | ✓ |
| HW-PRIV-03 | **Handset mic unpowered on hook and when muted.** MIC_VCC exists only when MUTE is off **AND** the hook sensor reads off-hook (series switch pole + a P-FET driven from the Hall sensor), in hardware firmware cannot override: the ESP32 reads HOOK only through 47 kΩ (it can pull the line low = mic off, never lift it against the sensor) and reads the mic line only through a one-way diode. The earpiece is disconnected on hook as well. ~~Handset VBUS = hook AND GPIO~~ (D2 superseded by D16). | security-model; D16. b05: IO17 driven high on hook → HOOK 20 mV, capsule 0 V; b04: IO10 high → 0.3 nA into the mic line. | I (`checks.check_privacy`), A, S (b04, b05), T | ✓ |
| HW-PRIV-04 | No camera, radar, or other sensor able to image or record a person shall be on the board; the light sensor shall be a lux sensor without imaging. | security-model "No camera, no radar". | I (BOM) | ✓ (radar removed 2026-09-28) |
| HW-PRIV-05 | A red **recording light**, separate from the mic lights and the status pixel, shall be driven by its own GPIO (D1). | security-model trust signal #2; D1. | I | ✓ (H5: D23, GPIO13, 680 Ω) |
| HW-PRIV-06 | Production locking shall be possible on this board: secure boot, flash encryption, NVS HMAC keys and JTAG disable burned in eFuse (HW-ELEC-08), while signed updates and secure download mode keep working over the native USB on the power USB-C. | security-model; DESIGN §10.1. | A, T (fixture) | ✓ (by design; fixture test open) |
| HW-PRIV-07 | The board shall be marked "Open Lounge Phone", the owner's signature logo, "CERN-OHL-S-2.0" and its revision, with a pointer (QR planned) to the public design files. | CLAUDE.md board marking; security-model trust signal #3–4. | I (silkscreen) | ✓ (logo/name/licence in `boards.yaml`; QR planned) |

## 4. Safety (HW-SAFE)

| ID | Requirement | Rationale | Verification | Status |
|---|---|---|---|---|
| HW-SAFE-01 | The product shall be powered only by USB (≤ 5.25 V, ≤ 15 W) and the optional 1S pack; no mains inside. The e-ink boost's internal gate rails (≈ ±20 V, 50 V-rated caps) shall stay inside the enclosure. | DESIGN §9.4; SSD1680 VGH/VGL on the FPC [R20 p8]. | I | ✓ |
| HW-SAFE-02 | Battery: only protected 1S packs with a 10 kΩ NTC on TS; charging only at 0–45 °C; the connector keyed and polarized with a **specified pinout** (pin 1 VBAT, 2 NTC, 3 GND); the pack in a screwed compartment. | GUIDELINES §1; BQ24074 TS window VHOT/VCOLD [R5 p13]. | I, T | △ F-10 |
| HW-SAFE-03 | Overcurrent protection on the input (fuse + charger limit); the jack's lines are passively limited (HW-ELEC-27). ~~Handset-port ≤ 0.6 A limit~~ (D14). | GUIDELINES §1; D14, D20. | I, A | ✓ |
| HW-SAFE-04 | Toy-safety design intent (D11: EN 71-1, EN IEC 62115, ASTM F963, **not certified yet**): no part a child can remove without a tool may be a small part or a loose magnet — in particular the **hook plunger and its magnet are captive** (D8, HW-MECH-09); keycaps captive; electronics and battery behind screws; no sharp edges. | GUIDELINES §1; D8, D11. | I, T (small-parts cylinder, torque/tension) | △ (proto box captive since H5; product enclosure open) |
| HW-SAFE-05 | Accessible surfaces shall rise ≤ 15 °C above ambient in the worst sustained scenario. | DESIGN §14.2 EVT criterion. | T | △ |

## 5. Mechanical (HW-MECH)

| ID | Requirement | Rationale | Verification | Status |
|---|---|---|---|---|
| HW-MECH-01 | Board outline 180 × 88 mm, R8.5 corners, 1.6 mm 4-layer, nine M2.5 plated holes at (34.7, 5.0) (145.3, 5.0) (34.7, 82.6) (145.3, 82.6) (145.1, 29.4) (5.0, 29.8) (26.0, 29.8) (154.0, 29.8) (176.0, 29.8) with a 6 mm keep-out. | `layout/boards.yaml`; LAYOUT §2 (board frame: x right, y down from the rear edge). | I | ✓ |
| HW-MECH-02 | Height budget: top-side parts ≤ 3.0 mm under the lid, ≤ 3.8 mm where the lid has a pocket (USB-C 3.26 mm [R22 drawing], WROOM-1U); bottom parts ≤ 9.0 mm (10.0 mm to the floor, H5); the handset jack (4.0 mm) on the bottom; ≤ 1.0 mm on the bottom under the speaker (x 59–102, y 32.5–55), whose SP-2040 is 8.4 mm deep; switch plate top = board top + 5.0 mm. | PROTO_BOX geometry; `proto_box.py` checks. | I (`make proto` checks) | ✓ |
| HW-MECH-03 | Connector and control positions (board coordinates): **handset jack J7 on the rear edge at x 153.8, bottom side** (H5); power USB-C J1 on the right edge at y 40; VOL− y 70.8, VOL+ y 62.8, MUTE y 51.3 on the right edge (bottom side); battery JST J2 (150, 46) bottom; speaker JST J4 (108, 60) bottom; e-ink ZIF J6 (119.4, 43.8); RESET/BOOT pinholes (158.5, 12.5)/(158.5, 20.8); mic lights (158.5, 67.5), recording light (158.5, 77.0). | `layout/placement.yaml` (to update in H6), `proto_box.py`. | I | △ (placement.yaml still has the USB-C J7 until H6) |
| HW-MECH-04 | **Antenna rule (D7, D19):** a general-purpose 2.4 GHz antenna with a U.FL/IPEX connector on the shell wall, user-upgradable. **Certification caveat:** the WROOM-1U modular grant covers only antennas of the **same type** as its certification antenna (monopole, TFPD05H08750011) with peak gain **≤ 2.33 dBi**; any other type or a higher gain needs new radio testing, and a user-fitted upgrade is outside the certification. ≥ 15 mm from any metal; no metallic paint or plating on the base. | [R1 p44]; 47 CFR 15.204(c)(4); D7, D19. | I (enclosure CAD, antenna datasheet), T (RSSI within 3 dB of a DevKit) | △ (the shipped antenna must meet the caveat; F-02) |
| HW-MECH-05 | Keys at x 42.4 + 19.05 i, rows y 14.8 and 72.8; sockets on the bottom; the printed lid is the switch plate and takes keystroke force; keycaps captive. | LAYOUT §2, GUIDELINES §4. | I | ✓ |
| HW-MECH-06 | Every connector and switch cluster shall have a mounting hole within 10 mm; force-bearing parts shall have through-hole or hold-down tabs. | GUIDELINES §4. | I | △ (USB-C shell tabs through-hole [R22]; the SMD jack J7 has two locating pegs and six pads only: keep a mounting hole within 10 mm and a wall boss behind the plug, H6/enclosure) |
| HW-MECH-07 | Hook geometry: plunger magnet ≤ 2 mm above the Hall sensor on-hook, **≥ 10 mm travel** (D3, b11); no ferrous parts within 15 mm of the sensor. | PROTO_BOX; DESIGN §11.3. | I, T | ✓ |
| HW-MECH-08 | NFC coil region: no copper inside the loop on any layer; the ST25DV within 20 mm of the coil. | DESIGN §11.3; LAYOUT §7 NFC check. | I (layout check) | ✓ |
| HW-MECH-09 | **Captive hook plunger and magnet (D8):** the plunger cannot be pulled out of its sleeve without tools (retaining lip or pin), the magnet is fully enclosed in it; plunger travel 10 mm (HW-FUNC-08). | D8; EN 71-1 / ASTM F963 magnet clauses (HW-REG-05). | I (enclosure CAD), T (pull/torque test at DVT) | ✓ proto box (sleeve flange under the lid, lip, retainer cage; `make proto` check); product enclosure open |

## 6. Environmental (HW-ENV)

| ID | Requirement | Rationale | Verification | Status |
|---|---|---|---|---|
| HW-ENV-01 | Operating ambient **0 … +40 °C** (indoor). Every fitted part shall be rated for at least this range; charging only 0 … 45 °C. | Narrowest parts: e-ink 0 … +50 °C [R20 p9], LTR-303 −30 … +70 °C [R18 p6], the handset's electret is off-board (H5), WROOM-1U-N16R8 −40 … +65 °C [R1 p3]. | A (this table), T | ✓ |
| HW-ENV-02 | Storage and transport **−20 … +60 °C** (without the battery pack; packs per their datasheet). | e-ink storage −25 … +70 °C [R20 p9]; electret −30 … +70 °C [R19 p2]; USB-C −30 … +80 °C [R22]. | A | ✓ |
| HW-ENV-03 | Humidity: operating 20–80 % RH non-condensing; storage ≤ 85 % RH. | Indoor product; e-ink optimal storage 55 ± 10 % RH [R20 p9]. | A, T (damp-heat soak at DVT) | △ |
| HW-ENV-04 | Mechanical robustness: the base shall survive a 0.9 m drop onto hardwood on each face without loss of function; keys ≥ 1 M presses; handset plug ≥ 5 000 cycles. | Kids' use (DESIGN §14.2); PJ-31060 life 5 000 cycles (HOOYA drawing p1, UNVERIFIED reading). | T (DVT) | △ |

## 7. Regulatory intent (HW-REG)

The product is not being certified yet; these requirements make the design certifiable.

| ID | Requirement | Rationale | Verification | Status |
|---|---|---|---|---|
| HW-REG-01 | **FCC Part 15 Subpart B, Class B** (unintentional radiator, digital device) for the host; the radio relies on the WROOM-1U's Part 15C modular grant, so the host label shall read "Contains FCC ID: …" and the module integration rules (antenna type, gain) shall be followed. | 47 CFR 15.101/15.109, 15.212 (https://www.ecfr.gov/current/title-47/chapter-I/subchapter-A/part-15); module certificates [R1 p2]. | T (pre-scan at DVT), I (label) | △ F-02 |
| HW-REG-02 | **ISED** ICES-003 Class B and module IC ID on the label. | Canada equivalent (UNVERIFIED clause). | I, T | △ |
| HW-REG-03 | **CE, Radio Equipment Directive 2014/53/EU** via the module's radio reports: Art 3.1(a) EN IEC 62368-1 + EN 62311/EN 62479 (RF exposure); 3.1(b) EN 301 489-1/-17 with EN 55032/EN 55035; 3.2 EN 300 328 (module report reusable only with the same antenna type/gain); 3.3(d)(e)(f) EN 18031-1/-2 (cybersecurity; -2 for toys/childcare and personal data). | DESIGN top risks; RED delegated regulation 2022/30 applies from 1 Aug 2025 (https://eur-lex.europa.eu/eli/reg_del/2022/30/oj). | I, T | △ F-02 |
| HW-REG-04 | **RoHS** (2011/65/EU as amended by 2015/863), REACH SVHC declaration and WEEE marking; every BOM line RoHS-compliant. | Market access; vendor RoHS statements in each component file. | I (BOM declarations) | ✓ (all listed parts state RoHS) |
| HW-REG-05 | **Toy safety as design input, not certification (D11):** EN 71-1/-2/-3, **EN IEC 62115** (electric toys) and ASTM F963 (incl. its magnet and battery clauses) are design intent; certification is a later decision. | GUIDELINES §1; D11. | I (design review), T (DVT pre-test) | ✗ F-21 |
| HW-REG-06 | **Battery**: the pack shall have a UN 38.3 test summary (transport) and IEC 62133-2 certification (UL 2054/UL 1642 for US retail); the design shall meet the EU Battery Regulation (EU) 2023/1542 marking and end-user removability rules (screws with commercially available tools). | GUIDELINES §1; https://eur-lex.europa.eu/eli/reg/2023/1542/oj (Art. 11). | I (supplier documents) | △ (no pack chosen) |

## 8. Manufacturing and cost (HW-MFG)

| ID | Requirement | Rationale | Verification | Status |
|---|---|---|---|---|
| HW-MFG-01 | The board shall be orderable as standard JLCPCB 4-layer PCBA (two-sided) and portable to any fab: ≥ 0.15/0.15 mm track/space, ≥ 0.3 mm drill, Gerber X2 + Excellon + IPC-2581, generic BOM (MPN + LCSC) and pick-and-place. | Owner manufacturing decision 2026-09-27. | I (`make layout` outputs) | △ (not routed) |
| HW-MFG-02 | Prefer JLC *basic* parts: extended parts **should** be ≤ 25 distinct lines (each adds a setup fee on small orders). | Owner cost decision; H5 count 34 (was 35; `build/summary.txt`). | I (`cost.py`) | ✗ F-23 (owner question) |
| HW-MFG-03 | Every fitted part shall have ≥ 1 000 units in stock at JLCPCB/LCSC at design freeze, or a checked drop-in alternate listed in its component file. | One-off and small-batch buildability. | I (`make lcsc`) | △ BQ24074 (F-24 alternate), SWPA4020S470MT |
| HW-MFG-04 | Cost per phone: ≤ $40 at 1 k and ≤ $38 at 10 k (including the handset), and **affordable one-off** (≈ $198 per phone for a JLC minimum order after H5, to report each build). | Owner cost goal $28–40 (CLAUDE.md). | A (`cost.py`) | ✓ ($34.61 / $32.81, H5) |
| HW-MFG-05 | Hand-assembly feasibility: no part smaller than 0603 and no BGA; fine-pitch QFN/LGA parts listed with the tools they need; parts that cannot be reflowed identified. | Owner: hobbyist builds (ASSEMBLY.md). | I | ✓ (H5: the iron-only electret is gone) |
| HW-MFG-06 | Test points on the bottom on a 2.54 mm grid: VBUS, VSYS, 3V3, 3V0, **MIC_VCC** (H5), GND × 2, U0TXD, U0RXD, EN, BOOT; first power-up with a current-limited 5 V on the VBUS pad. | Owner audit 2026-09-28; BR-TP-01. | I | ✓ |
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
