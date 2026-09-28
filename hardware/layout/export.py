"""Fab + review outputs per board and variant (KiCad Python + kicad-cli).

    python export.py main|plate [--variant kids]

Writes build/<board>-<variant>/layout/ (plate: build/plate/):
  gerbers/  Gerber X2 + Excellon (PTH/NPTH) + job file, and <board>-<variant>-gerbers.zip
  <board>-<variant>.ipc2581.xml   IPC-2581C (stackup, netlist, BOM with MPN/manufacturer/LCSC)
  cpl-jlc.csv      JLCPCB CPL (Designator, Mid X, Mid Y, Layer, Rotation), fitted parts only
  cpl.csv          generic pick-and-place (Ref, Value, Footprint, X, Y, Rot, Side), fitted only
  bom-jlc.csv      JLCPCB BOM (copied from the schematic build, fitted parts only)
  bom.csv          generic BOM: MPN, manufacturer, LCSC, DigiKey/Mouser search links, DNP
  <board>-<variant>.step          3D assembly (DNP parts left out)
  render-top.png, render-bottom.png, render-iso.png   kicad-cli 3D renders (DNP left out)
  README.md        what each file is
Variants differ only by DNP: the committed board has every footprint; DNP flags are set from
build/<board>-<variant>/<board>.net on a temporary copy before exporting.
"""

from __future__ import annotations

import argparse
import csv
import re
import shutil
import subprocess
import urllib.parse
import zipfile
from pathlib import Path

import kienv
from kienv import BUILD, KICAD_CLI, KICAD_OUT, LAYOUT, TOOLS, load_yaml

import pcbnew  # noqa: E402

import netlist as nl  # noqa: E402

LAYERS = "F.Cu,In1.Cu,In2.Cu,B.Cu,F.Paste,B.Paste,F.SilkS,B.SilkS,F.Mask,B.Mask,Edge.Cuts"


def cli(*args):
    r = subprocess.run([KICAD_CLI, *map(str, args)], capture_output=True, text=True)
    if r.returncode:
        raise SystemExit(f"kicad-cli {' '.join(map(str, args[:3]))} failed:\n{r.stdout}{r.stderr}")
    return r


_DATE_PATTERNS = [
    (re.compile(r"^%TF\.CreationDate,.*\*%\n", re.M), ""),
    (re.compile(r"^G04 Created by KiCad.*date.*\n", re.M), ""),
    (re.compile(r"^; DRILL file .* date .*\n", re.M), ""),
    (re.compile(r"^;.*[Cc]reated on .*\n", re.M), ""),
    (re.compile(r"^## Created on .*\n", re.M), ""),
    (re.compile(r'"CreationDate": "[^"]*"'), '"CreationDate": ""'),
    (re.compile(r"FILE_NAME\('([^']*)','[^']*'"), r"FILE_NAME('\1','1970-01-01T00:00:00'"),
    (re.compile(r'createdOn="[^"]*"'), 'createdOn=""'),
    (re.compile(r'dateTime="[^"]*"'), 'dateTime=""'),
]


def strip_dates(path: Path) -> None:
    try:
        text = path.read_text()
    except UnicodeDecodeError:
        return
    for rx, rep in _DATE_PATTERNS:
        text = rx.sub(rep, text)
    path.write_text(text)


