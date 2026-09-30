# CPG151101S11-2 — MX hot-swap socket (SW3-SW15, 13 pcs)

| | |
|---|---|
| MPN / maker | CPG151101S11-2, HanElectricity (same body, holes and land as the Kailh CPG151101S11) |
| Function here | 12 key sockets (SW3-SW14: `1 2 3 4 5 MENU` / `6 7 8 9 0 BACK`) and the hook switch (SW15: an MX switch under the hook plunger). Pin 1 → the key's own GPIO (internal pull-up), pin 2 → GND. Bottom side; the switch pins come through from the top. |
| Datasheet | HanElectricity drawing: https://datasheet.lcsc.com/datasheet/pdf/1ee2260e25d7adfa886a86560701dea9.pdf ; Kailh original (KH-PS2206-43 rev A, drawing KHA-PG1511-388EN): https://datasheet.lcsc.com/datasheet/pdf/5ea75d84e431b4d0c68ab6e4e17d332c.pdf |
| LCSC / JLC | C49352235; ~$0.046 @1, $0.032 @1k; **extended** (the Kailh -16, C5156480, had no stock) |
| Footprint | `OpenLoungePhone:Kailh_MX_Hotswap_CPG151101S11` (layout/footprints/gen_footprints.py) |

| Spec | Value | Source |
|---|---|---|
| Switch pin holes | Ø2.90 ± 0.05 mm, 6.35 / 2.54 mm apart | [p1] (both drawings) |
| Recommended land | Ø3.00 holes, pads 2.55 × 2.5 mm outboard | [p1] |
| Rating | 12 V / 10 mA max; contact ≤ 100 mΩ; 5 000 insertions | [p1] |
| Plating | tin (Kailh: gold) | [p1] BOM |

The footprint's pad positions follow the common Kailh land; they are **UNVERIFIED** against the
-2 drawing's dimension table until a test fit on the M2 board. The hook as an MX switch: 4 mm
travel, actuation at ~2 mm, so the hook plunger needs ≥ 2 mm of stroke and must stop within
4 mm (enclosure, M2).
