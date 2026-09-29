"""Vendor SPICE models, downloaded at run time (never committed).

Every TI model used here carries "(C) Texas Instruments Incorporated. All rights reserved." and
only an "aid for customers" disclaimer: no licence to redistribute. So the files are fetched from
ti.com into ``build/sim/models/`` (git-ignored) on the first ``make sim`` and checked against the
SHA-256 recorded here (a changed file is used but flagged in the report).
"""

from __future__ import annotations

import hashlib
import io
import urllib.request
import zipfile
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class Model:
    key: str
    title: str
    url: str          # TI literature link (redirects to the current revision)
    member: str       # file inside the zip
    sha256: str       # of the extracted file, as downloaded 2026-09-29
    subckt: str
    page: str         # product page listing the model


MODELS = {m.key: m for m in (
    Model("tlv62569", "TLV62569 PSpice Unencrypted Transient Model (SLVMBW3, rev A)",
          "https://www.ti.com/lit/zip/slvmbw3",
          "TLV62569_PSPICE_TRANS/TLV62569_TRANS.lib",
          "ff1fcd570d0bdd234c5ac1494c827fac9aeb24714e4da440fea329efaba6448e",
          "TLV62569_TRANS", "https://www.ti.com/product/TLV62569"),
    Model("lp5907", "LP5907 3.0 V Unencrypted PSpice Transient Model (SNVMAP8, rev A)",
          "https://www.ti.com/lit/zip/snvmap8", "LP5907_3P0_TRANS.LIB",
          "277a420aaca45b4daf9c9ece50ac5bce3816e6c247d40ee84d91b97e71bfadcd",
          "LP5907_3P0_TRANS", "https://www.ti.com/product/LP5907"),
    Model("sn74lv1t125", "SN74LV1T125 behavioural SPICE model (SCLM183, rev 2.0)",
          "https://www.ti.com/lit/zip/sclm183", "SN74LV1T125.cir",
          "199648d010c5121327f1ef5ce0d96ed7f3e7e7f3dffbea05d9d3c2cad4143f58",
          "SN74LV1T125", "https://www.ti.com/product/SN74LV1T125"),
    Model("tps61023", "TPS61023 Unencrypted PSpice Model (SLVMD68, rev A)",
          "https://www.ti.com/lit/zip/slvmd68",
          "SLVMD68/TPS61023_TRANS_PSPICE/library/TPS61023_TRANS.LIB",
          "bf575c936aefa99f2a838b8c6a8471796cffb87e3682bd607aa625a7eb66d4f2",
          "TPS61023_schematic", "https://www.ti.com/product/TPS61023"),
)}


def fetch(key: str, cache: Path) -> tuple[Path, str]:
    """Path to the model file (downloading it once) and a provenance note."""
    m = MODELS[key]
    cache.mkdir(parents=True, exist_ok=True)
    dest = cache / Path(m.member).name
    if not dest.exists():
        req = urllib.request.Request(m.url, headers={"User-Agent": "Mozilla/5.0"})
        blob = urllib.request.urlopen(req, timeout=60).read()
        with zipfile.ZipFile(io.BytesIO(blob)) as z:
            dest.write_bytes(z.read(m.member))
    digest = hashlib.sha256(dest.read_bytes()).hexdigest()
    ok = "sha256 matches the pinned file" if digest == m.sha256 else \
        f"WARNING sha256 {digest[:12]} differs from pinned {m.sha256[:12]} (TI revised it?)"
    return dest, f"{m.title}, {m.url} (listed on {m.page}); {ok}"
