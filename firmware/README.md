# Firmware

ESP32-S3 firmware for the **minimal board** (`hardware/DESIGN.md`), in C on **ESP-IDF v5.5**.
It speaks [protocol v1](../docs/protocol.md) and mirrors the browser phone (`apps/device-web`):
the handset state machine (`packages/core/src/device.ts` → `main/phone.c`), the status strip
(`strip.ts` → `strip.c`), the status light (`leds.ts` → `render()` in `main.c`) and a first
part of the menu (`menu.ts` → `menu.c`). With a server it can't talk to (protocol versions,
`compat.c`) it shows `UPDATE NEEDED` or `SERVER TOO OLD` and retries hourly; unknown fields and
messages from a newer server are ignored.

**Status: sets up its Wi-Fi, pairs, signs in, and makes and takes calls with two-way audio (WebRTC, Opus wideband or G.711).** Call
audio is verified end to end in the QEMU simulator with a test tone; the codec path (ES8311) needs a
real board ([`hardware/BRINGUP.md`](../hardware/BRINGUP.md)).

| Works | Stubbed / TODO |
|---|---|
| 12 keys + hook + jack detect (interrupts + debounce), piezo ring and beeps, status LED patterns (idle, pairing, offline, ringing, missed) | Voice prompts (the pairing code read out), AEC if the handset echoes; TURN over TCP/TLS (broken in `esp_peer` 1.5.6) |
| WeAct 2.13" e-paper (SSD1680, 250 × 122; the 2.9" with `CONFIG_OLP_EPD_213=n`) behind a small display interface; the protocol's strip model (≤ 2 lines × 16 chars, large type) | Partial refresh uses the controller's built-in mode (`0x22 0xFC`): check on a real panel |
| **Setup network** (see below): "OpenLoungePhone-XXXX" + a captive setup page (Wi-Fi **and** server: your own, or the public hub to try it) when no Wi-Fi is saved; Wi-Fi also from the console (`wifi`) or Kconfig; server also from the console (`server`), MENU → 4, or Kconfig (**default: none**, see "Your keys, your server") | Bluetooth setup from the companion; the QR sticker |
| WebSocket over TLS (the ESP-IDF certificate bundle), reconnects, keep-alive `{"t":"ping"}`, `status` every minute; **updates** (see below; off in source builds): signed manifest + image, two slots, rollback, overnight while idle, MENU → 9 | Hardware Secure Boot V2 / flash encryption eFuses (documented, not burned) |
| `hello` → `pair.begin` (`alg: "p256"`, mbedTLS ECDSA) → `pair.code` on the strip + beeps → `pair.done` → reconnect → `auth.challenge`/`auth.proof` → `config` | Flash encryption and hardware secure boot (eFuses; planned for production phones) |
| `deviceStep`: hook, keys → `button`, incoming ring (BACK silences it here), answer by lifting, hang up by the hook, rooms, busy decline; **call waiting** (`WAITING: MOM` / `1 TAKE 2 IGNORE`; taking it ends the call you're in: one call has audio at a time); MENU in a call: 1 hold / resume, 2 blind transfer, 3 **mute** (the codec's mic off, silence sent; `MUTED`, the LED's slow double blink), 9 volume; **missed calls** (MENU 5: call back, next, clear) and **redial** (MENU 8, kept in NVS); `RECONNECTING` when the call's connection drops, `CONNECTION LOST` (`call.hangup` `lost`) if it isn't back in 15 s; **leaving a message** after no answer (beep, record 8 kHz WAV, hang up to send); **listening to voicemail** (MENU 2 → 1 on a person's own phone); **extensions** (MENU 6, and transfer to one from the call screen); **Lounge phones** (takeover code on the e-paper, `PRESS KEY 7` proof, MENU 5 chat / 8 log out, who's here, house-line keys) | Adding a second caller, merge and attended transfer (one call has audio at a time), playing recorded greetings |
| **Call audio** (see below and [docs/audio.md](../docs/audio.md)): WebRTC with Espressif's `esp_peer` (ICE with the server's STUN and TURN over UDP, DTLS-SRTP), Opus 16 kHz wideband with G.711 µ-law as the fallback, the ES8311 over I2S at 16 kHz, the mic's AGC, an adaptive jitter buffer with loss concealment, sidetone, the echo measured in every call and an echo canceller, a capped earpiece volume, call-progress tones in the earpiece | First-run mode choice (always `kind: "kids"`) |
| `wipe`: erases the whole NVS partition (the device key, id and settings; Wi-Fi put back), reboots, pairs again; factory reset: MENU+BACK held 10 s at power-on; **encrypted storage** in release builds (see below) | Rooms (group calls) have no media on the phone yet |
| The phone's screens, keys, LED, beeps and menu follow [docs/phone-ux.md](../docs/phone-ux.md): MENU → 1 Volume (earpiece, ringer loudness and style, 6 sidetone, 7 echo canceller), 2 Voicemail (count, play, clear), 3 Network: Wi-Fi and server (→ 1 change: the setup network; kids' phones ask twice, Lounge phones don't offer it), 4 the house intercom or the chime (else Network), 5 Missed calls / 8 Redial (on a Lounge phone in use: 5 chat / 8 log out), 6 Extension, 7 Phone check (the mic's live speech level with the handset up; → 1 self-test, 2 echo test), 9 Update now, 0 About (firmware version + the four fingerprint words); the clock on the ready screen; the daily check-in (`CHECK IN BY 10:00` / `PRESS 1: I'M OK`); the status LED double-flashes in a recorded call | Spoken prompts |
| **House intercom** (`intercom.c`, `lan.c`, `lan_crypto.c`; see below): phones of one space on the same network call room to room with no server, off unless turned on in the app; control lines HMAC-signed with the space's key, audio AES-128-CTR | Tried in QEMU only: two boards on real Wi-Fi, the codec's audio over it |
| **Wired network** on hw v0.901 (`eth.c`, `netsel.c`; see below): the W5500 on the display's SPI bus, DHCP, the cable used when it works and Wi-Fi off, Wi-Fi as the fallback with the cable's PHY powered down and checked every 30 s; setup without Wi-Fi on a cable; `eth` on the console | Run in QEMU with its Ethernet as the cable (`tools/qemu_cable.py`); the W5500 itself needs a v0.901 board ([BRINGUP.md](../hardware/BRINGUP.md) §8) |

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

