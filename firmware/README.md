# Firmware (later phase)

ESP32-S3 firmware (ESP-IDF / FreeRTOS). It will implement [protocol v1](../docs/protocol.md)
and mirror the handset state machine in `packages/core/src/device.ts`, using the browser
emulator (`apps/device-web`) as its reference implementation and test peer.

## Requirements already decided

### Calls

- Media is WebRTC peer to peer with the ICE servers the server sends in `rtc.config`; enable
  **Opus DTX** (`usedtx=1` in the local description, as `packages/client` `withOpusDtx` does)
  so silence costs almost nothing on a relay.
- The handset is a USB-C UAC device on the ESP32-S3's native USB (host); the power USB-C port
  carries the CH340C console/flashing bridge.

### Modes and remove = wipe (docs/device-lifecycle.md)

- The first-run choice goes in `pair.begin.kind`: `kids`, `personal` or `lounge`; whoever claims
  the phone may pick another mode, and `config.owner.mode` is the truth afterwards.
- The strip's trust line comes from `config.owner` ("KIDS: SMITH HOME", "JESSE'S PHONE",
  "LOUNGE: OFFICE"); see `ownerLine` in `apps/device-web/src/strip.ts`.
- On `wipe`: forget the device id, owner and settings, erase the device key and generate a new
  one, keep Wi-Fi, and go back to "Set me up". The server sends it to a connected phone when it's
  removed, or after a removed phone reconnects and signs the challenge with its old key.
- MENU → About shows the device fingerprint as four words: `FINGERPRINT_WORDS[b]` for the first
  four bytes of SHA-256(raw public key), list in `packages/core/src/fingerprint.ts` (copy it
  verbatim), two words per strip line.
- An idle Lounge phone may get `config.houseLine` (its keys call as the space) and
  `config.here` ("who's here"); both are off unless the space turns them on.

### USB power source policy (hardware/DESIGN.md §9.2a)

- Read the USB-C Rp advertisement on CC1/CC2 (GPIO8 / GPIO6, ADC1, per
  `hardware/schematic/pin_table.yaml`; 5.1 kΩ Rd fitted):
  `< 0.66 V` = Default (500 mA, also every USB-A→C cable), `0.66–1.23 V` = 1.5 A, `> 1.23 V` = 3 A.
  Use the higher of the two pins (only the connected one carries Rp). Re-read on attach and
  every few seconds.
- **Kids:** full features on any source.
- **Lounge on a Default source → reduced mode:** LEDs ≤ 10 %, ringer ≤ 0.5 W, charging off
  (`CHG_CE` high). (The radar in the original plan is not on the board: one board, one BOM
  since 2026-09-28.)
  Status display: `USE 1.5A CHARGER`.
- Always cap LEDs ≤ 30 % and amp level per `hardware/schematic/power_budget.yaml`.
- Report it in `status`: `power: { source: "default" | "1.5A" | "3A", reduced: boolean }`.
