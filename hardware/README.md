# Hardware (later phase)

KiCad schematics, PCB layout, and enclosure for the ESP32-S3 phone.

- [DESIGN.md](DESIGN.md): the r0.1 hardware design proposal (parts, pin map, power, BOM).
- [SCHEMATIC.md](SCHEMATIC.md): the schematic as code (SKiDL, `schematic/`). `make build`
  runs ERC and design checks, then writes KiCad netlists and BOMs to `build/`.

Hardware designs in this directory are licensed under the
[CERN Open Hardware Licence v2 – Strongly Reciprocal](LICENSE).
