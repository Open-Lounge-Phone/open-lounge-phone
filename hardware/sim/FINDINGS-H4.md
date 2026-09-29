# H4 findings: schematic changes for H5 (ranked)

Status: 2026-09-30, from the ngspice benches in this folder (results: [README.md](README.md),
full report: `build/sim/report.md` after `make sim`) and the owner decisions of 2026-09-30
recorded in [../REQUIREMENTS.md](../REQUIREMENTS.md) §0. **This is the input to H5.** Nothing has
been changed in the SKiDL schematic or the board. Each item names the bench that proves it, the
requirement IDs and the H2 finding it closes ([../components/FINDINGS.md](../components/FINDINGS.md)).

Severity as in H2: **High** breaks a promised guarantee, a core function or production locking;
**Medium** out of a datasheet limit or likely to fail a test; **Low** margin or verification.
LCSC codes were looked up on JLCPCB/LCSC on 2026-09-29; every new code still goes through
`make lcsc` in H5.

## Ranked change list

| # | Sev | Change (values, parts) | Why (bench result) | Req. | Closes |
|---|---|---|---|---|---|
| P-01 | **High** | **Mic supply and privacy light, parallel fallback (decision 1).** Remove Q1 (MMBT3904), its 22 k/100 k base divider, the 470 Ω from 3V3 and the 100 k bleed. New chain: 3V0 → 100 Ω → 10 µF (**the RC filter moves in front of the MUTE switch**) → MUTE pole A → **MIC_VCC** (100 nF) → two KT-0603R LEDs, each with its own **1 kΩ** to GND, side by side under the mic-light pipe → 2.2 kΩ → electret. ES7210 MICBIAS12 is no longer used (keep its 1 µF, pin otherwise open). | b05: a red LED **in series** leaves only **0.89 V** at the electret (needs ≥ 1.5 V, GMI6027 p2) at the VF-max/0 °C corner, so the approved fallback applies. Parallel: ≥ **2.65 V** at the capsule, **≥ 0.71 mA** per LED in every corner, one open LED leaves the other at 0.77 mA; opening MUTE darkens light and mic together (mic live with the light off: 0.24 ms; capsule < 0.5 V after 0.96 ms). | HW-PRIV-01, -02, HW-FUNC-09, -11 | F-09 |
| P-02 | **High** | **Recording light (decision 1):** a second, separate red 0603 LED (KT-0603R, C2286, basic) + 680 Ω from **GPIO13** (free, not a strap) to GND, under its own light hole, away from the mic light. | security-model trust signal #2; the board has none today. | HW-PRIV-05, HW-FUNC-11 | F-09 |
| P-03 | **High** | **Handset port power (decisions 2, 5).** Remove D8/D9 (B5819W diode-OR) and feed the port from a **TPS61023DRLR** boost (C919459, SOT-563) on **VSYS**: 1 µH inductor (I_sat ≥ 4.5 A, choose in H5), 10 µF in, 22 µF 0805/25 V out, FB **820 kΩ / 110 kΩ 1 %** (5.03 V). Boost EN and SY6280 EN both from one **SN74LVC1G08DBVR** (C7666) AND gate: A = HOOK (DRV5032 output, high = off-hook), B = **HS_MODE** (GPIO3, existing 100 kΩ pull-down). SY6280 input cap 1 µF → **10 µF**; R_SET 15 kΩ → **13 kΩ** (0.39–0.65 A). | b04: VBUS **5.02 V** in a call on USB and on a 3.3 V battery (today: 4.2–4.6 V on USB, **2.8 V** on battery); **0 V** at boot with GPIO3 floating; **34 mV** 3 ms after hang-up; a short folds back to 0.26 A; **0 A** pushed into a PC that drives the port. | HW-PRIV-03, HW-ELEC-19, -06, -17, HW-FUNC-06, HW-SAFE-03 | F-04, F-05 |
| P-04 | **High** | **Flashing without the CH340C (decision 4).** Add an **FSUSB42MUX** USB 2.0 switch (C11355, MSOP-10, hand-solderable; VCC 3V3): common = ESP32 IO19/IO20; port 1 = power USB-C J1 D+/D− (after D1 and the 0 Ω links), port 2 = handset J7 D+/D− (after D7). **SEL = HS_MODE (GPIO3)**: low (reset, boot, download mode) = power port → USB-Serial-JTAG device for flashing/console with any C-to-C cable (J1 keeps its Rd); high = handset port (host). Remove U16 (CH340C), Q5/Q6 and their resistors; keep the U0TXD/U0RXD/EN/BOOT pads for recovery. Because the same GPIO3 feeds the AND gate, the handset VBUS is off whenever the data path is on the power port — in hardware. | b04 boot-state checks; WROOM-1U datasheet v1.8 p13-14 (GPIO3 floats at reset; USB-Serial-JTAG download on IO19/20). Firmware: switch to the handset only when no host enumerates on J1. | HW-FUNC-15, HW-PRIV-06, -03 | F-01, F-23 (−3 extended lines) |
| P-05 | **High** | **3V3 set point (decision 6 as intended).** FB **105 kΩ / 24.3 kΩ, 0.1 % thin film** (3.19 V nominal; codes in H5). Stay inside TI's verified output range: 22 µF at the buck + 22 µF at the module (drop one of the two 22 µF at the buck: 44 µF nominal ≤ 47 µF). | b02: 3.30 V nominal (as worded) reaches **3.45 V** at the VFB-max corner in power-save — over the **3.3 V eFuse-write limit** (ESP32-S3 datasheet v2.2 p64, Table 5-2 note 3) whatever the resistors. With 1 % resistors no set point satisfies both ends (3.15 V → 2.94 V worst low). 3.19 V with 0.1 %: worst low **3.022 V** under a 500 mA Wi-Fi step (≥ 3.0 V, WROOM p27), worst high while burning eFuses **3.287 V**, ≤ 3.36 V after the load release. | HW-ELEC-07, -08, -24, HW-PRIV-06 | F-03, F-19 |
| P-06 | **High** | **Hook sensor (decision 3):** DRV5032FA → **DRV5032AJDBZR** (C266120, SOT-23, same pinout; open-drain → add a **100 kΩ pull-up** on HOOK to 3V3, plus 100 Ω series + 1 nF to GND at U10 against ESD from the metal post, BOARD_REQUIREMENTS BR-ESD-05). Keep the Ø3 × 1.5 mm N35 magnet; plunger travel 8 → **10 mm** (enclosure). | b11: AJ (BOP ≤ 9.5 mT, BRP ≥ 3.0 mT, SLVSDC7H p6) gives **3.3×** on-hook and **3.3×** off-hook margin with ±0.3 mm stack-up (FA today: off-hook margin **0.3×**). | HW-FUNC-08, HW-PRIV-03, HW-MECH-07 | F-26 |
| P-07 | Medium | **Input PTC:** SMD1206P150TFT → **SMD1812P200TF16** (C20812, 1812, 2 A hold / 4 A trip, 16 V; 29.9 k at JLC). | b01: the charger's ILIM-max corner draws **1.56 A** through the PTC (hold only 1.34 A at 40 °C). The 1812 part's 40 °C hold ≈ 1.78 A (derating assumed equal to PTTC's 1206 chart: UNVERIFIED, confirm in H5). | HW-ELEC-04, HW-SAFE-03 | F-07 |
| P-08 | Medium | **VSYS capacitance:** C46 100 µF/1206 → **22 µF 0805/25 V**; the amp's 10 µF → **1 µF** (NS4150B p7 asks 1 µF); BQ24074 OUT 2 × 10 µF → **1 × 10 µF**. Total 44.5 µF nominal. | b01: 141.5 µF → 44.5 µF (≤ 47 µF, SLUS810N p8); start-up 0.39 ms; VSYS ≥ **3.83 V** under the worst capped load at the 4.75 V / ILIM-min corner without a pack; 1 ms-average input ≤ 0.90 A. | HW-ELEC-10, -05 | F-11 |
| P-09 | Medium | **LED power switch soft start:** add **47 kΩ** between Q3's drain and Q2's gate and **4.7 nF** gate–drain (VLED) on Q2; VLED bulk C61/C62 2 × 22 µF → **1 × 10 µF** (plus the 13 × 100 nF at the LEDs). | b09: today the rail switches on with a **≈ 26 A** inrush and a **1.29 V** VSYS dip (buck/amp brown-out risk). Proposed: **85 mA**, 1.7 mV dip, 0.16 ms rise; VLED ≥ 4.32 V with all LEDs at the 30 % cap; LED data (TI SN74LV1T125 model) meets VIH at VSYS 4.4 and 3.7 V. | HW-FUNC-02, HW-ELEC-10, -05 | (new) |
| P-10 | Medium | **Speaker gain (decision 9):** R35/R36 150 kΩ → **68 kΩ** (A_V 3.5); firmware caps the ringer at 1 W. Speaker: an 8 Ω, ≥ 86 dB/1 W/0.5 m part such as **Soberton SP-2040** (20 × 40 mm) — it is **8.4 mm deep**, so the proto box's ≤ 5 mm speaker rule must grow or a thinner part be found. | b06: 150 kΩ gives only 0.26 W → **71 dBA** at 1 m (worst unit); 68 kΩ reaches the 1 W cap → **77 dBA** (≥ 75); speakerphone 83 dBA at 0.5 m; VSYS stays ≥ 4.12 V while ringing without a pack. On a 3.3 V battery the ringer drops to 74.5 dBA (clipping). | HW-ELEC-14, HW-FUNC-04 | F-06 |
| P-11 | Medium | **NFC coil:** 9 → **7 turns** (same 26 × 42 mm, 0.3/0.3 mm; ≈ 3.19 µH) and **fit** C78 as a **12 pF C0G** (trim in EVT). | b08: 9 turns = 4.50 µH → 13.47 MHz with no cap and a corner spread down to 12.46 MHz — a parallel cap can only tune *down*, so some boards could never reach 13.56 MHz. 7 turns spans 14.81–17.43 MHz untuned; 12 pF brings the nominal to 13.56 MHz. | HW-FUNC-07 | F-18 |
| P-12 | Medium | **3V0 capacitance:** remove the 10 µF on 3V0 (keep 1 µF at the LDO + the codec pins: 4.1 µF nominal). | b03: 14.1 µF nominal > 10 µF max (SNVS798Q p6); PSRR with the TI model 82 dB at 100 Hz, 79 dB at 1 kHz; the 1 → 25 mA step stays within 2.993–3.007 V. | HW-ELEC-09 | F-08 |
| P-13 | Low | **Remove the accelerometer (decision 10):** U12 (LIS2DH12), Q4, its 100 kΩ and caps. | stock 0; no software use. | HW-FUNC-17, HW-MFG-03 | F-16 |
| P-14 | Low | **Mic SNR margin:** keep the circuit; set the ES7210 PGA ≥ 12 dB in firmware and measure in EVT. If EVT misses 55 dBA, move to a reflowable analog MEMS mic with ≥ 63 dBA SNR (owner decision; also closes F-25). | b07: **54.97 dBA** at 94 dB SPL with PGA 0 dB and typical ADC noise (mic 7.2 µV, ADC 7.2 µV); response flat (−0.01…+0.08 dB, 100 Hz–7 kHz), 19 Hz corner, 3V0 noise 0.21 µV. | HW-ELEC-13 | — |
| P-15 | Low | **power_budget.yaml / checks:** the handset moves from `vbus_direct` to a VSYS load through the boost (≈ 126 mA from VSYS at 100 mA/5 V, ≈ 0.85 A worst at the 0.65 A limit); the ringing row follows the 1 W cap (≈ 600 mA at the input, b06). | b01/b04/b06 numbers. | HW-ELEC-05 | — |

## Firmware duties that the benches assume (not schematic changes)

- Refuse to enable the handset VBUS when `HS_VBUS_SENSE` ≥ 1 V (a foreign source on the port).
- Keep HS_MODE low (power port, device mode) until no host enumerates on J1.
- Ringer ≤ 1 W; LEDs ≤ 30 % on a ≥ 1.5 A source; blank the LEDs when VSYS < 3.7 V.
- On battery: LED rail off except during events, Wi-Fi power save (b10 needs ≤ **137 mW** average
  idle to meet 8 h idle + 1 h talk; the DESIGN §9.2 idle of 199 mW fails with 2.79 Wh > 2.20 Wh).
- Battery cut-off ≥ 3.3 V (3V3 stays in regulation down to VSYS ≈ 3.28 V at 500 mA, b02).

## Not settled by simulation (owner)

1. **Decision 6 wording:** "3.30 V nominal" cannot meet "worst case ≤ 3.3 V" (b02). Proposed:
   3.19 V with 0.1 % resistors (or 3.30 V plus a production fixture that lowers 3V3 while burning).
2. **Mic SNR (P-14):** accept firmware PGA + EVT, or switch to a MEMS mic now.
3. **Speaker depth (P-10):** the SP-2040 is 8.4 mm; the proto box allows 5 mm.
4. **Antenna (decision 7):** no part with a published "monopole" type *and* ≤ 2.33 dBi was
   confirmed in this pass. Candidate: the Molex 204281 family (adhesive flex, 1.4–2.2 dBi at
   2.4 GHz, > 60 % efficiency, DigiKey/Mouser; Molex part data 2042811200) — its antenna type and
   an I-PEX MHF I variant must be confirmed before H5 (REQUIREMENTS §0).
5. **Vendor switching models:** TI's TLV62569, TLV62569P and TPS61023 models do not run in ngspice
   45.2, so averaged models are used; a cross-check in TI's PSpice-for-TI is possible if wanted.
