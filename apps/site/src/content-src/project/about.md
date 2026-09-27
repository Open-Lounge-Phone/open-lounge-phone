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

## Principles

- **Default deny.** A phone only talks to people explicitly allowed on it, in both directions.
- **No hosted dependency.** You run it — on your own free Cloudflare account or on your own
  hardware with Docker. There is no central service, and this project never sees your calls.
- **Screen-light by design.** Keys, lights and voice first; a small status strip at most.
- **Repairable.** Hot-swap keys, a plug-in display, a standard coiled handset cord.
- **Open.** Software under **AGPL-3.0-or-later**, hardware under **CERN-OHL-S-2.0**. If you run a
  modified server for others, you share your changes.

## Status

| Part | State |
|---|---|
| Wire protocol, access control, quiet hours | done |
| Self-hosted server, browser phone emulator, companion app | done |
| Cloudflare backend (Workers, Durable Objects, D1, TURN) | done |
| Invites, passkeys, voicemail with transcripts | done |
| One-command deploy, desktop app | next |
| Lounge features | planned |
| ESP32-S3 firmware and custom PCB | in design |

See the [introduction](/intro/) for the full picture and [contributing](/project/contributing/)
to get involved.
