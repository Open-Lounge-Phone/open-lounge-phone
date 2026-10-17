"""The other cases in the site teaser: the flat-cut desk phone (flatcase.py), the wall phone
(faceplate.py, OLP_FACEPLATE=hook) and the cushion (plush.py), around the same board, switches,
display module and handsets as the printed box (teaser.py).

Every case script works in the board's frame (x right, y toward the rear or up, z = 0 on the
board's top); the teaser's frame is the printed box's, where the board sits at OFF. So each case's
parts are moved by OFF and the shared meshes stay where they are: a layout only adds its parts, a
pose for the whole phone (the wall phone stands up) and where each handset rests in it.
"""
from __future__ import annotations

import hashlib
import math
from pathlib import Path

import numpy as np
import trimesh

import proto_box as P
import faceplate as F
import flatcase as FC
import plush as PL

HERE = Path(__file__).resolve().parent
OFF = np.array([P.GAP + P.WALL, P.GAP + P.WALL, P.Z_BT])   # board frame -> the teaser's frame
CLEAR = 0.4                # a handset rests this far off what holds it (no touching surfaces)


def tri(shape, tol=0.04, ang=0.2, at=OFF) -> trimesh.Trimesh:
    v, f = P.mesh_of(shape, tol, ang)
    return trimesh.Trimesh(v + at, f, process=True)


def cyl(x, y, z0, z1, r, sections=40) -> trimesh.Trimesh:
    m = trimesh.creation.cylinder(radius=r, height=z1 - z0, sections=sections)
    m.apply_translation([x, y, (z0 + z1) / 2])
    m.apply_translation(OFF)
    return m


def cat(ms):
    return trimesh.util.concatenate(list(ms))


# ------------------------------------------------------------------------------- parts
def flat_parts() -> dict[str, trimesh.Trimesh]:
    p2 = FC.parts_2d()
    a = FC.assembly(p2)
    hw = FC.hardware3d()
    out = {
        "flat_back": tri(a["back-plate"]),
        "flat_front": tri(a["front-plate"]),
        "flat_ears": cat(tri(a[f"ear-{i}"]) for i in (1, 2)),
        "flat_arm": cat(tri(a[n]) for n in FC.ARM),
        "flat_columns": cat(tri(h) for n, h in hw.items() if n.startswith("column")),
        "flat_spacers": cat(tri(h) for n, h in hw.items() if n.startswith("spacer")),
        "flat_feet": cat(tri(h) for n, h in hw.items() if n.startswith("foot")),
    }
    heads = [h for n, h in hw.items() if n.startswith("board screw")]
    heads += [FC.Pos(x, y, FC.FRONT_Z1) * FC.Cylinder(2.85, 1.65, align=(FC.Align.CENTER, FC.Align.CENTER, FC.Align.MIN))
              for x, y in FC.COLUMNS]
    out["flat_screws"] = cat(tri(h) for h in heads)
    # the display module's far end stands on two M2 spacers on the plate
    out["flat_posts"] = cat(cyl(x, F.Y(y), FC.FRONT_Z1, P.STANDOFF_L, 1.9, 6) for x, y in P.MODULE_FAR_HOLES)
    return out


def wall_parts() -> dict[str, trimesh.Trimesh]:
    return {"wall_bracket": tri(F.build_bracket()), "wall_housing": tri(F.build_hook_face(), 0.05),
            "wall_rocker": tri(F.build_rocker())}


def cushion_parts() -> dict[str, trimesh.Trimesh]:
    return {"cushion_bottom": tri(PL.build_plate()), "cushion_case": tri(PL.build_case(), 0.05)}


def cap_parts() -> dict[str, trimesh.Trimesh]:
    """The captive caps, one of each kind, centred on x = y = 0 at the board's height (the page
    sets one on every switch): the wall phone's dished caps, the cushion's puffy ones and the hook
    key's rounded crown (both cases)."""
    at = np.array([0.0, 0.0, OFF[2]])
    return {"wall_cap": tri(F.build_cap(""), 0.01, 0.1, at), "cushion_cap": tri(PL.build_puffy_cap(""), 0.01, 0.1, at),
            "captive_hook": tri(F.build_cap("HOOK"), 0.01, 0.1, at)}


