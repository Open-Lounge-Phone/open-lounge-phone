---
title: Getting started
description: Three ways in — the public hub, your own server, or an invite — and trying everything on your own computer in five minutes.
sidebar:
  order: 2
---

There are three ways to start. Whichever you pick, you get an **address** (`name@server`) that
people on any Open Lounge Phone server can knock on, and any device can be a phone.

## 1. Join the public hub

The public hub, `hub.openloungephone.app`, is free and funded by donations
([funding](/project/funding/)). *The code is ready; the hub opens soon.*

1. Open the hub and choose **Create an account**.
2. Pick a **handle** — your address will be `handle@hub.openloungephone.app` — and create a
   **passkey** on your device. No email, no phone number, no password.
3. Use any device as a phone: open `hub.openloungephone.app/device/` on an old phone, tablet or
   laptop and choose **Add to Home Screen**. Or pair phone hardware when it exists.
4. Knock on the people you want to call under **Connections (buddies)**.

The hub has a generous fair-use allowance; for full control of your data and keys, run your own
server instead (below) — it reaches everyone just the same.

## 2. Run your own server

- **On your own Cloudflare account:** one command, free plan is enough for a household —
  [deploy guide](/how-to/deploy-cloudflare/).
- **With Docker** on a spare computer, NAS or small server — [self-hosting](/how-to/self-host/).

Federation is **on by default**: people on your server can connect with (and call) people on the
hub and on every other server. It's also how you try everything on your own computer first — see
below.

## 3. Got an invite?

A guardian sent you a link? Just open it: it adds you to their household (or signs you in there).
If you already have an account on that server, open it while signed in and the household is added
to your account.

---

## Try it on your computer

Everything runs on an ordinary computer: a server, a browser phone that behaves exactly like the
hardware, and the companion app guardians use.

### 1. Start the server

You need [Node.js](https://nodejs.org) 22 or newer.

```sh
npm install
npm start
```

The server builds the web apps and starts on port 8787. On first start it prints a **one-time
setup link** like `http://localhost:8787/#setup=…`.

### 2. Create your household

Open the setup link, name your household and yourself. You're now its first guardian. The app
offers to add a passkey so you can sign in again later without a password.

### 3. Open a phone in the browser

Open `http://localhost:8787/device/` in another tab. The first time, it asks what the phone will
be — choose **Kids phone** — then one tap starts it (that tap lets it make sound and use the
microphone). That's the phone: twelve keys (`1 2 3 4 5 MENU` / `6 7 8 9 0 BACK`), a handset, key
lights and a small status display.

| Keyboard | Phone |
|---|---|
| <kbd>Space</kbd> | lift / hang up the handset |
| <kbd>0</kbd>–<kbd>9</kbd> | digit keys |
| <kbd>M</kbd> | MENU |
| <kbd>Esc</kbd> | BACK |

Add `?dev=1` for the developer panel (log, battery and power controls),
`?display=none` for the Kids Lite phone (no display) or `?display=segments` for a
14-segment display. Add `?profile=kitchen` to run a second phone in the same browser.

:::tip[Any device can be a phone]
An old phone, tablet or laptop on a stand makes a real phone: open `<your server>/device/` on it
and choose **Add to Home Screen** (or **Install app**). It opens full screen with the keys, the
status strip and a big **Lift handset** button, keeps the screen on, and reconnects by itself
after Wi-Fi hiccups. Leave it plugged in.
:::

### 4. Pair it

Lift the handset (<kbd>Space</kbd>): the phone reads a six-digit code aloud and shows it on its
display. In the companion app choose **+ Pair a phone** and enter the code.

### 5. Call

Lift the handset and press <kbd>1</kbd> — the pairing guardian is on speed dial 1 — and answer in
the companion app. Or press **Call** in the app and lift the phone's handset to answer.

## Next

- [Add family and quiet hours](/how-to/family-and-quiet-hours/)
- [Lounge phones](/how-to/lounge-phone/)
- [How it works](/reference/architecture/) and [how servers connect](/reference/federation/)
- [Privacy and retention](/project/privacy/)
