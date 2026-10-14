"""The add-on's identity: one Ed25519 key, kept in a file only its owner can read (mode 600)."""

from __future__ import annotations

import base64
import os
from pathlib import Path

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey


def b64url(data: bytes) -> str:
    """base64url without padding (the protocol's encoding for keys, nonces and signatures)."""
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def from_b64url(text: str) -> bytes:
    return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))


class AddonKey:
    """An Ed25519 key pair. The private half never leaves this machine."""

    def __init__(self, private: Ed25519PrivateKey) -> None:
        self._private = private

    @classmethod
    def generate(cls) -> "AddonKey":
        return cls(Ed25519PrivateKey.generate())

    @classmethod
    def load_or_create(cls, path: str | os.PathLike[str]) -> "AddonKey":
        """Loads the key at `path`, or makes one there (PEM, PKCS#8, mode 600)."""
        p = Path(path)
        if p.exists():
            data = p.read_bytes()
            key = serialization.load_pem_private_key(data, password=None)
            if not isinstance(key, Ed25519PrivateKey):
                raise ValueError(f"{p} isn't an Ed25519 key")
            return cls(key)
        key = cls.generate()
        p.parent.mkdir(parents=True, exist_ok=True)
        pem = key._private.private_bytes(
            serialization.Encoding.PEM,
            serialization.PrivateFormat.PKCS8,
            serialization.NoEncryption(),
        )
        # Created with mode 600 from the start: never readable by anyone else, even briefly.
        fd = os.open(p, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "wb") as f:
            f.write(pem)
        return key

    @property
    def public_key(self) -> str:
        """The raw 32-byte public key, base64url (43 characters), as `pair.begin` sends it."""
        raw = self._private.public_key().public_bytes(
            serialization.Encoding.Raw, serialization.PublicFormat.Raw
        )
        return b64url(raw)

    def sign(self, nonce_b64: str) -> str:
        """`auth.proof`: the signature over the raw nonce bytes, base64url (86 characters)."""
        return b64url(self._private.sign(from_b64url(nonce_b64)))
