# The add-on bridge (Python)

`openloungephone-addon` (import `olp_addon`) lets a service take part in Open Lounge Phone calls
as an **add-on**: something a person links to their own account, like an AI companion or a notes
taker. The bridge does the linking, the key and the signed challenge, and the WebRTC call; your
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

addon = Addon("https://hub.example", "seat.addon-key")   # makes the key on first use (mode 600)

@addon.on_call
async def talk(call):
    print("call from", call.caller.name, call.caller.address)   # verified by the server
    await call.answer()
    async for frame in call.frames():   # 20 ms of 16-bit mono PCM at 48 kHz
        await call.send(frame)           # say something back (here: an echo)

asyncio.run(addon.run())   # links first (prints a 6-digit code), then takes calls
```

The first run prints a code. Its owner types it into the companion app under **Settings →
Add-ons → Link an add-on** and picks its name (the part after `+`). From then on the add-on
answers a signed challenge on every connection; no one's password or session is ever stored in
it. Only its owner calls it at its own address; others reach it only through a share (below).

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

`Addon(server_url, key_path, *, rate=48000)`
: One add-on on one server. `key_path` is its Ed25519 key (PEM; made if missing, mode 600). The
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

`addon.online` / `@addon.on_status`
: `online` is True while it's connected and signed in. `handler(online)` runs with True when it
  signs in and False when the connection drops (it then reconnects by itself).

`await addon.call(address, share=None) -> Call`
: Calls its owner (`handle@host`), or, with `share` (an id), someone holding that share. Returns
  once the server answers: `call.state` is `ringing`, or `ended` with `call.reason`
  (`unavailable` when they may not be called). The add-on sends the WebRTC offer when the call
  connects.

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

`Call`
: - `call.caller`: who is calling (`.address`, `.name`), checked by their server.
  - `call.share`: the `Share` (`.id`, `.label`, `.grant_id`) the call came in through, or
    None when its owner is calling (incoming); the share named in `addon.call` (outgoing).
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