def build_parts(cache: Path) -> dict[str, trimesh.Trimesh]:
    """Every case part (built once, kept until a case script changes: building them is slow)."""
    src = b"".join((HERE / n).read_bytes() for n in ("flatcase.py", "faceplate.py", "plush.py", "proto_box.py",
                                                     "handset.py", "teaser_cases.py"))
    key = hashlib.sha1(src + P.DISPLAY.encode()).hexdigest()[:12]
    f = cache / f"cases-{key}.npz"
    if f.exists():
        d = np.load(f, allow_pickle=False)
        names = [str(n) for n in d["names"]]
        return {n: trimesh.Trimesh(d[f"v{i}"], d[f"f{i}"], process=False) for i, n in enumerate(names)}
    parts = {**flat_parts(), **wall_parts(), **cushion_parts(), **cap_parts()}
    cache.mkdir(parents=True, exist_ok=True)
    names = list(parts)
    np.savez_compressed(f, names=np.array(names), **{f"v{i}": parts[n].vertices for i, n in enumerate(names)},
                        **{f"f{i}": parts[n].faces for i, n in enumerate(names)})
    return parts


# ------------------------------------------------------------------------------- handsets
def pts(m: trimesh.Trimesh, n: int = 40000) -> np.ndarray:
    """Points on a mesh's surface: its vertices and an even sprinkle (long thin triangles have
    few vertices)."""
    p, _ = trimesh.sample.sample_surface(m, n, seed=1)
    return np.vstack([m.vertices, p])


def hits(points: np.ndarray, solids: list[trimesh.Trimesh]) -> bool:
    """Any of the points inside any of the (closed) solids."""
    for s in solids:
        lo, hi = s.bounds
        near = points[np.all((points >= lo - 0.01) & (points <= hi + 0.01), axis=1)]
        if len(near) and s.contains(near).any():
            return True
    return False


def drop(hs: trimesh.Trimesh, move: np.ndarray, along: np.ndarray, solids, reach: float) -> np.ndarray:
    """Move the handset by `move`, then along `along` (a unit vector) until it meets the solids:
    the offset where it rests, CLEAR short of touching."""
    v = pts(hs) + move
    if hits(v, solids):
        raise SystemExit("teaser: a handset starts inside its case")
    step, t = 2.0, 0.0
    while t < reach and not hits(v + along * (t + step), solids):
        t += step
    lo, hi = t, t + step                     # free at lo, touching at hi
    for _ in range(12):
        mid = (lo + hi) / 2
        lo, hi = (mid, hi) if not hits(v + along * mid, solids) else (lo, mid)
    return move + along * max(0.0, lo - CLEAR)


def rest_flat(hs: trimesh.Trimesh) -> np.ndarray:
    """On the flat case's two V catches (key up): the handle's lowest points over each catch
    sit on the V (its sides at 45 degrees, then the flat tops beside it)."""
    b = hs.bounds
    lx, yc = FC.LX + OFF[0], sum(FC.CATCH_Y) / 2 + OFF[1]
    move = np.array([lx - (b[0][0] + b[1][0]) / 2, yc - (b[0][1] + b[1][1]) / 2, 0.0])
    v = pts(hs) + move
    h = FC.V_OPEN / 2
    need = -1e9
    for cy in FC.CATCH_Y:
        s = v[np.abs(v[:, 1] - (cy + OFF[1])) <= FC.T / 2 + 0.6]
        dx = np.abs(s[:, 0] - lx)
        s, dx = s[dx <= h + FC.V_WALL], dx[dx <= h + FC.V_WALL]
        need = max(need, float(np.max(FC.APEX + OFF[2] + np.minimum(dx, h) - s[:, 2])))
    return move + [0, 0, need + CLEAR]


