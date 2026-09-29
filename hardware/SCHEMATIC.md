# Open Lounge Phone "Trimline" r0.1: schematic as code

Status: **electrical capture of the single board, H5 revision (2026-09-30), pre-layout.** (Single board, owner
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
| `board_main.py` | The board, block by block: power + battery, MCU, audio, handset jack, privacy chain, sensors, side controls, test points |
| `ui.py` | UI block (the former deck board): AW9523B keys, LED chain, mic lights, recording light, ALS, NFC, e-ink |
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
sets TS; without a pack the charger simply does not charge). Everything is fitted (since H5 also
the 12 pF NFC tuning cap); `check_one_bom` enforces it.

Removed: the LD2410C radar with its 5 V switch, series resistors and LD_* GPIOs (GPIO46 strap now
left open with its internal pull-down), the supercap hold-up (47 Ω, 0.47 F,
Schottky), the ATECC608B footprint (flash encryption + eFuse HMAC instead), the IR hook option,
the Qwiic display port and the fixed 10 k TS resistor. Lounge features (radar presence,
power-fail wipe) are deferred to a future board. **H5 (2026-09-30)** removed the USB-C handset
port (J7 USB-C, SY6280, B5819W diode-OR, SRV05-4), the CH340C with its auto-reset NPNs, the
ES7210, the base electret, the AEC loopback, the NPN privacy-LED sense and the LIS2DH12 — see
[SCHEMATIC_REVIEW.md](SCHEMATIC_REVIEW.md) for the full before/after.

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

**The board (H5, 2026-09-30): 220 parts (12 keys, 34 JLC-extended lines), all blocks from
DESIGN.md §3–§5, §6–§9 and §11.3 as revised by the owner decisions of 2026-09-30.**

- **Power:**
  - USB-C J1: sink with separate 5.1 k Rd on CC1/CC2, **and the ESP32 native USB** (D+/D− →
    USBLC6-2SC6 D1 → 0 Ω links → IO19/IO20, device mode: flashing + USB-Serial-JTAG console).
  - CC sense to GPIO8 (CC1) / GPIO6 (CC2) through 1 k; USBLC6-2SC6 D2 on CC1/CC2.
  - PTC **2 A** (SMD1812P200TF16, 1812, 16 V), then SMF5.0A.
  - BQ24074 power path: EN2=1/EN1=0, ILIM 1.1 k → 1.46 A; ISET 1.8 k → 494 mA. /CE on GPIO45
    (strap pull-down). /PGOOD and /CHG pulled up to GPIO16/18. VSYS: 10 µF at OUT + 10 µF buck
    input + 1 µF LDO + 22 µF/1 µF at the amp = 44.5 µF (≤ 47 µF, H4 P-08).
  - TLV62569 buck to **3.19 V** (105 k / 24.3 k, 0.1 % thin film; 22 µF + 22 µF at the module),
    LP5907-3.0 analog LDO (1 µF; 2.1 µF total on 3V0).
- **MCU:** ESP32-S3-WROOM-1U-N16R8 with 22 µF + 100 nF, EN RC (10 k/1 µF) with a RESET button,
  GPIO0 BOOT with a 10 k pull-up. Pins follow `pin_table.yaml`; IO35–37 explicit no-connect; IO3,
  IO9, IO46 free.
- **Audio:** ES8311 (U6, 0x18) alone: **ADC = handset mic** (MIC1P/N, ASDOUT → 47 Ω → IO4),
  **DAC = earpiece and speaker**. NS4150B (U9) on VSYS, CTRL = PA_EN (GPIO38, 100 k pull-down),
  input 100 nF + **68 k** (gain 3.5, 1 W firmware cap), outputs through 2 A beads + 220 pF to J4
  for a Soberton **SP-2040** (8 Ω 1 W). Speaker for ringing and prompts only.
- **Handset jack (J7, HOOYA PJ-31060, 3.5 mm TRRS, bottom side, rear edge, CTIA):**
  - Earpiece: OUTP → TS5A3166 (U8, IN = HOOK: on only off-hook) with a 22 k bypass (keeps the
    coupling caps at VMID: no pop) → 2 × 22 µF → 22 Ω each to T and R1; 100 pF at the jack; 10 k
    tip bleed.
  - Mic: MIC_VCC → 2.2 k → HS_MIC_F → bead (FB3) → S; 100 pF; 1 µF into MIC1P; MIC1N via 1 µF
    to the jack ground R2 (net tie to GND at the jack).
  - Sense: HS_MIC_F → 1N4148W (D9, anode on the mic line) → 100 k → MIC_SENSE (IO10, ADC1),
    1 M + 10 nF to GND: mic present / button (S to GND) / OMTP plug. The diode blocks any GPIO
    current into the mic line.
  - Insertion: TN (normally-closed tip contact) → 1 M pull-up, 1 k → JACK_DET (IO12): low with
    no plug (TN touches the tip and its 10 k bleed), high with a plug.
  - ESD: 2 × PESD5V0S2BT (D7: T/R1, D8: S/TN), bidirectional.
