# Firmware changelog

## 0.6.0 — 2026-09-30: your keys, your server

- **No server by default.** `CONFIG_OLP_SERVER_URL` is empty: a phone built from source connects
  to nothing and shows `SET UP: CHOOSE A SERVER` until one is chosen. The setup page now asks for
  the server too: "My own server" (an address) or "Public hub (free, to try it)". Also MENU → 4
  (→ 1 re-opens setup) and the console `server <address> | hub | none`. Another server means
  pairing again. The simulator configs no longer name a server (`OLP_SIM_SERVER`).
- **Updates off in source builds.** New `CONFIG_OLP_OTA` (off): no update key and no update URL
  are embedded, there are no update checks and no SNTP; MENU → 9 says `UPDATES / NOT SET UP`.
  Only official release builds (`sdkconfig.release`) embed the project's public key and the
  `fw-stable` channel. Builders turn updates on with their own key (`tools/release.sh keygen`,
  then `build --repo you/your-repo`); with updates on and no key the build stops and says how.
- CI: the QEMU smoke test boots a default build and checks from a packet capture that it sends
  nothing but DHCP; `check_release_scheme.py` checks the defaults, the release config and (with
  `--default-build` / `--release-build`) the built images.

## 0.5.0 — 2026-09-30: encrypted storage

- `CONFIG_OLP_STORAGE_ENCRYPTED` (on in `sdkconfig.release`, off for development and the
  simulators): ESP-IDF's HMAC-based NVS encryption. The device key, its id and the Wi-Fi password
  are encrypted at rest with keys derived from a random eFuse key (KEY5, purpose HMAC_UP) burned on
  the first boot: **one-time and irreversible** (README "Encrypted storage" says what happens).
- Wipes erase the whole NVS partition physically (remote removal, the console `wipe`, and the
  factory reset); a removal writes back only the Wi-Fi, the server and the update URL. Before, a
  removal marked the identity namespace deleted and the old key stayed in the flash until reused.
- `status` shows `storage=encrypted|plain`.
- QEMU e2e: step 12 (a build with encryption on: the key is burned once, nothing readable in the
  flash, decrypts after a restart, a removal erases and keeps the Wi-Fi) and step 6 now checks the
  old device id is gone from the flash after a wipe.

## 0.4.0 — 2026-09-30: signed over-the-air updates

- Two app slots (`partitions.csv`, 4 MB layout) with bootloader rollback. **A USB flash is needed
  once** to move from the one-slot table.
- Updates come from one fixed channel, the `fw-stable` release's `firmware-manifest.json` (never
  GitHub's `/releases/latest`, which can be a hardware release). Firmware releases are `fw-vX.Y.Z`
  (made with `--latest=false`); hardware releases are `hw-vX.Y`. CI checks the scheme.
- The manifest names the board (`minimal-revA`) and is signed (RSA-PSS, the release key built into
  the phone); the phone refuses another board, an older or equal version, a bad signature, a size
  or SHA-256 that differs, and (release builds) an image whose own Secure Boot V2 signature isn't by
  its key. A new image runs on trial and is kept once it reaches the server; a crash or 5 minutes
  without the server rolls it back.
- Automatic updates only while hung up and idle for 10 minutes, at night (SNTP + the space's UTC
  offset, a new optional `utcOffsetMin` in `config`); MENU → 9 updates now. Console `ota`.
- `tools/release.sh` (keygen, signed build, draft by default, a confirmed real release that also
  updates the channel), `tools/ota_manifest.py`, `sdkconfig.release`. The release key was generated
  into `firmware/keys/` (gitignored); its public half is `main/ota_signing_pub.pem`.
- The firmware version comes from the app descriptor (`PROJECT_VER`), one place.

Found and fixed on the way (TESTLOG.md): the QEMU bootloader hangs on its own flash writes (an
emulator bug; the OTA test makes those writes for it); a new Kconfig symbol didn't reach cached QEMU
builds (the build key now includes `Kconfig.projbuild`).

## 0.3.0 — 2026-09-30: Wi-Fi setup network

- With no Wi-Fi saved the phone opens "OpenLoungePhone-XXXX" (WPA2, a fresh 8-digit password shown
  on the display) with a captive-portal DNS and a one-page setup site at http://192.168.4.1/:
  nearby networks or a typed name, a checked password, Save and restart. The page answers only on
  the setup network.
