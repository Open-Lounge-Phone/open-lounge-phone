"""The add-on against a small fake server: linking, the signed challenge, calls, removal."""

import asyncio
import json
import os
import stat
import tempfile
import unittest
from pathlib import Path

import websockets
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey

from olp_addon import Addon, AddonError, AddonRemoved, Call, Share, ShareRefused, ShareRequest
from olp_addon.keys import b64url, from_b64url


class FakeServer:
    """Speaks the device protocol's add-on side, one connection at a time."""

    def __init__(self) -> None:
        self.inbox: asyncio.Queue[tuple[str, dict]] = asyncio.Queue()
        self.ws = None
        self.public_key: str | None = None
        self.device_id = "ao_test1"
        self.verified = asyncio.Event()
        self.path: list[str] = []
        #: What it says it handles (`config.server.features`).
        self.features = ["addons", "addon-shares", "addon-about"]

    async def handler(self, ws) -> None:
        self.ws = ws
        self.path.append(ws.request.path)
        async for raw in ws:
            msg = json.loads(raw)
            await self.inbox.put((msg["t"], msg))
            if msg["t"] == "pair.begin":
                self.public_key = msg["publicKey"]
                await ws.send(json.dumps({"t": "pair.code", "code": "123456", "expiresAt": 1}))
            elif msg["t"] == "hello" and msg.get("deviceId"):
                self.nonce = b64url(os.urandom(32))
                await ws.send(json.dumps({"t": "auth.challenge", "nonce": self.nonce}))
            elif msg["t"] == "auth.proof":
                pub = Ed25519PublicKey.from_public_bytes(from_b64url(self.public_key or ""))
                pub.verify(from_b64url(msg["sig"]), from_b64url(self.nonce))
                self.verified.set()
                await ws.send(
                    json.dumps(
                        {
                            "t": "config",
                            "buttons": [],
                            "quiet": False,
                            "server": {"software": "fake", "features": self.features},
                            "addon": {
                                "name": "seat",
                                "address": "jo+seat@x.example",
                                "owner": {"name": "Jo", "address": "jo@x.example"},
                            },
                        }
                    )
                )

    async def send(self, msg: dict) -> None:
        assert self.ws is not None
        await self.ws.send(json.dumps(msg))

    async def next(self, t: str) -> dict:
        while True:
            got, msg = await asyncio.wait_for(self.inbox.get(), 5)
            if got == t:
                return msg


