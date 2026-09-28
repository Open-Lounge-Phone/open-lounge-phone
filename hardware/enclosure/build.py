#!/usr/bin/env python3
"""Open Lounge Phone enclosure build: every part -> STL (print orientation) + STEP (assembled
position), automated checks, PNG renders, web GLBs + manifest.

    .venv/bin/python build.py [--no-render] [--no-web] [--no-diy]      (or: make)

Exit status 1 if any check FAILs."""

from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

from build123d import Compound, Pos, export_step, export_stl

sys.path.insert(0, str(Path(__file__).resolve().parent))

from olp.common import Geo, load_params, union  # noqa: E402
from olp.parts import Build, to_bed  # noqa: E402
from olp import checks, handset, hook  # noqa: E402

OUT = Path(__file__).resolve().parent / "build"


def log(msg, t0=[time.time()]):
    print(f"[{time.time() - t0[0]:6.1f}s] {msg}", flush=True)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--no-render", action="store_true")
    ap.add_argument("--no-web", action="store_true")
    ap.add_argument("--no-diy", action="store_true", help="skip the optional printable DIY handset")
    a = ap.parse_args()

    g = Geo(load_params())
    B = Build(g, with_diy_handset=not a.no_diy)
    (OUT / "stl").mkdir(parents=True, exist_ok=True)
    (OUT / "step").mkdir(parents=True, exist_ok=True)
    log(f"main board: {g.mb['source']}")

    summary = {"parts": [], "base": dict(L=g.L, D=g.D, H=g.H), "key_stack": {k: round(v, 3) for k, v in g.ks.items()},
               "plunger": {k: round(v, 3) for k, v in g.pl.items()}, "posts": g.posts,
               "tube_cut_list": hook.cut_list(g)}
    for part in B.printed:
        bed = to_bed(part.shape, part.orient)
        export_stl(bed, OUT / "stl" / f"{part.name}.stl", tolerance=0.02, angular_tolerance=0.1)
        export_step(part.shape, OUT / "step" / f"{part.name}.step")
        bb = bed.bounding_box()
        summary["parts"].append(dict(name=part.name, qty=part.qty, material=part.material, note=part.note,
                                     bed_mm=[round(bb.size.X, 1), round(bb.size.Y, 1), round(bb.size.Z, 1)],
                                     volume_cm3=round(part.shape.volume / 1000, 1)))
        log(f"exported {part.name}")
    for nm in ("handset_pop", "handset_g1"):
        export_step(B.refs[nm], OUT / "step" / f"ref_{nm}.step")
    asm = [B.part("base_top").shape, B.part("base_bottom").shape, B.part("speaker_lid").shape, B.part("light_bar").shape,
           B.part("saddle_pop_left").shape, B.part("saddle_pop_right").shape, B.refs["main_pcb"], B.refs["deck_pcb"],
           B.refs["key_plate"], B.refs["eink"], B.refs["handset_pop"]] + B.refs["switches"] + B.refs["keycaps"] + \
        B.refs["tubes"] + B.refs["plungers"]
    export_step(Compound(asm), OUT / "step" / "assembly.step")
    log("assembly.step")
    (OUT / "summary.json").write_text(json.dumps(summary, indent=1))

    R = checks.run(g, B)
    checks.write(R, OUT)
    log("checks:\n" + R.text())

    if not a.no_render:
        from olp import renders
        renders.all(g, B, OUT / "renders")
        log("renders")
    if not a.no_web:
        from olp import web
        man, total = web.export(g, B, OUT / "web")
        mx = max(e["triangles"] for e in man["parts"])
        log(f"web: {len(man['parts'])} GLBs, {total / 1e6:.2f} MB total, max {mx} triangles/part")
    return 1 if R.failed else 0


if __name__ == "__main__":
    sys.exit(main())
