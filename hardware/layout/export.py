"""Fab + review outputs of the routed board (KiCad Python + kicad-cli).

    <KiCad python> export.py main [--previews DIR]        # (make fab)

Writes build/<board>/fab/ (generated, git-ignored):
  <board>-gerbers.zip   Gerber X2 (2 copper layers, mask, paste, silk, outline) + Excellon
                        drill (PTH and NPTH) + job file: upload this to any fab
  gerbers/              the same files unzipped
  bom-jlc.csv           JLCPCB BOM (Comment, Designator, Footprint, LCSC) from the schematic build
  cpl-jlc.csv           JLCPCB placement (Designator, Mid X, Mid Y, Layer, Rotation), fitted parts
  cpl-rotations.txt     how each JLC rotation was derived (check them in JLC's placement preview)
  bom.csv, cpl.csv      generic BOM (MPN, manufacturer, LCSC, DigiKey/Mouser search) and
                        pick-and-place (KiCad's own rotation convention)
  <board>.ipc2581.xml   IPC-2581C: stackup, copper, netlist and BOM in one file
  <board>.step          3D assembly
  render-top.png, render-bottom.png, render-iso.png   3D renders
  layers.pdf            one page per layer (copper, silk, mask) with the outline
  routed-top.png, routed-bottom.png   2D copper + silk (bottom seen from below)
  README.md             what each file is
--previews DIR also copies routed-top.png, routed-bottom.png and layers.pdf there.
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

import kienv  # noqa: F401
from kienv import BUILD, KICAD_CLI, KICAD_OUT, TOOLS

import pcbnew  # noqa: E402

LAYERS = "F.Cu,B.Cu,F.Paste,B.Paste,F.SilkS,B.SilkS,F.Mask,B.Mask,Edge.Cuts"
PDF_LAYERS = "F.Cu,B.Cu,F.Silkscreen,B.Silkscreen,F.Mask,B.Mask"

# JLCPCB's part models are not all drawn in KiCad's zero orientation. Offsets (degrees, added
# to the rotation as seen from the part's own side) from the community rotation tables used by
# kicad-jlcpcb-tools / JLCKicadTools; packages not listed are taken as 0 and flagged "verify".
JLC_OFFSETS = [
    (r"^SOT-223", 180, "table"), (r"^SOT-23", 180, "table"), (r"^QFN-", 270, "table"),
    (r"^[RC]_0603|^[RC]_0805|^LED_1206", 0, "table"),
]


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


def jlc_rotation(fp) -> tuple[float, str]:
    """JLC rotation of a fitted part and how it was derived. KiCad stores a bottom part's
    angle as 180 - (its angle seen from the top); seen from the bottom (board turned over
    left-right) the part is un-mirrored at 180 - stored, and JLC's package offset applies in
    that view (the kicad-jlcpcb-tools convention)."""
    name = str(fp.GetFPID().GetLibItemName())
    rot = fp.GetOrientationDegrees() % 360
    base = (180 - rot) % 360 if fp.IsFlipped() else rot
    for rx, off, src in JLC_OFFSETS:
        if re.search(rx, name):
            return (base + off) % 360, f"{'bottom: 180 - ' if fp.IsFlipped() else ''}{rot:g}" \
                f" + {off} ({src})"
    return base, f"{'bottom: 180 - ' if fp.IsFlipped() else ''}{rot:g} + 0 (verify in JLC preview)"


def write_cpl(board, pos_csv: Path, out: Path) -> None:
    rows = list(csv.DictReader(pos_csv.open()))
    fps = {fp.GetReference(): fp for fp in board.GetFootprints()}
    with (out / "cpl.csv").open("w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["Ref", "Value", "Footprint", "PosX_mm", "PosY_mm", "Rot_deg", "Side"])
        for r in rows:
            w.writerow([r["Ref"], r["Val"], r["Package"], r["PosX"], r["PosY"], r["Rot"], r["Side"]])
    notes = ["JLC rotation per part (degrees): how it was derived. 'verify' = no offset table",
             "entry for the package: check pin 1 in JLC's placement preview before ordering.", ""]
    with (out / "cpl-jlc.csv").open("w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["Designator", "Mid X", "Mid Y", "Layer", "Rotation"])
        for r in rows:
            fp = fps[r["Ref"]]
            rot, why = jlc_rotation(fp)
            w.writerow([r["Ref"], f"{float(r['PosX']):.4f}mm", f"{float(r['PosY']):.4f}mm",
                        "Top" if r["Side"] == "top" else "Bottom", f"{rot:g}"])
            notes.append(f"{r['Ref']:5} {r['Side']:6} {str(fp.GetFPID().GetLibItemName())[:44]:44} "
                         f"{rot:6g}  = {why}")
    (out / "cpl-rotations.txt").write_text("\n".join(notes) + "\n")


def write_boms(board_name: str, out: Path) -> None:
    src = BUILD / board_name / "bom.csv"
    rows = list(csv.DictReader(src.open()))
    with (out / "bom.csv").open("w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["Refs", "Qty", "Value", "Description", "Manufacturer", "Manufacturer_PN",
                    "LCSC", "JLC library", "DigiKey_search", "Mouser_search", "Footprint",
                    "Verified"])
        for r in rows:
            mpn = r["MPN"]
            q = urllib.parse.quote(mpn) if mpn else ""
            w.writerow([r["Refs"], r["Qty"], r["Value"], r["Description"], r["Manufacturer"], mpn,
                        r["LCSC"], r["JLC library"],
                        f"https://www.digikey.com/en/products/result?keywords={q}" if q else "",
                        f"https://www.mouser.com/c/?q={q}" if q else "",
                        r["Footprint"], r["Verified"]])
    shutil.copy(BUILD / board_name / "bom-jlc.csv", out / "bom-jlc.csv")


def svg_png(svg: Path, png: Path, aspect: float, size=2400) -> None:
    """SVG -> PNG with macOS Quick Look (no extra tools); Quick Look draws into a square
    canvas from the top, so the board strip (height = aspect x width) is cropped out."""
    tmp = svg.parent
    subprocess.run(["qlmanage", "-t", "-s", str(size), "-o", str(tmp), str(svg)],
                   capture_output=True)
    shutil.move(str(tmp / (svg.name + ".png")), png)
    subprocess.run(["sips", "-c", str(int(round(size * aspect)) + 2), str(size),
                    "--cropOffset", "0", "0", str(png)], capture_output=True)


def pictures(pcb: Path, out: Path, tmp: Path) -> None:
    common = ["--width", "2000", "--height", "1200", "--quality", "high", "--background",
              "opaque"]
    cli("pcb", "render", pcb, "-o", out / "render-top.png", "--side", "top", *common)
    cli("pcb", "render", pcb, "-o", out / "render-bottom.png", "--side", "bottom", *common)
    cli("pcb", "render", pcb, "-o", out / "render-iso.png", "--rotate", "-40,0,-30",
        "--perspective", "--zoom", "0.9", *common)
    cli("pcb", "export", "pdf", pcb, "-o", out / "layers.pdf", "--mode-multipage",
        "-l", PDF_LAYERS, "--cl", "Edge.Cuts", "--include-border-title", "--drill-shape-opt", "2")
    for side, layers, mirror in (("top", "F.Cu,F.Silkscreen,F.Mask,Edge.Cuts", []),
                                 ("bottom", "B.Cu,B.Silkscreen,B.Mask,Edge.Cuts", ["--mirror"])):
        svg = tmp / f"routed-{side}.svg"
        cli("pcb", "export", "svg", pcb, "-o", svg, "--mode-single", "--fit-page-to-board",
            "--exclude-drawing-sheet", "--drill-shape-opt", "2", "-l", layers, *mirror)
        svg_png(svg, out / f"routed-{side}.png", 88.0 / 156.0)


README = """# {board} fabrication and review outputs

