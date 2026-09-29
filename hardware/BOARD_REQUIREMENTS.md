# Open Lounge Phone board requirements for layout (H3)

Status: **draft 2, 2026-09-30 (H5).** Draft 1 assumed the H4 proposal with a USB-C handset port;
draft 2 follows the H5 schematic as built (owner decisions D14–D21: analog 3.5 mm handset jack, no
USB host / boost / USB switch / CH340C, no base mic or speakerphone, privacy chain on the handset
mic). Items that no longer apply are struck through and marked **superseded**. Phase H3 of the hardware process: the checklist the layout of the
one 180 × 88 mm board is checked against. Every item has an ID `BR-<area>-nn` and cites the
requirement IDs of [REQUIREMENTS.md](REQUIREMENTS.md) it serves; the numbers come from the H4
benches ([sim/](sim/README.md)), the parts files ([components/](components/README.md)) and the
fab's published capabilities. It follows the **H5 schematic** (`schematic/`, reviewed in
[SCHEMATIC_REVIEW.md](SCHEMATIC_REVIEW.md)). Nothing here changes the board: the layout is H6.

Verification: **C** = checked by `layout/checks.py` or KiCad DRC (existing or to add), **R** =
review against the rendered board, **M** = measured on the first boards (EVT). An item is done
when its method passes and the reviewer ticks it in the layout review record (GUIDELINES §6).

## 1. Power tree, budgets, transients and ripple

```
USB-C J1 (sink, Rd; D+/D- -> ESP32 native USB) ─ PTC 2 A (1812) ─ SMF5.0A ─ VBUS ── BQ24074 ── VSYS 4.3–4.5 V / VBAT
                                                         │            ├─ TLV62569 ─ 3V3 3.19 V (ESP32, codec digital, e-ink, logic)
                                          pack 1S ─ BAT ─┘            ├─ LP5907 ─── 3V0 3.0 V (ES8311 analog) ─ 100 Ω/10 µF ─ MUTE ─ Q5 (HOOK) ─ MIC_VCC
                                                                      ├─ NS4150B ── speaker 8 Ω (ring + prompts)
                                                                      └─ AO3401A Q2 (soft start) ─ VLED (13 × SK6812)
```

