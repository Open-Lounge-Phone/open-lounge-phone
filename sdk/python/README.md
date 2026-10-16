# The add-on bridge (Python)

`openloungephone-addon` (import `olp_addon`) lets a service take part in Open Lounge Phone calls
as an **add-on**: any service that serves live voice over a call (an assistant, a radio, a notes
taker), linked by a person to their own account. The bridge does the linking, the key and the signed challenge, and the WebRTC call; your
code gets events and plain PCM audio.

Licensed **Apache-2.0** (see `LICENSE`), so any service can use it. The rest of Open Lounge Phone
is AGPL-3.0-or-later; this directory is the exception.

What an add-on is, who may reach it and how it's labelled: [docs/add-ons.md](../../docs/add-ons.md).
The server must have add-ons turned on (`ADDONS=on` when self-hosting, `--addons` on Cloudflare).

## Install

Python 3.10 or newer.

```sh
python3 -m venv .venv
.venv/bin/pip install -e .          # from this directory (aiortc, websockets, cryptography)
```

aiortc and PyAV usually install from prebuilt wheels. If pip has to build PyAV from source on
your platform, it needs FFmpeg's development libraries first.

## Use

```python
import asyncio
from olp_addon import Addon

addon = Addon("https://hub.example", "echo.addon-key")   # makes the key on first use (mode 600)
addon.set_about(summary="Plays back what you say.", hears="live", keys=True)   # its page in the app

@addon.on_call
async def talk(call):
    print("call from", call.caller.name, call.caller.address)   # verified by the server
    await call.answer()
    async for frame in call.frames():   # 20 ms of 16-bit mono PCM at 48 kHz
        await call.send(frame)           # say something back (here: an echo)

asyncio.run(addon.run())   # links first (prints a 6-digit code), then takes calls
```

The first run prints a code. Its owner types it into the companion app under **Add-ons → Link an
add-on** and picks its name (the part after `+`). From then on the add-on
answers a signed challenge on every connection; no one's password or session is ever stored in
it. Only its owner calls it at its own address; others reach it only through a share (below).

## Saying what it does

```python
addon.set_about(
    summary="Plays the station.",   # one plain sentence (up to 140 characters)
    hears="nothing",                # "nothing" (one-way), "live" (keeps nothing) or "keeps"
    transcribes=False,
    answers=True,                   # people can call it
    calls=False,                    # it never calls anyone
    shares=True,                    # it offers shares (default: whether it set any)
    keys=False,                     # no keypad
    lines=10,                       # calls at once (the server allows at most 10)
)
```

Its page in the app shows this in plain words. The server holds it to `answers`, `calls`,
`shares`, `keys` and `lines` (a call beyond `lines` is busy; `addon.call` raises `AddonError`
when it said `calls=False`); `summary`, `hears` and `transcribes` are shown as its own words. It
is sent after every connection, only to servers that take it (`addon-about`). An add-on that
never says keeps the older rules: it can be called, may call, may offer shares, gets keys, one
call at a time.

**Examples:** `examples/echo.py` (plays back what it hears) and `examples/radio.py` (one-way: it
plays a tune to several callers at once and never reads what they say).

## Limits

