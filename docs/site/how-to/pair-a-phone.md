---
title: Set up a phone
description: Get a phone online, choose its server and pair it to your household or team with a six-digit code, on the hardware phone or any old phone or tablet.
sidebar:
  order: 4
---

Every phone has its own cryptographic key, made on the phone and never shared. Setting a phone up
means three things: getting it online, telling it which server to use, and **pairing** it, which
tells your server which household or team that key belongs to.

## A browser phone (any old phone, tablet or laptop)

No hardware yet? Open `<your server>/device/` in the device's browser (on the public hub:
`hub.openloungephone.app/device/`), choose **Add to Home Screen**, open it from there and pick
**Kids phone**, **My own phone** or [**Lounge phone**](/how-to/lounge-phone/). It's already
online and already knows its server, so skip to [Pair it](#pair-it). Tap the big **Lift handset**
button when the steps below say to lift the handset.

## A hardware phone: first start

1. **Plug it in** (USB-C, any phone charger). The screen shows the Open Lounge Phone mark, then
   `SET UP:` / `CHOOSE A SERVER`. A new phone connects to nothing until you tell it to.
2. **Open the setup network.** Press **MENU**, then **3** (Network), then **1** (Change). The
   screen shows a QR code and, in words, a Wi-Fi network name and password.
3. **Scan the QR code** with your phone's camera (or join that network by hand and open
   `192.168.4.1`). A setup page opens.
4. **On the setup page**, pick your home Wi-Fi and enter its password, then choose a server:
   - **My own server**: type its address (for example `phone.example.com`);
   - **Public hub**: free, to try it or if you'd rather not run anything.
5. **Save.** The phone joins your Wi-Fi (it needs a 2.4 GHz network) and connects to the server.

If Wi-Fi won't join, the screen says why: `WRONG PASSWORD?`, `WEAK WI-FI` or `NETWORK NOT SEEN`
(usually a 5 GHz-only network). See [Using the phone](/how-to/using-the-phone/#when-somethings-wrong).

## Pair it

1. **Lift the handset.** An unpaired phone shows a six-digit code, `PAIR 123 456`, with three
   short beeps (the browser phone also reads it aloud). The code is valid for 10 minutes.
2. **In the companion app** choose **+ Pair a phone** and enter the code. The app shows **four
   words**. Check the phone shows the same ones under **MENU**, then **0 About**. Different
   words mean it's a different phone: don't pair it.
3. Pick **how it will be used** (what the phone was set up as is preselected):
   - **Kids phone**: for a child; only the people you allow, plus quiet hours (households only,
     set up by a guardian);
   - **My own phone**: a desk or bedside phone that is always you (anyone can add their own);
   - **Lounge phone**: shared; idle until someone signs in (guardians and admins).
4. **Give it a name**, for example "Maya's phone". It comes online in the app, and its screen
   shows whose phone it is (`KIDS: SMITH HOME`, `JESSE'S PHONE`).

On a kids' phone you're added automatically as its first contact, on speed-dial key **1**, and
you can always ring through quiet hours. Next: [choose who's on its keys](/how-to/family-and-quiet-hours/).

## Afterwards

- **Key labels.** **Manage phone → Print key labels** prints a sheet of names to slip under the
  clear keycaps.
- **The phone's page** (**Manage**) shows when it was last seen, the software it runs and its
  four words.
- **Moving it to another Wi-Fi or server:** **MENU 3**, then **1 Change** opens the setup
  network again. A new server means pairing again.
- **Updates.** Official firmware checks for signed updates and installs them itself (**MENU 9**
  to check now); firmware you build yourself has updates off.

:::note
**Remove and wipe** (on the **Manage** page) makes the server forget the phone, and the phone
wipes itself: at once if it's online, otherwise when it next connects. Nothing stays on it. To
use a phone another way or give it to another household, remove it and pair it again. Holding
**MENU and BACK** for 10 seconds while plugging it in also erases it completely.
:::
