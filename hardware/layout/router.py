"""Deterministic grid router (A*) for the Open Lounge Phone boards (KiCad Python + numpy).

Why not FreeRouting: on these boards FreeRouting 2.4.1 plateaued at 50-90 unrouted
connections after 10+ passes (hours), and its output changed from run to run. This router is
small, deterministic (same input -> same copper) and knows the project rules directly:

- routing layers F.Cu, In2.Cu, B.Cu (In1.Cu is the solid GND plane: never routed);
- net-class widths/clearances; a 0.15 mm neck-down is allowed only within 1 mm of the net's
  own pads (fine-pitch pin escapes); every clearance gets a 0.02 mm grid margin;
- board edge 0.3 mm, hole 0.25 mm, hole-to-hole 0.5 mm, rule areas (antenna, NFC loop, NFC
  slit = no GND/supply tracks, mounting-hole areas = no tracks);
- 0.1 mm grid, 8-way moves, vias 0.6/0.3 where every layer and drill spacing allows.

Nets are routed in order (supplies first, then speaker, audio, buses, the rest); each net
grows a tree from its first copper island to the nearest unconnected island. Connections that
fail are retried once after all others. What stays unrouted is reported, never hidden.
"""

from __future__ import annotations

import heapq
import math
import re

import kienv  # noqa: F401  (sys.path for numpy in .tools/pylib)
import numpy as np
import pcbnew

MM = pcbnew.FromMM
RES = 0.1
MARGIN = 0.02
SMALL_W = 0.15            # neck-down width near own pads
NEAR_PAD = 1.0            # mm from own pads where the neck-down is allowed
EDGE = 0.3
AUDIO_SPEAKER = 0.5      # rule file: "audio to speaker 0.5 mm"
HOLE_CLR = 0.25
HOLE_TO_HOLE = 0.5
VIA_D, VIA_DRILL = 0.6, 0.3
VIA_COST = 14.0
HEUR_WEIGHT = 1.6         # weighted A*: a little longer paths, far fewer expansions
LAYERS = [pcbnew.F_Cu, pcbnew.In2_Cu, pcbnew.B_Cu]
LAYER_COST = [1.0, 1.25, 1.0]
ORDER = {"Power": 0, "Power3V": 1, "Speaker": 2, "USB": 3, "Audio": 4, "Bus": 5,
         "Default": 6, "GND": 7}
NO_SUPPLY_AREAS = ("NFC_SLIT", "NFC_LOOP_SIG")
SUPPLY_CLASSES = ("GND", "Power", "Power3V")


