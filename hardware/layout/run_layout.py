"""`make layout`: footprints -> boards (place + route, cached) -> plate -> checks -> exports.

    python run_layout.py [--force] [--boards main]

Routing (layout/router.py, a deterministic grid router) takes minutes, so a board is only re-placed and re-routed when its inputs
change: the SHA-256 of the netlist, boards.yaml, placement.yaml, the project footprints and the
layout scripts is stored in hardware/kicad/<board>/inputs.sha256 (committed with the board).
Exit code 1 if any layout check fails.
"""

from __future__ import annotations

import argparse
import hashlib
import shutil
import subprocess
import sys
from pathlib import Path

import kienv
from kienv import BUILD, KICAD_OUT, LAYOUT

PY = sys.executable
VARIANTS = ["main"]   # one board, one BOM (owner 2026-09-28)


def inputs_hash(board: str) -> str:
    """Hash of what shapes the copper: connectivity + footprints (not values/sourcing fields,
    which sync_fields.py updates in place), outlines, placement, footprints, scripts."""
    import netlist as nl

    h = hashlib.sha256()
    files = [LAYOUT / "boards.yaml", LAYOUT / "placement.yaml", LAYOUT / "build_board.py",
             LAYOUT / "fab-common.kicad_dru"]
    files += sorted((LAYOUT / "footprints" / "openloungephone.pretty").glob("*.kicad_mod"))
    for f in files:
        h.update(f.name.encode())
        h.update(f.read_bytes())
    net = nl.read(BUILD / board / f"{board}.net")
    for ref in sorted(net.comps):
        h.update(f"{ref}={net.comps[ref].footprint};".encode())
    for name in sorted(net.nets):
        h.update(f"{name}:{sorted(net.nets[name])};".encode())
    return h.hexdigest()


def run(*args) -> int:
    print("+", " ".join(map(str, args)), flush=True)
    return subprocess.run([PY, *map(str, args)], cwd=LAYOUT).returncode


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--force", action="store_true", help="re-place and re-route every board")
    ap.add_argument("--boards", default="main")
    ap.add_argument("--variants", default=",".join(VARIANTS))
    ap.add_argument("--passes", default="100")
    a = ap.parse_args()
    boards = a.boards.split(",")
    rc = 0
    if run(LAYOUT / "footprints" / "gen_footprints.py"):
        return 1
    for b in boards:
        stamp = KICAD_OUT / b / "inputs.sha256"
        want = inputs_hash(b)
        pcb = KICAD_OUT / b / f"{b}.kicad_pcb"
        if not a.force and pcb.exists() and stamp.exists() and stamp.read_text().strip() == want:
            print(f"{b}: inputs unchanged, keeping the routed board ({pcb.name})")
            if run("build_board.py", b, "--stage", "sync"):
                return 1
        else:
            if run("build_board.py", b, "--stage", "all", "--passes", a.passes):
                return 1
            stamp.write_text(want + "\n")
    if run("build_board.py", "plate") or run("export.py", "plate"):
        return 1
    for b in boards:
        out = BUILD / b / "layout"
        if run("checks.py", b, "--out", out):
            rc = 1
        if run("export.py", b):
            rc = 1
    return rc


if __name__ == "__main__":
    sys.exit(main())
