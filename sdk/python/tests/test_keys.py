import os
import stat
import tempfile
import unittest
from pathlib import Path

from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
from cryptography.hazmat.primitives.asymmetric.ec import SECP256R1, generate_private_key
from cryptography.hazmat.primitives import serialization

from olp_addon.keys import AddonKey, b64url, from_b64url


class KeyTest(unittest.TestCase):
    def setUp(self) -> None:
        self.dir = tempfile.TemporaryDirectory()
        self.path = Path(self.dir.name) / "seat.addon-key"

    def tearDown(self) -> None:
        self.dir.cleanup()

    def test_made_once_readable_only_by_its_owner(self) -> None:
        key = AddonKey.load_or_create(self.path)
        self.assertEqual(stat.S_IMODE(os.stat(self.path).st_mode), 0o600)
        again = AddonKey.load_or_create(self.path)
        self.assertEqual(key.public_key, again.public_key)
        self.assertEqual(len(key.public_key), 43)  # 32 bytes, base64url without padding

    def test_signs_the_raw_nonce_bytes(self) -> None:
        key = AddonKey.load_or_create(self.path)
        nonce = b64url(os.urandom(32))
        sig = key.sign(nonce)
        self.assertEqual(len(sig), 86)  # 64 bytes
        pub = Ed25519PublicKey.from_public_bytes(from_b64url(key.public_key))
        pub.verify(from_b64url(sig), from_b64url(nonce))  # raises if wrong
        with self.assertRaises(Exception):
            pub.verify(from_b64url(sig), b"something else")

    def test_refuses_a_key_of_another_kind(self) -> None:
        other = generate_private_key(SECP256R1())
        self.path.write_bytes(
            other.private_bytes(
                serialization.Encoding.PEM,
                serialization.PrivateFormat.PKCS8,
                serialization.NoEncryption(),
            )
        )
        with self.assertRaises(ValueError):
            AddonKey.load_or_create(self.path)

    def test_base64url_round_trip(self) -> None:
        for n in range(0, 40):
            data = os.urandom(n)
            text = b64url(data)
            self.assertNotIn("=", text)
            self.assertEqual(from_b64url(text), data)


if __name__ == "__main__":
    unittest.main()
