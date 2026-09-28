"""Generate the project footprint library OpenLoungePhone (openloungephone.pretty) + simple 3D models.

    python gen_footprints.py        # any Python 3.9+; rewrites the .kicad_mod/.wrl files

Only parts with no suitable official KiCad footprint live here (official library first):
- Kailh_MX_Hotswap_CPG151101S11: MX switch holes + Kailh hot-swap socket pads. Drawn as the
  SOCKET sees the board (it is placed on the bottom side, so KiCad mirrors it back into the
  switch's top view). Geometry: Cherry MX PCB footprint (centre 4.0, pegs 1.75 @ +-5.08,
  pins 3.0 @ (-3.81,-2.54)/(2.54,-5.08)) and the widely used Kailh socket land
  (2.55 x 2.5 pads @ (-7.085,-2.54)/(5.842,-5.08)) - [UNVERIFIED] against the -2 suffix drawing.
- Electret_6mm_SMD_pads: 6 mm capsule with solder pads - [UNVERIFIED] pad pitch/can pad.
- Supercap_D11.5mm_P5.0mm: 11.5 mm radial, 5.0 mm pitch - [UNVERIFIED] part not chosen yet.
- NFC_Coil_Strip: 13.56 MHz PCB spiral (net-tie footprint, spiral on F.Cu, underpass on
  B.Cu), since the single board (2026-09-27) in the free front-left end region, 26 x 42 mm,
  9 turns. Inductance is estimated here with a filament Neumann integral; tune in EVT with the
  DNP cap.
- FPC-05F-24PH20: XUNPU 24P 0.5 mm flip-lock bottom-contact FPC connector (e-ink tail),
  land pattern from the XUNPU FPC-05F-NPH20 drawing: signal pads 0.30 x 1.25 on 0.5 mm,
  mounting pads 2.0 x 2.5 whose outer edge is 2.69 mm beyond pin 1/N and whose top edge is
  0.70 mm below the signal pads.

The RJ9 jack uses the official Connector_RJ:RJ9_Evercom_5301-440xxx_Horizontal (same part).
"""

from __future__ import annotations

import math
from pathlib import Path

HERE = Path(__file__).resolve().parent
LIB = HERE / "openloungephone.pretty"
MODELS = HERE / "openloungephone.3dshapes"
MODEL_REF = "${KIPRJMOD}/../../layout/footprints/openloungephone.3dshapes"

# NFC coil parameters: sized for the free front-left end region of the single board
# (boards.yaml keep-out NFC_LOOP). Width/spacing are well above every fab's minimum.
COIL = dict(w_out=26.0, h_out=42.0, turns=9, width=0.30, space=0.30)


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
    s += line(m * -6.1, -4.0, m * -6.1, -0.9, "F.SilkS")
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


def electret() -> str:
    s = header("Electret_6mm_SMD_pads",
               "6 mm electret capsule (GMI6027-2C42DB class) soldered on its terminal pads; "
               "pad 1 = OUT, pad 2 = GND/can [UNVERIFIED against drawing]",
               "electret microphone capsule", ref_at=(0, -4.2), val_at=(0, 4.2))
    s += smd("1", -1.3, 0, 1.2, 2.0)
    s += smd("2", 1.3, 0, 1.2, 2.0)
    s += circle(0, 0, 3.0, "F.Fab", 0.1)
    s += circle(0, 0, 3.15, "F.SilkS", 0.12)
    s += circle(0, 0, 3.4, "F.CrtYd", 0.05)
    s += text("-", 2.2, -1.9, "F.SilkS", 0.8)
    s += text("${REFERENCE}", 0, 0, "F.Fab", 0.8)
    s += model("Electret_6mm.wrl")
    s += "\t(embedded_fonts no)\n)\n"
    wrl_box(MODELS / "Electret_6mm.wrl", [(0, 0, 1.35, 5.4, 5.4, 2.7, (0.6, 0.6, 0.6))])
    return s


