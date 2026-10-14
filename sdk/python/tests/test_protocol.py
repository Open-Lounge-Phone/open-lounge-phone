import unittest

from olp_addon import protocol as p


class ProtocolTest(unittest.TestCase):
    def test_server_addresses(self) -> None:
        self.assertEqual(p.ws_url("https://hub.example"), "wss://hub.example/ws/device")
        self.assertEqual(
            p.ws_url("http://127.0.0.1:8787/", "ao_abc"), "ws://127.0.0.1:8787/ws/device?device=ao_abc"
        )
        self.assertEqual(p.ws_url("hub.example"), "wss://hub.example/ws/device")
        with self.assertRaises(ValueError):
            p.ws_url("ftp://hub.example")

    def test_an_addon_says_what_it_is(self) -> None:
        self.assertEqual(
            p.hello(),
            {"t": "hello", "proto": 1, "model": "addon", "fw": p.FW, "buttons": 1, "display": "none"},
        )
        self.assertEqual(p.hello("ao_1")["deviceId"], "ao_1")
        self.assertEqual(
            p.pair_begin("k" * 43),
            {"t": "pair.begin", "kind": "addon", "alg": "ed25519", "publicKey": "k" * 43},
        )
        self.assertEqual(p.call_address("jo@x.example"), {"t": "call.address", "address": "jo@x.example"})
        self.assertEqual(p.call_answer("c1"), {"t": "call.answer", "callId": "c1"})
        self.assertEqual(p.call_hangup("c1"), {"t": "call.hangup", "callId": "c1"})
        self.assertEqual(
            p.rtc_sdp("c1", "answer", "v=0"), {"t": "rtc.sdp", "callId": "c1", "type": "answer", "sdp": "v=0"}
        )
        self.assertEqual(p.decode(p.encode(p.ping())), {"t": "ping"})

    def test_reads_the_verified_caller(self) -> None:
        ringing = {
            "t": "call.ringing",
            "callId": "c1",
            "from": {"label": "Bob", "address": "bob@b.example"},
        }
        self.assertEqual(p.caller_of(ringing), p.Party(address="bob@b.example", name="Bob"))
        self.assertTrue(p.caller_of({"from": {"label": "x", "kind": "addon"}}).addon)

    def test_reads_its_identity(self) -> None:
        config = {
            "t": "config",
            "buttons": [],
            "quiet": False,
            "addon": {
                "name": "seat",
                "address": "jo+seat@x.example",
                "owner": {"name": "Jo", "address": "jo@x.example"},
            },
        }
        ident = p.identity_of(config)
        assert ident is not None
        self.assertEqual(ident.address, "jo+seat@x.example")
        self.assertEqual(ident.owner, p.Party(address="jo@x.example", name="Jo"))
        self.assertIsNone(p.identity_of({"t": "config"}))

    def test_ignores_what_isnt_a_message(self) -> None:
        for text in ["", "nope", "[]", '{"x":1}', '{"t":1}']:
            self.assertIsNone(p.decode(text))


if __name__ == "__main__":
    unittest.main()