class AddonTest(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self) -> None:
        self.dir = tempfile.TemporaryDirectory()
        self.key = Path(self.dir.name) / "seat.addon-key"
        self.fake = FakeServer()
        self.server = await websockets.serve(self.fake.handler, "127.0.0.1", 0)
        port = self.server.sockets[0].getsockname()[1]
        self.url = f"http://127.0.0.1:{port}"

    async def asyncTearDown(self) -> None:
        self.server.close()
        await self.server.wait_closed()
        self.dir.cleanup()

    async def linked(self) -> Addon:
        addon = Addon(self.url, self.key)
        codes: list[str] = []
        link = asyncio.ensure_future(addon.link(on_code=codes.append))
        hello = await self.fake.next("hello")
        self.assertEqual(hello["model"], "addon")
        self.assertNotIn("deviceId", hello)
        begin = await self.fake.next("pair.begin")
        self.assertEqual(begin["kind"], "addon")
        self.assertEqual(begin["publicKey"], addon.key.public_key)
        await asyncio.sleep(0.05)
        self.assertEqual(codes, ["123456"])
        await self.fake.send({"t": "pair.done", "deviceId": self.fake.device_id, "householdId": "hh"})
        self.assertEqual(await link, self.fake.device_id)
        return addon

    async def test_links_and_remembers_the_link(self) -> None:
        addon = await self.linked()
        state = Path(f"{self.key}.json")
        self.assertEqual(stat.S_IMODE(os.stat(state).st_mode), 0o600)
        self.assertEqual(json.loads(state.read_text())["deviceId"], self.fake.device_id)
        # A new process with the same key file is still linked; another server isn't.
        self.assertEqual(Addon(self.url, self.key).device_id, self.fake.device_id)
        self.assertIsNone(Addon("https://elsewhere.example", self.key).device_id)
        self.assertTrue(addon.linked)

    async def test_tells_the_code_with_its_expiry_and_reports_online_status(self) -> None:
        addon = Addon(self.url, self.key)
        got: list[tuple[str, int | None]] = []

        def show(code: str, expires_at: int | None) -> None:
            got.append((code, expires_at))

        link = asyncio.ensure_future(addon.link(on_code=show))
        await self.fake.next("pair.begin")
        await asyncio.sleep(0.05)
        self.assertEqual(got, [("123456", 1)])  # the fake server's expiresAt
        await self.fake.send({"t": "pair.done", "deviceId": self.fake.device_id, "householdId": "hh"})
        await link

        status: list[bool] = []
        addon.on_status(status.append)
        self.assertFalse(addon.online)
        await addon.start(timeout=5)
        self.assertTrue(addon.online)
        self.assertEqual(status, [True])
        # The server drops the connection: offline (then it reconnects by itself).
        assert self.fake.ws is not None
        await self.fake.ws.close()
        for _ in range(100):
            if status[-1] is False:
                break
            await asyncio.sleep(0.02)
        self.assertEqual(status[:2], [True, False])
        await addon.stop()

    async def test_answers_the_challenge_and_takes_a_call(self) -> None:
        addon = await self.linked()
        calls: list[Call] = []
        keys: list[str] = []

        @addon.on_call
        async def take(call: Call) -> None:
            calls.append(call)
            call.on_key = keys.append
            await call.answer()

        await addon.start(timeout=5)
        self.assertTrue(self.fake.verified.is_set())
        self.assertIn("device=ao_test1", self.fake.path[-1])
        assert addon.identity is not None
        self.assertEqual(addon.identity.address, "jo+seat@x.example")
        self.assertEqual(addon.identity.owner.address, "jo@x.example")

        await self.fake.send(
            {"t": "call.ringing", "callId": "c1", "from": {"label": "Bob", "address": "bob@b.example"}}
        )
        self.assertEqual(await self.fake.next("call.answer"), {"t": "call.answer", "callId": "c1"})
        call = calls[0]
        self.assertEqual(call.caller.address, "bob@b.example")
        self.assertEqual(call.caller.name, "Bob")
        await self.fake.send({"t": "call.key", "callId": "c1", "key": "5"})
        await self.fake.send({"t": "call.state", "callId": "c1", "state": "ended", "reason": "hangup"})
        self.assertEqual(await asyncio.wait_for(call.wait_ended(), 5), "hangup")
        self.assertEqual(keys, ["5"])
        # Its frames end with the call.
        self.assertEqual([f async for f in call.frames()], [])
        await addon.stop()

    async def test_places_a_call_and_hears_why_it_was_refused(self) -> None:
        addon = await self.linked()
        await addon.start(timeout=5)
        placing = asyncio.ensure_future(addon.call("jo@x.example"))
        self.assertEqual(
            await self.fake.next("call.address"), {"t": "call.address", "address": "jo@x.example"}
        )
        await self.fake.send({"t": "call.state", "callId": "c9", "state": "ringing"})
        call = await asyncio.wait_for(placing, 5)
        self.assertEqual((call.id, call.state, call.direction), ("c9", "ringing", "out"))
        await self.fake.send({"t": "call.state", "callId": "c9", "state": "ended", "reason": "declined"})
        self.assertEqual(await asyncio.wait_for(call.wait_ended(), 5), "declined")

        refused = asyncio.ensure_future(addon.call("stranger@x.example"))
        await self.fake.next("call.address")
        await self.fake.send({"t": "call.state", "callId": "c10", "state": "ended", "reason": "unavailable"})
        call = await asyncio.wait_for(refused, 5)
        self.assertEqual((call.state, call.reason), ("ended", "unavailable"))
        await addon.stop()

    async def test_says_what_it_shares_now_and_after_every_reconnect(self) -> None:
        addon = await self.linked()
        addon.set_shares([{"id": "bookclub", "label": "Book club"}, {"id": "bookclub", "label": "x"}])
        await addon.start(timeout=5)
        first = await self.fake.next("addon.shares")
        self.assertEqual(first["shares"], [{"id": "bookclub", "label": "Book club"}])
        # A change goes out at once.
        addon.set_shares([{"id": "bookclub", "label": "Book club"}, {"id": "garden", "label": "Garden"}])
        changed = await self.fake.next("addon.shares")
        self.assertEqual([s["id"] for s in changed["shares"]], ["bookclub", "garden"])
        # The server drops the connection: the list goes out again once it's back.
        assert self.fake.ws is not None
        await self.fake.ws.close()
        again = await asyncio.wait_for(self.fake.next("addon.shares"), 10)
        self.assertEqual([s["id"] for s in again["shares"]], ["bookclub", "garden"])
        with self.assertRaises(ValueError):
            addon.set_shares([{"id": "Book Club", "label": "Book club"}])
        with self.assertRaises(ValueError):
            addon.set_shares([{"id": "x", "label": ""}])
        await addon.stop()

    async def test_says_what_it_does_first_and_only_to_a_server_that_takes_it(self) -> None:
        addon = await self.linked()
        addon.set_shares([{"id": "listen", "label": "Listen"}])
        addon.set_about(hears="nothing", summary="Plays  the station.", lines=5)
        await addon.start(timeout=5)
        about = await self.fake.next("addon.about")
        self.assertEqual(
            about,
            {
                "t": "addon.about",
                "hears": "nothing",
                "summary": "Plays the station.",
                "transcribes": False,
                "answers": True,
                "calls": False,
                "shares": True,  # it offers shares, so it says so
                "keys": False,
                "lines": 5,
            },
        )
        await self.fake.next("addon.shares")  # after what it does
        # It said it doesn't call people: the bridge says so before the server would.
        with self.assertRaises(AddonError):
            await addon.call("jo@x.example")
        with self.assertRaises(ValueError):
            addon.set_about(hears="everything")
        # A server that doesn't take it: not sent (its old rules apply there).
        self.fake.features = ["addons", "addon-shares"]
        assert self.fake.ws is not None
        await self.fake.ws.close()
        await self.fake.next("hello")
        await self.fake.next("addon.shares")
        self.assertTrue(all(t != "addon.about" for t, _ in list(self.fake.inbox._queue)))  # type: ignore[attr-defined]
        await addon.stop()

    async def test_without_shares_it_never_says_any(self) -> None:
        addon = await self.linked()
        await addon.start(timeout=5)
        await self.fake.send(
            {"t": "call.ringing", "callId": "c1", "from": {"label": "Jo", "address": "jo@x.example"}}
        )
        await self.fake.next("call.hangup")  # no handler: declined
        seen: list[str] = []
        while not self.fake.inbox.empty():
            seen.append(self.fake.inbox.get_nowait()[0])
        self.assertNotIn("addon.shares", seen)
        await addon.stop()

    async def test_tells_a_call_through_a_share_from_its_owners(self) -> None:
        addon = await self.linked()
        calls: list[Call] = []

        @addon.on_call
        async def take(call: Call) -> None:
            calls.append(call)

        await addon.start(timeout=5)
        await self.fake.send(
            {"t": "call.ringing", "callId": "c1", "from": {"label": "Jo", "address": "jo@x.example"}}
        )
        await self.fake.send(
            {
                "t": "call.ringing",
                "callId": "c2",
                "from": {"label": "Ana", "address": "ana@x.example"},
                "share": {"id": "bookclub", "label": "Book club", "grantId": "ag_1"},
            }
        )
        for _ in range(100):
            if len(calls) == 2:
                break
            await asyncio.sleep(0.02)
        self.assertIsNone(calls[0].share)
        self.assertEqual(calls[1].share, Share(id="bookclub", label="Book club", grant_id="ag_1"))
        await addon.stop()

    async def test_calls_within_a_share(self) -> None:
        addon = await self.linked()
        addon.set_shares([{"id": "bookclub", "label": "Book club"}])
        await addon.start(timeout=5)
        placing = asyncio.ensure_future(addon.call("ana@x.example", share="bookclub"))
        self.assertEqual(
            await self.fake.next("call.address"),
            {"t": "call.address", "address": "ana@x.example", "share": "bookclub"},
        )
        await self.fake.send({"t": "call.state", "callId": "c3", "state": "ringing"})
        call = await asyncio.wait_for(placing, 5)
        self.assertEqual(call.share, Share(id="bookclub", label="Book club", grant_id=""))
        with self.assertRaises(ValueError):
            await addon.call("ana@x.example", share="Book Club")
        await addon.stop()

    async def test_answers_its_owners_share_requests(self) -> None:
        addon = await self.linked()
        asked: list[ShareRequest] = []

        @addon.on_share_request
        async def make(req: ShareRequest) -> str:
            asked.append(req)
            if req.label == "Nope":
                raise ShareRefused("Not now.")
            return "garden"

        await addon.start(timeout=5)
        await self.fake.send(
            {
                "t": "addon.share.request",
                "requestId": "sr_1",
                "label": "Garden",
                "by": "jo@x.example",
                "with": ["ana@x.example"],
            }
        )
        shares = await self.fake.next("addon.shares")
        self.assertEqual(shares["shares"], [{"id": "garden", "label": "Garden"}])
        self.assertEqual(
            await self.fake.next("addon.share.created"),
            {"t": "addon.share.created", "requestId": "sr_1", "id": "garden"},
        )
        self.assertEqual(asked[0], ShareRequest("sr_1", "Garden", "jo@x.example", ("ana@x.example",)))
        self.assertEqual(addon.shares, [{"id": "garden", "label": "Garden"}])
        await self.fake.send({"t": "addon.share.request", "requestId": "sr_2", "label": "Nope", "by": "jo@x.example", "with": []})
        self.assertEqual(
            await self.fake.next("addon.share.refused"),
            {"t": "addon.share.refused", "requestId": "sr_2", "reason": "Not now."},
        )
        await addon.stop()

    async def test_refuses_share_requests_without_a_handler(self) -> None:
        addon = await self.linked()
        await addon.start(timeout=5)
        await self.fake.send({"t": "addon.share.request", "requestId": "sr_1", "label": "X", "by": "jo@x.example", "with": []})
        refused = await self.fake.next("addon.share.refused")
        self.assertEqual(refused["requestId"], "sr_1")
        self.assertTrue(refused["reason"])
        await addon.stop()

    async def test_declines_calls_without_a_handler(self) -> None:
        addon = await self.linked()
        await addon.start(timeout=5)
        await self.fake.send({"t": "call.ringing", "callId": "c2", "from": {"label": "Bob"}})
        self.assertEqual(await self.fake.next("call.hangup"), {"t": "call.hangup", "callId": "c2"})
        await addon.stop()

    async def test_forgets_its_link_when_removed(self) -> None:
        addon = await self.linked()
        await addon.start(timeout=5)
        runner = addon._runner
        await self.fake.send({"t": "wipe", "reason": "removed"})
        with self.assertRaises(AddonRemoved):
            await asyncio.wait_for(runner, 5)
        self.assertFalse(addon.linked)
        self.assertFalse(Path(f"{self.key}.json").exists())
        self.assertTrue(self.key.exists())  # the key stays; linking again makes a new link


if __name__ == "__main__":
    unittest.main()
