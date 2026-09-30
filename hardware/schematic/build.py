"""Build the minimal board: SKiDL ERC, custom checks, KiCad netlist, BOM CSVs, part count, cost.

    python build.py            # everything (what `make build` runs); exit code 1 on any ERROR
    python build.py --one      # the SKiDL run itself (used internally, in a subprocess)

Outputs go to ../build/main/ :
    main.net        KiCad netlist (KiCad PCB editor: File > Import > Netlist)
    bom.csv         BOM: refs, qty, value, MPN, manufacturer, LCSC, footprint, JLC library type
    bom-jlc.csv     JLCPCB assembly format (Comment, Designator, Footprint, LCSC)
    erc.txt         SKiDL ERC output
    checks.txt      checks.py results
    cost.txt        cost per board at 1 / 100 / 1000 (cost.py)
and ../build/summary.txt (the lines printed at the end).
"""

from __future__ import annotations

import csv
import os
import re
import subprocess
import sys
from collections import defaultdict
from pathlib import Path

HERE = Path(__file__).resolve().parent
OUT = HERE.parent / "build" / "main"


def refkey(r: str):
    m = re.match(r"([A-Z]+)(\d+)", r)
    return (m.group(1), int(m.group(2))) if m else (r, 0)


def one() -> int:
    sys.path.insert(0, str(HERE))
    import builtins

    from skidl import ERC, generate_netlist

    import board_main
    import checks
    import parts  # noqa: F401  (registers the part specs)
    from config import DESIGN

    board_main.build(DESIGN)
    circuit = builtins.default_circuit
    ERC()
    results = checks.run_all(circuit)

    net_path = OUT / "main.net"
    generate_netlist(file_=str(net_path))
    # deterministic output: drop the timestamp so diffs show only real changes
    net_path.write_text(re.sub(r'\(date "[^"]*"\)', '(date "")', net_path.read_text()))
    n_bom = write_boms(circuit)
    for junk in list(OUT.glob("*_sklib.py")) + list(OUT.glob("*.erc")):
        junk.unlink()  # SKiDL side files
    with (OUT / "checks.txt").open("w") as f:
        for lvl, msg in results:
            f.write(f"{lvl:5} {msg}\n")
    n_err = sum(1 for lvl, _ in results if lvl == "ERROR")
    n_bom_parts, n_lines = n_bom
    print(f"main: {n_bom_parts} parts ({n_lines} BOM lines) + "
          f"{len(circuit.parts) - n_bom_parts} non-BOM items (holes, logo), "
          f"{len(circuit.nets)} nets, {n_err} check errors")
    return 1 if n_err else 0


def write_boms(circuit) -> tuple[int, int]:
    from lcsc import load_cache

    cache = load_cache()
    groups = defaultdict(list)
    for p in circuit.parts:
        if p.fields.get("BOM") == "exclude":
            continue
        key = (p.value, p.footprint, p.fields.get("MPN", ""), p.fields.get("Manufacturer", ""),
               p.fields.get("LCSC", ""), p.fields.get("Verified", ""), p.description or "")
        groups[key].append(p.ref)
    rows = sorted(groups.items(), key=lambda kv: refkey(sorted(kv[1], key=refkey)[0]))
    with (OUT / "bom.csv").open("w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["Refs", "Qty", "Value", "Description", "MPN", "Manufacturer", "LCSC",
                    "JLC library", "Footprint", "Verified"])
        for (value, fp, mpn, manu, lcsc, ver, desc), refs in rows:
            lib = (cache.get(lcsc) or {}).get("jlc_library") or ""
            lib = {"base": "basic", "expand": "extended"}.get(lib, lib)
            w.writerow([" ".join(sorted(refs, key=refkey)), len(refs), value, desc, mpn, manu,
                        lcsc, lib, fp, "yes" if ver == "yes" else f"[UNVERIFIED] {ver}"])
    with (OUT / "bom-jlc.csv").open("w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["Comment", "Designator", "Footprint", "LCSC"])
        for (value, fp, mpn, manu, lcsc, ver, desc), refs in rows:
            w.writerow([mpn or value, ",".join(sorted(refs, key=refkey)), fp.split(":")[-1], lcsc])
    return sum(len(r) for r in groups.values()), len(groups)


def main() -> int:
    sys.path.insert(0, str(HERE))
    OUT.mkdir(parents=True, exist_ok=True)
    # point SKiDL at an empty KiCad library dir: every part is defined in parts.py
    env = dict(os.environ, **{f"KICAD{v}_SYMBOL_DIR": str(HERE)
                              for v in ("", "6", "7", "8", "9", "10")})
    proc = subprocess.run([sys.executable, str(Path(__file__).resolve()), "--one"], cwd=OUT,
                          capture_output=True, text=True, env=env)
    log = proc.stdout + proc.stderr
    # sorted: SKiDL reports in set order, which varies run to run
    erc = sorted(line for line in log.splitlines() if line.startswith("ERC "))
    (OUT / "erc.txt").write_text("\n".join(erc) + "\n")
    (OUT / "build.log").write_text(log)
    n_err = sum(1 for line in erc if line.startswith("ERC ERROR"))
    n_warn = sum(1 for line in erc if line.startswith("ERC WARNING"))
    status = proc.stdout.strip().splitlines()[-1] if proc.stdout.strip() else "crashed"
    summary = [f"{status}; ERC {n_err} errors / {n_warn} warnings"]
    rc = 1 if (proc.returncode or n_err) else 0
    if proc.returncode and "check errors" not in status:
        summary.append(log[-3000:])
    try:
        import cost

        summary.append(cost.main().rstrip("\n"))
    except Exception as exc:
        summary.append(f"cost roll-up crashed: {exc!r}")
        rc = 1
    text = "\n".join(summary) + "\n"
    (OUT.parent / "summary.txt").write_text(text)
    print(text, end="")
    return rc


if __name__ == "__main__":
    if sys.argv[1:] == ["--one"]:
        sys.exit(one())
    sys.exit(main())