The server treats every add-on as untrusted code ([security-model.md](../../docs/security-model.md#add-ons)).
By default an add-on places one call at a time, at most 10 an hour and 6 a day to any one person;
one person calls one add-on at most 30 times an hour; a call with an add-on lasts at most 4
hours; it may send 600 messages a minute, its share list 60 times an hour, and connect 120 times
an hour. Over a limit, a call ends `denied` with a plain note (`call.reason`), and too many
messages close the connection (the bridge reconnects with backoff).

## Sharing

An add-on decides what of itself can be shared, such as one shared project. Its owner decides who
gets each share, and the server enforces it: a share has its own address,
`handle+name+share@host`, and only the people holding it get through.

```python
addon.set_shares([{"id": "bookclub", "label": "Book club"}])   # sent now and after reconnects

@addon.on_call
async def talk(call):
    if call.share is None:
        ...  # its owner: everything
    else:
        ...  # call.share.id, .label, .grant_id: stay inside that share

@addon.on_share_request          # the owner's "Ask it for a new share…" in the app
async def make(req):             # req.label, req.by, req.with_ (addresses)
    project = await create_project(req.label, members=req.with_)   # yours
    return project.slug           # the new share's id; or raise ShareRefused("why")

await addon.call("ana@hub.example", share="bookclub")   # someone holding it; they see the share
```

The server can't see inside the add-on: keeping a shared call inside its share is the add-on's
job, best enforced by its own permissions (for example, a token limited to that one project), not
only by instructions to a model. Code written before shares keeps working: it sends no shares,
and only its owner reaches it.

## API

`Addon(server_url, key_path, *, rate=48000, about=None)`
: One add-on on one server. `about`: the same fields as `set_about`. `key_path` is its Ed25519 key (PEM; made if missing, mode 600). The
  link is kept in `<key_path>.json` (mode 600). `rate` is the PCM sample rate both ways (8000,
  16000, 24000 or 48000 are typical).

`await addon.link(on_code=print) -> str`
: Asks for a code, gives it to `on_code(code)` or `on_code(code, expires_at)` (`expires_at`: when
  the code stops working, in ms since the Unix epoch, for a countdown), waits until the owner
  enters it, saves the link and answers the add-on's id. `addon.linked` says whether it's linked.

`@addon.on_call` / `addon.on_call(handler)`
: `handler(call)` runs for every incoming call (ringing). Without one, calls are declined.

`await addon.run()`
: Links if needed, then stays connected (reconnects with backoff) until `stop()`. Raises
  `AddonRemoved` when the owner removes it (the link file is deleted), `AddonError` when the
  server refuses it (for example: add-ons are off on that server).

`await addon.start()` / `await addon.stop()`
: The same in the background (returns once connected).

`addon.identity`
: Once connected: `.name`, `.address` (`handle+name@host`) and `.owner` (`.name`, `.address`).

`addon.linked_to`
: Once connected, where it's linked, for its own UI: `"jesse+seat@hub.example (Jesse)"` (the
  address's host is the server it's linked on). It's also logged when it connects.

`addon.online` / `@addon.on_status`
: `online` is True while it's connected and signed in. `handler(online)` runs with True when it
  signs in and False when the connection drops (it then reconnects by itself).

`await addon.call(address, share=None) -> Call`
: Calls its owner (`handle@host`), or, with `share` (an id), someone holding that share. Returns
  once the server answers: `call.state` is `ringing`, or `ended` with `call.reason`
  (`unavailable` when they may not be called). The add-on sends the WebRTC offer when the call
  connects.

`addon.set_about(hears, *, summary, transcribes, answers, calls, shares, keys, lines)`
: What it does (above). Sent now if connected, and after every reconnect.

`addon.set_shares([{"id", "label"}])` / `addon.shares`
: What it offers for sharing. Ids are 1–30 of `a-z`, `0-9` and `-` (the part after the second
  `+` of the share's address); labels 1–40 characters. Replaces the list: a share left out is
  gone, with everyone its owner gave it to (their calls into it end). Sent at once when
  connected, and again after every reconnect; nothing is sent until it's first called.

`@addon.on_share_request` / `addon.on_share_request(handler)`
: `handler(request)` (sync or async) for its owner's "Ask it for a new share…": `request.label`,
  `request.by` (the owner's address), `request.with_` (addresses), `request.request_id`. Make the
  scope and return its share id; the bridge adds `{id, label}` to `shares` if needed, tells the
  server, and the server gives it to those people. Raise `ShareRefused(reason)` (or return None)
  to say no. Without a handler, requests are refused. An unanswered request lapses after a
  minute.

`@addon.on_test` / `addon.on_test(handler)`
: Test connection (its owner, or someone holding a share, presses it in the app): the bridge
  answers the server's `addon.test` by itself at once with its `fw` version, how long it has been
  up and how many calls it's on. The optional `handler()` (sync or async) runs first, to check
  what the add-on itself needs (its model, its storage): return a dict to change `version`,
  `uptime_s` or `calls`, or raise to not answer, so the test says it didn't answer in 5 s.

`Call`
: - `call.caller`: who is calling (`.address`, `.name`), checked by their server.
  - `call.share`: the `Share` (`.id`, `.label`, `.grant_id`) the call came in through, or
    None when its owner calls its own address (incoming; `.grant_id` is `owner` when its owner
    calls within a share); the share named in `addon.call` (outgoing).
  - `call.callee`: the address it dialled (outgoing calls).
  - `call.direction` (`"in"`/`"out"`), `call.state` (`ringing`, `connecting`, `active`, `ended`),
    `call.reason` once ended.
  - `await call.answer()`, `await call.hangup()`.
  - `async for frame in call.frames()`: what the other person says, 20 ms frames of 16-bit mono
    PCM at `rate`, until the call ends.
  - `await call.send(pcm)`: play 16-bit mono PCM at `rate` (any length; it waits when more than
    about a second is queued). `call.clear()` drops what hasn't played.
  - `call.on_key = fn`: a key the other person pressed (`0`–`9`, `*`, `#`, from the app's keypad).
  - `call.on_hangup = fn`: called with the reason when the call ends; or `await call.wait_ended()`.
  - `await call.wait_active()`: until audio flows.

Audio is converted for you: apps send Opus, hardware phones PCMU (8 kHz); the bridge resamples
to and from `rate`.

## Demo

`examples/echo.py` plays back what it hears, half a second later. `#` on the app's keypad makes
it hang up.

```sh
.venv/bin/python examples/echo.py --server http://localhost:8787 --key echo.addon-key
.venv/bin/python examples/echo.py --server http://localhost:8787 --key echo.addon-key --call you@localhost:8787
.venv/bin/python examples/echo.py --server http://localhost:8787 --key echo.addon-key --share bookclub:"Book club"
```

With `--share` it offers that share; "Ask it for a new share…" in the app makes a new one named
after what you typed.

## Tests

```sh
.venv/bin/python -m unittest discover -s tests -v
```

The end-to-end test (a local server, this echo add-on, and the companion app in headless
Chromium) lives with the repository's other live tests:
`OLP_ADDON_E2E=1 PLAYWRIGHT_CORE=… npx vitest run tests/e2e/live/addon.test.ts`.

## The protocol underneath

An add-on speaks the same device protocol as a phone ([docs/protocol.md](../../docs/protocol.md)):
`hello` (`model: "addon"`), `pair.begin` (`kind: "addon"`), `auth.challenge`/`auth.proof`,
`config` (with `addon`), `call.ringing` (with the verified caller), `call.answer`,
`call.hangup`, `call.address`, `call.key`, `rtc.config`, `rtc.sdp`, `rtc.ice`. Anyone may write
an add-on in another language from that description.
