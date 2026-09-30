# Firmware

ESP32-S3 firmware for the **minimal board** (`hardware/DESIGN.md`), in C on **ESP-IDF v5.5**.
It speaks [protocol v1](../docs/protocol.md) and mirrors the browser phone (`apps/device-web`):
the handset state machine (`packages/core/src/device.ts` → `main/phone.c`), the status strip
(`strip.ts` → `strip.c`), the status light (`leds.ts` → `render()` in `main.c`) and a first
part of the menu (`menu.ts` → `menu.c`).

**Status: pairs, signs in, and makes and takes calls with two-way audio (WebRTC, G.711).** Call
audio is verified end to end in the QEMU simulator with a test tone; the codec path (ES8311) needs a
real board ([`hardware/BRINGUP.md`](../hardware/BRINGUP.md)).

| Works | Stubbed / TODO |
|---|---|
| 12 keys + hook + jack detect (interrupts + debounce), piezo ring and beeps, status LED patterns (idle, pairing, offline, ringing, missed) | Voice prompts (the pairing code read out), AEC if the handset echoes; TURN over TCP/TLS (broken in `esp_peer` 1.5.6) |
| 2.9" e-paper (SSD1680) behind a small display interface; the protocol's strip model (≤ 2 lines × 16 chars, large type) | Partial refresh uses the controller's built-in mode (`0x22 0xFC`): check on a real panel |
| Wi-Fi from NVS (console `wifi`) or Kconfig; server from NVS (console `server`) or Kconfig (default `wss://l1.openloungephone.app`) | SoftAP provisioning ("OpenLoungePhone-XXXX" + a setup page) |
| WebSocket over TLS (the ESP-IDF certificate bundle), reconnects, keep-alive `{"t":"ping"}`, `status` every minute | OTA updates (two slots, signed, rollback) |
| `hello` → `pair.begin` (`alg: "p256"`, mbedTLS ECDSA) → `pair.code` on the strip + beeps → `pair.done` → reconnect → `auth.challenge`/`auth.proof` → `config` | Encrypted NVS / flash encryption (the device key is in plain NVS) |
| `deviceStep`: hook, keys → `button`, incoming ring, answer by lifting, hang up by the hook, rooms, busy decline | Hold / merge / transfer (MENU in a call), voicemail recording, greetings, Lounge features, extensions |
| **Call audio** (see below): WebRTC with Espressif's `esp_peer` (ICE with the server's STUN and TURN over UDP, DTLS-SRTP), G.711 µ-law at 8 kHz, the ES8311 over I2S, a capped earpiece volume, call-progress tones in the earpiece | First-run mode choice (always `kind: "kids"`), factory reset (MENU+BACK at power-on) |
| `wipe`: erases the device key, id and settings (keeps Wi-Fi), reboots, pairs again | Brightness, voicemail and call menus; rooms (group calls) have no media on the phone yet |
| MENU → 1 Volume, 3 Wi-Fi status, 0 About (firmware version + the four fingerprint words) | |

## Build and flash

Install ESP-IDF v5.5 once (official installer, ESP32-S3 only). v5.5 is required: `esp_peer`'s
prebuilt libraries call `esp_log()`, which v5.4 doesn't have (the build stops with a clear message
on older versions).

```sh
mkdir -p ~/esp && cd ~/esp
git clone -b v5.5.5 --recursive https://github.com/espressif/esp-idf.git esp-idf-v5.5.5
cd esp-idf-v5.5.5 && ./install.sh esp32s3
```

Then, in each new shell: `. ~/esp/esp-idf-v5.5.5/export.sh`, and:

```sh
cd firmware
idf.py build
idf.py -p <port> flash monitor      # e.g. /dev/cu.usbmodem1101; Ctrl-] quits the monitor
```

