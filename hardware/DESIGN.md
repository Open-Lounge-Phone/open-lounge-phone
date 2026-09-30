# Open Lounge Phone hardware design: the minimal board (M1)

**Owner decision 2026-09-30:** the earlier 220-part board (charger, fuel gauge, I/O expander,
13 RGB LEDs, e-ink FPC with its boost, NFC, hall hook sensor, hardware privacy chain, mute
switch, speaker amplifier) was rejected as over-engineered. This is the fresh start: **core only
plus one status LED**, 53 parts on a 2-layer board. The old design is in git history
(`hardware/` before this commit). License CERN-OHL-S-2.0.

Status: **M1 = schematic only** (SKiDL, `make build` checks it). M2 = placement and layout.

## 1. What is on the board

| Block | Parts | Ref |
|---|---|---|
| MCU | ESP32-S3-WROOM-1U-N16R8 (U.FL antenna), EN RC reset, RESET and BOOT buttons | U1, SW1, SW2 |
| Power | USB-C receptacle (5 V + native USB), 2 × 5.1 kΩ CC, one USB ESD part, one 3.3 V LDO | J1, D1, U2 |
| Keys | 12 MX switches in Kailh-style hot-swap sockets, each on its own GPIO | SW3-SW14 |
| Hook | one more MX switch in a hot-swap socket, pressed by the hook plunger | SW15 |
| Display | 1x8 pin header for a ready-made SPI display module | J3 |
| Handset | 3.5 mm TRRS jack (CTIA) + ES8311 codec with its reference parts | J2, U3 |
| Ringer | piezo buzzer on one GPIO through an NPN | BZ1, Q1 |
| Status | one LED + resistor | D2 |
| Board | 4 × M3 holes, the signature logo and "Open Lounge Phone" on the silkscreen | H1-H4, G1, G2 |

