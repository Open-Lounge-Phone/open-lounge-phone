# OpenTinCan "Trimline" r0.1: schematic as code

Status: **electrical capture of the main and deck boards, pre-layout.** This implements
[DESIGN.md](DESIGN.md) r0.1 as checked, version-controlled Python. It does not decide any of the
owner's open questions in DESIGN.md §15; they are build parameters (see Variants below).
License: CERN-OHL-S-2.0, like the rest of `hardware/`.

## Toolchain

**SKiDL 2.3** (Python → KiCad netlist), pinned in `requirements.txt` and installed only into
`hardware/.venv`. No KiCad install is needed to build or check.

- **atopile was tried first and rejected.** The PyPI release that installs on Python 3.13
  (0.12.6) refuses to run and says the classic CLI has been replaced by a hosted app. The last
  CLI (0.15.x) needs Python 3.14 and is in maintenance-only mode. An end-of-life CLI is a poor
  foundation for an open-hardware source of truth.
- **KiCad is not required** to build. Every part is defined in `schematic/parts.py` (pin map,
  footprint, MPN, LCSC), so SKiDL never reads KiCad's symbol libraries. The netlist refers to
  footprints by their official KiCad library names.
- **What it cannot do (no KiCad GUI here):** it draws no schematic sheet (the Python *is* the
  schematic), does no PCB layout and no DRC.

## Build

```sh
cd hardware
make build        # venv (first run) + ERC + checks + netlists + BOMs for every board x variant
make lcsc         # network: re-verify every LCSC code (LCSC + JLCPCB), refresh lcsc_cache.json
make footprints   # network: refresh the KiCad footprint-library listing (fp_cache.json)
```

`make build` works offline because it uses the committed caches. It exits non-zero on any ERC
error or check error. Two harmless warnings, "fp-lib-table file was not found", come from SKiDL.

Outputs (git-ignored, regenerate with `make build`) are in `build/<board>-<variant>/`:

| File | What |
|---|---|
| `main.net` / `deck.net` | KiCad netlist. In Pcbnew: File → Import → Netlist. |
| `bom.csv` | Full BOM incl. DNP, with MPN, LCSC, footprint and verification status |
| `bom-jlc.csv` | Fitted parts only, in JLCPCB assembly format |
| `erc.txt`, `checks.txt` | SKiDL ERC output and custom check results |
| `../summary.txt` | One line per board, plus the cross-board FFC and I2C results |

## Source layout (`schematic/`)

| File | Contents |
|---|---|
| `board_main.py` | Main board, block by block: power, MCU, audio, sensors, radar, FFC, test points |
| `board_deck.py` | Deck board: FFC, AW9523B keys/side controls, LED chain, privacy LED, ALS, NFC, e-ink |
| `parts.py` | Every non-passive part: pin map, footprint, MPN, LCSC, datasheet, verification note |
| `lib.py` | Part factory, passives (JLC basic codes), DNP, references |
| `ffc.py` | The 24-pin main↔deck FFC pinout (single source for both boards) |
| `pin_table.yaml` | DESIGN.md §5 GPIO table, machine-readable |
| `config.py` | Variants / open-question parameters |
| `checks.py` | Custom checks (below) |
| `lcsc.py`, `fpcheck.py` | LCSC/JLCPCB and KiCad-footprint verifiers with committed caches |

## Variants (open questions stay parameters)

| Build | Radar LD2410C | Supercap hold-up | Battery B-option | Keys |
|---|---|---|---|---|
| `kids` | DNP | DNP | DNP (10k TS resistor fitted) | 10 |
| `lounge` | fitted (header + 5 V switch) | fitted | DNP | 10 |
| `kids-batt` | DNP | DNP | fitted (JST-PH-3, MAX17048; TS resistor DNP) | 10 |

