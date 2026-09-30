# Firmware changelog

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