**Not on the board** (owner, don't add): NFC, battery/charger/fuel gauge, per-key LEDs, I/O
expander, hall sensor and magnet, privacy-light circuits, mute switch, speaker and amplifier,
accelerometer, radar, extra ESD networks, test-pad farms, level shifters.

```
USB-C J1 ── VBUS 5 V ──┬── 10 µF ── SGM2212-3.3 U2 ── 3V3 ──┬── ESP32-S3-WROOM-1U U1 (22 µF + 100 nF)
   │ CC1/CC2: 5.1k Rd  │                                  ├── ES8311 U3 ── TRRS jack J2 (handset)
   │                   └── piezo BZ1 ← Q1 ← IO45          ├── display header J3 ← SPI (IO38-42, 48)
   └── D+/D- ── USBLC6 D1 ── IO20/IO19 (native USB)       └── status LED D2 ← IO44
12 keys + hook: MX sockets SW3-SW15, GPIO ↔ GND, internal pull-ups
```

## 2. Power

- **USB-C sink**, 5.1 kΩ Rd on CC1 and CC2: any USB-C source (or USB-A to C cable) gives 5 V at
  USB default power (500 mA). No PD, no CC sensing.
- **No fuse.** A compliant USB source limits its own VBUS current; the board has no battery and
  nothing that stores energy beyond ~35 µF; the LDO limits its output current (≥ 810 mA) and
  shuts down at 165 °C (SGM2212 [p6], [p10]). A PTC would only add a part and a voltage drop.
- **One regulator: SGM2212-3.3** (800 mA LDO, SOT-223, ceramic-stable). Datasheet (rev A.2):
  https://datasheet.lcsc.com/datasheet/pdf/6f07bb879ae0c9e810e5cf5bf8b1cedc.pdf
  - Sizing: the ESP32-S3-WROOM-1 datasheet v1.8 asks for a supply that delivers **≥ 0.5 A**
    ([p27]); Wi-Fi TX peaks at **355 mA** ([p28]). 3V3 peak ≈ 450 mA (module 355 + codec and
    earpiece 30 + display allowance 60 + bias, pull-ups, LED 4) against **800 mA** rated ([p1])
    leaves > 20 % margin.
  - Dropout (3.3 V version, full temperature): 380 mV at 500 mA, 610 mV at 800 mA ([p6]). At
    the lowest USB voltage at a device (4.40 V) the headroom is 0.72 V.
  - Heat: average in a call ≈ 200 mA → (5.25 − 3.3) V × 0.2 A = 0.39 W; θJA 117 °C/W ([p3]) →
    Tj ≈ 86 °C at 40 °C ambient (limit 125 °C).
  - Capacitors: C_IN 10 µF (≥ 2.2 µF, [p10]; ≤ 10 µF USB attach limit); C_OUT 2.2 µF at the
    LDO ([p10]) plus 22 µF + 100 nF at the module pin (WROOM-1 [p41]). Effective ≈ 14 µF after
    DC bias: [p10] says larger C_OUT improves the load transient; [p4] recommends 1-10 µF
    effective, so M2 places the 22 µF at the module, not at the LDO.
  - Rejected: the JLC-basic **AMS1117-3.3** needs a 22 µF tantalum output capacitor for
    stability (AMS DS1117 [p4]) and drops 1.1-1.3 V; a buck converter adds an inductor and
    extended parts for ~0.3 W saved.
- **Checked on every build:** `schematic/power_budget.yaml` + `check_power_budget` (peak vs
  rating with 20 % margin, USB 500 mA, dropout headroom at 4.40 V, junction temperature).
  **Simulated:** `make sim` b01 (hot-plug start-up before the EN delay, a 60 → 400 mA Wi-Fi
  burst at VBUS 4.40 V: 3V3 ≥ 3.13 V at the module in the pessimistic corner, window 3.0-3.6 V).
- The piezo runs from VBUS directly (5 V, a few mA), off the 3V3 rail.

## 3. MCU

**ESP32-S3-WROOM-1U-N16R8** (C3013946; 16 MB flash, 8 MB octal PSRAM) with a U.FL connector
and a general-purpose 2.4 GHz antenna, user-upgradable (owner 2026-09-30). The plug-in antenna
frees the module from the board-edge antenna keep-out. Datasheet v1.8:
https://www.espressif.com/sites/default/files/documentation/esp32-s3-wroom-1_wroom-1u_datasheet_en.pdf

- Peripheral circuit per [p41]: 22 µF + 100 nF at 3V3, EN = 10 kΩ pull-up + 1 µF RC delay,
  RESET button (SW1) from EN to GND.
- **BOOT** (SW2) pulls GPIO0 low; GPIO0's internal weak pull-up is the default SPI-boot level
  ([p13]), so no external resistor. Hold BOOT and press RESET for download mode ([p14]).
- **Native USB** on IO19 (D−) / IO20 (D+) through the USBLC6-2SC6: flashing and the
  USB-Serial-JTAG console with any USB cable. UART0 (IO43/44) is not brought out; IO44 drives
  the status LED, IO43 is free.
- Module ambient rating −40 … +65 °C (N16R8, [p3]).
- Antenna: the module's certification assumes the same antenna type with gain ≤ 2.33 dBi
  ([p44]); another type may need extra radio/EMC testing. The shipped antenna is not chosen yet.

## 4. GPIO map

`schematic/pin_table.yaml` is the source; `make build` fails if the schematic differs, a GPIO
not in the table is connected, or a strap rule breaks. 32 of 33 usable GPIOs are used.

| GPIO | Net | | GPIO | Net |
|---|---|---|---|---|
| 0 | BOOT (strap, button to GND) | | 21 | I2S_DOUT → ES8311 DSDIN |
| 1 | I2C_SDA (4.7 kΩ) | | 35-37 | unconnected (octal PSRAM) |
| 2 | I2C_SCL (4.7 kΩ) | | 38 | EPD_DIN |
| 3 | KEY_9 (strap, key to GND) | | 39 | EPD_CLK |
| 4, 5, 6, 7 | KEY_1, KEY_2, KEY_3, KEY_4 | | 40 | EPD_CS |
| 15, 16 | KEY_5, KEY_MENU | | 41 | EPD_DC |
| 17, 18, 8 | KEY_6, KEY_7, KEY_8 | | 42 | EPD_RST |
| 9 | KEY_BACK | | 43 | free (TXD0: ROM boot log) |
| 10 | HOOK (low = on the hook) | | 44 | STATUS_LED (RXD0) |
| 11 | JACK_DET (high = plug in) | | 45 | BUZZER (strap, NPN base) |
| 12, 13, 14 | I2S_MCLK, I2S_BCLK, I2S_WS | | 46 | KEY_0 (strap, key to GND) |
| 19, 20 | USB D−, D+ | | 47 | I2S_DIN ← ES8311 ASDOUT |
| | | | 48 | EPD_BUSY |

**Strapping pins** (S3: GPIO0/3/45/46, [p13-15]). GPIO45 (VDD_SPI) and GPIO46 (boot mode) have
weak pull-downs and must be low at reset for this 3.3 V-flash module; the key on GPIO46 and the
transistor base on GPIO45 can only pull low, never high, so they cannot upset the boot (checked
by `check_pin_table`). GPIO3 is only read if EFUSE_STRAP_JTAG_SEL is burned ([p15]); its key
leaves it low or floating. Every key and the hook are on RTC GPIOs (0-21), so any of them can
wake the chip from deep sleep.

## 5. Keys and hook

- **Keys:** 12 MX switches, two rows of six at 19.05 mm: `1 2 3 4 5 MENU` (rear) and
  `6 7 8 9 0 BACK` (front). Each hot-swap socket (HanElectricity CPG151101S11-2, the Kailh
  CPG151101S11 land) connects its GPIO to GND; the GPIO's internal pull-up and firmware
  debounce do the rest. No expander, no matrix, no diodes, no series resistors (the switch
  contacts are inside the switch housing, not user-reachable).
- **Hook:** a 13th MX switch in the same socket, under the hook rest's plunger. The handset's
  weight presses it (on hook = HOOK low). One more of a part already on the board, 4 mm travel
  with actuation at ~2 mm, millions of cycles, and replaceable. The plunger must travel ≥ 2 mm
  and stop within 4 mm (enclosure, M2). A heavier switch (60-80 gf) returns the plunger
  briskly. Alternative if the rest cannot host an MX switch: a lever microswitch on the same
  two nets (e.g. Omron SS-5GL, C93981).

## 6. Display: a module on a header

The board carries only **J3, a 1x8 2.54 mm pin header** in the pin order of the Waveshare 2.9"
e-Paper module: **1 VCC (3V3), 2 GND, 3 DIN, 4 CLK, 5 CS, 6 DC, 7 RST, 8 BUSY**. The module
has its own driver, boost and level handling; firmware drives it over SPI (IO38-42, IO48).

| Module | Panel | Notes |
|---|---|---|
| **WeAct Studio 2.9" e-Paper** (standard) | 296 × 128 B/W, SSD1680 | ~$8 retail; 8-pin header (order printed on the module; jumper wires if it differs) |
| **Waveshare 2.9" e-Paper Module (V2)** | 296 × 128 B/W, SSD1680 | ~$15 retail; J3's pin order; ships a PH2.0-to-Dupont cable |
| 1.3" SPI OLED (SH1106/SSD1306) | 128 × 64 | 7 pins GND VCC CLK MOSI RES DC CS, no BUSY: jumper wires |
| 1.54"-2.0" SPI TFT (ST7789) | 240 × 240 / 240 × 320 | GND VCC SCL SDA RES DC CS BLK (BLK to 3V3): jumper wires; draws the most (budgeted 60 mA) |

A male header takes the module's cable or Dupont jumpers, so the module can sit in the lid
window wherever the enclosure wants it; `hello.display` stays `eink` for the standard module.

## 7. Handset audio: ES8311 + 3.5 mm TRRS

- **Codec:** ES8311 (Everest), datasheet rev 7.0:
  https://datasheet.lcsc.com/datasheet/pdf/333c4745650c47b22df304e43da4c3e5.pdf . The parts
  are those of its typical application circuit ([p4]): 1 µF AVDD, 100 nF DVDD and PVDD, 1 µF
  on VMID, ADCVREF, DACVREF, 1 µF coupling on MIC1P and MIC1N. All supplies on 3V3 (1.7-3.6 V,
  [p8]). CE to GND → I2C address 0x18. I2S: MCLK, BCLK, WS, DOUT, DIN; I2C with 4.7 kΩ pull-ups.
- **Jack:** PJ-31060 (CTIA): T and R1 = earpiece, R2 = GND, S = mic.
- **Earpiece:** OUTP (biased at VMID) → 22 µF → 22 Ω → T and R1 (a mono handset uses one; a
  stereo headset hears both). The ES8311 output drives 16/32 Ω headphone loads (User Guide rev
  1.11 [p2]); full scale is AVDD/3.3 Vrms = 1 Vrms ([p9]). Low corner 134 Hz into 32 + 22 Ω.
- **Mic:** the ES8311 has no MICBIAS pin, so 3V3 → 1 kΩ / 10 µF filter (16 Hz) → 2.2 kΩ →
  sleeve biases the electret; sleeve → 1 µF → MIC1P, MIC1N → 1 µF → GND (pseudo-differential,
  [p4]).
- **Insertion detect is free on this jack:** TN (the normally-closed tip contact) touches the
  tip with no plug. The tip has a 4.7 kΩ DC path to GND (which also keeps the coupling cap
  discharged), so JACK_DET (IO11 via 1 kΩ, internal pull-up) reads low with no plug and high
  with a plug.
- **Headset button:** not wired (no free hardware for it). Firmware may detect a press as a
  large transient on the mic ADC (unverified).
- OMTP plugs (mic and ground swapped) are not supported.

## 8. Ringer and status LED

- **Ringer:** TDK PS1240P02BT piezo (Ø12.2 mm, 4 kHz, external drive) from VBUS, switched by an
  MMBT3904 whose base gets IO45 through 1 kΩ; 1 kΩ across the piezo charges and discharges it.
  This is TDK's recommended drive circuit (PS series [p2]). A piezo needs no flyback diode.
  Rated 70 dB at 10 cm at 3 V; 5 V drive and a port in the enclosure help. If that is too quiet,
  a magnetic buzzer (e.g. MLT-8540H, 85 dB) fits the same transistor plus one diode.
- **Status LED:** IO44 → 1 kΩ → red 0603 LED (~1.3 mA). IO44 is an input at boot, so the LED
  stays dark until firmware lights it.

## 9. The board

- **2 layers**, FR-4 1.6 mm, 1 oz, HASL lead-free: JLCPCB's cheapest process and every other
  fab's standard. Rules: [BOARD_REQUIREMENTS.md](BOARD_REQUIREMENTS.md).
- **Proposed outline 160 × 88 mm** (fits the compact base, whose earlier board was 180 × 88).
  Why: the key rows are 6 × 19.05 = 114.3 mm wide; with the display module (≈ 80-90 × 37 mm)
  between the rows, the row centres sit ≈ 61 mm apart, so the key block is ≈ 114 × 80 mm. The
  ESP32 module, LDO, codec, USB-C and jack take a ≈ 35 mm band at one end. Placement is M2.
- **Proposed zones (for the owner to confirm in M2):** keys left, the display header between
  the rows, U1/U2/U3 and J1 (side edge) and J2 (rear edge) in the right-hand band, the hook
  socket where the hook post lands, the piezo near a grille. **All SMD parts on the bottom
  side** (the hot-swap sockets must be there anyway): one-sided assembly (JLCPCB "economic"
  PCBA) and a clean top with only the plugged switches, the header and the piezo (THT).
- **Mounting holes:** 4 × M3 (3.2 mm), one near each corner; exact spots in M2.
- **Marking:** the owner's signature logo (G1, `layout/footprints/openloungephone.pretty`) and
  "Open Lounge Phone" (G2) in a clear silkscreen area, plus "CERN-OHL-S-2.0" and the revision.

## 10. Part count and cost

From `make build` (`build/main/bom.csv`, `build/main/cost.txt`); prices are LCSC/JLCPCB
ladders, fees and the bare PCB are dated estimates in `schematic/cost_model.yaml`.

- **53 parts on 23 BOM lines** (13 hot-swap sockets, 15 capacitors, 13 resistors, 12 other
  parts), plus 4 mounting holes and 2 silkscreen items. 14 lines are JLC basic, 9 extended
  (the module, codec, LDO, USB-C, jack, sockets, ESD, header, piezo).
- **Cost per board** (PCB + parts + assembly, JLCPCB reference):
  - **1 board: $82.63** for the minimum order (5 bare PCBs, 2 assembled: $41.32 each);
    $27 of it is the extended-part fees.
  - **100 boards: $7.50** each.
  - **1000 boards: $6.07** each (parts $5.28, of which the ESP32 module is $3.43).
- **Off-board per phone** (EST): 13 MX switches, 12 keycaps, display module, antenna, handset:
  $14.49 at scale, ≈ $56 retail. Phone electronics at 1000 ≈ $20.56.

## 11. What the minimal board does and doesn't do

Does: 12 keys + hook, a display module, handset earpiece and mic through the codec, a piezo
ringer, one status LED, Wi-Fi/BLE, flashing and console over USB-C.

Doesn't (by owner decision): no **hardware mute switch**, no **mic lights wired to the mic's
power** and no separate recording light: the handset mic bias is always on while powered, and
firmware alone decides when audio is captured. No **NFC** (claiming uses the QR code or the
pairing code), no **battery** (USB power only), no **per-key LEDs** (the display and voice
prompts carry state; the emulator still shows key lights), no **speaker** (the piezo rings;
prompts play in the earpiece), no **presence radar, hall sensor, light sensor or
accelerometer**. [../docs/security-model.md](../docs/security-model.md) states what that means
for privacy.

## 12. Open questions for the owner before M2 (placement)

1. **Board size and zones:** 160 × 88 mm with the right-hand electronics band (§9)?
2. **Assembly side:** all SMD on the bottom (one-sided, cheapest PCBA)?
3. **Display:** WeAct or Waveshare 2.9" as the standard module; where it mounts (lid window) and
   where J3 sits relative to it (cable vs direct plug).
4. **Hook:** an MX switch under the plunger (proposed) or a lever microswitch; which hook post.
5. **Edges:** USB-C on the side or rear; the jack on the rear (as before)?
6. **Ringer loudness:** is the piezo (≈ 70 dB at 10 cm) enough, or a magnetic buzzer + diode?
7. **Antenna:** which 2.4 GHz U.FL antenna ships (certification caveat, §3).
8. The earlier questions that still stand: base envelope and toy classification (Kids).

## 13. Sources

- ESP32-S3-WROOM-1/1U datasheet v1.8 (Espressif): straps p13-15, supply p27, current p28,
  peripheral schematic p41, antenna p43-44.
- SGM2212 rev A.2 (SG Micro): features p1, θJA p3, pinout p4, accuracy p5, dropout/limits p6,
  load transient p7, capacitors p10.
- AMS1117 datasheet DS1117 (Advanced Monolithic Systems), p4: 22 µF tantalum output capacitor.
- ES8311 datasheet rev 7.0 (Everest): p1, p3, typical application p4, ratings p8-9; ES8311 User
  Guide rev 1.11 p2 (headphone load).
- ST USBLC6-2 datasheet p1-2; HOOYA PJ-31060 drawing rev A2 p1; TDK PS series buzzers p2;
  JSCJ MMBT3904 rev 2.1 p1; KENTO KT-0603R p2; XKB TS-1187A rev A0; HanElectricity
  CPG151101S11-2 and Kailh KH-PS2206-43 drawings p1. Links in [components/](components/README.md).
