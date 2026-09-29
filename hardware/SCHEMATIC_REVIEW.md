# H5 schematic review

Status: **2026-09-30, H5 (schematic revision; no PCB layout).** This reviews the SKiDL schematic
as built (`schematic/`, `make build` → `build/main/`) against every requirement in
[REQUIREMENTS.md](REQUIREMENTS.md) (draft 3) and every layout-checklist item in
[BOARD_REQUIREMENTS.md](BOARD_REQUIREMENTS.md) (draft 2). It implements the H4 change list
([sim/FINDINGS-H4.md](sim/FINDINGS-H4.md)) and the owner's second batch of decisions of
2026-09-30 (REQUIREMENTS §0 **D14–D21**): analog 3.5 mm handset jack instead of the USB-C handset,
no base mic or speakerphone, hardware privacy re-based on the handset mic, 3V3 at 3.19 V, the
SP-2040 speaker, a general-purpose IPEX antenna, and the rest of the H4/H2 list.
License CERN-OHL-S-2.0.

**Verdicts:** **met** — the schematic satisfies it, with the evidence named; **met (changed)** —
the requirement was rewritten by an owner decision and the new text is met; **N/A** — superseded
or no longer applicable; **open** — needs a sample, the layout (H6), EVT or an owner answer;
**not met** — the schematic does not satisfy it.

**Evidence sources:** `build/main/checks.txt` (custom checks), `build/main/erc.txt` (SKiDL ERC),
`build/main/bom.csv` / `cost.txt`, `build/sim/report.md` (`make sim`, benches b01–b11),
`enclosure/build/proto/checks.txt` (`make proto`), `build/review/schematic.pdf` (`make review`,
one sheet per block), the component files in [components/](components/README.md) (datasheet
pages), and the netlist itself.

## 1. Results at a glance

| | Before H5 (H3 schematic) | After H5 |
|---|---|---|
| Parts (incl. test pads, net ties) | 241 | **220** |
| Fitted parts / BOM lines | 228 / 73 | **208 / 70** |
| JLC extended lines | 35 | **34** |
| Board parts at 1k / 10k | $16.49 / $15.82 | **$13.97 / $13.25** |
| Per phone at 1k / 10k (with PCB, assembly, off-board incl. handset) | $39.63 / $37.88 | **$34.61 / $32.81** |
| One-off, JLC PCBA reference (2 built) / OSH Park + hand | $204.49 / $333.10 | **$197.61 / $328.02** |
| ERC | 0 errors, 9 warnings | **0 errors, 8 warnings** (5 open-drain → GPIO, 3 free pads IO3/IO9/IO46) |
| Custom checks | 0 errors | **0 errors**, 10 WARN (7 `[UNVERIFIED]` notes, the coil has no LCSC code, U0TXD/U0RXD reach only their recovery pads) |
| `make sim` (H5 verdict) | exit 1 (b07) | **exit 0: all 11 benches PASS** |
| `make proto` | pass | **pass**, 1 WARN (J7 in the H3 board data) |

**Removed:** USB-C J7 (handset), SY6280, 2 × B5819W, the handset SRV05-4, CH340C + 2 × MMBT3904
auto-reset, ES7210, the base electret MK1 with its bias/RF parts, the AEC loopback divider, the
MMBT3904 privacy-LED sense, LIS2DH12 + its N-FET, the 100 µF VSYS bulk, one 22 µF (3V3), the
10 µF on 3V0, one 10 µF at BQ24074 OUT, 2 × 22 µF VLED bulk, SMD1206P150TFT, DRV5032FA,
ST25DV04K-IER6S3, Kailh CPG151101S11-16. **Added:** PJ-31060 jack J7, 2 × PESD5V0S2BT, 1N4148W,
TS5A3166 earpiece switch, the privacy chain (Q5 AO3401A, Q6 AO3400A, 100 Ω / 10 µF / 100 kΩ /
100 nF), a second mic light and the recording light (+ their resistors), the jack's RC/bias/sense
parts, the HOOK RC and pull-up, the LED soft start (47 kΩ + 4.7 nF), 12 pF NFC tuning (fitted),
105 k / 24.3 k 0.1 % divider, SMD1812P200TF/16, DRV5032AJ, ST25DV04KC-IE6S3, CPG151101S11-2,
an FB on the mic line, a MIC_VCC test pad. **Changed:** NS4150B R_IN 150 k → 68 k; speaker 4 Ω
3 W → Soberton SP-2040 8 Ω 1 W (off-board).

