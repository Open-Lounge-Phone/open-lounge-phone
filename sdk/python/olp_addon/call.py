"""One call: its signaling (as the server relays it) and its audio, as PCM frames."""

from __future__ import annotations

import asyncio
import logging
from collections.abc import AsyncIterator, Awaitable, Callable
from typing import Any

from aiortc import (
    RTCConfiguration,
    RTCIceServer,
    RTCPeerConnection,
    RTCSessionDescription,
)
from aiortc.mediastreams import MediaStreamError, MediaStreamTrack
from aiortc.sdp import candidate_from_sdp

from . import protocol as p
from .audio import TRACK_RATE, Chunker, PcmTrack, Resampler, frame_bytes

log = logging.getLogger("olp_addon")

Send = Callable[[p.Message], Awaitable[None]]


class Call:
    """A call with the add-on.

    Incoming calls arrive at `Addon.on_call` ringing; outgoing ones come from `Addon.call`.
    Audio is 16-bit mono PCM at `rate` in 20 ms frames, both ways.
    """

    def __init__(
        self,
        send: Send,
        *,
        direction: str,
        rate: int,
        call_id: str | None = None,
        caller: p.Party | None = None,
        callee: str | None = None,
        share: p.Share | None = None,
    ) -> None:
        self.direction = direction
        #: Incoming: who is calling (verified by the server). Outgoing: None.
        self.caller = caller
        #: The share it's about: incoming, the one the caller came in through (None: its owner
        #: is calling); outgoing, the one it was placed within (None: none named). Keep the
        #: conversation inside that share.
        self.share = share
        #: Outgoing: the address dialled.
        self.callee = callee
        self.id = call_id
        self.rate = rate
        #: `ringing`, `connecting`, `active` or `ended`.
        self.state = "ringing" if direction == "in" else "requesting"
        #: Why it ended (`hangup`, `declined`, `unavailable`, …), once it has.
        self.reason: str | None = None
        #: Called with the reason when the call ends (whoever ended it).
        self.on_hangup: Callable[[str], Any] | None = None
        #: Called with a key (`0`–`9`, `*`, `#`) the other person pressed.
        self.on_key: Callable[[str], Any] | None = None
        self._send = send
        self._pc: RTCPeerConnection | None = None
        self._ice_servers: list[RTCIceServer] = []
        self._out = PcmTrack()
        self._to_track = Resampler(TRACK_RATE, src_rate=rate)
        self._frames: asyncio.Queue[bytes | None] = asyncio.Queue(maxsize=500)
        self._pending_ice: list[p.Message] = []
        self._remote_set = False
        self._active = asyncio.get_running_loop().create_future()
        self._ended = asyncio.get_running_loop().create_future()
        self._reader: asyncio.Task[None] | None = None

    def __repr__(self) -> str:
        who = self.caller.address if self.caller else self.callee
        return f"<Call {self.id} {self.direction} {who} {self.state}>"

    # --- what an add-on does with a call -------------------------------------------------

    async def answer(self) -> None:
        """Takes an incoming call. Media starts once the caller's offer arrives."""
        if self.direction != "in" or self.state != "ringing" or not self.id:
            return
        await self._send(p.call_answer(self.id))

    async def hangup(self) -> None:
        """Leaves (or declines) the call."""
        if self.state == "ended":
            return
        if self.id:
            await self._send(p.call_hangup(self.id))
        await self._end("hangup")

    async def send(self, frame: bytes) -> None:
        """Plays 16-bit mono PCM at `rate` (any length; 20 ms frames suit best). Waits when more
        than about a second is queued, so a fast producer is paced by the call."""
        if self.state == "ended":
            return
        await self._out.wait_room()
        self._out.push(self._to_track.pcm(frame))

    def clear(self) -> None:
        """Drops audio queued by `send` that hasn't played yet (e.g. when interrupted)."""
        self._out.clear()

    async def frames(self) -> AsyncIterator[bytes]:
        """What the other person says: 20 ms frames of 16-bit mono PCM at `rate`, until the
        call ends."""
        while True:
            frame = await self._frames.get()
            if frame is None:
                return
            yield frame

    async def wait_active(self, timeout: float | None = None) -> None:
        """Until audio flows both ways (raises `CallEnded` if it ends first)."""
        await asyncio.wait_for(asyncio.shield(self._active), timeout)

    async def wait_ended(self) -> str:
        """Until the call ends; answers why."""
        return await asyncio.shield(self._ended)

    @property
    def ended(self) -> bool:
        return self.state == "ended"

    # --- from the server -------------------------------------------------------------------

    async def _on_state(self, msg: p.Message) -> None:
        state = msg.get("state")
        if state == "ended":
            await self._end(str(msg.get("reason") or "hangup"))
        elif state == "ringing":
            self.state = "ringing"
        elif state == "connecting":
            self.state = "connecting"
            # The caller sends the offer (here: when the add-on placed the call).
            if self.direction == "out":
                await self._offer()
        elif state == "active":
            self.state = "active"
            if not self._active.done():
                self._active.set_result(None)

    async def _on_rtc_config(self, msg: p.Message) -> None:
        servers = []
        for s in msg.get("iceServers") or []:
            urls = s.get("urls")
            if not urls:
                continue
            servers.append(
                RTCIceServer(urls=urls, username=s.get("username"), credential=s.get("credential"))
            )
        self._ice_servers = servers

    async def _on_sdp(self, msg: p.Message) -> None:
        pc = self._peer()
        desc = RTCSessionDescription(sdp=str(msg.get("sdp", "")), type=str(msg.get("type")))
        await pc.setRemoteDescription(desc)
        self._remote_set = True
        for ice in self._pending_ice:
            await self._on_ice(ice)
        self._pending_ice.clear()
        if desc.type == "offer":
            await pc.setLocalDescription(await pc.createAnswer())
            await self._send(p.rtc_sdp(self.id or "", "answer", pc.localDescription.sdp))

    async def _on_ice(self, msg: p.Message) -> None:
        text = msg.get("candidate")
        if not text:
            return  # end of candidates
        if not self._remote_set:
            self._pending_ice.append(msg)
            return
        try:
            cand = candidate_from_sdp(str(text).split(":", 1)[1] if text.startswith("candidate:") else text)
            cand.sdpMid = msg.get("sdpMid")
            cand.sdpMLineIndex = msg.get("sdpMLineIndex")
            await self._peer().addIceCandidate(cand)
        except Exception as e:  # a candidate we can't use is not fatal
            log.debug("ignored ICE candidate %r: %s", text, e)

    async def _on_key(self, msg: p.Message) -> None:
        key = msg.get("key")
        if isinstance(key, str) and self.on_key:
            result = self.on_key(key)
            if asyncio.iscoroutine(result):
                await result

    # --- media -----------------------------------------------------------------------------

    def _peer(self) -> RTCPeerConnection:
        if self._pc is None:
            config = RTCConfiguration(iceServers=self._ice_servers or None)
            pc = RTCPeerConnection(configuration=config)
            pc.addTrack(self._out)

            @pc.on("track")
            def on_track(track: MediaStreamTrack) -> None:
                if track.kind == "audio" and self._reader is None:
                    self._reader = asyncio.ensure_future(self._read(track))

            self._pc = pc
        return self._pc

    async def _offer(self) -> None:
        pc = self._peer()
        await pc.setLocalDescription(await pc.createOffer())
        await self._send(p.rtc_sdp(self.id or "", "offer", pc.localDescription.sdp))

    async def _read(self, track: MediaStreamTrack) -> None:
        to_rate = Resampler(self.rate)
        chunks = Chunker(frame_bytes(self.rate))
        try:
            while True:
                frame = await track.recv()
                for chunk in chunks.push(to_rate.frame(frame)):
                    if self._frames.full():
                        self._frames.get_nowait()  # nobody's reading: keep the newest
                    self._frames.put_nowait(chunk)
        except (MediaStreamError, asyncio.CancelledError):
            pass

    async def _end(self, reason: str) -> None:
        if self.state == "ended":
            return
        self.state = "ended"
        self.reason = reason
        if not self._active.done():
            self._active.set_exception(CallEnded(reason))
            self._active.exception()  # retrieved: no "never retrieved" warning
        if not self._ended.done():
            self._ended.set_result(reason)
        if self._frames.full():
            self._frames.get_nowait()
        self._frames.put_nowait(None)
        if self._reader:
            self._reader.cancel()
        self._out.stop()
        if self._pc:
            await self._pc.close()
        if self.on_hangup:
            result = self.on_hangup(reason)
            if asyncio.iscoroutine(result):
                await result


class CallEnded(Exception):
    """The call ended before it was answered or connected; `args[0]` is why."""
