---
title: Build the hardware
description: The open-hardware phone — the minimal board's design, schematic, layout checklist and assembly.
sidebar:
  order: 5
---

The phone is a compact 3D-printed base with an off-the-shelf analog G-style handset that plugs
into a 3.5 mm jack (for example the Opis 60s Micro). All electronics sit on **one small,
deliberately minimal circuit board** (2 layers, 53 parts): an ESP32-S3 module, one USB-C port
for power and flashing, one 3.3 V regulator, twelve hot-swap mechanical keys and a hook switch,
a socket for a ready-made 2.13" e-paper display module, an audio codec for the handset, a piezo
ringer and one status light. There is **no** battery, NFC, speaker, per-key lights or hardware
mute switch.

**The board has no microphone of its own.** The only microphone is the one in the handset:
unplug the handset and there is no microphone connected at all; while the handset is hung up the
software keeps its mic muted (see the
[security model](https://github.com/Open-Lounge-Phone/open-lounge-phone/blob/main/docs/security-model.md)).
The phone is mains/USB-powered like a landline: no battery by design, it is not a mobile device.
Hardware is licensed under CERN-OHL-S-2.0.

:::caution[Status]
**Hardware v0.1 is an early dev board prototype** (silkscreen rev A, 156 × 88 mm, 2 layers, 53
parts): four phones on the first boards, made by JLCPCB, are built and working, running
the experimental labs build (0.0.0), lightly tested so far. Expect a revision: we recommend trying a virtual phone first
and waiting for board v1.0 before building your own. The exact manufacturing files (Gerbers,
BOM/CPL, schematic and layer PDFs, STEP) and the build and flash guide are in the
[hw-v0.1 release](https://github.com/Open-Lounge-Phone/open-lounge-phone/releases/tag/hw-v0.1).
:::

:::tip[Board v0.3: coming soon]
For tinkerers: board v0.3 will be offered **fully assembled** or as a **bare PCB** to populate yourself. No price
or date yet. [Join the interest list](https://github.com/Open-Lounge-Phone/open-lounge-phone/discussions/1) and say which you'd want.
:::


Read in this order:

1. [Hardware overview](/hardware/overview/) — what's in the `hardware/` folder.
2. [Hardware design](/hardware/design/) — parts, board, pin map, power budget, cost.
3. [Design guidelines](/hardware/guidelines/) — safety and layout rules every board follows.
4. [Schematic](/hardware/schematic/) — how the schematic-as-code is built and checked.
5. [Layout checklist](/hardware/layout/) and [Assembly](/hardware/assembly/) — what the 2-layer
   layout must meet, and building the board (JLCPCB first; any PCB house or hand assembly).

## Your keys, your server

A phone you build depends on nobody, this project included:

- **No server until you choose one.** Its setup page asks for your Wi-Fi and a server: **My own
  server** (its address) or **Public hub (free, to try it)**. Change it later with MENU → 4.
- **No updates unless you set them up.** Firmware built from source has no update key and checks
  nothing. To update your own phones, make your own key (`firmware/tools/release.sh keygen`) and
  publish to your own channel. Only the project's official firmware downloads take the project's
  updates.
- **Its device key is made on the phone** and never leaves it. If you turn on Secure Boot, it uses
  your key.

Details: "Your keys, your server" in the [firmware reference](/reference/firmware/).

## Until the boards arrive

Until then, the [browser phone](/getting-started/#try-it-on-your-computer) behaves like the
hardware phone: same keys, same screens. The phone firmware (0.9.x: Wi-Fi setup from your phone,
pairing, calls with two-way audio, voicemail, Lounge phones, updates) builds with ESP-IDF and
runs in a simulator; see the [firmware reference](/reference/firmware/) and its
[changelog](/project/firmware-changelog/). When a board arrives, [Bring-up](/hardware/bring-up/)
is the checklist for trying it.

## Then make it do more

The same board runs the [labs firmware](/extend/labs/): a house intercom, a doorbell, a daily
check-in, a Home Assistant panel, a macro pad and a few games. See also
[make it yours](/extend/make-it-yours/) and [versions and releases](/project/versions/).