New part choices and their datasheet evidence: [components/pj-31060.md](components/pj-31060.md)
(HOOYA drawing rev A2 p1), [pesd5v0s2bt.md](components/pesd5v0s2bt.md) (Nexperia 2018 p1–p4),
[1n4148w.md](components/1n4148w.md) (Semtech Electronics rev 05 p1),
[ts5a3166.md](components/ts5a3166.md) (TI SCDS186E p3–4),
[smd1812p200tf16.md](components/smd1812p200tf16.md) (Ruilon SP-PTC-008 A6 p4, p6);
DRV5032AJ (TI SLVSDC7H p6), ST25DV04KC (ST DS13519 rev 4 p1, p4, p165), the ES8311's headphone
drive (ES8311 User Guide rev 1.11 p2), the SP-2040 (Soberton spec rev B p1).

## 2. Design notes for the H5 blocks

**Handset jack (J7, CTIA).** T and R1 both carry the earpiece (22 Ω each, so a mono handset on
the tip, a handset with both contacts joined, or a stereo headset all work); R2 is the handset
ground, tied to GND at the jack only; S is the mic. The ES8311's OUTP drives the earpiece
single-ended (0.455 Vrms at full scale); the ES8311 is specified for 16/32 Ω headphone loads (User
Guide p2), so **no headphone driver was added**: b04 gives 2.1 mW / **98 dB SPL** into an assumed
32 Ω, 95 dB/mW receiver, 24 mA peak worst case (≤ the rated 16 Ω load). Earpiece-vs-speaker
routing is by **HOOK in hardware** (TS5A3166 closed only off hook: −52 dB leak while the speaker
rings) plus PA_EN in firmware. The 22 kΩ bypass across the switch keeps the coupling caps at VMID
(91 µV click on lift).

**Button, plug type, insertion.** Insertion: the jack's normally-closed tip contact TN (low with
no plug through the 10 kΩ tip bleed, 33 mV; high with a plug). Inline button and OMTP: the mic
line is read on IO10 (ADC1) through a 1N4148W and 100 kΩ — mic ≥ 1.37 V, button/OMTP ≤ 0.01 V
(b04). **OMTP is detected, not switched** (S meets the plug's ground: indistinguishable from a
held button except that it persists from insertion; firmware tells the user to use a CTIA
adapter). Both readings need the mic supply, i.e. off hook and unmuted — by design.

**AEC.** With no speakerphone, the only echo path is inside the handset (receiver → mic). No
hardware reference is needed; if EVT measures too much coupling, ESP-SR AEC can use the playback
stream as its reference because one codec with one I2S clock makes it sample-synchronous.
**Confirmed and simplified:** the ES7210 CH3 loopback is gone.

**Privacy chain (HW-PRIV-01…03).** 3V0 → 100 Ω / 10 µF → MUTE pole A (MIC_M) → Q5 (P-FET, gate
100 kΩ to MIC_M) → MIC_VCC (100 nF) → two mic lights (1 kΩ each) and the 2.2 kΩ bias. Q6 (N-FET,
gate = HOOK) pulls Q5's gate low only off hook. HOOK = DRV5032AJ (open drain) through 100 Ω, 100 kΩ
pull-up, 1 nF; the ESP32 reads it through **47 kΩ** on IO17, so a GPIO driven high holds HOOK at
20 mV against the sensor (b05) — below Q6's 0.65 V minimum threshold. `check_privacy` proves on
every build that no GPIO has a DC path into the mic supply or mic line (diodes one way, every
switch and FET channel taken as closed) and that the chain's structure is intact; it was
mutation-tested (a reversed D9, or HOOK through 1 kΩ with Q5 moved before MUTE, each fail the
build). **FMEA (b05):** one LED open or shorted, Q5 or Q6 shorted: the mic is either unpowered
or at least one light carries ≥ 0.2 mA — no single fault in the chain leaves the mic powered
with the lights dark. **Residual single fault outside the chain:** a *shorted* 1 µF MIC1P
coupling capacitor would let the ES8311 input (6 kΩ to VMID) weakly bias the capsule with the
lights dark; it needs a component fault *and* firmware enabling the ADC (owner question 6).

