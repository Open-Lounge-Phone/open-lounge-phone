# Firmware (later phase)

ESP32-S3 firmware (ESP-IDF / FreeRTOS). It will implement [protocol v1](../docs/protocol.md)
and mirror the handset state machine in `packages/core/src/device.ts`, using the browser
emulator (`apps/device-web`) as its reference implementation and test peer.

## Requirements already decided

### Calls

- Media is WebRTC peer to peer with the ICE servers the server sends in `rtc.config`; enable
  **Opus DTX** (`usedtx=1` in the local description, as `packages/client` `withOpusDtx` does)
  so silence costs almost nothing on a relay.
- The board is the **minimal board** (`hardware/DESIGN.md`, GPIO map in
  `hardware/schematic/pin_table.yaml`). The handset is analog, on a 3.5 mm TRRS jack (CTIA):
  the ES8311 (I2C 0x18: SDA IO18, SCL IO17; I2S MCLK IO16, BCLK IO6, WS IO5, DOUT IO15, DIN IO7)
  records its mic on MIC1 and drives its earpiece from OUTP. Nothing is switched in hardware:
  firmware reads HOOK (IO2, an MX switch, low = on hook, internal pull-up) and JACK_DET (IO4,
  high = plug in, internal pull-up), mutes the earpiece on hook and only captures audio in a
  call. No inline-button detect (a press may show as a transient on the mic ADC). No speaker:
  the piezo ringer is IO8 (PWM, ~4 kHz resonance) and voice prompts play in the earpiece.
  If EVT shows receiver-to-mic echo, run AEC with the playback stream as the reference.
- Keys: 12 GPIOs with internal pull-ups, active low, debounce 5-10 ms (`pin_table.yaml`:
  KEY_1 … KEY_0, KEY_MENU, KEY_BACK). The status LED is IO1 (the recording light too). The
  display module is on SPI: DIN IO14, CLK IO13, CS IO47, DC IO21, RST IO38, BUSY IO48. Key 6 is
  on IO43 (TXD0): ignore it until the ROM boot log is over.
- Flashing and the console use the ESP32-S3's native USB (USB-Serial-JTAG) on the USB-C port.

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

### USB power

- The minimal board has no CC sensing and draws under 500 mA: it runs fully on any USB source.
  Report `status.power` as `{ source: "default", reduced: false }` (or omit it).