def supercap() -> str:
    s = header("Supercap_D11.5mm_P5.0mm",
               "Radial supercapacitor, D11.5 mm, 5.0 mm lead pitch (0.47 F 5.5 V hold-up) "
               "[UNVERIFIED: part not chosen]", "supercapacitor radial", attr="through_hole",
               ref_at=(2.5, -7), val_at=(2.5, 7))
    s += tht("1", 0, 0, 1.8, 1.0, shape="rect")
    s += tht("2", 5, 0, 1.8, 1.0)
    s += circle(2.5, 0, 5.75, "F.Fab", 0.1)
    s += circle(2.5, 0, 5.9, "F.SilkS", 0.12)
    s += circle(2.5, 0, 6.2, "F.CrtYd", 0.05)
    s += text("+", -1.8, -1.6, "F.SilkS", 1.0)
    s += text("${REFERENCE}", 2.5, 0, "F.Fab", 1.0)
    s += official_model("Capacitor_THT.3dshapes/CP_Radial_D12.5mm_P5.00mm.step")
    s += "\t(embedded_fonts no)\n)\n"
    return s


def fpc24() -> str:
    """XUNPU FPC-05F-24PH20 (C2856805). Pin 1 left, pads toward -y, FPC enters from +y."""
    n, pitch = 24, 0.5
    span = (n - 1) * pitch
    x1 = -span / 2
    my = 0.625 + 0.70 + 1.25            # mounting-pad centre: 0.70 below the signal pads
    mx = span / 2 + 2.69 - 1.0          # outer edge 2.69 beyond the end pins, pad 2.0 wide
    body_w = span + 4.90
    s = header("FPC-05F-24PH20",
               "XUNPU FPC-05F-24PH20 24P 0.5 mm FPC connector, flip lock, bottom contact, H2.0 "
               "(land pattern per the FPC-05F-NPH20 drawing)", "FPC FFC 0.5mm 24P flip",
               ref_at=(0, -2.2), val_at=(0, 6.0))
    for i in range(n):
        s += smd(str(i + 1), x1 + i * pitch, 0, 0.30, 1.25, shape="rect")
    s += smd("MP", -mx, my, 2.0, 2.5, shape="rect")
    s += smd("MP", mx, my, 2.0, 2.5, shape="rect")
    s += rect(-body_w / 2, 0.3, body_w / 2, 0.3 + 5.12, "F.Fab", 0.1)
    s += line(-body_w / 2, 0.9, -mx - 1.2, 0.9, "F.SilkS")
    s += line(body_w / 2, 0.9, mx + 1.2, 0.9, "F.SilkS")
    s += circle(x1, -1.2, 0.15, "F.SilkS", 0.3)
    s += rect(-body_w / 2 - 0.3, -0.95, body_w / 2 + 0.3, 0.3 + 5.12 + 0.3, "F.CrtYd", 0.05)
    s += text("${REFERENCE}", 0, 2.8, "F.Fab", 0.8)
    s += model("FPC-05F-24PH20.wrl")
    s += "\t(embedded_fonts no)\n)\n"
    wrl_box(MODELS / "FPC-05F-24PH20.wrl",
            [(0, 0.3 + 2.56, 1.0, body_w, 5.12, 2.0, (0.9, 0.9, 0.85))])
    return s


# ---------------------------------------------------------------------------------------------
def coil_path(w_out, h_out, turns, width, space):
    """Rectangular spiral centred at 0,0: returns (F.Cu polyline, inner end, pad1, pad2)."""
    p = width + space
    a = [w_out / 2 - width / 2 - i * p for i in range(turns + 1)]
    b = [h_out / 2 - width / 2 - i * p for i in range(turns + 1)]
    pts = [(a[0], b[0])]
    for k in range(turns):
        pts += [(a[k], -b[k]), (-a[k], -b[k]), (-a[k], b[k]), (a[k + 1], b[k])]
    inner = pts[-1]
    return pts, inner, a, b


