"""Design parameters of the minimal board (M1, owner decision 2026-09-30). One board, one BOM.

- ``n_keys``: 12 (owner decision 2026-09-27): rear row ``1 2 3 4 5 MENU``, front row
  ``6 7 8 9 0 BACK``. Every key is an MX switch in a hot-swap socket wired straight to its own
  ESP32 GPIO (internal pull-up); no expander, no matrix.
- ``board_mm``: proposed outline (M2 places the parts), see DESIGN.md §9.
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class Design:
    name: str = "main"
    n_keys: int = 12
    board_mm: tuple = (160.0, 88.0)
    layers: int = 2


DESIGN = Design()

# Key legends in protocol order (index = protocol `button` for digits: 1-9 -> 0-8, 0 -> 9)
KEYS = ["1", "2", "3", "4", "5", "MENU", "6", "7", "8", "9", "0", "BACK"]