**3V3, VSYS, LEDs, NFC, hook.** As the H4 benches prescribed: 3.19 V (b02: 3.022–3.287 V worst
case), VSYS 44.5 µF (b01), LED soft start (b09: 85 mA inrush), 12 pF NFC tuning (b08; the 7-turn
coil footprint is an H6 change), DRV5032AJ with a 10 mm captive plunger (b11: 3.3×/3.3×).

## 3. REQUIREMENTS.md, item by item

| ID | Verdict | Evidence |
|---|---|---|
| HW-FUNC-01 | met | 12 × SW6–SW17 on AW9523B U17 ports per `ui.AW_PORTS`, 10 kΩ pull-ups (netlist, review sheet 8) |
| HW-FUNC-02 | met | 13 × SK6812MINI-E on VLED; Q2/Q3 from AW9523B P1_7 with 100 kΩ pull-down, soft start (b09) |
| HW-FUNC-03 | met / open | J6 FPC-05F-24PH20 + GD reference boost, BS1 = GND; FPC land and contact side need a sample (F-12) |
| HW-FUNC-04 | met (changed) | NS4150B U9, CTRL = PA_EN with 100 kΩ pull-down, R_IN 68 kΩ; ringer and prompts only (D15) |
| HW-FUNC-05 | N/A | superseded (D15): no base mic, no AEC reference |
| HW-FUNC-06 | met (changed) | J7 PJ-31060 CTIA, earpiece from ES8311 OUTP, mic into MIC1P/N, bias from MIC_VCC (b04); pad mapping on a sample: open (Q1) |
| HW-FUNC-07 | met / open | ST25DV04KC U19 + coil + 12 pF C62; read range in EVT; coil footprint to 7 turns in H6 |
| HW-FUNC-08 | met | DRV5032AJ U10, 100 kΩ pull-up (checks: HOOK_IN on RTC GPIO17); b11 3.3×/3.3× |
| HW-FUNC-09 | met (changed) | SW5 pole A = MIC_F → MIC_M (handset-mic supply), pole B → MUTE_SENSE (AW9523B); pole-B polarity on a sample (F-15) |
| HW-FUNC-10 | met | SW3/SW4 → AW9523B, 10 kΩ pull-ups, SRV05-4 D4 |
| HW-FUNC-11 | met (changed) | status pixel D-chain end; D21/D22 on MIC_VCC; D23 on IO13 (checks: `check_privacy` "2 mic lights") |
| HW-FUNC-12 | met | LTR-303ALS U18 at 0x29 |
| HW-FUNC-13 | met / open | BQ24074 + JST-PH-3 J2 + MAX17048; pack pinout/NTC spec open (F-10) |
| HW-FUNC-14 | met / open | WROOM-1U U1 (U.FL); shipped antenna to choose within the grant (HW-MECH-04) |
| HW-FUNC-15 | met (changed) | J1 D+/D− → D1 → 0 Ω → IO19/IO20 (pin_table.yaml), UART0/EN/BOOT pads (TP) |
| HW-FUNC-16 | met | SW1/SW2 pinhole tacts only |
| HW-FUNC-17 | met | removed: no accelerometer in the BOM |
| HW-FUNC-18 | met (new) | TN → 1 kΩ → IO12 (JACK_DET); S → 1N4148W → 100 kΩ → IO10 ADC1; b04 levels and 11.5 ms button response |
| HW-ELEC-01 | met | 2 × 5.1 kΩ Rd on J1 CC1/CC2 |
| HW-ELEC-02 | met | CC1/CC2 → 1 kΩ → IO8/IO6 (ADC1; check_pin_table adc1) |
| HW-ELEC-03 | met | `check_power_budget`: reduced mode 491 mA peak on a 500 mA source |
| HW-ELEC-04 | met | SMF5.0A D3, SMD1812P200TF/16 (1.80 A at 40 °C vs 1.56 A, b01), BQ24074 ILIM 1.1 kΩ (guaranteed 1350 mA) |
| HW-ELEC-05 | met (changed) | power_budget.yaml H5 rows: worst capped 992 mA (27 % headroom), uncapped 1323 mA < 1350 mA |
| HW-ELEC-06 | met by analysis | b10: 1.04 Wh needed for 8 h + 1 h vs 2.20 Wh usable (with the battery power policy) |
| HW-ELEC-07 | met (sim) / open (EVT) | b02 averaged model: ≥ 3.022 V under a 500 mA step |
| HW-ELEC-08 | met | 105 k / 24.3 k 0.1 % (R12, R13): ≤ 3.287 V worst case (b02) |
| HW-ELEC-09 | met | 3V0 C_OUT 2.1 µF (b03: in range; PSRR 79 dB at 1 kHz) |
| HW-ELEC-10 | met | `check_power_budget`: VSYS ≤ 4.5 V vs lowest rating 5.25 V |
| HW-ELEC-11 | met | pin_table straps (IO0 pull-up, IO45 pull-down, IO3/IO46 open); PA_EN, LED_PWR_EN pull-downs; earpiece/mic off on hook (HOOK) |
| HW-ELEC-12 | met by analysis / open | charger Tj ≈ 78 °C at the worst capped load, 0.84 W (checks.txt); thermal camera in EVT |
| HW-ELEC-13 | met (changed, assumptions) | b07: 57.8 dBA at PGA 18 dB with the assumed capsule; board takes 0.7 dB (≤ 1.5); 53.8 dBA at PGA 0 dB (Q4) |
| HW-ELEC-14 | met (changed) | b06: 77 dBA at 1 m (1 W cap, SP-2040, R_IN 68 kΩ); no speakerphone target |
| HW-ELEC-15 | N/A | superseded (D15) |
| HW-ELEC-16 | N/A | the ES8311's only input is used; no ES7210 |
| HW-ELEC-17 | met (changed) | b05: MIC_VCC up/down in < 1 ms of HOOK; b04: 91 µV click; sensor latency ≤ 75 ms |
| HW-ELEC-18 | open (H6) | one pair, nets USB_DP/DN(_C); routing rules in BR-STK-02/-03 |
| HW-ELEC-19 | N/A | superseded (D14, D20) |
| HW-ELEC-20 | N/A | superseded (D14) |
| HW-ELEC-21 | met / open | unique addresses 0x18/0x29/0x36/0x53/0x57/0x58 (check_i2c_union); rise time to measure (F-20) |
| HW-ELEC-22 | met / open | TVS at every entry: J1 (D1, D2, D3), J7 (D7, D8), side switches (D4); hook post grounding (F-13, H6/enclosure) |
| HW-ELEC-23 | met | JACK_DET 1 kΩ, MIC_SENSE diode + 100 kΩ, HOOK_IN 47 kΩ, CC 1 kΩ, keys/side switches only to the AW9523B |
| HW-ELEC-24 | met (sim) | b02: 1.4 / 17 mV p-p ripple |
| HW-ELEC-25 | N/A | superseded (D14) |
| HW-ELEC-26 | met (new, assumptions) | b04: 98 dB SPL, ±3 dB 100 Hz–7 kHz (−1.8 dB at 100 Hz), 24 mA peak, −52 dB on hook, 91 µV click |
| HW-ELEC-27 | met (new) | b04: 1.32 mA into a shorted S; 22 Ω per earpiece contact |
| HW-PRIV-01 | met | MUTE pole A is the only path from MIC_F to MIC_M (`check_privacy`), b05 mute transient |
| HW-PRIV-02 | met | two lights on MIC_VCC, ≤ 1 µF on MIC_VCC, FMEA (b05) |
| HW-PRIV-03 | met | Q5/Q6 on HOOK after MUTE; IO17 through 47 kΩ, IO10 through a diode (`check_privacy`, b04, b05) |
| HW-PRIV-04 | met | no camera/radar/imaging sensor in the BOM |
| HW-PRIV-05 | met | D23 + 680 Ω on IO13 (pin_table.yaml) |
| HW-PRIV-06 | met by design / open | native USB device on J1 keeps secure download; fixture test open |
| HW-PRIV-07 | open (H6) | silkscreen: `layout/boards.yaml` (text size BR-KO-03) |
| HW-SAFE-01 | met | USB-only supply; e-ink rails internal |
| HW-SAFE-02 | open | keyed JST-PH-3, pinout silkscreen and pack spec (F-10) |
| HW-SAFE-03 | met (changed) | PTC + ILIM on the input; jack lines passively limited |
| HW-SAFE-04 | met (proto) / open (product) | captive plunger + caged magnet (`make proto` "captive plunger + magnet" PASS) |
| HW-SAFE-05 | open (EVT) | measure |
| HW-MECH-01 | met / H6 | outline and holes unchanged (`layout/boards.yaml`) |
| HW-MECH-02 | met (changed) | proto box: 10 mm under the board, SP-2040 8.4 mm and the 4.0 mm jack fit (`make proto`) |
| HW-MECH-03 | open (H6) | positions set in proto_box.py / BOARD_REQUIREMENTS; placement.yaml still H3 |
| HW-MECH-04 | open | caveat documented (DESIGN §4); shipped antenna to pick (Q3) |
| HW-MECH-05 | met / H6 | key grid unchanged (`make proto` key grid PASS on H3 data) |
| HW-MECH-06 | open (H6) | J7 is SMD with two pegs: a hole within 10 mm and a wall boss behind the plug |
| HW-MECH-07 | met | 2.0 mm gap, 10 mm travel (`make proto` hook geometry) |
| HW-MECH-08 | open (H6) | NFC keep-out (layout checks) |
| HW-MECH-09 | met (proto) | sleeve flange under the lid, lip Ø7.4 vs flange Ø9.4, cage Ø2 vs magnet Ø3 |
| HW-ENV-01 | met | fitted parts ≥ 0…40 °C (PJ-31060: UNVERIFIED rating, typical −20…+70 °C for the family) |
| HW-ENV-02 | met | unchanged |
| HW-ENV-03 | open (DVT) | — |
| HW-ENV-04 | open (DVT) | jack life on a sample |
| HW-REG-01 | open | antenna choice (F-02), pre-scan at DVT |
| HW-REG-02 | open | — |
| HW-REG-03 | open | antenna type/gain; EN 18031 |
| HW-REG-04 | met | new parts are RoHS per their LCSC listings |
| HW-REG-05 | met (proto) / open | captive magnet; certification later (D11) |
| HW-REG-06 | open | no pack chosen |
| HW-MFG-01 | open (H6) | fab outputs come from the layout |
| HW-MFG-02 | **not met** | 34 extended lines vs ≤ 25 (F-23; owner question 2) |
| HW-MFG-03 | met / open | every new part ≥ 2 500 JLC stock (TS5A3166 the thinnest); BQ24074 and SWPA4020S470MT alternates listed |
| HW-MFG-04 | met | $34.61 / $32.81; one-off $197.61 |
| HW-MFG-05 | met | the iron-only electret is gone; smallest parts 0603, SC-70 |
| HW-MFG-06 | met | TPs VBUS, VSYS, 3V3, 3V0, MIC_VCC, GND × 2, U0TXD, U0RXD, EN, BOOT |
| HW-MFG-07 | met (docs) | ASSEMBLY.md MSL notes |

