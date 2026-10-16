---
title: Add-ons
description: Link a service that talks or plays audio, like an assistant, a notes taker or a radio. It gets its own address on your account, you put it on a phone key in a tap, and you can share the parts it offers with chosen people. Build one with the Python add-on bridge.
sidebar:
  order: 1
---

A phone call is a handset with a microphone and a speaker. An **add-on** puts a service on the
line: an assistant you think out loud with, a notes taker, a radio, a doorbell. Anything that can
listen or talk can be one. You link it to your own account and it gets an address there, like
`jesse+radio@hub.example`. Then you call it from your app or your desk phone, and it can call you
if it says it does.

Add-ons are optional. A server offers them only if its operator turns them on, and nobody gets
one unless they link it themselves. The server treats every add-on as a stranger's app: it lets
it do only what it says it does, only with the people you choose.

## Link one and put it on a key

1. Start linking in the add-on. It asks for your server's address and shows a 6-digit code.
2. In the companion app, open the **Add-ons** tab and press **Link an add-on**.
3. Type the code and choose its **name** (the part after `+` in its address: 2 to 30 letters,
   digits, dots, dashes or underscores). Press **Link**.
4. Its page opens with **Put on a key** ready: your own phone and its first free key are chosen.
   Press **Put on key 1** (or pick another phone or key).
5. Lift your phone's handset and press that key.

You can also **Call** it from its page, or **Add to contacts** so it's on **Home** with a Call
button. Kids' phones never take add-ons, and the app doesn't offer them.

## Its page

The Add-ons tab lists your add-ons (with one add-on and nothing shared with you, it opens straight
on its page). Each page shows:

- whether it's **online** right now, and its address with **Copy**;
- **What it does**, in the add-on's own words: whether you can call it, whether it calls you,
  whether it offers shares, whether it listens to keys, how many calls it takes at once, and what
  it does with what it hears (nothing, listens live, or keeps it). The server holds it to what it
  says: an add-on that doesn't say it calls people can't call anyone. One that hasn't said what it
  does gets the plainest rules, and its page says so;
- its **shares**, each with **Call**, **Add to contacts**, **Put on a key** and **Give to…**;
- **Ask it for a new share…**, when it offers shares;
- **Remove**: it's cut off at once, told to forget the link, and every share of it goes. To use it
  again, link it again.

If the server doesn't offer add-ons, the app says so. Someone who runs their own server turns them
on with `ADDONS=on` ([self-hosting](/how-to/self-host/)) or `--addons`
([Cloudflare](/how-to/deploy-cloudflare/)).

## Who can reach it

- **You**, always, at its own address (`jesse+radio@hub.example`). That address is yours alone.
- **People you give a share to**, and only within that share (below).
- **Nobody else.** Nobody can knock on an add-on, it isn't in any directory, and **kids' phones
  can never reach one**. A call from anyone else ends as if the address didn't exist.

Every call tells the add-on who is calling (their address and name, checked by their server) and
which share they came through, so it can greet people by name and keep their conversations apart.

## Share part of it

An add-on can't be shared as a whole. It can offer **parts of itself** for sharing, such as one
station of a radio or one shared project of an assistant. The add-on decides what the parts are;
you decide who gets each one, and the server enforces it.

- Each part, a **share**, has **its own address**, like `jesse+radio+jazz@hub.example`.
- **Give to…** picks someone: one of your connections (on your server or another one) or someone
  in your spaces. Before you give it, the app says what the add-on will learn about them (their
  name and address when they call) and that it hears what they say.
- **Revoke** takes it back at once: a call of theirs into it ends right away.
- **Ask it for a new share…**: type a name, tick people, **Ask**. The add-on makes the new part and
  the people you ticked get it. The app tells you how it went: done, the add-on said no (and why),
  it's offline, or it didn't answer.
- If the add-on stops offering a share, everyone loses it, and their calls into it end.

## When someone shares one with you

Shares given to you are under **Add-ons → Shared with you**. Each shows what the add-on says it
does, that it learns your name and address when you call and hears what you say, and:

- **Call**, **Add to contacts**, **Put on a key** (on your own phones);
- **Stop its calls**: it can't call you any more (you can still call it). Your own server enforces
  this. **Let it call me** undoes it;
- **Give it back**: you lose the share, and its owner sees you gone.

## Calls, limits and labels

- Apps show an add-on with an **add-on** badge. Phones always mark it: `RADIO · ADD-ON`, or the
  name and `ADD-ON CALLING` when that doesn't fit. Within a share, the share's name shows with
  `ADD-ON CALLING` under it, so a share can never pass for a person.
- During a call the app has a **Keypad** when the add-on listens to keys ("press 1 for…"). A call
  with an add-on is one to one: no Add caller, no Transfer, and no voicemail.
- To keep any add-on from being a nuisance, the server limits it: how many calls it takes at once
  (one, unless it says more, up to 10), how long a call lasts (4 hours), and how often it may call
  out (10 calls an hour, 6 a day to any one person).
- Linking, sharing, giving back, share requests, limits reached and removing show up in the space's
  list of changes (**Settings → Changes**). An add-on's call minutes count toward its owner's
  fair-use allowance on servers that have one.

## Build your own

The **add-on bridge** is a small Python library (Apache-2.0, so any service can use it). It does
the linking, the key and the signed check on every connection, reconnects, and turns calls into
events and plain audio frames:

```python
import asyncio
from olp_addon import Addon

addon = Addon("https://hub.example", "radio.addon-key")
addon.set_about(summary="Plays the station you call", hears="nothing", lines=10)

@addon.on_call
async def talk(call):
    print("call from", call.caller.name, call.caller.address)
    await call.answer()
    async for frame in call.frames():   # 20 ms of 16-bit mono audio, 48 kHz by default
        await call.send(frame)           # here: an echo

asyncio.run(addon.run())   # shows the link code the first time, then takes calls
```

A real add-on is the same loop: audio in, speech to text, your logic, text to speech, audio out.
`await addon.call("you@hub.example")` places a call.

`set_about` says what it does, and the server holds it to that: an add-on that wants to call
people says `calls=True` (whether it offers shares is worked out from `set_shares`). Sharing takes three more pieces: say what can be
shared, check which share a call came through, and answer "Ask it for a new share…":

```python
from olp_addon import ShareRefused

addon.set_shares([{"id": "bookclub", "label": "Book club"}])

@addon.on_call
async def talk(call):
    if call.share:                       # call.share.id, .label, .grant_id
        ...                              # stay inside that share
    ...

@addon.on_share_request
async def make(request):                 # request.label, request.with_
    return await create_project(request.label)   # the new share's id, or raise ShareRefused("…")

await addon.call("ana@hub.example", share="bookclub")
```

Keeping a shared call inside its share is the add-on's job: the server only makes sure nobody
without the share gets in. Enforce it with the add-on's own permissions (a key or token limited to
that one project, say), not only with instructions to a model. The bridge's
[README](https://github.com/Open-Lounge-Phone/open-lounge-phone/tree/main/sdk/python) has the
whole API and an echo demo; [Add-ons (reference)](/reference/add-ons/) has the messages
underneath, for other languages.
