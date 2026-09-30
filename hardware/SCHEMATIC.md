# Open Lounge Phone minimal board: schematic as code

Status: **M1 (2026-09-30), the minimal board's schematic, checked; no layout yet (M2).** This
implements [DESIGN.md](DESIGN.md) as version-controlled Python. License CERN-OHL-S-2.0.

## Toolchain

**SKiDL 2.3** (Python → KiCad netlist), pinned in `requirements.txt` and installed into
`hardware/.venv`. KiCad is not needed to build or check: every part is defined in
`schematic/parts.py` (pin map, footprint, MPN, LCSC, datasheet page), and the netlist refers to
footprints by their official KiCad library names (or the project library
`layout/footprints/openloungephone.pretty`). There is no drawn sheet: the Python is the
schematic, and `make review` renders a readable PDF from the netlist.

## Build

```sh
cd hardware
make build        # venv (first run) + ERC + checks + netlist + BOM + part count + cost
make review       # build/review/schematic.pdf: overview + one page per block
make sim          # the regulator bench (sim/README.md)
make lcsc         # network: re-verify every LCSC code (LCSC + JLCPCB), refresh lcsc_cache.json
make footprints   # network: refresh the KiCad footprint-library listing (fp_cache.json)
```

`make build` works offline (committed caches) and exits non-zero on any ERC error or check
error. Two harmless "fp-lib-table file was not found" warnings come from SKiDL.

| Output (`build/`) | What |
|---|---|
| `main/main.net` | KiCad netlist (Pcbnew: File → Import → Netlist) |
| `main/bom.csv` | BOM: refs, qty, value, MPN, manufacturer, LCSC, JLC library type, footprint, verification |
| `main/bom-jlc.csv` | JLCPCB assembly format |
| `main/erc.txt`, `main/checks.txt` | SKiDL ERC and the custom checks |
| `main/cost.txt` | cost per board at 1 / 100 / 1000, part count, extended parts, off-board parts |
| `summary.txt` | the lines `make build` prints |
| `review/schematic.pdf` | `make review` |

## Source (`schematic/`)

| File | Contents |
|---|---|
| `board_main.py` | the board, one function per block: power, mcu, keys, audio, ui |
| `parts.py` | every non-passive part with its datasheet page notes |
| `lib.py` | part factory, JLC-basic passives, pinless board items (holes, silkscreen) |
| `config.py` | design parameters: 12 keys and their legends, proposed outline, layers |
| `pin_table.yaml` | the GPIO map with strap/RTC/pull rules |
| `power_budget.yaml` | loads, source, regulator data for `check_power_budget` |
| `checks.py` | the custom checks below |
| `cost.py`, `cost_model.yaml` | cost roll-up (dated estimates for PCB and assembly fees) |
| `lcsc.py`, `fpcheck.py` | LCSC/JLCPCB and KiCad-footprint verifiers, with committed caches |
| `review.py` | the review PDF |

## Checks (`checks.py`, every build)

| Check | What it enforces |
|---|---|
| `check_pin_table` | every module GPIO matches `pin_table.yaml`; nothing else connected; IO35-37 unconnected; straps GPIO0/3/45/46 cannot be pulled high at reset by anything on their nets (only keys, a transistor base, an LED); GPIO0 has no pull-down; I2C has exactly one pull-up each; wake inputs on RTC GPIOs |
| `check_keys` | each of the 12 keys and the hook is one hot-swap socket between its own GPIO and GND, nothing else on the net |
| `check_i2c` | I2C addresses from the strap wiring (ES8311 CE → 0x18) match the table and are unique |
| `check_nets` | no single-pin nets; no unconnected input or power pins |
| `check_sourcing` | every LCSC code exists, its MPN matches, passive values match the LCSC description, JLC stock > 0; unverified pin maps are reported |
| `check_footprints` | every footprint exists in the KiCad library (cache) or the project library |
| `check_power_budget` | 3V3 peak ≤ 80 % of the LDO rating and ≥ the module's 0.5 A rule; USB draw ≤ 500 mA; LDO headroom at VBUS 4.40 V; junction temperature at 40 °C |

The checks were verified to fail when the design is broken (a pull-up on GPIO45, a resistor
across two keys).

## Result

53 parts on 23 BOM lines, 53 nets, ERC 0 errors / 0 warnings, 0 check errors. Two WARNs stay by
design: the PJ-31060 terminal mapping and the hot-swap land are to be confirmed on samples (M2).
Cost per board: $82.63 for the minimum JLCPCB order of 1 (2 assembled), $7.50 at 100, $6.07 at
1000 (DESIGN.md §10).