- **Key count** is `Variant.n_keys` (DESIGN.md's 10; §15 Q2 is open). The deck generator accepts
  4–12 keys; 8 and 12 were built to confirm this.
- **Battery default** (§15 Q3) follows DESIGN.md's proposal (no battery) but builds both ways.
- **Kids radar** (§15 Q5) is DNP, per DESIGN.md.
- **Not touched by the schematic:** base length and envelope (§15 Q1) and toy classification
  (§15 Q4).
- **Always DNP footprints:** ATECC608B, the IR hook sensor and the analog-sidetone links.

## What is captured

**Main board: 200 parts, all blocks from DESIGN.md §3–§5, §8, §9 and §11.3.**

- **Power:**
  - USB-C sink with separate 5.1 k Rd on CC1/CC2.
  - CC sense to GPIO1/2 through 1 k.
  - USBLC6-2SC6 on D+/D−, and a second one on CC1/CC2.
  - PTC 1.5 A, then SMF5.0A.
  - BQ24074 power path: EN2=1/EN1=0, so ILIM 1.1 k gives 1.46 A; ISET 1.8 k gives 494 mA. /CE is on GPIO45 (strap pull-down). /PGOOD and /CHG are pulled up to GPIO48/47.
  - TLV62569 buck to 3.3 V (100 k/22 k), and LP5907-3.0 analog LDO from VSYS.
- **MCU:** ESP32-S3-WROOM-1-N16R8 with 22 µF + 100 nF, EN RC (10 k/1 µF) with a RESET button, and GPIO0 BOOT with a 10 k pull-up. The pins follow `pin_table.yaml`; IO35–37 are explicitly no-connect.
- **Audio** (Korvo-2 topology; values read from its V3.1.2 schematic):
  - ES8311 at 0x18 (CE strap). ES7210 at 0x40 (AD0/AD1 straps), TDM on SDOUT1 through 47 Ω to GPIO38.
  - Shared MCLK/BCLK/WS.
  - AVDD from 3V0; digital supplies from 3V3.
- **Handset and base mic:**
  - RJ9 jack with SRV05-4 at the jack.
  - Four 3-pad solder jumpers swap the cord pairs; the default is pins 1/4 mic, 2/3 earpiece.
  - Each cord line gets a 600 Ω bead and 100 pF.
  - The handset mic is biased through 2.2 k from filtered MICBIAS and goes pseudo-differentially into ES7210 CH1. Its return uses a net tie.
  - HANDSET_DET: 100 k/100 k divider plus 100 nF to GPIO4.
  - The base electret goes into CH2.
- **Earpiece:** ES8311 OUTP → TS5A3166 (EAR_EN, GPIO3, 100 k pull-down) → EAR+; OUTN → EAR−. The receiver is driven DC-coupled and bridge-tied.
- **AEC reference:** ES8311 OUTP/OUTN → 470 nF → 20 k per leg, with 4.3 k + 100 pF shunted across the legs (≈ −24 dB, Korvo values) → ES7210 CH3. CH4 is AC-grounded.
- **Speaker:** NS4150B on VSYS, CTRL = PA_EN (GPIO41, 100 k pull-down). Input is 100 nF + 150 k (gain 1.6). Outputs go through 2.2 A ferrite beads + 220 pF to a JST-PH-2.
- **Mic bias / privacy:**
  - ES7210 MICBIAS12 → FFC → deck MUTE slide (pole A) → back to main.
  - On main: 100 k bleed and a 100 Ω/10 µF filter, feeding both electrets.
  - An MMBT3904 senses the post-switch bias and sinks the deck privacy-LED cathode. Firmware cannot light a mic without lighting the LED.
- **Sensors:**
  - DRV5032**FA** hall hook → GPIO5 (0 Ω link), with a DNP ITR8307 IR alternative.
  - LIS2DH12 at 0x19. INT1 reaches the shared IRQ through an N-FET (see Deviations).
  - ATECC608B DNP. MAX17048 on VBAT (B-option).
- **Radar (Lounge):** 5-pin right-angle socket. 5 V comes through a P-FET with an N-FET gate driver on LD_PWR_EN (GPIO46 strap pull-down), and the UART/OUT lines have 1 k series resistors.
- **Supercap (Lounge):** 47 Ω 2512 charge resistor and a B5819W discharge diode into VSYS.
- **Other:**
  - LED data: GPIO42 (100 k pull-down) → SN74LV1T125 on VSYS → 330 Ω → FFC.
  - Shared I2C pull-ups of 4.7 k, and a 10 k IRQ pull-up.
  - 24-pin FFC (Hirose FH12).
  - Test points: VBUS, VSYS, 3V3, 3V0, GND×4, USB D±, U0TX/RX, EN, GPIO0, I2S BCLK/WS/DIN/DOUT, I2C, HOOK, PA_EN, SPK±, EAR±, MIC±, ES8311 ASDOUT and the FFC spare.

**Deck board: 92 parts (10 keys).**

- **Keys and side controls:**
  - FFC mate.
  - AW9523B at 0x58. RSTN is pulled up because the chip has an internal pull-down. The port map follows DESIGN.md §5.
  - 10 Kailh hot-swap sockets with 10 k pull-ups (the chip has none).
  - VOL−/VOL+ side tacts, and the MUTE DPDT: pole A breaks the bias, pole B pulls MUTE_SENSE low.
  - SRV05-4 on the side-switch lines.
- **LEDs:** 11 × SK6812MINI-E (10 keys + status) on VLED. VLED is switched from VSYS by a P-FET with an N-FET driver, from LED_PWR_EN (AW9523B P1_5).
- **Indicators and sensors:**
  - Red privacy LED.
  - LTR-303ALS at 0x29, polled.
  - ST25DV04K at 0x53/0x57, GPO on IRQ. Its PCB coil is a footprint placeholder, with a DNP tuning cap.
- **E-ink:** GDEY029T94 on a Hirose FH12 FPC connector, with the Good Display reference boost:
  - 47 µH inductor and Si1308EDL switch, with a 1 M gate pull-down.
  - 2.2 Ω sense resistor and 3 × MBR0530.
  - 4.7 µF charge pump, and 1 µF (50 V parts) on VSH1/VSH2/VSL/VGH/VGL/VCOM/VDD.
  - BS1 low (4-wire SPI).

## Checks (all run by `make build`)

1. **SKiDL ERC.** Result: 0 errors. There are 3 expected warnings on main, all open-drain outputs (/PGOOD, /CHG, MAX17048 ALRT) meeting an ESP32 GPIO.
2. **Pin table.** Every ESP32 pad's net must equal `pin_table.yaml`. Beyond that:
   - analog signals must be on ADC1 and wake signals on RTC GPIOs;
   - strap pins need a pull in the right direction only;
   - IO35–37 must be unconnected;
   - no GPIO outside the table may be used.
3. **I2C addresses** are derived from the strap wiring, not declared. They must match DESIGN.md's map and be unique across both boards, DNP parts included.
4. **FFC:** 24 pins, 6 GND, and the same net on the same pin at both ends. This is read from the actual connector pins.
5. **Nets:** no single-pin nets and no floating input or power pins.
6. **Sourcing:**
   - every LCSC code exists, and its MPN matches the schematic's;
   - each passive's value matches LCSC's description;
   - zero JLCPCB stock is warned;
   - `[UNVERIFIED]` items are listed.
7. **Footprints:** every name exists in the official KiCad library. `OpenTinCan:` footprints are listed as TODO.

**The checks have been mutation-tested.** Each of these deliberate breakages made the build fail:
- swapping two GPIOs;
- flipping the GPIO45 strap;
- strapping LIS2DH12 SA0 low;
- crossing the mic-bias lines at one FFC end;
- using PSRAM pin IO36;
- floating BQ24074 EN1;
- a wrong LCSC code;
- a wrong basic-resistor code;
- a misspelled footprint.

**Current result:** 6 builds (3 variants × 2 boards) with 0 ERC errors and 0 check errors.

## Deviations from DESIGN.md (and why)

1. **LED level shifter:** SN74LV1T125 instead of 74AHCT1G125. The AHCT part's minimum VCC is 4.5 V, but VSYS is 4.4 V, or lower on battery. The LV1T125 accepts 3.3 V inputs at VCC 4.4 V. It sits on the **main** board, because the FFC carries buffered data; DESIGN.md §12.2 lists it on the deck.
2. **Hall sensor:** DRV5032**FA** (C140921) instead of FB (C2655033). FB is the 5 Hz variant; FA is the 20 Hz omnipolar push-pull part DESIGN.md intends. FB also showed zero JLCPCB stock.
3. **LIS2DH12 INT1 → IRQ goes through an N-FET.** The LIS2DH12 has no open-drain interrupt mode, so it cannot be wire-OR'd directly.
4. **FFC has one spare, not two.** DESIGN.md §5's list adds up to 25 signals for a 24-pin cable. The pin order in `ffc.py` fences LED data and SPI clock with GND and keeps the mic-bias pair at the far end.
5. **B-option battery connector is JST-PH-3** (VBAT/NTC/GND) instead of PH-2. A 2-pin plug cannot bring the pack NTC to the BQ24074 TS pin.
6. **P-FET load switches get N-FET gate drivers** (radar 5 V, LED VSYS). A 3.3 V GPIO or AW9523B output cannot pull a 4.4–5 V P-FET gate high enough to turn it off. DESIGN.md didn't specify the driver.
7. **Supercap charge resistor is a 47 Ω 2512 (1 W).** It dissipates 0.41 W at t = 0.
8. **ILIM is 1.46 A typ (1.35 A guaranteed), not 1.5 A.** 1.5 A needs 1.07 kΩ, which is below
   the BQ24074's 1.1 kΩ minimum — and it isn't needed: `check_power_budget` (data in
   `schematic/power_budget.yaml`) proves every scenario fits under the *guaranteed minimum*
   (K_ILIM 1500 AΩ, 1 % resistor): worst firmware-capped load 970 mA through the charger (28 %
   headroom), worst uncapped 1250 mA (7 %). It also checks VSYS against every VSYS part's rating
   and the charger's junction temperature (≈77 °C worst case at 40 °C ambient).
   Considered and rejected: BQ24075 (same footprint, OUT follows VBUS up to 5.5 V). It runs
   cooler, but VSYS would exceed the NS4150B's 5.25 V rating and sit at the 5.5 V limit of the
   LDO, buck, LEDs and supercap; the BQ24074's regulated 4.4 V is a feature. The check fails if
   anyone makes that swap.
9. **Additions DESIGN.md implied but didn't list:**
   - 100 k bleed on the post-mute bias, so the privacy LED goes out quickly;
   - 330 Ω LED-data series resistor and a GPIO42 pull-down, to limit back-feed into an unpowered LED chain;
   - AW9523B RSTN pull-up;
   - 0 Ω D± links for EVT tuning.
10. **Hot-swap socket listing:** C49352235 (CPG151101S11-2, in stock) instead of C5156480 (-16, zero stock). Marked unverified.

## Assumptions and unverified items (also in `checks.txt`)

- **Pin maps:**
  - ES7210 pins 3/4 (CDATA/CCLK) follow the pinout drawing and Korvo-2; the datasheet's pin table has them swapped.
  - RJ9 jack pin order and body: the jumpers cover either pair assignment.
  - Electret ground pad, red LED cathode mark, MMBT3904 B/E/C and ITR8307 variant.
  - MAX17048 exposed pad.
  - AW9523B exposed-pad land size.
  - C&K JS202011JAQN pole pinout, and whether it shares the JCQN land pattern.
- **GDEY029T94:** which pins get caps was read from a small reference drawing. The FPC contact side needs confirming against a sample.
- **Values to tune in EVT:**
  - AEC-reference attenuation;
  - speaker EMI;
  - total VSYS capacitance: ~140 µF against TI's recommended 4.7–47 µF on BQ24074 OUT. Verify start-up.
- **Supercap:** no LCSC/JLCPCB listing found for 0.47 F / 5.5 V. Part and footprint still to choose.
- **Stock:** LIS2DH12TR showed zero stock on LCSC and JLCPCB on 2026-09-27. The alternatives (LIS2DW12, SC7A20) are not pin-checked.
- **SK6812MINI-E minimum VDD is 3.7 V.** On the battery B-option, VSYS can fall below that; firmware should blank the LEDs below ~3.7 V.
- **Debug:** the ESP32-S3 has no SWD. Flashing and debug use the native USB-Serial/JTAG on the USB-C port. Pad JTAG (GPIO39–42) is used for radar UART, PA_EN and LED data, so there is no external JTAG header. Recovery is UART download mode through the U0TXD/U0RXD + GPIO0 + EN pads. Production eFuses (DESIGN.md §10.1) disable USB-JTAG.

## What's left

1. **Custom footprints** in `OpenTinCan.pretty`:
   - RJ9 jack
   - 6 mm electret
   - supercap
   - Kailh MX hot-swap socket
   - NFC coil. Design it with ST eDesignSuite for ~4.8 µH, to resonate with the ST25DV's 28.5 pF.
2. **KiCad project and layout:** import the netlists, draw board outlines per DESIGN.md §11, then place and route. Layout needs to cover:
   - the antenna keep-out;
   - codec and analog placement;
   - the hall sensor under the magnet;
   - the NFC loop keep-out;
   - the bottom-side deck sockets and LEDs.
   Then DRC, the family panel and stackup. This needs KiCad, which isn't installed here.
3. **Deck mechanics:** the FR4 key plate (no electrical content), side-switch placement, and the strip window.
4. **Mechanical integration:** enclosure, radome window, and handset parts (not electrical).
5. **Before layout freeze:** close the unverified items above, and pick the FFC cable type so that pin n maps to pin n.