def rest_wall(hs, rocker, housing) -> np.ndarray:
    """Hung on the wall phone's hook: cups toward the wall, the earpiece up, its cup's base just
    in front of the pivot housing; lowered (down the wall) until the cup sits on the cradle."""
    b = hs.bounds
    y0 = F.Y(F.PIV_KY) + OFF[1]
    z_face = F.PIV_Z + F.LUG_W / 2 + 1.5 + OFF[2]          # in front of the pivot housing's top
    # the earpiece end (+y) hangs on the hook: start with its cup's lowest point over the cradle
    move = np.array([F.PIV_X + OFF[0] - (b[0][0] + b[1][0]) / 2, y0 + 30.0 - (b[1][1] - 68.0), z_face - b[0][2]])
    return drop(hs, move, np.array([0.0, -1.0, 0.0]), [rocker, housing], 120.0)


def rest_cushion(hs, case, hook_cap) -> np.ndarray:
    """In the cushion's bed: over the two cup pockets, lowered until it rests (on the upper
    pocket's floor and the hook key's button)."""
    b = hs.bounds
    x, y = PL.HS_C[0] + OFF[0], PL.HS_C[1] + OFF[1]
    move = np.array([x - (b[0][0] + b[1][0]) / 2, y - (b[0][1] + b[1][1]) / 2, PL.BED_TOP + OFF[2] + 15.0 - b[0][2]])
    return drop(hs, move, np.array([0.0, 0.0, -1.0]), [case, hook_cap], 80.0)


def check_path(name, moving: trimesh.Trimesh, d_moving, fixed: list[tuple[trimesh.Trimesh, np.ndarray]], n=24):
    """The exploded view: sample it and report the moving part's points inside a part it passes."""
    bad = []
    pm = pts(moving, 20000)
    for k in range(n + 1):
        ex = k / n
        v = pm + np.asarray(d_moving) * ex
        for m, d in fixed:
            mv = m.copy()
            mv.apply_translation(np.asarray(d) * ex)
            if hits(v, [mv]):
                bad.append(round(ex, 2))
                break
    if bad:
        print(f"teaser: WARNING {name} passes through a part in the exploded view at ex = {bad}")


# ------------------------------------------------------------------------------- layouts
def screen_window(window: tuple[float, float] | None, active: tuple[float, float]) -> list[float]:
    """What of the panel's active area shows (shell frame): [cx, cy, w, h], the active area cut
    by the case's window over it (both centred on the active area)."""
    cx, cy = P.bx2x(P.DISP_X0 + P.DSP["view_cx"]), P.by2y(P.DISP_MID)
    w, h = active
    if window:
        w, h = min(w, window[0]), min(h, window[1])
    return [cx, cy, w, h]


def pose(rx_deg=0.0, t=(0.0, 0.0, 0.0)) -> list[float]:
    """A pose for the whole phone: a turn about x, then a move (column-major, three's order)."""
    M = trimesh.transformations.rotation_matrix(math.radians(rx_deg), [1, 0, 0])
    M[:3, 3] = t
    return [float(x) for x in M.T.flatten()]


