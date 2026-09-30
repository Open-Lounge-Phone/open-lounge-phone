# Open Lounge Phone hardware design: the minimal board (M1 schematic, M2 placement)

**Owner decision 2026-09-30:** the earlier 220-part board (charger, fuel gauge, I/O expander,
13 RGB LEDs, e-ink FPC with its boost, NFC, hall hook sensor, hardware privacy chain, mute
switch, speaker amplifier) was rejected as over-engineered. This is the fresh start: **core only
plus one status LED**, 53 parts on a 2-layer board. The old design is in git history
(`hardware/` before this commit). License CERN-OHL-S-2.0.

Status: **M1 schematic** (SKiDL, `make build` checks it), **M2 placement** (`make placement`,
§9) and **M3 routing** (`make route`, `make fab`: §9a). Next: bring-up of the first boards.

## 1. What is on the board

| Block | Parts | Ref |
|---|---|---|
| MCU | ESP32-S3-WROOM-1U-N16R8 (U.FL antenna), EN RC reset, RESET and BOOT buttons | U1, SW1, SW2 |
| Power | USB-C receptacle (5 V + native USB), 2 × 5.1 kΩ CC, one USB ESD part, one 3.3 V LDO | J1, D1, U2 |
| Keys | 12 MX switches in Kailh-style hot-swap sockets, each on its own GPIO | SW3-SW14 |
| Hook | one more MX switch in a hot-swap socket, pressed by the hook plunger | SW15 |
| Display | 2x4 socket for the WeAct 2.9" e-paper module (plugs in) + 2 M3 standoff holes | J3, H5, H6 |
| Handset | 3.5 mm TRRS jack (CTIA) + ES8311 codec with its reference parts | J2, U3 |
| Ringer | piezo buzzer on one GPIO through an NPN | BZ1, Q1 |
| Status | one reverse-mount LED (shines up through a board hole) + resistor | D2 |
| Board | 4 × M3 holes, the signature logo and "Open Lounge Phone" on the silkscreen | H1-H4, G1, G2 |

