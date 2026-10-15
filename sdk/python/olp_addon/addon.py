"""The add-on: links to someone's account like a phone pairs, then stays connected for calls."""

from __future__ import annotations

import asyncio
import contextlib
import inspect
import json
import logging
import os
from collections.abc import Awaitable, Callable
from pathlib import Path
from typing import Any

import websockets

from . import protocol as p
from .call import Call
from .keys import AddonKey

log = logging.getLogger("olp_addon")

CallHandler = Callable[[Call], Awaitable[Any]]
ShareRequestHandler = Callable[[p.ShareRequest], Any]

#: Seconds between keep-alive pings (the server and proxies close quiet sockets).
PING_EVERY_S = 25.0
#: Reconnect backoff: first wait and the longest.
BACKOFF_S = (1.0, 30.0)


def _accepts_two(fn: Callable[..., Any]) -> bool:
    """Whether `fn` can take two positional arguments (code, expires_at)."""
    try:
        inspect.signature(fn).bind("123456", None)
        return True
    except (TypeError, ValueError):
        return False


class AddonError(Exception):
    """The server refused something (its words are the message)."""


class AddonRemoved(AddonError):
    """Its owner removed the add-on (the server said `wipe`); the link is forgotten."""


class ShareRefused(Exception):
    """Raised by an `on_share_request` handler to say no; its message is shown to the owner."""


