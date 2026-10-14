# Add-ons: services you can call (planned)

> **Status: planned.** Nothing here is built yet. This is the design that add-ons will follow.

A phone call is a handset with a microphone and a speaker. Anyone could already wire a computer to
a handset and put a program on the line. An **add-on** makes that a supported, optional part of
your account: a service (an AI you think out loud with, a notes taker, a radio, a doorbell) gets
an address on your account and joins calls like a phone does.

Add-ons are not part of the default phone. A server offers them only if its operator turns them
on, and a person uses one only by linking it to their own account. People who link an add-on
choose it knowingly. Most are programs that listen and transcribe, so the phones don't add a
spoken warning; they show a label.

The first add-on is an AI companion (Thinking Room's Seat). Nothing in the design is specific to
it.

## What an add-on is

- **An endpoint on your account.** Linking one gives it an address that is part of your account,
  such as `jesse+seat@hub.example`. Nothing separate to sign up for or manage. Removing it from your
  account revokes it at once.
- **Reachable only by people you choose.** By default only you can call it and only you can be
  called by it. You can allow some of your connections too, and only them. Nobody can knock on an
  add-on, it never appears in a directory, and kids' phones can't reach one.
- **Told who's speaking.** Every call tells the add-on the verified caller: their address and
  name, checked by the caller's server. It can greet people by name and keep separate memories per
  person.
- **Labelled.** Apps and phones show the add-on's name with an add-on label, e.g. `SEAT · ADD-ON`.

## How an add-on connects: it's a phone

An add-on speaks the same device protocol as a phone (`docs/protocol.md`), so there's one way to
be on a call, not two:

1. **Link.** The add-on opens a WebSocket to the server and sends `hello` and `pair.begin` with
   `kind: "addon"` and its public key (Ed25519). It shows the 6-digit code it gets back.
2. **Claim.** You enter the code in the companion app (**Settings → Add-ons → Link an add-on**),
   choose its name (the part after `+`) and who may talk to it. Like pairing a phone.
3. **Every connection** answers a signed challenge with its key. No person's session token is
   ever stored in the add-on.
4. **Calls** work as on a phone:
   - it gets `call.ringing` (with the verified caller) and answers with `call.answer`;
   - it places calls with `call.address` to you or an allowed connection;
   - audio is WebRTC (`rtc.*`), peer to peer, Opus from apps and PCMU from hardware phones.

What changes on the server (all additive):

- Device mode `addon` next to `kids`, `personal` and `lounge`, with its sub-address on the owner's
  account and its allow-list (the owner plus chosen connections).
- `call.address` for add-ons (dial the owner or an allowed connection by address). Phones keep
  their speed-dial keys.
- `call.ringing.from` carries the verified address (it already has `label` and `address?`) and,
  for an add-on, `kind: "addon"`.
- Federation: the call body says the caller or callee is an add-on (`addon: true`). A server that
  doesn't list the `addons` feature doesn't get calls from add-ons and isn't offered them.
- Server setting `ADDONS=on|off` (default off). The hub's fair-use allowance counts add-on minutes
  against the owner, and operators can turn add-ons off per account.
- An add-on can be a speed-dial key on your own phones (a personal phone, or your keys on a Lounge
  phone), so lifting the handset and pressing a key starts a conversation.
- Linking, removing and changing who may talk to an add-on go in the space's audit trail.

## The bridge: the easy way to build one

Most add-on authors don't want to write WebRTC. The project ships a small library, the
**add-on bridge** (Python, Apache-2.0, so any service can use it), that:

- does the linking, the key and the signed challenge;
- turns calls into events (`ringing(caller)`, `answered`, `hung_up`, `key(digit)`);
- turns audio into plain PCM frames in and out, at the rate the add-on asks for (e.g. 48 kHz), and
  converts to and from Opus or PCMU for the call;
- places calls (`call(address)`).

A minimal add-on is a loop: frames in → speech to text → your logic → text to speech → frames out.
The bridge comes with a demo add-on (an echo and a talking clock) and an end-to-end test where the
companion app calls it.

## Example: a thinking room

The Seat uses the bridge in a voice worker next to its own servers:

- In the Seat, **Connect a phone** shows a code. You type it into your companion, and your account
  gains `you+seat@your-server`.
- Lift your desk phone's handset, press the Seat's key, and talk. The Seat hears you through the
  bridge, answers with its own voice, and files the conversation where it always does.
- The Seat can call you too, for a check-in at the time you planned.
- Someone you allow (a co-founder, a coach) can call your Seat as well; it knows it's them.

The same pattern fits a dedicated "thinking room" phone whose only key is the Seat, or a
conversation with yourself that feels more natural than typing.

## Planned phases

1. Server: device mode `addon`, sub-addresses, allow-lists, `call.address`, labels, the federation
   flag and feature, `ADDONS`, fair use, audit; companion **Settings → Add-ons**. Tests.
2. The bridge (Python) with the demo add-on and an end-to-end test.
3. Thinking Room's Seat on the bridge (in its own repository).
4. Later, if wanted: add-ons that receive voicemail or send notices.