def layouts(parts, handsets: dict[str, trimesh.Trimesh], active: tuple[float, float]) -> dict:
    """The scene.json entries for the three cases: pose, explode offsets per group (in the case's
    own frame, mm per unit of explode), where each handset rests, which caps, the screen window."""
    out = {}
    # flat-cut: lies on its feet. Explodes straight up, bottom to top.
    feet = FC.BACK_Z0 - FC.FOOT_H + OFF[2]
    hs_flat = {n: rest_flat(h).tolist() for n, h in handsets.items()}
    ex_flat = {"flat_back": 0, "flat_feet": -14, "flat_columns": 18, "board": 34, "flat_spacers": 45, "flat_front": 56,
               "switch": 66, "spring": 74, "swtop": 86, "stem": 100, "flat_posts": 92, "module": 104, "flat_screws": 112,
               "keycap": 126, "flat_ears": 148, "flat_arm": 172, "handset": 222}
    out["flat"] = {"label": "flat-cut acrylic", "hide": [], "pose": pose(0, (0, 0, -feet)), "caps": "xda",
                   "explode": {k: [0, 0, v] for k, v in ex_flat.items()}, "handsets": hs_flat,
                   "screen": screen_window(None, active), "occluders": ["flat_arm", "flat_ears", "handset", "keycap"]}

    # wall phone: stands upright, face toward -y. Explodes out of the wall (+z here), the handset
    # up and out off its hook.
    hs_wall = {n: rest_wall(h, parts["wall_rocker"], parts["wall_housing"]).tolist() for n, h in handsets.items()}
    ex_wall = {"wall_bracket": 0, "board": 34, "switch": 58, "spring": 64, "swtop": 74, "stem": 86, "module": 92,
               "caps": 112, "wall_housing": 150, "wall_rocker": 150}
    lowest = min(min(h.bounds[0][1] + hs_wall[n][1] for n, h in handsets.items()), parts["wall_bracket"].bounds[0][1])
    wall_y = F.Z_WALL() + OFF[2]                                       # the wall, in the case's frame
    ex = {k: [0, 0, v] for k, v in ex_wall.items()}
    ex["handset"] = [0, 90, 240]
    out["wall"] = {"label": "wall phone", "hide": ["board_net"], "pose": pose(90, (0, 0, 70.0 - lowest)), "caps": "wall",
                   "explode": ex, "handsets": hs_wall, "wall": wall_y, "front": True,
                   "screen": screen_window(F.WIN, active), "occluders": ["wall_rocker", "wall_housing", "handset"]}

    # cushion: lies on its bottom. Explodes straight up.
    hook_cap = parts["captive_hook"].copy()
    hook_cap.apply_translation([P.bx2x(P.HOOK[0]), P.by2y(P.HOOK[1]), 0])
    hs_cush = {n: rest_cushion(h, parts["cushion_case"], hook_cap).tolist() for n, h in handsets.items()}
    ex_cush = {"cushion_bottom": 0, "board": 34, "switch": 58, "spring": 64, "swtop": 74, "stem": 86, "module": 92,
               "caps": 112, "cushion_case": 150, "handset": 215}
    out["cushion"] = {"label": "cushion", "hide": ["board_net"], "pose": pose(0, (0, 0, -(PL.Z_BOT + OFF[2]))), "caps": "cushion",
                      "explode": {k: [0, 0, v] for k, v in ex_cush.items()}, "handsets": hs_cush,
                      "screen": screen_window(F.WIN, active), "occluders": ["cushion_case", "handset"]}

    # the risky moves in the exploded views, sampled
    for n, h in handsets.items():
        hw = h.copy(); hw.apply_translation(hs_wall[n])
        check_path(f"{n} (wall)", hw, ex["handset"], [(parts["wall_rocker"], ex["wall_rocker"]),
                                                       (parts["wall_housing"], ex["wall_housing"])])
        hc = h.copy(); hc.apply_translation(hs_cush[n])
        check_path(f"{n} (cushion)", hc, [0, 0, ex_cush["handset"]], [(parts["cushion_case"], [0, 0, ex_cush["cushion_case"]])])
        hf = h.copy(); hf.apply_translation(hs_flat[n])
        check_path(f"{n} (flat)", hf, [0, 0, ex_flat["handset"]], [(parts["flat_arm"], [0, 0, ex_flat["flat_arm"]]),
                                                                    (parts["flat_ears"], [0, 0, ex_flat["flat_ears"]])])
    # the assembled phones: nothing of a handset inside a part
    for lay, hs_at, solids in (("flat", hs_flat, ["flat_arm", "flat_ears", "flat_front"]),
                               ("wall", hs_wall, ["wall_rocker", "wall_housing", "wall_bracket"]),
                               ("cushion", hs_cush, ["cushion_case"])):
        for n, h in handsets.items():
            if hits(pts(h) + hs_at[n], [parts[s] for s in solids]):
                print(f"teaser: WARNING the {n} sits inside the {lay} case")
    return out