class Addon:
    """An add-on for one Open Lounge Phone server.

    `key_path` holds its Ed25519 key (made on first use, mode 600); the link (its id on the
    server) is kept next to it in `<key_path>.json`. Audio is 16-bit mono PCM at `rate`.
    """

    def __init__(
        self,
        server_url: str,
        key_path: str | os.PathLike[str],
        *,
        rate: int = 48_000,
        fw: str = p.FW,
        about: dict[str, Any] | None = None,
    ) -> None:
        self.server_url = server_url
        self.key = AddonKey.load_or_create(key_path)
        self.rate = rate
        self.fw = fw
        self._state_path = Path(f"{os.fspath(key_path)}.json")
        self.device_id: str | None = self._load_state().get("deviceId")
        #: Who it is and whose (from the server's `config`), once connected.
        self.identity: p.Identity | None = None
        self._handler: CallHandler | None = None
        self._share_handler: ShareRequestHandler | None = None
        #: What it offers for sharing (None: never said, so nothing is sent).
        self._shares: list[dict[str, str]] | None = None
        #: What it says it does (`addon.about`; None: never said).
        self._about: p.Message | None = p.addon_about(**about) if about else None
        #: What the server it's connected to handles (`config.server.features`).
        self.server_features: set[str] = set()
        self._on_status: Callable[[bool], Any] | None = None
        self._ws: Any = None
        self._calls: dict[str, Call] = {}
        self._placing: Call | None = None
        self._place_lock = asyncio.Lock()
        self._ready = asyncio.Event()
        self._stopped = False
        self._runner: asyncio.Task[None] | None = None
        self._tasks: set[asyncio.Task[Any]] = set()

    # --- linking ---------------------------------------------------------------------------

    @property
    def linked(self) -> bool:
        return self.device_id is not None

    async def link(self, on_code: Callable[..., Any] | None = None) -> str:
        """Asks the server for a 6-digit code and waits until its owner enters it in the app
        (Settings → Add-ons → Link an add-on). `on_code(code)` or `on_code(code, expires_at)`
        gets it (default: printed); `expires_at` is when the code stops working, in ms since the
        Unix epoch (or None). Answers the add-on's id on the server, which is saved next to
        the key."""
        show = on_code or (lambda code: print(f"Link code: {code}", flush=True))
        takes_expiry = _accepts_two(show)
        async with websockets.connect(p.ws_url(self.server_url)) as ws:
            await ws.send(p.encode(p.hello(fw=self.fw)))
            await ws.send(p.encode(p.pair_begin(self.key.public_key)))
            async for raw in ws:
                msg = p.decode(raw)
                if not msg:
                    continue
                if msg["t"] == "pair.code":
                    expires = msg.get("expiresAt")
                    expires_at = int(expires) if isinstance(expires, (int, float)) else None
                    code = str(msg["code"])
                    result = show(code, expires_at) if takes_expiry else show(code)
                    if asyncio.iscoroutine(result):
                        await result
                elif msg["t"] == "pair.done":
                    self.device_id = str(msg["deviceId"])
                    self._save_state({"deviceId": self.device_id, "server": self.server_url})
                    return self.device_id
                elif msg["t"] == "error":
                    raise AddonError(str(msg.get("message", "refused")))
        raise AddonError("the server closed the connection before the code was entered")

    def forget(self) -> None:
        """Forgets the link (the key stays): the next `link()` makes a new one."""
        self.device_id = None
        with contextlib.suppress(FileNotFoundError):
            self._state_path.unlink()

    # --- status ----------------------------------------------------------------------------

    @property
    def online(self) -> bool:
        """True while connected to the server and signed in (calls can come in)."""
        return self._ready.is_set()

    def on_status(self, handler: Callable[[bool], Any]) -> Callable[[bool], Any]:
        """Sets a handler (usable as a decorator) called with True when the add-on is connected
        and signed in, and False when the connection drops."""
        self._on_status = handler
        return handler

    async def _status(self, online: bool) -> None:
        if self._on_status is None:
            return
        try:
            result = self._on_status(online)
            if asyncio.iscoroutine(result):
                await result
        except Exception:  # a broken status handler must not take the add-on down
            log.exception("status handler failed")

    # --- calls -----------------------------------------------------------------------------

    def on_call(self, handler: CallHandler) -> CallHandler:
        """Sets the handler for incoming calls (usable as a decorator). It gets a ringing `Call`;
        `await call.answer()` takes it. Without a handler, calls are declined."""
        self._handler = handler
        return handler

    async def call(self, address: str, share: str | None = None) -> Call:
        """Calls its owner (`handle@host`), or, with `share` (a share id), someone who holds
        that share; they see the share's label with the add-on's name. Returns once the server
        answers (`call.state`): `call.state` is then `ringing`, or `ended` with a `reason` if it
        was refused (`unavailable` when they may not be called)."""
        msg = p.call_address(address, share)
        if self._about is not None and not self._about.get("calls"):
            raise AddonError("it said it doesn't call people: set_about(..., calls=True)")
        await self._ready.wait()
        async with self._place_lock:
            label = next((s["label"] for s in self._shares or [] if s["id"] == share), share or "")
            call = Call(
                self._send,
                direction="out",
                rate=self.rate,
                callee=address,
                share=p.Share(id=share, label=label, grant_id="") if share else None,
            )
            self._placing = call
            try:
                await self._send(msg)
                while call.id is None and not call.ended:
                    await asyncio.sleep(0.01)
            finally:
                self._placing = None
            return call

    # --- what it does (docs/add-ons.md, "Saying what it does") ------------------------------

    def set_about(self, **fields: Any) -> None:
        """Says what it does, for its page in the app: `hears` ("nothing", "live" or "keeps"),
        and optionally `summary`, `transcribes`, `answers`, `calls`, `shares`, `keys`, `lines`
        (see `protocol.addon_about`). The server enforces what it says it does and doesn't do.
        Sent now if connected, and again after every reconnect."""
        if "shares" not in fields:
            # Offering shares (or making them on request) means it does.
            fields["shares"] = bool(self._shares) or self._share_handler is not None
        self._about = p.addon_about(**fields)
        if self._ready.is_set() and self._ws is not None:
            self._spawn(self._send_about())

    async def _send_about(self) -> None:
        if self._about is None or "addon-about" not in self.server_features:
            return  # a server that doesn't take it: it keeps the rules it always had
        try:
            await self._send(self._about)
        except ConnectionError:
            pass

    # --- sharing (docs/add-ons.md, Sharing) -------------------------------------------------

    @property
    def shares(self) -> list[dict[str, str]]:
        """What it offers for sharing, as last set."""
        return list(self._shares or [])

    def set_shares(self, shares: list[Any]) -> None:
        """Says which parts of itself can be shared: `[{"id": "bookclub", "label": "Book club"},
        …]` (ids: 1–30 of a-z, 0-9 and dashes; labels: 1–40 characters). Replaces the list; a
        share left out is gone, with everyone it was given to. Sent now if connected, and again
        after every reconnect. Its owner then gives shares to people."""
        self._shares = p.normalize_shares(shares)
        if self._ready.is_set() and self._ws is not None:
            self._spawn(self._send_shares())

    def on_share_request(self, handler: ShareRequestHandler) -> ShareRequestHandler:
        """Sets the handler (usable as a decorator) for its owner's "New shared project with…".
        `handler(request)` (sync or async) makes the scope and returns the new share's id; the
        bridge adds `{id, label: request.label}` to `shares` if it isn't there yet, tells the
        server, and the server gives it to `request.with_`. Raise `ShareRefused(reason)` or
        return None to say no. Without a handler, requests are refused."""
        self._share_handler = handler
        return handler

    async def _send_shares(self) -> None:
        if self._shares is None:
            return
        try:
            await self._send(p.addon_shares(self._shares))
        except ConnectionError:
            pass  # sent again on the next connection

    async def _share_request(self, msg: p.Message) -> None:
        req = p.share_request_of(msg)
        try:
            if self._share_handler is None:
                raise ShareRefused("This add-on doesn't make shared projects.")
            result = self._share_handler(req)
            if inspect.isawaitable(result):
                result = await result
            if not result:
                raise ShareRefused("No.")
            share_id = p.check_share_id(str(result))
            if not any(s["id"] == share_id for s in self._shares or []):
                self._shares = p.normalize_shares(
                    [*(self._shares or []), {"id": share_id, "label": req.label}]
                )
            await self._send_shares()
            await self._send(p.share_created(req.request_id, share_id))
        except ShareRefused as e:
            await self._send(p.share_refused(req.request_id, str(e)))
        except ConnectionError:
            pass  # the request lapses; its owner can ask again
        except Exception:
            log.exception("share request handler failed")
            await self._send(p.share_refused(req.request_id, "Something went wrong."))

    def _spawn(self, work: Awaitable[Any]) -> None:
        task = asyncio.ensure_future(work)
        self._tasks.add(task)
        task.add_done_callback(self._tasks.discard)

    # --- running ---------------------------------------------------------------------------

    async def run(self) -> None:
        """Links first if needed (showing the code), then stays connected, reconnecting with
        backoff, until `stop()` or until its owner removes it (`AddonRemoved`)."""
        if not self.linked:
            await self.link()
        backoff = BACKOFF_S[0]
        while not self._stopped:
            try:
                await self._session()
                backoff = BACKOFF_S[0]
            except (AddonRemoved, AddonError):
                raise
            except (OSError, websockets.WebSocketException, asyncio.TimeoutError) as e:
                log.info("disconnected (%s); reconnecting in %.0f s", e, backoff)
            if self._stopped:
                break
            await asyncio.sleep(backoff)
            backoff = min(backoff * 2, BACKOFF_S[1])

    async def start(self, timeout: float = 30.0) -> None:
        """Runs in the background; returns once connected and signed in."""
        self._runner = asyncio.ensure_future(self.run())
        ready = asyncio.ensure_future(self._ready.wait())
        done, _ = await asyncio.wait({self._runner, ready}, timeout=timeout, return_when="FIRST_COMPLETED")
        if self._runner in done:
            ready.cancel()
            self._runner.result()  # raises what stopped it
        if ready not in done:
            ready.cancel()
            raise TimeoutError("couldn't connect to the server")

    async def stop(self) -> None:
        self._stopped = True
        for call in list(self._calls.values()):
            await call.hangup()
        if self._ws is not None:
            await self._ws.close()
        if self._runner:
            self._runner.cancel()
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await self._runner

    async def _session(self) -> None:
        url = p.ws_url(self.server_url, self.device_id)
        async with websockets.connect(url) as ws:
            self._ws = ws
            pinger = asyncio.ensure_future(self._ping(ws))
            try:
                await ws.send(p.encode(p.hello(self.device_id, self.fw)))
                async for raw in ws:
                    msg = p.decode(raw)
                    if msg:
                        await self._handle(msg)
            finally:
                pinger.cancel()
                self._ws = None
                was_online = self._ready.is_set()
                self._ready.clear()
                if was_online:
                    await self._status(False)
                # The socket is gone: so are its calls (the server ends them too).
                for call in list(self._calls.values()):
                    await call._end("error")
                self._calls.clear()

    async def _ping(self, ws: Any) -> None:
        while True:
            await asyncio.sleep(PING_EVERY_S)
            await ws.send(p.encode(p.ping()))

    async def _send(self, msg: p.Message) -> None:
        if self._ws is None:
            raise ConnectionError("not connected to the server")
        await self._ws.send(p.encode(msg))

    async def _handle(self, msg: p.Message) -> None:
        t = msg["t"]
        if t == "auth.challenge":
            await self._send(p.auth_proof(self.key.sign(str(msg["nonce"]))))
        elif t == "config":
            self.identity = p.identity_of(msg)
            self.server_features = p.server_features(msg)
            first = not self._ready.is_set()
            self._ready.set()
            if first:
                # A new connection: say again what it does and what it offers for sharing.
                await self._send_about()
                await self._send_shares()
                await self._status(True)
        elif t == "addon.share.request":
            self._spawn(self._share_request(msg))
        elif t == "wipe":
            self.forget()
            self._stopped = True
            raise AddonRemoved("its owner removed this add-on")
        elif t == "error":
            text = str(msg.get("message", ""))
            if msg.get("code") == "unauthorized":
                if "unknown device" in text:
                    self.forget()  # the server has no such link any more: link again
                raise AddonError(text or "the server refused this add-on")
            log.warning("server: %s", text)
        elif t == "call.ringing":
            await self._ringing(msg)
        elif t in ("call.state", "rtc.config", "rtc.sdp", "rtc.ice", "call.key"):
            await self._route(msg)

    async def _ringing(self, msg: p.Message) -> None:
        call_id = str(msg["callId"])
        call = Call(
            self._send,
            direction="in",
            rate=self.rate,
            call_id=call_id,
            caller=p.caller_of(msg),
            share=p.share_of(msg),
        )
        self._calls[call_id] = call
        if not self._handler:
            await call.hangup()
            return
        self._spawn(self._run_handler(call))

    async def _run_handler(self, call: Call) -> None:
        try:
            await self._handler(call)  # type: ignore[misc]
        except Exception:
            log.exception("call handler failed")
            await call.hangup()

    async def _route(self, msg: p.Message) -> None:
        call_id = str(msg.get("callId", ""))
        call = self._calls.get(call_id)
        if call is None and msg["t"] == "call.state" and self._placing and self._placing.id is None:
            # The first state after `call.address` names the new call.
            call = self._placing
            call.id = call_id
            self._calls[call_id] = call
        if call is None:
            return
        if msg["t"] == "call.state":
            await call._on_state(msg)
            if call.ended:
                self._calls.pop(call_id, None)
        elif msg["t"] == "rtc.config":
            await call._on_rtc_config(msg)
        elif msg["t"] == "rtc.sdp":
            await call._on_sdp(msg)
        elif msg["t"] == "rtc.ice":
            await call._on_ice(msg)
        elif msg["t"] == "call.key":
            await call._on_key(msg)

    # --- the link file ---------------------------------------------------------------------

    def _load_state(self) -> dict[str, Any]:
        try:
            data = json.loads(self._state_path.read_text())
        except (FileNotFoundError, ValueError):
            return {}
        # A link is for one server: another server means linking again.
        return data if isinstance(data, dict) and data.get("server") == self.server_url else {}

    def _save_state(self, data: dict[str, Any]) -> None:
        tmp = self._state_path.with_suffix(".tmp")
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w") as f:
            json.dump(data, f)
        os.replace(tmp, self._state_path)