- **Privacy chain:** 3V0 → 100 Ω → MIC_F (10 µF) → **MUTE pole A** → MIC_M → **Q5 AO3401A**
  (gate 100 k to MIC_M, pulled low by **Q6 AO3400A** whose gate is **HOOK**) → **MIC_VCC**
  (100 nF) → two red mic lights (D21, D22, 1 k each) and the 2.2 k mic bias. HOOK: DRV5032AJ
  (open drain) → 100 Ω → HOOK, 100 k pull-up to 3V3, 1 nF; the ESP32 reads it on IO17 through
  47 k. Recording light D23 on IO13 through 680 Ω. `check_privacy` proves the chain on the
  netlist (below).
- **Side controls (main board edge):** VOL−/VOL+ (SKRTLAE010) and MUTE (C&K JS202011AQN,
  right-angle through-hole DPDT) with 10 k pull-ups and SRV05-4 (D4); MUTE pole A breaks the
  handset-mic supply, pole B and the VOL lines go to the AW9523B.
- **Sensors:** DRV5032**AJ** hook (above); MAX17048 on VBAT (always fitted; the battery is
  optional). *(LIS2DH12, radar, supercap: removed.)*
- **Other:**
  - LED data: GPIO21 (100 k pull-down) → SN74LV1T125 on VSYS → 330 Ω → LED chain.
  - Shared I2C pull-ups of 4.7 k, and a 10 k IRQ pull-up (AW9523B INTN, ST25DV GPO, MAX17048 ALRT are open-drain).
  - Test points: VBUS, VSYS, 3V3, 3V0, **MIC_VCC**, GND×2, U0TX/RX, EN, BOOT.

**UI block (`ui.py`, the former deck board).**

- **Keys:**
  - AW9523B (U17, C148077) at 0x58 = 0x58 + AD1·2 + AD0 with AD0 = AD1 = GND. Per the datasheet
    AD0/AD1 also set the power-on output state; tied low the outputs start low, so LED_PWR_EN
    (port 1) keeps the LED chain unpowered until firmware runs. RSTN has an internal 100 k
    pull-*down*: 10 k pull-up + 100 nF. INTN is open-drain: shared IRQ with its 10 k pull-up.
    P0 is open-drain by default and there are no internal pull-ups: every key has a 10 k
    pull-up (port 1 drives LED_PWR_EN push-pull). Port map: `ui.AW_PORTS` (follows the board geometry).
  - 12 hot-swap sockets **CPG151101S11-2** (HanElectricity, C49352235: the Kailh CPG151101S11
    body and land, in stock; the Kailh -16 had none).
- **LEDs:** 13 × SK6812MINI-E (12 keys + status) on VLED. VLED is switched from VSYS by Q2
  (AO3401A) with Q3 (AO3400A) from LED_PWR_EN (AW9523B port 1), **soft start** 47 k + 4.7 nF
  (≈ 85 mA inrush, H4 b09), 10 µF bulk.
- **Indicators and sensors:**
  - Two red mic lights on MIC_VCC; red recording light on IO13.
  - LTR-303ALS-01 (U18, C364577) at 0x29, polled.
  - ST25DV04**KC**-IE6S3 (U19) at 0x53/0x57, GPO on IRQ; PCB coil (7 turns, 26 × 42 mm, ≈ 3.19 µH
    by H4 b08 — the footprint still has 9 turns until H6) with a fitted **12 pF C0G** (C62).
- **E-ink:** GDEY029T94 on an XUNPU **FPC-05F-24PH20** (J6, C2856805: 24P 0.5 mm flip-lock,
  bottom contact; project footprint from the XUNPU drawing) with the Good Display reference boost:
  - 47 µH inductor and Si1308EDL switch, with a 1 M gate pull-down.
  - 2.2 Ω sense resistor and 3 × MBR0530.
  - 4.7 µF charge pump, and 1 µF (50 V parts) on VSH1/VSH2/VSL/VGH/VGL/VCOM/VDD.
  - BS1 low (4-wire SPI).

## Checks (all run by `make build`)

1. **SKiDL ERC.** Result: 0 errors, 8 expected warnings: 5 open-drain outputs (/PGOOD, /CHG, MAX17048 ALRT, AW9523B INTN, ST25DV GPO) meeting an ESP32 GPIO, and the 3 free module pads IO3, IO9, IO46.
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

