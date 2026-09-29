# Hardware (in design)

One ESP32-S3 board (180 × 88 mm, 4 layers, one BOM) in a compact 3D-printable base, with 12
hot-swap MX keys, an e-ink status strip, NFC, an optional battery and a USB-C port for an
off-the-shelf G-style handset. Status: **schematic captured and checked; the board is placed but
not routed yet**; the enclosure CAD is being brought in line with the single board. Nothing to
buy yet.

- [DESIGN.md](DESIGN.md): the hardware design (parts, power, security, staging); its top box
  lists the current owner decisions.
- [SCHEMATIC.md](SCHEMATIC.md): the schematic as code (SKiDL, `schematic/`). `make build`
  runs ERC and design checks, then writes the netlist, BOM and cost roll-up to `build/main/`.
- [LAYOUT.md](LAYOUT.md): the board layout as code (`layout/`), placement status and routing plan.
- [ASSEMBLY.md](ASSEMBLY.md): building the board (PCBA, hybrid, by hand).
- [GUIDELINES.md](GUIDELINES.md): the design rules (child-safe, rugged, simple).
- [enclosure/ENCLOSURE.md](enclosure/ENCLOSURE.md) and [enclosure/PROTO_BOX.md](enclosure/PROTO_BOX.md):
  the printed base and a functional prototype box.

Hardware designs in this directory are licensed under the
[CERN Open Hardware Licence v2 – Strongly Reciprocal](LICENSE).
