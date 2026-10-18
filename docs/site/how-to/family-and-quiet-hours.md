---
title: Add family & quiet hours
description: Invite grandparents and friends, choose who can call, assign speed-dial keys and set quiet hours.
sidebar:
  order: 4
---

A phone can only call — and be called by — people on its allow-list. Everything else is refused.

## Invite people

In the companion app open **People** and choose **Invite someone**. Pick whether they're a
**contact** (can call phones they're allowed on) or a **guardian** (can also manage phones,
people and quiet hours). Share the link it creates; it works once and expires after 7 days.
They join with one tap and can add a passkey on their own device.

## Choose who can call

Open a phone's **Manage** page. Under **Allowed people**, add someone and set:

- **Can call the phone** — they may ring it.
- **Phone can call them** — the phone may ring them.
- **Rings during quiet hours** — they get through even during quiet hours (for parents).

## Speed-dial keys

Still on **Manage**, assign people to keys **1–9** and **0**. The names appear on the phone's
screen when the handset is lifted; **Print key labels** also prints them for relegendable
keycaps. More than ten people? **Add page** gives ten more keys: on the phone, **BACK** turns
to them with the handset up (see [More than ten people](/how-to/using-the-phone/#more-than-ten-people)).
Every key follows the same list and quiet hours, whatever page it's on.

## People from other households or servers

Grandparents with their own household, or friends on another server, can be on a kid's phone
too — through **your** connections (buddies). First connect with them under **Connections**
(knock on their address, or accept their knock). Then, on the phone's **Manage** page, choose them
under **Add someone you're connected with** and set the same three switches. They then see the
phone in their own app and can call it; if you disconnect, they're off the list. A kid's phone
itself never has an address, so nobody can knock on it.

## Quiet hours

Open **Quiet hours** and add windows, for example school nights 20:30–07:00 or school hours.
Windows can run past midnight, and the times are in your household's time zone (change it under
**Settings** if you move; the phones follow straight away). During quiet hours:

- the phone doesn't ring — approved callers go straight to its greeting and can **leave a
  voicemail**, which guardians get with a transcript (see [Voicemail & greetings](/how-to/voicemail/));
- the phone can't call out, except to people marked *rings during quiet hours*;
- the phone shows when quiet hours end, and any missed callers.

## What your child sees

The phone keeps things simple and honest, so a child always knows what happened:

- **Lifting the handset** shows who is on each key. A key with nobody on it shows a dash. With
  more than one page of people, the bottom line says `PAGE 1/2 - BACK: NEXT PAGE`.
- **A missed call** shows the caller's name with `ASK A GROWN-UP`: the message waits for you in
  the app, with a transcript, and the reminder clears once you've heard it.
- **A call that doesn't go through** says why: `BUSY`, `NO ANSWER`, `NOT ALLOWED`, or
  `QUIET TIL 07:00` during quiet hours.
- **The light** breathes slowly when there's something waiting, and the screen says whose phone
  it is: `KIDS: SMITHS`.

## Rules that always apply to kids' phones

Whatever else you set, a kids' phone:

- **has no address**, so nobody can knock on it or find it;
- **only rings for people a guardian allowed**, and only calls the people you allowed it to;
- **can never call a [public line](/how-to/workplace-phone-system/)** (businesses' open lines);
- **is never recorded**, even in a call with a space that records calls;
- **can't change its own settings**: the Network menu asks twice, and moving it to another
  server or family means a guardian removes and re-pairs it.

## Voicemail for kids' phones

When an allowed caller isn't answered (or it's quiet hours), they hear the phone's greeting and
can leave a message. You decide on the phone's **Manage** page how long it rings first and what
the greeting says, recorded in the app (see [Voicemail & greetings](/how-to/voicemail/)).

The phone never records your child: no voicemail from it when a call isn't answered, no greeting
recorded on it, and no call recording.

## See who called

The phone's **Manage** page has **Call activity**, for guardians only: every call to and from the
phone, newest first, with when, who and how long. Calls that didn't go through say why, in plain
words: "Dad tried to call · Not on the phone's list", "Tried to call Grandma · Quiet hours",
"Missed call from Mom · left a voicemail". **Show older** goes further back, as far as your
household keeps its call history (**Settings → Privacy**). Nothing that was said is in it.

## When the phone's firmware changes

A hardware phone tells the server which firmware it runs. When a kids' phone starts running
firmware that isn't an official update (say your child built and flashed their own version), you
get a notice in the app straight away: "Mia's phone is running new firmware: built at home,
'mia-snake 2', today 4:12 PM." It's a good moment to ask them what they made. Official updates
don't alert you; they're listed under **Settings → Changes**, with every other firmware change.

The phone's **Manage** page shows the firmware it runs now, whether it's an official update or
built at home, and since when. **Ask me first** (on unless you turn it off) makes a kids' phone
wait for you after firmware that isn't an official update:

- the phone shows `ASK A GROWN-UP`;
- nobody can call it (callers can leave a message), and it can call only its grown-ups;
- it stays like that until you tap **Allow** on its Manage page, or **Remove and wipe** it.

**What it can't promise.** The phone reports its own firmware. Firmware someone writes
themselves can claim to be anything, including an official update, so this notices honest
changes, not someone set on hiding one. Only Secure Boot, where the chip runs nothing but signed
firmware, could rule that out; a "Locked" option built on it is planned. The details are in the
[security model](https://github.com/Open-Lounge-Phone/open-lounge-phone/blob/main/docs/security-model.md#firmware-changes).

## A daily check-in for someone you look after

For a grandparent or anyone living alone, the [labs firmware](/extend/labs/) adds a daily
**check-in**: one key says "I'm OK", and if nobody presses it by a set time, every guardian gets
an alert in their voicemail. See [Ideas for grandparents and elders](/uses/grandparents/).
