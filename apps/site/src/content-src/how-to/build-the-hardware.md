---
title: Build the hardware
description: The open-hardware phone — design, schematic, PCB layout and assembly.
sidebar:
  order: 5
---

The phone is a compact 3D-printed base with an off-the-shelf G-style handset on a USB-C cord. All
electronics sit on **one circuit board** in the base: an ESP32-S3, a hardware-echo-cancelling
audio codec, twelve hot-swap mechanical keys with per-key lights, a small e-ink status strip, NFC
and an optional battery. It's powered by USB-C. Hardware is licensed under CERN-OHL-S-2.0.

:::caution[Status]
The hardware is a **pre-production design**: the schematic is captured as code and checked, the
board's parts are placed and routing comes next, and no boards have been built yet. There is one
board with one parts list (no variants). Expect changes.
:::

Read in this order:

1. [Hardware overview](/hardware/overview/) — what's in the `hardware/` folder.
2. [Hardware design](/hardware/design/) — parts, board, pin map, power budget, cost.
3. [Design guidelines](/hardware/guidelines/) — safety and layout rules every board follows.
4. [Schematic](/hardware/schematic/) — how the schematic-as-code is built and checked.
5. [PCB layout](/hardware/layout/) and [Assembly](/hardware/assembly/) — making and building the
   board (JLCPCB first; outputs work at any PCB house or for hand assembly).

Until then, the [browser emulator](/getting-started/) behaves exactly like the phone, and the
firmware notes are in the [firmware reference](/reference/firmware/).
