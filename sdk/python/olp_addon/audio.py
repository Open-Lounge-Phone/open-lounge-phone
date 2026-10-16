"""PCM in and out of a call: 16-bit mono frames at the rate the add-on asks for.

The call's codec (Opus from apps, PCMU from hardware phones) is aiortc's business: it hands us
decoded frames and encodes what we give it. Here we only resample and cut audio into 20 ms
frames.
"""

from __future__ import annotations

import asyncio
import fractions
import time

import av
from aiortc.mediastreams import MediaStreamError, MediaStreamTrack

#: What the outgoing track produces (aiortc encodes from it: Opus, or PCMU at 8 kHz).
TRACK_RATE = 48_000
FRAME_MS = 20


def frame_bytes(rate: int, ms: int = FRAME_MS) -> int:
    """Bytes in one frame of 16-bit mono PCM."""
    return rate * ms // 1000 * 2


def _pcm_of(frame: av.AudioFrame) -> bytes:
    """The samples of a packed s16 mono frame (its plane may be padded)."""
    return bytes(frame.planes[0])[: frame.samples * 2]


class Resampler:
    """Any decoded audio (or 16-bit mono PCM at `src_rate`) → 16-bit mono PCM at `rate`."""

    def __init__(self, rate: int, src_rate: int | None = None) -> None:
        self.rate = rate
        self.src_rate = src_rate
        self._av = av.AudioResampler(format="s16", layout="mono", rate=rate)
        self._pts = 0

    def frame(self, frame: av.AudioFrame) -> bytes:
        return b"".join(_pcm_of(f) for f in self._av.resample(frame))

    def pcm(self, data: bytes) -> bytes:
        """16-bit mono PCM at `src_rate` → at `rate` (stateful: feed a stream in order)."""
        if not data:
            return b""
        src = self.src_rate or self.rate
        if src == self.rate:
            return data
        n = len(data) // 2
        f = av.AudioFrame(format="s16", layout="mono", samples=n)
        f.planes[0].update(data[: n * 2])
        f.sample_rate = src
        f.pts = self._pts
        f.time_base = fractions.Fraction(1, src)
        self._pts += n
        return self.frame(f)


class Chunker:
    """Cuts a byte stream into equal frames."""

    def __init__(self, size: int) -> None:
        self.size = size
        self._buf = bytearray()

    def push(self, data: bytes) -> list[bytes]:
        self._buf += data
        out = []
        while len(self._buf) >= self.size:
            out.append(bytes(self._buf[: self.size]))
            del self._buf[: self.size]
        return out


class PcmTrack(MediaStreamTrack):
    """The add-on's voice: plays what `push` gave it, 20 ms at a time, silence when there's none."""

    kind = "audio"

    #: Hold at most this much audio ahead (seconds); `wait_room` blocks a sender beyond it.
    MAX_AHEAD_S = 1.0

    def __init__(self) -> None:
        super().__init__()
        self._buf = bytearray()
        self._start: float | None = None
        self._ts = 0
        self._room = asyncio.Event()
        self._room.set()

    def push(self, pcm48k: bytes) -> None:
        self._buf += pcm48k
        if len(self._buf) > frame_bytes(TRACK_RATE, int(self.MAX_AHEAD_S * 1000)):
            self._room.clear()

    async def wait_room(self) -> None:
        await self._room.wait()

    def clear(self) -> None:
        self._buf.clear()
        self._room.set()

    def stop(self) -> None:
        # Nothing plays any more: a sender waiting for room must not wait forever.
        self.clear()
        super().stop()

    async def recv(self) -> av.AudioFrame:
        if self.readyState != "live":
            raise MediaStreamError
        samples = TRACK_RATE * FRAME_MS // 1000
        if self._start is None:
            self._start = time.time()
            self._ts = 0
        else:
            self._ts += samples
            wait = self._start + self._ts / TRACK_RATE - time.time()
            if wait > 0:
                await asyncio.sleep(wait)
        need = samples * 2
        chunk = bytes(self._buf[:need])
        del self._buf[:need]
        if len(self._buf) <= frame_bytes(TRACK_RATE, int(self.MAX_AHEAD_S * 500)):
            self._room.set()
        if len(chunk) < need:
            chunk += b"\0" * (need - len(chunk))
        frame = av.AudioFrame(format="s16", layout="mono", samples=samples)
        frame.planes[0].update(chunk)
        frame.sample_rate = TRACK_RATE
        frame.pts = self._ts
        frame.time_base = fractions.Fraction(1, TRACK_RATE)
        return frame
