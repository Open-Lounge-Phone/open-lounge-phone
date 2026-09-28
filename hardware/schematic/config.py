"""Build variants. Open questions from DESIGN.md §15 are parameters here, not decisions.

- ``battery``: DESIGN.md §9.3 proposes "no battery" by default with a footprint-ready B-option.
  The owner has not answered §15 Q3, so both variants build; the default follows the proposal.
- ``radar``: HLK-LD2410C fitted on Lounge, DNP on Kids (§8); §15 Q5 is still open for Kids.
- ``n_keys``: 12 (owner decision 2026-09-27: digits 1-9, 0 + MENU + BACK in two rows of six;
  no SPEAKER/END keys). The key circuit (ui.py) and key grid are generated from this number
  (4..12, even; AW9523B has room for 12 keys + VOL/MUTE/LED_EN).
- ``supercap``: 0.47 F power-fail hold-up, Lounge only (§9.5).
- ``secure_element``: ATECC608B footprint, DNP until the protocol adopts p256 (§10.1).
- ``ir_hook``: IR reflective hook sensor for third-party handsets without a magnet, DNP (§6.4).
- ``display`` (owner decision 2026-09-27): ``"none"`` (Kids "Lite": printed relegendable keycaps,
  status via key LEDs + audio; the e-ink FPC connector and SSD1680 boost parts are DNP) or
  ``"eink"`` (GDEY029T94 strip populated). One board layout serves every variant (single board,
  owner decision 2026-09-27); the difference is DNP. The board also carries a DNP
  Qwiic/STEMMA QT I2C port for a cheaper field/maker display
  (SSD1306 0.91" OLED at 0x3C or HT16K33 14-segment backpack at 0x70) on every variant.
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class Variant:
    name: str
    radar: bool
    supercap: bool
    battery: bool = False
    n_keys: int = 12
    secure_element: bool = False
    ir_hook: bool = False
    display: str = "eink"  # "none" | "eink"

    def __post_init__(self):
        if self.display not in ("none", "eink"):
            raise ValueError(f"display must be 'none' or 'eink', not {self.display!r}")

    @property
    def tag(self) -> str:
        return self.name + ("-batt" if self.battery else "")


VARIANTS = {
    # Kids "Lite" (default Kids SKU): no display, printed relegendable keycaps.
    "kids": Variant("kids", radar=False, supercap=False, display="none"),
    # Kids "Standard": same as kids with the e-ink strip populated.
    "kids-eink": Variant("kids", radar=False, supercap=False, display="eink"),
    "lounge": Variant("lounge", radar=True, supercap=True, display="eink"),
    # B-option (battery) is footprint-ready on both SKUs; build it to check the populated case.
    "kids-batt": Variant("kids", radar=False, supercap=False, battery=True, display="none"),
}