| ID | Rail | Nominal / range | Budget (continuous / peak) | Transient and ripple spec | Layout consequence | Req. |
|---|---|---|---|---|---|---|
| BR-PWR-01 | VBUS_C → VBUS | 4.75–5.25 V; hot-plug peak ≤ 7.4 V (b01) | ≤ 1.56 A (charger ILIM max, K_ILIM 1720 AΩ / 1.1 kΩ, SLUS810N p12) | attach capacitance ≤ 10 µF effective (5.8 µF, b01; USB 2.0 §7.2.4.1) | Power class (0.6 mm) or pour J1 → F1 → D3 → U2 IN; TVS D3 within 3 mm of J1 VBUS pins, its GND via ≤ 1 mm | HW-ELEC-01, -04, -05 |
| BR-PWR-02 | VSYS | 4.3–4.5 V on USB (SLUS810N p12), 3.0–4.2 V on the pack | worst firmware-capped 0.99 A at 5 V (`power_budget.yaml`, H5), ≤ 0.9 A 1 ms average at 4.75 V (b01) | ≥ 3.83 V at the worst capped load without a pack (b01); ≥ 4.12 V while ringing at 1 W (b06); LED switch-on dip ≤ 0.2 V (b09: 1.7 mV); 1 kHz LED-PWM ripple ≤ 50 mV p-p (b09: 11 mV) | L3 VSYS pour (right end) with ≥ 2 vias per transition; total OUT capacitance 44.5 µF nominal (≤ 47 µF, SLUS810N p8) — the 22 µF at the amp VCC pin, the 10 µF at U2 OUT | HW-ELEC-05, -10 |
| BR-PWR-03 | 3V3 | **3.19 V** (0.1 % FB divider), window **3.00–3.30 V** at the module pin | ≥ 0.5 A (WROOM p27); Wi-Fi burst step 0 → 500 mA at 1 A/µs | worst low 3.022 V, worst high 3.287 V in power-save, ≤ 3.36 V after release (b02); PWM ripple ≤ 30 mV p-p (b02: 1.4 mV), PSM ripple ≤ 30 mV p-p (17 mV) | buck loop (VIN cap – U3 – L1 – COUT – GND) on L1 over solid L2, ≤ 10 mm²; FB divider at U3 pin 5, sense taken at the output cap, not near L1; 22 µF at the buck and 22 µF + 100 nF at module pin 2 (100 nF between pin and via) | HW-ELEC-07, -08, -24, HW-PRIV-06 |
| BR-PWR-04 | 3V0 | 3.0 V ± 2 % (LP5907 p5) | ≈ 25 mA (ES8311 + earpiece ≤ 14 mA rms + mic supply) | load step 1 → 25 mA stays 2.993–3.007 V; ≤ 10 µVrms noise; PSRR ≥ 79 dB at 1 kHz (b03, TI model) | L3 3V0 island under the codec only; C_OUT 2.1 µF nominal (0.7–10 µF, SNVS798Q p6); no digital or switching net crosses the island on L1/L3 | HW-ELEC-09, -13 |
| BR-PWR-05 | MIC_F → MIC_M → MIC_VCC | 2.9 V (3V0 through 100 Ω; MUTE pole A; Q5 P-FET switched by HOOK) | ≈ 2 mA (2 mic lights at 0.7–0.8 mA + handset electret ≤ 0.5 mA) | capsule ≥ 1.5 V in every corner (b05: 1.54 V) | the 100 Ω/10 µF filter sits **before** MUTE; MIC_VCC after Q5 carries only 100 nF + the lights (`check_privacy`: ≤ 1 µF); MIC_VCC and HS_MIC_F as Audio class, away from the amp and the buck; Q5/Q6 next to SW5 | HW-PRIV-01, -02, -03, HW-ELEC-13 |
| BR-PWR-06 | VLED | switched VSYS | 13 × (1 mA + 3 × 14.5 mA) = 0.58 A uncapped, ≈ 0.19 A at the 30 % cap | inrush ≤ 0.3 A (b09: 85 mA), VLED ≥ 3.7 V (b09: 4.32 V) | two L3 strips under the key rows (LAYOUT §6), fed from Q2 by one neck ≥ 0.6 mm; gate RC (47 kΩ + 4.7 nF) at Q2; 10 µF bulk | HW-FUNC-02, HW-ELEC-10 |
| BR-PWR-07 | ~~HS_VIN / HS_VBUS~~ | **superseded** (D14): no handset boost or VBUS switch | — | — | — | — |
| BR-PWR-08 | VBAT | 3.0–4.2 V | charge 494 mA (K_ISET/R_ISET, SLUS810N p8) | — | U2 BAT pins → J2 (bottom, 150, 46) Power class; MAX17048 CELL sensed at J2, not at U2 | HW-FUNC-13 |

## 2. Stackup and impedance