### Building for each board

The board is a build setting (menuconfig → *Open Lounge Phone* → *Board*). It decides which
pins the firmware uses and the board id that updates must be signed for.

| Board | Build | Board id |
|---|---|---|
| **Minimal board, rev A** (hw v0.1, Wi-Fi only): the default | `idf.py build` | `minimal-revA` |
| **hw v0.901** (rev A + RJ45 with a W5500, and PoE) | `idf.py -B build-v0901 -D SDKCONFIG=build-v0901/sdkconfig -D "SDKCONFIG_DEFAULTS=sdkconfig.defaults;sdkconfig.v0901" build` | `minimal-v0901` |

A rev A build has no wired network code at all: it never drives GPIO0 (the BOOT button there)
or GPIO45, never looks for a W5500, and links nothing from `esp_eth` (CI checks the image). The
board id isn't settable by hand, so an update built for one board can't install on the other.
Flash the build for the board you have. A v0.901 build on a rev A board would find no W5500 and
run on Wi-Fi, but it drives GPIO0 high as a chip select, and rev A's BOOT button pulls GPIO0
straight to ground (v0.901 has 1 kΩ in series): don't hold BOOT on such a board.

Flashing and the console use the board's USB-C (native USB, USB-Serial-JTAG). If the board
doesn't show up, hold BOOT, press RESET, release BOOT. `idf.py menuconfig` → *Open Lounge Phone*
picks the board (above), can bake in a default server and Wi-Fi (both empty by default),
*Updates* turns updates on with your key, and *Call audio* sets the earpiece cap, mic gain and ICE
options. CI builds both boards, the Wokwi and QEMU targets with the `espressif/idf:v5.5.5` image and runs the host
unit tests (`make -C firmware/test/host`: G.711, tones, meters, ICE server choice, the audio
modules: AGC, jitter buffer, concealment, resamplers, Opus, sidetone, echo; they need libopus:
`brew install opus` or `apt-get install libopus-dev pkg-config`).

## Your keys, your server

Nothing in a phone you build depends on the project. A phone built from this repo with the
defaults connects to **no server** and checks for **no updates** until you say so.

| Key | Where it lives | Who holds it |
|---|---|---|
| **Device key** (P-256): signs the phone in | made on the phone at first boot, in its (encrypted) NVS | the phone; the server only knows the public half |
| **Server federation key** (Ed25519): signs server-to-server requests | made on your server when you deploy it | whoever runs that server |
| **Update key** (RSA-3072, optional): signs firmware updates | `firmware/keys/` on the machine that builds releases (gitignored) | you, if you turn updates on |
| **Storage key** (eFuse HMAC, release builds) | burned into the chip at first boot, unreadable | the phone |

**Server.** The setup page asks for one: **My own server** (its address, e.g.
`phone.example.com`) or **Public hub** (`hub.openloungephone.app`, free, to try it). Change it
later with MENU → 4 → 1 (re-opens setup) or the console (`server <address>`, `server hub`,
`server none`); another server means pairing again. Until one is chosen the display says
`SET UP: CHOOSE A SERVER`. To bake your own into your builds, set `CONFIG_OLP_SERVER_URL`.
Servers talk to each other either way (federation): the server you pick decides nothing about
who you can call.

**Updates.** Source builds embed **no update key and no update URL**, so they never check. To
update your own phones: `tools/release.sh keygen` (your key pair in `keys/`, gitignored; back up
the private half offline), then `tools/release.sh build --repo you/your-repo` and `publish`
(your key, your `fw-stable` channel), or turn on `CONFIG_OLP_OTA` in menuconfig with your own
manifest URL (or set it later with `ota url`). The build stops with that instruction if updates
are on and no key exists. **Official firmware releases** (`fw-v*`, built with
`sdkconfig.release` by `tools/release.sh build`) are the only builds that embed the project's
public key (`main/ota_signing_pub.pem`) and the official `fw-stable` channel: flashing an official
binary is how you opt in to the project's updates. CI checks all of this
(`tools/check_release_scheme.py`).

