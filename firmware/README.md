# Firmware

ESP32-S3 firmware for the **minimal board** (`hardware/DESIGN.md`), in C on **ESP-IDF v5.4**.
It speaks [protocol v1](../docs/protocol.md) and mirrors the browser phone (`apps/device-web`):
the handset state machine (`packages/core/src/device.ts` → `main/phone.c`), the status strip
(`strip.ts` → `strip.c`), the status light (`leds.ts` → `render()` in `main.c`) and a first
part of the menu (`menu.ts` → `menu.c`).

**v0 status: pairs, signs in and does call signaling; no call audio yet.**

| Works | Stubbed / TODO |
|---|---|
| 12 keys + hook + jack detect (interrupts + debounce), piezo ring and beeps, status LED patterns (idle, pairing, offline, ringing, missed) | Call audio: I2S, the ES8311 path, prompts, WebRTC (esp-webrtc). The codec is only probed and reset over I2C |
| 2.9" e-paper (SSD1680) behind a small display interface; the protocol's strip model (≤ 2 lines × 16 chars, large type) | Partial refresh uses the controller's built-in mode (`0x22 0xFC`): check on a real panel |
| Wi-Fi from NVS (console `wifi`) or Kconfig; server from NVS (console `server`) or Kconfig (default `wss://l1.openloungephone.app`) | SoftAP provisioning ("OpenLoungePhone-XXXX" + a setup page) |
| WebSocket over TLS (the ESP-IDF certificate bundle), reconnects, keep-alive `{"t":"ping"}`, `status` every minute | OTA updates (two slots, signed, rollback) |
| `hello` → `pair.begin` (`alg: "p256"`, mbedTLS ECDSA) → `pair.code` on the strip + beeps → `pair.done` → reconnect → `auth.challenge`/`auth.proof` → `config` | Encrypted NVS / flash encryption (the device key is in plain NVS) |
| `deviceStep`: hook, keys → `button`, incoming ring, answer by lifting, hang up by the hook, rooms, busy decline | Hold / merge / transfer (MENU in a call), voicemail recording, greetings, Lounge features, extensions |
| Signaling-only calls: the phone offers/answers SDP with its audio **rejected** (port 0), so calls go `active` with no media | First-run mode choice (always `kind: "kids"`), factory reset (MENU+BACK at power-on) |
| `wipe`: erases the device key, id and settings (keeps Wi-Fi), reboots, pairs again | Volume, brightness, voicemail and call menus |
| MENU → 3 Wi-Fi status, 0 About (firmware version + the four fingerprint words) | |

## Build and flash

Install ESP-IDF v5.4 once (official installer, ESP32-S3 only):

```sh
mkdir -p ~/esp && cd ~/esp
git clone -b v5.4.2 --recursive https://github.com/espressif/esp-idf.git
cd esp-idf && ./install.sh esp32s3
```

Then, in each new shell: `. ~/esp/esp-idf/export.sh`, and:

```sh
cd firmware
idf.py build
idf.py -p <port> flash monitor      # e.g. /dev/cu.usbmodem1101; Ctrl-] quits the monitor
```

Flashing and the console use the board's USB-C (native USB, USB-Serial-JTAG). If the board
doesn't show up, hold BOOT, press RESET, release BOOT. `idf.py menuconfig` → *Open Lounge Phone*
sets the default server and Wi-Fi. CI builds both targets with the `espressif/idf` image.

**Pin map.** `main/board.h` is generated from `hardware/build/main/gpio_map.json`:
`make -C hardware build`, then `python3 firmware/tools/gen_board.py` (it also copies the
fingerprint word list from `packages/core`; `--check` fails on drift).

## Console

At the `olp>` prompt (USB serial, 115200 in the simulator):

| Command | |
|---|---|
| `wifi <ssid> [password]` | save Wi-Fi in NVS and connect |
| `server [wss://host]` | show or set the server (reconnects) |
| `status` | phone state, connection, device id, Wi-Fi, the four words, the strip |
| `key <0-9\|menu\|back>`, `hook <up\|down>` | press a key or move the hook, as the real switches do |
| `drop [wifi]` | drop the WebSocket (or Wi-Fi) to test reconnects |
| `wipe` | forget the device key, id and settings (keeps Wi-Fi), reboot |
| `screen` | print the display's framebuffer (`tools/fb2png.py` turns it into a PNG) |
| `reboot` | restart |

The log shows every protocol message (`-> …`, `<- …`), `STATE <kind>`, `STRIP [line|line]`,
`SIG led=…`/`SIG ring=…`, and the pairing code as **`PAIRING CODE: 123456`**.

## Pairing a phone

1. Power it; it joins Wi-Fi and shows `PAIR 123 456` on the strip (and prints `PAIRING CODE:`).
2. In the companion app: Home → **+ Pair a phone**, type the code, pick the mode and name.
3. The phone reconnects, signs the challenge and shows `READY` with its owner line. MENU → 0
   shows its four words; the app shows the same four for that phone.

## Wokwi simulator

`wokwi/diagram.json` is an ESP32-S3 devkit with 12 key buttons, the hook button (held = on the
hook), the status LED, the buzzer and a display. The simulator build (`sdkconfig.sim`) joins
`Wokwi-GUEST`, connects to the test server `wss://t1.openloungephone.app`, prints the console
on UART0 (so keys 6 and 7 move from IO43/IO44 to IO35/IO36) and has no PSRAM.

```sh
curl -L https://wokwi.com/ci/install.sh | sh      # or the release binary into ~/.local/bin
echo "<token>" > firmware/.wokwi-token            # gitignored; never commit it
firmware/tools/sim.sh smoke        # build + wokwi/smoke.yaml → build-sim/serial.log, *.png
firmware/tools/sim.sh interactive  # the console on your terminal (hook, keys, status…)
```

`smoke.yaml` boots, joins Wi-Fi, opens the WebSocket, waits for `pair.code` and the strip, moves
the hook, walks MENU → About → BACK, presses keys, and saves `build-sim/screenshot.png` (the
simulated display) and `build-sim/display.png` (the firmware's own framebuffer). To finish
pairing live, run `sim.sh interactive` and type the printed code into the companion on t1.

Simulator notes (all only in the sim build):
- **Display stand-in:** Wokwi has no supported 2.9" e-paper part. The community chip
  (`board-epaper-2in9`, bonnyr/wokwi-ws29v2) takes one byte per chip select, animates every
  refresh line by line (the whole simulation ran at a fraction of real time) and dropped the
  simulator's connection. The sim uses Wokwi's ILI9341 SPI TFT on the same pins
  (`main/display_ili9341.c`), drawing the same 296 × 128 strip image.
- **TLS:** Wokwi emulates the S3's software ECC about 7× slower than silicon (a P-256 verify
  takes 1.4 s of simulated time, P-384 2.4 s), so a full handshake with the certificate bundle
  outlasted Cloudflare's handshake timeout. The sim trusts the servers' intermediate (Google
  Trust Services WE1, `main/sim_ca_we1.pem`, valid until 2029-02) and uses P-256 for ECDHE.
  Hardware builds verify the full chain against the bundle.
- A simulation runs at most 5 minutes (the Wokwi plan), at roughly 0.4–0.8× real time.

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
