---
title: About
description: Why Open Lounge Phone exists, the principles behind it, and where it stands.
sidebar:
  order: 1
---

## Why

**A first phone without the internet in it.** Kids want to call grandma and their friends; parents
don't want to hand them a smartphone. Open Lounge Phone is a real phone with real keys and a
handset — and nothing else. No browser, no games, no strangers: it can only reach the people a
guardian approves, and it goes quiet at bedtime.

**A phone that belongs to the room, not the person.** In lounges, clubs and phone booths, the same
hardware becomes a shared phone: take it over with your own contacts, see who's around to chat,
and it forgets you when you leave.

**Inspired by the Tin Can phone.** The idea of a simple, kid-safe landline that only calls
approved people comes from the [Tin Can](https://tincan.kids/) phone. Open Lounge Phone is an
independent, open-source take on that idea (open hardware, your own server, federation). It is not
affiliated with or endorsed by Tin Can, and "Tin Can" is their trademark.

## Principles

- **Default deny.** A phone only talks to people explicitly allowed on it, in both directions.
- **No hosted dependency.** You run it — on your own Cloudflare account or on your own hardware
  with Docker — or use the free public hub, which is just one more server. Servers federate as
  equals; there is no central directory, and nobody sees your call audio.
- **No phone network, no text chat.** A closed, spam-free network of people who accepted each
  other.
- **Screen-light by design.** Keys, lights and voice first; a small status strip at most.
- **Repairable.** Hot-swap keys, a drop-in display, a standard USB-C handset cable.
- **Open.** Software under **AGPL-3.0-or-later**, hardware under **CERN-OHL-S-2.0**. If you run a
  modified server for others, you share your changes.

## Status

| Part | State |
|---|---|
| Wire protocol, access control, quiet hours | done |
| Self-hosted server, browser phone (any device, `/device/`), companion app | done |
| Cloudflare backend (Workers, Durable Objects, D1, TURN) | done |
| Invites, passkeys, voicemail with transcripts | done |
| Grown-up calls between companion apps, availability | done |
| Lounge phones: QR takeover with a key proof, open to chat | done (software) |
| Accounts and addresses (`name@server`), households, teams and organizations | done |
| Connections across servers ("knock, then talk"), calls, voicemail, presence, Lounge guests | done |
| The free public hub (fair use, operator tools, export and account deletion) | live at hub.openloungephone.app |
| Voicemail for every unanswered call, greetings (standard, your name, your own), ring time | done (software) |
| Per-buddy call timeline; rooms and 3-way calls; interop tests; professional features | planned |
| One-command deploy (done), desktop app | desktop app next |
| Circuit board (one ESP32-S3 board, one BOM) | in design: parts placed, routing next |
| 3D-printable base | prototype box designed; enclosure being updated for the single board |
| ESP32-S3 firmware | after the board |

See the [introduction](/intro/) for the full picture and [contributing](/project/contributing/)
to get involved.
