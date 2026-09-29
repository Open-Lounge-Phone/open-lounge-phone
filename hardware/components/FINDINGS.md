# H2 findings: discrepancies, risks and required changes

Status: 2026-09-29, from the H1 requirements ([../REQUIREMENTS.md](../REQUIREMENTS.md)) and the
H2 part files in this folder. **Input for H5** (schematic/board changes). Nothing here has been
changed in the schematic or the board. Each finding names the requirement(s) it affects and the
part file(s) with the evidence and datasheet pages.

Severity: **High** — breaks a promised guarantee, a core function, production locking, or
certification/safety as designed. **Medium** — out of a datasheet limit or likely to fail a test,
fixable with a small change. **Low** — margin, documentation or verification gap. **Info** — no
change needed, recorded for traceability.

## H5 status (2026-09-30): what the schematic revision did with each finding

H5 built the schematic to the H4 change list and to the owner's second batch of decisions
(REQUIREMENTS.md §0 D14–D21: analog 3.5 mm handset jack, no base mic or speakerphone, privacy
chain on the handset mic). Evidence per requirement: [../SCHEMATIC_REVIEW.md](../SCHEMATIC_REVIEW.md).

| Finding | H5 status |
|---|---|
| F-01 flashing path | **closed** — native USB goes straight to the power USB-C (D14), no switch, no CH340C |
| F-02 antenna type | **documented** — general-purpose U.FL/IPEX antenna, same type and ≤ 2.33 dBi to keep the grant (D19); the shipped part is still to pick (owner) |
| F-03 3V3 vs eFuse limit | **closed** — 105 k / 24.3 k 0.1 % → 3.19 V (D17, b02) |
| F-04 handset powered on hook | **closed differently** — no handset VBUS; the handset **mic** supply is MUTE AND hook in hardware (D16, b05, `check_privacy`) |
| F-05 handset VBUS range | **N/A** — no USB handset (D14) |
| F-06 speaker power | **closed** — R_IN 68 kΩ, SP-2040 (b06: 77 dBA) |
| F-07 PTC | **closed** — SMD1812P200TF/16, 1.80 A hold at 40 °C (Ruilon p6) |
| F-08 3V0 capacitance | **closed** — 2.1 µF |
| F-09 mic light / recording light | **closed** — two lights on MIC_VCC, recording light on IO13 (b05 FMEA) |
| F-10 battery connector / TS | open (pack spec, silkscreen: H6/BOM notes) |
| F-11 VSYS capacitance | **closed** — 44.5 µF |
| F-12 FPC land | open (sample) |
| F-13 metal hook post ESD | **partly** — 100 Ω + 1 nF RC on HOOK; post grounding is layout/enclosure (H6) |
| F-14 AEC divider | **N/A** — no AEC reference (D15) |
| F-15 MUTE_SENSE polarity | open (sample) |
| F-16 LIS2DH12 stock | **closed** — removed (D10) |
| F-17 ST25DV NRND | **closed** — ST25DV04KC-IE6S3 |
| F-18 NFC coil | **closed by analysis** — 7 turns + 12 pF (footprint in H6, VNA in EVT) |
| F-19 3V3 capacitance | **closed** — 22 + 22 µF |
| F-20 I2C rise time | **improved** — two fewer devices (ES7210, LIS2DH12); still measure or run 100 kHz |
| F-21 removable plunger/magnet | **closed for the proto box** — captive sleeve/plunger/retainer (`make proto`); product enclosure open |
| F-22 PROTO_BOX.md stale | **closed** |
| F-23 extended lines | open — 34 (was 35) vs ≤ 25 (owner question) |
| F-24 stock | **partly** — socket alternate in the BOM; BQ24074 / SWPA4020S470MT alternates listed |
| F-25 assembly (electret iron-only, MSL) | **closed** for the electret (removed); MSL notes stay |
| F-26 off-hook margin | **closed** — DRV5032AJ + 10 mm travel (b11) |
| F-27 0x2D, stale comment | **closed** |
| F-28 LED polarity | open (assembly check, now 3 LEDs) |
| F-29 electret orientation | **N/A** — removed |
| F-30 MUTE covers only the base mic | **closed** — MUTE now cuts the only mic (the handset's) |
| F-31 module/LED temperature | info, unchanged |

## Owner decisions 2026-09-30 and H4 results (resolved)

The owner answered the questions at the end of this file on 2026-09-30 (full wording:
[../REQUIREMENTS.md](../REQUIREMENTS.md) §0). H4 ([../sim/](../sim/README.md)) simulated each
one; the resulting schematic changes are P-01 … P-15 in [../sim/FINDINGS-H4.md](../sim/FINDINGS-H4.md).

| Finding | Decision (2026-09-30) | H4 evidence | H5 change |
|---|---|---|---|
| F-09 | D1: mic light **in series** with the mic supply, **two parallel LEDs** as fallback; separate red recording LED on its own GPIO | b05: series leaves 0.89 V for the electret (< 1.5 V) → **parallel fallback taken**; one open LED leaves the other lit; MUTE darkens light and mic together | P-01, P-02 |
| F-04 | D2: handset VBUS = hook sensor **AND** GPIO | b04: 0 V at boot, 34 mV 3 ms after hang-up | P-03 |
| F-26 | D3: ≥ 2× magnetic margin both ways | b11: **DRV5032AJ** + 10 mm travel → 3.3× / 3.3× (FA: 0.3× off-hook) | P-06 |
| F-01 | D4: USB 2.0 analog switch, power port by default and at boot | FSUSB42MUX, select = HS_MODE (also gates the handset VBUS) | P-04 |
| F-05 | D5: 5 V boost (TPS61023-class) for the handset port | b04: 5.02 V at the port on USB and on a 3.3 V battery | P-03 |
| F-03 | D6: 3V3 at 3.30 V nominal, ≤ 1 % resistors, worst case ≤ the eFuse limit | b02: **3.30 V nominal cannot meet ≤ 3.3 V** at the VFB-max corner (3.45 V); 3.19 V with 0.1 % resistors does (3.022–3.287 V) — **owner to confirm** | P-05 |
| F-02 | D7: same antenna type as certified (monopole), ≤ 2.33 dBi, JLC/DigiKey part | candidate Molex 204281 (1.4–2.2 dBi); type + MHF I variant to confirm | enclosure / BOM |
| F-21 | D8: captive plunger and magnet (HW-MECH-09); D11: toy standards as design intent, not certified | — | enclosure |
| F-06 | D9: ringer ≥ 75 dBA at 1 m, speakerphone ≥ 70 dBA | b06: R_IN 68 kΩ → 77 dBA (150 kΩ: 71 dBA) | P-10 |
| (HW-ELEC-06) | D9: battery ≥ 8 h idle + 1 h talk (700 mAh) | b10: needs ≤ 137 mW average idle (firmware power policy) | firmware |
| F-16 | D10: drop the LIS2DH12 | — | P-13 |
| (handsets) | D12: Native Union POP + one generic USB-C handset | — | EVT |
| (tooling) | D13: ngspice | `make sim` (ngspice CLI or KiCad's libngspice) | — |

H4 also closed or re-ranked: **F-07** (b01: charger ILIM max 1.56 A > PTC hold 1.34 A at 40 °C →
SMD1812P200TF16, P-07), **F-08** (b03, P-12), **F-11** (b01: 44.5 µF VSYS, P-08), **F-18**
(b08: the 9-turn coil resonates at 13.47 MHz and can reach 12.46 MHz — a cap only tunes down →
7 turns + 12 pF, P-11), **F-19** (b02, P-05), and found one new problem: the LED power switch
has a ≈ 26 A inrush and a 1.29 V VSYS dip (b09 → P-09).

## Ranked findings

| # | Sev | Finding | Req. | Evidence | Proposed change (H5) |
|---|---|---|---|---|---|
| F-09 | **High** | **Mic light is not fail-safe, and there is no recording light.** Today the red LED is fed from 3V3 and *sunk* by an NPN that senses the post-mute bias. If the LED or its resistor opens (or Q1 fails open), the mic stays powered with the light off — the security-model promise "if the light is off, the mic is unpowered" does not survive a single fault. The queued change ("power the light from the mic's supply") must not hang 1–2.5 mA on the ES7210 MICBIAS pin without data: the datasheet gives **no MICBIAS voltage or current capability** (UNVERIFIED). The trust signals also call for a **separate recording light**, which the board lacks. | HW-PRIV-02, HW-PRIV-05, HW-FUNC-11 | es7210.md, kt-0603r.md, mmbt3904.md; docs/security-model.md | Create a switched mic supply (e.g. 3V0 → mute pole A → "MIC_VCC") that feeds both the electret bias network and the mic light, so the light is physically on the mic's supply; or keep MICBIAS for the electret and add a series element so the mic cannot be powered with the LED open (FMEA in H4). Add a recording LED on a spare pin (ESP32 IO9/IO12/IO13 are free). |
| F-04 | **High** | **Handset is not unpowered on-hook in hardware.** SY6280 EN comes only from GPIO3; firmware can power the handset (and its mic) while hung up. | HW-PRIV-03, HW-FUNC-06 | sy6280.md, drv5032.md | EN = (HOOK off-hook) AND (HS_VBUS_EN): one AND gate (e.g. 74LVC1G08, SOT-23-5) or a series N-FET; the DRV5032 output is low when the magnet is present. Re-check D7's REF2 on the switched rail (srv05-4.md) and measure enumeration time (HW-ELEC-17). |
| F-26 | **High** | **Off-hook may never be detected.** The plunger gives ≈ 1.6 mT at the sensor off-hook (PROTO_BOX), but the DRV5032FA release point BRP is **0.5–3 mT** [DRV5032 p6]; a part with BRP < 1.6 mT stays "on-hook". | HW-FUNC-08 | drv5032.md | Plunger/enclosure: off-hook field < 0.5 mT for every part (more travel, smaller/weaker magnet, larger gap); re-run the field calculation with tolerances. On-hook (≈ 70 mT) is far above BOP max 4.8 mT. |
| F-01 | **High** | **Flashing path after removing the CH340C is undefined.** Queued: flash via native USB on the handset port with the VBUS switch off in boot mode. But that port presents **Rp** (source); a PC's USB-C port is a source or dual-role → with a C-to-C cable there is either no connection or the PC becomes the *device*. Only a USB-A-to-C cable (Rp in the cable, PC as host) works, with the SY6280 blocking back-feed when off [SY6280 p1, p5]. USB-Serial-JTAG download on IO19/20 itself is supported [WROOM p14]. | HW-FUNC-15, HW-PRIV-06 | esp32-s3-wroom-1u.md, usb-c-type-c-31-m-12.md, ch340c.md | Either (a) make J7 dual-role: switch Rp↔Rd (GPIO or boot-strap controlled) so download mode presents Rd with VBUS off, or (b) document "flash with an A-to-C cable into the handset port" as the only path and keep the UART/EN/BOOT pads. Decide before removing U16/Q5/Q6. |
| F-03 | **High** | **3V3 is above the eFuse-write limit.** FB 100 k/22 k gives 3.327 V nominal, up to ≈ 3.41 V with VFB max 0.612 V and 1 % resistors [TLV62569 p4]; the ESP32-S3 requires VDD3P3_CPU ≤ 3.3 V while burning eFuses [ESP32-S3 datasheet p64]. Secure boot, flash encryption and the HMAC keys are all eFuse writes. | HW-ELEC-08, HW-PRIV-06 | tlv62569.md, esp32-s3-wroom-1u.md | Set the buck to ≈ 3.2 V (e.g. 100 k / 23.2 k → 3.186 V nominal; keep ≥ 3.0 V at the module under load, HW-ELEC-07), or provide a fixture method to lower 3V3 during burning. |
| F-02 | **High** | **External antenna type differs from the module's certification antenna.** WROOM-1U was certified with a monopole (TFPD05H08750011, ≤ 2.33 dBi); "if you use an external antenna of a different type or gain, additional testing … may be required" [WROOM p44]. An adhesive FPC antenna is planned. | HW-REG-01, -03, HW-MECH-04, HW-FUNC-14 | esp32-s3-wroom-1u.md, off-board.md | Choose an antenna of the certified type and ≤ 2.33 dBi, or budget radio + EMC testing. Revisit the WROOM-1 (PCB antenna) if an edge with 15 mm clearance becomes available. |
| F-21 | **High** (Kids) | **Removable magnet plunger.** The plunger with a glued N35 magnet "is held in by gravity and the handset only; it lifts out" (PROTO_BOX). Under toy rules this is a small part containing a magnet (EN 71-1 / ASTM F963 magnet clauses). | HW-SAFE-04, HW-REG-05 | off-board.md; enclosure/PROTO_BOX.md | Captive plunger (retaining lip/pin), magnet fully enclosed; pull/torque test in DVT. The prototype box may keep the loose plunger with a warning. |
| F-05 | **High** | **Handset VBUS is below the USB range.** HS_VIN = VBUS − PTC (≤ 0.16 V) − Schottky (0.3–0.45 V) → ≈ 4.2–4.6 V at the port on USB power; on battery VSYS = VBAT (3.0–4.2 V) − 0.3 V → **2.7–3.9 V**. USB host ports supply 4.75–5.25 V; many UAC handsets will brown out on battery (HW-FUNC-13) and some on USB. HS_VIN also has 1 µF where 10 µF is "strongly recommended" [SY6280 p5], and R_SET 15 kΩ gives 0.34–0.57 A with the ±25 % spread, below the part's 0.4 A minimum range [SY6280 p3]. | HW-ELEC-19, HW-ELEC-06, HW-FUNC-06, -13 | sy6280.md, b5819w.md, smd1206p150tf.md | Replace the diode-OR with a small 5 V boost from VSYS (with load disconnect) or an ideal-diode power mux; if staying with the switch, feed it from VBUS through an ideal diode and state "handset needs USB power" (battery mode = base speaker/mic only). HS_VIN 10 µF; R_SET ≈ 12 kΩ (0.57 A nominal). |
| F-07 | Medium | **Input PTC can nuisance-trip.** Hold current 1.34 A at 40 °C (1.23 A at 50 °C) [PTC p4], but the charger may draw up to 1.56 A (K_ILIM max 1720 AΩ / 1.1 kΩ [BQ24074 p12]) plus the handset port (VBUS-direct, up to 0.57 A). PTC V_max is 8 V, and between ≈ 6 and 10 V a faulty source also exceeds the SY6280's 6 V abs max through D8. | HW-ELEC-04, HW-SAFE-03 | smd1206p150tf.md, smf5.0a.md, bq24074.md | 2 A-hold PTC with V_max ≥ 8 V (1812 size; the 1206 2 A part is only 6 V), or feed the handset from VSYS only so it sits behind the charger's OVP and ILIM. |
| F-06 | Medium | **Speaker power is capped at ≈ 0.5 W.** ES8311 full scale at AVDD 3.0 V is 0.91 Vrms [ES8311 p9]; NS4150B gain 240 k/150 k = 1.6 [NS4150B p7] → ≈ 1.45 Vrms → ≈ 0.53 W into 4 Ω, while the budget allows up to 3 W and the ringer needs loudness. | HW-ELEC-14, HW-FUNC-04 | ns4150b.md, es8311.md | Lower R_in (e.g. 47–68 kΩ) after a bench check of the gain definition; keep the firmware power caps. |
| F-08 | Medium | **LP5907 output capacitance too high:** ≈ 14.1 µF nominal on 3V0 vs COUT max 10 µF [LP5907 p6]. | HW-ELEC-09 | lp5907.md, capacitors.md | Remove the 10 µF on 3V0, or prove stability with the vendor model (H4). |
| F-10 | Medium | **Battery connector and TS.** JST-PH fixes the housing, not the pin order; 3-pin packs use varying orders, and a mismatched pack reverse-biases BAT (abs min −0.3 V [BQ24074 p10]). TS floats without a pack (datasheet: "connect a 10 kΩ fixed resistor" when TS is unused [BQ24074 p9]); it works (TS rises above VCOLD → charging suspended) but is off-datasheet, and 2-wire packs never charge. | HW-SAFE-02, HW-FUNC-13 | jst-ph-sm4-tb.md, bq24074.md, off-board.md | Specify the pack (pinout, NTC β, protection) in the BOM, silkscreen the pin order; optional reverse-polarity protection on BAT; document "packs need an NTC". |
| F-11 | Medium | **VSYS capacitance ≈ 141 µF** vs 4.7–47 µF on BQ24074 OUT [BQ24074 p8] (already flagged in SCHEMATIC.md). Start-up runs at a 100 mA limit until VOUT > 0.9 V [p12, p19]; DPPM/supplement-mode behaviour with this load is unverified. | HW-ELEC-10, -05 | bq24074.md, capacitors.md | Reduce the 100 µF amplifier bulk (e.g. 22 µF); simulate start-up (H4); cold-start tests with and without a pack. |
| F-13 | Medium | **Metal hook post above the Hall sensor** (owner: drop-in metal posts). U10 sits directly under the right post socket; an ESD strike to the post (±8/±15 kV, HW-ELEC-22) has a short path into U10/HOOK. | HW-ELEC-22, HW-MECH-04 | drv5032.md, off-board.md | Ground the posts to GND through a defined path (insert/screw pad), or keep an insulating gap and add a TVS/RC on HOOK; keep posts ≥ 15 mm from the antenna. |
| F-16 | Medium | **LIS2DH12TR has zero stock** at LCSC and JLCPCB; alternates unverified (SC7A20 claimed compatible; LIS2DW12 has a different pinout). It has no current software use. | HW-FUNC-17, HW-MFG-03 | lis2dh12.md | Owner decision: remove U12, Q4 and passives (simplest), or qualify SC7A20TR. |
| F-24 | Medium | **Other stock risks:** BQ24074RGTR 432 units (second source BQ24073RGTR C15220, 33.7 k, pin 15 TD → GND); Kailh CPG151101S11-16 0 units (HanElectricity CPG151101S11-2, C49352235, identical land, tin contacts); GMI6027 electret 995; SWPA4020S470MT 1 495. | HW-MFG-03 | bq24074.md, kailh-cpg151101s11.md, gmi6027-electret.md, inductors-ferrites.md | Add the alternates to the BOM notes; use C49352235 for JLC orders. |
| F-25 | Medium | **Assembly process gaps:** the GMI6027 electret is specified for **iron soldering only** (320 °C, 2–3 s, heat-sinked) with no reflow profile [GMI6027 p5]; SK6812MINI-E is **MSL 5a** [SK6812 p1]; WROOM-1U MSL 3 [WROOM p47]. | HW-MFG-05, -07 | gmi6027-electret.md, sk6812mini-e.md | Mark MK1 "hand-solder after reflow" (or choose a reflowable mic); add MSL/baking notes to ASSEMBLY.md. |
| F-12 | Low | **E-ink FPC contact side / land pattern:** the tail's contacts are on the display side [GDEY029T94 p7]; with the planned 180° fold under the panel they face the PCB, so the bottom-contact ZIF is right — but the XUNPU drawing is unreadable (corrupt PDF), so the land pattern is unverified. | HW-FUNC-03 | fpc-05f-24ph20.md, gdey029t94.md | Order samples (J6 + panel); confirm the fold and land before layout freeze. |
| F-14 | Low | **AEC reference divider** ≈ −20 dB unloaded vs Korvo-2's ≈ −24 dB; it omits Korvo's two RC low-pass stages (2.2 k/10 nF, 10 k/2.2 nF) and uses 1 µF instead of 0.22 µF into MIC3 [Korvo-2 V3.1.2 sheet 4]. SCHEMATIC.md's "≈ −24 dB, Korvo values" note is inaccurate. | HW-ELEC-15 | es7210.md | Simulate with the ES7210 6 kΩ input (H4); copy Korvo's network or set the PGA; fix the note. |
| F-15 | Low | **MUTE_SENSE polarity uncertain:** C&K's circuit diagram draws 4 over 1, the KiCad footprint puts 6 opposite 1 [JS p1]; MUTE_SENSE might read inverted. The hardware mute (pole A) is unaffected. | HW-FUNC-09 | js202011aqn.md | Continuity check on a sample; invert in firmware if needed. |
| F-17 | Low | **ST25DV04K-IER6S3 is NRND** (replacement ST25DV04KC-IE6S3, C3304276, 17.8 k stock, $0.50 @1k — cheaper). | HW-FUNC-07, HW-MFG-03 | st25dv04k.md | Swap after checking the KC datasheet (pinout, addresses, tuning capacitance). |
| F-18 | Low | **NFC coil** inductance is calculated only (4.8 µH Neumann; 4.5 µH modified Wheeler) → 13.6–14.1 MHz with the 28.5 pF internal cap; the 22 pF placeholder would detune it to ≈ 10 MHz. | HW-FUNC-07 | nfc-coil.md | Keep C78 DNP; VNA in EVT; read-range test with iPhone/Android. |
| F-19 | Low | **3V3 output capacitance** ≈ 70 µF nominal vs TLV62569's verified 10–47 µF / 2 × 22 µF cells [TLV62569 p9-10]. | HW-ELEC-07 | tlv62569.md, capacitors.md | Simulate with the vendor model incl. DC-bias derating (H4); measure the 500 mA step. |
| F-20 | Low | **I2C rise time:** 4.7 kΩ with 8 devices and a ~100 mm branch to the ST25DV (estimated 80–100 pF, UNVERIFIED) gives ≈ 320–400 ns (0.8473·RC) > the 300 ns Fast-mode limit [AW9523B p7]. | HW-ELEC-21 | aw9523b.md, resistors.md | Run at 100 kHz, or 2.2 kΩ pull-ups; measure after routing. |
| F-23 | Low | **35 extended JLC lines** vs the ≤ 25 goal (≈ $3 setup each on small orders). F-01 (CH340C), F-16 (LIS2DH12) and 4.3 k → 4.7 k reduce it. | HW-MFG-02 | resistors.md, README.md | Track in `cost.py`. |
| F-28 | Low | **KT-0603R polarity:** the vendor numbers pin 1 = anode (cathode = green-marked end, pin ②) while KiCad pad 1 = K [KT-0603R p2]. Correct if the marked end lands on pad 1. | HW-PRIV-02 | kt-0603r.md | Check the JLC polarity preview; silkscreen a cathode mark. |
| F-29 | Low | **Electret orientation:** terminal 2 = case/GND, terminal 1 = output [GMI6027 p4]; the round part has no orientation feature and the footprint is symmetric. | HW-FUNC-05 | gmi6027-electret.md | Silkscreen "GND/case" at pad 2; assembly note. |
| F-22 | Info | **PROTO_BOX.md text is stale:** it puts both USB-C openings on the rear wall (J7 x 24, J1 x 159); `proto_box.py` and placement use J7 on the rear at x 153.8 and J1 on the right wall at y 40. | HW-MECH-03 | usb-c-type-c-31-m-12.md | Update the doc (H5). |
| F-27 | Info | `pin_table.yaml` lists 0x2D for the ST25DV04K; the datasheet shows only 0x53/0x57 [ST25DV p88]. Stale comment in `board_main.py` ("GPIO41: amp off"): PA_EN is GPIO38. | HW-ELEC-21 | st25dv04k.md | Clean up in H5. |
| F-30 | Info | **MUTE covers only the base mic.** The handset mic is not affected by the mute switch; its only hardware guarantee is "unpowered on-hook" (F-04). | HW-PRIV-01 | js202011aqn.md | Owner decision: document, or let MUTE also cut handset VBUS (ends the call). |
| F-31 | Info | The N16R8 module is rated −40 … +65 °C (octal PSRAM) [WROOM p3]; SK6812 IC parameters are characterized at 4.5–5.5 V while VLED is 4.4 V [SK6812 p6]. Both acceptable for HW-ENV-01. | HW-ENV-01, HW-FUNC-02 | esp32-s3-wroom-1u.md, sk6812mini-e.md | none |

## Previously unverified items — resolved

| Item | Resolution | Evidence |
|---|---|---|
| ES7210/ES8311 unused mic inputs | Neither datasheet states a rule. Espressif's Korvo-2 leaves ES8311 MIC1P/N on test pads only and AC-couples ES7210 MIC4 with MIC4P effectively unterminated → our open inputs match Espressif practice. Power the unused channels down in firmware; optional 1 µF to GND for margin. | es8311.md, es7210.md; Korvo-2 V3.1.2 sheet 4 |
| E-ink FPC tail side | Contacts are on the display side [GDEY029T94 p7]; with the tail folded 180° under the panel (placement.yaml) they face the PCB → **bottom-contact** ZIF is correct. Land pattern still unverified (corrupt XUNPU PDF, F-12). | fpc-05f-24ph20.md |
| SKRTLAE010 pad pairing | Terminals ① and ③ are internally common, ② is the other contact [Alps p3]; KiCad pads "1" = ①/③, "2" = ②, MP = frame. Our nets (1 = VOL_x, 2 = GND) are correct. | skrtlae010.md |
| KT-0603R cathode | Cathode = green-marked end = vendor pin ② (vendor pin ① = +) [p2]; KiCad pad 1 = K. Correct if placed mark-to-pad-1 (F-28). | kt-0603r.md |
| SOT-23 pinouts | MMBT3904 1 B / 2 E / 3 C [JSCJ p1]; AO3400A and AO3401A 1 G / 2 S / 3 D [AOS p1 figures]; Si1308EDL (SC-70) 1 G / 2 S / 3 D [Vishay p1]; DRV5032 1 VCC / 2 OUT / 3 GND [TI p3]; SOT-23-5/6 parts (TLV62569, LP5907, SN74LV1T125, SY6280, USBLC6, SRV05-4) also match. All nets correct. | respective files |
| Kailh CPG151101S11-16 out of stock | HanElectricity **CPG151101S11-2** (C49352235, 26 k stock) has the identical body, holes and recommended land (both drawings p1); it is a different maker using Kailh's part number, with tin- instead of gold-plated contacts. Footprint-compatible. | kailh-cpg151101s11.md |

Also resolved along the way: ES7210 pins 3/4 (3 = CDATA, 4 = CCLK: drawing, typical application and
Korvo-2 agree); SY6280 current-limit formula (6800/R_SET, [SY6280 p2]); CH340C pin 7 NC / pin 8
OUT# ([CH340 p3]); electret ground terminal (terminal 2, [GMI6027 p4]); AW9523B power-on state
(all outputs low with AD0 = AD1 = GND, [AW9523B p11]); MAX17048 pinout, EP to GND and address 0x36
([p6], [p16]). Still UNVERIFIED: MAX17048 and AW9523B exposed-pad land sizes, the XUNPU FPC land
pattern, ES7210 MICBIAS capability, the JS202011AQN pole-B terminal order.

## SPICE model coverage (input for H4)

| Part | Vendor model | Source |
|---|---|---|
| TLV62569 | **Yes** — PSpice unencrypted transient model SLVMBW3 | https://www.ti.com/product/TLV62569 |
| LP5907-3.0 | **Yes** — PSpice SNVM028 / unencrypted SNVMAP8; TINA-TI SNVM611 | https://www.ti.com/product/LP5907 |
| SN74LV1T125 | **Yes** — behavioural SPICE SCLM183, IBIS SCLM109 | https://www.ti.com/product/SN74LV1T125 |
| MBR0530, MMBT3904 | Likely (onsemi discrete models; standard 2N3904 models) — UNVERIFIED, onsemi site not reachable | onsemi product pages |
| AO3400A, AO3401A | Likely (AOS product pages) — UNVERIFIED | https://www.aosmd.com |
| USBLC6-2SC6, SMF5.0A, SRV05-4 | Likely from ST / Littelfuse / Semtech — UNVERIFIED (sites not reachable) | vendor pages |
| BLM18PG121SN1D, Samsung MLCCs | Murata SimSurfing / Samsung tool models — UNVERIFIED format | vendor tools |
| **Needs a behavioural model** | BQ24074 (TI lists none), NS4150B, ES8311, ES7210 (6 kΩ inputs), SY6280, DRV5032 (TI lists none), Si1308EDL (Vishay lists none), B5819W, SK6812MINI-E (load), ESP32-S3 module (current profile), ST25DV + NFC coil (RLC), GMI6027 electret, speaker (RLC), PTC (thermal); MAX17048, AW9523B, LIS2DH12, LTR-303, CH340C are digital (static loads only) | per-part files |

Suggested H4 simulations, in priority order: (1) 3V3 load step 0 → 500 mA with the TLV62569 model
and derated caps (HW-ELEC-07, F-19); (2) VSYS start-up and DPPM with ≈ 141 µF and the handset load
(F-11); (3) LP5907 stability with the real 3V0 capacitance (F-08); (4) handset VBUS drops on USB and
battery (F-05); (5) mic bias / mute / mic-light FMEA (F-09); (6) AEC reference divider with the
6 kΩ ADC input (F-14); (7) NFC coil resonance (F-18).

## What H3/H4 needed from the owner (answered 2026-09-30, see the table at the top)

1. **Battery-life and loudness targets** (HW-ELEC-06, -14 are marked "(owner)").
2. **Antenna choice**: certified-type monopole vs FPC with extra tests (F-02).
3. **Handset power on battery**: add a 5 V boost, or accept "handset needs USB" (F-05).
4. **Flashing path** after the CH340C removal: dual-role J7, or A-to-C-cable-only (F-01).
5. **Accelerometer**: remove or qualify SC7A20 (F-16); **recording light** (F-09); MUTE and the
   handset mic (F-30).
6. **Toy classification** (DESIGN §15 Q4): decides how strict F-21 and HW-REG-05 are.
7. **Handset models to qualify** (≥ 3 UAC handsets/headsets) and the reference USB-C adapter.
8. **H4 tooling**: ngspice (KiCad-integrated) vs LTspice for the TI PSpice models.