- It also opens after 3 minutes without the saved Wi-Fi (and closes when it's back), from
  MENU → 3 Wi-Fi → 1, from the console (`setup`), and with MENU+BACK held 3 s at power-on;
  held 10 s it's a factory reset (erases everything, as docs/device-lifecycle.md says).
- The display shows the steps. Console: `setup`, `setup test` (the phone fetches and posts its own
  page), `wifi forget`.
- Wi-Fi reconnects use a timer instead of sleeping in the event handler (which stalled every other
  Wi-Fi event), and retry once a minute while the setup network is up.
- Pure logic in `main/prov_core.c` with host tests; QEMU e2e step 10 drives the page from Chromium.

Found and fixed (TESTLOG.md): a phone without saved Wi-Fi closed the setup network as soon as any
link came up; the setup site answered 403 because the HTTP server listens dual-stack (IPv4
clients appear as `::ffff:a.b.c.d`).

## 0.2.0 — 2026-09-30: call audio

Two-way call audio between the phone and the apps.

- WebRTC with Espressif's `esp_peer` (component registry, `~1.5.6`): ICE with the server's
  STUN and TURN over UDP from `rtc.config`, DTLS-SRTP, RTP. TURN over TCP/TLS is opt-in
  (`CONFIG_OLP_ICE_TCP_RELAY`, `ice tcp|tls`) because it doesn't work in `esp_peer` 1.5.6 (README). The caller offers; the other side's trickled `rtc.ice`
  candidates are applied (queued until its SDP). No media, no call: a failed or lost connection
  hangs up. The old signaling-only SDP (audio rejected) is gone.
- G.711 µ-law (PCMU) at 8 kHz, chosen over Opus for robustness (README "Call audio").
- Audio device interface: the ES8311 over I2S (8 kHz mono, MCLK 2.048 MHz, init over I2C on the
  new `i2c_master` driver) or a test device (1 kHz source, analysing sink) for the simulators and
  bring-up. The mic is captured only while a call's media is up.
- Earpiece: call-progress tones mixed in locally (dial, ringback, busy, hold), volume 0-10 in 3 dB
  steps under a -6 dBFS cap (Kconfig), MENU → 1 Volume. Muted on the hook.
- Console: `audio` (counters, levels, `tone`, `loop` echo test, `watch`), `volume`, `rtc`,
  `ice all|udp|tcp|tls`.
  TURN credentials are never logged (`rtc.config` is logged without them; `esp_peer`'s agent log
  stays at WARN).
- ESP-IDF v5.5 (v5.5.5) is now required: `esp_peer`'s prebuilt libraries need `esp_log()`.
- QEMU build (`sdkconfig.qemu`, `tools/qemu.sh`): Espressif's esp32s3 machine with its OpenCores
  Ethernet standing in for Wi-Fi; CI boots it (`tools/qemu_smoke.py`). The e2e test runs on QEMU
  by default (Wokwi's free plan ran out of CI minutes).
- Host unit tests (`firmware/test/host`, in CI): G.711, tones and cadences, meters, ICE choice.
- `hardware/BRINGUP.md`: the checklist for the first real board (codec, levels, cap, echo).

Found and fixed on the way (TESTLOG.md): the test device's catch-up loop starved the idle task
(watchdog); one-second sample buffers cost 48 KB of RAM (now running meters); the console's terminal
probe swallowed the first command typed after boot (the e2e now waits for the prompt); QEMU with
32 MB PSRAM left no address space for the flash (8 MB, like the board's module); QEMU's Ethernet
dropped RTP bursts with 4 RX buffers (16).

## 0.1.0 (v0) — 2026-09-30

First firmware for the minimal board (ESP32-S3, ESP-IDF v5.4). No call audio yet.

- Pin map generated from the hardware build (`tools/gen_board.py` → `main/board.h`).
- 12 keys, hook and jack detect: GPIO interrupts + debounce; piezo ring and beeps (LEDC);
  status LED patterns: idle, pairing, connecting, offline, ringing, missed.
- Display interface with the WeAct 2.9" e-paper (SSD1680) driver and an ILI9341 stand-in for
  the Wokwi simulator; the protocol's strip model in large type; `screen` dumps the framebuffer.
- Wi-Fi from NVS or Kconfig; server from NVS or Kconfig (default `wss://l1.openloungephone.app`);
  WebSocket over TLS with the certificate bundle; keep-alive and `status`.
- Protocol: `hello` → `pair.begin` (P-256) → `pair.code` → `pair.done` → reconnect →
  `auth.challenge`/`auth.proof` → `config`; `deviceStep` mirrored in C; `wipe` → reboot, new key.
- Signaling-only calls: SDP with the audio section rejected, so calls go `active` without media.
- MENU → Wi-Fi status and About (version + the four fingerprint words).
- Console: `wifi`, `server`, `status`, `key`, `hook`, `drop`, `wipe`, `screen`, `reboot`.
- Wokwi: diagram, smoke scenario, `tools/sim.sh`; live e2e `tests/e2e/live/firmware.test.ts`.

Fixes found by the simulator and the e2e run (see TESTLOG.md):
- A board without a display module no longer waits 45 s at boot (BUSY pulled down, init gives up
  after 1 s).
- `screen` rows can no longer be split by other tasks' log lines.