Generated by hardware/layout/export.py (`make fab`) from hardware/kicad/{board}/. Do not edit.

| File | What |
|---|---|
| `{board}-gerbers.zip` | Gerber X2 + Excellon drill (PTH and NPTH) + job file: upload this to any fab |
| `gerbers/` | the same files unzipped (layers below) |
| `bom-jlc.csv`, `cpl-jlc.csv` | JLCPCB assembly BOM + placement; `cpl-rotations.txt` says how each rotation was derived |
| `bom.csv`, `cpl.csv` | generic BOM (MPN, manufacturer, LCSC, DigiKey/Mouser search links) and pick-and-place |
| `{board}.ipc2581.xml` | IPC-2581C: stackup, copper, netlist and BOM in one file |
| `{board}.step` | 3D assembly |
| `render-*.png` | 3D renders (top, bottom, isometric) |
| `layers.pdf` | one page per layer: copper, silkscreen, mask (with the outline) |
| `routed-top.png`, `routed-bottom.png` | copper + silkscreen; the bottom is seen from below |
| `jlc-order.txt` | JLCPCB reference quote for one order of 5 assembled boards (EST) |

Board: 2 layers, FR-4 1.6 mm, 1 oz, HASL lead-free, green mask, white silk, 156 x 88 mm.
Rules: 0.15/0.15 mm track/space minimum (0.2 mm used for signals), 0.3 mm drill, 0.6 mm vias
(common 2-layer capability). Assembly: every SMD part on the BOTTOM (one-sided economic
PCBA); J3 and BZ1 are through-hole on the top. Check pin 1 of each part in the fab's placement
preview before ordering: package zero orientations differ between libraries
(`cpl-rotations.txt` marks the ones without a table entry).

