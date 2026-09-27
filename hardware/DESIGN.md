# OpenTinCan Hardware Design — "Trimline" r0.1

Status: **proposal / pre-EVT**. Owner: hardware. License: CERN-OHL-S-2.0 (this document and all
derived KiCad/enclosure files).

This document picks the parts, board partitioning, envelope, pin map, power, BOM and staging for the
first custom OpenTinCan phone: a **Trimline-style corded phone** (slim base + handset on a coiled
cord), USB-C powered, running the **same PCBA** for the **Kids'** and **Lounge** variants.

Product-owner constraints incorporated (revision of 2026-09-27):

- **No main screen.** The only display is a **narrow e-ink status strip**. Primary feedback is
  **per-key RGB LEDs** plus **audio prompts/earcons** from flash.
- **Passive handset.** Earpiece + mic + magnet only. All electronics live in the base.
- **Keys are keyboard switches.** MX-compatible, hot-swap sockets, plate-mounted, standard keycaps.

Anything marked **[UNVERIFIED]** is an estimate or a datasheet detail I could not confirm online;
see §17 for the full list. Prices are 1k-qty estimates in USD unless an LCSC list price is cited.

---

## 0. Executive summary: key decisions

| # | Decision | Why (one line) |
|---|---|---|
| 1 | **Envelope: Trimline width (92 mm), stretched to ~330 mm long.** Handset cradle (224 mm) + in-line "key deck" (~104 mm). Height 36 mm body, ~50 mm with handset. | A real Trimline base is completely covered by its handset, so keys and a status strip have to sit beside it. Going longer keeps the Trimline's slim profile. |
| 2 | **Handset is fully passive.** Dynamic receiver + electret capsule + N52 magnet, on a standard **4P4C (RJ9/RJ22) coiled cord**, analog to the base. | Any $3 replacement coiled cord (and most landline handsets) works. There is nothing to break, charge or flash in the part kids throw. |
| 3 | **MCU: ESP32-S3-WROOM-1-N16R8** (pre-certified module, 16 MB flash, 8 MB octal PSRAM). | Espressif's AFE/AEC (ESP-SR) and esp-webrtc both target the S3. The C5 lacks AFE support and the P4 costs too much. |
| 4 | **Audio: ES8311 (DAC/earpiece driver) + ES7210 (4-ch ADC) + NS4150B (3 W class-D)**, the same chipset as ESP32-S3-Korvo-2 / S3-BOX-3. ES7210 ch3 records the **analog AEC reference**. | This is Espressif's known-good AEC topology, so the dev kit matches the product. INMP441/MAX98357A can't serve a passive handset and give no hardware reference. |
| 5 | **Keys: 10 × MX-compatible switches** in **Kailh CPG151101S11 hot-swap sockets**, on a **1.6 mm FR4 plate**, DSA/relegendable 1u keycaps: 8 contact keys (2 rows × 4) + SPEAKER + END. | This follows the owner's direction. Relegendable caps let kids' phones carry photos, and hot-swap means a parent can fix a key in 30 s. |
| 6 | **Per-key LEDs: 11 × SK6812MINI-E** (10 keys + 1 status), reverse-mounted, on one RMT GPIO. A **hardwired red privacy LED** lights whenever mic bias is present. | With no screen, the keys are the status surface. The privacy LED can't be overridden by firmware. |
| 7 | **E-ink strip: Good Display GDEY029T94** (2.9", 296 × 128, SSD1680, active 66.9 × 29.1 mm), placed **between the two key rows** so every contact key has its label directly above or below it. I compared 7/14-segment LED arrays (HT16K33), dot-matrix, a single 0.91" SSD1306 OLED and per-key OLEDs (§7.2). | 4 key columns at 19.05 mm = 76.2 mm, which matches the 79 mm panel. It's the only option with per-key labels, zero light emission at night and no burn-in. It renders a QR at 22 mm, which is only enough at ~20–25 cm (§7.1). Cost-down "Lite" = 14-seg HT16K33 array (−$2.66). |
| 8 | **Lounge takeover = printed QR / NFC tap + proof of presence** (mmWave occupied **and** press-the-glowing-key challenge). The strip QR (rotating token) is a secondary path. | A photographed sticker is useless without someone physically at the phone. |
| 9 | **Hook: TI DRV5032 omnipolar Hall switch** (µA-class) + **12 × 4 mm N52 disc** in the handset. Footprint for an IR reflective sensor (DNP) covers third-party handsets. | Works with the magnet in either orientation, uses almost no power, has no mechanics to wear out. |
| 10 | **Power: USB-C sink (5.1 kΩ Rd, no PD) → BQ24074 power-path** (always fitted: OVP, input current limit, optional battery) **→ 3.3 V buck + 3.0 V low-noise analog LDO.** No battery by default. The **LiPo 1S 1200 mAh "B-option"** is footprint-ready. A **0.47 F supercap hold-up** on Lounge enables power-pull wipe. | Mains-powered desk device; a USB power bank *is* the UPS. The Wi-Fi router dies in an outage anyway. Lounge needs a few seconds after unplug to wipe the screen and log the user out. |
| 11 | **Radar: HLK-LD2410C** (Lounge only; DNP on Kids) behind a 0.9 mm radome window, **its BLE disabled** at boot. **NFC: ST25DV04K dynamic tag** (both SKUs) with a PCB coil around the strip. | Presence for the dead-man logout. NFC tap covers setup, pairing and lounge takeover. |
| 12 | **Security:** Secure Boot v2 + flash encryption (release) + HMAC-protected NVS encryption. The **Ed25519 seed is derived at boot by the eFuse-keyed HMAC peripheral and never stored in flash.** Protocol should add **alg negotiation (ed25519 \| p256)** now. | The S3's DS peripheral is RSA-only and ATECC608B is P-256-only. P-256 opens the door to ESP32-C5/P4 on-chip ECDSA keys later. |
| 13 | **PCBs: 3 boards.** Main (4-layer, 144 × 80 mm) under the cradle; Deck (4-layer, 98 × 84 mm) under the keys; FR4 key plate. Connected by one 24-pin 0.5 mm FFC. The handset optionally gets a *passive* 20 × 14 mm jack carrier. One family panel at JLCPCB. | One stencil and one SMT run. Keeps the antenna and analog audio on the main board, away from key-switch ESD. |
| 14 | **Cost:** core PCBA (main + deck, assembled) **≈ $15.4** (meets the <$20 goal). All electronics incl. strip, switches, caps, speaker, handset parts: **Kids ≈ $28, Lounge ≈ $29**. Landed COGS with enclosure ≈ **$36–38**. | The <$20 target holds for the PCBA only. The whole phone doesn't make it (§12). |

**Top risks:** (1) speakerphone AEC and **RF buzz from Wi-Fi bursts into the 2 m analog handset
cord**; (2) the **330 mm envelope** (46% longer than a real Trimline) plus MX key stack height
needs owner/ID acceptance; (3) **cost and compliance**: electronics ~$28 vs $20, plus
FCC 15B/CE RED incl. **EN 18031-2 (kids/toys cybersecurity)** and possible toy-safety scope.

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

**Base:** 330 L × 92 D × 36 H mm body; handset top at ~50 mm when docked.
Wall-mount: two keyhole slots on the bottom (83 mm US wall-plate spacing is **not** needed — this
is not a line-powered phone — so use 100 mm spacing), firmware rotates strip content 180° if hung
key-deck-down.

### 1.3 Mechanical sketches (mm)

Coordinate system: x = left→right along base length (user faces the front long side),
y = front→rear, z = up from base floor.

**Top view (handset removed)**

```
 x=0                                                              224  228                     330
 ┌───────────────────────────────────────────────────────────────────┬──────────────────────────┐ y=92
 │ rear wall  [USB-C]x70 [RJ9]x90            [ESP32-S3 ant]x150-168   │  KEY DECK (skin z=28)    │
 │ ┌──────────┐ ┌──────────────────────────────────────────────────┐  │ ┌────┬────┬────┬────┬────┐│
 │ │ SPEAKER  │ │ MAIN BOARD 144 x 80  (under trough, z=6)          │  │ │ R1 │ R2 │ R3 │ R4 │SPKR││ rear row
 │ │ Ø40 4Ω   │ │                                                    │  │ ├────┴────┴────┴────┼────┤│
 │ │ sealed   │ │   codecs   BQ24074   [DRV5032]x113   ES8311/7210   │  │ │ E-INK STRIP 2.9"   │ALS ││
 │ │ 14cc box │ │                                                    │  │ │ 79 x 36.7 (window  │stat││
 │ │ fires ↓  │ │                    [LD2410C]x170-192 [MIC]x200     │  │ │  67 x 29.1)  [NFC] │priv││
 │ └──────────┘ └──────────────────────────────────────────────────┘  │ ├────┬────┬────┬────┼────┤│
 │  x=6..56        x=62 ............................... x=206          │ │ F1 │ F2 │ F3 │ F4 │END ││ front row
 │       ════════ HANDSET TROUGH 222 x 56, floor z=22 ════════         │ └────┴────┴────┴────┴────┘│
 └───────────────────────────────────────────────────────────────────┴──────────────────────────┘ y=0
   front wall: radar window (0.9 mm) at x=170-192, mic port x=200        right end face: VOL-/VOL+/MUTE
```

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

### 2.1 Decision

| Lives in the HANDSET (passive) | Lives in the BASE |
|---|---|
| Dynamic receiver 32 Ω | ESP32-S3 module, all power, codecs, amp |
| Electret mic capsule with internal RF caps + 33 pF | Base speaker (ringer/speakerphone), base mic |
| 12 × 4 mm N52 magnet (hook) | Hall sensor, radar, NFC, ALS, accelerometer |
| 4P4C jack (panel or passive carrier) | Keys, LEDs, e-ink strip |

### 2.2 Cord interface

Standard **4P4C (RJ9/RJ10/RJ22) coiled handset cord**, fully analog, two balanced pairs:

| Pin | Common handset convention [UNVERIFIED, not universal] | OpenTinCan signal |
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
- **Speakerphone (SPEAKER key / Lounge hands-free):** EAR_EN=0 (so the docked receiver doesn't
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

Constraints: **GPIO35–37 are used by octal PSRAM**; GPIO26–32 are flash/PSRAM internal; **strapping
pins 0, 3, 45, 46** (GPIO45 must be low at reset for 3.3 V flash; GPIO46 + GPIO0 combination
rules); GPIO19/20 = native USB; ADC2 unusable with Wi-Fi, so all analog inputs go on **ADC1
(GPIO1–10)**. Deep-sleep wake sources must be RTC GPIOs (0–21).

| GPIO | Signal | Dir | Board | Notes |
|---|---|---|---|---|
| 0 | BOOT / service button | in | main | Strap. 10 k pull-up, pinhole button. Long-press at runtime = factory reset. |
| 1 | CC1_SENSE | ADC1_CH0 | main | Reads USB-C Rp advertisement: default / 1.5 A / 3 A |
| 2 | CC2_SENSE | ADC1_CH1 | main | 〃 |
| 3 | EAR_EN | out | main | Strap only if EFUSE_STRAP_JTAG_SEL burned (we don't). 100 k pull-down, so the earpiece is off at boot. |
| 4 | HANDSET_DET | ADC1_CH3 | main | MIC+ bias via 100 k/100 k: missing / present / short |
| 5 | HOOK | in, RTC wake | main | DRV5032 push-pull output |
| 6 | LD_OUT | in, RTC wake | main | LD2410C presence pin |
| 7 | IRQ (shared) | in, RTC wake | both | Wired-OR open-drain: AW9523B INTN, ST25DV GPO, LIS2DH12 INT1 (open-drain mode **[UNVERIFIED]**). 10 k pull-up. |
| 8 | I2C_SDA | io | both | 4.7 k pull-ups; 400 kHz |
| 9 | I2C_SCL | out | both | |
| 10 | EPD_CS | out | deck | FSPI IO_MUX group (CS0) |
| 11 | EPD_MOSI | out | deck | FSPID |
| 12 | EPD_SCK | out | deck | FSPICLK, ≤10 MHz over FFC |
| 13 | EPD_DC | out | deck | |
| 14 | EPD_RST | out | deck | |
| 15 | EPD_BUSY | in | deck | |
| 16 | I2S_MCLK | out | main | 256·fs to ES8311/ES7210 |
| 17 | I2S_BCLK | out | main | |
| 18 | I2S_WS | out | main | |
| 19 | USB_D− | io | main | Native USB Serial/JTAG: flashing, console, DFU |
| 20 | USB_D+ | io | main | |
| 21 | I2S_DOUT → ES8311 | out | main | |
| 35–37 | — | — | — | **Reserved (octal PSRAM)** |
| 38 | I2S_DIN ← ES7210 (TDM) | in | main | |
| 39 | LD_RX (UART1) | in | main | JTAG pins are free because JTAG is over USB |
| 40 | LD_TX (UART1) | out | main | 256000 baud |
| 41 | PA_EN (NS4150B CTRL) | out | main | 100 k pull-down, so no pop at boot |
| 42 | LED_DATA (RMT) | out | →deck | Through 74AHCT1G125 (VSYS-powered) to the SK6812 chain |
| 43 | U0TXD | out | TP | Console/factory test pad |
| 44 | U0RXD | in | TP | |
| 45 | CHG_CE (BQ24074 /CE) | out | main | Strap: 10 k pull-down keeps flash at 3.3 V and charging enabled by default |
| 46 | LD_PWR_EN | out | main | Strap: pull-down, so the radar is off at boot |
| 47 | CHG_STAT (/CHG) | in | main | |
| 48 | PGOOD (/PGOOD) | in, IRQ | main | Power-fail interrupt → lounge wipe (§9.5) |

All usable GPIOs are allocated. Expansion is on the **AW9523B** (deck, I2C 0x58, LCSC C148077,
$0.17):

| AW9523B pin | Signal |
|---|---|
| P0_0–P0_7 | KEY F1–F4, R1–R4 (active-low to GND; **external 10 k pull-ups** — AW9523B has no configurable pull-ups **[UNVERIFIED]**) |
| P1_0–P1_1 | KEY SPEAKER, KEY END |
| P1_2–P1_3 | VOL−, VOL+ (side tact) |
| P1_4 | MUTE_SENSE (2nd pole of slide switch) |
| P1_5 | LED_PWR_EN (P-FET cuts SK6812 quiescent ~1 mA each) |
| P1_6–P1_7 | spare |

**I2C map (no conflicts):** ES8311 0x18, **LIS2DH12 0x19** (SA0=1, avoids ES8311),
LTR-303ALS 0x29, MAX17048 0x36 (B-option), ES7210 0x40, ST25DV04K 0x53/0x57 (+0x2D system),
AW9523B 0x58, ATECC608B 0x60 (DNP).

**Main↔Deck FFC (24-pin, 0.5 mm, ~60 mm):** 3V3 ×2, VSYS ×2, GND ×6 (interleaved), EPD ×6,
I2C ×2, IRQ, LED_DATA(buffered), MICBIAS_IN / MICBIAS_OUT (mute switch loop), PRIV_LED_K,
spare ×2. Analog audio never crosses the FFC. The mute loop carries only filtered DC bias.

---

## 6. Input: keys, hook, side controls

### 6.1 Key count and layout

**10 MX-compatible keys at 19.05 mm pitch:** rear row R1–R4 + SPEAKER, front row F1–F4 + END.
The e-ink strip sits **between** the rows, so each of the 8 contact keys has its label band
directly beside it (strip 296 px / 4 columns = 74 px ≈ 16.7 mm per column vs 19.05 mm key pitch.
Labels are drawn centred on the key positions and clipped at the panel edge.)

- Kids: 8 contacts, SPEAKER (hands-free answer/call), END (hang up speakerphone; long-press =
  play voicemail). **Relegendable clear keycaps** take printed photos/names, which works for
  pre-readers.
- Lounge: 8 "contact slots" filled per session with the user's trusted contacts (names on strip,
  presence on LEDs). SPEAKER, and a red **END SESSION** cap.

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
| SK6812 ×11 (quiescent ~1 mA each + light) | VSYS | 27 | 40 | 30 | 30 | 120 (capped) | 400 (uncapped) |
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

### 9.3 Battery decision

**Default: no battery (both SKUs).** Rationale: a desk device on USB. In a power cut the home
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
"Ending session — press any key to stay") → logout. END SESSION key. Companion app "leave".
Power pull (§9.5). Server-side heartbeat timeout.

### 10.3 Dead-man switch reality check

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
  1. **SoftAP + Wi-Fi QR on the strip** (`WIFI:T:WPA;S:OpenTinCan-7F3A;P:<random>;;`): every modern
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
  ("Your pairing code is 4-2-9, 1-1-7", repeated). SPEAKER announces it on the speaker. The
  captive-portal success page links to the companion with the device ID prefilled.

---

## 11. PCB design

### 11.1 Boards

| Board | Size (mm) | Layers | Key contents |
|---|---|---|---|
| **Main** | 144 × 80, 4 × M2.5 bosses | 4 | ESP32-S3 module (rear edge, antenna overhang), ES8311, ES7210, NS4150B, BQ24074, buck + LDO, USB-C + RJ9 (rear-left), DRV5032 (x≈113, under handset magnet), LD2410C header (front edge), base-mic pads, LIS2DH12, supercap/B-option pads, FFC |
| **Deck** | 98 × 84, 4 bosses + plate standoffs | 4 | 10 hot-swap sockets (bottom), 11 SK6812MINI-E (bottom, reverse-mount), AW9523B, LTR-303, ST25DV04K + coil, e-ink 24-pin FPC + SSD1680 boost (inductor, MOSFET, 3 Schottky, caps), side switches (right edge), privacy/status LEDs, FFC |
| **Key plate** | 98 × 84 × 1.6 FR4, 14.0 mm cutouts, strip window | 0 (bare FR4) | Panelized with the others |
| Handset carrier (optional) | 20 × 14 | 2 | 4P4C + 3 caps (passive) |

### 11.2 Stackup (main and deck)

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
- **Test points (bottom side, 1.0 mm pads, 2.54 mm grid for pogo fixture):** VBUS, VSYS, 3V3,
  3V0, GND ×4, USB D+/D−, U0TX/U0RX, EN, GPIO0, I2S BCLK/WS/DIN/DOUT, I2C, HOOK, PA_EN, speaker ±,
  EAR ±, MIC ±. Factory audio test = loopback plug in the RJ9 (EAR→MIC through an attenuator).
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
| PCB 4L 98 × 84 ENIG | | 1 | 0.80 | 0.80 | EST |
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
| MX-compatible tactile switches ×10 | 2.50 | 2.50 | EST $0.25 each |
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
10. END key: `call.hangup` when in a call. In Lounge idle/bound it's `session.end`.
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

1. **Envelope:** is a ~330 × 92 × 36 mm base (≈46% longer than a real Trimline) acceptable, or do we
   go Compact-6 (2.13" strip, 6 contacts + 2 fn keys, ~310 mm)? Desk-only, or must wall-mount ship
   day one?
2. **Key count:** 8 contact keys + SPEAKER + END enough? Kids with >8 contacts: pages on the strip,
   or hard cap?
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
