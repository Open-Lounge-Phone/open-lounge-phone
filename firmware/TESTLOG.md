# Firmware test log

Wokwi simulation (ESP32-S3 devkit, `wokwi/diagram.json`), driven by `wokwi/smoke.yaml` (against
the owner's l1 since t1 was deleted) or by `tests/e2e/live/firmware.test.ts` (serial console + the
companion in Chromium with a virtual passkey; runs r1-r4 used the disposable server
`t1.openloungephone.app`, now any `OLP_E2E_SERVER`). Newest last.

| Date | Run | Step | Result | Issue found | Fix |
|---|---|---|---|---|---|
| 2026-09-30 | smoke | boot → display | FAIL | The community e-paper chip (`board-epaper-2in9`) dropped the simulator's connection on the first refresh: it takes one byte per chip select | Tried byte-per-CS: works, but its line-by-line refresh animation slowed the whole simulation to ~0.3× real time. Replaced by Wokwi's ILI9341 as a stand-in (`display_ili9341.c`) — `9e374aa` |
| 2026-09-30 | smoke | TLS to t1 | FAIL | `mbedtls_ssl_handshake -0x0050` (peer reset) ~6 s of simulated time into every handshake: Wokwi emulates software ECC ~7× slower than silicon (P-256 verify 1.4 s, P-384 2.4 s, measured in the sim), so Cloudflare's handshake timeout hits | 240 MHz, `-O2`, `MBEDTLS_ECP_FIXED_POINT_OPTIM` for all builds; the sim build trusts the GTS WE1 intermediate (skips the P-384 check) and uses P-256 for ECDHE: first-attempt success (~4.2 s simulated) — `9e374aa` |
| 2026-09-30 | noepd | boot | FAIL | With no display module, BUSY floats high: init waited 3 × 15 s | BUSY pull-down; init gives up after 1 s and the display is skipped — `9e374aa` |
| 2026-09-30 | smoke | scenario | FAIL | Scenario bug: `wait-serial` only sees output after it starts, so waiting after releasing a key missed the log line | Wait while the key is held — `9e374aa` |
| 2026-09-30 | smoke | all | PASS | boot, Wi-Fi, WebSocket, `pair.code`, hook, MENU → About, keys, screenshot (49 s) | — |
| 2026-09-30 | e2e r1 | 0-3, 5-7 | PASS | sign-up, boot + code, pairing + P-256 auth + words match, outgoing call active, reconnect, quiet hours → voicemail → MISSED MOM, remove → wipe → new key + code | — |
| 2026-09-30 | e2e r1 | 4 incoming | FAIL | Test bug: waited for the LED/buzzer log lines before the strip line, which is printed first | Wait for the strip first — `76a9057` |
| 2026-09-30 | e2e r1 | log | note | `WS closed0` when a socket closed without a code | `1bd1f45` |
| 2026-09-30 | e2e r2 | 0-7 | PASS | all 8 steps in 236 s; test account deleted | — |
| 2026-09-30 | e2e r2 | screen | FAIL | Some framebuffer dumps unreadable: another task's log line split a row | One `printf` per row — `76a9057` |
| 2026-09-30 | e2e r3 | 1, 6 | FAIL (infra) | Wokwi stalled: simulation A stopped printing mid-reconnect for ~110 s; simulation B never got past the CLI banner. No firmware fault in the log | Re-run later |
| 2026-09-30 | e2e r4 | 0-7 | PASS | all 8 steps (3.5 min), every framebuffer PNG readable (pairing, About words, idle, IN CALL, QUIET TIL 23:59 / MISSED MOM, new code after the wipe); test account deleted | — |
| 2026-09-30 | smoke l1 | boot → code | PASS | t1 deleted; the sim build now targets the owner's `wss://l1.openloungephone.app`. l1 has the same chain (GTS WE1 → GTS Root R4, identical SHA-256), so the pinned intermediate is unchanged. TLS opened on the first attempt; `PAIRING CODE: 399091` (left unpaired, no accounts made on l1) | this commit |