10. **Privacy** (`check_privacy`, H5): (a) no ESP32 GPIO has a DC path — through resistors,
    beads, net ties, switches and FET channels taken as closed, diodes only anode → cathode —
    into MIC_VCC, MIC_M, HS_MIC_F or HS_MIC; (b) MIC_VCC is fed by exactly one P-FET whose
    source is on MUTE pole A (common = MIC_F) and whose gate is pulled by an N-FET driven by
    HOOK; (c) no ESP32 pin sits on HOOK and every GPIO resistor to HOOK is ≥ 10 kΩ; (d) at least
    two LED + resistor pairs hang on MIC_VCC; (e) MIC_VCC carries ≤ 1 µF. Mutation-tested in H5:
    reversing D9 (IO10 could bias the mic) and reading HOOK through 1 kΩ with Q5 moved before
    MUTE each fail the build.

**The checks have been mutation-tested.** Each of these deliberate breakages made the build fail:
- swapping two GPIOs;
- flipping the GPIO45 strap;
- strapping LIS2DH12 SA0 low (before its removal in H5);
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
2. **Hall sensor:** DRV5032**AJ** (C266120, open drain, BOP ≤ 9.5 mT / BRP ≥ 3.0 mT) since H5 (owner D3, H4 b11: 3.3× margin both ways). The FA (20 Hz push-pull, C140921) had only 0.3× off-hook margin.
3. *(LIS2DH12 and its INT1 N-FET: removed in H5, owner D10.)*
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
   - (pre-H5: a 100 k bleed on the post-mute bias; since H5 MIC_VCC holds only 100 nF and the lights, which drain it);
   - 330 Ω LED-data series resistor and a LED_DATA (GPIO21) pull-down, to limit back-feed into an unpowered LED chain;
   - AW9523B RSTN pull-up;
   - 0 Ω D± links for EVT tuning.
10. **Hot-swap socket:** the Kailh **CPG151101S11-16** (C5156480) has had no stock since
    2026-09-27; since H5 the BOM carries the HanElectricity **CPG151101S11-2** (C49352235), whose
    drawing matches the Kailh body, holes and land (components/kailh-cpg151101s11.md; tin
    instead of gold contacts). Hand-sourced Kailh sockets fit the same footprint.
11. **Datasheet re-check 2026-09-27 (no change needed):** side-push VOL switches Alps SKRTLAE010 (C110293; alt
    K2-1114SA-A4SW-06, C136662); JST S3B-PH-SM4-TB is C265101; no 2N7002 is used (every
    3.3 V-driven N-FET is an AO3400A, C20917, logic-level).

## Assumptions and unverified items (also in `checks.txt`)

- **Pin maps:**
  - Handset jack PJ-31060: the HOOYA drawing numbers the terminals 1–6; their mapping to the
    KiCad PJ31060-I pad names (T/TN/R1/R1N/R2/S) and the plug-axis height are to be confirmed
    on a sample before layout freeze.
  - PTC SMD1812P200TF16: 40 °C hold-current derating taken from the 1206 family chart.
  - Red LED cathode mark (KiCad pad 1 = K).
  - MAX17048 exposed pad.
  - AW9523B exposed-pad land size.
  - C&K JS202011JAQN pole pinout, and whether it shares the JCQN land pattern.
- **GDEY029T94:** which pins get caps was read from a small reference drawing. The FPC contact side needs confirming against a sample.
- **Values to tune in EVT:**
  - speaker EMI; the NFC tuning cap (12 pF);
  - handset mic PGA gain (≈ 18 dB) and earpiece level with the Opis 60s Micro and a generic
    handset (their electrical data are not published: b04/b07 assume typical values).
- **Stock:** BQ24074RGTR (second source BQ24073RGTR) and SWPA4020S470MT are the thin lines.
- **SK6812MINI-E minimum VDD is 3.7 V.** On battery, VSYS can fall below that; firmware should blank the LEDs below ~3.7 V.
- **Debug:** the ESP32-S3 has no SWD. Flashing and the console use the native USB (USB-Serial-JTAG) on the power USB-C port (H5). Pad JTAG (GPIO39–42) carries the e-ink control and SPI lines, so there is no external JTAG header. Recovery is UART download mode through the U0TXD/U0RXD + GPIO0 + EN pads. Production eFuses (DESIGN.md §10.1) disable USB-JTAG but keep secure USB download.

## What's left

Layout is code too, in `hardware/layout/` (see [LAYOUT.md](LAYOUT.md)); the H3 placement predates H5 and is redone in H6 (the jack, the privacy chain and the removed blocks). The project
footprints (hot-swap socket, NFC coil, e-ink FPC connector; the electret footprint is unused since H5) live in
`layout/footprints/openloungephone.pretty`. Passives are 0603 by default (hand-solderable; see [ASSEMBLY.md](ASSEMBLY.md)).

1. **Mechanical integration:** the product enclosure and hook rest (not designed yet; the
   prototype box is `enclosure/proto_box.py`).
2. **Before layout freeze:** close the unverified items above.
