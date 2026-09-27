"""Build variants. Open questions from DESIGN.md §15 are parameters here, not decisions.

- ``battery``: DESIGN.md §9.3 proposes "no battery" by default with a footprint-ready B-option.
  The owner has not answered §15 Q3, so both variants build; the default follows the proposal.
- ``radar``: HLK-LD2410C fitted on Lounge, DNP on Kids (§8); §15 Q5 is still open for Kids.
- ``n_keys``: DESIGN.md's 10 keys (8 contacts + SPEAKER + END). §15 Q2 is open; the deck
  circuit is generated from this number (AW9523B has room for up to 12 keys + VOL/MUTE/LED_EN).
- ``supercap``: 0.47 F power-fail hold-up, Lounge only (§9.5).
- ``secure_element``: ATECC608B footprint, DNP until the protocol adopts p256 (§10.1).
- ``ir_hook``: IR reflective hook sensor for third-party handsets without a magnet, DNP (§6.4).
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class Variant:
    name: str
    radar: bool
    supercap: bool
    battery: bool = False
    n_keys: int = 10
    secure_element: bool = False
    ir_hook: bool = False

    @property
    def tag(self) -> str:
        return self.name + ("-batt" if self.battery else "")


VARIANTS = {
    "kids": Variant("kids", radar=False, supercap=False),
    "lounge": Variant("lounge", radar=True, supercap=True),
    # B-option (battery) is footprint-ready on both SKUs; build it to check the populated case.
    "kids-batt": Variant("kids", radar=False, supercap=False, battery=True),
}
