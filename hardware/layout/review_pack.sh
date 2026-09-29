#!/bin/bash
# `make review`: regenerate the review pack in hardware/build/review/
#   schematic.pdf (schematic/review.py), <board>-layers.pdf (one page per layer, with the
#   outline on every page), <board>-top/bottom.png (3D renders), <board>-drc.txt/.json.
set -euo pipefail
cd "$(dirname "$0")/.."
APP=${KICAD_APP:-$HOME/Applications/KiCad/KiCad.app}
[ -d "$APP" ] || APP=/Applications/KiCad/KiCad.app
K=${KICAD_CLI:-$APP/Contents/MacOS/kicad-cli}
OUT=build/review
mkdir -p "$OUT"
(cd schematic && ../.venv/bin/python review.py --out "../$OUT/schematic.pdf")
for b in main; do
  pcb=kicad/$b/$b.kicad_pcb
  "$K" pcb export pdf --mode-multipage --cl Edge.Cuts --sp \
    -l F.Fab,F.Silkscreen,F.Cu,In1.Cu,In2.Cu,B.Cu,B.Fab,B.Silkscreen -o "$OUT/$b-layers.pdf" "$pcb" >/dev/null
  "$K" pcb render --side top -w 2000 -h 1100 -o "$OUT/$b-top.png" "$pcb" >/dev/null
  "$K" pcb render --side bottom -w 2000 -h 1100 -o "$OUT/$b-bottom.png" "$pcb" >/dev/null
  "$K" pcb drc --severity-error --format json -o "$OUT/$b-drc.json" "$pcb" >/dev/null || true
  python3 layout/drcsum.py "$OUT/$b-drc.json" > "$OUT/$b-drc.txt"
  head -1 "$OUT/$b-drc.txt"
done
ls -la "$OUT"
