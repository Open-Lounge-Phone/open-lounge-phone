"""An echo add-on: it plays back what it hears, half a second later.

    python examples/echo.py --server https://hub.example --key echo.addon-key
    python examples/echo.py --server https://hub.example --key echo.addon-key --call you@hub.example

The first run prints a 6-digit code: enter it in the companion app (Settings → Add-ons → Link an
add-on). Then call it from the app, or from your own phone's key. Press # on the app's keypad to
make it hang up. With --call it calls that address (you, or a connection you allowed) once
it's connected.
"""

from __future__ import annotations

import argparse
import asyncio
import logging
import math
import struct
from collections import deque

from olp_addon import Addon, Call, frame_bytes

DELAY_S = 0.5


def level(frame: bytes) -> float:
    """RMS of a 16-bit frame, 0..1."""
    n = len(frame) // 2
    if not n:
        return 0.0
    samples = struct.unpack(f"<{n}h", frame[: n * 2])
    return math.sqrt(sum(x * x for x in samples) / n) / 32768


async def echo(call: Call, rate: int) -> None:
    """Plays everything back after DELAY_S, until the call ends."""
    delay: deque[bytes] = deque()
    frames = int(DELAY_S * 1000 / 20)
    heard = 0
    async for frame in call.frames():
        heard += 1
        if heard % 50 == 0:
            print(f"heard {heard} frames, level {level(frame):.3f}", flush=True)
        delay.append(frame)
        if len(delay) > frames:
            await call.send(delay.popleft())
    print(f"call ended ({call.reason}) after {heard} frames", flush=True)


async def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawTextHelpFormatter)
    ap.add_argument("--server", required=True, help="the server, e.g. https://hub.example")
    ap.add_argument("--key", default="echo.addon-key", help="its key file (made on first run)")
    ap.add_argument("--rate", type=int, default=48_000, help="PCM sample rate (default 48000)")
    ap.add_argument("--call", help="call this address once connected")
    ap.add_argument("-v", "--verbose", action="store_true")
    args = ap.parse_args()
    logging.basicConfig(level=logging.DEBUG if args.verbose else logging.WARNING)

    addon = Addon(args.server, args.key, rate=args.rate)
    assert frame_bytes(args.rate) > 0

    @addon.on_call
    async def answer(call: Call) -> None:
        who = call.caller
        print(f"call from {who.name} <{who.address}>" if who else "call", flush=True)
        call.on_key = lambda key: print(f"key {key}", flush=True) or (
            asyncio.ensure_future(call.hangup()) if key == "#" else None
        )
        await call.answer()
        await echo(call, args.rate)

    if not addon.linked:
        await addon.link()
        print("linked", flush=True)
    await addon.start()
    ident = addon.identity
    print(f"ready {ident.address if ident else addon.device_id}", flush=True)
    if args.call:
        call = await addon.call(args.call)
        print(f"calling {args.call}: {call.state}", flush=True)
        if not call.ended:
            await echo(call, args.rate)
    await asyncio.Event().wait()  # until interrupted


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
