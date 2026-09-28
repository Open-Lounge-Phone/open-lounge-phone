"""Headless PNG renders (matplotlib, Lambert shading, painter's algorithm) and 2D sections."""

from __future__ import annotations

import numpy as np
import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402
from mpl_toolkits.mplot3d.art3d import Poly3DCollection  # noqa: E402


def mesh_of(shape, tol=0.15, ang=0.4):
    v, t = shape.tessellate(tol, ang)
    V = np.array([[p.X, p.Y, p.Z] for p in v], dtype=float)
    return V, np.array(t, dtype=int)


def _hex(c):
    c = c.lstrip("#")
    return np.array([int(c[i:i + 2], 16) / 255 for i in (0, 2, 4)])


def render(items, path, elev=28, azim=-60, size=(12, 8), title=None, light=(0.35, -0.8, 0.9), alpha=1.0,
           zoom=1.25, limits=None, dpi=110):
    """items: [(V, F, '#rrggbb')] in mm. One collection for all faces so the per-polygon depth
    sort is global. limits: optional (mn, mx) xyz arrays to share a scale between images."""
    fig = plt.figure(figsize=size, dpi=dpi)
    ax = fig.add_subplot(111, projection="3d")
    L = np.array(light, dtype=float)
    L /= np.linalg.norm(L)
    tris, cols, allv = [], [], []
    for V, F, col in items:
        if len(F) == 0:
            continue
        tri = V[F]
        n = np.cross(tri[:, 1] - tri[:, 0], tri[:, 2] - tri[:, 0])
        nn = np.linalg.norm(n, axis=1, keepdims=True)
        n = n / np.where(nn == 0, 1, nn)
        shade = 0.25 + 0.75 * np.clip(np.abs(n @ L), 0, 1) ** 1.2
        base = _hex(col)
        tris.append(tri)
        cols.append(np.clip(base[None, :] * shade[:, None], 0, 1))
        allv.append(V)
    T = np.concatenate(tris)
    C = np.concatenate(cols)
    pc = Poly3DCollection(T, facecolors=np.c_[C, np.full(len(C), alpha)], edgecolors="none", linewidths=0)
    ax.add_collection3d(pc)
    if limits is None:
        A = np.vstack(allv)
        mn, mx = A.min(0), A.max(0)
    else:
        mn, mx = np.asarray(limits[0], float), np.asarray(limits[1], float)
    rng = np.maximum(mx - mn, 1e-3)
    ax.set_xlim(mn[0], mx[0])
    ax.set_ylim(mn[1], mx[1])
    ax.set_zlim(mn[2], mx[2])
    ax.set_box_aspect(tuple(rng), zoom=zoom)
    ax.view_init(elev=elev, azim=azim)
    ax.set_axis_off()
    if title:
        ax.set_title(title, fontsize=14)
    fig.subplots_adjust(0, 0, 1, 1)
    fig.savefig(path, facecolor="white")
    plt.close(fig)


def section(items, path, axis="x", at=0.0, title=None, size=(12, 6), xlim=None, ylim=None):
    """2D cut through several shapes (build123d) at a plane; draws filled outlines."""
    from build123d import Plane
    fig, ax = plt.subplots(figsize=size, dpi=110)
    pl = {"x": Plane.YZ.offset(at), "y": Plane.XZ.offset(-at)}[axis]
    for shape, col, label in items:
        try:
            sec = shape.intersect(pl.to_local_coords(pl) if False else _slab(shape, axis, at))
        except Exception:
            continue
        if sec is None:
            continue
        for f in sec.faces():
            V, F = mesh_of(f, 0.05, 0.2)
            if len(F) == 0:
                continue
            h = 0 if axis == "y" else 1
            tri = V[F][:, :, [h, 2]]
            for tr in tri:
                ax.fill(tr[:, 0], tr[:, 1], color=col, lw=0)
        ax.plot([], [], color=col, lw=6, label=label)
    ax.set_aspect("equal")
    if xlim:
        ax.set_xlim(*xlim)
    if ylim:
        ax.set_ylim(*ylim)
    ax.grid(True, lw=0.3)
    ax.legend(loc="upper right", fontsize=7)
    if title:
        ax.set_title(title)
    fig.savefig(path, bbox_inches="tight", facecolor="white")
    plt.close(fig)


def _slab(shape, axis, at, t=0.02):
    """A very thin slab at the cut plane: intersecting gives the section as thin solids whose
    faces we plot (robust across OCC versions)."""
    from .common import box
    bb = shape.bounding_box()
    if axis == "x":
        return box(at - t, at + t, bb.min.Y - 1, bb.max.Y + 1, bb.min.Z - 1, bb.max.Z + 1)
    return box(bb.min.X - 1, bb.max.X + 1, at - t, at + t, bb.min.Z - 1, bb.max.Z + 1)
