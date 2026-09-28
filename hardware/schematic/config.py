"""Design parameters. One board, one BOM (owner decision 2026-09-28): no Kids/Lounge variants.

On the board: every core part plus the e-ink strip (GDEY029T94 ZIF + boost), NFC (ST25DV04K +
PCB coil) and the battery charger with its fuel gauge (1S LiPo on the JST-PH-3). Removed: the
Lounge radar (LD2410C) and supercap hold-up (deferred to a future board), the ATECC608B footprint
(the ESP32-S3 uses flash encryption + eFuse HMAC), the IR hook option (the magnet is in the hook
plunger) and the DNP Qwiic display port.

- ``n_keys``: 12 (owner decision 2026-09-27: digits 1-9, 0 + MENU + BACK in two rows of six).
  The key circuit (ui.py) and key grid are generated from this number (4..12, even).
- ``ir_hook``: IR reflective hook sensor for magnet-less handsets (§6.4); False = not on the board.
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class Variant:
    name: str = "main"
    n_keys: int = 12
    ir_hook: bool = False


DESIGN = Variant()
VARIANTS = {"main": DESIGN}   # one entry: the build and cost scripts iterate this
