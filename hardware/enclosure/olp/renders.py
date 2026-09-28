"""PNG renders for review: assembled (POP and G1 handsets), top/front/rear, exploded, sections
through the key stack and the hook post, every printed part in its print orientation, and the
reference handset next to the owner's reference photos."""

from __future__ import annotations

from pathlib import Path

from build123d import Pos

from .common import Geo, union
from .parts import Build, to_bed
from .render import mesh_of, render, section

ART = Path(__file__).resolve().parents[2] / "art"

COL = dict(top="#e8e1d1", bot="#8e8a82", cap="#f6f3ec", sw="#26262a", plate="#3a3a3a", pcb="#1f5130",
           eink="#d9dad2", saddle="#2e2e30", tube="#b9bec4", plunger="#b8412a", pop="#5f7472", g1="#e4dcc6",
           lid="#6f6b64", bar="#f4f4ee", hex="#c9a44a")


def _m(shape, col, tol=0.3):
    V, F = mesh_of(shape, tol, 0.4)
    return (V, F, col)


def assembly_items(g: Geo, B: Build, model="pop", explode=0.0, with_handset=True):
    r = B.refs
    e = explode
    items = [
        _m(Pos(0, 0, 2.2 * e) * B.part("base_top").shape, COL["top"]),
        _m(B.part("base_bottom").shape, COL["bot"]),
        _m(Pos(0, 0, 0.9 * e) * r["main_pcb"], COL["pcb"]),
        _m(Pos(0, 0, 1.2 * e) * r["deck_pcb"], COL["pcb"]),
        _m(Pos(0, 0, 1.5 * e) * r["key_plate"], COL["plate"]),
        _m(Pos(0, 0, 1.5 * e) * union(r["switches"]), COL["sw"]),
        _m(Pos(0, 0, 2.9 * e) * union(r["keycaps"]), COL["cap"], 0.25),
        _m(Pos(0, 0, 1.9 * e) * r["eink"], COL["eink"]),
        _m(Pos(0, 0, 2.2 * e) * B.part("light_bar").shape, COL["bar"]),
        _m(Pos(0, 0, 3.4 * e) * union([B.part(f"saddle_{model}_left").shape, B.part(f"saddle_{model}_right").shape]), COL["saddle"]),
        _m(Pos(0, 0, 3.0 * e) * union(r["tubes"]), COL["tube"]),
        _m(Pos(0, 0, 2.6 * e) * union(r["plungers"]), COL["plunger"]),
    ]
    if e:
        items.append(_m(Pos(0, 0, 1.0 * e) * union(r["hex_standoffs"]), COL["hex"]))
    if with_handset:
        items.append(_m(Pos(0, 0, 4.4 * e) * r[f"handset_{model}"], COL[model], 0.4))
    return items