**Secure Boot.** If you turn on hardware Secure Boot V2, its digest is **your** update key's,
burned into your phones' eFuses; the project has no say in it.

**Pin map.** `main/board.h` is generated from `hardware/build/main/gpio_map.json`:
`make -C hardware build`, then `python3 firmware/tools/gen_board.py` (it also copies the
fingerprint word list from `packages/core`; `--check` fails on drift). The pin map is hw v0.901's;
its wired network pins sit inside `#if CONFIG_OLP_BOARD_V0901` (`BOARD_HAS_ETHERNET` is 0 on rev
A, whose pins are otherwise the same).

## House intercom

Moved in from the labs build in 0.9.4. The server's config turns it on per phone
(`config.intercom`: the room's name and the space's 32-byte key, base64url); the phone keeps both
in NVS (`olp` / `ic_room`, `ic_key`) so it works without internet, and erases them when a config
comes without it (turned off, or the phone moved to another space) or on a wipe.

- **Control**: UDP broadcast on port 47100, one line per message (`intercom.c`: `HELLO`, `RING`,
  `ANSWER`, `BUSY`, `BYE`, `TAKEN`, `CHIME`), each sealed as
  `OLP2|<unix seconds>|<random 32-bit hex>|<line>|<tag>` with tag = the first 16 bytes of
  HMAC-SHA256 over the rest, keyed with HMAC(space key, `olp-intercom-control`). Lines are refused
  when the tag is wrong, when they're more than 60 s off this phone's clock (if both know the
  time: it comes from the server's config), or when their random number was seen among the last
  32. Unsigned (labs 0.0.0, `OLP1|…`) lines are ignored.
- **Audio**: UDP 47101 straight between the two phones: `[seq][AES-128-CTR(G.711 frame)][tag]`,
  per-call keys from HMAC(space key, `olp-intercom-audio`) and the call's random id; the counter
  block holds the call id, the direction and the sequence number, so the two directions never
  share a keystream; the 8-byte tag (HMAC-SHA256) is checked before decrypting; old or repeated
  sequence numbers are dropped.
- Not protected: who is on the network can see that phones talk (and how much), and a phone
  restarted with no internet can't check messages' age until it's back (the replay list still
  works).

## Wired network (hw v0.901)

Only in builds for hw v0.901 (`sdkconfig.v0901`); a rev A build has none of it. The pure decisions
are `main/netsel.c` (host-tested); `main/eth.c` drives the chip and `main/net.c` applies the
choice. Screens and keys: [docs/phone-ux.md](../docs/phone-ux.md) "Wired network".

