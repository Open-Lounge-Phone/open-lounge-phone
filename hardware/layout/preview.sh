#!/bin/bash
# Quick 2D preview PNGs of a board for placement iteration: preview.sh <board> [outdir]
set -euo pipefail
B=$1
OUT=${2:-$(dirname "$0")/../.tools/preview}
CLI=${KICAD_CLI:-$HOME/Applications/KiCad/KiCad.app/Contents/MacOS/kicad-cli}
PCB=$(dirname "$0")/../kicad/$B/$B.kicad_pcb
mkdir -p "$OUT"
for side in F B; do
  "$CLI" pcb export svg "$PCB" -o "$OUT/$B-$side.svg" --mode-single --fit-page-to-board \
    --exclude-drawing-sheet \
    -l "Edge.Cuts,$side.Cu,$side.SilkS,$side.CrtYd" >/dev/null 2>&1
  qlmanage -t -s 2400 -o "$OUT" "$OUT/$B-$side.svg" >/dev/null 2>&1
  mv "$OUT/$B-$side.svg.png" "$OUT/$B-$side.png"
done
ls "$OUT"/$B-*.png
