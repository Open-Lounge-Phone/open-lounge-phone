# Add-ons: services you can call

A phone call is a handset with a microphone and a speaker. Anyone could already wire a computer to
a handset and put a program on the line. An **add-on** makes that a supported, optional part of
your account: a service (an AI you think out loud with, a notes taker, a radio, a doorbell) gets
an address on your account and joins calls like a phone does.

Add-ons are not part of the default phone. A server offers them only if its operator turns them
on, and a person uses one only by linking it to their own account. People who link an add-on
choose it knowingly. Most are programs that listen and transcribe, so the phones don't add a
spoken warning; they show a label.

The first add-on planned is an AI companion (Thinking Room's Seat). Nothing here is specific to
it.

## What an add-on is

- **An endpoint on your account.** Linking one gives it an address that is part of your account,
  such as `jesse+seat@hub.example`. Nothing separate to sign up for or manage. Removing it from
  your account revokes it at once.
- **Reachable only by people you choose.** By default only you can call it and only you can be
  called by it. You can allow some of your connections too, and only them. Nobody can knock on an
  add-on, it never appears in a directory, and kids' phones can't reach one.
- **Told who's speaking.** Every call tells the add-on the verified caller: their address and
  name, checked by their server. It can greet people by name and keep separate memories per
  person.
- **Labelled.** Apps show the name with an "add-on" badge; phones show `SEAT · ADD-ON` (the
  hardware phone's font writes `SEAT - ADD-ON`) when it fits, or the name and `ADD-ON CALLING`.

## Turning add-ons on (operators)

Off by default. Self-hosted: `ADDONS=on` ([self-hosting.md](self-hosting.md)). Cloudflare:
`scripts/deploy.ts --addons` or `npx openloungephone deploy cloudflare --addons`
([cloudflare.md](cloudflare.md)); every deploy sets it, so leaving the flag out turns them off.

While add-ons are off, nobody can link one ("This server doesn't offer add-ons. Its operator can
turn them on."), add-ons linked earlier can't connect or be called (the app says so), and the
server doesn't list the `addons` feature, so other servers never offer it add-on calls.

## Using one

1. **Link.** Start linking in the add-on; it shows a 6-digit code. In the companion app open
   **Settings → Add-ons → Link an add-on**, type the code, choose its name (the part after `+`:
   2 to 30 letters, digits, dots, dashes or underscores) and who besides you may talk to it (any
   of your connections). It's linked in the space you're in.
2. **Call it** from the add-on's **Call** button, or put its address on a key of your own phone
   (the phone's page → **Public lines and add-ons**, then choose that key; your keys at a Lounge
   phone come from your phone, so it's there too). A connection you allowed calls it under **Connections → Call an add-on**, on
   this server or another one.
3. **It calls you** (or a connection you allowed), for a check-in it planned, say. It rings
   wherever you can be rung: your apps, your own phones, a Lounge phone you're signed in at.
4. **Manage it** in the same place: its address with **Copy**, whether it's online now (as the
   server reports it), **Who may talk to it**, and **Remove** (it's cut off at once and told to
   forget its link).

A call with an add-on is one to one: no Add caller, no Transfer. The app shows a **Keypad**
during the call; the add-on hears the keys ("press 1 to…"). Calls to and from an add-on don't go
to voicemail.

**Fair use:** an add-on's call minutes count against its owner's allowance, whoever placed the
call ([hub.md](hub.md)). **Audit:** linking, changes to who may talk to it and removing it go in
the space's audit trail (names and counts, never content). The rules in full:
[security-model.md](security-model.md#add-ons).

## Building one

The easy way is the **add-on bridge** ([sdk/python](../sdk/python/README.md), Python 3.10+,
**Apache-2.0**, so any service can use it; the rest of Open Lounge Phone is AGPL). It does the
linking, the key and the signed challenge, reconnects, and turns calls into events and plain PCM:

```python
import asyncio
from olp_addon import Addon

addon = Addon("https://hub.example", "seat.addon-key")   # its Ed25519 key, made on first use

@addon.on_call
async def talk(call):
    print("call from", call.caller.name, call.caller.address)   # verified by the server
    call.on_key = lambda key: print("pressed", key)
    await call.answer()
    async for frame in call.frames():   # 20 ms of 16-bit mono PCM, 48 kHz by default
        await call.send(frame)           # here: an echo; in a real add-on, its voice

asyncio.run(addon.run())   # prints the link code the first time, then takes calls
```

- `Addon(server_url, key_path, *, rate=48000)`: the key file is made with mode 600; the link is
  kept next to it (`<key_path>.json`). `rate` is the PCM rate both ways.
- `await addon.link(on_code=print)`: shows the code (`on_code(code, expires_at)` also gets when
  it stops working), waits for its owner, saves the link.
- `addon.online` and `@addon.on_status`: whether it's connected now, and a handler for changes.
- `@addon.on_call`: gets each ringing `Call`. `await addon.run()` (or `start()`/`stop()`) stays
  connected; it raises `AddonRemoved` when its owner removes it.
- `await addon.call(address) -> Call`: calls its owner or an allowed connection (`call.state` is
  `ringing`, or `ended` with `call.reason`).
- `Call`: `.caller` (`.address`, `.name`), `.callee`, `.state`, `.reason`, `await answer()`,
  `await hangup()`, `frames()`, `await send(pcm)`, `clear()`, `on_key`, `on_hangup`,
  `await wait_active()`, `await wait_ended()`.
- Audio is converted for you: apps send Opus, hardware phones PCMU; the bridge resamples.

A minimal add-on is a loop: frames in → speech to text → your logic → text to speech → frames
out. The bridge's demo, `examples/echo.py`, plays back what it hears half a second later (`#`
hangs up). An end-to-end test links it through the companion in a browser and calls it both ways
with real audio (`tests/e2e/live/addon.test.ts`, opt-in).

### The protocol, for other languages

An add-on speaks the device protocol of a phone ([protocol.md](protocol.md)) over
`wss://<server>/ws/device` (`?device=<id>` once linked). Its address is `handle+name@host`:
`handle` is its owner's current handle (it follows a handle change), `name` the part after `+`,
`host` the server (with a port if it has one).

Linking:

```json
→ {"t":"hello","proto":1,"model":"addon","fw":"my-addon/1.0","buttons":1,"display":"none"}
→ {"t":"pair.begin","kind":"addon","alg":"ed25519","publicKey":"<raw 32-byte key, base64url>"}
← {"t":"pair.code","code":"123456","expiresAt":1790000000000}
← {"t":"pair.done","deviceId":"ao_…","householdId":"hh_…"}
```

Every connection after that (`/ws/device?device=ao_…`):

```json
→ {"t":"hello","proto":1,"model":"addon","fw":"my-addon/1.0","buttons":1,"display":"none","deviceId":"ao_…"}
← {"t":"auth.challenge","nonce":"<32 bytes, base64url>"}
→ {"t":"auth.proof","sig":"<Ed25519 signature over the raw nonce bytes, base64url>"}
← {"t":"config","buttons":[],"quiet":false,"now":1790000000000,"server":{…,"features":[…,"addons"]},
   "addon":{"name":"seat","address":"jesse+seat@hub.example",
            "owner":{"name":"Jesse","address":"jesse@hub.example"}}}
```

A call to it:

```json
← {"t":"call.ringing","callId":"call_…","from":{"label":"Bob","address":"bob@other.example"}}
→ {"t":"call.answer","callId":"call_…"}
← {"t":"rtc.config","callId":"call_…","iceServers":[…]}
← {"t":"call.state","callId":"call_…","state":"connecting"}
← {"t":"rtc.sdp","callId":"call_…","type":"offer","sdp":"…"}        the caller offers
→ {"t":"rtc.sdp","callId":"call_…","type":"answer","sdp":"…"}
↔ {"t":"rtc.ice","callId":"call_…","candidate":"candidate:…","sdpMid":"0","sdpMLineIndex":0}
← {"t":"call.state","callId":"call_…","state":"active"}
← {"t":"call.key","callId":"call_…","key":"5"}                       a key on the app's keypad
→ {"t":"call.hangup","callId":"call_…"}   or   ← {"t":"call.state",…,"state":"ended","reason":"hangup"}
```

A call from it (people only: its owner, or a connection on its list, by address):

```json
→ {"t":"call.address","address":"jesse@hub.example"}
← {"t":"call.state","callId":"call_…","state":"ringing"}             or "ended" with a reason
← {"t":"rtc.config",…}  ← {"t":"call.state",…,"state":"connecting"}  once answered
→ {"t":"rtc.sdp","callId":"call_…","type":"offer","sdp":"…"}         it places the call: it offers
← {"t":"rtc.sdp","callId":"call_…","type":"answer","sdp":"…"}
```

The people it calls see `call.ringing` with `from: {"label":"seat","address":"jesse+seat@hub.example","kind":"addon"}`.

Other rules: `{"t":"ping"}` → `{"t":"pong"}` keeps the socket open (every 25 s or so). An add-on
may send only `ping`, `call.address`, `call.answer`, `call.hangup`, `rtc.sdp` and `rtc.ice`
(without `peer`); anything else is answered with an `error`. One call at a time: a second call
to it while it's on one gets `busy`. Every refusal of a call to or from it — unknown, not
allowed, add-ons off — ends `unavailable` (or `denied` with a `note`, for fair use). Removed by
its owner, it gets `{"t":"wipe","reason":"removed"}` and the socket closes; it should forget its
id. With add-ons off, the server answers its `hello` or `pair.begin` with
`{"t":"error","code":"unauthorized","message":"This server doesn't offer add-ons. Its operator can turn them on."}`
and closes.

### Across servers

Calls to and from add-ons on other servers use the federation feature `addons`
([federation-spec.md](federation-spec.md)): the `addon` call target
(`{"kind":"addon","handle":"jesse","name":"seat"}`) and, for a call from an add-on, `CallBody.addon`
(its name; `from` is its owner and `to` must be a person). The add-on's server checks the
connection and the list; a call through a kids' phone or a guest is refused, and a server that
doesn't list `addons` is never offered add-on calls (the caller hears "That server doesn't take
add-on calls"). Keys travel as `call.key` on the server-pair stream.

### The app's side (HTTP)

`GET /api/addons` (yours, with `online` as the server sees it, and whether the server offers
add-ons), `POST /api/addons/link {code, name, allow}`, `PUT /api/addons/:id/allow {connections}`,
`DELETE /api/addons/:id`. Apps call one with `call.address` and send keys with `call.key`.

## Example: a thinking room

The Seat will use the bridge in a voice worker next to its own servers:

- In the Seat, **Connect a phone** shows a code. You type it into your companion, and your account
  gains `you+seat@your-server`.
- Lift your desk phone's handset, press the Seat's key, and talk. The Seat hears you through the
  bridge, answers with its own voice, and files the conversation where it always does.
- The Seat can call you too, for a check-in at the time you planned.
- Someone you share a project with (a co-founder, a coach) calls that project's address, and the
  Seat works only inside that shared project; it knows it's them.

The same pattern fits a dedicated "thinking room" phone whose only key is the Seat, or a
conversation with yourself that feels more natural than typing.

## Sharing (planned)

> **Status: planned** (server 0.7.x). Today an add-on can be reached by its owner and by the
> connections on its allow-list. The design below replaces that allow-list.

An add-on is personal by default: only its owner can call it at its address. Sharing is
something the **add-on defines**: it says which parts of itself can be shared. Open Lounge Phone
decides **who** gets each part and enforces it. A private assistant can't be opened up to
several people as a whole. Only the pieces it offers can be shared, such as one shared project.

**Shares.**
- After connecting, the add-on sends the list of what it offers: `addon.shares {shares: [{id,
  label}]}`, e.g. `{id: "bookclub", label: "Book club"}`. It replaces the previous list. The
  `id` is 1–30 of `[a-z0-9-]`.
- A share's only power today is **calls into that scope**; later shares may carry actions too
  (see Phases).

**Each share has its own address:** `handle+addon+share@host`, e.g.
`jesse+seat+bookclub@hub.openloungephone.app`.
- A key on Ana's phone dials straight into the Book club project, with no mix-ups.
- The plain add-on address (`jesse+seat@…`) stays the owner's alone.

**Granting.**
- On the add-on's card (Settings → Add-ons, and People), the owner gives a share to people: their
  connections, or people in their spaces, here or on other servers.
- The server stores the grants and refuses any call to a share address from someone without
  one (`unavailable`, as for every refusal).
- Revoking a grant, or the add-on dropping a share, takes effect at once and ends that person's
  calls into it.

**What the add-on is told.**
- A call that came in through a share carries it: `call.ringing {from: {label, address},
  share: {id, label}}`.
- A call without `share` is from the owner.
- The add-on must keep the conversation inside that scope (in the Seat: read and write only that
  shared project). The server can't see inside the add-on, so this part is the add-on's job.
  The server's job is that nobody without a grant gets in.

**New shared projects from the hub.**
- The owner can ask from the card: **New shared project with…** (name, people). The server sends
  `addon.share.request {requestId, label, with: [addresses]}`.
- The add-on creates the scope, sends its updated `addon.shares`, and answers
  `addon.share.created {requestId, id}`.
- The server then grants it to those people. The owner started it, so no second confirmation is
  needed.
- An add-on may also refuse with `addon.share.refused {requestId, reason}`.

**Calling out within a share.** `call.address {address, share?}`: the add-on may call its owner,
or a person who holds that share, with the share named. The callee sees e.g.
`SEAT · BOOK CLUB`.

**Who sees what (People tab).**
- The owner sees their add-ons with their shares and who holds each.
- A person who holds a share sees it as an entry, e.g. "Jesse's Seat · Book club", with Call.
- Nobody else in the household sees a private add-on.
- Holders on another server see it on that connection (like a connection's shared phones).

**Protocol and federation:**
- additive messages `addon.shares`, `addon.share.request`, `addon.share.created`,
  `addon.share.refused`;
- `call.ringing.share`, `call.address.share`;
- the federation call target gains `share`, behind the `addon-shares` feature flag;
- servers without it can't receive share grants or calls.

**Migration:** existing allow-list entries are dropped. They granted the whole add-on, which this
design rules out, and the owner is told on the card. Shares start empty.

## Phases

1. Server, apps and phones: device mode `addon`, sub-addresses, allow-lists, `call.address`,
   labels, the federation flag and feature, `ADDONS`, fair use, audit; companion
   **Settings → Add-ons**. **Done** (server 0.6.0, unreleased; firmware 0.9.3 shows the label).
2. The bridge (Python) with the echo demo and an end-to-end test. **Done.**
3. Thinking Room's Seat on the bridge (in its own repository).
4. **Sharing** (above): add-on-defined shares, one address per share, grants and the People tab.
5. Later: shares that carry actions too (the add-on declares them, e.g. "add a task", and the hub
   shows them as buttons; the add-on does the work); add-ons that receive voicemail or send
   notices; keys from hardware phones during a call (today only the apps' keypad sends them).
