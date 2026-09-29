# Hardware (in design)

One ESP32-S3 board (180 × 88 mm, 4 layers, one BOM) in a compact 3D-printable base, with 12
hot-swap MX keys, an e-ink status strip, NFC, an optional battery and a USB-C port for an
off-the-shelf G-style handset. Status: **schematic captured and checked; the board is placed but
not routed yet**; a functional prototype box exists, the product enclosure is not designed yet.
Nothing to buy yet.

- [DESIGN.md](DESIGN.md): the hardware design (parts, power, security, staging); its top box
  lists the current owner decisions.
- [SCHEMATIC.md](SCHEMATIC.md): the schematic as code (SKiDL, `schematic/`). `make build`
  runs ERC and design checks, then writes the netlist, BOM and cost roll-up to `build/main/`.
- [LAYOUT.md](LAYOUT.md): the board layout as code (`layout/`), placement status and routing plan.
- [ASSEMBLY.md](ASSEMBLY.md): building the board (PCBA, hybrid, by hand).
- [GUIDELINES.md](GUIDELINES.md): the design rules (child-safe, rugged, simple).
- [REQUIREMENTS.md](REQUIREMENTS.md): numbered, traceable hardware requirements (H1).
- [components/](components/README.md): one file per part, checked against its datasheet and
  footprint (H2); [components/FINDINGS.md](components/FINDINGS.md) ranks the problems found.
- [enclosure/PROTO_BOX.md](enclosure/PROTO_BOX.md): a functional, printable prototype box for
  the board (`make proto`).

## Building the outputs

Everything here is source: the schematic, layout and enclosure are code, and generated outputs
are not committed. With Python 3 (and KiCad 10 for the layout and review steps):

```sh
cd hardware
make build     # ERC + design checks -> build/main/ (netlist, BOM, checks, cost)
make layout    # place + route, layout checks, fab outputs -> build/main/layout/ (KiCad 10)
make review    # review pack -> build/review/ (schematic PDF, per-layer PDF, renders, DRC)
make proto     # prototype box STL/STEP + fit checks -> enclosure/build/proto/
```

Fab outputs (Gerbers, drill, IPC-2581, BOM, pick-and-place) will ship as GitHub Release assets
when the board is final.

Hardware designs in this directory are licensed under the
[CERN Open Hardware Licence v2 – Strongly Reciprocal](LICENSE).
