"""Dump a board's footprints for the enclosure fit checks (run with KiCad's Python).

    python dump_parts.py <board> [out.json]

Board frame: x right, y down from the board's top-left corner (the rear-left corner), mm.
Per footprint: ref, side, position, courtyard bbox (or pad bbox when there is no courtyard),
whether it has through-hole pads, and its 3D model (resolved path, offset, rotation, scale) so
enclosure/proto_box.py can measure part heights from the STEP models.
"""

from __future__ import annotations

import json
import os
import sys

import kienv
from kienv import KICAD_OUT, MODEL_DIR, PROJECT_FP_LIB

import pcbnew


def resolve(path: str) -> str:
    for var in ("${KICAD10_3DMODEL_DIR}", "${KICAD9_3DMODEL_DIR}", "${KICAD8_3DMODEL_DIR}",
                "${KICAD7_3DMODEL_DIR}", "${KICAD6_3DMODEL_DIR}", "${KICAD_3DMODEL_DIR}"):
        path = path.replace(var, str(MODEL_DIR))
    path = path.replace("${KIPRJMOD}", str(KICAD_OUT))
    path = path.replace("${OLP_3DMODELS}", str(PROJECT_FP_LIB.parent / "openloungephone.3dshapes"))
    for ext in (".step", ".stp", ".STEP"):
        cand = os.path.splitext(path)[0] + ext
        if os.path.exists(cand):
            return cand
    return path if os.path.exists(path) else ""


def main() -> None:
    board = sys.argv[1]
    out = sys.argv[2] if len(sys.argv) > 2 else None
    b = pcbnew.LoadBoard(str(KICAD_OUT / board / f"{board}.kicad_pcb"))
    edge = b.GetBoardEdgesBoundingBox()
    lw = 0.05  # Edge.Cuts line width: the bbox includes half of it on each side
    ox, oy = pcbnew.ToMM(edge.GetX()) + lw / 2, pcbnew.ToMM(edge.GetY()) + lw / 2
    parts = []
    for f in b.GetFootprints():
        bottom = f.IsFlipped()
        cy = f.GetCourtyard(pcbnew.B_CrtYd if bottom else pcbnew.F_CrtYd)
        bb = cy.BBox() if cy.OutlineCount() else f.GetBoundingBox(False)
        crt = [pcbnew.ToMM(bb.GetX()) - ox, pcbnew.ToMM(bb.GetY()) - oy,
               pcbnew.ToMM(bb.GetRight()) - ox, pcbnew.ToMM(bb.GetBottom()) - oy]
        models = []
        for m in f.Models():
            if not m.m_Show:
                continue
            models.append({"path": resolve(m.m_Filename),
                           "offset": [m.m_Offset.x, m.m_Offset.y, m.m_Offset.z],
                           "rot": [m.m_Rotation.x, m.m_Rotation.y, m.m_Rotation.z],
                           "scale": [m.m_Scale.x, m.m_Scale.y, m.m_Scale.z]})
        pos = f.GetPosition()
        parts.append({
            "ref": f.GetReference(), "fp": str(f.GetFPID().GetLibItemName()),
            "side": "bottom" if bottom else "top",
            "at": [round(pcbnew.ToMM(pos.x) - ox, 3), round(pcbnew.ToMM(pos.y) - oy, 3)],
            "rot": f.GetOrientationDegrees(),
            "crt": [round(v, 3) for v in crt],
            "tht": any(p.GetAttribute() == pcbnew.PAD_ATTRIB_PTH for p in f.Pads()),
            "dnp": bool(f.IsDNP()) if hasattr(f, "IsDNP") else False,
            "models": models,
        })
    size = [pcbnew.ToMM(edge.GetWidth()) - lw, pcbnew.ToMM(edge.GetHeight()) - lw]
    data = {"board": board, "size": [round(v, 3) for v in size], "parts": parts}
    text = json.dumps(data, indent=1)
    if out:
        with open(out, "w") as fh:
            fh.write(text)
    else:
        print(text)


if __name__ == "__main__":
    main()
