# Firmware changelog

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