| ID | Item | Requirement | Req. |
|---|---|---|---|
| BR-STK-01 | Stackup | JLCPCB **JLC04161H-7628**, 1.6 mm: L1 35 µm / prepreg 7628 0.2104 mm (εr 4.4) / L2 15 µm / core 1.065 mm / L3 15 µm / prepreg 0.2104 mm / L4 35 µm; ENIG (`layout/boards.yaml` `stackup`, LAYOUT §3). L2 solid GND, no routing. | HW-MFG-01, HW-ELEC-18 |
| BR-STK-02 | USB 90 Ω differential | The one pair (J1 → D1 → 0 Ω links → U1 IO19/20) on L1 over L2: **0.27 mm track / 0.15 mm gap** → 89.4 Ω by the IPC-2141A edge-coupled microstrip estimate, JLC calculator 88–92 Ω for this stackup (LAYOUT §3). Solder mask lowers it by ≈ 2–4 Ω: acceptable, USB 2.0 FS tolerates ±15 %. **Gate before ordering:** re-run the JLC impedance calculator (https://jlcpcb.com/pcb-impedance-calculator) and record the numbers here. | HW-ELEC-18 |
| BR-STK-03 | Pair routing | Length match ≤ 0.15 mm, no vias on the L1 pair, ESD at the connector first, every segment over unbroken L2 (no pour gaps or slots under the pair). | HW-ELEC-18, -23 |

## 3. Net classes and via rules

| ID | Class | Nets | Track / clearance | Req. |
|---|---|---|---|---|
| BR-NET-01 | Default | everything else | 0.20 / 0.15 mm (min 0.15/0.15) | HW-MFG-01 |
| BR-NET-02 | Bus | I2C, I2S, EPD SPI, LED data, IRQ, UART, HOOK, HOOK_IN, JACK_DET | 0.20 / 0.20 mm | HW-ELEC-21 |
| BR-NET-03 | USB | USB_DP/DN, USB_DP/DN_C | 0.27 / 0.15 mm, pair gap 0.15 | HW-ELEC-18 |
| BR-NET-04 | Audio | MIC_F, MIC_M, MIC_VCC, HS_MIC, HS_MIC_F, MIC1P/N, HS_GND, DAC_OUTP/N, EAR_SW, EAR_AC, HS_T, HS_R1, PA_IN_*, MIC_SENSE_D | 0.20 / 0.20 mm (LAYOUT §4 deviation from 0.25/0.3), ≥ 0.5 mm to Speaker; the mic pair (HS_MIC_F → MIC1P, HS_GND → MIC1N) routed together | HW-ELEC-13, -26 |
| BR-NET-05 | Power3V | 3V3, 3V0 | 0.4 / 0.2 mm or pour | HW-ELEC-07, -09 |
| BR-NET-06 | Power | VBUS_C, VBUS, VSYS, VBAT, VLED | 0.6 / 0.25 mm; neck-down only in ≤ 1 mm stubs | HW-ELEC-04 |
| BR-NET-07 | Speaker | NS4150B outputs, SPK_VOP/VON | 0.5 / 0.25 mm, pair routed together | HW-FUNC-04 |
| BR-NET-08 | GND | GND | L2 solid; L1/L4 fills stitched every ≈ 5 mm and along all edges | HW-ELEC-22, HW-REG-01 |
| BR-VIA-01 | Vias | 0.3 mm drill / 0.6 mm pad (annular 0.15 mm); ≥ 2 vias per power transition; thermal-pad arrays (§7); no via-in-pad except exposed pads (filled vias are not ordered) | HW-MFG-01 |

## 4. Keep-outs

| ID | Area | Requirement | Req. |
|---|---|---|---|
| BR-KO-01 | NFC loop | 26 × 42 mm coil at the front-left end (7 turns 0.3/0.3 mm after P-11): no copper inside the loop on L1/L2, only straight signal crossings on L3/L4 without vias, pour slit to the left edge on every layer (`NFC_LOOP`, `NFC_SLIT`); ST25DV U19 and C62 (12 pF) within 20 mm of the coil terminals; ≥ 5 mm from the key sockets where possible. | HW-FUNC-07, HW-MECH-08 |
| BR-KO-02 | Antenna cable path | The U.FL at the module's bottom edge (U1 rot 180) and the first 20 mm of the Ø1.13 cable toward the shell wall: no part taller than 1.5 mm and no screw boss on the path; the antenna itself sits on the shell wall **≥ 15 mm from metal** (hook posts, inserts, screws, speaker magnet, pack) — enclosure item; the cable must not cross the NFC loop or the speaker. | HW-MECH-04, HW-FUNC-14, HW-REG-01, -03 |
| BR-KO-03 | Marking area | Bottom silkscreen inside the NFC coil: signature logo, "Open Lounge Phone", "board rN", "CERN-OHL-S-2.0" (`LOGO` keep-out, 4.0–26.8 × 41.6–61.4); no tracks, vias, parts or pours under it on L4. Silk text ≥ **1.0 mm** high and ≥ 0.15 mm stroke (JLC minimum; the current 0.8 mm texts in `boards.yaml` must grow). | HW-PRIV-07, HW-MFG-01 |
| BR-KO-04 | Mounting holes | Nine M2.5 plated holes (HW-MECH-01) with a Ø6 mm keep-out on both sides; plated to GND with ≥ 4 stitching vias each (ESD path for inserts/screws). | HW-MECH-01, -06, HW-ELEC-22 |
| BR-KO-05 | Hall sensor | No inductor, ferrite, speaker magnet or other ferrous part within **15 mm** of U10 (171.0, 18.8) — includes L1; the plunger retainer footprint (Ø11) above U10 free of top parts taller than 2.2 mm (`make proto`) | HW-MECH-07, HW-FUNC-08 |
| BR-KO-06 | Key switches, panel, battery, speaker | 13.5 mm switch bodies: no top parts; under the e-ink panel ≤ 2.8 mm; `BATTERY_POCKET` (102.4–142.4 × 24–54) no bottom parts; under the speaker (x 59–102, y 32.5–55) bottom parts ≤ 1.0 mm. | HW-MECH-02, -05 |
| BR-KO-07 | ~~Handset USB corridor~~ | **superseded** (D14): the handset jack J7 sits on the bottom at the rear edge; keep its six pads, the two locating-peg holes and the rear-wall plug path (Ø8 at the board edge) free | HW-FUNC-06 |

## 5. Placement per block (approved floorplan: power + ESP32 at the right end, codecs next to the ESP32, AW9523B at the row ends, NFC front-left)

| ID | Block | Constraint | Req. |
|---|---|---|---|
| BR-PL-01 | ESP32-S3-WROOM-1U U1 | (131.5, 32.3) rot 180, native USB pins facing J1's pair; ≥ 10 mm from U2 (charger) (module rated to +65 °C ambient, WROOM p3) | HW-ENV-01, HW-FUNC-14 |
| BR-PL-02 | Power entry | J1 right wall y 40 → D1/D2 → F1/D3 → U2 → U3/L1 in signal-flow order; U14 and J2 beside U2 | HW-ELEC-04, HW-FUNC-13 |
| BR-PL-03 | ~~USB mux~~ | **superseded** (D14): J1 → D1 → 0 Ω links → U1 IO19/20, ≤ 40 mm where possible | HW-FUNC-15, HW-ELEC-18 |
| BR-PL-04 | Handset jack (new) | J7 on the **bottom** at the rear edge (x 153.8), its front face flush with the board edge (≤ 0.5 mm overhang); D7/D8 within 3 mm of its pads; FB3, the 100 pF shunts and the 22 Ω earpiece resistors at the jack; U8 (TS5A3166), the 2 × 22 µF and the 22 kΩ bypass between U6 and J7; D9 + 100 kΩ close to J7, MIC_SENSE on to IO10 | HW-FUNC-06, -18, HW-ELEC-26 |
| BR-PL-05 | Codec | ES8311 U6 directly below U1 (I2S ≤ 32 mm), LP5907 U4 and the 3V0 island with it; its MIC1P/N toward J7 | HW-ELEC-13 |
| BR-PL-06 | Privacy chain, lights, MUTE | Q5/Q6 and the 100 Ω/10 µF filter next to SW5; the two mic lights D21/D22 side by side under one light slot (158.5, 67.5); recording light D23 under its own hole (158.5, 77.0), ≥ 8 mm from the mic lights; MIC_VCC test pad | HW-PRIV-01, -02, -05 |
| BR-PL-07 | Amp | NS4150B U9 at the panel's right end next to J4 and the speaker; outputs → beads → J4 ≤ 15 mm; ≥ 15 mm from the mic nets (HS_MIC_F, MIC1P/N) | HW-FUNC-04, HW-ELEC-13 |
| BR-PL-08 | Keys and LEDs | AW9523B U17 at the right end of the key rows (rows as parallel buses, `ui.AW_PORTS`); U5 between keys 5 and MENU; Q2/Q3 + soft-start parts next to U17 | HW-FUNC-01, -02 |
| BR-PL-09 | NFC | coil front-left, U19 at its terminals | HW-FUNC-07 |
| BR-PL-10 | Decoupling | every IC supply pin has its cap ≤ 2 mm (checked ≤ 2.5 mm), cap GND via ≤ 1.5 mm | GUIDELINES §3 |

## 6. Thermal

| ID | Part | Worst sustained dissipation | Requirement | Req. |
|---|---|---|---|---|
| BR-TH-01 | BQ24074 U2 (θJA 44.5 °C/W, SLUS810N p11) | Q1 (5.25 − 4.4 V) × 1.56 A = 1.33 W plus charge FET (4.4 − 3.0 V) × 0.494 A = 0.69 W → 2.0 W: at 40 °C ambient the part reaches thermal regulation (charge current folds back, p28) — acceptable, but the board must spread it | ≥ 9 thermal vias (0.3 mm) in the exposed pad to L2; ≥ 4 cm² of GND copper on L1 + L4 around U2; ≥ 10 mm from U1 and ≥ 5 mm from the battery pocket; accessible surface rise ≤ 15 °C (HW-SAFE-05, measure) | HW-ELEC-12, HW-SAFE-05 |
| BR-TH-02 | ~~TPS61023~~ | **superseded** (D14) | — | — |
| BR-TH-03 | NS4150B (θJC 190 °C/W, datasheet p2) | 1 W out at η 0.88 → 0.14 W | GND pour on L1 at pin 7, ≥ 2 vias; keep ≥ 10 mm from U1 | HW-ELEC-12 |
| BR-TH-04 | ~~SY6280~~ | **superseded** (D14) | — | — |

## 7. ESD and EMC plan per connector

| ID | Connector / entry | Protection and layout | Req. |
|---|---|---|---|
| BR-ESD-01 | Power USB-C J1 | SMF5.0A on VBUS, USBLC6-2SC6 D1 on D+/D− (the native USB), D2 on CC1/CC2, all within 3 mm of the pins, GND vias ≤ 1 mm; shell tabs to GND via ≥ 4 vias; 1 kΩ CC sense resistors next to U1 side | HW-ELEC-22, -23 |
| BR-ESD-02 | Handset jack J7 | two PESD5V0S2BT (bidirectional: the AC-coupled earpiece swings below GND) D7 on T/R1, D8 on S/TN, within 3 mm of the pads, common pin to GND with ≤ 1 mm via; R2 (HS_GND) joins GND at the jack only (net tie) | HW-ELEC-22, -23 |
| BR-ESD-03 | Side switches SW3–SW5 | SRV05-4 D4 at the right edge, 10 kΩ pull-ups on the far side; MUTE pole A (MIC_F/MIC_M) has no TVS — keep it ≥ 1 mm inside the board edge and let the switch body shield it | HW-ELEC-22 |
| BR-ESD-04 | Keys (gaps around the caps) | GND guard ring on L1 and L4 around the key field, stitched every 5 mm; key lines reach only the AW9523B (never an ESP32 pin) | HW-ELEC-22, -23 |
| BR-ESD-05 | Metal hook posts / inserts | posts land on plated, GND-stitched holes or pads (F-13); HOOK net: 100 kΩ pull-up (DRV5032AJ open-drain) plus 100 Ω series and 1 nF to GND at U10 (fitted in H5); U10 ≥ 3 mm from the post socket rim | HW-ELEC-22, HW-FUNC-08 |
| BR-ESD-06 | Speaker J4, battery J2, e-ink FPC J6 | internal: beads + 220 pF at J4 (speaker cable emission); J2 and J6 unprotected (not user-reachable); FPC GND pins to L2 with vias | HW-REG-01 |
| BR-EMC-01 | Switching loops | buck and e-ink boost loops each ≤ 10 mm² on L1 over L2, SW nodes not routed under other parts; class-D outputs as a tight pair with beads at the amp | HW-REG-01, -03 |
| BR-EMC-02 | Board edges | GND stitching along all edges (≤ 5 mm), no signal within 1 mm of the edge except connector pins | HW-REG-01 |

## 8. Test points and programming

| ID | Item | Requirement | Req. |
|---|---|---|---|
| BR-TP-01 | Test pads | bottom side, Ø1.0 mm on a 2.54 mm pogo grid (origin 156.0, 9.6): VBUS, VSYS, 3V3, 3V0 (at the codec), **MIC_VCC** (H5: production check of mic light = mic power), GND × 2, U0TXD, U0RXD, EN, BOOT. | HW-MFG-06, HW-PRIV-02 |
| BR-TP-02 | Programming | flashing and console through the **power USB-C J1** (native USB, USB-Serial-JTAG); recovery: UART0 + EN + BOOT pads; RESET/BOOT pinhole buttons at (158.5, 12.5)/(158.5, 20.8). | HW-FUNC-15, -16, HW-PRIV-06 |
| BR-TP-03 | First power-up | current-limited 5 V on the VBUS pad; BOM check that nothing is DNP (the NFC tuning cap C62, 12 pF, is fitted since H5) | HW-MFG-06 |

## 9. DFM / DFA for JLCPCB (portable to other fabs)

| ID | Rule | Our value | JLCPCB capability (https://jlcpcb.com/capabilities/pcb-capabilities, 2026-09-30) | Req. |
|---|---|---|---|---|
| BR-DFM-01 | Track / space | ≥ 0.15 / 0.15 mm | 0.09 / 0.09 mm (multilayer, 1 oz) | HW-MFG-01 |
| BR-DFM-02 | Drill / via | ≥ 0.3 mm drill, 0.6 mm pad | 0.15 mm hole / 0.25 mm pad min; annular ≥ 0.15 (0.20 recommended) | HW-MFG-01 |
| BR-DFM-03 | Hole-to-hole | ≥ 0.5 mm (MX socket NPTH 0.45 mm waiver) | via 0.2 mm, pad holes 0.45 mm | HW-MFG-01 |
| BR-DFM-04 | Copper to edge | ≥ 0.3 mm | ≥ 0.2 mm (routed) | HW-MFG-01 |
| BR-DFM-05 | Silkscreen | text ≥ **1.0 mm** high, line ≥ 0.15 mm | 1.0 mm / 0.15 mm | HW-PRIV-07 |
| BR-DFM-06 | Solder-mask dam | pad spacing ≥ 0.10 mm keeps a dam (QFN 0.4 mm pitch: the ES8311 gets a dam only if the land allows) | 0.10 mm (1 oz) | HW-MFG-01 |
| BR-DFA-01 | Part-to-edge | body ≥ 2.5 mm from the board edge, or add **5 mm edge rails** (the USB-C receptacles and side switches sit at the edge, so rails with mouse bites on the top and bottom edges are required for JLC PCBA) | JLC PCBA: body-to-edge ≥ 2.5 mm, rails ≥ 5 mm (https://jlcpcb.com/help/article/how-to-add-edge-rails-fiducials-for-pcb-assembly-order) | HW-MFG-01 |
| BR-DFA-02 | Fiducials | 3 per assembled side (both sides are assembled): 1 mm copper, 2 mm mask opening, ≥ 3.35 mm from the edge, on the board or the rails | same source | HW-MFG-01 |
| BR-DFA-03 | Panel | 1-up with rails (board 180 × 88 mm is inside JLC's 70 × 70 … 460 × 500 mm PCBA range); a 2-up panel only if the one-off price drops (report in `cost.py`) | same source | HW-MFG-01, -04 |
| BR-DFA-04 | Hand / hybrid assembly | SK6812MINI-E MSL 5a, WROOM-1U MSL 3 handling (ASSEMBLY.md); no part below 0603; fine-pitch list: ES8311 QFN 0.4, BQ24074/AW9523B/MAX17048 QFN/DFN, TS5A3166 SC-70-5 (0.65 mm); J7 is SMD with locating pegs (reflow or iron) | — | HW-MFG-05, -07 |
| BR-DFA-05 | Outputs | Gerber X2 + Excellon (PTH/NPTH), IPC-2581, generic BOM + JLC BOM/CPL (`make layout`) | — | HW-MFG-01 |

## 10. Height budget under the lid

| ID | Zone | Limit (PROTO_BOX / HW-MECH-02) | Parts to watch | Req. |
|---|---|---|---|---|
| BR-HT-01 | Top side, general | ≤ 3.0 mm (lid 3.0 mm above the board) | 22 µF 0805 (1.25 mm), SOT-23-5 (1.45), 1812 PTC (≤ 1.5) | HW-MECH-02 |
| BR-HT-02 | Top side with a lid pocket | ≤ 3.8 mm | USB-C J1 (3.26 mm), WROOM-1U | HW-MECH-02 |
| BR-HT-03 | Under the e-ink panel | ≤ 2.8 mm | e-ink boost L3 (SWPA4020 2.0 mm) | HW-MECH-02 |
| BR-HT-04 | Bottom side | ≤ 9.0 mm (10.0 mm to the floor, proto box since H5) | handset jack J7 (4.0 mm), JST-PH J2/J4, side switches SW3–SW5, hot-swap sockets, SK6812MINI-E | HW-MECH-02 |
| BR-HT-05 | Bottom, under the speaker | ≤ 1.0 mm | nothing but passives; the SP-2040 is 8.4 mm deep (spec rev B p1) and fits since the box floor space grew to 10.0 mm (H5, `make proto`) | HW-MECH-02, HW-ELEC-14 |

## 11. Connector and opening positions for the prototype box

Source of truth: `enclosure/proto_box.py` (H5) and, after H6, `layout/placement.yaml` (it still
has the USB-C J7 and the old light holes until the layout is redone). PROTO_BOX.md follows
proto_box.py since H5 (F-22 closed).

| ID | Item | Board position (mm, x right, y down from the rear edge) | Box feature | Req. |
|---|---|---|---|---|
| BR-BOX-01 | Handset jack J7 (H5) | rear edge, x 153.8, **bottom side**, plug axis ≈ 2.0 mm below the board (UNVERIFIED, sample) | rear-wall round opening Ø8.0 (plug overmolds ≤ 7.6 mm reach the jack face) | HW-MECH-03, HW-FUNC-06 |
| BR-BOX-02 | Power USB-C J1 (power + flashing/console) | right edge, y 40.0, top side | right-wall opening 12.8 × 7.2 + recess | HW-MECH-03, HW-FUNC-15 |
| BR-BOX-03 | VOL− / VOL+ / MUTE | right edge (bottom side), y 70.8 / 62.8 / 51.3 (MUTE body centred on 53.8) | Ø4 / Ø4 / 9 × 4 slot | HW-MECH-03, HW-FUNC-09, -10 |
| BR-BOX-04 | RESET / BOOT | (158.5, 12.5) / (158.5, 20.8) | Ø1.6 pinholes | HW-FUNC-16 |
| BR-BOX-05 | ~~Base mic MK1~~ | **superseded** (D15): no base mic, no pinhole | — | — |
| BR-BOX-06 | Light holes | status SK6812 (127.0, 62.8) Ø3.2; **mic lights** (158.5, 67.5) slot 4.6 × 2.0 for the two LEDs; ALS (140.0, 63.6) Ø2; **recording light** (158.5, 77.0) Ø2 (9.5 mm from the mic lights) | lid holes | HW-PRIV-02, -05, HW-FUNC-11, -12 |
| BR-BOX-07 | Hook sockets | (9.0, 18.8) and (171.0, 18.8) over U10; **captive** plunger (sleeve flange under the lid, top lip, retainer with a Ø2 magnet cage), plunger travel **10 mm**, magnet 2.0 mm above U10 pressed (D3, D8) | lid collar, sleeve, retainer | HW-FUNC-08, HW-MECH-07, -09, HW-SAFE-04 |
| BR-BOX-08 | Internal connectors | battery J2 (150, 46) bottom; speaker J4 (108, 60) bottom; e-ink ZIF J6 (119.4, 43.8) | cable slack, pack pocket | HW-MECH-03 |
| BR-BOX-09 | Antenna | U.FL at the module's bottom edge; a general-purpose 2.4 GHz IPEX antenna on the shell wall ≥ 15 mm from metal (same type, gain ≤ 2.33 dBi for the modular grant, D19) | wall pad | HW-MECH-04 |
