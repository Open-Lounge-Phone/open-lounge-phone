"""Generate the project footprint library OpenLoungePhone (openloungephone.pretty) + 3D models.

    python gen_footprints.py        # any Python 3.9+; rewrites the .kicad_mod/.wrl files

Only parts with no suitable official KiCad footprint live here (official library first):
- Kailh_MX_Hotswap_CPG151101S11: MX switch holes + Kailh hot-swap socket pads. Drawn as the
  SOCKET sees the board (it is placed on the bottom side, so KiCad mirrors it back into the
  switch's top view). Geometry: Cherry MX PCB footprint (centre 4.0, pegs 1.75 @ +-5.08,
  pins 3.0 @ (-3.81,-2.54)/(2.54,-5.08)) and the widely used Kailh socket land
  (2.55 x 2.5 pads @ (-7.085,-2.54)/(5.842,-5.08)) - [UNVERIFIED] against the -2 suffix drawing.
  Used for the 12 keys and the hook switch.
- openloungephone_name_F: the board name "Open Lounge Phone" as front silkscreen text (the
  signature logo footprints come from hardware/art/make_logo.py).
"""

from __future__ import annotations

from pathlib import Path

HERE = Path(__file__).resolve().parent
LIB = HERE / "openloungephone.pretty"
MODELS = HERE / "openloungephone.3dshapes"
MODEL_REF = "${KIPRJMOD}/../../layout/footprints/openloungephone.3dshapes"

def f(x: float) -> str:
    s = f"{x:.4f}".rstrip("0").rstrip(".")
    return "0" if s in ("-0", "") else s


def header(name, descr, tags, attr="smd", ref_at=(0, -3), val_at=(0, 3), extra=""):
    return f'''(footprint "{name}"
\t(version 20260206)
\t(generator "openloungephone_gen")
\t(layer "F.Cu")
\t(descr "{descr}")
\t(tags "{tags}")
\t(property "Reference" "REF**"
\t\t(at {f(ref_at[0])} {f(ref_at[1])} 0)
\t\t(layer "F.SilkS")
\t\t(effects (font (size 1 1) (thickness 0.15)))
\t)
\t(property "Value" "{name}"
\t\t(at {f(val_at[0])} {f(val_at[1])} 0)
\t\t(layer "F.Fab")
\t\t(effects (font (size 1 1) (thickness 0.15)))
\t)
\t(property "Datasheet" "" (at 0 0 0) (layer "F.Fab") (hide yes)
\t\t(effects (font (size 1 1) (thickness 0.15))))
\t(property "Description" "{descr}" (at 0 0 0) (layer "F.Fab") (hide yes)
\t\t(effects (font (size 1 1) (thickness 0.15))))
\t(attr {attr})
{extra}'''


def line(x1, y1, x2, y2, layer, w=0.12):
    return (f'\t(fp_line (start {f(x1)} {f(y1)}) (end {f(x2)} {f(y2)}) '
            f'(stroke (width {f(w)}) (type solid)) (layer "{layer}"))\n')


def rect(x1, y1, x2, y2, layer, w=0.12):
    return (f'\t(fp_rect (start {f(x1)} {f(y1)}) (end {f(x2)} {f(y2)}) '
            f'(stroke (width {f(w)}) (type solid)) (fill no) (layer "{layer}"))\n')


def circle(cx, cy, r, layer, w=0.12):
    return (f'\t(fp_circle (center {f(cx)} {f(cy)}) (end {f(cx + r)} {f(cy)}) '
            f'(stroke (width {f(w)}) (type solid)) (fill no) (layer "{layer}"))\n')


def text(s, x, y, layer, size=1.0):
    return (f'\t(fp_text user "{s}" (at {f(x)} {f(y)} 0) (layer "{layer}") '
            f'(effects (font (size {f(size)} {f(size)}) (thickness {f(size * 0.15)}))))\n')


def smd(num, x, y, w, h, shape="roundrect", layers=('"F.Cu"', '"F.Paste"', '"F.Mask"')):
    rr = " (roundrect_rratio 0.1)" if shape == "roundrect" else ""
    return (f'\t(pad "{num}" smd {shape} (at {f(x)} {f(y)}) (size {f(w)} {f(h)}) '
            f'(layers {" ".join(layers)}){rr})\n')


def tht(num, x, y, size, drill, shape="circle"):
    return (f'\t(pad "{num}" thru_hole {shape} (at {f(x)} {f(y)}) (size {f(size)} {f(size)}) '
            f'(drill {f(drill)}) (layers "*.Cu" "*.Mask") (remove_unused_layers no))\n')


def npth(x, y, d):
    return (f'\t(pad "" np_thru_hole circle (at {f(x)} {f(y)}) (size {f(d)} {f(d)}) '
            f'(drill {f(d)}) (layers "*.Cu" "*.Mask"))\n')


def model(name, offset=(0, 0, 0), rot=(0, 0, 0)):
    return (f'\t(model "{MODEL_REF}/{name}"\n\t\t(offset (xyz {f(offset[0])} {f(offset[1])} '
            f'{f(offset[2])}))\n\t\t(scale (xyz 1 1 1))\n\t\t(rotate (xyz {f(rot[0])} '
            f'{f(rot[1])} {f(rot[2])}))\n\t)\n')