def all(g: Geo, B: Build, out: Path):
    out.mkdir(parents=True, exist_ok=True)
    (out / "parts").mkdir(exist_ok=True)
    it = assembly_items(g, B, "pop")
    render(it, out / "assembled_3q.png", elev=24, azim=-58, zoom=0.95, size=(12, 9), title="Open Lounge Phone - assembled (POP-type handset)")
    render(it, out / "assembled_top.png", elev=88, azim=-90, zoom=0.95, size=(12, 8), title="top")
    render(it, out / "assembled_front.png", elev=3, azim=-90, zoom=0.95, size=(12, 7), title="front")
    render(it, out / "assembled_rear.png", elev=12, azim=100, zoom=0.95, size=(12, 8), title="rear: USB-C power + USB-C handset ports")
    render(it, out / "assembled_end.png", elev=3, azim=0, zoom=0.95, size=(10, 8), title="right end")
    it2 = assembly_items(g, B, "g1")
    render(it2, out / "assembled_g1_3q.png", elev=24, azim=-58, zoom=0.95, size=(12, 9), title="with a classic WE G1 handset (g1 saddle inserts)")
    itb = assembly_items(g, B, "pop", with_handset=False)
    render(itb, out / "base_no_handset_3q.png", elev=35, azim=-60, zoom=0.95, size=(12, 9), title="base without handset")
    ite = assembly_items(g, B, "pop", explode=12.0)
    render(ite, out / "exploded.png", elev=18, azim=-58, zoom=0.9, size=(12, 11), title="exploded")
    # sections
    r = B.refs
    x_key = g.keys[0][1]
    section([(B.part("base_top").shape, COL["top"], "top shell"), (B.part("base_bottom").shape, COL["bot"], "bottom tray"),
             (r["main_pcb"], COL["pcb"], "main PCB"), (r["deck_pcb"], "#2f7a48", "deck PCB"),
             (r["key_plate"], COL["plate"], "key plate"), (union(r["switches"]), COL["sw"], "MX switches"),
             (union(r["keycaps"]), "#c9c2b0", "DSA caps (rest)"), (r["eink"], "#8a8b84", "e-ink"),
             (union(r["hex_standoffs"]), COL["hex"], "hex standoffs"), (r["handset_pop"], COL["pop"], "handset")],
            out / "section_key_stack.png", axis="x", at=x_key, title=f"section x = {x_key:.1f} (key column 1 / 6)",
            size=(12, 8))
    px = g.posts[1][0]
    section([(B.part("base_top").shape, COL["top"], "top shell"), (B.part("base_bottom").shape, COL["bot"], "bottom tray"),
             (r["main_pcb"], COL["pcb"], "main PCB (hall under the magnet)"), (B.part("saddle_pop_right").shape, COL["saddle"], "saddle (pop)"),
             (r["tubes"][1], COL["tube"], "tube post"), (r["plungers"][1], COL["plunger"], "plunger"),
             (r["magnets"][1], "#303090", "magnet 3x1.5"), (r["springs"][1], "#707070", "spring"),
             (r["handset_pop"], COL["pop"], "handset (on-hook)")],
            out / "section_hook_post.png", axis="x", at=px, title=f"section x = {px:.1f} (right hook post, on-hook)",
            size=(12, 9), ylim=(0, 100))
    # printed parts in print orientation
    for part in B.printed:
        s = to_bed(part.shape, part.orient)
        render([_m(s, part.color, 0.2)], out / "parts" / f"{part.name}.png", elev=30, azim=-60, zoom=0.95, size=(9, 7),
               title=f"{part.name} (print orientation)")
    handset_vs_reference(g, B, out)


def handset_vs_reference(g: Geo, B: Build, out: Path):
    from PIL import Image
    from . import handset
    tmp = out / "_hs_pop.png"
    render([_m(handset.reference(g, "pop"), COL["pop"], 0.15)], tmp, elev=14, azim=-62, zoom=0.95, size=(9, 6),
           title="model: POP-type USB-C handset (230 x 55 x 55)")
    tmp2 = out / "_hs_g1.png"
    render([_m(handset.reference(g, "g1"), COL["g1"], 0.15)], tmp2, elev=34, azim=-35, zoom=0.95, size=(9, 6),
           title="model: WE G1 (estimated)")
    imgs = []
    for ref, mdl in (("reference-handset-modern.jpg", tmp), ("reference-g-handset.jpg", tmp2)):
        row = []
        if (ART / ref).exists():
            row.append(Image.open(ART / ref).convert("RGB"))
        row.append(Image.open(mdl).convert("RGB"))
        h = 520
        row = [im.resize((int(im.width * h / im.height), h)) for im in row]
        w = sum(im.width for im in row)
        canvas = Image.new("RGB", (w, h), "white")
        x = 0
        for im in row:
            canvas.paste(im, (x, 0))
            x += im.width
        imgs.append(canvas)
    W = max(i.width for i in imgs)
    comb = Image.new("RGB", (W, sum(i.height for i in imgs)), "white")
    y = 0
    for i in imgs:
        comb.paste(i, (0, y))
        y += i.height
    comb.save(out / "handset_vs_reference.png")
    tmp.unlink(missing_ok=True)
    tmp2.unlink(missing_ok=True)