**Not on the board** (owner, don't add): NFC, battery/charger/fuel gauge, per-key LEDs, I/O
expander, hall sensor and magnet, privacy-light circuits, mute switch, speaker and amplifier,
accelerometer, radar, extra ESD networks, test-pad farms, level shifters.

```
USB-C J1 ── VBUS 5 V ──┬── 10 µF ── SGM2212-3.3 U2 ── 3V3 ──┬── ESP32-S3-WROOM-1U U1 (22 µF + 100 nF)
   │ CC1/CC2: 5.1k Rd  │                                  ├── ES8311 U3 ── TRRS jack J2 (handset)
   │                   └── piezo BZ1 ← Q1 ← IO8           ├── display socket J3 ← SPI (IO13/14/21/47/48/38)
   └── D+/D- ── USBLC6 D1 ── IO20/IO19 (native USB)       └── status LED D2 ← IO1
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
  USB-Serial-JTAG console with any USB cable. UART0 is not brought out; IO43/IO44 carry keys
  6 and 7 (§4).
- Module ambient rating −40 … +65 °C (N16R8, [p3]).
- Antenna: the module's certification assumes the same antenna type with gain ≤ 2.33 dBi
  ([p44]); another type may need extra radio/EMC testing. The shipped antenna is not chosen yet.

## 4. GPIO map

`schematic/pin_table.yaml` is the source; `make build` fails if the schematic differs, a GPIO
not in the table is connected, or a strap rule breaks. 32 of 33 usable GPIOs are used (IO45 is
free). **M2 assigned every bus in the order its wires arrive** (§9): the module sits on the
bottom with its antenna end at the left edge, so its 12-pin row faces the keys, its pin-1 side
faces the rear edge and its pin-40 side the front.

| Module side | GPIO → net (in pin order) |
|---|---|
| Row, toward the keys (rear → front) | IO3 KEY_1, IO46 KEY_2, IO9 KEY_3, IO10 KEY_4, IO11 KEY_5, IO12 KEY_MENU · IO13 EPD_CLK, IO14 EPD_DIN, IO21 EPD_DC, IO47 EPD_CS, IO48 EPD_BUSY · IO45 free |
| Rear side (left → right) | IO4 JACK_DET, IO5 I2S_WS, IO6 I2S_BCLK, IO7 I2S_DIN, IO15 I2S_DOUT, IO16 I2S_MCLK, IO17 I2C_SCL, IO18 I2C_SDA, IO8 BUZZER, IO19/IO20 USB D−/D+ |
| Front side (left → right) | IO1 STATUS_LED, IO2 HOOK, IO43 KEY_6, IO44 KEY_7, IO42 KEY_8, IO41 KEY_9, IO40 KEY_0, IO39 KEY_BACK, IO38 EPD_RST, IO0 BOOT |

**Strapping pins** (S3: GPIO0/3/45/46, [p13-15]). GPIO45 (VDD_SPI) and GPIO46 (boot mode) have
weak pull-downs and must be low at reset for this 3.3 V-flash module; the key on GPIO46 can only
pull low, never high, and GPIO45 is left free (checked by `check_pin_table`). GPIO3 is only read
if EFUSE_STRAP_JTAG_SEL is burned ([p15]); its key leaves it low or floating. GPIO0 = BOOT.

**Wake and boot notes.** The hook is on an RTC GPIO (IO2), so lifting the handset can wake the
chip from deep sleep; keys on IO38-48 are not RTC GPIOs and wake it from light sleep (any GPIO),
which is enough for a phone that is always on USB power. KEY_6 is on IO43 (TXD0): the ROM boot
log drives that pin for a moment after reset, so a key held during boot only loses the log
(burn EFUSE_UART_PRINT_CONTROL to silence it). KEY_7 is on IO44 (RXD0, an input at boot).

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

## 6. Display: a module on a socket

The standard display is the **WeAct Studio 2.9" e-Paper module** (296 × 128 B/W, SSD1680,
~$8 retail). It sits between the key rows, centred over the digit columns, and **plugs straight
into J3**, a 2x4 2.54 mm female socket in the module's own header order (WeAct drawing and
schematic, `WeActStudio.EpaperModule/Hardware/`): **1 BUSY, 2 RES, 3 D/C, 4 CS, 5 SCL (CLK),
6 SDA (DIN), 7 GND, 8 VCC** (3V3; the module has its own LDO, boost and 100 Ω series
resistors, no pull-ups on the lines). Its far end rests on **two M3 × 11 mm standoffs** in H5
and H6, which match the module's own M3 holes (86.2 × 31.9 mm pattern, 2.8 mm from the edges
of its 91.8 × 37.5 mm board). 11 mm = the socket's 8.5 mm + the module header's 2.5 mm plastic.
The module ships with a right-angle header: fit a straight 2x4 male header pointing down
instead. Which end of that header is pin 1, seen from the panel side, is to be confirmed on a
sample (the socket is placed for pin 1 at the module's outer column, lower row).

| Module | Notes |
|---|---|
| **WeAct Studio 2.9" e-Paper** (standard) | plugs into J3 + 2 standoffs |
| Waveshare 2.9" e-Paper Module (V2) | same controller; PH2.0 cable → female-male jumpers to J3 (order differs) |
| 1.3" SPI OLED (SH1106/SSD1306) | 7 pins, no BUSY: jumper wires |
| 1.54"-2.0" SPI TFT (ST7789) | BLK to 3V3: jumper wires; draws the most (budgeted 60 mA) |

`hello.display` stays `eink` for the standard module.

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
  discharged), so JACK_DET (IO4 via 1 kΩ, internal pull-up) reads low with no plug and high
  with a plug.
- **Headset button:** not wired (no free hardware for it). Firmware may detect a press as a
  large transient on the mic ADC (unverified).
- OMTP plugs (mic and ground swapped) are not supported.

## 8. Ringer and status LED

- **Ringer:** a 12 mm piezo on top of the board under a dome of sound holes in the lid:
  TDK PS1240P02BT (Ø12.2 mm, 4 kHz, external drive, pins 5 mm apart) from VBUS, switched by an
  MMBT3904 whose base gets IO8 through 1 kΩ; 1 kΩ across the piezo charges and discharges it.
  This is TDK's recommended drive circuit (PS series [p2]). A piezo needs no flyback diode.
  The owner's placement default asks for a ~85 dB class ringer: the PS1240 is rated 70 dB at
  10 cm at 3 V (5 V drive and the lid port help); a louder 12 mm transducer on the same 5 mm pin
  pitch drops into the footprint, or a magnetic buzzer (e.g. MLT-8540H, 85 dB) with one more
  diode. To be chosen by measurement at bring-up.
- **Status LED:** IO1 → 1 kΩ → Lite-On LTST-C230KRKT, a **reverse-mount** red 1206 LED
  (~1.5 mA). It is soldered on the bottom with every other SMD part and shines up through the
  footprint's 1.8 × 2.4 mm board cut-out to a Ø3 lid hole at the band's front-left, so the board
  stays one-sided. IO1 is an input at boot, so the LED stays dark until firmware lights it.

## 9. The board (M2 placement)

**Owner-approved placement defaults (2026-09-30), as built:**

1. Two rows of 6 MX keys at 19.05 mm (`1 2 3 4 5 MENU` rear, `6 7 8 9 0 BACK` front), row
   centres **61 mm** apart. The WeAct 2.9" module sits between the rows on J3 plus two M3 × 11
   standoffs (H5, H6) at its own holes (§6), centred over the digit columns; 1.45 mm is left
   between its bezel and each keycap row.
2. **All SMD parts on the bottom** (one-sided JLCPCB assembly). On top: only the plugged MX
   switches, J3 and the piezo (hand- or wave-soldered THT). The hot-swap sockets are on the
   bottom as usual.
3. **Hook = the 13th MX switch** (SW15) in a hot-swap socket at the board's **left end**, in
   line with the front row but outside the key rows; the lid gives it a square collar that
   guides the handset rest's plunger (or a plain keycap). Left rather than right because the
   electronics band is on the left (below): its wire to IO2 is 20 mm instead of 140 mm.
4. **USB-C J1 and the 3.5 mm jack J2 on the rear edge** (bottom side, mouths flush with the
   edge). The ESP32 module's **U.FL connector is at the left edge**: the antenna end of the
   module is 0.5 mm from it, and the cable runs to the left shell wall.
5. **12 mm piezo** on top next to the USB-C, under a lid dome with seven sound holes; **one
   status LED** seen through a board hole (§8).
6. **Antenna:** a generic 2.4 GHz adhesive FPC antenna with a U.FL (IPEX MHF1) plug and a
   100-150 mm cable, stuck to the inside of the left wall ≥ 15 mm from metal. Pick one whose
   datasheet gain is ≤ 2.33 dBi to stay inside the module's certification (§3), e.g. the
   common "2.4G FPC antenna IPEX 2 dBi" parts sold for ESP32 modules. The exact part is still
   the owner's call (§12).
7. **2 layers, 156 × 88 mm** (4 mm less than proposed: the band next to the keys needs 37 mm),
   R3 corners, 4 × M3 holes (H1-H4: three corners + one next to the band; the rear-left corner
   holds the jack). The signature logo and "Open Lounge Phone" sit on the top silkscreen under
   the display module (clear of everything; silkscreen DRC checks stay errors).

**Layout.** The electronics live in a 37 mm band at the **left** end, keys and display to the
right. A module on the bottom is mirrored, and only the pose with its antenna end at the left
edge puts its 12-pin row toward the keys, its pin-1 side toward the rear edge (USB pins 13/14
right under the USB-C) and its pin-40 side toward the front. So the wires come in as buses:

- **rear keys** drop from their sockets into a lane under the rear sockets and run into the
  top of the row (IO3, 46, 9, 10, 11, 12 for keys 1 … MENU);
- **display**: J3 is 20 mm from the row, its lines go straight in below the rear keys
  (IO13, 14, 21, 47, 48; RST reaches IO38 on the front side under the module, top layer);
- **front keys** rise into a lane above the front sockets and run into the front side
  (IO43, 44, 42, 41, 40, 39 for keys 6 … BACK); the hook (IO2) and LED (IO1) sit left of them;
- **rear band**, above the module: USB-C → USBLC6 → module USB pins in a straight line; the
  LDO right next to the USB-C and the module's rear corner; the ES8311 above its eight module
  pins (IO4-IO7, IO15-IO18) with its supply caps at its pins and the jack right above it; the
  ringer driver between the codec and the USB lines.
- **GND** is a pour on the top layer (plus bottom fill); **3V3** a pour island on the top layer
  over the rear band (LDO → module pin 2, codec, pull-ups) with a track on to J3.

`make placement` numbers (straight-line ratsnest, GND and 3V3 left out as pours): **1353 mm**
of wiring and **1 crossing** (the USBLC6's VBUS pin sits between D+ and D−, as in every
pass-through use of that part). Supply decoupling: every capacitor's pad is **≤ 1.12 mm**
from its pin. DRC: **0 violations** (0 courtyard overlaps, 0 silkscreen errors), only the
unconnected items of an unrouted board. Image: `build/review/placement.png`.

## 9a. Routing (M3)

`make route` (layout/route.py) rebuilds the copper from the placed board, deterministically;
`make fab` writes the fab and review outputs to `build/main/fab/` (Gerbers + drill, JLC BOM
and CPL, IPC-2581, STEP, renders, `layers.pdf`, `routed-*.png`), the firmware's GPIO map
`build/main/gpio_map.json` and a 5-board JLC quote.

- **Buses by script, on the bottom:** the six rear keys and six front keys run as parallel
  0.2 mm tracks at 0.6 mm pitch in the planned lanes with nested 45° corners; the display's
  five lines leave J3 as one 1.27 mm-pitch bundle with a single parallel 45° jog; the hook,
  RST, BOOT and the LED go straight to their pins.
- **USB:** J1 -> USBLC6 (flow-through: pins 1/6 and 3/4 are one node inside the part, declared
  as jumper pad groups) -> IO19/IO20; D- joins its second receptacle pad over the pad row,
  D+ under it. Signal paths 26.00 / 25.91 mm (0.10 mm apart). VBUS reaches the TVS's VBUS pin
  through the gap between its pad rows, so nothing crosses the pair and the top plane under it
  is unbroken.
- **Power:** VBUS 0.6 mm to the LDO; 3V3 = a 217 mm2 bottom pour on the LDO tab (heat), a
  top-layer trunk that passes under the module south of the USB pair's end to pin 2 and J3,
  and short spurs to the codec, EN resistor and pull-ups; a top track along the rear edge feeds
  the mic bias.
- **Codec corner, by hand:** JACK_DET/WS/BCLK straight down to pins 4-6; DOUT and DIN change
  order between codec and module, so each hops over on the top (2 vias each); MCLK/SCL/SDA fan
  out at 0.4 mm pitch; the mic line (MIC1P -> C14 -> R9) stays on the bottom with an unbroken
  top plane above it. Routing moved a few passives: R1 0.5 mm, C3 (22 uF) into the edge column
  beside C4, C5 above them, C7 upright beside C6, C14 in line with pin 18, and VMID's and
  MIC1N's caps (C9, C15) into the free spot above the codec, reached through a via pair each:
  **~6 mm from their pins instead of the 2 mm of BR-15** (both are AC-grounded reference nodes;
  the 0.4 mm pin pitch leaves no planar way out between the MIC1P and SDA lines).
- **GND:** fills on both layers (islands removed; the top is one piece), a via at every SMD
  ground pad, stitching every 6 mm in the electronics band, 9 mm elsewhere and along the edges.
- **Checks** (`build/review/route-metrics.txt`, `main-drc.json`): DRC 0 errors / 0 warnings /
  0 unconnected; every segment at 45° multiples, no acute junctions, no top copper under the
  USB pair or the audio lines; 1.79 m of track, 17 signal vias.

## 10. Part count and cost

From `make build` (`build/main/bom.csv`, `build/main/cost.txt`); prices are LCSC/JLCPCB
ladders, fees and the bare PCB are dated estimates in `schematic/cost_model.yaml`.

- **53 parts on 23 BOM lines** (13 hot-swap sockets, 15 capacitors, 13 resistors, 12 other
  parts), plus 6 holes (4 mounting, 2 display standoffs) and 2 silkscreen items. 13 lines are
  JLC basic, 10 extended (the module, codec, LDO, USB-C, jack, sockets, ESD, display socket,
  piezo, reverse-mount LED).
- **Cost per board** (PCB + parts + assembly, JLCPCB reference):
  - **1 board: $85.93** for the minimum order (5 bare PCBs, 2 assembled: $42.96 each);
    $30 of it is the extended-part fees.
  - **100 boards: $7.64** each.
  - **1000 boards: $6.16** each.
- **Off-board per phone** (EST): 13 MX switches, 12 keycaps, display module, antenna, handset:
  $14.49 at scale, ≈ $56 retail.

## 11. What the minimal board does and doesn't do

Does: 12 keys + hook, a display module, handset earpiece and mic through the codec, a piezo
ringer, one status LED, Wi-Fi/BLE, flashing and console over USB-C.

**Privacy, stated plainly (owner):** the board has **no microphone of its own**. The only
microphone is the one in the handset, on the 3.5 mm jack: **unplug the handset and there is no
microphone connected at all**. With the handset plugged in, firmware keeps its mic muted while
it is hung up and only captures audio in a call.

**Power (owner):** the phone is **mains/USB-powered like a landline**: no battery by design; it
is not a mobile device.

Doesn't (by owner decision): no **hardware mute switch**, no **mic lights wired to the mic's
power** and no separate recording light (the mic bias is on while powered; firmware decides
when audio is captured). No **NFC** (claiming uses the QR code or the pairing code), no
**battery**, no **per-key LEDs** (the display and voice prompts carry state; the emulator still
shows key lights), no **speaker** (the piezo rings; prompts play in the earpiece), no
**presence radar, hall sensor, light sensor or accelerometer**.
[../docs/security-model.md](../docs/security-model.md) states what that means for privacy.

## 12. Owner decisions for M2 and what is still open

Resolved 2026-09-30 by the owner-approved placement defaults (§9): board size and zones
(156 × 88, electronics band at the left), all SMD on the bottom, the WeAct 2.9" as the standard
display on J3 + standoffs, the hook as an MX switch out of the key rows, USB-C and jack on the
rear edge, a 12 mm piezo and one status LED seen from the top, a generic 2.4 GHz U.FL adhesive
antenna.

Still open:

1. **Ringer part:** keep the PS1240 (70 dB at 10 cm) or fit an ~85 dB 12 mm part on the same
   footprint (measure at bring-up, §8).
2. **Antenna part:** the exact 2.4 GHz U.FL antenna that ships (≤ 2.33 dBi, §3).
3. **Display header pin 1:** confirm on a WeAct sample which end of its 2x4 header is pin 1
   (J3 is placed for the outer column, lower row, seen from the panel side).
4. **Hook post / handset rest:** the rest that presses SW15 (the proto box has a collar only).
5. The earlier questions that still stand: base envelope and toy classification (Kids).

## 13. Sources

- ESP32-S3-WROOM-1/1U datasheet v1.8 (Espressif): straps p13-15, supply p27, current p28,
  peripheral schematic p41, antenna p43-44.
- SGM2212 rev A.2 (SG Micro): features p1, θJA p3, pinout p4, accuracy p5, dropout/limits p6,
  load transient p7, capacitors p10.
- AMS1117 datasheet DS1117 (Advanced Monolithic Systems), p4: 22 µF tantalum output capacitor.
- ES8311 datasheet rev 7.0 (Everest): p1, p3, typical application p4, ratings p8-9; ES8311 User
  Guide rev 1.11 p2 (headphone load).
- ST USBLC6-2 datasheet p1-2; HOOYA PJ-31060 drawing rev A2 p1; TDK PS series buzzers p2;
  JSCJ MMBT3904 rev 2.1 p1; Lite-On LTST-C230KRKT p1, p3; XKB TS-1187A rev A0; HanElectricity
  CPG151101S11-2 and Kailh KH-PS2206-43 drawings p1. Links in [components/](components/README.md).
- WeAct Studio EpaperModule (github.com/WeActStudio/WeActStudio.EpaperModule, Hardware/):
  2.9" board shape (91.8 × 37.5, holes 86.2 × 31.9, 2x4 header) and schematic (header order).
