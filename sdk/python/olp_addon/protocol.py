"""The device protocol messages an add-on sends and reads (docs/protocol.md), as plain dicts."""

from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any
from urllib.parse import quote, urlsplit, urlunsplit

PROTOCOL_VERSION = 1
FW = "olp-addon/0.1.0"

Message = dict[str, Any]


def ws_url(server_url: str, device_id: str | None = None) -> str:
    """`https://host` → `wss://host/ws/device` (with `?device=` once linked)."""
    parts = urlsplit(server_url if "://" in server_url else f"https://{server_url}")
    scheme = {"https": "wss", "http": "ws", "wss": "wss", "ws": "ws"}.get(parts.scheme)
    if not scheme:
        raise ValueError(f"not a server address: {server_url}")
    query = f"device={quote(device_id)}" if device_id else ""
    return urlunsplit((scheme, parts.netloc, "/ws/device", query, ""))


def encode(msg: Message) -> str:
    return json.dumps(msg, separators=(",", ":"))


def decode(text: str | bytes) -> Message | None:
    try:
        msg = json.loads(text)
    except ValueError:
        return None
    return msg if isinstance(msg, dict) and isinstance(msg.get("t"), str) else None


def hello(device_id: str | None = None, fw: str = FW) -> Message:
    """First message on every connection. An add-on has no keys and no display."""
    msg: Message = {
        "t": "hello",
        "proto": PROTOCOL_VERSION,
        "model": "addon",
        "fw": fw[:32],
        "buttons": 1,
        "display": "none",
    }
    if device_id:
        msg["deviceId"] = device_id
    return msg


def pair_begin(public_key: str) -> Message:
    return {"t": "pair.begin", "kind": "addon", "alg": "ed25519", "publicKey": public_key}


def auth_proof(sig: str) -> Message:
    return {"t": "auth.proof", "sig": sig}


def call_answer(call_id: str) -> Message:
    return {"t": "call.answer", "callId": call_id}


def call_hangup(call_id: str) -> Message:
    return {"t": "call.hangup", "callId": call_id}


def call_address(address: str) -> Message:
    return {"t": "call.address", "address": address}


def rtc_sdp(call_id: str, kind: str, sdp: str) -> Message:
    return {"t": "rtc.sdp", "callId": call_id, "type": kind, "sdp": sdp}


def ping() -> Message:
    return {"t": "ping"}


@dataclass(frozen=True)
class Party:
    """Who is on the other end: their verified address (`handle@host`) and name."""

    address: str | None
    name: str
    #: The other side is an add-on too (never, for now: add-ons call people).
    addon: bool = False


def caller_of(ringing: Message) -> Party:
    """The verified caller of a `call.ringing`."""
    frm = ringing.get("from") or {}
    return Party(
        address=frm.get("address"),
        name=str(frm.get("label", "")),
        addon=frm.get("kind") == "addon",
    )


@dataclass(frozen=True)
class Identity:
    """What the server says this add-on is (`config.addon`)."""

    name: str
    address: str
    owner: Party


def identity_of(config: Message) -> Identity | None:
    a = config.get("addon")
    if not isinstance(a, dict):
        return None
    owner = a.get("owner") or {}
    return Identity(
        name=str(a.get("name", "")),
        address=str(a.get("address", "")),
        owner=Party(address=owner.get("address"), name=str(owner.get("name", ""))),
    )