Flashing and the console use the board's USB-C (native USB, USB-Serial-JTAG). If the board
doesn't show up, hold BOOT, press RESET, release BOOT. `idf.py menuconfig` → *Open Lounge Phone*
sets the default server and Wi-Fi, and *Call audio* the earpiece cap, mic gain and ICE options. CI
builds the board, Wokwi and QEMU targets with the `espressif/idf:v5.5.5` image and runs the host
unit tests (`make -C firmware/test/host`: G.711, tones, meters, ICE server choice).

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
| `audio` | audio device, call counters (`tx`/`rx` frames, underruns) and levels (`miclevel`, `rxlevel`, the watched tone) |
| `audio tone <dialtone\|ringback\|busy\|hold\|test\|none>` | play a tone in the earpiece, even on the hook (bring-up) |
| `audio loop <ms>\|off` | mic → earpiece after a delay: an echo test for bring-up (the mic is on only while it runs) |
| `audio watch <hz>` | which frequency the received-audio meter watches (default 440 Hz) |
| `volume [0-10]` | earpiece volume (10 = the cap, 3 dB steps; also MENU → 1) |
| `rtc [log on\|off]` | the call's media state: ICE servers in use, connected, setup time |
| `ice <all\|udp\|tcp\|tls>` | which ICE servers the next call uses (`tcp`/`tls` = TURN over TCP/TLS only: experimental, see Call audio) |
| `screen` | print the display's framebuffer (`tools/fb2png.py` turns it into a PNG) |
| `reboot` | restart |

The log shows every protocol message (`-> …`, `<- …`), `STATE <kind>`, `STRIP [line|line]`,
`SIG led=…`/`SIG ring=…`, `TONE …`, `RTC state …`/`RTC CONNECTED …`, `AUDIO tx=… rx=…` every 5 s in
a call, and the pairing code as **`PAIRING CODE: 123456`**.

## Call audio

One WebRTC peer connection per call, with Espressif's **`esp_peer`** (esp-webrtc-solution, from the
ESP component registry, `espressif/esp_peer ~1.5.6`): ICE, DTLS-SRTP and RTP. `main/media.c` runs it
on its own task; `main/audio.c` moves 20 ms frames between it and the audio device.

- **Signaling** follows the protocol: `rtc.config` (the call's ICE servers) starts the peer
  connection at once, so STUN/TURN gathering overlaps the signaling; the party that placed the call
  sends the offer (the phone sends it once the call is `connecting`), the other answers. `esp_peer`
  puts the phone's own candidates in its SDP (no trickle from the phone); the other side's trickled
  `rtc.ice` candidates are fed in (queued until its SDP is set). If the media fails to connect or
  drops, the phone hangs up (`call.hangup`, busy tone) rather than sit in silence.
- **ICE:** STUN plus TURN over UDP from `rtc.config` (`main/ice.c`, host-tested picks one of each:
  Cloudflare's `stun:…:3478` and `turn:…:3478?transport=udp`). **TURN over TCP/TLS doesn't work in
  `esp_peer` 1.5.6** (found in simulation, TESTLOG q4-d4): over TLS (`turns:…:443`) the agent gives
  up ~10 ms after starting its non-blocking connect, before any handshake, even with certificate
  checks off (and its API has no way to pass a CA, so it could not verify the TURN server anyway);
  over plain TCP it allocates, binds a channel and pairs, then every DTLS read fails
  (`agent_recv error: -1`); and with its `tcp_support` on, a TCP/TLS server in the list stalls
  gathering for ordinary calls. So the phone uses UDP only: **a network that blocks outgoing UDP
  (some guest and corporate Wi-Fi) can't carry the phone's calls yet.** `CONFIG_OLP_ICE_TCP_RELAY`
  and `ice tcp` / `ice tls` try it again with a newer `esp_peer` (e2e steps 8 and 9, opt-in). TURN
  credentials are never logged (`rtc.config` is logged without them, and `esp_peer`'s agent, which
  prints them at INFO, stays at WARN unless `rtc log on`).
- **Codec: G.711 µ-law (PCMU) at 8 kHz**, not Opus. Every browser supports PCMU; it costs no CPU and
  no extra library (`main/dsp.c`, host-tested), behaves the same in the simulator and on the board,
  and the handset is a telephone earpiece and electret, narrowband anyway. The price is bandwidth:
  64 kbit/s each way (≈ 80 with headers) and no DTX, so a relayed call costs ~70 MB per hour on TURN.
  Opus (via `esp_audio_codec`) is feasible on the S3 with PSRAM and is the upgrade path behind the
  same audio interface; it was not chosen first because Opus encoding is the one heavy CPU load
  that the simulator can't show honestly.
- **Audio device** (`main/audio_dev.h`): the **ES8311** on I2S0 (8 kHz, 16-bit mono, MCLK
  2.048 MHz from the S3; registers set over I2C, `main/audio_es8311.c`), or a **test device**
  (`main/audio_test.c`: the "mic" is a 1 kHz tone at -15 dBFS, the "earpiece" measures level and a
  watched frequency). The simulators always use the test device; a board without a codec falls back
  to it. `audio` prints the counters and levels of the current call.
- **Earpiece:** plays only with the handset lifted (the DAC is muted on the hook); call-progress
  tones (`soundFor` in `packages/core`: dial 350+440 Hz, ringback 440+480 Hz 2 s/4 s, busy 480+620
  Hz 0.5 s/0.5 s, hold beep) are mixed in locally. **Volume** 0-10 (MENU → 1, `volume`), 3 dB steps
  below a **cap of -6 dBFS** (`CONFIG_OLP_EARPIECE_MAX_DB`; hardware owner question 8: full scale
  may reach ~98 dB SPL until the receiver is measured).
- **Mic:** captured only while a call's media is connected (or during the `audio loop` bring-up
  test); otherwise the ADC is muted and I2S RX is off.
- A small jitter buffer (starts at 60 ms, capped at 300 ms) sits behind `esp_peer`'s own (NACK,
  reordering).

