# H4: circuit simulation (ngspice testbenches)

Phase H4 of the hardware process (retargeted in H5, 2026-09-30): eleven testbenches (ten requested plus the hook-field analysis) with automatic PASS/FAIL checks against the
requirement IDs in [../REQUIREMENTS.md](../REQUIREMENTS.md) (and the layout checklist
[../BOARD_REQUIREMENTS.md](../BOARD_REQUIREMENTS.md)). The schematic changes they call for are
ranked in [FINDINGS-H4.md](FINDINGS-H4.md), the input to H5. Nothing here changes the schematic
or the board. License CERN-OHL-S-2.0 like the rest of `hardware/`.

```sh
cd hardware
make sim            # all benches -> build/sim/report.md (git-ignored) + the table below
make sim VENDOR=1   # also the TI switching-model smoke test (slow, ~10 min)
.venv/bin/python sim/run.py b05 b06   # a subset (does not touch this README)
```

**Simulator (owner decision 2026-09-30): ngspice.** `sim/spice.py` uses the `ngspice` command
line when it is on `PATH` (`brew install ngspice`), else the `libngspice` that KiCad ships
(`KiCad.app/Contents/Frameworks/libngspice.0.dylib`, ngspice 45.2, with its XSPICE code models
loaded by hand), in PSpice-compatible mode (`ngbehavior=psa`). Each run is a subprocess; the
netlists, logs and raw data land in `build/sim/<bench>/`.

**Verdicts.** Every bench reports two verdicts: **H5** (the schematic as built in H5; the check scope is
still called `proposal`) and **pre-H5** (the H3 schematic, the before/after record). Checks carry a scope: `both`,
`current`, `proposal` or `alt` (an alternative rejected on this data, shown for the record).
`make sim` exits 1 if an H5 (`proposal`/`both`) check fails, so a regression is loud; pre-H5
FAILs are the expected before/after evidence.

## Models and their provenance

| Part | Model used | Source / licence |
|---|---|---|
| LP5907-3.0 | **TI vendor model** SNVMAP8 rev A (unencrypted PSpice), VSWITCH → ngspice `SW` rewrite | https://www.ti.com/lit/zip/snvmap8 — "(C) TI, all rights reserved", no redistribution grant → **downloaded at run time**, SHA-256 pinned (`models/vendor.py`) |
| TLV62569 | averaged current-mode model `CONV_AVG`, calibrated to SLVSDG1C Fig. 18 | TI SLVMBW3 / SLVMC19 (TLV62569P) were tried: in ngspice 45.2 both stop switching during soft start (output stalls at 0.5–0.9 V); smoke test kept behind `VENDOR=1` |
| TPS61023 (unused since H5) | `CONV_AVG` in boost mode | TI SLVMD68 rev A tried: never leaves shutdown in ngspice (enable/UVLO block); same licence as above |
| SN74LV1T125 | **TI vendor model** SCLM183 rev 2.0 (b09: LED data levels at VSYS 4.4 / 3.7 V) | https://www.ti.com/lit/zip/sclm183 — same TI licence → downloaded at run time |
| BQ24074 | behavioural `BQ24074_BEH` | TI lists no model; built from SLUS810N p8, p12, p19 |
| SY6280 (unused since H5) | behavioural `SY6280_BEH` | AN_SY6280 rev 0.1 p1–p5 |
| NS4150B | behavioural `NS4150B_BEH` | Nsiway V1.1 p3, p7 |
| KT-0603R LED, SMF5.0A | diode fits (min/typ/max VF corners; BV/RS) | KENTO A.0 p3; Littelfuse SMF p2 |
| AO3401A | level-1 PMOS fit + Ciss/Crss | AOS rev 3.1 p1–p2 |
| Handset electret, ES8311 input, 1N4148W, AO3400A/AO3401A, 32 Ω receiver, speaker, NFC coil | current source / 6 kΩ / standard 1N4148 / level-1 fits / 32 Ω + 20 µH / 8 Ω + 40 µH / RLC from geometry | per-bench provenance in the report |

Our own models are in `models/olp_behavioural.lib` (CERN-OHL-S-2.0); every parameter cites its
datasheet page in a comment. Vendor files are never committed.

## Benches

