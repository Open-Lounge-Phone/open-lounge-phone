---
title: Getting started
description: Run Open Lounge Phone on your computer in five minutes — a server, an emulated phone and the companion app.
sidebar:
  order: 2
---

Everything runs on an ordinary computer before any hardware exists: a server, a browser emulator
that behaves exactly like the phone, and the companion app guardians use.

## 1. Start the server

You need [Node.js](https://nodejs.org) 22 or newer.

```sh
npm install
npm start
```

The server builds the web apps and starts on port 8787. On first start it prints a **one-time
setup link** like `http://localhost:8787/#setup=…`.

## 2. Create your household

Open the setup link, name your household and yourself. You're now its first guardian. The app
offers to add a passkey so you can sign in again later without a password.

## 3. Open an emulated phone

Open `http://localhost:8787/device/` in another tab. That's the phone: twelve keys
(`1 2 3 4 5 MENU` / `6 7 8 9 0 BACK`), a handset, key lights and a small status display.

| Keyboard | Phone |
|---|---|
| <kbd>Space</kbd> | lift / hang up the handset |
| <kbd>0</kbd>–<kbd>9</kbd> | digit keys |
| <kbd>M</kbd> | MENU |
| <kbd>Esc</kbd> | BACK |

Add `?display=none` for the Kids Lite phone (no display) or `?display=segments` for a
14-segment display. Add `?profile=kitchen` to run a second phone in the same browser.

## 4. Pair it

Lift the handset (<kbd>Space</kbd>): the phone reads a six-digit code aloud and shows it on its
display. In the companion app choose **+ Pair a phone** and enter the code.

## 5. Call

Lift the handset and press <kbd>1</kbd> — the pairing guardian is on speed dial 1 — and answer in
the companion app. Or press **Call** in the app and lift the phone's handset to answer.

## Next

- [Add family and quiet hours](/how-to/family-and-quiet-hours/)
- [Deploy your own on Cloudflare](/how-to/deploy-cloudflare/) or [self-host with Docker](/how-to/self-host/)
- [How it works](/reference/architecture/)