def deterministic_zip(src: Path, dst: Path) -> None:
    with zipfile.ZipFile(dst, "w", zipfile.ZIP_DEFLATED) as z:
        for f in sorted(src.iterdir()):
            info = zipfile.ZipInfo(f.name, date_time=(1980, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            z.writestr(info, f.read_bytes())


def variant_copy(board_name: str, variant: str, tmp: Path) -> tuple[Path, nl.Netlist]:
    """Copy the project to tmp and set DNP flags for this variant."""
    src = KICAD_OUT / board_name
    if tmp.exists():
        shutil.rmtree(tmp)
    shutil.copytree(src, tmp, ignore=shutil.ignore_patterns("route"))
    cfg = load_yaml(LAYOUT / "boards.yaml")[board_name]
    net = nl.read(BUILD / f"{board_name}-{variant}" / f"{cfg['netlist']}.net")
    pcb = tmp / f"{board_name}.kicad_pcb"
    board = pcbnew.LoadBoard(str(pcb))
    for fp in board.GetFootprints():
        c = net.comps.get(fp.GetReference())
        if c is not None:
            fp.SetDNP(c.dnp)
            fp.SetExcludedFromPosFiles(c.dnp or c.fields.get("BOM") == "exclude")
            fp.SetExcludedFromBOM(c.dnp or c.fields.get("BOM") == "exclude")
    pcbnew.SaveBoard(str(pcb), board)
    return pcb, net


def write_cpl(pos_csv: Path, out: Path, net: nl.Netlist) -> None:
    rows = list(csv.DictReader(pos_csv.open()))
    with (out / "cpl.csv").open("w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["Ref", "Value", "Footprint", "PosX_mm", "PosY_mm", "Rot_deg", "Side"])
        for r in rows:
            w.writerow([r["Ref"], r["Val"], r["Package"], r["PosX"], r["PosY"], r["Rot"],
                        r["Side"]])
    with (out / "cpl-jlc.csv").open("w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["Designator", "Mid X", "Mid Y", "Layer", "Rotation"])
        for r in rows:
            w.writerow([r["Ref"], f"{float(r['PosX']):.4f}mm", f"{float(r['PosY']):.4f}mm",
                        "Top" if r["Side"] == "top" else "Bottom", r["Rot"]])


def write_generic_bom(board_name: str, variant: str, out: Path) -> None:
    src = BUILD / f"{board_name}-{variant}" / "bom.csv"
    rows = list(csv.DictReader(src.open()))
    with (out / "bom.csv").open("w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["Refs", "Qty", "Value", "Description", "Manufacturer_PN", "LCSC",
                    "DigiKey_search", "Mouser_search", "Footprint", "Fitted", "Verified"])
        for r in rows:
            mpn = r["MPN"]
            q = urllib.parse.quote(mpn) if mpn else ""
            w.writerow([r["Refs"], r["Qty"], r["Value"], r["Description"], mpn, r["LCSC"],
                        f"https://www.digikey.com/en/products/result?keywords={q}" if q else "",
                        f"https://www.mouser.com/c/?q={q}" if q else "",
                        r["Footprint"], r["Fitted"], r["Verified"]])
    shutil.copy(BUILD / f"{board_name}-{variant}" / "bom-jlc.csv", out / "bom-jlc.csv")


def renders(pcb: Path, out: Path) -> None:
    common = ["--width", "1800", "--height", "1200", "--quality", "basic", "--background",
              "opaque"]
    cli("pcb", "render", pcb, "-o", out / "render-top.png", "--side", "top", *common)
    cli("pcb", "render", pcb, "-o", out / "render-bottom.png", "--side", "bottom", *common)
    cli("pcb", "render", pcb, "-o", out / "render-iso.png", "--rotate", "-40,0,-30",
        "--perspective", "--zoom", "0.9", *common)


README = """# {board} ({variant}) fabrication and review outputs

Generated by `make layout` (hardware/layout/export.py) from hardware/kicad/{board}/. Do not edit.
Variant `{variant}` differs from the others only by DNP (not-fitted) parts.

| File | What |
|---|---|
| `{board}-{variant}-gerbers.zip` | Gerber X2 + Excellon drill (PTH and NPTH) + job file: upload this to any fab |
| `gerbers/` | the same files unzipped (layer list below) |
| `{board}-{variant}.ipc2581.xml` | IPC-2581C: stackup, copper, netlist and BOM (MPN, manufacturer, LCSC) in one file |
| `bom-jlc.csv`, `cpl-jlc.csv` | JLCPCB assembly BOM + placement (reference path) |
| `bom.csv`, `cpl.csv` | generic BOM (MPN, manufacturer, LCSC, DigiKey/Mouser search links; DigiKey/Mouser part numbers not verified) and generic pick-and-place |
| `{board}-{variant}.step` | 3D assembly, fitted parts only |
| `render-*.png` | 3D renders (top, bottom, isometric), fitted parts only |
| `drc.json`, `drc.rpt`, `checks.txt` | DRC and layout checks (hardware/layout/checks.py) |

Stackup: generic 1.6 mm 4-layer, 7628 prepreg (JLC04161H-7628 or any fab's standard
4-layer): L1 signal + parts, L2 solid GND, L3 power pours + slow signals, L4 signal + GND.
Finish ENIG. Rules: 0.15/0.15 mm track/space, 0.3 mm drill, 0.6 mm vias (common capability).
Check the pick-and-place rotation preview in the fab's tool before ordering (package zero
orientation differs between libraries).

Gerber layers: {layers}
"""


def export_board(board_name: str, variant: str) -> None:
    out = BUILD / f"{board_name}-{variant}" / "layout"
    out.mkdir(parents=True, exist_ok=True)
    tmp = TOOLS / "tmp" / f"{board_name}-{variant}"
    pcb, net = variant_copy(board_name, variant, tmp)
    g = out / "gerbers"
    if g.exists():
        shutil.rmtree(g)
    g.mkdir()
    cli("pcb", "export", "gerbers", pcb, "-o", g, "-l", LAYERS, "--subtract-soldermask")
    cli("pcb", "export", "drill", pcb, "-o", g, "--format", "excellon",
        "--excellon-separate-th", "--excellon-units", "mm")
    for f in g.iterdir():
        strip_dates(f)
    deterministic_zip(g, out / f"{board_name}-{variant}-gerbers.zip")
    cli("pcb", "export", "pos", pcb, "-o", tmp / "pos.csv", "--format", "csv", "--units", "mm",
        "--side", "both", "--exclude-dnp")
    write_cpl(tmp / "pos.csv", out, net)
    write_generic_bom(board_name, variant, out)
    ipc = out / f"{board_name}-{variant}.ipc2581.xml"
    cli("pcb", "export", "ipc2581", pcb, "-o", ipc, "--bom-col-mfg-pn", "MPN",
        "--bom-col-mfg", "Manufacturer", "--bom-col-dist-pn", "LCSC", "--bom-col-dist", "LCSC")
    strip_dates(ipc)
    step = out / f"{board_name}-{variant}.step"
    cli("pcb", "export", "step", pcb, "-o", step, "--force", "--no-dnp", "--subst-models")
    strip_dates(step)
    renders(pcb, out)
    (out / "README.md").write_text(README.format(board=board_name, variant=variant,
                                                 layers=", ".join(sorted(p.name for p in g.iterdir()))))
    print(f"exported {board_name}-{variant} -> {out}")


def export_plate() -> None:
    out = BUILD / "plate"
    out.mkdir(parents=True, exist_ok=True)
    pcb = KICAD_OUT / "plate" / "plate.kicad_pcb"
    g = out / "gerbers"
    if g.exists():
        shutil.rmtree(g)
    g.mkdir()
    cli("pcb", "export", "gerbers", pcb, "-o", g, "-l", "Edge.Cuts,F.SilkS,F.Mask,B.Mask")
    cli("pcb", "export", "drill", pcb, "-o", g, "--format", "excellon", "--excellon-units", "mm")
    for f in g.iterdir():
        strip_dates(f)
    deterministic_zip(g, out / "plate-gerbers.zip")
    cli("pcb", "export", "dxf", pcb, "-o", out / "plate-outline.dxf", "-l", "Edge.Cuts",
        "--mode-single", "--ou", "mm")
    strip_dates(out / "plate-outline.dxf")
    common = ["--width", "1600", "--height", "1200", "--quality", "basic", "--background",
              "opaque"]
    cli("pcb", "render", pcb, "-o", out / "render-top.png", "--side", "top", *common)
    (out / "README.md").write_text(
        "# Key plate outputs\n\nFR4 1.5-1.6 mm, **no copper** (order as a 2-layer board with no "
        "copper, or laser/CNC-cut the DXF).\nMX cut-outs 14.0 mm at 19.05 mm pitch, e-ink pocket "
        "79.4 x 37.1 mm, M2.5 clearance holes, light-pipe holes.\n\n- `plate-gerbers.zip`, "
        "`gerbers/`: outline + silk\n- `plate-outline.dxf`: outline for laser/CNC (mm)\n"
        "- `render-top.png`\n")
    print(f"exported plate -> {out}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("board", choices=["main", "plate"])
    ap.add_argument("--variant", default="kids")
    a = ap.parse_args()
    if a.board == "plate":
        export_plate()
    else:
        export_board(a.board, a.variant)


if __name__ == "__main__":
    main()
