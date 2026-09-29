# Open Lounge Phone "Trimline" r0.1: schematic as code

Status: **electrical capture of the single board, pre-layout.** (Single board, owner
decision 2026-09-27: two stacked boards were carried over from the old long base; one board is
cheaper one-off: one fab/assembly setup, no FFC/connectors/standoffs. The former deck board is
the `ui.py` block of the one netlist.) This implements
[DESIGN.md](DESIGN.md) r0.1 as checked, version-controlled Python. It does not decide any of the
owner's open questions in DESIGN.md §15; they are build parameters in `config.py`.
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
make build        # venv (first run) + ERC + checks + netlist + BOM for the one board
make lcsc         # network: re-verify every LCSC code (LCSC + JLCPCB), refresh lcsc_cache.json
make footprints   # network: refresh the KiCad footprint-library listing (fp_cache.json)
```

`make build` works offline because it uses the committed caches. It exits non-zero on any ERC
error or check error. Two harmless warnings, "fp-lib-table file was not found", come from SKiDL.

Outputs (regenerate with `make build`) are in `build/main/` (one board, one BOM):

| File | What |
|---|---|
| `main.net` | KiCad netlist. In Pcbnew: File → Import → Netlist. |
| `bom.csv` | Full BOM with MPN, LCSC, footprint and verification status (only the NFC tuning cap is DNP) |
| `bom-jlc.csv` | Fitted parts only, in JLCPCB assembly format |
| `erc.txt`, `checks.txt` | SKiDL ERC output and custom check results |
| `../summary.txt` | The build line, the I2C bus and the cost result |

## Source layout (`schematic/`)

| File | Contents |
|---|---|
| `board_main.py` | The board, block by block: power + battery, MCU, audio, sensors, handset port, side controls, test points |
| `ui.py` | UI block (the former deck board): AW9523B keys, LED chain, privacy LED, ALS, NFC, e-ink |
| `parts.py` | Every non-passive part: pin map, footprint, MPN, LCSC, datasheet, verification note |
| `lib.py` | Part factory, passives (JLC basic codes), DNP, references |
| `pin_table.yaml` | DESIGN.md §5 GPIO table, machine-readable |
| `config.py` | Design parameters (one design) |
| `checks.py` | Custom checks (below) |
| `lcsc.py`, `fpcheck.py` | LCSC/JLCPCB and KiCad-footprint verifiers with committed caches (the LCSC cache also stores LCSC and JLCPCB price ladders) |
| `cost.py`, `cost_model.yaml` | cost roll-up (at scale and one-off) |

## One board, one BOM (owner decision 2026-09-28)

No Kids/Lounge variants: `config.DESIGN` is the only build. On the board: every core part plus
the e-ink strip (GDEY029T94 ZIF + SSD1680 boost), NFC (ST25DV04K + PCB coil) and the 1S LiPo
charger path with the MAX17048 fuel gauge and the JST-PH-3 (no fixed TS resistor: the pack NTC
sets TS; without a pack the charger simply does not charge). Everything is fitted except the NFC
tuning cap (value set in EVT); `check_one_bom` enforces it.

Removed: the LD2410C radar with its 5 V switch, series resistors and LD_* GPIOs (GPIO46 strap now
left open with its internal pull-down), the supercap hold-up (47 Ω, 0.47 F,
Schottky), the ATECC608B footprint (flash encryption + eFuse HMAC instead), the IR hook option,
the Qwiic display port, the fixed 10 k TS resistor and the 1 µF caps on the unused codec mic
inputs (ES7210 MIC1/MIC4, ES8311 MIC1 now open: they are biased internally at VMID
**[UNVERIFIED against the datasheets]**). Lounge features (radar presence, power-fail wipe)
are deferred to a future board.

- **Key count** is `Variant.n_keys` = 12 (owner decision 2026-09-27): rear row `1 2 3 4 5 MENU`,
  front row `6 7 8 9 0 BACK`. AW9523B ports: `ui.AW_PORTS` (bus order: each row arrives as a
  parallel bus on one side of the AW9523B at the right end of the rows).
  The SK6812 chain runs rear row right→left (MENU first, next to the ESP32), front row
  left→right, then the status pixel (`ui.led_chain`, firmware maps LED index → key with it).
- **Power:** full features need a ≥ 1.5 A USB-C source; any source works in reduced mode
  (`power_budget.yaml`, `check_power_budget`).
- **Not touched by the schematic:** base length and envelope (§15 Q1) and toy classification
  (§15 Q4).

## What is captured

**The board: 241 parts (12 keys), all blocks from DESIGN.md §3–§5, §6–§9 and §11.3.**

- **Power:**
  - USB-C sink with separate 5.1 k Rd on CC1/CC2.
  - CC sense to GPIO8 (CC1) / GPIO6 (CC2) through 1 k.
  - USBLC6-2SC6 on D+/D−, and a second one on CC1/CC2.
  - PTC 1.5 A, then SMF5.0A.
  - BQ24074 power path: EN2=1/EN1=0, so ILIM 1.1 k gives 1.46 A; ISET 1.8 k gives 494 mA. /CE is on GPIO45 (strap pull-down). /PGOOD and /CHG are pulled up to GPIO16/18.
  - TLV62569 buck to 3.3 V (100 k/22 k), and LP5907-3.0 analog LDO from VSYS.
- **MCU:** ESP32-S3-WROOM-1-N16R8 with 22 µF + 100 nF, EN RC (10 k/1 µF) with a RESET button, and GPIO0 BOOT with a 10 k pull-up. The pins follow `pin_table.yaml` (assigned by board geometry since placement A2, `layout/pinswap.py`); IO35–37 are explicitly no-connect.
- **Audio** (Korvo-2 topology; values read from its V3.1.2 schematic):
  - ES8311 at 0x18 (CE strap). ES7210 at 0x40 (AD0/AD1 straps), TDM on SDOUT1 through 47 Ω to GPIO38.
  - Shared MCLK/BCLK/WS.
  - AVDD from 3V0; digital supplies from 3V3.
- **Handset (owner decision 2026-09-27): off-the-shelf USB-C UAC handset/headset** on a
  second USB-C receptacle (J7, rear edge). The ESP32-S3 native USB (GPIO19/20) is the host.
  Source role: Rp 33 k to 3V3 on CC1/CC2; VBUS from a SY6280 0.45 A switch (U15, EN = GPIO3
  with 100 k pull-down, ILIM 15 k) fed from VBUS or VSYS through two B5819W (diode-OR, works on
  the battery option); HS_VBUS sensed on GPIO10 via 100 k/100 k + 100 nF; SRV05-4 (D7) on
  D+/D−/CC1/CC2 at the connector. The RJ9 jack, its ESD, the pair-swap jumpers, cord filters,
  handset mic bias/detect and the TS5A3166 earpiece switch are gone. ES7210 CH1 and the ES8311
  ADC inputs are AC-grounded (unused).
- **Programming/console:** CH340C (U16, 3.3 V) on the power USB-C D+/D− (after the USBLC6 and
  0 Ω links) to UART0 (GPIO43/44), DTR/RTS auto-reset through two MMBT3904 (Q5 → EN, Q6 →
  GPIO0).
- **Base mic:** the base electret goes into CH2.
- **Side controls (main board edge):** VOL−/VOL+ (SKRTLAE010) and MUTE (C&K JS202011AQN,
  right-angle through-hole DPDT) with 10 k pull-ups and SRV05-4; MUTE pole A breaks the mic bias
  locally, pole B and the VOL lines go to the AW9523B.
- **AEC reference:** ES8311 OUTP/OUTN → 470 nF → 20 k per leg, with 4.3 k + 100 pF shunted across the legs (≈ −24 dB, Korvo values) → ES7210 CH3. CH4 is AC-grounded.
- **Speaker:** NS4150B on VSYS, CTRL = PA_EN (GPIO38, 100 k pull-down). Input is 100 nF + 150 k (gain 1.6). Outputs go through 2.2 A ferrite beads + 220 pF to a JST-PH-2.
- **Mic bias / privacy:**
  - ES7210 MICBIAS12 → MUTE slide (pole A) → MICBIAS_OUT.
  - 100 k bleed and a 100 Ω/10 µF filter, feeding the electret.
  - An MMBT3904 senses the post-switch bias and sinks the privacy-LED cathode. Firmware cannot light a mic without lighting the LED.
- **Sensors:**
  - DRV5032**FA** hall hook → HOOK (RTC GPIO, `pin_table.yaml`), direct.
  - LIS2DH12 at 0x19. INT1 reaches the shared IRQ through an N-FET (see Deviations).
  - MAX17048 on VBAT (always fitted; the battery itself is optional).
- *(Radar socket and supercap hold-up: removed 2026-09-28, see above.)*
- **Other:**
  - LED data: GPIO21 (100 k pull-down) → SN74LV1T125 on VSYS → 330 Ω → LED chain.
  - Shared I2C pull-ups of 4.7 k, and a 10 k IRQ pull-up (AW9523B INTN, ST25DV GPO, MAX17048 ALRT are open-drain).
  - Test points (A3, LAYOUT.md): VBUS, VSYS, 3V3, 3V0, handset VBUS, GND×2, U0TX/RX, EN, BOOT; the rest are probed on the parts.

**UI block (`ui.py`, the former deck board).**

- **Keys:**
  - AW9523B (U17, C148077) at 0x58 = 0x58 + AD1·2 + AD0 with AD0 = AD1 = GND. Per the datasheet
    AD0/AD1 also set the power-on output state; tied low the outputs start low, so LED_PWR_EN
    (port 1) keeps the LED chain unpowered until firmware runs. RSTN has an internal 100 k
    pull-*down*: 10 k pull-up + 100 nF. INTN is open-drain: shared IRQ with its 10 k pull-up.
    P0 is open-drain by default and there are no internal pull-ups: every key has a 10 k
    pull-up (port 1 drives LED_PWR_EN push-pull). Port map: `ui.AW_PORTS` (follows the board geometry).
  - 12 Kailh hot-swap sockets **CPG151101S11-16** (C5156480, out of stock on 2026-09-27; see
    Deviations 10).
- **LEDs:** 13 × SK6812MINI-E (12 keys + status) on VLED. VLED is switched from VSYS by a P-FET with an N-FET driver, from LED_PWR_EN (AW9523B port 1).
- **Indicators and sensors:**
  - Red privacy LED.
  - LTR-303ALS-01 (U18, C364577) at 0x29, polled; pins 1 VDD, 2 NC, 3 GND, 4 SCL, 5 INT
    (open-drain, unused), 6 SDA.
  - ST25DV04K (U19) at 0x53/0x57, GPO on IRQ. Its PCB coil (9 turns, 26 × 42 mm, ≈ 4.8 µH
    estimated) sits in the free front-left end region of the board, with a DNP tuning cap.
- **E-ink:** GDEY029T94 on an XUNPU **FPC-05F-24PH20** (J6, C2856805: 24P 0.5 mm flip-lock,
  bottom contact; project footprint from the XUNPU drawing) with the Good Display reference boost:
  - 47 µH inductor and Si1308EDL switch, with a 1 M gate pull-down.
  - 2.2 Ω sense resistor and 3 × MBR0530.
  - 4.7 µF charge pump, and 1 µF (50 V parts) on VSH1/VSH2/VSL/VGH/VGL/VCOM/VDD.
  - BS1 low (4-wire SPI).

## Checks (all run by `make build`)

1. **SKiDL ERC.** Result: 0 errors. There are 5 expected warnings, all open-drain outputs (/PGOOD, /CHG, MAX17048 ALRT, AW9523B INTN, ST25DV GPO) meeting an ESP32 GPIO.
2. **Pin table.** Every ESP32 pad's net must equal `pin_table.yaml`. Beyond that:
   - analog signals must be on ADC1 and wake signals on RTC GPIOs;
   - strap pins need a pull in the right direction only;
   - IO35–37 must be unconnected;
   - no GPIO outside the table may be used.
3. **I2C addresses** are derived from the strap wiring, not declared. They must match DESIGN.md's map and be unique on the bus.
4. (The FFC pin check was removed with the FFC: single board since 2026-09-27.)
5. **Nets:** no single-pin nets and no floating input or power pins.
6. **Sourcing:**
   - every LCSC code exists, and its MPN matches the schematic's;
   - each passive's value matches LCSC's description;
   - zero JLCPCB stock is warned;
   - `[UNVERIFIED]` items are listed.
7. **Footprints:** every name exists in the official KiCad library. `OpenLoungePhone:` footprints are listed as TODO.

**The checks have been mutation-tested.** Each of these deliberate breakages made the build fail:
- swapping two GPIOs;
- flipping the GPIO45 strap;
- strapping LIS2DH12 SA0 low;
- using PSRAM pin IO36;
- floating BQ24074 EN1;
- a wrong LCSC code;
- a wrong basic-resistor code;
- a misspelled footprint.

**Current result:** one build (`build/main/`) with 0 ERC errors and 0 check errors.

8. **One BOM** (`check_one_bom`): e-ink parts present and nothing DNP except the NFC tuning cap.
9. **Cost roll-up** (`cost.py`, runs after the board): BOM × price ladder from
   `lcsc_cache.json` (JLCPCB assembly price first) at 1k and 10k phones, plus a one-off
   maker order (JLCPCB PCBA reference quote and an OSH Park bare-board + hand-assembly build),
   PCB/assembly/off-board estimates from `cost_model.yaml` (all dated, marked EST). Writes
   `build/main/cost.txt` and one line in `build/summary.txt`; WARNs above
   $40 at 1k (owner guidance: $28-40 is fine), never fails the build.

## Deviations from DESIGN.md (and why)

1. **LED level shifter:** SN74LV1T125 instead of 74AHCT1G125. The AHCT part's minimum VCC is 4.5 V, but VSYS is 4.4 V, or lower on battery. The LV1T125 accepts 3.3 V inputs at VCC 4.4 V.
2. **Hall sensor:** DRV5032**FA** (C140921) instead of FB (C2655033). FB is the 5 Hz variant; FA is the 20 Hz omnipolar push-pull part DESIGN.md intends. FB also showed zero JLCPCB stock.
3. **LIS2DH12 INT1 → IRQ goes through an N-FET.** The LIS2DH12 has no open-drain interrupt mode, so it cannot be wire-OR'd directly.
4. **No FFC** (single board, 2026-09-27): DESIGN.md §5's 24-pin main↔deck FFC and both FH12 connectors are gone.
5. **B-option battery connector is JST-PH-3** (VBAT/NTC/GND) instead of PH-2. A 2-pin plug cannot bring the pack NTC to the BQ24074 TS pin.
6. **P-FET load switches get N-FET gate drivers** (LED VSYS; the radar 5 V switch went with the radar). A 3.3 V GPIO or AW9523B output cannot pull a 4.4–5 V P-FET gate high enough to turn it off. DESIGN.md didn't specify the driver.
7. *(Supercap charge resistor: removed with the supercap, 2026-09-28.)*
8. **ILIM is 1.46 A typ (1.35 A guaranteed), not 1.5 A.** 1.5 A needs 1.07 kΩ, which is below
   the BQ24074's 1.1 kΩ minimum — and it isn't needed: `check_power_budget` (data in
   `schematic/power_budget.yaml`) proves every scenario fits under the *guaranteed minimum*
   (K_ILIM 1500 AΩ, 1 % resistor): worst firmware-capped load 970 mA through the charger (28 %
   headroom), worst uncapped 1250 mA (7 %). It also checks VSYS against every VSYS part's rating
   and the charger's junction temperature (≈77 °C worst case at 40 °C ambient).
   Considered and rejected: BQ24075 (same footprint, OUT follows VBUS up to 5.5 V). It runs
   cooler, but VSYS would exceed the NS4150B's 5.25 V rating and sit at the 5.5 V limit of the
   LDO, buck and LEDs; the BQ24074's regulated 4.4 V is a feature. The check fails if
   anyone makes that swap.
9. **Additions DESIGN.md implied but didn't list:**
   - 100 k bleed on the post-mute bias, so the privacy LED goes out quickly;
   - 330 Ω LED-data series resistor and a LED_DATA (GPIO21) pull-down, to limit back-feed into an unpowered LED chain;
   - AW9523B RSTN pull-up;
   - 0 Ω D± links for EVT tuning.
10. **Hot-swap socket:** the exact part is Kailh **CPG151101S11-16** (LCSC C5156480), out of
    stock at LCSC/JLCPCB on 2026-09-27. In-stock alternative: C49352235 (CPG151101S11-2, 26k
    stock, listed under HanElectricity), the same socket body per its listing — confirm against
    its drawing before a JLC order. Otherwise hand-source Kailh sockets (keyboard vendors) and
    hand-solder them (large pads).
11. **Datasheet re-check 2026-09-27 (no change needed):** side-push VOL switches Alps SKRTLAE010 (C110293; alt
    K2-1114SA-A4SW-06, C136662); JST S3B-PH-SM4-TB is C265101; no 2N7002 is used (every
    3.3 V-driven N-FET is an AO3400A, C20917, logic-level).

## Assumptions and unverified items (also in `checks.txt`)

- **Pin maps:**
  - ES7210 pins 3/4 (CDATA/CCLK) follow the pinout drawing and Korvo-2; the datasheet's pin table has them swapped.
  - SY6280 current limit formula (6800/Rset) from the Silergy application note; CH340C pinout from the WCH datasheet (SOP-16).
  - Electret ground pad, red LED cathode mark and MMBT3904 B/E/C.
  - MAX17048 exposed pad.
  - AW9523B exposed-pad land size.
  - C&K JS202011JAQN pole pinout, and whether it shares the JCQN land pattern.
- **GDEY029T94:** which pins get caps was read from a small reference drawing. The FPC contact side needs confirming against a sample.
- **Values to tune in EVT:**
  - AEC-reference attenuation;
  - speaker EMI;
  - total VSYS capacitance: ~140 µF against TI's recommended 4.7–47 µF on BQ24074 OUT. Verify start-up.
- **Stock:** LIS2DH12TR showed zero stock on LCSC and JLCPCB on 2026-09-27. The alternatives (LIS2DW12, SC7A20) are not pin-checked.
- **SK6812MINI-E minimum VDD is 3.7 V.** On battery, VSYS can fall below that; firmware should blank the LEDs below ~3.7 V.
- **Debug:** the ESP32-S3 has no SWD. Flashing and the console use the CH340C USB-UART bridge on the power USB-C port (the native USB is the handset port's host). Pad JTAG (GPIO39–42) carries the e-ink control and SPI lines, so there is no external JTAG header. Recovery is UART download mode through the U0TXD/U0RXD + GPIO0 + EN pads. Production eFuses (DESIGN.md §10.1) disable USB-JTAG.

## What's left

Layout is code too, in `hardware/layout/` (see [LAYOUT.md](LAYOUT.md)); the board is placed, not routed yet. The project
footprints (hot-swap socket, electret, NFC coil, e-ink FPC connector) live in
`layout/footprints/openloungephone.pretty`. Passives are 0603 by default (hand-solderable; see [ASSEMBLY.md](ASSEMBLY.md)).

1. **Mechanical integration:** the product enclosure and hook rest (not designed yet; the
   prototype box is `enclosure/proto_box.py`).
2. **Before layout freeze:** close the unverified items above.
