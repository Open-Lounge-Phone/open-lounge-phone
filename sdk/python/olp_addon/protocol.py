"""The device protocol messages an add-on sends and reads (docs/protocol.md), as plain dicts."""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from typing import Any
from urllib.parse import quote, urlsplit, urlunsplit

PROTOCOL_VERSION = 1
FW = "olp-addon/0.4.0"

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


#: A share's id: 1–30 of a-z, 0-9 and dashes (the part after the second `+` of its address).
SHARE_ID_RE = re.compile(r"^[a-z0-9-]{1,30}$")
#: The most shares one add-on offers.
MAX_SHARES = 100


def check_share_id(share_id: str) -> str:
    if not isinstance(share_id, str) or not SHARE_ID_RE.match(share_id):
        raise ValueError(f"a share id is 1-30 of a-z, 0-9 and dashes: {share_id!r}")
    return share_id


def call_address(address: str, share: str | None = None) -> Message:
    msg: Message = {"t": "call.address", "address": address}
    if share is not None:
        msg["share"] = check_share_id(share)
    return msg


def addon_shares(shares: list[dict[str, str]]) -> Message:
    """What the add-on offers for sharing (`addon.shares`); replaces what it said before."""
    return {"t": "addon.shares", "shares": shares}


def share_created(request_id: str, share_id: str) -> Message:
    return {"t": "addon.share.created", "requestId": request_id, "id": check_share_id(share_id)}


def test_ok(
    test_id: str,
    *,
    version: str | None = None,
    uptime_s: int | None = None,
    calls: int | None = None,
) -> Message:
    """The answer to `addon.test` (Test connection): how it is, with nothing about any call."""
    msg: Message = {"t": "addon.test.ok", "testId": test_id}
    text = (version or "").strip()[:64]
    if text:
        msg["version"] = text
    if uptime_s is not None:
        msg["uptimeS"] = max(0, int(uptime_s))
    if calls is not None:
        msg["calls"] = max(0, min(100, int(calls)))
    return msg


def share_refused(request_id: str, reason: str) -> Message:
    text = (reason or "").strip()[:200] or "No reason given."
    return {"t": "addon.share.refused", "requestId": request_id, "reason": text}


def normalize_shares(shares: list[Any]) -> list[dict[str, str]]:
    """`[{"id", "label"}]` checked: valid ids, labels of 1–40 characters, each id once."""
    out: list[dict[str, str]] = []
    seen: set[str] = set()
    for s in shares:
        share_id = check_share_id(s["id"] if isinstance(s, dict) else getattr(s, "id"))
        label = str(s["label"] if isinstance(s, dict) else getattr(s, "label")).strip()
        if not 1 <= len(label) <= 40:
            raise ValueError(f"a share's label is 1-40 characters: {label!r}")
        if share_id in seen:
            continue
        seen.add(share_id)
        out.append({"id": share_id, "label": label})
    if len(out) > MAX_SHARES:
        raise ValueError(f"an add-on offers at most {MAX_SHARES} shares")
    return out


#: What it does with what people say to it (`addon.about.hears`).
HEARS = ("nothing", "live", "keeps")


def addon_about(
    *,
    hears: str,
    summary: str | None = None,
    transcribes: bool = False,
    answers: bool = True,
    calls: bool = False,
    shares: bool = False,
    keys: bool = False,
    lines: int = 1,
) -> Message:
    """What the add-on does, for its page in the app (`addon.about`). The server enforces
    `answers`, `calls`, `shares`, `keys` and `lines` (calls at once, capped by the server);
    `summary`, `hears` and `transcribes` are shown as the add-on's own words.

    `hears`: "nothing" (it only plays sound, one-way), "live" (it listens during the call and
    keeps nothing), or "keeps" (it keeps what it hears: recordings, transcripts or notes)."""
    if hears not in HEARS:
        raise ValueError(f"hears is one of {', '.join(HEARS)}: {hears!r}")
    if not isinstance(lines, int) or not 1 <= lines <= 100:
        raise ValueError(f"lines is 1-100: {lines!r}")
    msg: Message = {
        "t": "addon.about",
        "hears": hears,
        "transcribes": bool(transcribes),
        "answers": bool(answers),
        "calls": bool(calls),
        "shares": bool(shares),
        "keys": bool(keys),
        "lines": lines,
    }
    if summary is not None:
        text = " ".join(str(summary).split())
        if not 1 <= len(text) <= 140 or not text.isprintable():
            raise ValueError("summary is 1-140 printable characters")
        msg["summary"] = text
    return msg


def server_features(config: Message) -> set[str]:
    """What the server says it handles (`config.server.features`)."""
    server = config.get("server") or {}
    return {str(f) for f in server.get("features") or []}


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
class Share:
    """The share a call came in through (`call.ringing.share`): None means its owner is calling."""

    id: str
    label: str
    #: The grant the caller holds (stable until its owner takes the share back).
    grant_id: str


def share_of(ringing: Message) -> Share | None:
    s = ringing.get("share")
    if not isinstance(s, dict) or not s.get("id"):
        return None
    return Share(id=str(s["id"]), label=str(s.get("label", "")), grant_id=str(s.get("grantId", "")))


@dataclass(frozen=True)
class ShareRequest:
    """Its owner asks for a new shared scope ("Ask it for a new share…", `addon.share.request`)."""

    request_id: str
    #: What its owner called it.
    label: str
    #: Its owner's address (`handle@host`).
    by: str
    #: The people to give it to, by address.
    with_: tuple[str, ...]


def share_request_of(msg: Message) -> ShareRequest:
    return ShareRequest(
        request_id=str(msg.get("requestId", "")),
        label=str(msg.get("label", "")),
        by=str(msg.get("by", "")),
        with_=tuple(str(a) for a in msg.get("with") or []),
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
