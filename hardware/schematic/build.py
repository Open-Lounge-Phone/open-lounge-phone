"""Build every board x variant: SKiDL ERC, custom checks, KiCad netlist, BOM CSVs.

    python build.py              # everything (what `make` runs); exit code 1 on any ERROR
    python build.py --one main kids   # a single board/variant (used internally)

Outputs go to ../build/<board>-<variant>/ :
    <board>.net     KiCad netlist (import in KiCad PCB editor: File > Import > Netlist)
    bom.csv         full BOM incl. DNP, MPN, LCSC, verification status
    bom-jlc.csv     fitted parts only, JLCPCB assembly format (Comment,Designator,Footprint,LCSC)
    erc.txt         SKiDL ERC output
    checks.txt      checks.py results
    ffc.json        FFC pin -> net map (cross-checked between main and deck)
"""

from __future__ import annotations

import csv
import json
import os
import re
import subprocess
import sys
from collections import defaultdict
from pathlib import Path

HERE = Path(__file__).resolve().parent
BUILD = HERE.parent / "build"
BOARDS = ("main", "deck")


def one(board: str, variant_name: str) -> int:
    sys.path.insert(0, str(HERE))
    import builtins

    from skidl import ERC, generate_netlist

    import checks
    import parts  # noqa: F401  (registers all part specs)
    from config import VARIANTS

    variant = VARIANTS[variant_name]
    out = BUILD / f"{board}-{variant_name}"
    out.mkdir(parents=True, exist_ok=True)
    mod = __import__(f"board_{board}")
    ffc_map = mod.build(variant)

    circuit = builtins.default_circuit
    ERC()
    results = checks.run_all(circuit, board)
    (out / "ffc.json").write_text(json.dumps(ffc_map, indent=1) + "\n")
    (out / "i2c.json").write_text(json.dumps(checks.i2c_devices(circuit), indent=1) + "\n")

    net_path = out / f"{board}.net"
    generate_netlist(file_=str(net_path))
    # deterministic output: drop the timestamp so diffs show only real changes
    text = re.sub(r'\(date "[^"]*"\)', '(date "")', net_path.read_text())
    net_path.write_text(text)

    write_boms(circuit, out)
    for junk in list(out.glob("*_sklib.py")) + list(out.glob("*.erc")):
        junk.unlink()  # SKiDL side files
    with (out / "checks.txt").open("w") as f:
        for lvl, msg in results:
            f.write(f"{lvl:5} {msg}\n")
    n_err = sum(1 for lvl, _ in results if lvl == "ERROR")
    print(f"{board}-{variant_name}: {len(circuit.parts)} parts, {len(circuit.nets)} nets, "
          f"{n_err} check errors")
    return 1 if n_err else 0


def write_boms(circuit, out: Path) -> None:
    groups = defaultdict(list)
    for p in circuit.parts:
        if p.fields.get("BOM") == "exclude":
            continue
        key = (p.value, p.footprint, p.fields.get("MPN", ""), p.fields.get("LCSC", ""),
               p.fields.get("DNP", ""), p.fields.get("Verified", ""), p.description or "")
        groups[key].append(p.ref)

    def refkey(r):
        m = re.match(r"([A-Z]+)(\d+)", r)
        return (m.group(1), int(m.group(2))) if m else (r, 0)

    rows = sorted(groups.items(), key=lambda kv: (kv[0][4], refkey(sorted(kv[1], key=refkey)[0])))
    with (out / "bom.csv").open("w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["Refs", "Qty", "Value", "Description", "MPN", "LCSC", "Footprint", "Fitted",
                    "Verified"])
        for (value, fp, mpn, lcsc, dnp, ver, desc), refs in rows:
            refs = sorted(refs, key=refkey)
            w.writerow([" ".join(refs), len(refs), value, desc, mpn, lcsc, fp,
                        "DNP" if dnp else "yes", "yes" if ver == "yes" else f"[UNVERIFIED] {ver}"])
    with (out / "bom-jlc.csv").open("w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["Comment", "Designator", "Footprint", "LCSC"])
        for (value, fp, mpn, lcsc, dnp, ver, desc), refs in rows:
            if dnp:
                continue
            w.writerow([mpn or value, ",".join(sorted(refs, key=refkey)), fp.split(":")[-1], lcsc])


def main() -> int:
    sys.path.insert(0, str(HERE))
    from config import VARIANTS

    import checks

    BUILD.mkdir(exist_ok=True)
    rc = 0
    summary = []
    for variant in VARIANTS:
        for board in BOARDS:
            out = BUILD / f"{board}-{variant}"
            out.mkdir(parents=True, exist_ok=True)
            # point SKiDL at an empty KiCad library dir: all parts are defined in parts.py
            env = dict(os.environ, **{f"KICAD{v}_SYMBOL_DIR": str(HERE) for v in ("", "6", "7",
                                                                                    "8", "9", "10")})
            env["KICAD_SYMBOL_DIR"] = str(HERE)
            proc = subprocess.run(
                [sys.executable, str(Path(__file__).resolve()), "--one", board, variant],
                cwd=out, capture_output=True, text=True, env=env,
            )
            log = proc.stdout + proc.stderr
            erc = [line for line in log.splitlines() if line.startswith("ERC ")]
            (out / "erc.txt").write_text("\n".join(erc) + "\n")
            (out / "build.log").write_text(log)
            n_erc_err = sum(1 for line in erc if line.startswith("ERC ERROR"))
            n_erc_warn = sum(1 for line in erc if line.startswith("ERC WARNING"))
            status = proc.stdout.strip().splitlines()[-1] if proc.stdout.strip() else "crashed"
            summary.append(f"{status}; ERC {n_erc_err} errors / {n_erc_warn} warnings")
            if proc.returncode or n_erc_err:
                rc = 1
                if proc.returncode and "check errors" not in status:
                    summary.append(log[-3000:])
        def load(board):
            f = BUILD / f"{board}-{variant}" / "ffc.json"
            return json.loads(f.read_text()) if f.exists() else {}

        main_ffc, deck_ffc = load("main"), load("deck")
        ffc = checks.check_ffc(main_ffc, deck_ffc)
        i2c = {b: json.loads((BUILD / f"{b}-{variant}" / "i2c.json").read_text())
               for b in BOARDS if (BUILD / f"{b}-{variant}" / "i2c.json").exists()}
        bus = checks.check_i2c_union(i2c)
        summary.append(f"I2C bus ({variant}): " + "; ".join(m for _, m in bus))
        if any(lvl == "ERROR" for lvl, _ in bus):
            rc = 1
        summary.append(f"FFC main<->deck ({variant}): "
                       + ("OK" if not ffc else "; ".join(m for _, m in ffc)))
        if any(lvl == "ERROR" for lvl, _ in ffc):
            rc = 1
    text = "\n".join(summary) + "\n"
    (BUILD / "summary.txt").write_text(text)
    print(text, end="")
    return rc


if __name__ == "__main__":
    if len(sys.argv) == 4 and sys.argv[1] == "--one":
        sys.exit(one(sys.argv[2], sys.argv[3]))
    sys.exit(main())
