# Firmware (later phase)

ESP32-S3 firmware (ESP-IDF / FreeRTOS). It will implement [protocol v1](../docs/protocol.md)
and mirror the handset state machine in `packages/core/src/device.ts`, using the browser
emulator (`apps/device-web`) as its reference implementation and test peer.
