# Hardware (in design)

The **minimal board** (owner decision 2026-09-30): an ESP32-S3 module, one USB-C port for power
and flashing, one 3.3 V regulator, 12 hot-swap MX keys and a hook switch wired straight to
GPIOs, a socket for a ready-made 2.9" e-paper display module, a 3.5 mm jack with an ES8311
codec for an off-the-shelf analog handset, a piezo ringer and one status LED. 53 parts on a
2-layer board. It has **no** battery, NFC, speaker, per-key LEDs, hardware mute switch or mic
lights.

Status: **schematic done and checked (M1)**, **placement done (M2)**: 156 × 88 mm, all SMD on
the bottom, DRC clean, image in `build/review/placement.png` (`make placement`). Routing is
next. Nothing to buy yet.

- [DESIGN.md](DESIGN.md): the design, GPIO map, cost, what the board does and doesn't do, and
  the placement (§9) and the questions still open.
- [SCHEMATIC.md](SCHEMATIC.md): the schematic as code (SKiDL, `schematic/`) and its checks.
- [REQUIREMENTS.md](REQUIREMENTS.md) and [BOARD_REQUIREMENTS.md](BOARD_REQUIREMENTS.md): the
  requirements and the 2-layer layout checklist.
- [components/](components/README.md): one file per part, with datasheet pages.
- [GUIDELINES.md](GUIDELINES.md): the design rules (child-safe, rugged, simple).
- [ASSEMBLY.md](ASSEMBLY.md): building the board (PCBA or by hand).
- [sim/](sim/README.md): the regulator simulation (`make sim`).
- [enclosure/PROTO_BOX.md](enclosure/PROTO_BOX.md): the prototype box for the placed board.

## Building the outputs

Everything here is source; generated outputs are not committed. With Python 3:

```sh
cd hardware
make build     # ERC + design checks -> build/main/ (netlist, BOM, checks, cost, part count)
make review    # readable schematic PDF -> build/review/schematic.pdf
make sim       # regulator simulation -> build/sim/report.md (ngspice or KiCad's libngspice)
make placement # KiCad 10: kicad/main board, DRC, wiring metrics, build/review/placement.png
make proto     # prototype box (enclosure/) + its fit checks
```

`layout/`: `place.py` builds `kicad/main/main.kicad_pcb` from the netlist (placement table +
a small placer for resistors and capacitors), `review_placement.py` measures it and draws the
placement image (planned lanes live only in the image), plus the netlist reader, fab-output
export and the project footprint library (hot-swap socket, board marking).

Hardware designs in this directory are licensed under the
[CERN Open Hardware Licence v2 – Strongly Reciprocal](LICENSE).