**Verified in simulation** (QEMU, `tests/e2e/live/firmware.test.ts` against a live server, see
TESTLOG.md): ICE through Cloudflare TURN over UDP (relay to relay) and directly, DTLS-SRTP, RTP both ways with
test tones (the companion finds the phone's 1 kHz with WebAudio; the phone measures the companion's
440 Hz), both call directions, hang-up turns the mic off. **Needs the real board:** the ES8311
register setup and I2S timing, levels, the volume cap in dB SPL, echo from the handset, and call
quality over real Wi-Fi: [`hardware/BRINGUP.md`](../hardware/BRINGUP.md).

## Pairing a phone

1. Power it; it joins Wi-Fi and shows `PAIR 123 456` on the strip (and prints `PAIRING CODE:`).
2. In the companion app: Home → **+ Pair a phone**, type the code, pick the mode and name.
3. The phone reconnects, signs the challenge and shows `READY` with its owner line. MENU → 0
   shows its four words; the app shows the same four for that phone.

## QEMU simulator

Espressif's QEMU runs the same firmware on an emulated ESP32-S3 (with octal PSRAM like the board),
with no time limit. QEMU has no Wi-Fi: the QEMU build (`sdkconfig.qemu`) uses QEMU's OpenCores
Ethernet with user-mode NAT instead; everything above the link (DHCP, DNS, TLS with the full
certificate bundle, UDP for WebRTC) is the board's code. There is no display (`screen` still dumps
the framebuffer) and no keys (use the console's `key` and `hook`).

```sh
# Espressif's x86_64 macOS build esp-develop-9.2.2-20250817 (the newer "x86_64" archive holds an
# arm64 binary); Linux: python $IDF_PATH/tools/idf_tools.py install qemu-xtensa
brew install libgcrypt
firmware/tools/qemu.sh run        # build, fresh flash + eFuse files, console on this terminal
firmware/tools/qemu.sh resume     # run again on the same flash (NVS, OTA state kept)
python3 firmware/tools/qemu_smoke.py   # the CI boot smoke test
```

The e2e test uses QEMU by default (`OLP_SIM=qemu`; `OLP_SIM=wokwi` for Wokwi).

## Wokwi simulator

`wokwi/diagram.json` is an ESP32-S3 devkit with 12 key buttons, the hook button (held = on the
hook), the status LED, the buzzer and a display. The simulator build (`sdkconfig.sim`) joins
`Wokwi-GUEST`, connects to the owner's server `wss://l1.openloungephone.app`, prints the console
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
pairing live, run `sim.sh interactive` and type the printed code into the companion on l1
(Home → + Pair a phone). Another server: `server wss://host` at the `olp>` prompt.

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

- Media is WebRTC peer to peer with the ICE servers the server sends in `rtc.config`. The browser
  apps use **Opus DTX** (`usedtx=1`, `packages/client` `withOpusDtx`) so silence costs almost
  nothing on a relay; the phone uses G.711 (no DTX) for now: see "Call audio" for why.
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
