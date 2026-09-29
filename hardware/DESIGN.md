# Open Lounge Phone Hardware Design — "Trimline" r0.1

Status: **proposal / pre-EVT**. Owner: hardware. License: CERN-OHL-S-2.0 (this document and all
derived KiCad/enclosure files).

This document picks the parts, board partitioning, envelope, pin map, power, BOM and staging for the
first custom Open Lounge Phone: a **Trimline-style corded phone** (slim base + handset on a coiled
cord), USB-C powered: **one board, one BOM** (owner, 2026-09-28) for every phone; Kids and
Lounge are software modes.

Product-owner constraints incorporated (revision of 2026-09-27):

- **No main screen.** The only display is a **narrow e-ink status strip**. Primary feedback is
  **per-key RGB LEDs** plus **audio prompts/earcons** from flash.
- **Passive handset.** Earpiece + mic + magnet only. All electronics live in the base.
- **Keys are keyboard switches.** MX-compatible, hot-swap sockets, plate-mounted, standard keycaps.

> **Current architecture — owner decisions of 2026-09-27 (supersede conflicting text below;
> the older sections are kept for their reasoning and are being brought in line):**
>
> - **Form factor:** compact base ≈ 186 × 94 × 33 mm with a G-style handset resting on a
>   raised hook rest **above** the keypad (keys and e-ink stay visible). **Single board (owner,
>   2026-09-27):** one 180 × 88 mm 4-layer board carries everything, including the 12 hot-swap
>   keys, LEDs, e-ink ZIF, AW9523B, NFC coil (free end region) and sensors. Two stacked boards
>   were carried over from the old long base; one board is cheaper one-off (one fab/assembly
>   setup, no FFC/connectors/standoffs). Hook sensing: DRV5032 on the main board under one hook-rest post (plunger magnet,
>   post at ≈ +80 mm from the base centre, a layout parameter until the enclosure confirms it).
> - **Keys:** 12 MX keys, `1 2 3 4 5 MENU` / `6 7 8 9 0 BACK` (§6.1); 13 SK6812MINI-E.
> - **Handset:** **off-the-shelf USB-C (UAC 1.0) handset/headset** — e.g. a G-style retro USB-C
>   handset of the Native Union POP class, or any USB-C headset — plugged into a **USB-C
>   receptacle on the rear edge** (a short right-angle or coiled C-to-C extension also works).
>   The ESP32-S3 native USB OTG (GPIO19/20) is the **USB host** (ESP-IDF `usb_host_uac` class
>   driver, full-speed, isochronous; one device, no hub; firmware must accept the device's fixed
>   formats, typically 16/48 kHz mono/stereo). The port is a **source**: Rp 33 k to 3V3 on CC1/CC2
>   (Default USB), VBUS through a 0.45 A current-limited switch (SY6280) fed from VBUS or VSYS
>   (diode-OR, so it works on the battery option), enabled by GPIO3 (off at boot), sensed on GPIO10;
>   SRV05-4 at the connector. **Rejected:** USB-C analog audio-accessory mode (needs SBU wires most
>   C-to-C cables lack, and Ra on both CC), and the RJ9/4P4C cord (few new products, hard to
>   customise). A DIY handset (USB-C + CM108-class UAC codec) stays a possible future option.
>   The AEC reference for handset calls is the digital stream the firmware sends to the handset;
>   the ES8311→ES7210 CH3 loopback remains the reference for the base speaker.
> - **Programming/console:** the power USB-C (sink) now has a **CH340C** USB-UART bridge to UART0
>   with DTR/RTS auto-reset (the native PHY belongs to the handset port).
> - **Side controls:** VOL−/VOL+ (right-angle tacts) and MUTE (right-angle DPDT, lever outward)
>   on the board's right edge with ESD; MUTE breaks the mic bias locally; their states go to
>   the AW9523B.
> - **Speaker:** 20 × 40 mm rectangular top-firing speaker beside the deck (keep-out on the main
>   board's left zone).
> - **One board, one BOM (owner decision 2026-09-28), no variants:** every core part plus the
>   e-ink strip (ZIF + boost), NFC (ST25DV + coil) and the 1S battery charger with its fuel
>   gauge, all fitted. **Removed:** the Lounge radar (LD2410C) and supercap hold-up (Lounge
>   features are deferred to a future board), the ATECC608B footprint (the ESP32-S3 uses flash
>   encryption + eFuse HMAC), the IR hook option (the magnet is in the plunger) and the Qwiic
>   display port. Kids/Lounge text below describes software modes and the deferred Lounge
>   board; the hardware sections follow SCHEMATIC.md / LAYOUT.md where they differ.
> - **ESP32 module: WROOM-1U (U.FL + external FPC antenna on the shell wall)** instead of the
>   PCB-antenna WROOM-1 (layout, 2026-09-27): in base A no main-board edge is ≥ 15 mm from the
>   hook tubes, standoffs and inserts. Same pinout and firmware; +≈$0.45 at scale for the antenna.
> - Main-board geometry follows `enclosure/params.yaml → main_intent` (180 × 88, R8.5, 9 M2.5
>   holes, hall U10 at (171.0, 18.8), handset USB-C at x = 24, power USB-C at x = 159).
> - Layout, fab outputs, costs: [LAYOUT.md](LAYOUT.md), [ASSEMBLY.md](ASSEMBLY.md).

Anything marked **[UNVERIFIED]** is an estimate or a datasheet detail I could not confirm online;
see §17 for the full list. Prices are 1k-qty estimates in USD unless an LCSC list price is cited.

---

## 0. Executive summary: key decisions

| # | Decision | Why (one line) |
|---|---|---|
| 1 | **Envelope: compact base ≈186 L × 94 D × 33 H mm** (owner decision 2026-09-27, supersedes the ≈350 mm Trimline stretch). **One 180 × 88 mm board** with the keys on it (single board, owner 2026-09-27; the stacked deck + main pair is superseded), G-style USB-C handset on a raised hook rest above the keypad. | Smallest base that holds the board; keys and e-ink stay visible under the handset bridge. One board = one fab/assembly setup, no FFC/connectors/standoffs. |
| 2 | **Handset: an off-the-shelf USB-C (UAC 1.0) handset** (G-style, Native Union POP class, or any USB-C headset) on a standard **USB-C to USB-C cable**; the ESP32-S3's native USB is the host (owner, 2026-09-27; *supersedes the passive 4P4C/RJ9 handset*). The hook magnet is in the base's plunger, not the handset. | No custom handset to build; any C-to-C cable (coiled or not) works; the digital link has no analog cord to pick up Wi-Fi buzz. |
| 3 | **MCU: ESP32-S3-WROOM-1-N16R8** (pre-certified module, 16 MB flash, 8 MB octal PSRAM). | Espressif's AFE/AEC (ESP-SR) and esp-webrtc both target the S3. The C5 lacks AFE support and the P4 costs too much. |
| 4 | **Audio: ES8311 (DAC/earpiece driver) + ES7210 (4-ch ADC) + NS4150B (3 W class-D)**, the same chipset as ESP32-S3-Korvo-2 / S3-BOX-3. ES7210 ch3 records the **analog AEC reference**. | This is Espressif's known-good AEC topology, so the dev kit matches the product. INMP441/MAX98357A can't serve a passive handset and give no hardware reference. |
| 5 | **Keys: 12 × MX-compatible switches** (owner decision 2026-09-27) in **Kailh CPG151101S11 hot-swap sockets**, on a **1.6 mm FR4 plate**, DSA/relegendable 1u keycaps, two rows of six: `1 2 3 4 5 MENU` / `6 7 8 9 0 BACK`. No SPEAKER/END keys: hang up = handset on hook, speakerphone is a menu item. | This follows the owner's direction. Relegendable caps let kids' phones carry photos, and hot-swap means a parent can fix a key in 30 s. |
| 6 | **Per-key LEDs: 13 × SK6812MINI-E** (12 keys + 1 status), reverse-mounted, on one RMT GPIO. A **hardwired red privacy LED** lights whenever mic bias is present. | With no screen, the keys are the status surface. The privacy LED can't be overridden by firmware. |
| 7 | **E-ink strip: Good Display GDEY029T94** (2.9", 296 × 128, SSD1680, active 66.9 × 29.1 mm), placed **between the two key rows** so every contact key has its label directly above or below it. I compared 7/14-segment LED arrays (HT16K33), dot-matrix, a single 0.91" SSD1306 OLED and per-key OLEDs (§7.2). | 4 key columns at 19.05 mm = 76.2 mm, which matches the 79 mm panel. It's the only option with per-key labels, zero light emission at night and no burn-in. It renders a QR at 22 mm, which is only enough at ~20–25 cm (§7.1). *The e-ink strip is now standard on the one board; the "Lite" and Qwiic-display options are superseded (2026-09-28).* |
| 8 | **Lounge takeover = QR (strip, or printed) / NFC tap + press-the-flashing-key proof.** Implemented in software today (single-use QR nonce + key proof, also for guests from other servers). *mmWave presence is deferred with the radar (2026-09-28).* | A photographed code is useless without someone physically at the phone. |
| 9 | **Hook: TI DRV5032 omnipolar Hall switch** (µA-class) under one hook-rest post; the **magnet rides in the hook plunger**, which the handset's weight pushes down (owner, 2026-09-27). *The IR-sensor option is removed.* | Works with any handset, uses almost no power, has no contacts to wear out. |
| 10 | **Power: USB-C sink (5.1 kΩ Rd, no PD) → BQ24074 power-path** (always fitted: OVP, input current limit, optional battery) **→ 3.3 V buck + 3.0 V low-noise analog LDO.** The 1S battery charger and fuel gauge are always fitted; the pack itself is optional. *The supercap hold-up is removed (2026-09-28).* A Lounge phone needs a ≥ 1.5 A USB-C source for full features (§9.2a). | Mains-powered desk device; a USB power bank *is* the UPS. |
| 11 | **NFC: ST25DV04K dynamic tag** with a PCB coil, on every board. *Radar (HLK-LD2410C) removed (2026-09-28): Lounge presence is deferred to a possible future board.* | NFC tap covers setup, pairing and lounge takeover. |
| 12 | **Security:** Secure Boot v2 + flash encryption (release) + HMAC-protected NVS encryption. The **Ed25519 seed is derived at boot by the eFuse-keyed HMAC peripheral and never stored in flash.** Protocol should add **alg negotiation (ed25519 \| p256)** now. | The S3's DS peripheral is RSA-only and ATECC608B is P-256-only. P-256 opens the door to ESP32-C5/P4 on-chip ECDSA keys later. |
| 13 | **PCBs: one board** (owner, 2026-09-27): 4-layer 180 × 88 mm with keys, LEDs, e-ink, NFC and all electronics; plus the key plate (FR4 or the printed top). Supersedes the 3-board main + deck + plate set and its 24-pin FFC. | One fab/assembly setup, no FFC, connectors or standoffs; cheapest one-off. |
| 14 | **Cost (current build roll-up, `build/main/cost.txt`):** board parts ≈ $16.5 at 1k; with PCB, assembly and off-board parts (switches, caps, speaker, e-ink panel, USB-C handset, antenna, battery) ≈ **$40 per phone at 1k, ≈ $38 at 10k**. A one-off build through JLCPCB is ≈ $208 per phone (setup and extended-part fees dominate). | Inside the owner's revised $28–40 goal at scale (§12). |

**Top risks:** (1) speakerphone AEC and USB host audio (UAC) on the ESP32-S3 with arbitrary
handsets; (2) the MX key stack height in a compact base; (3) **cost and compliance**: FCC 15B/CE
RED incl. **EN 18031-2 (kids/toys cybersecurity)** and possible toy-safety scope. *(The earlier
risks "RF buzz into the 2 m analog cord" and "the 330 mm envelope" are gone with the USB-C
handset and the compact base.)*

---

## 1. Form factor and dimensions

### 1.1 What a real Trimline measures

| Source | Dimension | Notes |
|---|---|---|
| AT&T 210 Trimline (current production) retail listings | **3.4" W × 8.9" H × 3.8" D ≈ 86 × 226 × 97 mm** | Assembled phone, handset docked. Which axis is "H" (upright wall use vs desk) is not stated. |
| Cooper Hewitt collection record (via search snippet) | **8.5 × 23 × 7.6 cm** | Assembled desk Trimline. |
| Wikipedia / Bell System Memorial | Dial/keypad on the underside of the handset (1965 Henry Dreyfuss design); later switchhook "moved to top of phone just below the receiver". Handset ≈ 3 oz. | No handset-only dimensions published. |

**[UNVERIFIED] Handset-alone dimensions.** From the overall envelope I estimate a Trimline
handset at ~215–220 × 48–52 × 25–30 mm. **Action: buy an AT&T 210 (~$20) and a WE 220 donor and
measure/scan both before industrial design freeze.**

The key observation: in a real Trimline **the handset covers essentially the whole base top**.
A status strip and speed-dial keys can't be visible while docked unless the base grows. Options:

| Option | Result | Verdict |
|---|---|---|
| A. Trimline-true: keys in handset (as 1965) | Needs active electronics or a resistor ladder in the handset, single-ended audio over a shared ground, and the strip is still hidden. Violates "passive handset". | Rejected |
| B. Wider base, deck beside the handset (~140 × 230) | Squat desk-phone look; loses the Trimline's slimness | Rejected |
| **C. Trimline width, deck in-line (~92 × 330)** | Keeps the slim silhouette and Trimline cross-section. Wall-mounts naturally (handset hangs above the deck). | **Chosen** |
| D. Compact-6: 2.13" strip + 2×3 contact keys + 2 fn keys | ~92 × 310 mm, labels fit 3 columns | Documented cost-down variant |

### 1.2 Proposed envelopes

**Handset (passive):** 218 L × 52 W × 28 T mm max (ear/mouth cups), neck ~38 × 20 mm.
Target mass 110–140 g. Contents: Ø28–32 mm dynamic receiver (32 Ω), Ø6 × 2.7 mm electret with
RF caps, 12 × 4 mm N52 disc magnet at the neck centre (x ≈ 113 mm from mouth end), 4P4C jack
(either a bare panel jack or a 20 × 14 mm passive carrier, §2.3).

**Base:** ≈186 L × 94 D × 33 H mm (owner decision 2026-09-27; supersedes the earlier ≈350 mm in-line layout). The handset rests on a raised hook rest above the keypad; the DRV5032 sits on the main board under one hook-rest post (≈ +80 mm from the base centre, a layout parameter `hook_post_x` in layout/boards.yaml).
Wall-mount: two keyhole slots on the bottom (83 mm US wall-plate spacing is **not** needed — this
is not a line-powered phone — so use 100 mm spacing), firmware rotates strip content 180° if hung
key-deck-down.

### 1.3 Mechanical sketches (mm)

Coordinate system: x = left→right along base length (user faces the front long side),
y = front→rear, z = up from base floor.

**Top view (handset removed) — compact stacked base (2026-09-27)**

```
 x=0                                                                   186
 ┌──────────────────────────────────────────────────────────────────────┐ y=94 rear:
 │ [USB-C power]x≈10  [USB-C handset]x≈24                  ESP32 ant ►  │ USB-C x2
 │ ┌────────┐  ┌────┬────┬────┬────┬────┬────┐                 ┌──┐     │
 │ │SPEAKER │  │ 1  │ 2  │ 3  │ 4  │ 5  │MENU│   hook-rest post│H │     │
 │ │20 x 40 │  ├────┴────┴────┴────┴────┼────┤   (DRV5032 on   │  │ VOL-│
 │ │top-    │  │ E-INK STRIP 79 x 36.7   │ALS │    main below)  └──┘ VOL+│ right edge
 │ │firing  │  │ [NFC coil around it]    │priv│                      MUTE│
 │ └────────┘  ├────┬────┬────┬────┬────┼────┤                          │
 │             │ 6  │ 7  │ 8  │ 9  │ 0  │BACK│   KEY DECK 117 x 84      │
 │             └────┴────┴────┴────┴────┴────┘   over MAIN 180 x 88     │
 └──────────────────────────────────────────────────────────────────────┘ y=0
```

The older in-line sketches below (Trimline stretch, RJ9) are kept for their reasoning only.

**Front view (y = 0 face)**

```
 ┌──────────────── handset (docked, top z≈50) ─────────────────┐
 │ mouthpiece ◄──── 218 ────► earpiece                          │           keycaps z≈34-37
╔╧═════════════════════════════════════════════════════════════╧═╗ ┌┐┌┐┌┐┌┐┌┐
║                                              ▒radar  ∘mic       ║ ║▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔║  z=36
║                                              ▒window            ║ ║ printed QR 30 mm  ║
║                                                                 ║ ║ (lounge)          ║
╚═════════════════════════════════════════════════════════════════╝═╝───────────────────╝  z=0
 x=0                                                          224                    330
```

**Side section through the key deck (x ≈ 280, looking from the right end)**

```
 z (mm)
 37 ┤        ┌──DSA cap──┐                 ┌──DSA cap──┐         keycap top ≈ 34.6 (DSA 7.6)
    │        │           │                 │           │         / ≈ 36.6 (relegendable)
 28 ┤ skin ──┘  ▲4 mm    └── e-ink window ─┘           └── skin (2 mm PC/ABS, 19.5 mm key holes)
 25 ┤           travel      ▓▓▓▓▓▓▓▓▓▓▓▓▓ e-ink 1.0 mm on 3 mm foam, glass 0.5 mm below skin
 21 ┤ ══════ FR4 plate 1.6 mm (plate top z≈20.6) ════════════════════════════
 15 ┤ ══════ DECK PCB 1.6 mm (top z=15.6) ══ NFC coil (no copper pour inside loop) ══
 14 ┤  ▄socket▄ (Kailh CPG151101S11, 1.85 mm)  ▄SK6812 rev-mount▄
 10 ┤ ┌──────────────── B-option LiPo 603450 (6 mm) + 1 mm swell gap ────────────┐
  2 ┤ └────────────────────────────────────────────────────────────────────────┘
  0 ┴ base floor ─────────────────────────────────────────── y=0 ... y=92
```

**Key stack budget (MX)** [UNVERIFIED — confirm against CAD models of the chosen switch/cap]:
socket 1.85 + PCB 1.6 + PCB-top→plate-top 5.0 + plate-top→DSA keycap top ≈ 14.0 ⇒ **≈ 22.5 mm**
from socket bottom to cap top (≈ 24.5 mm with relegendable caps). The deck PCB sits at z = 14 so
the battery pocket fits underneath and the cap tops land flush with the 36 mm body line.

**Clearances used:** 2.5 mm walls (PC/ABS), 1 mm air to all walls, 3 mm min around screw bosses,
4 × M2.5 / #4 plastite bosses per board, speaker in a sealed 40 × 45 × 14 mm (≈14 cm³) molded box
firing down through a bottom grille (4 mm feet) + left-end slots.

---

## 2. Partitioning: base vs handset

> **Superseded (owner, 2026-09-27):** the handset is an off-the-shelf **USB-C (UAC) handset** on a
> standard C-to-C cable, and the hook magnet sits in the base's plunger. §2.1–2.3 describe the
> earlier passive handset on an analog 4P4C (RJ9) cord and are kept only for their reasoning; the
> current handset interface is in the "Current architecture" box above and SCHEMATIC.md.

### 2.1 Decision

| Lives in the HANDSET (passive) | Lives in the BASE |
|---|---|
| Dynamic receiver 32 Ω | ESP32-S3 module, all power, codecs, amp |
| Electret mic capsule with internal RF caps + 33 pF | Base speaker (ringer/speakerphone), base mic |
| 12 × 4 mm N52 magnet (hook) | Hall sensor, radar, NFC, ALS, accelerometer |
| 4P4C jack (panel or passive carrier) | Keys, LEDs, e-ink strip |

### 2.2 Cord interface

Standard **4P4C (RJ9/RJ10/RJ22) coiled handset cord**, fully analog, two balanced pairs:

| Pin | Common handset convention [UNVERIFIED, not universal] | Open Lounge Phone signal |
|---|---|---|
| 1 | Transmitter (mic) | MIC+ (electret drain, biased from MICBIAS via 2.2 kΩ) |
| 2 | Receiver | EAR+ (ES8311 OUTP, via EAR_EN switch) |
| 3 | Receiver | EAR− (ES8311 OUTN) |
| 4 | Transmitter (mic) | MIC− (return to codec AGND at the jack, pseudo-differential into ES7210 CH1N) |

Base jack footprint includes **4 × 0 Ω solder jumpers** to swap the pairs, for third-party
handsets that use the inner pair for the mic. Handset detection: ADC on the biased MIC+ line
(open ≈ MICBIAS, electret ≈ 1.2–2.0 V, short ≈ 0) → "handset missing" status.

**Noise/RF:** Wi-Fi TX bursts (~1 kHz packet cadence) rectifying in the electret FET across a
~2 m cord is the classic "buzz" failure. Mitigations: electret with built-in 10 pF/33 pF RF caps;
33 pF + 100 pF at the capsule; ferrite bead (600 Ω@100 MHz) + 100 pF on every cord line at the
base jack; balanced receive into ES7210; jack and cord exit at the rear-left, 60 mm from the
antenna. Validate in EVT with Wi-Fi at max TX and the cord draped over the base.

**ESD:** 4-channel TVS array (e.g. TPD4E05U06 or SRV05-4 class) at the base jack. The handset
side gets only caps; it has nothing to protect.

**Cord length:** standard 12–25 ft coiled cords, ~0.1–0.5 Ω/conductor. That's irrelevant for a
32 Ω receiver and a high-impedance mic input.

### 2.3 Handset construction

Preferred: **no PCB.** Receiver and capsule solder to a 4P4C panel-mount jack with a glued-in
2 × 0603 cap "flying" assembly. If the ID wants a PCB-mount jack, use a **passive 20 × 14 mm 2-layer
carrier** (jack + 3 caps + pads). No active parts either way.

### 2.4 Rejected

- **Digital I2S/I2C over the cord** (INMP441 in handset): needs ≥5 conductors (power, GND, BCLK,
  WS, SD) plus an amp. It's an ESD/EMI antenna on a coiled cord, and breaks standard cords.
- **Tiny MCU in handset** (e.g. CH32V003 + resistor ladder keys): the owner wants a passive
  handset. It adds a failure point in the part kids drop.
- **USB-C-style coiled cord:** expensive, non-standard coiled cables, still needs electronics in
  the handset.

---

## 3. Audio chain

### 3.1 Block diagram

```
                 ┌──────────────── BASE / MAIN BOARD ───────────────────────────────────────┐
 HANDSET         │                                                                          │
 electret ─MIC±──┼─RJ9─[FB+TVS+RF C]──┬──► ES7210 CH1 (handset mic)   ┐                     │
                 │                    └ ─ ─► ES8311 MIC1 (0 Ω DNP, analog sidetone option)  │
 receiver ─EAR±──┼─RJ9─[FB+TVS]◄─[EAR_EN SPST]◄─ ES8311 OUTP/OUTN (HP driver 16/32 Ω)       │
                 │                                    │     │                               │
 base electret ──┼──(rubber boot, front wall)──► ES7210 CH2 (speakerphone mic)             │
                 │                                    │     └─[÷ attenuator]─► ES7210 CH3 (AEC REF)
 speaker 4Ω 3W ◄─┼──── NS4150B ◄─(CTRL=PA_EN)─────────┘                     ES7210 CH4 (spare)
                 │                                                                          │
                 │  ES8311 DSDIN ◄── I2S0 DOUT ─┐   MCLK/BCLK/WS shared                      │
                 │  ES7210 SDOUT ──► I2S0 DIN ──┤── ESP32-S3 (TDM RX 4 slots @16 kHz)        │
                 │  MICBIAS12/34 ─► [MUTE slide switch] ─► mics  ─► [bias-sense BJT]─► PRIV LED
                 └──────────────────────────────────────────────────────────────────────────┘
```

### 3.2 Codec choice

| Option | Mics | AEC reference | Earpiece drive | Cost | Verdict |
|---|---|---|---|---|---|
| INMP441 + MAX98357A (original) | 1 digital, can't live in a passive handset | Software only (timing drift) | None (speaker amp only) | ~$2.5 | Rejected for product, kept for cheap dev kit |
| ES8311 only | 1 ADC; needs analog mux for handset vs base mic | Internal digital loopback (post-volume, pre-amp) | Yes (16/32 Ω) | $0.28 | Viable cost-down (−$0.47); weaker speakerphone AEC |
| ES8388 | 2 ADC ch, 2 DAC + HP | Needs one ADC ch for ref → only 1 mic | Yes | ~$0.9 | Rejected |
| **ES8311 + ES7210 + NS4150B** | 4 ch (handset, base, REF, spare) | **Analog REF on ES7210 CH3** (Espressif's recommended source is the ES8311 DAC output) | Yes | $0.82 | **Chosen.** Identical to ESP32-S3-Korvo-2 / S3-BOX-3, so ESP-ADF/esp_codec_dev drivers and AEC tuning carry over. |

- **Why a hardware reference:** ESP-SR AFE expects channel-interleaved input such as `"MMR"`
  (mic, mic, reference). An analog loopback captured by the same ADC is sample-synchronous with
  the mics, so there's no clock drift for AEC to fight.
- **Sample rate:** 16 kHz end-to-end (AFE requirement; Opus wideband). Ringtones/prompts are
  authored at 16 kHz.
- **I2S topology:** one I2S controller full-duplex, shared MCLK/BCLK/WS, TX to ES8311, TDM RX from
  ES7210 (Korvo-2 pattern **[UNVERIFIED: confirm against Korvo-2 V3.1 schematic]**).

### 3.3 Handset vs speakerphone routing

- **Handset mode:** EAR_EN=1, PA_EN=0. AFE input = CH1 (handset) + CH3 (ref). AEC still runs
  because it removes receiver→capsule acoustic leak and linear cord crosstalk.
- **Speakerphone (MENU → speaker / Lounge hands-free):** EAR_EN=0 (so the docked receiver doesn't
  buzz), PA_EN=1. AFE = CH2 (base mic) + CH3 (ref) + NS.
- **Ringer:** PA_EN=1, EAR_EN=0. Kids' quiet hours: the server routes callers to voicemail and the
  phone never rings.
- Mic/speaker separation: speaker at x ≈ 31, base mic at x ≈ 200 → **~170 mm**, in a sealed box
  firing downward. The radar sits outside the speaker's vibration path (§8).

### 3.4 Sidetone

Telephone users expect to hear themselves at about −12…−18 dB.

1. **Default: digital sidetone in firmware** from a 2 ms I2S DMA sub-frame path (separate from
   the 20 ms Opus/AFE frames), ≈4–6 ms total latency.
2. **Option (EVT experiment):** the handset mic is also wired to ES8311 MIC1 through DNP 0 Ω
   resistors. If the ES8311 ADC→DAC internal path can *mix* (not just replace) —
   **[UNVERIFIED]** in the ES8311 user guide — it gives <1 ms analog-like sidetone.

### 3.5 Volume

The ES8311 DAC digital volume (0.5 dB steps) is driven by VOL−/VOL+ side keys. There are separate
stored levels for earpiece / speakerphone / ringer / prompts. Ringer volume can be set by the
guardian (protocol recommendation §13). Lounge resets volumes at session end.

### 3.6 Audio prompts and earcons

Stored in a **3 MB `prompts` flash partition** (LittleFS), 16 kHz mono Opus 16–24 kbps (or IMA-ADPCM
for zero-CPU playback). Content: digits 0–9, "your pairing code is…", "quiet hours until…",
"this phone is offline", "missed call from…", "press the glowing key", "session ended",
dial/ringback/busy/howler tones, 3–4 ringtones. That's ~3–5 min per language, so several
languages fit and packs update over OTA. **Spoken names** ("…from Grandma") come from a short
clip the guardian records in the companion app, cached on the device (protocol §13).

---

## 4. MCU and radio

**Chosen: ESP32-S3-WROOM-1-N16R8** (LCSC C2913202, ~$3.4–3.8; 18 × 25.5 mm; PCB antenna; 802.11
b/g/n 2.4 GHz + BLE 5; modular FCC/CE certification). 16 MB flash holds 2 × 4 MB OTA slots +
3 MB prompts + fonts/assets. 8 MB PSRAM holds jitter buffers, AFE and a "session arena" (§10).

| Alternative | Pros | Cons | Verdict |
|---|---|---|---|
| ESP32-C5 (dual-band Wi-Fi 6, ECDSA eFuse key) | 5 GHz for crowded lounges; hardware-isolated P-256 key | ESP-SR AFE/AEC lists ESP32/S3/P4 only; single RISC-V core, no S3 SIMD; module ~$5.4 | **Rejected for r1**; revisit when AFE supports it |
| ESP32-P4 + C6/C5 co-processor | Big DSP headroom, ECDSA peripheral, AFE-supported | Two chips + hosted Wi-Fi, ~$8–10, more power, more PCB | Rejected (cost); v2 path for 5 GHz |
| Bare ESP32-S3 + flash + PSRAM | −$1 | Loses modular certification (+$10–20k testing), RF layout risk | Rejected |

**Radio uses:** Wi-Fi (signalling + WebRTC). BLE is used for **provisioning** (Improv-BLE /
ESP unified provisioning) and, later, lounge proximity. **Caveat:** a PWA can't advertise BLE and
iOS has no Web Bluetooth, so the BLE dead-man switch requires a future native app (§10.4).

**Antenna placement:** module on the **rear edge** of the main board at x ≈ 150–168, antenna
overhanging the edge toward the plastic rear wall (≥3 mm air), with **15 mm copper/component
keep-out around the antenna on all layers** (Espressif PCB layout guideline). Distances:
USB-C/cable ≈ 60 mm, speaker magnet ≈ 100 mm, B-option LiPo ≥ 80 mm, radar ≈ 80 mm (disable
its BLE). The docked handset sits ~20 mm above the antenna, with its magnet 40 mm and receiver
~35 mm away laterally. That's acceptable because the handset is lifted during calls. **No metallic
paint, plating or foil** anywhere on the base; the key plate is FR4, not steel.

---

## 5. Pin allocation (ESP32-S3-WROOM-1-N16R8)

> **Superseded by `schematic/pin_table.yaml`:** since placement A2 (2026-09-28) GPIOs are assigned by
> board geometry (`layout/pinswap.py`), and the radar pins are gone. The table below is the r0.1
> allocation, kept for its reasoning; the build checks the schematic against `pin_table.yaml`.

Constraints: **GPIO35–37 are used by octal PSRAM**; GPIO26–32 are flash/PSRAM internal; **strapping
pins 0, 3, 45, 46** (GPIO45 must be low at reset for 3.3 V flash; GPIO46 + GPIO0 combination
rules); GPIO19/20 = native USB; ADC2 unusable with Wi-Fi, so all analog inputs go on **ADC1
(GPIO1–10)**. Deep-sleep wake sources must be RTC GPIOs (0–21).

| GPIO | Signal | Dir | Board | Notes |
|---|---|---|---|---|
| 0 | BOOT / service button | in | main | Strap. 10 k pull-up, pinhole button. Long-press at runtime = factory reset. |
| 1 | CC1_SENSE | ADC1_CH0 | main | Reads USB-C Rp advertisement: default / 1.5 A / 3 A |
| 2 | CC2_SENSE | ADC1_CH1 | main | 〃 |
| 3 | HS_VBUS_EN | out | main | Handset-port VBUS switch. Strap only if EFUSE_STRAP_JTAG_SEL burned (we don't). 100 k pull-down: off at boot. |
| 4 | LD_RX (UART1) | in | main | UART1 through the GPIO matrix |
| 5 | LD_TX (UART1) | out | main | 256000 baud |
| 6 | LD_OUT | in, RTC wake | main | LD2410C presence pin |
| 7 | PA_EN (NS4150B CTRL) | out | main | 100 k pull-down, so no pop at boot |
| 8 | CHG_STAT (/CHG) | in | main |  |
| 9 | HOOK | in, RTC wake | main | DRV5032 push-pull output |
| 10 | HS_VBUS_SENSE | ADC1_CH3 | main | Handset-port VBUS via 100 k/100 k (overload = sagging VBUS) |
| 11 | I2C_SDA | io | both | 4.7 k pull-ups; 400 kHz |
| 12 | I2S_MCLK | out | main | 256·fs to ES8311/ES7210 |
| 13 | I2S_BCLK | out | main |  |
| 14 | I2S_WS | out | main |  |
| 15 | I2S_DOUT → ES8311 | out | main |  |
| 16 | IRQ (shared) | in, RTC wake | both | Wired-OR open-drain: AW9523B INTN, ST25DV GPO, LIS2DH12 INT1 (open-drain mode **[UNVERIFIED]**). 10 k pull-up. |
| 17 | I2C_SCL | out | both |  |
| 18 | PGOOD (/PGOOD) | in, IRQ | main | Power-fail interrupt → lounge wipe (§9.5) |
| 19 | HS_USB_D− | io | main | Native USB OTG = **host** for the USB-C (UAC) handset port. Flashing/console via the CH340C on the power port. |
| 20 | HS_USB_D+ | io | main |  |
| 21 | LED_DATA (RMT) | out | →deck | Through 74AHCT1G125 (VSYS-powered) to the SK6812 chain |
| 35–37 | — | — | — | **Reserved (octal PSRAM)** |
| 38 | EPD_BUSY | in | deck |  |
| 39 | EPD_RST | out | deck |  |
| 40 | EPD_DC | out | deck |  |
| 41 | EPD_SCK | out | deck | ≤10 MHz |
| 42 | I2S_DIN ← ES7210 (TDM) | in | main |  |
| 43 | U0TXD | out | TP | Console/factory test pad |
| 44 | U0RXD | in | TP |  |
| 45 | CHG_CE (BQ24074 /CE) | out | main | Strap: 10 k pull-down keeps flash at 3.3 V and charging enabled by default |
| 46 | LD_PWR_EN | out | main | Strap: pull-down, so the radar is off at boot |
| 47 | EPD_MOSI | out | deck |  |
| 48 | EPD_CS | out | deck | GPIO matrix (≤10 MHz is fine) |

The GPIO numbers follow the board geometry since 2026-09-28 (`layout/pinswap.py`: each signal leaves
the module on the side facing what it connects to); `schematic/pin_table.yaml` is the source of
truth and the build checks it.

All usable GPIOs are allocated. Expansion is on the **AW9523B** (deck, I2C 0x58, LCSC C148077,
$0.17):

| AW9523B pin | Signal |
|---|---|
| P0_0 | KEY 4 |
| P0_1 | KEY 3 |
| P0_2 | KEY 2 |
| P0_3 | KEY 1 |
| P0_4 | KEY 5 |
| P0_5 | KEY 6 |
| P0_6 | KEY 7 |
| P0_7 | KEY 8 |
| P1_0 | VOL− (side tact) |
| P1_1 | KEY MENU |
| P1_2 | MUTE_SENSE (2nd pole of slide switch) |
| P1_3 | VOL+ (side tact) |
| P1_4 | LED_PWR_EN (P-FET cuts SK6812 quiescent ~1 mA each; port 1 = push-pull) |
| P1_5 | KEY 9 |
| P1_6 | KEY 0 |
| P1_7 | KEY BACK |

Keys are active-low to GND with **external 10 k pull-ups**; the port order follows the board
geometry (`schematic/ui.py AW_PORTS`, 2026-09-28) so the key lines fan out without crossing.

**I2C map (no conflicts):** ES8311 0x18, **LIS2DH12 0x19** (SA0=1, avoids ES8311),
LTR-303ALS 0x29, MAX17048 0x36 (B-option), ES7210 0x40, ST25DV04K 0x53/0x57 (+0x2D system),
AW9523B 0x58, ATECC608B 0x60 (DNP).

**Main↔Deck FFC (24-pin, 0.5 mm, ~60 mm):** 3V3 ×2, VSYS ×2, GND ×6 (interleaved), EPD ×6,
I2C ×2, IRQ, LED_DATA(buffered), PRIV_LED_K, MUTE_SENSE, VOL_DN, VOL_UP (since the stacked
form factor the side controls sit on the main board; hardware/schematic/ffc.py is the pinout).
No analog audio crosses the FFC.

---

## 6. Input: keys, hook, side controls

### 6.1 Key count and layout

**12 MX-compatible keys at 19.05 mm pitch** (owner decision 2026-09-27), two rows of six:

```
 rear row:   1   2   3   4   5   MENU
            [   e-ink strip, centred over the five digit columns   ]
 front row:  6   7   8   9   0   BACK
```

- Digits 0–9 are essential (dialling, codes). Pressing a digit selects the option the strip
  shows for it. **MENU** turns the digits into soft keys labelled on the strip (contacts,
  speakerphone, voicemail, settings); **BACK** steps out. Hang up = handset on hook;
  speakerphone is a menu item (no SPEAKER/END keys).
- The strip is **representational**, not physically aligned: it draws the two rows of labels in
  the same order as the keys (the 79 mm panel is narrower than the 95.25 mm digit span).
- **Kids Lite (no display):** the same keys drive a **voice menu** (audio prompts); relegendable
  clear keycaps can carry photos for the contacts reachable by digit.
- Lounge: per-session contacts on the digits (names on the strip, presence on the key LEDs).
- The deck is generated from `n_keys` (hardware/schematic/config.py, even 4..12), so a later
  change of key count is a parameter change plus a placement review.

### 6.2 Switch choice

| Option | Height (approx) | Keycaps | Hot-swap | Verdict |
|---|---|---|---|---|
| **MX-compatible full-height** (Gateron/Kailh/Cherry MX2A), tactile ~55 gf | ≈22.5 mm stack with DSA | Any MX cap incl. relegendable photo caps | Kailh CPG151101S11 (LCSC, $0.066) | **Chosen**, per the owner. Fits because the deck body is 36 mm tall. |
| Kailh Choc v2 (MX stem, Choc body) | ≈ −5 mm | MX caps | Choc v2 socket | Fallback if ID wants a thinner deck |
| Choc v1 / Cherry MX ULP / Gateron KS-33 | thinnest | proprietary caps | varies | Rejected: no standard caps |

- **Tactile, not linear, not clicky:** confirmation for kids and no clatter in a lounge.
- **Plate-mounted on a 1.6 mm FR4 plate** (fabricated in the same panel as the PCBs): the plate
  takes the pressing and prying loads, not the hot-swap sockets. Four 3.4 mm standoffs tie plate
  to deck PCB. FR4 rather than steel keeps metal away from the NFC coil and antenna.
- **Kid-proofing:** hot-swap lets a parent replace a snapped stem with a switch puller. Keycap
  pullers aren't shipped; DSA caps are fine for fingers. Skin holes are 19.5 mm, so there's no
  pinch gap bigger than a finger tip (verify against ASTM F963 / EN 71-1 if in scope).

### 6.3 Per-key LEDs (primary status surface)

11 × **SK6812MINI-E** (reverse-mount, 3.2 × 2.8 mm, LCSC C5149201, $0.045), one under each switch
(shines through the MX LED window and a translucent/shine-through or relegendable cap) + one
status pixel beside the strip. The chain runs from VSYS (4.4 V) via P-FET (LED_PWR_EN), with data
level-shifted by 74AHCT1G125. Firmware caps total brightness at 30% (~120 mA). The ALS dims or
blacks them out at night.

Suggested LED language (firmware; configurable):

| State | Pattern |
|---|---|
| Idle, contact mapped | dim warm white (off at night) |
| Contact "open to chat" (Lounge) / online (Kids) | green, slow breathe |
| Incoming call from contact | that key flashes white, others off |
| Dialling / ringback | key pulses blue |
| Missed call / voicemail waiting | amber solid / amber slow blink on that key |
| Quiet hours | all keys off; status pixel dim violet |
| Offline (no Wi-Fi/server) | status pixel red; lifting the handset plays the "offline" prompt instead of dial tone |
| Pairing / provisioning | chase animation across keys |
| Lounge presence challenge | one random key fast white pulse |
| Low battery (B-option) | status pixel amber |

### 6.4 Other inputs

- **Hook:** TI **DRV5032** omnipolar hall switch (SOT-23, LCSC C2655033, ~$0.10; 20 Hz version
  ~1.6 µA @ 3 V). Use the 20 Hz high-sensitivity omnipolar variant (FB per my reading **[UNVERIFIED:
  confirm variant table]**). Magnet: **12 × 4 mm N52 disc**. On-axis field
  B(z) = (Br/2)·[(z+L)/√(R²+(z+L)²) − z/√(R²+z²)], Br ≈ 1.45 T, R = 6, L = 4:
  z = 15 mm → 18 mT; **z = 20 mm → 8.9 mT**; z = 25 mm → 5.0 mT; lifted z = 60 mm → 0.44 mT.
  Design target: sensor-to-magnet ≤ 17 mm docked (≈13 mT, ≥2.5× BOP max), so it releases
  cleanly off-hook. Replaces the AH3144, which is unipolar, draws mA and is an old part.
  **Third-party handsets have no magnet.** A DNP footprint for an IR reflective sensor (ITR8307
  class) under a trough window covers them.
- **Side controls (right end face):** VOL−, VOL+ (right-angle SMD tact), **MUTE slide switch**
  (DPDT: pole A physically breaks MICBIAS to both mics; pole B → MUTE_SENSE).
- **Rejected:** a dedicated "open to chat" toggle. Presence is set in the companion app, and
  long-press END is available if the owner wants a physical one.

---

## 7. Display: e-ink status strip

**Chosen: Good Display GDEY029T94** (2.9", 296 × 128, SSD1680, SPI, outline 79.0 × 36.7 mm,
active 66.9 × 29.06 mm, 24-pin 0.5 mm FPC; full 3 s / fast 1.5 s / partial 0.3 s). No front light.

| Candidate | Outline / active (mm) | Fits | Verdict |
|---|---|---|---|
| GDEY0213B74 2.13" 250 × 122 | 59.2 × 29.2 / 48.6 × 23.7 | 3 key columns | Compact-6 cost-down (~−$1) |
| **GDEY029T94 2.9" 296 × 128** | 79.0 × 36.7 / 66.9 × 29.1 | **4 key columns (76.2 mm)** | **Chosen** |
| GDEY0579T93 5.79" bar 792 × 272 | 150.9 × 56.9 / 139 × 47.7 | Too tall for a 92 mm deck with 2 key rows | Rejected |

**Content:** label bands (≈40 px) above/below for the rear/front key rows; the 48 px centre line
shows status, e.g. "Quiet hours until 7:00", "Offline — Wi-Fi", "Pair code 429 117",
"Missed: Grandma 3:14pm", "USB power / 82% charging", Lounge "Sam • Alex • Kim open to chat".
The status line can temporarily take the full panel (pairing code at 40 px digits; Wi-Fi setup QR).

**Refresh policy:** partial refresh for status changes; full refresh every ~10 partials or 1 h to
avoid ghosting. Deep-sleep the SSD1680 between updates (standby ~µW). **Labels are rendered
server-side as 1-bpp bitmaps** (protocol §13), so any script or emoji works and no 2 MB Unicode
font sits in flash.

### 7.1 Can the strip render a scannable QR?

Pixel pitch = 66.9 mm / 296 = **0.226 mm**. Height 128 px.

| QR | px/module | Symbol | Quiet zone (≥4 needed) | Capacity (alphanumeric) | "10:1" scan distance |
|---|---|---|---|---|---|
| V2 (25 mod) | 4 | 22.6 mm | 14 px = 3.5 mod (marginal) | L 47 / M 38 | ~23 cm |
| **V4 (33 mod)** | **3** | **22.4 mm** | 14.5 px = 4.8 mod ✓ | L 114 / **M 90** | **~22 cm** |
| V3 (29 mod) | 4 | 26.2 mm | 6 px = 1.5 mod ✗ | M 61 | ~26 cm |

Payload: uppercase URL + base32 128-bit token, e.g.
`HTTPS://PHONE.EXAMPLE.ORG/L/` + 26 chars ≈ 55–70 chars → **V4-M in alphanumeric mode**.

**Verdict: marginal at arm's length (50–60 cm needs ≥50 mm), fine at 20–25 cm.** A modern phone
camera (≈4000 px across a ~70° FOV) at 50 cm resolves ~3.9 px per 0.68 mm module, which may
decode but isn't reliable. So the **primary lounge path is a printed 30–35 mm QR** on the base
front face (1.3–1.4 mm modules → ~35 cm) or a venue table-tent (60 mm → arm's length), plus the
NFC tap zone. The strip QR (rotating token) is secondary. The strip is also where the **SoftAP
Wi-Fi-join QR** appears during setup (§10.5), and 22 cm is fine there.

### 7.2 Display technology comparison (owner-requested)

**What the display actually has to say** (longest realistic strings):
`QUIET TIL 7:00` (14), `PAIR 429 117` (12), `CALLING MOM` (11), `MISSED GRANDMA` (14),
`OFFLINE - WIFI` (14), `USB 82% CHG` (11), `IN CALL 12:04` (13), Lounge `SAM ALEX KIM OPEN` (17+).
Contact labels are up to 24 chars in the protocol, so anything under ~14 characters needs scrolling
or truncation. Lounge also needs **a label beside each key**, because names change every session.

**Slot available:** the 79 × 37 mm band between the key rows (or ~80 × 15 mm if the rows are
pushed together for a thin segment display).

| Option | Chars / resolution in slot | Glyph height | Update speed | Light at night | Bright-room readability | QR? | Per-key labels? | Extra pins | Power (typ, lit) | Cost @1k (display + driver + lens) |
|---|---|---|---|---|---|---|---|---|---|---|
| **A. E-ink strip GDEY029T94** (chosen) | 296 × 128 px, any font/script, labels for 8 keys + status line | 5–12 mm (any) | 0.3 s partial; fine for status, not for a 1 Hz timer | **None (reflective)** | Excellent (paper-like) | V4-M at ~20–25 cm | **Yes** (between rows) | 6 (SPI + DC/RST/BUSY) | ≈0 idle; ~10 mW during refresh | **≈ $4.98** (panel 4.50 + FPC/boost 0.28 + window 0.20) |
| B. 14/16-segment LED array: 5 × dual 0.39" 14-seg + 2 × **HT16K33** (I2C, 16 × 8, 16-level dimming, LCSC ~$0.23–0.26) | 10 chars (scroll longer) | ~10 mm | Instant (timer, ring animation) | Emits; HT16K33 dims to 1/16, **blank at night via ALS** | Good behind smoked lens | No | No (scroll + press-to-preview) | 0 (I2C 0x70/0x71) | 25–60 mA @3.3 V (0.08–0.2 W) | ≈ $2.32 (modules ~1.50 EST + HT16K33 ×2 0.52 + smoked lens 0.25 + passives) |
| C. Plain 7-segment (8 digits, TM1640 / HT16K33) | Digits + a few crude letters | ~9 mm | Instant | Emits | Good | No | No | 0 (I2C) or 2 (TM1640) | 20–40 mA | ≈ $1.0 |
| D. 5 × 7 / 8 × 8 dot-matrix LED (MAX7219 / HT16K33) | ~5 chars at 0.7" in 80 mm; 8 × 32 matrix = 5 low-res chars | 12–17 mm | Instant | Emits (a lot) | Good | No | No | 0–3 | 50–150 mA | ≈ $3–4 (1 driver per 1–3 chars) |
| E. Single 0.91" OLED 128 × 32 SSD1306 (I2C 0x3C/0x3D) | 2 lines × 21 chars (5 × 7) or 1 line × ~12 chars (16 px) | **1.2 mm / 2.8 mm** (active only 22.4 × 5.6 mm) | Instant | Emits; must blank at night | Poor in sunlight | **No** (32 px → 3.7 mm symbol) | No | 0 | 2–10 mA text, ~25 mA full-on | ≈ $1.2–1.6 (module/bare glass EST) |
| E2. Larger 2.23" 128 × 32 OLED (SSD1305) | same pixels, ~55 × 14 mm active | ~7 mm (16 px) | Instant | Emits | Fair | No | No | 0 (I2C) | 10–30 mA | ≈ $4–6 **[UNVERIFIED]** |
| F. **One OLED per key** (8 × 0.49" 64 × 32 or 0.91" 128 × 32 via **TCA9548A** mux, LCSC ~$0.58) | 1 name per key, dynamic | 1.5–3 mm | Instant | **8 glowing panels** | Poor | No | **Yes** | 0 (I2C behind mux) | 8 × 3–10 mA | ≈ $10–13 (8 × 1.0–1.3 + mux 0.58 + 8 FPC conns 0.64 + windows) |
| G. Hybrid: B (14-seg) + per-key RGB + relegendable caps + printed QR/NFC, **no e-ink** | 10 chars status | ~10 mm | Instant | Blankable | Good | No (printed) | Kids: photo caps; Lounge: no | 0 | as B | ≈ $2.32 (saves ≈ $2.66 vs A) |

Notes on the owner's OLED ideas:

- **0.91" OLED:** zero extra pins (shares I2C), cheapest, fast, and can do icons. But its
  22 × 5.6 mm active area gives 1.2–2.8 mm glyphs. That's legible at 25 cm and not at the
  40–70 cm of a desk phone or lounge booth. Static status text (e.g. "QUIET TIL 7:00" for 10 h a
  night) is the worst case for **burn-in** (hobby-grade SSD1306 T50 ≈ 5–10 kh at full contrast).
  It needs pixel-shift + timeouts, and then it's blank most of the time anyway. It's too short for
  any QR. **Useful as a bench/dev-kit debug display, not the product display.**
- **One OLED per key** as a dynamic legend is attractive for Lounge (names beside keys), but:
  ~$10–13 BOM (2–3× the e-ink), 8 FPC joints and a mux on a board kids hammer, and 8 light
  sources in a child's bedroom. Static names are exactly the burn-in pattern OLEDs hate. It also
  can't fit 0.91" modules (38 mm) at 19.05 mm key pitch, so only 0.49"-class glass works, and its
  glyphs are ~1.5 mm. The e-ink strip gives the same "label beside each key" result for ~$5, emits
  no light and never burns in.
- **Segment arrays (B/G):** they're the right answer for **live** content (call timer, ring
  animation), but the per-key RGB LEDs already cover animation, and a call timer isn't a product
  requirement. They can't show per-key names for Lounge, can't do QR, and add a glowing
  "alarm-clock" look that conflicts with the calm, distraction-free ethos. HT16K33 can dim to
  1/16 and the ALS can blank it at night, which mitigates but doesn't remove the problem.

**Recommendation: keep A (e-ink strip between the key rows) + per-key RGB LEDs + audio prompts**
for both SKUs:

- It's the only option that gives **per-key labels** (needed for Lounge's per-session names),
  **no light emission** in a dark bedroom, **no burn-in**, and a secondary QR.
- Its one weakness (slow refresh) is exactly what the per-key LEDs cover (ringing, dialling,
  presence animation).
- **Documented cost-down "Lite" variant = G** (14-seg HT16K33 array, no e-ink; −$2.66, frees
  GPIO10–15, +25–60 mA when lit, Lounge falls back to press-to-preview names). Kids-only SKU could
  take it if the $20 target becomes hard.
- Rejected: C (text too poor), D (too few chars / too much light), E/E2 (glyphs too small /
  light + burn-in), F (cost, fragility, burn-in).

The pin table (§5), power budget (§9.2) and BOM (§12) in this document are for option **A**.
If option G is chosen: remove EPD_CS/MOSI/SCK/DC/RST/BUSY (GPIO10–15 become spare), add 2 ×
HT16K33 at I2C 0x70/0x71 (no address conflicts), add 25–60 mA to the 3V3 column in idle/call
states, and swap $4.98 of display parts for $2.32.

---

## 8. Sensors and extras

> **Current board (2026-09-28):** the LD2410C radar and the ATECC608B footprint are **removed**
> (Lounge presence is deferred to a possible future board; the ESP32-S3 uses flash encryption +
> eFuse HMAC). The MAX17048 fuel gauge is always fitted. NFC sits in a free end region of the one
> board, not on a deck. The table keeps the original evaluation.

| Function | Part | Decision |
|---|---|---|
| Presence (Lounge) | **HLK-LD2410C** (24 GHz FMCW, ±60°, 5 V, ~79 mA avg, UART 256000, 3.3 V IO; LCSC HLK-LD2410C-P C19723500) | **Lounge only** (DNP on Kids). Mounted vertically on the main-board front edge (x 170–192) via a right-angle 5-pin header. Antenna face **12.4 mm (1λ) ±1.2 mm** behind a **radome window thinned to ≤0.9 mm** (≈λ/8 in PC, εr≈2.9) per Hi-Link guidance; no paint on the window. Distance gates limited to 0–1.5 m so passers-by don't count. **Send the "disable BLE" command at every boot**: its BLE config service is an open door in a public booth. Alternatives: LD2450 (multi-target x/y, better "zone" rejection, larger), LD2402/LD2410S (lower power, less mature). |
| Ambient light | **LTR-303ALS-01** ($0.21, C364577) | Chosen over BH1750 ($0.52) and VEML7700 ($0.98). Drives LED dimming and night mode. Light pipe beside the strip. |
| NFC | **ST25DV04K** dynamic tag, I2C + RF, energy harvesting; PCB coil on the deck encircling the strip band (no copper pour inside the loop) | **Both SKUs** (~$0.5). Tap → NDEF URL (setup, pairing link, lounge takeover token). Any phone reads it with no app. Rotate the token **only on presence events** to respect EEPROM endurance. Store no personal data in it. EVT must validate coupling through the e-ink glass + key metal. Fallback coil location is the right-end top. |
| Accelerometer | **LIS2DH12** (0x19) | Tamper/theft/"knocked over" events (Lounge), shake-to-wake diagnostics. ~$0.35 (SC7A20 clone −$0.25). |
| Temperature | ESP32-S3 internal + LIS2DH12 temp + battery NTC (B-option) | Enough for thermal throttling of charge/amp |
| Secure element | ATECC608B **DNP footprint** | P-256 only (no Ed25519). Populate only if protocol adopts p256 (§10) |
| Fuel gauge | MAX17048 ($1.34, C2682616) | **B-option only** |
| Haptic | — | **Rejected.** A vibrating desk base just rattles. Silent ring = key LED flash + strip |
| Privacy LED | Red LED driven by a BJT sensing the *post-switch* MICBIAS | **Hardwired**: firmware can't power the mics without lighting it |
| Physical mute | DPDT slide on the right end face | Breaks bias to both mics in hardware + reports state |
| Knocked-off-hook | Firmware: off-hook + no key + (radar empty or 60 s) → howler prompt, report `handset: "abandoned"` | Protocol §13 |

---

## 9. Power

### 9.1 Architecture

```
USB-C (sink, 2× 5.1 kΩ Rd on CC1/CC2, D+/D− to ESP32 USB)
  │  PTC 1.5 A ─ TVS (5 V SMF-class) ─┬──────────────────────────► VBUS_5V ─[P-FET LD_PWR_EN]─► LD2410C
  │                                   │
  └──────────────────────────────────►│ BQ24074 (IN: OVP 6.6 V, ILIM=1.5 A, DPPM)
                                      ├─ OUT = VSYS (≈4.4 V on USB [UNVERIFIED], = VBAT on battery)
                                      │     ├─► TLV62569 buck 2 A ──► 3V3  (ESP32-S3, e-ink, AW9523, sensors)
                                      │     ├─► low-noise LDO 3.0 V ─► AVDD (ES8311, ES7210, MICBIAS)
                                      │     ├─► NS4150B (speaker amp)
                                      │     ├─► [P-FET LED_PWR_EN] ─► SK6812 chain
                                      │     └─◄ Schottky ◄─ 0.47 F/5.5 V supercap ◄─ 47 Ω (Lounge hold-up)
                                      └─ BAT ─► (B-option) 1S LiPo 1200 mAh + NTC(TS) ─ MAX17048
```

- **USB-C:** sink-only, separate 5.1 kΩ Rd per CC pin (required for C-to-C chargers). **No PD.**
  CC1/CC2 are read by ADC to learn the advertised current (Default ≈0.25–0.61 V, 1.5 A ≈0.70–1.16 V,
  3 A ≈1.31–2.04 V). Firmware then caps amp level and LED brightness and disables charging on
  Default-USB sources. USB 2.0 data goes to the native ESP32 USB for flashing/DFU/console.
- **BQ24074 is always fitted** ($0.63, C54313) even without a battery: it provides input OVP,
  a programmable input current limit, and DPPM (the system load has priority over charging).
  That means one BOM for both power options. **[UNVERIFIED]** BQ24074 regulated OUT voltage on
  input power (I read 4.4 V; confirm, else pick the variant with the higher OUT) and its
  no-battery configuration (TS/BAT handling).
- **3.3 V via buck** (TLV62569, supports 100% duty for battery operation), not an LDO: a
  4.4 → 3.3 V linear at 0.45 A peak dissipates 0.5 W in SOT-23. **Analog 3.0 V via LDO** keeps
  buck ripple out of the codecs and mic bias.
- **Rejected:** TP4056 + DW01A (no power path: system load confuses charge termination; no OVP;
  no input current limit). IP5306 (power-bank SoC with its own boost and auto-shutdown at light
  load; wrong fit). BQ25895 (switching charger, more capable, overkill for 0.5 A charging).

### 9.2 Power budget (at the 5 V USB input)

Assumptions: 3V3 via buck η≈88% (I₅ ≈ 0.75·I₃.₃), VSYS loads pass linearly through BQ24074.
ESP32-S3 Wi-Fi TX peak **355 mA** (802.11b 1 Mbps, 20.5 dBm, datasheet). LD2410C **79 mA avg @5 V**.

| Load | Rail | Idle Kids | Idle Lounge | Handset call (Lounge) | Speakerphone (Lounge) | Ringing max | Worst-case peak |
|---|---|---|---|---|---|---|---|
| ESP32-S3 + PSRAM (modem-sleep idle / active call / TX peak) | 3V3 | 40 → 30 | 40 → 30 | 140 → 105 | 140 → 105 | 60 → 45 | 355 → 266 |
| ES8311 + ES7210 + mic bias | 3V0 | 1 | 1 | 25 | 25 | 10 | 25 |
| E-ink strip (avg; refresh ≈10.5 mW) | 3V3 | ~0 | ~0 | ~0 | ~0 | 3 | 6 |
| AW9523B, LTR-303, LIS2DH12, DRV5032, ST25DV | 3V3 | 0.5 | 0.5 | 0.5 | 0.5 | 0.5 | 1 |
| SK6812 ×13 (quiescent ~1 mA each + light; ×13/11 of the 11-LED figures) | VSYS | 32 | 47 | 35 | 35 | 142 (capped) | 473 (uncapped) |
| LD2410C | VBUS | — | 79 | 79 | 79 | 79 | 100 |
| NS4150B (avg electrical in) | VSYS | 0 | 0 | 0 | 130 | 470 | 550 |
| **Total @5 V** | | **≈59 mA / 0.30 W** | **≈151 mA / 0.76 W** | **≈240 mA / 1.2 W** (Kids ≈160 mA / 0.8 W) | **≈370 mA / 1.85 W** | **≈730 mA / 3.6 W** | **≈1.35 A / 6.7 W** |
| + B-option charging | VSYS | +500 | — | — | — | DPPM throttles | throttled |

- With the policy caps (LEDs ≤30%, amp limited by CC advertisement), worst case is ≈1.07 A,
  which fits a **1.5 A**-advertising source with margin. On a Default-USB source (500/900 mA):
  ringer ≤0.5 W, LEDs ≤10%, charging off.
- Night-mode idle (LEDs switched off) ≈ 31 mA ≈ 0.16 W.
- **B-option runtime** (1200 mAh ≈ 4.4 Wh, ~3.8 Wh usable): idle ≈ 11 h, night idle ≈ 20 h,
  handset call ≈ 4 h.
- **Thermal:** worst sustained dissipation is inside the amp (~0.25 W) and BQ24074 while charging
  ((4.4−3.7) × 0.5 ≈ 0.35 W, thermal regulation at ~110 °C junction). Charging is limited to
  0–45 °C via NTC. Place the charger and amp away from the battery pocket.

### 9.2a USB source policy (Default / 1.5 A / 3 A)

The sink reads the source's Rp advertisement on CC1/CC2 (GPIO1/2, ADC1) with the 5.1 kΩ Rd in
place: < 0.66 V = Default (500 mA; also what every USB-A→C cable reports), 0.66–1.23 V = 1.5 A,
> 1.23 V = 3 A. Re-read on attach and every few seconds (sources may change advertisement).

| Board (one design since 2026-09-28) | Default source | ≥1.5 A source |
|---|---|---|
| main | **reduced mode**: LEDs ≤10 %, ringer ≤0.5 W, charging off; strip "USE 1.5A CHARGER" (491 mA peak) | full features (1.11 A capped peak) |

USB PD / higher voltages are deliberately not used: everything runs from 5 V, and a 5 V / 3 A
Type-C advertisement already covers the worst case. Budget numbers and the per-SKU requirement
are enforced by `hardware/schematic/power_budget.yaml` + `check_power_budget`.

### 9.3 Battery decision

**Superseded 2026-09-28 (owner): the battery charger, fuel gauge and JST-PH-3 are fitted on the
one board**; the pack (≤ 40 × 30 × 6 mm, e.g. 603040 ≈ 700 mAh) lies under the board
(LAYOUT.md). Earlier text: **Default: no battery (both SKUs).** Rationale: a desk device on USB. In a power cut the home
router is down too, so a battery buys little connectivity. Users who want backup plug in a USB-C
power bank with pass-through, which acts as an external UPS at zero product risk. Kids' "battery
%" becomes **power status** (`usb` / `battery nn%` / `unplugged→offline`).

**B-option (footprint-ready, SKU decision after EVT):** 1S LiPo pouch 603450, ~1200 mAh, with
integrated PCM, 10 k NTC, **IEC 62133-2 + UN 38.3** (UL 2054 for US retail), JST-PH-2 with
polarized latch, in a screwed battery compartment (toy-safety expectation). MAX17048 populated.

| Option | Verdict |
|---|---|
| 18650 in a holder | Rejected: 10 Wh in a kids' product; loose unprotected cells; steel can near the antenna |
| LiPo pouch 1200 mAh | B-option |
| Supercap only | Too little energy for runtime (~seconds). **Used for power-fail wipe on Lounge** |
| None | **Default** |

### 9.4 Safety for a kids' product

Low-voltage USB input only; no mains in the product. PTC + OVP + TVS on the input. Charger
thermal regulation + NTC. Enclosure V-0 or V-2 PC/ABS. Screws on every battery-access path.
Hot-swap switches are ≥ small-parts-cylinder size **[UNVERIFIED vs ASTM F963 small-parts rule;
a removed keycap may fail]**, which is an open question (§15).

### 9.5 Lounge power-pull wipe

> **Removed (2026-09-28):** the supercap hold-up is not on the board; a power-pull wipe is
> deferred with the other Lounge hardware. In software, a Lounge session already ends (and the
> phone forgets the person) when the phone disconnects for more than a minute.

Pulling USB would otherwise leave the user's session names on the bistable e-ink. The 0.47 F
supercap on VSYS stores ½·C·(4.4² − 3.4²) ≈ **1.8 J**. On /PGOOD rising (GPIO48 IRQ): amp, LEDs
and radar off → send `session.end{reason:"power"}` → **fast refresh the strip to a neutral
screen and overwrite both SSD1680 RAM banks** → zeroize session arena. That's ≈0.9 W for 1.5 s
≈ 1.35 J, which fits. The supercap charges through 47 Ω (τ ≈ 22 s) so it doesn't trip the
BQ24074's start-up short-circuit detection.

---

## 10. Security and identity

### 10.1 Protecting the device key

- The protocol uses **Ed25519** (`pair.begin.publicKey` 32 B, `auth.proof.sig` 64 B).
- ESP32-S3's **Digital Signature peripheral is RSA-only**. ATECC608B is **P-256 only**; NXP
  SE050 supports Ed25519 but costs several dollars. **ESP32-C5/P4/H2 have an ECDSA peripheral
  (P-256)** with an eFuse key that software can't read.

**r1 design (no secure element):**

1. **Secure Boot v2** (RSA-3072 on S3), revoke unused digests, **flash encryption in release
   mode**, UART download → secure download mode, **disable pad JTAG and USB-JTAG** via eFuse in
   production (keep USB-Serial for recovery).
2. **NVS encryption with HMAC-based key protection** (the NVS key is derived from an eFuse HMAC
   key, not stored in flash).
3. **The Ed25519 seed is never stored.** At boot: `seed = HMAC_eFuse(KEY_HMAC_UP, "otc-dev-key" ‖ epoch)`
   computed by the HMAC peripheral. Pubkey is derived with libsodium/monocypher. Factory reset or
   re-pair bumps `epoch` (stored in NVS), which yields a new identity. A flash dump, even with the
   XTS key, contains no private key. Residual risk: code execution on the device can still read the
   seed from RAM, and there's published fault-injection work on ESP32 families **[UNVERIFIED for S3
   rev ≥0.2]**.
4. eFuse key-block budget (S3 has 6): XTS-AES-128 (1) + SBv2 digest (1, +1 spare) + NVS HMAC (1)
   + identity HMAC (1) = 5 ≤ 6.

**Protocol recommendation:** add `alg: "ed25519" | "p256"` to `pair.begin` now (P-256 raw r‖s
signatures are also 64 bytes/86 chars, compressed pubkeys 33 bytes/44 chars). That enables
ATECC608B (populate the DNP footprint) or a future C5/P4 board with a truly non-extractable key.

### 10.2 Zero-trace logout (Lounge)

**What holds session state, and how it's wiped:**

| Place | Content | Wipe |
|---|---|---|
| SRAM/PSRAM | session token, user label, contact list/presence, call log, SDP/ICE, DTLS/SRTP keys, jitter/AEC/Opus buffers, WebSocket buffers | Allocate everything session-scoped from a **dedicated PSRAM "session arena"** (multi_heap on a static 1–2 MB region) → `memset` the whole arena + `mbedtls_platform_zeroize` for keys → `esp_restart()`. PSRAM is **not** cleared by reset, which is why the explicit wipe comes first. Enable heap poisoning for everything else. |
| **E-ink panel + SSD1680 RAM** | names on the glass (bistable!) and the previous-frame RAM used for partial refresh | Full refresh to the neutral idle screen **and** write the neutral image to both RAM banks (0x24/0x26) |
| NVS / flash | must hold **nothing** session-related | Lounge build asserts no `nvs_set*` during a session. **Disable flash core-dumps** in Lounge. BLE: non-bonding only (NimBLE would persist bonds to NVS). |
| ST25DV EEPROM | only a non-personal takeover token | Rotate on logout |
| Logs | console | Production log level WARN, no user labels in logs |
| Server | session, presence subscriptions | `session.end` → server revokes token (source of truth) |

**Triggers:** radar reports empty for >60 s → 10 s warning (chime + END key flashing + strip
"Ending session — press any key to stay") → logout. MENU → "end session". Companion app "leave".
Power pull (§9.5). Server-side heartbeat timeout.

### 10.3 Dead-man switch reality check

> **Status (2026-09-28):** with the radar deferred, the software ends a Lounge session on log-out,
> leave, an idle timeout while hung up (default 10 min), a new takeover, or a disconnect over a
> minute. mmWave presence returns only with a future Lounge board.

- **mmWave:** primary and reliable.
- **BLE proximity to the user's phone:** needs the phone to advertise a session-specific rotating
  identifier. A PWA can't advertise, iOS has no Web Bluetooth, and phone MACs are randomized.
  **Not feasible until a native companion app exists.** Keep the ESP32 side ready (BLE scan
  in firmware); treat it as phase 2.
- **Geolocation:** a PWA only gets location in the foreground, so it can't be the dead-man.
  At most a server-side soft signal.

### 10.4 Lounge takeover without a main screen

```
User at booth ──scan printed QR (static https://<srv>/l/<deviceId>)──┐
      or      ──tap NFC (dynamic token URL, rotated on presence)──────┤──► companion web app (logged in)
      or      ──scan strip QR (rotating token, ~20 cm)────────────────┘            │
                                                                                    ▼
server: device must report radar "occupied" (Lounge) ──► server sends lounge.challenge{keyIndex, nonce}
device: lights key #k (fast white pulse) + prompt "press the glowing key" + strip "Press the glowing key"
user presses key k ──► device sends challenge response ──► server binds session ──► device loads contacts
```

A photographed sticker fails because no one is present to press the random key. The NFC path
already proves ~4 cm proximity (the key press can be skipped by policy). The rotating strip QR
needs a live camera feed to abuse, and we still require the key press.

### 10.5 Onboarding and pairing without a main screen

- **Wi-Fi provisioning (in order of preference):**
  1. **SoftAP + Wi-Fi QR on the strip** (`WIFI:T:WPA;S:OpenLoungePhone-7F3A;P:<random>;;`): every modern
     phone joins by camera, no app. The captive portal collects home SSID/password **and the
     backend URL** (self-hosters). The password is random per boot and only visible on the strip,
     so it proves physical access.
  2. **Improv Wi-Fi over BLE** (Web Bluetooth: Android Chrome / desktop Chrome) and **Improv over
     USB-Serial** (desktop Chrome Web Serial, from the companion's setup page). Open standard,
     good fit for an open project.
  3. **ESP-IDF unified provisioning over BLE** (Security 2 / SRP6a with a proof-of-possession) for
     the future native app.
  4. NFC tap opens the setup URL (read-only NDEF; the phone can't write credentials without an app).
- **Pairing (after Wi-Fi):** `pair.begin` → `pair.code`. The **strip shows "Pair code 429 117"**
  in large digits, keys run the chase animation, and **lifting the handset reads it aloud**
  ("Your pairing code is 4-2-9, 1-1-7", repeated). MENU → "speaker" announces it on the speaker. The
  captive-portal success page links to the companion with the device ID prefilled.

---

## 11. PCB design

### 11.1 Boards

| Board | Size (mm) | Layers | Key contents |
|---|---|---|---|
| **Board** (single, owner 2026-09-27; one BOM 2026-09-28) | 180 × 88, R8.5, 9 × M2.5 | 4 | ESP32-S3-WROOM-1U (U.FL), ES8311, ES7210, NS4150B, BQ24074 + MAX17048 (battery optional), buck + LDO, power USB-C (sink) + CH340C, handset USB-C (host, SY6280 VBUS switch), DRV5032 under the hook post, VOL−/VOL+/MUTE (right edge), base mic, LIS2DH12; 12 hot-swap sockets (bottom), 13 SK6812MINI-E (bottom, reverse-mount), AW9523B, LTR-303, ST25DV04K + PCB coil in a free end region, e-ink 24-pin FPC (FPC-05F-24PH20) + SSD1680 boost, privacy/status LEDs. No radar, supercap, ATECC or Qwiic port. Replaces the main + deck pair and their FFC. |
| **Key plate** | 117 × 84 × 1.5–1.6 FR4, 14.0 mm cutouts, strip window | 0 (bare FR4) | Panelized with the others |

### 11.2 Stackup

JLCPCB **JLC04161H-7628** (≈1.6 mm): L1 signal/components (35 µm) / 0.21 mm PP / **L2 solid GND** /
1.065 mm core / **L3 power pours (3V3, VSYS, 3V0) + slow signals** / 0.21 mm PP / L4 signal + GND fill.
It supports 90 Ω USB diff pairs (D+/D− are short; impedance control is nice-to-have). Material
FR-4 TG155 if impedance is ordered. **ENIG** finish (QFN-20/32 and FPC fine pitch).

### 11.3 Placement and layout rules

- **RF:** module on the rear edge, antenna overhanging, 15 mm keep-out all layers, no parts or
  screw bosses in the keep-out, stitching vias along the GND edge. USB-C and RJ9 ≥50 mm away.
- **Audio/analog:** one continuous GND plane, **no split**; partition by placement. Codecs,
  AVDD LDO and the jack/mic front-ends sit together at the rear-left/centre. NS4150B goes near the
  speaker connector (left) with tight output loops and a small LC/ferrite on outputs for EMI.
  The buck sits away from codecs with its loop on L1 over solid L2. Mic lines route as tightly
  coupled pairs with guard GND and no layer changes. AEC reference divider at the ES7210 input.
- **ESD:** USBLC6-2SC6-class on D+/D−, low-cap ESD on CC1/CC2, 5 V TVS on VBUS, 4-ch TVS at RJ9,
  TVS on the side-switch lines at the deck edge, GND guard ring on deck perimeter (the gaps around
  keys are ESD entry points).
- **Hall sensor:** DRV5032 on L1 directly under the trough floor at the magnet position, no
  ferrous parts (inductors, shields) within 15 mm.
- **Radar:** keep the LD2410C's forward hemisphere free of copper, cables and screws. Right-angle
  header with a 3D-printed/molded locating bracket.
- **NFC coil (deck):** 3–4 turns around the strip band, no copper pour inside the loop on any layer,
  tuning caps next to the ST25DV, ≥5 mm from switch sockets where possible.
- **Test points (bottom side, 1.0 mm pads, 2.54 mm grid for pogo fixture):** essentials only
  (owner audit 2026-09-28): VBUS, VSYS, 3V3, 3V0, HS_VBUS, GND ×2, U0TX/U0RX, EN, GPIO0. Buses and
  audio are probed on the parts; programming USB is the connector. Factory audio test = loopback plug in the RJ9 (EAR→MIC through an attenuator).
- **Debug/programming:** native USB-C only (USB-Serial/JTAG). No separate header. EN + GPIO0
  pads let a bricked board be forced into download mode.

### 11.4 Fabrication and assembly

- **Family panel** (4-layer): 1 × Main + 1 × Deck + 1 × Plate (+ handset carrier) with mouse-bites
  and 5 mm rails, fiducials, tooling holes. One order, one stencil set, one SMT program.
- Deck is double-sided (sockets and SK6812 on the bottom; AW9523/connectors on the bottom too; only
  the LTR-303 and side switches need the top). Consider moving the ALS to the bottom behind a hole
  to make the deck single-sided.
- **JLCPCB/PCBWay basic vs extended parts:** ESP32-S3 module, ES8311, ES7210, NS4150B, BQ24074,
  AW9523B, DRV5032, SK6812MINI-E, CPG151101S11 are LCSC-stocked (most are *extended* → per-part
  setup fee per batch). Prefer basic-library passives (0402/0603).
- Hand/selective: none required. The RJ9 and USB-C hybrid through-hole pegs reflow fine. The LD2410C
  plugs into a header (not soldered) for field replacement.

---

## 12. BOM and cost (1k qty, USD)

LCSC prices are list prices seen during research (quantity breaks vary). Everything else is an
**[EST]imate**.

> **Superseded by the single board (2026-09-27/28):** the per-board tables below are the r0.1
> estimate for the old main + deck pair. Current costs come from `make build`
> (`schematic/cost.py`, one board, one BOM; see SCHEMATIC.md and `build/main/cost.txt`): about
> $40 per phone at 1k and $38 at 10k, ≈ $208 for a one-off JLCPCB build.

### 12.1 Main board (both SKUs)

| Part | Function | Package | Qty | Unit | Ext | Source/notes |
|---|---|---|---|---|---|---|
| ESP32-S3-WROOM-1-N16R8 | MCU + Wi-Fi/BLE, 16 MB/8 MB | module 18 × 25.5 | 1 | 3.78 | 3.78 | LCSC C2913202 ($3.41–3.78) |
| ES8311 | mono codec, earpiece driver | QFN-20 3 × 3 | 1 | 0.28 | 0.28 | LCSC C962342 |
| ES7210 | 4-ch ADC (mics + AEC ref) | QFN-32 4 × 4 | 1 | 0.47 | 0.47 | LCSC C365743 |
| NS4150B | 3 W class-D amp | ESOP-8 | 1 | 0.07 | 0.07 | LCSC C189961 |
| BQ24074RGTR | power path / OVP / charger | QFN-16 | 1 | 0.63 | 0.63 | LCSC C54313 |
| TLV62569 + 2.2 µH | 3.3 V 2 A buck | SOT-23-5 | 1 | 0.30 | 0.30 | EST (SY8089 cost-down) |
| 3.0 V low-noise LDO | AVDD | SOT-23-5 | 1 | 0.06 | 0.06 | EST |
| DRV5032 (20 Hz omnipolar) | hook sensor | SOT-23 | 1 | 0.10 | 0.10 | LCSC C2655033 |
| LIS2DH12TR | accelerometer | LGA-12 | 1 | 0.35 | 0.35 | EST |
| SPST analog switch | EAR_EN | SC-70 | 1 | 0.08 | 0.08 | EST |
| Electret capsule + boot | base mic | Ø6 | 1 | 0.25 | 0.25 | EST |
| USB-C 16P receptacle | power/data | SMD+THT | 1 | 0.15 | 0.15 | EST |
| 4P4C RJ9 jack | handset | THT/SMD | 1 | 0.12 | 0.12 | EST |
| ESD/TVS set | USB, CC, VBUS, RJ9 | various | 1 | 0.25 | 0.25 | EST |
| PTC 1.5 A | input | 1206 | 1 | 0.03 | 0.03 | EST |
| Mute/privacy BJTs, LD P-FET, headers | misc | | 1 | 0.11 | 0.11 | EST |
| Speaker conn (JST-PH-2) | | | 1 | 0.03 | 0.03 | EST |
| FFC 24P 0.5 mm conn | main↔deck | | 1 | 0.10 | 0.10 | EST |
| Passives (~110) | | 0402/0603 | 1 | 0.70 | 0.70 | EST |
| Tact (BOOT/RESET) | | | 2 | 0.02 | 0.04 | EST |
| PCB 4L 144 × 80 ENIG | | | 1 | 1.20 | 1.20 | EST |
| **Main subtotal** | | | | | **9.10** | |

### 12.2 Deck board + plate

| Part | Function | Qty | Unit | Ext | Source/notes |
|---|---|---|---|---|---|
| AW9523BTQR | 16-bit I/O expander (keys, vol, mute) | 1 | 0.17 | 0.17 | LCSC C148077 |
| SK6812MINI-E | per-key + status RGB | 11 | 0.045 | 0.49 | LCSC C5149201 |
| 74AHCT1G125 + P-FET | LED level shift / power gate | 1 | 0.08 | 0.08 | EST |
| LTR-303ALS-01 | ambient light | 1 | 0.21 | 0.21 | LCSC C364577 |
| ST25DV04K + tuning | NFC dynamic tag | 1 | 0.50 | 0.50 | EST (2017 budget price $0.38) |
| E-ink FPC 24P + SSD1680 boost parts | strip driver | 1 | 0.28 | 0.28 | EST |
| FFC 24P conn + 60 mm cable | | 1 | 0.22 | 0.22 | EST |
| Kailh CPG151101S11 | MX hot-swap socket | 10 | 0.066 | 0.66 | LCSC (C5156480 listing) |
| Mute slide + 2 side tacts | | 1 | 0.11 | 0.11 | EST |
| Privacy/status discrete LEDs | | 1 | 0.02 | 0.02 | EST |
| Passives (~40) | | 1 | 0.25 | 0.25 | EST |
| PCB 4L 117 × 84 ENIG | | 1 | 0.95 | 0.95 | EST |
| FR4 key plate 1.6 mm | | 1 | 0.30 | 0.30 | EST |
| **Deck subtotal** | | | | **4.09** | |

### 12.3 Roll-up

| Block | Kids | Lounge | Notes |
|---|---|---|---|
| Main board parts + PCB | 9.10 | 9.10 | |
| Deck parts + PCB + plate | 4.09 | 4.09 | |
| SMT assembly (JLC-class, ~650 joints, double-sided deck, extended-part fees amortized) | 2.20 | 2.20 | EST |
| **Core PCBA (target < $20)** | **15.39** ✓ | **15.39** ✓ | |
| E-ink strip GDEY029T94 | 4.50 | 4.50 | EST (no public price) |
| MX-compatible tactile switches ×12 | 3.00 | 3.00 | EST $0.25 each |
| Keycaps | 3.44 (8 relegendable + 2 printed) | 1.20 (10 printed DSA) | EST |
| Speaker 40 mm 4 Ω 3 W | 0.60 | 0.60 | EST |
| Handset electrical: receiver 0.35, electret 0.10, magnet 0.12, carrier/jack 0.20, coiled cord 0.75 | 1.52 | 1.52 | EST |
| HLK-LD2410C radar | — | 3.00 | EST (LCSC C19723500) |
| Supercap hold-up | — | 0.50 | EST |
| **Electronics total** | **≈ 27.95** | **≈ 29.21** | vs $20 target ✗ |
| Enclosure (base top/bottom, deck bezel, window, handset shells, light pipes, feet, screws) | 6–8 | 6–8 | EST, excl. $30–60k tooling |
| USB-C cable + packaging | 2.10 | 2.10 | EST; 5 V/2 A USB-C PSU optional +$2.5 |
| **Landed COGS (approx.)** | **≈ $36–38** | **≈ $37–39** | |
| B-option (LiPo 1200 mAh certified 2.50 + MAX17048 1.34 + JST 0.03) | +3.87 | n/a | |
| ATECC608B | DNP (+0.75) | DNP | |

**Honest assessment:** the <$20 goal holds for the **core PCBA ($15.4)**. The full electronics
come to ~$28–29 because of the strip ($4.5), switches and caps ($3.7–6), radar ($3) and handset
parts. Cost-down levers (≈ −$4 to −5): 2.13" strip / Compact-6 (−$1.0), Outemu-class switches
(−$1.5), blank DSA caps on Kids (−$2), drop LIS2DH12 (−$0.35), ES8311-only audio (−$0.47, AEC risk),
2-layer deck (−$0.3), N8R8 module (**[UNVERIFIED]** ~−$0.3).

---

## 13. Firmware and protocol implications (recommendations only — no software changed)

**Identity/handshake**
1. `pair.begin` / `auth.proof`: add `alg: "ed25519" | "p256"` (default ed25519). Allows ATECC608B and
   ESP32-C5/P4 on-chip ECDSA keys.
2. `hello`: add `hw` (e.g. `"trimline-r1"`), `variant: "kids" | "lounge"`, and `caps`
   (`["speaker","radar","nfc","battery","mute-switch","eink-strip-296x128","leds-rgb"]`).
   `buttons: 10` with roles. `display` keeps `"eink"` but the device reports its resolution.

**Buttons/labels/LEDs**
3. `config.buttons[]`: add `role` (`contact|speaker|end`), `short` (≤10 chars), `labelBmp`
   (1-bpp, ~74 × 40 px, server-rendered for any script/emoji/photo), `nameClip` (id/URL of the
   guardian-recorded spoken name).
4. **Semantic key state** (server→device), not raw colours:
   `keys.state [{index, presence:"open"|"away"|"offline", missed:n, voicemail:n}]`. The device maps
   state to LED patterns, which keeps UX consistent across devices and cuts message volume.
5. `config`: add `ringVolume`, `quietUntil` (epoch) so the strip can show "Quiet hours until 7:00",
   `nightMode` hours for LEDs.

**Status/telemetry**
6. `status`: add `power:{source:"usb"|"battery", usbMa?:500|1500|3000}` (battery stays optional),
   `muted`, `volume`, `lux`, `occupied` (bool only — no raw radar data), `tamper`, `tempC`,
   `handset:"ok"|"missing"|"abandoned"`, `fw`. Mirror in `device.status` for guardians.
7. Mute state is forwarded to the call peer (companion shows "muted").

**Audio prompts**
8. `prompt` (server→device): play a sequence of prompt ids / cached clips (e.g.
   `["missed_call_from", {clip:"c_17"}]`). `prompts.version` so packs update over OTA.

**Call model / `deviceStep`**
9. Speakerphone: new input `{type:"speaker", on}` behaving as a virtual hook-up/down.
   `hook` message gains `via:"handset"|"speaker"`.
10. No END key (12-key layout): hang up is the hook; in Lounge, `session.end` is a MENU item (and the radar timeout). MENU/BACK drive a strip menu (voice menu on Kids Lite).
11. `soundFor`: add `"offline"` (prompt instead of dial tone when not connected) and `"howler"`
    (off-hook abandoned). Add an `offline` device state.

**Lounge**
12. New messages: `session.token` (server→device: rotating token + expiry for the strip QR/NFC),
    `lounge.challenge {nonce, keyIndex}` / `lounge.confirm {nonce}`, `session.bound {label}`,
    `session.end {reason:"button"|"presence"|"power"|"app"|"timeout"}` (both directions), plus
    presence feed via `keys.state`.
13. Device must refuse `lounge.challenge` unless its radar reports occupied (defence in depth).

**Provisioning/OTA**
14. Provisioning is out of band (SoftAP captive portal, Improv BLE/Serial, ESP BLE prov). It must
    also carry the **backend URL** for self-hosters.
15. OTA: `fw.offer {version, url, sha256, size}` / `fw.status`. Images are signed for Secure Boot v2.
    Two OTA slots with rollback.
16. Frame size: 16 KB is fine for label bitmaps (~370 B each).

---

## 14. Staging

### 14.1 Dev-kit path (start firmware now, mirrors final architecture)

| Kit | Contents | Mirrors |
|---|---|---|
| **A: "Korvo" (recommended)** | **ESP32-S3-Korvo-2 V3.1** (ES8311 + ES7210 + NS4150, AEC reference on ES7210 MIC3), **Waveshare/Good Display 2.9" SSD1680 e-paper module**, **2 × Adafruit NeoKey 1×4 QT** (MX hot-swap + NeoPixel per key, I2C) or any MX hot-swap macropad with SK6812, HLK-LD2410C, SparkFun Qwiic ST25DV breakout, DRV5032 (or any hall switch) + magnet, landline handset + RJ9 breakout | Audio chain, AEC topology, strip, per-key LEDs, radar, NFC, hook — everything but the power path. The earpiece can hang off the ES8311 output tap or the PA output through a series resistor **[UNVERIFIED: check Korvo-2 test points]** |
| B: "Box" | ESP32-S3-BOX-3 (ES8311 + ES7210) + dock GPIOs + the same peripherals | Same codecs, cheaper; fewer free GPIOs |
| C: "Budget contributor" | ESP32-S3-DevKitC-1-N16R8 + INMP441 + MAX98357A + 2.9" e-paper + MX macropad | Protocol/UI/LED/prompt work only; software-reference AEC (not representative) |
| D: "Frankenphone" | Kit A stuffed into a gutted **AT&T 210** + a 3D-printed deck | Ergonomics, handset feel, hall geometry, cord RF buzz |

Optional on every kit: a 0.91" SSD1306 OLED on the shared I2C bus as a bench debug display
(state machine, RSSI, AEC ERLE). It isn't a product part (§7.2).

Firmware from day one: HAL with `audio_hal` (codec vs I2S-mic), `keys_hal` (AW9523 vs NeoKey seesaw),
`leds_hal`, `strip_hal`, a `deviceStep` port with golden tests generated from `packages/core`, and
a prompt player.

### 14.2 Milestones

| Stage | Qty | Build | Exit criteria |
|---|---|---|---|
| **EVT** (rev A) | 10–20 | Family panel at JLC, SLA/MJF enclosure | All rails and sequencing. AEC ERLE ≥ 25 dB speakerphone. No audible Wi-Fi buzz at max TX with the cord draped over the base. Sidetone subjective pass. Wi-Fi RSSI within 3 dB of DevKitC in-enclosure. Radar through window detects a seated user at 0.3–1.2 m and ignores passers-by at >2 m. NFC reads with iPhone + Android through the strip. QR V4-M strip scan success ≥95% at 20 cm. Hook hysteresis over ±3 mm handset misplacement. Power-fail wipe completes on unplug. Thermal ≤ +15 °C skin at ringing max. |
| **DVT** (rev B) | 50–100 | Soft tooling / urethane casting | Pre-compliance: FCC Part 15B (host), CE RED: EN 301 489-1/-17, EN 62368-1, EN 62311 RF exposure, **EN 18031-1/-2** (cybersecurity; -2 covers toys/childcare processing personal data). Toy scope decision (ASTM F963 / EN 71). Battery (if B-option): IEC 62133-2 / UN 38.3 / UL 2054. Drop test (handset 1 m × 26), key life 1 M presses on hot-swap, ESD ±8 kV contact / ±15 kV air, field trial in 5 homes + 2 lounges. |
| **PVT** | 300–1000 | Hard tooling, production fixture | Pogo test fixture (rails, USB, audio loopback plug, key/LED check via camera), on-device key generation + eFuse burning (secure boot, flash encryption, HMAC keys, JTAG disable) in the fixture, yield ≥97%. Certification reports. |

---

## 15. Open questions for the product owner

1. ~~**Envelope**~~ **Resolved 2026-09-27:** compact stacked base ≈186 × 94 × 33 mm, key deck
   117 × 84 over a 180 × 88 main board, handset on a raised hook rest above the keypad (this
   supersedes the ≈350 mm in-line base accepted earlier the same day).
2. ~~**Key count**~~ **Resolved 2026-09-27:** 12 keys, `1 2 3 4 5 MENU` / `6 7 8 9 0 BACK`
   (§6.1); more contacts than digits are reached through MENU pages on the strip / voice menu.
3. **Battery:** agree to ship **without** a battery (USB power bank = backup), with the B-option held
   for later? Guardians then see "power status" instead of battery %.
4. **Toy classification:** is the Kids' phone marketed to under-14s (EU toy directive / ASTM F963
   in scope, small-parts rules vs removable keycaps and hot-swap switches)? Do we lock keycaps?
5. **Radar on Kids' SKU:** ship DNP (−$3, −0.4 W) or fit it for "someone's near → wake LEDs"?
6. **Lounge assurance level:** is printed-QR + radar + press-the-glowing-key enough, or is NFC tap
   mandatory? Who prints the QR (factory sticker vs venue table-tent)?
7. **Native companion app:** planned? It unlocks BLE dead-man, BLE provisioning on iOS, and
   NFC writes. Without it we rely on radar + server heartbeat.
8. **Protocol:** approve adding `alg` (ed25519|p256) before v1 freezes?
9. **Speakerphone quality bar:** is Lounge hands-free a must-have (drives AEC tuning effort and
   speaker size) or a nice-to-have?
10. **Power supply in box:** include a 5 V/2 A (≥1.5 A advertised) USB-C adapter, or cable only?
    Ringer loudness depends on it.
11. **Cost target:** is $20 meant for the core PCBA (met at ~$15) or the full electronics (~$28)?
    Which cost-down levers are acceptable?
12. **Colour/material:** any metal or metallic-paint trim wanted? It conflicts with antenna, radar
    and NFC placement.
13. **Languages** for the first prompt pack, and who voices them?
14. **5 GHz:** do target lounges have unusable 2.4 GHz? If so, prioritize the P4+C5 / C5 path.

---

## 16. Rejected alternatives (summary)

| Area | Rejected | Reason |
|---|---|---|
| Form | Keys-in-handset Trimline; wide squat base | Passive-handset rule; hidden strip; loses slimness |
| Handset link | I2S/I2C over cord; MCU in handset; USB-C coiled cord | Conductors, EMI/ESD, repairability, active parts |
| Audio | INMP441 + MAX98357A; ES8388; ES8311-only | No passive handset / no HW reference / fewer ADC channels |
| MCU | ESP32-C5; ESP32-P4 + C6; bare S3 chip | No AFE support; cost; certification |
| Keys | Choc v1 / MX ULP / KS-33 | Non-standard keycaps (Choc v2 kept as fallback) |
| Display | 5.79" bar; front-lit panels; any main screen | Envelope; power/cost; owner direction |
| Display tech | 7-seg; dot-matrix LED; 0.91" OLED; per-key OLEDs (14-seg kept as "Lite" cost-down) | Text quality; char count; glyph size, burn-in, light at night; cost/fragility (§7.2) |
| Hook | AH3144 (unipolar, mA); mechanical switch | Power, orientation-sensitive, wear |
| Light | BH1750, VEML7700 | Cost; LTR-303 sufficient |
| Power | TP4056 + DW01A; IP5306; BQ25895; 18650; supercap-only UPS | No power path/OVP; wrong class; overkill; safety; energy |
| Haptics | ERM/LRA motor | Rattles a desk base |
| Secure element | ATECC608B populated by default | P-256 only while the protocol is Ed25519 |

---

## 17. Unverified items and sources

**Unverified / to confirm before schematic freeze**
- Trimline handset-only dimensions (measure a donor AT&T 210 / WE 220).
- 4P4C handset pinout convention (pins 1/4 mic, 2/3 receiver). Solder jumpers cover either case.
- MX stack heights (PCB→plate 5.0 mm, cap heights); CPG151101S11 height (1.85 mm).
- DRV5032 variant letter for 20 Hz omnipolar high-sensitivity; exact BOP/BRP.
- BQ24074 OUT regulation voltage on input power and no-battery configuration.
- ES8311 ADC→DAC mixing capability for analog sidetone.
- Korvo-2 shared-I2S TDM wiring and earpiece test access.
- AW9523B internal pull-ups; LIS2DH12 open-drain INT option.
- Prices for GDEY029T94, switches, keycaps, radar, enclosure, assembly (estimates).
- Fault-injection resistance of ESP32-S3 flash encryption / secure boot.
- LD2410C FCC/CE status: the vendor page says certified. **Obtain the FCC ID/test reports**; without
  them the product needs intentional-radiator testing (47 CFR 15.245/15.249).

**Sources**
- Trimline: [Wikipedia — Trimline telephone](https://en.wikipedia.org/wiki/Trimline_telephone);
  [Bell System Memorial — Trimline](https://memorial.bellsystem.com/telephones-trimline.html);
  [AT&T 210 on Amazon (3.4 × 8.9 × 3.8 in)](https://www.amazon.com/AT-Trimline-Corded-Required-Wall-Mountable/dp/B00005MITU);
  [Cooper Hewitt record](https://collection.cooperhewitt.org/objects/18635497/)
- ESP32-S3: [WROOM-1 datasheet (TX 355 mA)](https://www.espressif.com/sites/default/files/documentation/esp32-s3-wroom-1_wroom-1u_datasheet_en.pdf);
  [LCSC C2913202](https://www.lcsc.com/product-detail/WiFi-Modules_Espressif-Systems-ESP32-S3-WROOM-1-N16R8_C2913202.html);
  [ESP-IDF GPIO notes](https://docs.espressif.com/projects/esp-idf/en/stable/esp32s3/api-reference/peripherals/gpio.html);
  [atomic14 S3 pinout guide (octal PSRAM pins)](https://github.com/atomic14/esp32-s3-pinouts);
  [ESP32-S3 PCB layout guidelines (antenna keep-out)](https://docs.espressif.com/projects/esp-hardware-design-guidelines/en/latest/esp32s3/pcb-layout-design.html);
  [Schematic checklist (USB)](https://docs.espressif.com/projects/esp-hardware-design-guidelines/en/latest/esp32s3/schematic-checklist.html)
- Security: [ESP32-S3 DS peripheral (RSA)](https://docs.espressif.com/projects/esp-idf/en/stable/esp32s3/api-reference/peripherals/ds.html);
  [ESP32-S3 security overview](https://docs.espressif.com/projects/esp-idf/en/stable/esp32s3/security/security.html);
  [ESP32-C5 ECDSA peripheral](https://docs.espressif.com/projects/esp-idf/en/stable/esp32c5/api-reference/peripherals/ecdsa.html);
  [ESP32-P4 ECDSA](https://docs.espressif.com/projects/esp-idf/en/stable/esp32p4/api-reference/peripherals/ecdsa.html);
  [ATECC608B](https://www.microchip.com/en-us/product/atecc608b);
  [Secure elements overview (SE050 Ed25519)](https://www.embeddedrelated.com/parts/security-ics/secure-elements);
  [Espressif RED-DA / EN 18031 guide](https://developer.espressif.com/blog/2025/04/esp32-red-da-en18031-compliance-guide/);
  [BSG EN 18031 overview](https://bsg.tech/blog/eu-radio-equipment-cybersecurity-red-en-18031-compliance-2025/)
- Audio: [ESP32-S3-Korvo-2 V3.1 user guide (AEC ref via ES7210 MIC3)](https://docs.espressif.com/projects/esp-adf/en/latest/design-guide/dev-boards/user-guide-esp32-s3-korvo-2.html);
  [Korvo-2 schematic](https://dl.espressif.com/dl/schematics/SCH_ESP32-S3-Korvo-2_V3.1.2_20240116.pdf);
  [ESP32-S3-LCD-EV-Board AEC reference design](https://docs.espressif.com/projects/esp-dev-kits/en/latest/esp32s3/esp32-s3-lcd-ev-board/user_guide.html);
  [ESP-SR AFE (input_format "MR")](https://docs.espressif.com/projects/esp-sr/en/latest/esp32s3/audio_front_end/README.html);
  [ESP-SR AEC](https://docs.espressif.com/projects/esp-sr/en/latest/esp32s3/acoustic_echo_cancellation/README.html);
  [esp-adf issue: ES8311 single-codec AEC](https://github.com/espressif/esp-adf/issues/1552);
  [ES8311 datasheet (16/32 Ω HP drive)](https://files.waveshare.com/wiki/common/ES8311.DS.pdf);
  [ES8311 LCSC C962342](https://www.lcsc.com/product-detail/C962342.html);
  [ES7210 LCSC C365743](https://www.lcsc.com/product-detail/C365743.html);
  [NS4150B LCSC C189961](https://www.lcsc.com/product-detail/C189961.html);
  [ESP32-S3-BOX-3 (ES8311 + ES7210)](https://docs.zephyrproject.org/latest/boards/espressif/esp32s3_box3/doc/index.html);
  [esp-webrtc-solution releases](https://github.com/espressif/esp-webrtc-solution/releases)
- Display alternatives: [HT16K33 LCSC C87502](https://lcsc.com/product-detail/LED-Drivers_HT16K33_C87502.html);
  [HT16K33A-28SSOP LCSC C5444738](https://www.lcsc.com/product-detail/C5444738.html);
  [0.54" 14-seg example (Kingbright, RS)](https://ph.rs-online.com/web/p/led-displays/1654394);
  [TCA9548A LCSC C130026](https://www.lcsc.com/product-detail/Signal-Switches-Encoders-Decoders-Multiplexers_Texas-Instruments-TCA9548APWR_C130026.html);
  [0.91" 128 × 32 SSD1306 with FPC (BuyDisplay)](https://www.buydisplay.com/0-91-inch-128x32-oled-display-with-connector-fpc-ssd1306-white-on-black);
  [SSD1306 current (DFRobot 0.91")](https://www.dfrobot.com/product-2018.html);
  [OLED burn-in experiment (Hackaday)](https://hackaday.com/2019/04/23/a-year-long-experiment-in-oled-burn-in/);
  [SSD1306 lifetime/burn-in notes](https://zbotic.in/oled-display-burn-in-how-to-prevent-pixel-degradation/)
- Display: [GDEY029T94](https://www.good-display.com/product/389.html);
  [GDEY0213B74](https://www.good-display.com/product/391.html);
  [GDEY0579T93 5.79" bar](https://www.good-display.com/product/439.html);
  [QR 10:1 sizing rule](https://qrlynx.com/blog/qr-code-size-guide-print)
- Keys/LEDs: [Kailh CPG151101S11 LCSC](https://www.lcsc.com/product-detail/C5156480.html);
  [SK6812MINI-E LCSC C5149201](https://www.lcsc.com/product-detail/rgb-leds-built-in-ic_opsco-optoelectronics-sk6812mini-e_C5149201.html);
  [Keycap profile heights](https://www.daskeyboard.com/blog/types-of-keycap-profiles);
  [Cherry MX datasheet](https://cdn.sparkfun.com/datasheets/Components/Switches/MX%20Series.pdf);
  [Kailh Choc v1 dims](https://mechboards.co.uk/products/kailh-low-profile-choc-switches-v1-red)
- Sensors: [DRV5032 datasheet](https://www.ti.com/lit/ds/symlink/drv5032.pdf);
  [DRV5032 LCSC C2655033](https://www.lcsc.com/product-detail/Hall-Switches_Texas-Instruments-DRV5032FBDBZR_C2655033.html);
  [AH1806 (alt.)](https://www.diodes.com/part/view/AH1806);
  [LD2410C datasheet](https://naylampmechatronics.com/img/cms/001080/HLK-LD2410C_datasheet.pdf);
  [LD2410C DroneBot overview (22 × 16 mm)](https://dronebotworkshop.com/ld2410c-human-sensor/);
  [Hi-Link LD2410C product page (FCC/CE claim)](https://www.hlktech.com/en/Goods-239.html);
  [LD2410 radome guidance (manual)](https://www.manualslib.com/manual/2917393/Hi-Link-Hlk-Ld2410.html?page=14);
  [LD2410C LCSC C19723500](https://www.lcsc.com/product-detail/Sensor-Modules_HI-LINK-HLK-LD2410C-P_C19723500.html);
  [LTR-303ALS LCSC](https://www.lcsc.com/product-detail/Ambient-Light-Sensors_Lite-On-LTR-303ALS-01_C364577.html);
  [VEML7700 LCSC](https://www.lcsc.com/product-detail/C1850416.html);
  [BH1750 LCSC](https://www.lcsc.com/product-detail/Ambient-Light-Sensors_ROHM-Semicon-BH1750FVI-TR_C78960.html);
  [ST25DV04K datasheet](https://datasheet.lcsc.com/lcsc/1809051927_STMicroelectronics-ST25DV04K-IER6S3_C155601.pdf);
  [NFC Forum ST25DV pricing note](https://nfc-forum.org/news/2017-03-advanced-dynamic-nfcrfid-tag-ics-stmicroelectronics-combine-long-range-contactless-communication-fast-transfer-mode/);
  [AW9523B LCSC C148077](https://www.lcsc.com/product-detail/I-O-Expanders_AWINIC-Shanghai-Awinic-Tech-AW9523BTQR_C148077.html);
  [TCA9555 LCSC](https://www.lcsc.com/product-detail/I-O-Expanders_Texas-Instruments-TCA9555PWR_C465732.html)
- Power: [BQ24074 datasheet](https://www.ti.com/lit/ds/symlink/bq24074.pdf);
  [BQ24074 LCSC C54313](https://www.lcsc.com/product-detail/C54313.html);
  [TP4056 LCSC](https://www.lcsc.com/product-detail/C382139.html);
  [MAX17048 LCSC C2682616](https://www.lcsc.com/product-detail/C2682616.html)
- Cord: [Wikipedia — Telephone jack and plug (4P4C handset)](https://en.wikipedia.org/wiki/Telephone_jack_and_plug);
  [Wikipedia — Registered jack](https://en.wikipedia.org/wiki/Registered_jack)
- PCB: [JLCPCB impedance stackups (JLC04161H-7628)](https://jlcpcb.com/impedance)

---

## Revision notes

- 2026-09-27 (single board, owner): the deck board is merged into the main board: one
  180 × 88 mm 4-layer board, no FFC/connectors/standoffs, NFC coil in a free end region, e-ink
  FPC-05F-24PH20. Two stacked boards were carried over from the old long base; one board is
  cheaper one-off (one fab/assembly setup).
- 2026-09-27 (layout): 12-key deck (1-5 MENU / 6-0 BACK), deck 117 × 84 mm, compact base ≈186 × 94 × 33 mm
  (supersedes ≈350 mm), 13 SK6812; USB-C UAC handset replaces RJ9; display variants (Kids Lite = no display, Kids Standard/Lounge = e-ink)
  and the DNP Qwiic display port are in hardware/SCHEMATIC.md; layout in hardware/LAYOUT.md.


**r0.1a (2026-09-27, schematic capture; see [SCHEMATIC.md](SCHEMATIC.md)).** These are errata
found while checking datasheets. The r0.1 text above has not been edited.

- **§9.1 BQ24074 OVP:** the BQ24074's OVP is **10.5 V**. 6.6 V is the OVP of the '72/'73/'75/'79.
  The OUT regulation of **4.4 V** on input power is confirmed (datasheet SLUS810N).
- **§6.4 / §12.1 DRV5032 variant:** the 20 Hz omnipolar push-pull part is **DRV5032FA**
  (LCSC C140921). FB (C2655033) is the 5 Hz variant.
- **§5 IRQ:** the LIS2DH12 INT pins are push-pull only; there is no open-drain option. INT1
  joins the wired-OR IRQ through an N-FET.
- **§5 FFC:** the signal list adds up to 25 for a 24-pin FFC, so it now has 1 spare
  (pinout in `schematic/ffc.py`).
- **§5 / §6.3 LED level shift:** 74AHCT1G125 needs VCC ≥ 4.5 V, above the 4.4 V VSYS.
  Replaced with **SN74LV1T125** on the main board.
- **§9.3 B-option connector:** a JST-PH-2 cannot carry the pack NTC to TS. Changed to
  **JST-PH-3**.
- **§12.1 NS4150B package:** it is **MSOP-8**, not ESOP-8.

- **Input current limit (2026-09-27):** R_ILIM = 1.1 kΩ gives 1.46 A typ / **1.35 A guaranteed**
  (not the 1.5 A written in §9.1; 1.5 A would need a resistor below the 1.1 kΩ minimum). The §9.2
  budget fits under the guaranteed value with 28 % headroom (firmware-capped) and 7 % (uncapped);
  enforced by `check_power_budget` on every build.
- **USB source requirement (owner decision 2026-09-27):** **Lounge requires a USB-C source that
  advertises ≥1.5 A** (ship it with a 5 V / 3 A USB-C adapter). Kids works on any source (peak
  491 mA on Default USB). On a Default-advertising source (incl. every USB-A charger via an
  A-to-C cable) Lounge runs in **reduced mode**: radar off via LD_PWR_EN (presence falls back to
  hook + NFC), LEDs ≤10 %, ringer ≤0.5 W, charging off → 491 mA. The phone reports
  `status.power {source, reduced}`; the strip shows "USE 1.5A CHARGER" and the companion app
  warns. See §9.2a and `firmware/README.md`.
