"""Dev helper: print pads (board coords) + courtyard bbox of refs: inspect_fp.py board REF..."""
import sys
import kienv  # noqa
import pcbnew
from build_board import unP
b = pcbnew.LoadBoard(str(kienv.KICAD_OUT / sys.argv[1] / f"{sys.argv[1]}.kicad_pcb"))
for ref in sys.argv[2:]:
    fp = b.FindFootprintByReference(ref)
    lay = pcbnew.B_CrtYd if fp.IsFlipped() else pcbnew.F_CrtYd
    bb = fp.GetCourtyard(lay).BBox()
    x0, y0 = unP(bb.GetOrigin()); x1, y1 = unP(bb.GetEnd())
    print(ref, fp.GetValue(), f"crtyd x {x0:.2f}..{x1:.2f} y {y0:.2f}..{y1:.2f}", "rot", fp.GetOrientationDegrees(), "B" if fp.IsFlipped() else "F")
    for p in fp.Pads():
        x, y = unP(p.GetPosition())
        print(f"   {p.GetNumber():>4} ({x:7.2f},{y:7.2f}) {p.GetNetname()}")