## 4. BOARD_REQUIREMENTS.md, item by item

The layout checklist is judged here only for what the **schematic** must provide (parts, values,
nets, refs); geometry and routing are **H6**.

| ID | Verdict | Schematic evidence / what H6 must do |
|---|---|---|
| BR-PWR-01 | met | J1 → F1 (2 A) → D3 → U2 IN; 10 µF + 1 µF on VBUS (b01 attach 5.8 µF eff.) |
| BR-PWR-02 | met | VSYS 44.5 µF nominal (C at U2 OUT, buck in, LDO in, 22 µF + 1 µF at U9) |
| BR-PWR-03 | met | 105 k / 24.3 k at U3 FB; 22 µF at the buck, 22 µF + 100 nF at U1 |
| BR-PWR-04 | met | 3V0 2.1 µF |
| BR-PWR-05 | met | MIC_F/MIC_M/MIC_VCC chain, 100 nF only on MIC_VCC |
| BR-PWR-06 | met | Q2 with 47 kΩ + 4.7 nF, 10 µF VLED bulk |
| BR-PWR-07 | N/A | superseded |
| BR-PWR-08 | met | J2 on VBAT; MAX17048 CELL on VBAT |
| BR-STK-01…03 | H6 | one USB pair (USB_DP/DN, USB_DP_C/DN_C) |
| BR-NET-01…08, BR-VIA-01 | H6 | net lists updated for H5 (Audio, USB, Power classes) |
| BR-KO-01 | met / H6 | U19 + C62 exist; coil footprint → 7 turns in H6 |
| BR-KO-02, -03, -04, -06 | H6 | — |
| BR-KO-05 | H6 | Ø11 retainer zone over U10: top parts ≤ 2.2 mm (U10's own 100 nF, 100 Ω, 1 nF are 0603) |
| BR-KO-07 | N/A → jack path | J7 pads, pegs and the Ø8 plug path |
| BR-PL-01, -02, -08, -09, -10 | H6 | refs unchanged (U1, J1, D1–D3, F1, U2, U3, U14, J2, U17, U5, Q2, Q3, U19) |
| BR-PL-03 | N/A | superseded |
| BR-PL-04 | H6 | new block: J7, D7, D8, D9, FB3, U8, 2 × 22 µF, 22 kΩ, 22 Ω × 2, 100 pF × 3 |
| BR-PL-05 | H6 | U6 + U4 only (no U7) |
| BR-PL-06 | H6 | Q5, Q6, filter near SW5; D21/D22 under one slot, D23 ≥ 8 mm away |
| BR-PL-07 | H6 | U9 ≥ 15 mm from the mic nets |
| BR-TH-01, -03 | met by analysis / H6 | copper per the table |
| BR-TH-02, -04 | N/A | superseded |
| BR-ESD-01 | met | D1 (D+/D−), D2 (CC), D3 (VBUS) |
| BR-ESD-02 | met | D7 (T/R1), D8 (S/TN), bidirectional; HS_GND net tie at the jack |
| BR-ESD-03 | met | D4 on VOL_DN/VOL_UP/MUTE_SENSE |
| BR-ESD-04 | H6 | keys reach only the AW9523B (netlist) |
| BR-ESD-05 | met | HOOK: 100 kΩ pull-up, 100 Ω series, 1 nF (U10) |
| BR-ESD-06 | met | J4 beads + 220 pF |
| BR-EMC-01, -02 | H6 | no boost loop any more |
| BR-TP-01 | met | MIC_VCC added, HS_VBUS removed |
| BR-TP-02 | met | J1 native USB; UART0/EN/BOOT pads |
| BR-TP-03 | met | nothing DNP (`check_one_bom`) |
| BR-DFM-01…06 | H6 | — |
| BR-DFA-01…03, -05 | H6 | — |
| BR-DFA-04 | met | fine-pitch list updated (no ES7210, LIS2DH12, electret) |
| BR-HT-01…05 | met (box) / H6 | `make proto`: jack 4.0 mm bottom, SP-2040 under 10 mm |
| BR-BOX-01…09 | met (box) / H6 | `make proto` PASS; J7 WARN until the board is re-placed |

## 5. Open items and owner questions before H6

1. **Jack sample:** measure a HOOYA PJ-31060 (C2939583): the mapping of its terminals 1–6 to
   the KiCad PJ31060-I pads T/TN/R1/R1N/R2/S, and the plug-axis height (the box assumes 2.0 mm
   below the board). Alternatively name a jack with a published pin table.
2. **Extended parts 34 > 25 (HW-MFG-02):** accept (≈ $3 each on a small JLC order), or trade:
   e.g. drop the TS5A3166 and accept the ringer in the earpiece on hook (not recommended), or ask
   for a basic-library bidirectional ESD part. The 0.1 % divider (2 lines) is owner-mandated.
3. **Antenna:** pick the shipped IPEX antenna (same type as the certification monopole,
   ≤ 2.33 dBi) so the product stays inside the WROOM-1U grant (F-02).
4. **Handset mic SNR (b07):** the pass rests on an assumed capsule and on Everest's qualitative
   PGA-noise statement. Accept "board takes ≤ 1.5 dB" as the requirement and measure the
   Opis 60s Micro in EVT, or require handsets with a published mic spec.
5. **Button and OMTP only while the mic is powered** (off hook, unmuted): a consequence of the
   privacy rule (any sense current could power the capsule). OK?
6. **Coupling-capacitor fault path:** a shorted 1 µF MIC1P cap could let the codec input weakly
   bias the capsule with the lights dark (needs that fault plus firmware). Close it with two
   caps in series (+1 part) in H6?
7. **Box height:** the SP-2040 (8.4 mm) grew the prototype box from 15.6 to 18.6 mm; carry the
   same under-board depth into the product enclosure budget (≈ 33 mm base)?
8. **Earpiece level cap:** full scale reaches ≈ 98 dB SPL with the assumed receiver; set a
   firmware maximum (e.g. −6 dBFS) until the Opis receiver is measured?
