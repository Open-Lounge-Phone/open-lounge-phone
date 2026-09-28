#!/bin/bash
# iterate: rebuild placement + DRC summary (dev helper)
B=${1:-main}
PY=${KICAD_PYTHON:-$HOME/Applications/KiCad/KiCad.app/Contents/Frameworks/Python.framework/Versions/3.9/bin/python3}
K=${KICAD_CLI:-$HOME/Applications/KiCad/KiCad.app/Contents/MacOS/kicad-cli}
cd "$(dirname "$0")"
$PY build_board.py $B ${@:2} 2>&1 | grep -v "assert\|traits"
$K pcb drc ../kicad/$B/$B.kicad_pcb -o ../.tools/drc-$B.json --format json >/dev/null 2>&1
python3 drcsum.py ../.tools/drc-$B.json | grep -v "^clearance\|^silk\|^lib_footprint\|^solder_mask\|^text_"