class Router:
    def __init__(self, board, origin, size, classes):
        """classes: {name: {"track": mm, "clearance": mm}} (boards.yaml netclasses)."""
        self.b = board
        self.classes = classes
        self.ox, self.oy = origin
        self.w, self.h = size
        self.nx = int(round(self.w / RES)) + 1
        self.ny = int(round(self.h / RES)) + 1
        xs = np.arange(self.nx) * RES
        ys = np.arange(self.ny) * RES
        self.X, self.Y = xs[None, :], ys[:, None]
        self.items = []   # dict(kind, layers, geom, net, clr, drill)
        self.fail_log = []
        self.netclr = {}
        self.netcls = {}
        self._collect()
        self._inside = self._board_mask()
        self._erode_cache = {}
        self._areas = self._rule_areas()

    # ---- geometry helpers --------------------------------------------------------------
    def mm(self, v):
        return pcbnew.ToMM(v.x) - self.ox, pcbnew.ToMM(v.y) - self.oy

    def _net_info(self, net):
        code = net.GetNetCode()
        if code not in self.netclr:
            name = net.GetNetClassName().split(",")[0]
            if name not in self.classes:
                name = "Default"
            self.netclr[code] = self.classes[name]["clearance"]
            self.netcls[code] = name
        return self.netclr[code]

    def _collect(self):
        for fp in self.b.GetFootprints():
            for pad in fp.Pads():
                attr = pad.GetAttribute()
                bb = pad.GetBoundingBox()
                x0, y0 = self.mm(bb.GetOrigin())
                x1, y1 = self.mm(bb.GetEnd())
                cx, cy = self.mm(pad.GetPosition())
                drill = pcbnew.ToMM(pad.GetDrillSize().x) / 2 if pad.HasHole() else 0.0
                if attr == pcbnew.PAD_ATTRIB_NPTH:
                    self.items.append(dict(kind="hole", layers=(0, 1, 2), geom=("circle", cx, cy,
                                      max(drill, (x1 - x0) / 2)), net=-1, clr=HOLE_CLR,
                                      drill=max(drill, (x1 - x0) / 2), ref=fp.GetReference(),
                                      routed=False, obj=None))
                    continue
                layers = tuple(i for i, lay in enumerate(LAYERS) if pad.IsOnLayer(lay))
                if not layers:
                    continue
                if pad.GetShape() == pcbnew.PAD_SHAPE_CIRCLE:
                    geom = ("circle", cx, cy, (x1 - x0) / 2)
                else:
                    geom = ("rect", x0, y0, x1, y1)
                net = pad.GetNet()
                clr = self._net_info(net) if pad.GetNetCode() else 0.15
                self.items.append(dict(kind="pad", layers=layers, geom=geom,
                                       net=pad.GetNetCode(), clr=clr, drill=drill,
                                       ref=fp.GetReference(), pad=pad.GetNumber(),
                                       routed=False, obj=None))
        for t in self.b.GetTracks():
            # pre-laid escape stubs are rippable like routed copper; hand routes (locked) and
            # the GND fan-out stay fixed
            self.add_track_item(t, routed=not t.IsLocked() and t.GetNetname() != "GND")
        self._fp_copper_graphics()

    def add_track_item(self, t, routed=False):
        net = t.GetNet()
        clr = self._net_info(net)
        if t.Type() == pcbnew.PCB_VIA_T:
            x, y = self.mm(t.GetPosition())
            it = dict(kind="via", layers=(0, 1, 2),
                      geom=("circle", x, y, pcbnew.ToMM(t.GetWidth()) / 2),
                      net=t.GetNetCode(), clr=clr, drill=pcbnew.ToMM(t.GetDrillValue()) / 2)
        else:
            if t.GetLayer() not in LAYERS:
                return None
            a, b = self.mm(t.GetStart()), self.mm(t.GetEnd())
            it = dict(kind="track", layers=(LAYERS.index(t.GetLayer()),),
                      geom=("seg", a[0], a[1], b[0], b[1], pcbnew.ToMM(t.GetWidth()) / 2),
                      net=t.GetNetCode(), clr=clr, drill=0.0)
        it["routed"] = routed
        it["obj"] = t if routed else None
        self.items.append(it)
        return it

    def _fp_copper_graphics(self):
        """Copper drawn in footprints (NFC coil turns, net-tie bridges) - no net, obstacle;
        footprint Edge.Cuts (cut-outs such as the ITR8307 window) - edge clearance."""
        for fp in self.b.GetFootprints():
            for g in fp.GraphicalItems():
                if g.GetClass() != "PCB_SHAPE":
                    continue
                if g.GetLayer() == pcbnew.Edge_Cuts and g.GetShape() == pcbnew.SHAPE_T_SEGMENT:
                    a, b = self.mm(g.GetStart()), self.mm(g.GetEnd())
                    self.items.append(dict(kind="graphic", layers=(0, 1, 2),
                                           geom=("seg", a[0], a[1], b[0], b[1], 0.0),
                                           net=-2, clr=EDGE + MARGIN, drill=0.0, routed=False,
                                           obj=None))
                    continue
                if g.GetLayer() not in LAYERS:
                    continue
                if g.GetShape() == pcbnew.SHAPE_T_POLY:   # net-tie pad polygons: bbox
                    bb = g.GetBoundingBox()
                    x0, y0 = self.mm(bb.GetOrigin())
                    x1, y1 = self.mm(bb.GetEnd())
                    self.items.append(dict(kind="graphic", layers=(LAYERS.index(g.GetLayer()),),
                                           geom=("rect", x0, y0, x1, y1), net=-2,
                                           clr=HOLE_CLR + MARGIN, drill=0.0, routed=False,
                                           obj=None))
                    continue
                if g.GetShape() != pcbnew.SHAPE_T_SEGMENT:
                    continue
                a, b = self.mm(g.GetStart()), self.mm(g.GetEnd())
                self.items.append(dict(kind="graphic", layers=(LAYERS.index(g.GetLayer()),),
                                       geom=("seg", a[0], a[1], b[0], b[1],
                                             pcbnew.ToMM(g.GetWidth()) / 2),
                                       net=-2, clr=0.2, drill=0.0, routed=False, obj=None))

    def _pip(self, pts, X, Y):
        """even-odd point-in-polygon for a polygon [(x, y)] over grid arrays."""
        inside = np.zeros(np.broadcast(X, Y).shape, dtype=bool)
        n = len(pts)
        for k in range(n):
            (x1, y1), (x2, y2) = pts[k], pts[(k + 1) % n]
            if y1 == y2:
                continue
            cond = (Y > min(y1, y2)) & (Y <= max(y1, y2))
            xint = x1 + (Y - y1) * (x2 - x1) / (y2 - y1)
            inside ^= cond & (X < xint)
        return inside

    def _poly_points(self, poly_set, k):
        ol = poly_set.Outline(k)
        return [self.mm(ol.CPoint(i)) for i in range(ol.PointCount())], \
            [[self.mm(poly_set.Hole(k, h).CPoint(i)) for i in range(poly_set.Hole(k, h).PointCount())]
             for h in range(poly_set.HoleCount(k))]

    def _board_mask(self):
        ps = pcbnew.SHAPE_POLY_SET()
        self.b.GetBoardPolygonOutlines(ps, True)
        m = np.zeros((self.ny, self.nx), dtype=bool)
        for k in range(ps.OutlineCount()):
            outer, holes = self._poly_points(ps, k)
            m |= self._pip(outer, self.X, self.Y)
            for h in holes:
                m &= ~self._pip(h, self.X, self.Y)
        return m

    def inside_for(self, r):
        """board cells at least r mm from any edge (square erosion: conservative)."""
        k = int(math.ceil(r / RES))
        if k not in self._erode_cache:
            m = self._inside.copy()
            for _ in range(k):
                e = m.copy()
                e[1:, :] &= m[:-1, :]
                e[:-1, :] &= m[1:, :]
                e[:, 1:] &= m[:, :-1]
                e[:, :-1] &= m[:, 1:]
                m = e
            self._erode_cache[k] = m
        return self._erode_cache[k]

    def _rule_areas(self):
        areas = []
        zones = list(self.b.Zones())
        for fp in self.b.GetFootprints():
            zones += list(fp.Zones())
        for z in zones:
            if not z.GetIsRuleArea():
                continue
            ol = z.Outline()
            for k in range(ol.OutlineCount()):
                pts = [self.mm(ol.Outline(k).CPoint(i)) for i in range(ol.Outline(k).PointCount())]
                mask = self._pip(pts, self.X, self.Y)
                areas.append(dict(name=z.GetZoneName(), mask=mask,
                                  tracks=z.GetDoNotAllowTracks(), vias=z.GetDoNotAllowVias(),
                                  layers=[k_ for k_, L in enumerate(LAYERS) if z.IsOnLayer(L)]))
        return areas

    # ---- rasterisation -------------------------------------------------------------------
    def stamp(self, mask, geom, r):
        res = self._hit(geom, r)
        if res is not None:
            j0, j1, i0, i1, hit = res
            mask[j0:j1, i0:i1] |= hit

    def cell_ids(self, geom, r):
        res = self._hit(geom, r)
        if res is None:
            return np.zeros(0, dtype=np.int64)
        j0, j1, i0, i1, hit = res
        js, is_ = np.nonzero(hit)
        return (js + j0) * self.nx + (is_ + i0)

    def _hit(self, geom, r):
        kind = geom[0]
        if kind == "rect":
            _, x0, y0, x1, y1 = geom
            bx0, by0, bx1, by1 = x0 - r, y0 - r, x1 + r, y1 + r
        elif kind == "circle":
            _, cx, cy, rad = geom
            bx0, by0, bx1, by1 = cx - rad - r, cy - rad - r, cx + rad + r, cy + rad + r
        else:
            _, ax, ay, bx, by, hw = geom
            bx0, by0 = min(ax, bx) - hw - r, min(ay, by) - hw - r
            bx1, by1 = max(ax, bx) + hw + r, max(ay, by) + hw + r
        i0, i1 = max(0, int(math.floor(bx0 / RES))), min(self.nx, int(math.ceil(bx1 / RES)) + 1)
        j0, j1 = max(0, int(math.floor(by0 / RES))), min(self.ny, int(math.ceil(by1 / RES)) + 1)
        if i0 >= i1 or j0 >= j1:
            return None
        X = np.arange(i0, i1)[None, :] * RES
        Y = np.arange(j0, j1)[:, None] * RES
        if kind == "rect":
            dx = np.maximum(np.maximum(x0 - X, 0), X - x1)
            dy = np.maximum(np.maximum(y0 - Y, 0), Y - y1)
            hit = dx * dx + dy * dy < r * r
        elif kind == "circle":
            hit = (X - cx) ** 2 + (Y - cy) ** 2 < (rad + r) ** 2
        else:
            vx, vy = bx - ax, by - ay
            L2 = vx * vx + vy * vy
            t = np.clip(((X - ax) * vx + (Y - ay) * vy) / L2, 0, 1) if L2 > 0 else 0.0
            px, py = ax + t * vx - X, ay + t * vy - Y
            hit = px * px + py * py < (hw + r) ** 2
        return j0, j1, i0, i1, hit

    # ---- per-net masks -------------------------------------------------------------------
    def dilate(self, m, r):
        k = int(math.ceil(r / RES))
        out = m.copy()
        for _ in range(k):
            e = out.copy()
            e[1:, :] |= out[:-1, :]
            e[:-1, :] |= out[1:, :]
            e[:, 1:] |= out[:, :-1]
            e[:, :-1] |= out[:, 1:]
            out = e
        return out

    def pair_clr(self, cls, it, c):
        """Class-pair rules from the rule file: analog audio vs speaker outputs 0.5 mm."""
        other = self.netcls.get(it["net"], "Default") if it["net"] > 0 else None
        if {cls, other} == {"Audio", "Speaker"}:
            return max(c, AUDIO_SPEAKER)
        return c

    def masks(self, net, width, locked=()):
        """(passable, full, via_bad, routed_cost_cells). Obstacles from nets that the router
        itself laid (and that are not in `locked`) are kept apart so a failed connection can
        rip them up."""
        clr = self.netclr.get(net, 0.15)
        cls = self.netcls.get(net, "Default")
        shape = (self.ny, self.nx)
        full = [~self.inside_for(EDGE + width / 2 + MARGIN) for _ in LAYERS]
        small = [~self.inside_for(EDGE + SMALL_W / 2 + MARGIN) for _ in LAYERS]
        rfull = [np.zeros(shape, dtype=bool) for _ in LAYERS]
        rsmall = [np.zeros(shape, dtype=bool) for _ in LAYERS]
        via_bad = ~self.inside_for(EDGE + VIA_D / 2 + MARGIN)
        rvia = np.zeros(shape, dtype=bool)
        own = np.zeros(shape, dtype=bool)
        for it in self.items:
            if it["net"] == net and it["kind"] == "pad":
                self.stamp(own, it["geom"], NEAR_PAD)
                continue
            if it["net"] == net and net > 0:
                continue
            soft = it["routed"] and it["net"] not in locked
            F, S, V = (rfull, rsmall, rvia) if soft else (full, small, None)
            c = self.pair_clr(cls, it, max(clr, it["clr"]))
            g = it["geom"]
            for L in it["layers"]:
                self.stamp(F[L], g, c + width / 2 + MARGIN)
                self.stamp(S[L], g, c + SMALL_W / 2 + MARGIN)
            self.stamp(rvia if soft else via_bad, g, c + VIA_D / 2 + MARGIN)
            if it["drill"] > 0:
                self.stamp(rvia if soft else via_bad, ("circle",) + g[1:3] + (it["drill"],),
                           HOLE_TO_HOLE + VIA_DRILL / 2 + MARGIN)
        for a in self._areas:
            if a["tracks"] or (a["name"] in NO_SUPPLY_AREAS and cls in SUPPLY_CLASSES):
                m = self.dilate(a["mask"], width / 2 + MARGIN)
                ms = self.dilate(a["mask"], SMALL_W / 2 + MARGIN)
                for L in a["layers"]:
                    full[L] |= m
                    small[L] |= ms
            if a["vias"]:
                via_bad |= self.dilate(a["mask"], VIA_D / 2 + MARGIN)
        static = [~full[L] | (~small[L] & own) for L in range(len(LAYERS))]
        passable = [static[L] & (~rfull[L] | (~rsmall[L] & own)) for L in range(len(LAYERS))]
        soft = [static[L] & ~passable[L] for L in range(len(LAYERS))]
        return dict(passable=passable, static=static, soft=soft,
                    full=[full[L] | rfull[L] for L in range(len(LAYERS))],
                    via_ok=~(via_bad | rvia), via_ok_static=~via_bad, via_soft=rvia & ~via_bad)

    # ---- copper islands of a net ---------------------------------------------------------
    def islands(self, net):
        its = [it for it in self.items if it["net"] == net]
        parent = list(range(len(its)))

        def find(a):
            while parent[a] != a:
                parent[a] = parent[parent[a]]
                a = parent[a]
            return a

        def cells(it):
            m = {}
            g = it["geom"]
            if g[0] == "rect":
                ids = self.cell_ids(("rect", g[1] + 0.04, g[2] + 0.04, g[3] - 0.04, g[4] - 0.04),
                                    0.001)
                cx, cy = (g[1] + g[3]) / 2, (g[2] + g[4]) / 2
            elif g[0] == "circle":
                ids = self.cell_ids(("circle", g[1], g[2], max(g[3] - 0.04, 0.02)), 0.001)
                cx, cy = g[1], g[2]
            else:
                ids = self.cell_ids(g[:5] + (max(g[5] - 0.04, 0.0),), 0.035)
                cx, cy = g[3], g[4]
            if len(ids) == 0:  # tiny copper: nearest cell to its centre
                ids = [int(round(cy / RES)) * self.nx + int(round(cx / RES))]
            s_ = set(int(c) for c in ids)
            for L in it["layers"]:
                m[L] = s_
            return m

        cellsets = [cells(it) for it in its]
        # items touch if they share a cell on a common layer
        index = {}
        for k, cs in enumerate(cellsets):
            for L, s in cs.items():
                for c in s:
                    key = (L, c)
                    if key in index:
                        ra, rb = find(k), find(index[key])
                        if ra != rb:
                            parent[ra] = rb
                    else:
                        index[key] = k
        groups = {}
        for k in range(len(its)):
            groups.setdefault(find(k), []).append(k)
        out = []
        for ks in groups.values():
            cs = {}
            for k in ks:
                for L, s in cellsets[k].items():
                    cs.setdefault(L, set()).update(s)
            out.append(dict(cells=cs, items=[its[k] for k in ks]))
        out.sort(key=lambda g: min((min(s) if s else 0) for s in g["cells"].values()))
        return out

    # ---- A* ----------------------------------------------------------------------------
    def astar(self, sources, targets, passable, via_ok, window, soft=None, via_soft=None,
              soft_cost=40.0, max_expand=250000):
        nx, ny = self.nx, self.ny
        i0, j0, i1, j1 = window
        tgt = set()
        for L, s in targets.items():
            for c in s:
                tgt.add(L * nx * ny + c)
        if not tgt:
            return None
        tj = [((t % (nx * ny)) // nx) for t in tgt]
        ti = [((t % (nx * ny)) % nx) for t in tgt]
        tx0, tx1, ty0, ty1 = min(ti), max(ti), min(tj), max(tj)
        # python bytes index ~10x faster than numpy scalars in this loop
        pas = [bytes(p.ravel().astype(np.uint8)) for p in passable]
        vok = bytes(via_ok.ravel().astype(np.uint8))
        sft = [bytes(x.ravel().astype(np.uint8)) for x in soft] if soft is not None else None
        vsf = bytes(via_soft.ravel().astype(np.uint8)) if via_soft is not None else None
        D = math.sqrt(2)

        W = HEUR_WEIGHT

        def h(i, j):
            dx = tx0 - i if i < tx0 else (i - tx1 if i > tx1 else 0)
            dy = ty0 - j if j < ty0 else (j - ty1 if j > ty1 else 0)
            return W * ((dx + dy) + (D - 2) * (dx if dx < dy else dy))

        openh = []
        g = {}
        came = {}
        for L, s in sources.items():
            for c in s:
                sid = L * nx * ny + c
                g[sid] = 0.0
                j, i = divmod(c, nx)
                heapq.heappush(openh, (h(i, j), 0.0, sid))
        moves = [(1, 0, 1.0), (-1, 0, 1.0), (0, 1, 1.0), (0, -1, 1.0),
                 (1, 1, D), (1, -1, D), (-1, 1, D), (-1, -1, D)]
        N = nx * ny
        expanded = 0
        closed = set()
        while openh:
            f, gc, sid = heapq.heappop(openh)
            if sid in closed:
                continue
            closed.add(sid)
            if sid in tgt:
                path = [sid]
                while path[-1] in came:
                    path.append(came[path[-1]])
                return path[::-1]
            expanded += 1
            if expanded > max_expand:
                return None
            L, c = divmod(sid, N)
            j, i = divmod(c, nx)
            lc = LAYER_COST[L]
            for di, dj, cost in moves:
                ii, jj = i + di, j + dj
                if ii < i0 or ii > i1 or jj < j0 or jj > j1:
                    continue
                nc = jj * nx + ii
                nid = L * N + nc
                if not pas[L][nc] and nid not in tgt:
                    continue
                if di and dj and not (pas[L][j * nx + ii] or pas[L][jj * nx + i]):
                    continue  # no squeezing diagonally between two blocked cells
                ng = gc + cost * lc
                if sft is not None and sft[L][nc]:
                    ng += soft_cost
                if ng < g.get(nid, 1e18):
                    g[nid] = ng
                    came[nid] = sid
                    heapq.heappush(openh, (ng + h(ii, jj), ng, nid))
            if vok[c]:
                for L2 in range(len(LAYERS)):
                    if L2 == L or not pas[L2][c]:
                        continue
                    nid = L2 * N + c
                    ng = gc + VIA_COST + (soft_cost if vsf is not None and vsf[c] else 0.0)
                    if ng < g.get(nid, 1e18):
                        g[nid] = ng
                        came[nid] = sid
                        heapq.heappush(openh, (ng + h(i, j), ng, nid))
        return None

    # ---- commit ----------------------------------------------------------------------------
    def commit(self, net_obj, path, width, full):
        """Turn a cell path into tracks/vias on the board (collinear runs merged; neck-down
        width where the full-width mask is blocked)."""
        N = self.nx * self.ny
        pts = []
        for sid in path:
            L, c = divmod(sid, N)
            j, i = divmod(c, self.nx)
            pts.append((L, i, j))
        added = []

        def xy(i, j):
            return self.ox + i * RES, self.oy + j * RES

        def seg(L, a, b, w):
            t = pcbnew.PCB_TRACK(self.b)
            t.SetStart(pcbnew.VECTOR2I(MM(xy(*a)[0]), MM(xy(*a)[1])))
            t.SetEnd(pcbnew.VECTOR2I(MM(xy(*b)[0]), MM(xy(*b)[1])))
            t.SetWidth(MM(w))
            t.SetLayer(LAYERS[L])
            t.SetNet(net_obj)
            self.b.Add(t)
            added.append(t)

        flag = [bool(full[L][j, i]) for L, i, j in pts]
        k = 0
        while k < len(pts) - 1:
            L, i, j = pts[k]
            L2, i2, j2 = pts[k + 1]
            if L2 != L:
                v = pcbnew.PCB_VIA(self.b)
                v.SetPosition(pcbnew.VECTOR2I(MM(xy(i, j)[0]), MM(xy(i, j)[1])))
                v.SetWidth(MM(VIA_D))
                v.SetDrill(MM(VIA_DRILL))
                v.SetViaType(pcbnew.VIATYPE_THROUGH)
                v.SetLayerPair(pcbnew.F_Cu, pcbnew.B_Cu)
                v.SetNet(net_obj)
                self.b.Add(v)
                added.append(v)
                k += 1
                continue
            d = (i2 - i, j2 - j)
            narrow = flag[k] or flag[k + 1]
            m = k + 1
            while m + 1 < len(pts):
                L3, i3, j3 = pts[m + 1]
                if L3 != L or (i3 - pts[m][1], j3 - pts[m][2]) != d:
                    break
                if (flag[m] or flag[m + 1]) != narrow:
                    break
                m += 1
            seg(L, (i, j), (pts[m][1], pts[m][2]), SMALL_W if narrow else width)
            k = m
        return [self.add_track_item(t, routed=True) for t in added]

    # ---- driver ------------------------------------------------------------------------------
    def rip_up(self, code):
        keep = []
        for it in self.items:
            if it["routed"] and it["net"] == code:
                self.b.Remove(it["obj"])
            else:
                keep.append(it)
        self.items = keep

    def route_all(self, skip_nets=(), log=print, max_rips=400):
        nets = {}
        for it in self.items:
            if it["net"] > 0:
                nets.setdefault(it["net"], []).append(it)
        netinfo = self.b.GetNetsByNetcode()
        order = []
        for code, its in nets.items():
            name = netinfo[code].GetNetname()
            if name in skip_nets:
                continue
            self._net_info(netinfo[code])
            xs = [it["geom"][1] for it in its]
            ys = [it["geom"][2] for it in its]
            hpwl = (max(xs) - min(xs)) + (max(ys) - min(ys))
            order.append((ORDER.get(self.netcls.get(code, "Default"), 6), hpwl, name, code))
        order.sort()
        queue = [o[3] for o in order]
        ripped = {}
        stats = {"connections": 0, "failed": 0, "ripups": 0}
        done = 0
        failed = set()
        retries = 0
        while queue or (failed and retries < 2):
            if not queue:  # second chance for failed nets once the rest has settled
                retries += 1
                queue = sorted(failed)
                log(f"  retry round {retries}: {len(queue)} nets")
            code = queue.pop(0)
            locked = {c for c, n in ripped.items() if n >= 4}
            victims = self.route_net(netinfo[code], stats, locked=locked,
                                     allow_rip=stats["ripups"] < max_rips)
            if not self.last_ok:
                failed.add(code)
            else:
                failed.discard(code)
            if True:  # nets crossed by a relaxed path are ripped even if another link failed
                for v in victims:
                    self.rip_up(v)
                    ripped[v] = ripped.get(v, 0) + 1
                    stats["ripups"] += 1
                    if v not in queue:
                        queue.append(v)
            done += 1
            if done % 20 == 0:
                log(f"  [{done}] queue {len(queue)} {stats}")
        unrouted = []
        for code in sorted(failed):
            isl = self.islands(code)
            if len(isl) > 1:
                unrouted.append((netinfo[code].GetNetname(), len(isl) - 1))
        return unrouted

    def _bbox(self, g):
        cs = [c for s in g["cells"].values() for c in s]
        js = [c // self.nx for c in cs]
        is_ = [c % self.nx for c in cs]
        return min(is_), min(js), max(is_), max(js)

    def route_net(self, net_obj, stats, locked=(), allow_rip=True):
        """Route every island of the net. Returns the list of nets to rip up (possibly empty)
        when the net ends fully connected, or None when a connection failed."""
        code = net_obj.GetNetCode()
        width = self.classes[self.netcls[code]]["track"]
        isl = self.islands(code)
        self.last_ok = True
        if len(isl) < 2:
            return []
        M = self.masks(code, width, locked=locked)
        connected = isl[0]
        rest = isl[1:]
        victims = set()
        ok = True
        N = self.nx * self.ny
        while rest:
            cb = self._bbox(connected)
            rest.sort(key=lambda g: sum(abs(a - b) for a, b in zip(self._bbox(g), cb)))
            target = rest.pop(0)
            tb = self._bbox(target)
            path, soft_used = None, False
            for pad in (60, 250, 100000):
                win = (max(0, min(cb[0], tb[0]) - pad), max(0, min(cb[1], tb[1]) - pad),
                       min(self.nx - 1, max(cb[2], tb[2]) + pad),
                       min(self.ny - 1, max(cb[3], tb[3]) + pad))
                path = self.astar(connected["cells"], target["cells"], M["passable"],
                                  M["via_ok"], win)
                if path:
                    break
            if not path and allow_rip:
                win = (0, 0, self.nx - 1, self.ny - 1)
                path = self.astar(connected["cells"], target["cells"], M["static"],
                                  M["via_ok_static"], win, soft=M["soft"],
                                  via_soft=M["via_soft"], max_expand=1200000)
                soft_used = path is not None
            stats["connections"] += 1
            if not path:
                stats["failed"] += 1
                ok = False
                refs = sorted({f"{it.get('ref', it['kind'])}.{it.get('pad', '')}"
                               for it in target["items"]})[:4]
                self.fail_log.append(f"{net_obj.GetNetname()}: could not reach {refs}")
                continue
            if soft_used:
                victims |= self.crossed_nets(code, width, path, locked)
            self.commit(net_obj, path, width, M["full"])
            for L, s_ in target["cells"].items():
                connected["cells"].setdefault(L, set()).update(s_)
            for sid in path:
                L, c = divmod(sid, N)
                connected["cells"].setdefault(L, set()).add(c)
        self.last_ok = ok
        return sorted(victims)

    def crossed_nets(self, code, width, path, locked):
        """Router-laid nets whose clearance zone the (relaxed) path enters."""
        N = self.nx * self.ny
        cells = {}
        prev = None
        for sid in path:
            L, c = divmod(sid, N)
            cells.setdefault(L, set()).add(c)
            if prev is not None and prev[1] == c and prev[0] != L:  # via: every layer
                for L2 in range(len(LAYERS)):
                    cells.setdefault(L2, set()).add(c)
            prev = (L, c)
        clr = self.netclr.get(code, 0.15)
        hit = set()
        for it in self.items:
            if not it["routed"] or it["net"] in (code,) or it["net"] in locked:
                continue
            if it["net"] in hit:
                continue
            c_ = self.pair_clr(self.netcls.get(code, "Default"), it, max(clr, it["clr"]))
            for L in it["layers"]:
                if L not in cells:
                    continue
                ids = self.cell_ids(it["geom"], c_ + VIA_D / 2 + MARGIN)
                if cells[L].intersection(int(x) for x in ids):
                    hit.add(it["net"])
                    break
        return hit