| # | Bench | Requirements | Method |
|---|---|---|---|
| b01 | USB-C → BQ24074: start-up, hot-plug, input limit, VSYS with/without the pack, PTC | HW-ELEC-03/-04/-05/-10/-11, HW-FUNC-13, HW-SAFE-03 | transient, behavioural charger |
| b02 | TLV62569 3V3: Wi-Fi burst step, ESP32 window, eFuse-burn limit, ripple, divider options | HW-ELEC-07/-08/-24, HW-PRIV-06 | averaged model + analytic corners |
| b03 | LP5907 3V0: PSRR, load step, C_OUT window, noise | HW-ELEC-09/-13 | TI model (AC + transient) |
| b04 | handset jack (H5): earpiece drive, hook-gated earpiece switch, pop, mic bias, button/OMTP/insertion sense, GPIO cannot feed the mic | HW-FUNC-06/-18, HW-ELEC-17/-26/-27, HW-PRIV-03 | AC + transient + analysis |
| b05 | privacy chain (H5): mute AND hook → handset-mic supply → two lights; corners, mute/hang-up transients, single-fault FMEA, IO17/IO10 driven high | HW-PRIV-01/-02/-03, HW-FUNC-09/-11, HW-ELEC-13 | DC corners + transient |
| b06 | NS4150B into 8 Ω: ringer SPL, prompt level (no speakerphone since H5), clipping, VSYS droop | HW-ELEC-14/-05/-10, HW-FUNC-04 | analysis + transient |
| b07 | handset electret into the ES8311 (H5): response, RF filter, A-weighted SNR, board degradation | HW-ELEC-13/-09, HW-FUNC-06 | AC transfer functions + noise integral |
| b08 | NFC coil: L from geometry, resonance with C_TUN, tuning cap, sensitivity | HW-FUNC-07, HW-MECH-08 | partial-inductance calc + RLC AC |
| b09 | LED power switch: inrush, VSYS dip, SK6812 PWM load | HW-FUNC-02, HW-ELEC-05/-10/-11 | transient |
| b10 | battery life, 8 h idle + 1 h talk on 700 mAh | HW-ELEC-06, HW-FUNC-13 | analysis script |
| b11 | hook magnet field vs DRV5032 BOP/BRP, ≥ 2× margin (decision 3) | HW-FUNC-08, HW-PRIV-03, HW-MECH-07 | analysis script |