Gerber layers: {layers}
"""


def export_board(board_name: str, previews: Path | None) -> None:
    out = BUILD / board_name / "fab"
    if out.exists():
        shutil.rmtree(out)
    out.mkdir(parents=True)
    tmp = TOOLS / "tmp" / board_name
    if tmp.exists():
        shutil.rmtree(tmp)
    shutil.copytree(KICAD_OUT / board_name, tmp, ignore=shutil.ignore_patterns("route"))
    pcb = tmp / f"{board_name}.kicad_pcb"
    board = pcbnew.LoadBoard(str(pcb))
    g = out / "gerbers"
    g.mkdir()
    cli("pcb", "export", "gerbers", pcb, "-o", g, "-l", LAYERS, "--subtract-soldermask")
    cli("pcb", "export", "drill", pcb, "-o", g, "--format", "excellon",
        "--excellon-separate-th", "--excellon-units", "mm", "--generate-map", "--map-format", "pdf")
    for f in g.iterdir():
        strip_dates(f)
    deterministic_zip(g, out / f"{board_name}-gerbers.zip")
    cli("pcb", "export", "pos", pcb, "-o", tmp / "pos.csv", "--format", "csv", "--units", "mm",
        "--side", "both", "--exclude-dnp")
    write_cpl(board, tmp / "pos.csv", out)
    write_boms(board_name, out)
    ipc = out / f"{board_name}.ipc2581.xml"
    cli("pcb", "export", "ipc2581", pcb, "-o", ipc, "--bom-col-mfg-pn", "MPN",
        "--bom-col-mfg", "Manufacturer", "--bom-col-dist-pn", "LCSC", "--bom-col-dist", "LCSC")
    strip_dates(ipc)
    step = out / f"{board_name}.step"
    cli("pcb", "export", "step", pcb, "-o", step, "--force", "--no-dnp", "--subst-models")
    strip_dates(step)
    pictures(pcb, out, tmp)
    (out / "README.md").write_text(README.format(
        board=board_name, layers=", ".join(sorted(p.name for p in g.iterdir()))))
    if previews:
        previews.mkdir(parents=True, exist_ok=True)
        for name in ("routed-top.png", "routed-bottom.png", "layers.pdf"):
            shutil.copy(out / name, previews / name)
    print(f"exported {board_name} -> {out}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("board", choices=["main"])
    ap.add_argument("--previews", type=Path, help="also copy the owner previews here")
    a = ap.parse_args()
    export_board(a.board, a.previews)


if __name__ == "__main__":
    main()