def neumann_inductance(segs, width, thick=0.035, step=0.5):
    """L (H) of a polyline of straight segments via the discretised Neumann integral, with the
    GMD of the rectangular cross-section as the self-distance."""
    gmd = 0.2235 * (width + thick) * 1e-3
    pieces = []
    for (x1, y1), (x2, y2) in segs:
        n = max(1, int(math.hypot(x2 - x1, y2 - y1) / step))
        dx, dy = (x2 - x1) / n * 1e-3, (y2 - y1) / n * 1e-3
        for i in range(n):
            pieces.append(((x1 * 1e-3 + (i + 0.5) * dx), (y1 * 1e-3 + (i + 0.5) * dy), dx, dy))
    total = 0.0
    for i, (xi, yi, dxi, dyi) in enumerate(pieces):
        for xj, yj, dxj, dyj in pieces:
            dot = dxi * dxj + dyi * dyj
            if dot == 0:
                continue
            r = math.sqrt((xi - xj) ** 2 + (yi - yj) ** 2 + gmd ** 2)
            total += dot / r
    return 1e-7 * total


def nfc_coil() -> tuple[str, float]:
    c = COIL
    pts, inner, a, b = coil_path(**c)
    w = c["width"]
    t = c["turns"]
    xo = a[0] + 2.2  # terminal column, outside the loop
    y2 = b[t - 1]    # underpass row (inside the last turn's bottom side)
    descr = (f"13.56 MHz PCB loop for ST25DV (CTUN 28.5 pF): {t} turns, {w} mm / "
             f"{c['space']} mm, outer {c['w_out']} x {c['h_out']} mm; no copper pour inside the "
             "loop on any layer; underpass on B.Cu")
    s = header("NFC_Coil_Strip", descr, "NFC coil antenna 13.56MHz", attr="smd",
               ref_at=(xo + 1.5, b[0] + 2.5), val_at=(0, 0),
               extra='\t(net_tie_pad_groups "1, 2")\n')
    for (x1, y1), (x2, y2) in zip(pts, pts[1:]):
        s += line(x1, y1, x2, y2, "F.Cu", w)
    s += line(xo, b[0], a[0], b[0], "F.Cu", w)          # pad 1 -> spiral start
    s += line(inner[0], inner[1], inner[0], y2, "F.Cu", w)  # inner end -> via row
    s += line(inner[0], y2, xo, y2, "B.Cu", w)          # underpass out to pad 2
    s += smd("1", xo, b[0], 0.9, 0.9, shape="circle", layers=('"F.Cu"', '"F.Mask"'))
    s += tht("2", inner[0], y2, 0.6, 0.3)  # inner via (same net as terminal 2)
    s += tht("2", xo, y2, 0.9, 0.4)        # terminal 2 (both layers)
    s += rect(-c["w_out"] / 2 - 0.3, -c["h_out"] / 2 - 0.3, c["w_out"] / 2 + 0.3,
              c["h_out"] / 2 + 0.3, "F.CrtYd", 0.05)
    s += rect(c["w_out"] / 2 + 0.6, y2 - 0.8, xo + 0.8, b[0] + 0.8, "F.CrtYd", 0.05)
    s += text("NFC COIL - NO COPPER INSIDE", 0, -b[0] + 2.0, "F.Fab", 1.0)
    s += "\t(embedded_fonts no)\n)\n"
    segs = list(zip(pts, pts[1:])) + [((xo, b[0]), (a[0], b[0])),
                                       ((inner[0], y2), (xo, y2))]
    L = neumann_inductance(segs, w)
    return s, L


def main() -> None:
    LIB.mkdir(parents=True, exist_ok=True)
    MODELS.mkdir(parents=True, exist_ok=True)
    fps = {"Kailh_MX_Hotswap_CPG151101S11": hotswap(), "Electret_6mm_SMD_pads": electret(),
           "Supercap_D11.5mm_P5.0mm": supercap(), "FPC-05F-24PH20": fpc24()}
    coil, L = nfc_coil()
    fps["NFC_Coil_Strip"] = coil
    for name, text_ in fps.items():
        (LIB / f"{name}.kicad_mod").write_text(text_)
    c_tot = 1 / ((2 * math.pi * 13.56e6) ** 2 * L)
    print(f"NFC coil: L = {L * 1e6:.2f} uH (filament estimate); resonance at 13.56 MHz needs "
          f"{c_tot * 1e12:.1f} pF total vs ST25DV CTUN 28.5 pF -> tuning cap "
          f"{max(0.0, c_tot * 1e12 - 28.5):.1f} pF (minus parasitics)")


if __name__ == "__main__":
    main()