def official_model(path, offset=(0, 0, 0), rot=(0, 0, 0)):
    return (f'\t(model "${{KICAD10_3DMODEL_DIR}}/{path}"\n\t\t(offset (xyz {f(offset[0])} '
            f'{f(offset[1])} {f(offset[2])}))\n\t\t(scale (xyz 1 1 1))\n\t\t(rotate (xyz '
            f'{f(rot[0])} {f(rot[1])} {f(rot[2])}))\n\t)\n')


def wrl_box(path: Path, boxes):
    """VRML 2.0 made of boxes [(cx, cy, cz, sx, sy, sz, (r, g, b))] in mm (KiCad: 1 unit =
    2.54 mm in VRML, so sizes are divided by 2.54). Y is flipped (VRML y up = board -y)."""
    k = 1 / 2.54
    out = ["#VRML V2.0 utf8\n"]
    for cx, cy, cz, sx, sy, sz, col in boxes:
        out.append(
            f"Transform {{ translation {cx * k:.4f} {-cy * k:.4f} {cz * k:.4f} children [ Shape {{"
            f" appearance Appearance {{ material Material {{ diffuseColor {col[0]} {col[1]} "
            f"{col[2]} }} }} geometry Box {{ size {sx * k:.4f} {sy * k:.4f} {sz * k:.4f} }} }} ] }}\n")
    path.write_text("".join(out))


# ---------------------------------------------------------------------------------------------
def hotswap() -> str:
    """Kailh MX hot-swap socket + MX switch holes, drawn from the socket (bottom) side, i.e.
    the switch top view mirrored in x. Pad 1 = left switch pin, pad 2 = right switch pin (as
    seen from the top)."""
    m = -1  # mirror x: footprint is flipped onto B.Cu, which mirrors it back
    s = header("Kailh_MX_Hotswap_CPG151101S11",
               "Kailh CPG151101S11 MX hot-swap socket (place on the bottom side) + Cherry MX "
               "PCB holes; SK6812MINI-E is a separate footprint at (0, +5.08) top view",
               "MX hotswap Kailh keyboard", attr="smd", ref_at=(0, 8.9), val_at=(0, 10.4))
    s += npth(0, 0, 4.0)
    s += npth(m * -5.08, 0, 1.75)
    s += npth(m * 5.08, 0, 1.75)
    s += npth(m * -3.81, -2.54, 3.0)
    s += npth(m * 2.54, -5.08, 3.0)
    s += smd("1", m * -7.085, -2.54, 2.55, 2.5)
    s += smd("2", m * 5.842, -5.08, 2.55, 2.5)
    # socket body (approximate, from the common Kailh land drawings): two cups + bridge
    body = [(-5.9, -3.8, -1.5, -0.6), (-1.5, -6.9, 4.9, -2.3), (-5.9, -3.8, -1.5, -1.0)]
    for x1, y1, x2, y2 in body[:2]:
        s += rect(m * x1, y1, m * x2, y2, "F.Fab", 0.1)
    s += rect(m * -8.6, -7.4, m * 7.4, -0.3, "F.CrtYd", 0.05)
    # MX switch body outline (top side; for reference only)
    s += rect(-7, -7, 7, 7, "B.Fab", 0.1)
    s += line(m * -5.45, -4.0, m * -5.45, -0.9, "F.SilkS")   # clear of pad 1 (5.81..8.36)
    s += line(m * 4.9, -7.1, m * 4.9, -6.4, "F.SilkS")
    s += text("${REFERENCE}", 0, -8.2, "F.Fab", 0.8)
    s += model("Kailh_CPG151101S11.wrl")
    s += "\t(embedded_fonts no)\n)\n"
    wrl_box(MODELS / "Kailh_CPG151101S11.wrl", [
        (m * -3.7, -2.2, 0.93, 4.4, 3.2, 1.85, (0.1, 0.1, 0.1)),
        (m * 1.7, -4.6, 0.93, 6.4, 4.6, 1.85, (0.1, 0.1, 0.1)),
        (m * -7.1, -2.54, 0.1, 1.8, 1.7, 0.2, (0.8, 0.7, 0.3)),
        (m * 5.85, -5.08, 0.1, 1.8, 1.7, 0.2, (0.8, 0.7, 0.3)),
    ])
    return s


def name_text() -> str:
    """'Open Lounge Phone' on F.SilkS: 3.0 mm text, 0.45 mm strokes (>= every fab's minimum)."""
    s = header("openloungephone_name_F", "Board name Open Lounge Phone, front silkscreen",
               "logo text", attr="board_only exclude_from_pos_files exclude_from_bom "
               "allow_missing_courtyard", ref_at=(0, -3), val_at=(0, 3))
    s = s.replace('(layer "F.SilkS")\n\t\t(effects', '(layer "F.Fab") (hide yes)\n\t\t(effects', 1)
    s += text("Open Lounge Phone", 0, 0, "F.SilkS", 3.0)
    s += "\t(embedded_fonts no)\n)\n"
    return s


def main() -> None:
    LIB.mkdir(parents=True, exist_ok=True)
    MODELS.mkdir(parents=True, exist_ok=True)
    fps = {"Kailh_MX_Hotswap_CPG151101S11": hotswap(), "openloungephone_name_F": name_text()}
    for name, text_ in fps.items():
        (LIB / f"{name}.kicad_mod").write_text(text_)


if __name__ == "__main__":
    main()
