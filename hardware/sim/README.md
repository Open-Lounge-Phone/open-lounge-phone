# Simulation (ngspice)

One bench for the minimal board (M1, 2026-09-30): the only circuit on it whose margins are worth
simulating is the 3.3 V supply. The old eleven benches (charger, buck, analog LDO, handset
privacy chain, speaker amp, NFC coil, LED rail, battery, hook magnet) went with the parts they
tested; git history keeps them. License CERN-OHL-S-2.0 like the rest of `hardware/`.

```sh
cd hardware
make sim            # all benches -> build/sim/report.md (git-ignored) + the table below
```

**Simulator: ngspice.** `sim/spice.py` uses the `ngspice` command line when it is on `PATH`
(`brew install ngspice`), else the `libngspice` that KiCad ships, in PSpice-compatible mode.
Each run is a subprocess; netlists, logs and raw data land in `build/sim/<bench>/`. `make sim`
exits 1 if a check fails.

## b01: 3V3 LDO (SGM2212-3.3)

| Check | Why |
|---|---|
| 3V3 reaches 3.0 V before the EN RC (10 k / 1 µF) releases the ESP32 | WROOM-1 datasheet v1.8 p14: rails stable before EN rises |
| no 3V3 overshoot above 3.6 V at USB hot-plug (5 V source, 0.3 Ω / 1 µH cable) | VDD33 3.0–3.6 V, p27 |
| 3V3 at the module stays in 3.0–3.6 V during a 60 → 400 mA Wi-Fi TX burst at VBUS 4.40 V | TX peak 355 mA, p28; lowest USB voltage at a device |
| LDO headroom during the burst ≥ the 380 mV max dropout | SGM2212 p6 |

**Model.** SG Micro publishes no SPICE model, so `models/olp_behavioural.lib` has a behavioural
`SGM2212_BEH`: output 3.251–3.349 V (p5), dropout as 0.76 Ω (380 mV at 500 mA, p6), current
limit 0.81 A (p6), and a transconductance loop calibrated on the p7 load-transient plot (~160 mV
for ~800 mA → GM ≈ 5 A/V) with one assumed 300 kHz pole. The pessimistic corner halves GM and
puts the pole at 100 kHz. It checks supply margins, not loop stability (the datasheet's
ceramic-capacitor guidance on p4/p10 covers that).

<!-- RESULTS -->
Last full run: 2026-09-29, ngspice-45.2 shared library.

| Check | Value | Limit | Verdict |
|---|---|---|---|
| b01: 3V3 inside 3.0 V before EN releases the chip | 3V3 at 77.8 µs, EN at 13.9 ms | 3V3 first (tSU >= 0, WROOM-1 p14) | PASS |
| b01: 3V3 overshoot at hot-plug | 3.442 V | <= 3.6 V | PASS |
| b01: 3V3 at the module during a 60 mA -> 400 mA burst, VBUS 4.40 V, GM 5 A/V, loop pole 300 kHz | 3.184-3.308 V | 3.0-3.6 V | PASS |
| b01: LDO headroom during the burst (VIN - 3V3) | 1157 mV | >= 380 mV (dropout max at 500 mA, p6) | PASS |
| b01: 3V3 at the module during a 60 mA -> 400 mA burst, VBUS 4.40 V, GM 2.5 A/V, loop pole 100 kHz | 3.128-3.365 V | 3.0-3.6 V | PASS |
<!-- /RESULTS -->
