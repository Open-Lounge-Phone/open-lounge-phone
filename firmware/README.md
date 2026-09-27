# Firmware (later phase)

ESP32-S3 firmware (ESP-IDF / FreeRTOS). It will implement [protocol v1](../docs/protocol.md)
and mirror the handset state machine in `packages/core/src/device.ts`, using the browser
emulator (`apps/device-web`) as its reference implementation and test peer.

## Requirements already decided

### USB power source policy (hardware/DESIGN.md §9.2a)

- Read the USB-C Rp advertisement on CC1/CC2 (GPIO1/GPIO2, ADC1; 5.1 kΩ Rd fitted):
  `< 0.66 V` = Default (500 mA, also every USB-A→C cable), `0.66–1.23 V` = 1.5 A, `> 1.23 V` = 3 A.
  Use the higher of the two pins (only the connected one carries Rp). Re-read on attach and
  every few seconds.
- **Kids:** full features on any source.
- **Lounge on a Default source → reduced mode:** keep the radar powered off (`LD_PWR_EN` low),
  LEDs ≤ 10 %, ringer ≤ 0.5 W, charging off (`CHG_CE` high); presence falls back to hook + NFC.
  Status display: `USE 1.5A CHARGER`.
- Always cap LEDs ≤ 30 % and amp level per `hardware/schematic/power_budget.yaml`.
- Report it in `status`: `power: { source: "default" | "1.5A" | "3A", reduced: boolean }`.
