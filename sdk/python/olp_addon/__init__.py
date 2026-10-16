"""The Open Lounge Phone add-on bridge: link a service to someone's account and take calls.

    from olp_addon import Addon

    addon = Addon("https://hub.example", "seat.addon-key")

    @addon.on_call
    async def talk(call):
        print("call from", call.caller.name, call.caller.address)
        await call.answer()
        async for frame in call.frames():   # 20 ms of 16-bit mono PCM at 48 kHz
            await call.send(frame)           # an echo

    asyncio.run(addon.run())                 # links first (prints a code), then takes calls

See README.md and docs/add-ons.md. Apache-2.0.
"""

from .addon import Addon, AddonError, AddonRemoved, ShareRefused
from .audio import FRAME_MS, Resampler, frame_bytes
from .call import Call, CallEnded
from .keys import AddonKey
from .protocol import Identity, Party, Share, ShareRequest

__all__ = [
    "Addon",
    "AddonError",
    "AddonKey",
    "AddonRemoved",
    "Call",
    "CallEnded",
    "FRAME_MS",
    "Identity",
    "Party",
    "Resampler",
    "Share",
    "ShareRefused",
    "ShareRequest",
    "frame_bytes",
]
__version__ = "0.4.0"