Assumptions that move results (all listed per bench in the report): MLCC DC-bias derating (typical
class-II values; Samsung's curves were not reachable), the Wi-Fi step (0 → 500 mA at 1 A/µs), the
LED visibility floor (0.2 mA), the speaker's free-field sensitivity, the handset's 100 mA, and the
ESP32 idle current on battery.

## Results

**H5 (2026-09-30):** every bench passes for the H5 schematic and `make sim` exits 0. b04 (handset
jack: earpiece level and hook gate, mic bias, button/OMTP and insertion sense, no GPIO path into
the mic), b05 (privacy chain: mute AND hook, two lights, FMEA, IO17/IO10 driven by firmware) and
b07 (handset electret into the ES8311) replace the USB-port, base-mic and ES7210 benches. **Honest
limits of b07:** it passes (57.8 dBA at PGA 18 dB) only with an *assumed typical* handset capsule
(−42 dBV/Pa, 58 dBA — the Opis 60s Micro publishes nothing) and Everest's qualitative PGA-noise
statement; at PGA 0 dB it is 53.8 dBA, and a 55 dBA capsule would cap it near 53 dBA whatever the
board does, which is why HW-ELEC-13 also asks that the board take ≤ 1.5 dB from the capsule (it
takes 0.7 dB). The "pre-H5" column keeps the H3 schematic's failures as the before/after record
(`n/a` where the circuit no longer exists). Engine: KiCad's libngspice 45.2.

<!-- RESULTS -->
Last full run: 2026-09-29, ngspice-45.2 shared library.

| Bench | H5 | pre-H5 | Key results |
|---|---|---|---|
| b01 USB-C → BQ24074 power path: start-up, hot-plug, input limit, VSYS | **PASS** | FAIL | VSYS min, worst capped load, no pack, 4.75 V source (proposed caps): 3.96 V; PTC current, uncapped load + charging, ILIM max corner (current: 1206 1.5 A): 1.56 A |
| b02 TLV62569 3V3 buck: Wi-Fi load step, ESP32 window, eFuse limit, ripple | **PASS** | FAIL | [proposed 3.19 V: 105k/24.3k 0.1 %] worst low at the module: VFB min corner − droop − ripple/2: 3.022 V (droop 101 mV); [proposed 3.19 V: 105k/24.3k 0.1 %] worst high while burning eFuses: VFB max corner + PSM ripple: 3.287 V; [proposed 3.19 V: 105k/24.3k 0.1 %] worst high after the 500→50 mA release: 3.354 V |
| b03 LP5907 3V0 analog rail: PSRR, load step, C_OUT window, noise | **PASS** | FAIL | PSRR at 100 Hz: 82.0 dB; PSRR at 1 kHz: 79.0 dB |
| b04 Handset jack: earpiece drive and hook gate, mic bias, button and insertion sense | **PASS** | n/a | earpiece at DAC full scale, 1 kHz: voltage, power, level (assumed receiver): 0.258 Vrms, 2.08 mW → 98.2 dB SPL; on-hook: earpiece level while the speaker rings at DAC full scale (switch open): -51.9 dB → 46 dB SPL at the receiver; MIC_SENSE (IO10): mic present vs button pressed / OMTP plug: mic ≥ 1.37 V, button/OMTP ≤ 0.01 V; IO10 driven high with the mic supply off: current pushed into the mic line: 303 pA |
| b05 Privacy chain: mute AND hook -> handset-mic supply -> two mic lights | **PASS** | FAIL | worst supply at the handset capsule (unmuted, off-hook): 1.54 V; hang-up: time the mic is live (≥ 1.0 V) with both lights dark: 30 µs; on-hook, IO17 driven high through 47 kΩ (AO3400A VGS(th) 0.65 V corner): HOOK 20.5 mV, capsule 885 pV |
| b06 NS4150B class-D into 8 Ω: ringer SPL, prompt level, clipping, VSYS droop | **PASS** | FAIL | [proposed R_IN 68 kΩ] VCC 4.3 V: max clean power → ringer SPL at 1 m (−3 dB unit): 1.00 W → 77.0 dBA |
| b07 Handset mic into ES8311: response, RF filter, A-weighted SNR | **PASS** | n/a | analog path response 100 Hz–7 kHz, re 1 kHz: -0.01 … +0.12 dB; SNR at 94 dB SPL, 1 kHz, A-weighted: PGA 18 dB, ES8311 ADC SNR typ: 57.76 dBA (mic 7.1, ADC 1.62 input-referred, board 0.52 µVrms) |
| b08 NFC coil: inductance from geometry, resonance with ST25DV, tuning, sensitivity | **PASS** | FAIL | current schematic, 9 turns: resonance with no external cap (C_TUN 28.5 + 2.5 pF self): 13.47 MHz; [proposed] 7 turns: L, resonance spread without C78, nominal C78 for 13.56 MHz: 3.19 µH, 14.81–17.43 MHz, C78 ≈ 12.2 pF |
| b09 LED power switch: inrush, VSYS dip, SK6812 PWM load | **PASS** | FAIL | VSYS dip when the LED rail switches on (current): 1.29 V; VLED inrush peak (proposed): 84.9 mA |
| b10 Battery life: 8 h idle + 1 h talk on a 700 mAh pack (analysis) | **PASS** | FAIL | budget as written (DESIGN §9.2 idle, LED rail on): idle 199 mW, talk 669 mW: 8 h + 1 h needs 2.26 Wh; idle after 1 h talk 7.7 h; proposed battery policy (LED rail off, Wi-Fi power save): idle 58 mW, talk 578 mW: 8 h + 1 h needs 1.04 Wh; idle after 1 h talk 27.9 h |
| b11 Hook magnet vs DRV5032 thresholds (≥ 2× margin both ways) | **PASS** | FAIL | DRV5032AJ (proposed), Ø3×1.5 N35, 10 mm travel: on-hook / off-hook margins: on 31.1 mT → 3.3×, off 0.91 mT → 3.3× |
<!-- /RESULTS -->
