#!/usr/bin/env python3
"""Release manifests for over-the-air updates (see firmware/README.md "Updates").

    ota_manifest.py make   --bin IMAGE --board B --version V --url URL --key PRIVATE.pem [--out F]
                           [--sha256 HEX] [--size N]      (overrides: only for negative tests)
    ota_manifest.py verify --manifest manifest.json --pub PUBLIC.pem [--bin IMAGE]

The signature is RSA-PSS (SHA-256, MGF1-SHA-256, 32-byte salt) by the release key over
    "olp-ota-v1\\n<board>\\n<version>\\n<url>\\n<sha256>\\n<size>\\n"
exactly as main/ota_core.c builds it. The private key is read from its file and never printed.
Needs the `cryptography` package (it ships with ESP-IDF's Python environment).
"""
import argparse
import base64
import hashlib
import json
import sys

from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import padding

PSS = padding.PSS(mgf=padding.MGF1(hashes.SHA256()), salt_length=32)


def signed_text(m: dict) -> bytes:
    return (
        f"olp-ota-v1\n{m['board']}\n{m['version']}\n{m['url']}\n{m['sha256']}\n{m['size']}\n"
    ).encode()


def make(args: argparse.Namespace) -> int:
    data = open(args.bin, "rb").read()
    m = {
        "board": args.board,
        "version": args.version,
        "url": args.url,
        "size": args.size if args.size is not None else len(data),
        "sha256": args.sha256 or hashlib.sha256(data).hexdigest(),
    }
    for field in ("board", "version", "url"):
        if any(ord(c) < 0x20 for c in m[field]):
            raise SystemExit(f"{field} has a control character")
    if not m["url"].startswith("https://"):
        raise SystemExit("the image URL must be https://")
    with open(args.key, "rb") as f:
        key = serialization.load_pem_private_key(f.read(), password=None)
    m["signature"] = base64.b64encode(key.sign(signed_text(m), PSS, hashes.SHA256())).decode()
    out = json.dumps(m, indent=2) + "\n"
    if args.out:
        open(args.out, "w").write(out)
    else:
        sys.stdout.write(out)
    return 0


def verify(args: argparse.Namespace) -> int:
    m = json.load(open(args.manifest))
    with open(args.pub, "rb") as f:
        pub = serialization.load_pem_public_key(f.read())
    pub.verify(base64.b64decode(m["signature"]), signed_text(m), PSS, hashes.SHA256())
    if args.bin:
        data = open(args.bin, "rb").read()
        if hashlib.sha256(data).hexdigest() != m["sha256"] or len(data) != m["size"]:
            raise SystemExit("the image doesn't match the manifest")
    print(f"manifest OK: {m['version']} {m['size']} bytes")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    mk = sub.add_parser("make")
    mk.add_argument("--bin", required=True)
    mk.add_argument("--board", required=True)
    mk.add_argument("--version", required=True)
    mk.add_argument("--url", required=True)
    mk.add_argument("--key", required=True)
    mk.add_argument("--out")
    mk.add_argument("--sha256")
    mk.add_argument("--size", type=int)
    vf = sub.add_parser("verify")
    vf.add_argument("--manifest", required=True)
    vf.add_argument("--pub", required=True)
    vf.add_argument("--bin")
    a = ap.parse_args()
    return make(a) if a.cmd == "make" else verify(a)


if __name__ == "__main__":
    sys.exit(main())
