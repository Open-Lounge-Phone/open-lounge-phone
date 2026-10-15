"""A one-way "radio": it plays a slow tune to everyone who calls, several at once, and never
listens. It says so (`hears="nothing"`), so its page in the app tells people.

    python examples/radio.py --server https://hub.example --key radio.addon-key --lines 5

The first run prints a 6-digit code: enter it in the companion app (Add-ons → Link an add-on).
It offers one share, "Listen": give it to people on its page, and they call it at its address.
"""

from __future__ import annotations

import argparse
import asyncio
import logging
import math
import struct

from olp_addon import Addon, Call, frame_bytes

#: A slow tune: notes in Hz, a quarter of a second each.
TUNE = (392.0, 440.0, 494.0, 523.3, 494.0, 440.0)


def tone_frames(rate: int):
    """20 ms frames of the tune, forever."""
    n = frame_bytes(rate) // 2
    t = 0
    note_len = rate // 4
    while True:
        out = []
        for _ in range(n):
            hz = TUNE[(t // note_len) % len(TUNE)]
            out.append(int(6000 * math.sin(2 * math.pi * hz * t / rate)))
            t += 1
        yield struct.pack(f"<{n}h", *out)


async def play(call: Call, rate: int) -> None:
    """Sends the tune until the call ends; what the caller says is never read."""
    sent = 0
    for frame in tone_frames(rate):
        if call.ended:
            break
        await call.send(frame)
        sent += 1
        if sent % 250 == 0:
            print(f"played {sent} frames to {call.caller.name if call.caller else '?'}", flush=True)
    print(f"call ended ({call.reason}) after {sent} frames", flush=True)


async def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawTextHelpFormatter)
    ap.add_argument("--server", required=True, help="the server, e.g. https://hub.example")
    ap.add_argument("--key", default="radio.addon-key", help="its key file (made on first run)")
    ap.add_argument("--rate", type=int, default=48_000, help="PCM sample rate (default 48000)")
    ap.add_argument("--lines", type=int, default=5, help="listeners at once (the server caps it)")
    ap.add_argument("-v", "--verbose", action="store_true")
    args = ap.parse_args()
    logging.basicConfig(level=logging.DEBUG if args.verbose else logging.WARNING)

    addon = Addon(args.server, args.key, rate=args.rate)
    addon.set_shares([{"id": "listen", "label": "Listen"}])
    addon.set_about(
        summary="Plays a slow tune to everyone who calls.",
        hears="nothing",
        shares=True,
        lines=args.lines,
    )
    listeners = 0

    @addon.on_call
    async def answer(call: Call) -> None:
        nonlocal listeners
        who = call.caller
        listeners += 1
        print(f"listener {who.name if who else '?'} <{who.address if who else '?'}> ({listeners} now)", flush=True)
        try:
            await call.answer()
            await play(call, args.rate)
        finally:
            listeners -= 1

    if not addon.linked:
        await addon.link()
        print("linked", flush=True)
    await addon.start()
    ident = addon.identity
    print(f"ready {ident.address if ident else addon.device_id}", flush=True)
    await asyncio.Event().wait()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