- **The chip.** A WIZnet W5500 with ESP-IDF's `esp_eth` driver (`esp_eth_mac_new_w5500` /
  `esp_eth_phy_new_w5500`) in **polling mode**: its INTn and RSTn have no GPIO, so
  `int_gpio_num = -1` with a 10 ms RX poll, `reset_gpio_num = -1` (its own power-on RC, then the
  driver's soft reset), the link read every 500 ms. It shares the display's SPI bus (SPI2: SCLK
  IO13, MOSI IO14) with its own chip select (IO0) and MISO (IO45, which only this build adds to
  the bus); ESP-IDF's bus lock gives each device whole transactions, so a full e-paper refresh
  and network frames take turns (`main/board_spi.c`). The W5500 runs at 16 MHz, the e-paper at
  10. It has no MAC address: the phone gives it the chip's Ethernet one
  (`esp_read_mac(ESP_MAC_ETH)`, the eFuse base + 3). A board whose W5500 doesn't answer at
  power-on logs it and runs on Wi-Fi. The driver runs all the time: powering the PHY down
  (PHYCFGR power-down mode) drops its link bit and the driver reports the link down; waking it
  (all-capable autonegotiation, with the PHY reset pulse) brings the link and then DHCP back.
  Between, the driver reads the link once every 500 ms and polls nothing else.
- **The network.** `esp_netif` with DHCP; DNS, TLS (the certificate bundle), the WebSocket,
  WebRTC and the house intercom run unchanged over it. The cable's interface ranks above Wi-Fi
  for the default route, and the phone sets the default to whichever network it chose.
- **Choosing.** At power-on the cable first, with the Wi-Fi radio off: a link within 5 s and an
  address within 15 s of the link means the cable is used, and Wi-Fi stays off. No cable (or no
  address): Wi-Fi, if one is saved; the W5500's PHY is put in power-down (PHYCFGR) and woken
  every 30 s for a 6 s look (5 minutes after a link that got no address; no looks during a
  call); a look that finds a link and an address moves the phone to the cable. The cable pulled
  out: Wi-Fi at once, the PHY kept on 6 s more for a bumped cable. No Wi-Fi saved: the PHY stays
  on and the phone waits for the cable. **Calls:** a call on Wi-Fi stays on Wi-Fi until it ends,
  even if a cable comes back (the phone moves to the cable when it hangs up). When the network
  a call is on is lost, the call ends and the phone reconnects to the server on the other
  network at once rather than waiting for the old socket to time out (a PoE-powered phone is
  always on its cable, so this matters only when a cable is pulled). The PHY and the Wi-Fi radio
  are on together only during a cable check that finds a cable, while a call finishes on Wi-Fi
  after a cable came back, and while the setup network is open on a cable.
- **Random numbers.** The S3's random number generator is truly random only while the radio or
  the SAR ADC feeds it. With the radio off (on the cable) the firmware keeps the SAR ADC entropy
  source on (`bootloader_random_enable`), and swaps it for the radio when Wi-Fi starts (the two
  can't run together). Device keys, TLS and DTLS keep true random numbers either way.
- **Setup.** A working cable is a network: the setup network doesn't open for lack of Wi-Fi,
  and a setup network that opened only for lack of a network closes when the cable comes up.
  Opened by hand (MENU 3/4 → 1, `setup`), the page says Wi-Fi is optional and can save just a
  server (`No Wi-Fi: use the cable`).
- **PoE** is power only: the firmware doesn't know or care where its 5 V comes from. A v0.901
  phone runs from PoE or a real USB-C charger; a computer's USB port is for flashing and the
  console, with the PoE cable plugged in too (the moments above when the PHY and Wi-Fi are on
  together draw more than a computer port's 500 mA; hardware/README.md "Power").

**Tested:** host tests (`test_netsel.c`: power-on, fallback, looks, unplug and replug, no Wi-Fi,
no address, calls; `test_prov_core.c`: setup with a cable; `test_menu.c`: the Network screen) and,
in QEMU, `tools/qemu_cable.py`: a QEMU build for hw v0.901 uses QEMU's Ethernet as the cable
(QEMU has no W5500), and the QEMU monitor's `set_link` pulls it out and plugs it back in: the
cable used with no setup network, `eth`, MENU 4, unplug → `CABLE UNPLUGGED`, the PHY powered down
(in QEMU the driver is stopped instead: its PHY model can't power down) and looked for every 30 s, replug found at the next look; with no Wi-Fi: the PHY kept on, the
setup page saving a server alone, setup opening with no network and closing when the cable
comes. **Needs a v0.901 board** ([BRINGUP.md](../hardware/BRINGUP.md) §8): the W5500 itself
(SPI at 16 MHz shared with the e-paper, the PHYCFGR power-down and wake-up, link LEDs), real
Wi-Fi fallback, a call on the cable, PoE-only power.

## Console

At the `olp>` prompt (USB serial, 115200 in the simulator):

| Command | |
|---|---|
| `wifi <ssid> [password]` | save Wi-Fi in NVS and connect |
| `wifi forget` | forget the saved Wi-Fi (the setup network opens after `reboot`) |
| `setup` | open the setup network now (Wi-Fi and server) |
| `ota [check\|now\|url <url>\|url default]` | updates: status, check, install now, the channel URL (only in builds with an update key) |
| `setup test [ssid [pass]]` | fetch the setup page from the phone itself and post a bad form (and, with an ssid, a real one): bring-up and Wokwi |
| `server [<address>\|hub\|none]` | show or set the server (`phone.example.com`, `wss://…`, `ws://…` for a local test server); another server means pairing again |
| `status` | phone state, connection, device id, Wi-Fi, the four words, the strip (hw v0.901: plus `NET uplink=wired\|wifi\|none ip=… cable=…`) |
| `key <0-9\|menu\|back>`, `hook <up\|down>` | press a key or move the hook, as the real switches do |
| `drop [wifi]` | drop the WebSocket (or Wi-Fi) to test reconnects |
| `eth` | the wired network (hw v0.901): controller, PHY on/off, link, speed and duplex, address, MAC, the network in use; on rev A: `no wired network on this board` |
| `wipe` | forget the device key, id and settings (keeps Wi-Fi), reboot |
| `audio` | audio device, call counters (`tx`/`rx` frames, underruns, `conceal`ed and `late` frames, the jitter buffer's target `jb`) and levels (`miclevel`, `micpeak`, the AGC's gain and the speech it hears, `rxlevel`, the watched tone), the echo (`erl`, `erle`) and the sidetone |
| `audio tone <dialtone\|ringback\|busy\|hold\|test\|none>` | play a tone in the earpiece, even on the hook (bring-up) |
| `audio loop <ms>\|off` | mic → earpiece after a delay: an echo test for bring-up (the mic is on only while it runs) |
| `audio watch <hz>` | which frequency the received-audio meter watches (default 440 Hz) |
| `audio gain <pga 0-30> [scale-up 0-42]` | the ES8311 mic gain in dB, live and not saved (tuning on a board: watch `miclevel`, or MENU 7's `MIC` row with the handset up; then set `CONFIG_OLP_MIC_PGA_DB` / `CONFIG_OLP_MIC_SCALE_DB`, see hardware/BRINGUP.md) |
| `audio agc on\|off` | the mic's automatic gain control (on by default) |
| `audio codec opus\|pcmu` | calls with Opus (default) or PCMU alone as in 0.9.5, for comparing on a board; not saved |
| `audio sidetone off\|low\|normal` | your own voice in the earpiece in a call (saved; also MENU → 1 → 6) |
| `audio echo on\|off\|test` | the echo canceller from the next call (saved; also MENU → 1 → 7), or the echo test (as MENU 7 → 2) |
| `audio source <hz>` | the test device's mic tone (0 = silent; simulators and e2e) |
| `volume [0-10]` | earpiece volume (10 = the cap, 3 dB steps; also MENU → 1) |
| `rtc [log on\|off]` | the call's media state: ICE servers in use, connected, setup time |
| `ice <all\|udp\|tcp\|tls>` | which ICE servers the next call uses (`tcp`/`tls` = TURN over TCP/TLS only: experimental, see Call audio) |
| `screen` | print the display's framebuffer (`tools/fb2png.py` turns it into a PNG) |
| `reboot` | restart |

The log shows every protocol message (`-> …`, `<- …`), `STATE <kind>`, `STRIP [line|line]`,
`SIG led=…`/`SIG ring=…`, `TONE …`, `RTC state …`/`RTC CONNECTED …`, `CODEC send=… recv=…`,
`AUDIO tx=… rx=…` every 5 s in a call (with the codecs, CPU per frame and the echo), `ECHOTEST …`, and the pairing code as **`PAIRING CODE: 123456`**.

## Updates (OTA)

**Releases and tags.** Hardware releases are `hw-vX.Y` (fab files; `hw-v0.1` = the minimal
board, rev A); firmware releases are `fw-vX.Y.Z` (the signed image and its manifest), created with
`--latest=false`. Phones **never use `/releases/latest`** (that is whatever release is newest, a
hardware one included): they read one fixed channel, the `fw-stable` release, one manifest per
board (`CONFIG_OLP_OTA_MANIFEST_URL`): `firmware-manifest.json` for rev A,
`firmware-manifest-minimal-v0901.json` for hw v0.901. `tools/release.sh build` signs an image and
a manifest for every board (`--board reva|v0901` for one) and `publish --release` replaces
them. CI checks this scheme (`tools/check_release_scheme.py`). Updates are **off**
in source builds (no key, no URL: "Your keys, your server"); official releases use the project's
channel, your own releases yours (`--repo`).

**The manifest** (`firmware-manifest.json`):
`{"board","version","url","size","sha256","signature"}`, the signature being RSA-PSS/SHA-256 by the
release key over `olp-ota-v1\n<board>\n<version>\n<url>\n<sha256>\n<size>\n`
(`tools/ota_manifest.py` makes and verifies it; `main/ota_core.c` parses it, host-tested). The
phone installs only a manifest that (1) is signed by the update key built into it
(`main/ota_signing_pub.pem` in official releases, yours in your builds), (2) names its board (`CONFIG_OLP_BOARD_ID`: `minimal-revA` or `minimal-v0901`, from the board choice), and
(3) is newer than what runs. It then downloads the image over HTTPS (certificate bundle; GitHub's
redirects followed), hashes it while writing the other slot, refuses a size or SHA-256 that differs
from the manifest, and lets `esp_ota_end` check the image; in release builds that includes the
image's own **Secure Boot V2 signature** (see below). It checks the new image's version too,
then restarts into it only when the phone is idle.

**Rollback.** Two app slots (`partitions.csv`, 1.875 MB each on 4 MB flash) and
`CONFIG_BOOTLOADER_APP_ROLLBACK_ENABLE`: a new image boots **on trial** and is kept
(`esp_ota_mark_app_valid_cancel_rollback`) once it reaches the server (a pairing code or a signed-in
`config`). If it crashes before that, the bootloader boots the old slot; if it runs but can't reach
the server for 5 minutes, it rolls itself back. The log says `OTA TRIAL`, `OTA VALID`,
`OTA ROLLED BACK`. Changing `partitions.csv` needs a USB flash (older phones with the one-slot table
must be flashed over USB once).

**When.** Checked a minute after going online and every 6 hours. An automatic update installs
only while the phone is **hung up and idle for 10 minutes**, and **overnight** (02:00-05:00 local:
SNTP plus the space's `utcOffsetMin` from `config`; no clock, no automatic install;
`CONFIG_OLP_OTA_NIGHT_ONLY`). **MENU → 9** updates now (not during a call); the display shows
`UPDATING 42%` / `DON'T UNPLUG`. Console: `ota`, `ota check`, `ota now`, `ota url <url>|default`.

**Signing without secure boot eFuses.** Release builds (`sdkconfig.release`) use ESP-IDF's
"signed app images without hardware secure boot" (`CONFIG_SECURE_SIGNED_APPS_NO_SECURE_BOOT`, RSA-3072,
the Secure Boot V2 scheme): the running firmware accepts an update only if it is signed with the key
that signed itself. Nothing is burned, so dev boards stay reflashable over USB; the protection is
against the network, not someone with the board in hand. Options: **(a)** this (the default);
**(b)** real **Secure Boot V2**: burn the same key's digest into eFuses so the ROM and bootloader
check every boot (one-time, irreversible; `espsecure`/`espefuse`, ESP-IDF's secure boot guide) — for
production phones, together with flash encryption; **(c)** dev builds (`sdkconfig.defaults`): no
image signature check (it would abort an unsigned running image), but the manifest signature and
SHA-256 still authenticate every update, so a dev board only installs release-key-signed images.

**Keys and releases.** The project's release key lives with the maintainer, outside the repo
(only its public half, `main/ota_signing_pub.pem`, is committed). `tools/release.sh keygen` makes
**your** key in `firmware/keys/` (gitignored, never committed or printed: **back it up offline**;
losing it means every phone needs a USB flash to trust a new key). `tools/release.sh build
[--repo you/your-repo]` signs a build of `PROJECT_VER` and writes `build-release/dist/`;
`publish --draft` (the default) makes a draft `fw-vX.Y.Z` that no phone sees; `publish --release`
asks for confirmation, publishes, and updates `fw-stable` in that repo.

**Tested in simulation (QEMU e2e step 11):** against a test pre-release (deleted after the run),
with throwaway keys (the test builds turn updates on with their own key): a manifest signed by another key, one for another board, a wrong SHA-256, an
image signed by another key (refused by `esp_ota_end`), an older version: all refused; a signed image
that crashes at boot: installed, tried, rolled back to the old slot; a good image: trial boot, kept
after reaching the server, still running after a restart. **QEMU caveat:** Espressif's QEMU
hangs on the bootloader's very first flash write, the one that records `ota_0` in a blank otadata
(it is the emulator: its GDB stub stops answering; builds 20250817 and 20260417), so
`tools/qemu.sh` writes that first entry into the flash image itself (`tools/qemu_otadata.py seed`,
byte for byte what the bootloader writes). The later writes (NEW → PENDING_VERIFY on the trial boot,
PENDING_VERIFY → ABORTED after the crash) were made by the bootloader itself in the test runs; the
test would make them on the stopped emulator if it ever stalled there, and says which happened.
**Needs the real board:** a power cut mid-update, and the first boot of a blank board's bootloader.

## Encrypted storage

Everything the phone keeps lives in NVS: its device key (the P-256 key that signs in to the
server), its id, and the Wi-Fi name and password. **Release builds encrypt NVS at rest**
(`CONFIG_OLP_STORAGE_ENCRYPTED`, set in `sdkconfig.release`; off in development and simulator
builds): ESP-IDF's HMAC-based NVS encryption. The keys that encrypt NVS (XTS-AES) are derived by
the chip's HMAC peripheral from a 256-bit key in an eFuse block (`KEY5`), which software can use but
never read. No flash encryption is needed for it, and nothing else about the phone changes.

**First boot with it (one-time, irreversible):** when the eFuse block is still empty, the firmware
generates a random key and **burns it into eFuse KEY5 with the purpose HMAC_UP**. That can't be
undone or changed: that block is used up for good, and the phone can only ever decrypt NVS written
under that key. If the board already ran a development build, the old (plain) NVS can't be read as
encrypted data, so the phone starts fresh: a new device key, and Wi-Fi setup and pairing again.
The log says `FIRST ENCRYPTED BOOT: burning a new NVS HMAC key into eFuse KEY5`, later
`STORAGE encrypted (… existing)`. Before flashing a release build on a dev board, decide whether
that board should stay a development board: the eFuse can't be un-burned.

**What it protects:** someone who reads the flash chip (desoldered, or over USB with esptool) sees
only ciphertext. **What it doesn't:** someone who can run their own firmware on the same chip can
use the HMAC peripheral too; that needs hardware Secure Boot V2 (see "Updates"), planned for
production phones.

**Wipes erase for real.** A remote removal (`wipe` from the server) or the console `wipe` erases
the **whole NVS partition** (every flash sector, not "mark deleted"), then writes back only the
Wi-Fi, server and update URL; a factory reset (MENU+BACK 10 s) erases it all. The old device key is
gone from the chip, not just unreachable. The HMAC key stays in eFuse (it can't be erased), which is
harmless: there is no old data left for it to decrypt.

**Tested in simulation (QEMU, which emulates the S3's eFuses and HMAC peripheral; e2e step 12):**
a build with encryption on burns KEY5 on the first boot (and only then), pairs and signs in; with
the emulator stopped, the device id, a Wi-Fi name and its password don't appear in the NVS flash
and the eFuse file has changed; after a restart the storage decrypts (same Wi-Fi, same phone signs
in); a removal erases it, generates a new key and keeps the Wi-Fi. Step 6 (a plain build) checks
that the old device id is gone from the flash after a wipe; with the old namespace-only erase it
fails (mutation-tested). **Needs the real board:** `espefuse.py summary` after the first boot
(KEY5 read-protected with purpose HMAC_UP), `hardware/BRINGUP.md` §7.

## Wi-Fi setup network

The setup page asks two things: the **Wi-Fi** and the **server** ("My own server" with its
address, or "Public hub (free, to try it)"; nothing is pre-selected on a new phone). Opened again
later, it keeps the saved Wi-Fi unless you pick another, and shows the saved server.

With no Wi-Fi saved (a new phone, or after a factory reset) the phone opens **"OpenLoungePhone-XXXX"**
(the last MAC bytes) and shows the steps on its display: the network name, its **8-digit password**
(WPA2, fresh each time, shown only there: joining needs someone at the phone) and
`OPEN 192.168.4.1`. Phones usually open the page by themselves: every DNS name answers with the
phone's address and the OS connectivity checks (`/generate_204`, `/hotspot-detect.html`, …) are
redirected to the page. The page lists nearby networks (strongest first) or takes a typed name,
and a password (checked: 8-63 characters or 64 hex); a typed name holds 32 bytes, like the
phone stores it. Anything that doesn't fit is refused with a message on the page, never cut or
dropped, and an address typed in the server box counts as choosing "My own server". **Save and
restart** stores it and the phone restarts onto it. The page answers only on the setup network, never on the home LAN.

It also opens when the saved Wi-Fi has been unreachable for 3 minutes (it closes again if the
saved one comes back), from MENU → 3 Wi-Fi → 1 or MENU → 4 Server → 1, from the console (`setup`), and with **MENU+BACK
held at power-on**: release after 3 s for setup, keep holding to 10 s for a factory reset (the
display says which). While it is open the phone retries its saved Wi-Fi only once a minute (a
station scanning for a missing network hops channels and drops the setup network's clients).
The decisions are pure code (`main/prov_core.c`: when to open/close, form decoding, input checks,
scan list, the captive DNS answer) with host tests; `main/prov.c` is the ESP side.

**Tested:** host unit tests; QEMU e2e step 10 (no radio in QEMU: the setup site runs on its
Ethernet through a forwarded port) — `wifi forget` → reboot → the setup screen → the page in
Chromium: captive redirect, a short password refused, save → restart with the saved network.
**Not tested in a simulator:** the SoftAP itself (QEMU has no Wi-Fi; Wokwi has no Wi-Fi clients
and its CI minutes were used up; `wokwi/setup.yaml` covers the MENU+BACK hold and the phone's own
`setup test` when they're back), the captive-portal pop-up on real phones (iOS, Android), and
the physical MENU+BACK hold. Bring-up: `hardware/BRINGUP.md` §6.

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
- **Codecs** (`main/voice.c`, host-tested with the system's libopus): **Opus** at 16 kHz mono,
  about 24 kbit/s, 20 ms frames, complexity 5, in-band FEC (libopus from Espressif's
  `espressif/esp_audio_codec`), and **G.711 µ-law (PCMU)** at 8 kHz as the fallback. The phone
  offers and accepts both; an offer without Opus opens the peer again sending PCMU before it
  answers. Its own SDP asks the other side for FEC and at most 16 kHz (`main/sdp.c`). `esp_peer`
  sends the codec it was opened with: a call the phone places sends Opus, so a peer that
  answers PCMU only (as a phone on 0.9.5 or older would) can't decode it. The log's `CODEC send=… recv=…`
  says what a call uses; `CONFIG_OLP_CALL_OPUS=n` builds a PCMU-only phone.
- **The audio path runs at 16 kHz.** G.711 calls, the house intercom, voicemail and greetings
  stay 8 kHz (WAV everywhere) through 2:1 half-band resamplers (`main/resample.c`: flat to
  3.4 kHz, at least 70 dB down from 4.6 kHz).
- **Two audio tasks.** A pump (`audio_io`) reads and writes the codec in 1 ms DMA blocks
  (`CONFIG_OLP_AUDIO_BLOCK`) and mixes in the sidetone; the audio task does the 20 ms work (the
  codecs, AGC, echo canceller, tones, voicemail) through lock-free FIFOs (`main/fifo.c`), keeping
  about 15 ms queued for the earpiece. Opus encodes on the audio task's stack (36 KB); its
  states and the echo canceller's are in PSRAM. The `AUDIO` line every 5 s gives the encode,
  decode and echo canceller time per frame (average/worst, µs), the stack left and the internal
  heap.
- **Audio device** (`main/audio_dev.h`): the **ES8311** on I2S0 (16 kHz, 16-bit mono, MCLK
  4.096 MHz from the S3; registers set over I2C, `main/audio_es8311.c`), or a **test device**
  (`main/audio_test.c`: the "mic" is a tone at -15 dBFS, 1 kHz unless `audio source`, the
  "earpiece" measures level and a watched frequency). The simulators always use the test device;
  a board without a codec falls back to it. `audio` prints the counters and levels of the
  current call.
- **Earpiece:** plays only with the handset lifted (the DAC is muted on the hook); call-progress
  tones (`soundFor` in `packages/core`: dial 350+440 Hz, ringback 440+480 Hz 2 s/4 s, busy 480+620
  Hz 0.5 s/0.5 s, hold beep) are mixed in locally. **Volume** 0-10 (MENU → 1, `volume`), 3 dB steps
  below a **cap of -6 dBFS** (`CONFIG_OLP_EARPIECE_MAX_DB`; hardware owner question 8: full scale
  may reach ~98 dB SPL until the receiver is measured). **Sidetone** (MENU → 1 → 6): your voice
  at -20 dB (normal, the default) or -26 dB (low), only in a connected call and never while
  muted; about 4 ms mic to ear by design (a block in, two queued out, the codec's filters).
- **Mic:** captured only while a call's media is connected and not muted (MENU 3), while leaving a
  message, while the phone check (MENU 7) is open with the handset up (to show its level, or for
  the echo test; nothing is sent or kept), or during the `audio loop` bring-up test; otherwise the
  ADC is muted and I2S RX is off. The PGA is at 30 dB plus 6 dB of ADC scale-up by default, then
  an **AGC** (`main/agc.c`: speech to -24 dBFS, gain -6 to +18 dB, only on frames above a gate
  over the noise floor, a -3 dBFS peak limiter).
- **Receiving** (`main/jbuf.c`, `main/plc.c`): an adaptive jitter buffer (starts at 60 ms, then
  40-120 ms from the measured jitter) behind `esp_peer`'s own; lost frames come from Opus FEC or
  Opus's concealment, or for PCMU a G.711 Appendix I-style concealment (pitch repetition, fading
  to silence over 60 ms).
- **Echo** (`main/echo.c`, SpeexDSP in `components/speexdsp`): the echo return loss is measured in
  every call (`AUDIO erl=`); the phone check's echo test (MENU 7 → 2) measures it and the delay
  with a sweep. The canceller (SpeexDSP's, 64 ms tail, with its residual echo suppressor) is off by
  default (`CONFIG_OLP_ECHO_CANCEL`), on per phone with MENU → 1 → 7, and turned on by an echo
  test that finds a poor loss (under 30 dB).

**Verified in simulation** (QEMU, `tests/e2e/live/firmware.test.ts` against a live server, see
TESTLOG.md): ICE through Cloudflare TURN over UDP (relay to relay) and directly, DTLS-SRTP, RTP both ways with
test tones (the companion finds the phone's 1 kHz with WebAudio; the phone measures the companion's
440 Hz), both call directions, hang-up turns the mic off. Entirely local
(`tests/e2e/live/codec.test.ts`: QEMU, a self-hosted server on this machine, the companion in
Chromium): a call from the companion negotiates Opus and carries 5 and 6 kHz tones both ways, and
PCMU (telephone band only) when Opus is taken out of its offer; a call the phone places offers both
(its media can't connect behind QEMU's NAT without TURN); the echo test runs. **Needs the real
board:** the ES8311 register setup and I2S timing at 16 kHz with 1 ms blocks, levels and the mic
gain default, the volume cap in dB SPL, the sidetone's delay and level, Opus's sound and CPU time,
echo from each handset, and call quality over real Wi-Fi:
[`hardware/BRINGUP.md`](../hardware/BRINGUP.md).

## Pairing a phone

1. Power it. A new phone opens its setup network first (above): choose its Wi-Fi and its server.
   Once online it shows `PAIR 123 456` on the strip (and prints `PAIRING CODE:`).
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
python3 firmware/tools/qemu_smoke.py   # the CI boot smoke test (a default build: no server)
```

`firmware/tools/qemu_cable.py` builds QEMU for hw v0.901 (`build-qemu-v0901`) and runs the wired
network checks above (`QEMU_MONITOR=<port>` puts QEMU's monitor on a local port, with the phone's
network as the netdev `cable`).

The smoke test boots a default build (no `OLP_SIM_SERVER`): it checks `SET UP: CHOOSE A SERVER`,
MENU → 4, that updates are off, and, from a packet capture of QEMU's network (`QEMU_PCAP`), that
the phone sent nothing but DHCP: no DNS, no TCP, no UDP to anyone. `OLP_SIM_SERVER=wss://host`
builds for a server (the e2e tests use their own). The e2e test uses QEMU by default (`OLP_SIM=qemu`; `OLP_SIM=wokwi` for Wokwi).

## Wokwi simulator

`wokwi/diagram.json` is an ESP32-S3 devkit with 12 key buttons, the hook button (held = on the
hook), the status LED, the buzzer and a display. The simulator build (`sdkconfig.sim`) joins
`Wokwi-GUEST`, connects to the server you build it for (`OLP_SIM_SERVER=wss://your-test-server`;
none otherwise), prints the console
on UART0 (so keys 6 and 7 move from IO43/IO44 to IO35/IO36) and has no PSRAM.

```sh
curl -L https://wokwi.com/ci/install.sh | sh      # or the release binary into ~/.local/bin
echo "<token>" > firmware/.wokwi-token            # gitignored; never commit it
OLP_SIM_SERVER=wss://your-test-server firmware/tools/sim.sh smoke  # build + wokwi/smoke.yaml → build-sim/serial.log, *.png
firmware/tools/sim.sh interactive  # the console on your terminal (hook, keys, status…)
```

`smoke.yaml` boots, joins Wi-Fi, opens the WebSocket, waits for `pair.code` and the strip, moves
the hook, walks MENU → About → BACK, presses keys, and saves `build-sim/screenshot.png` (the
simulated display) and `build-sim/display.png` (the firmware's own framebuffer). To finish
pairing live, run `sim.sh interactive` and type the printed code into the companion on that
server (Home → + Pair a phone). Another server: `server <address>` at the `olp>` prompt.

Simulator notes (all only in the sim build):
- **Display stand-in:** Wokwi has no supported e-paper part. The community chip
  (`board-epaper-2in9`, bonnyr/wokwi-ws29v2) takes one byte per chip select, animates every
  refresh line by line (the whole simulation ran at a fraction of real time) and dropped the
  simulator's connection. The sim uses Wokwi's ILI9341 SPI TFT on the same pins
  (`main/display_ili9341.c`), drawing the same screen image.
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
