---
title: "Make it yours"
description: "Where to change what — the box and keys, the firmware, the server and apps, or your own client or server that speaks the open protocols."
---

Everything is open: software under AGPL-3.0-or-later, hardware under CERN-OHL-S-2.0. Here is
where each kind of change lives in the
[repository](https://github.com/Open-Lounge-Phone/open-lounge-phone).

| You want to… | Start in | Read |
|---|---|---|
| Change the look: keycaps, switches, box colour, handset | the parts themselves; the box is code in `hardware/enclosure/` | [Assembly](/hardware/assembly/) |
| Change the board | `hardware/schematic/` (schematic as code, with checks) | [Hardware design](/hardware/design/), [Schematic](/hardware/schematic/) |
| Make a key do something new | `firmware/labs/` | [Labs firmware](/extend/labs/), [its reference](/reference/labs-firmware/) |
| Change how the phone behaves | `firmware/main/` and the browser phone in `apps/device-web/` | [The phone's screens, keys and sounds](/reference/phone-ux/), [Firmware](/reference/firmware/) |
| Change the server or the apps | `packages/` and `apps/` | [Architecture](/reference/architecture/) |
| Put a service on the line (an AI, a notes taker) | the add-on bridge, `sdk/python/` (Apache-2.0) | [Add-ons](/how-to/add-ons/), [reference](/reference/add-ons/) |
| Write your own phone or app | — | [Wire protocol](/reference/protocol/) |
| Write your own server that federates | — | [Federation spec](/reference/federation-spec/) |

## Your build, your keys

A phone built from source depends on nobody, this project included. It connects to no server
until you choose one on its setup page, and checks for no updates unless you make your own
update key and channel. Its device key is made on the phone and never leaves it. Details:
[security model](/reference/security-model/) and "Your keys, your server" in the
[firmware reference](/reference/firmware/).

## Keeping compatible

If your phone, app or server should keep talking to everyone else, follow the version rules:
additive changes are fine, anything else needs a new protocol version.
[Versions and releases](/project/versions/) explains how they fit together.

## Share it back

Found a bug, built something new, or printed a nicer box? See
[Contributing](/project/contributing/).
