"""Shared bits for the benches: the check record, the context, units and helpers."""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path

import numpy as np

import spice

SIM = Path(__file__).resolve().parent
HW = SIM.parent
BUILD = HW / "build" / "sim"
LIB = SIM / "models" / "olp_behavioural.lib"


@dataclass
class Check:
    name: str
    value: str          # measured / computed value, formatted
    limit: str          # pass criterion, formatted
    ok: bool | None     # True PASS, False FAIL, None INFO (reported, not judged)
    note: str = ""

    @property
    def verdict(self) -> str:
        return {True: "PASS", False: "FAIL", None: "INFO"}[self.ok]


@dataclass
class Bench:
    key: str
    title: str
    provenance: list[str]
    assumptions: list[str]
    checks: list[Check] = field(default_factory=list)
    error: str = ""

    def add(self, *a, **k) -> Check:
        c = Check(*a, **k)
        self.checks.append(c)
        return c

    @property
    def verdict(self) -> str:
        if self.error:
            return "ERROR"
        judged = [c.ok for c in self.checks if c.ok is not None]
        return "PASS" if judged and all(judged) else ("n/a" if not judged else "FAIL")


class Ctx:
    def dir(self, key: str) -> Path:
        d = BUILD / key
        d.mkdir(parents=True, exist_ok=True)
        return d

    def sim(self, key: str, name: str, netlist: str, analysis, vectors, **kw) -> dict:
        head = f"* {key}/{name}\n.include {LIB}\n"
        return spice.run(head + netlist, analysis, vectors, self.dir(key), name, **kw)


def window(r: dict, vec: str, t0: float, t1: float) -> np.ndarray:
    m = (r["x"] >= t0) & (r["x"] <= t1)
    return r[vec][m]


def si(v: float, unit: str, digits: int = 3) -> str:
    """Engineering format: 0.0123 A -> '12.3 mA'."""
    if v == 0 or not np.isfinite(v):
        return f"{v:g} {unit}"
    for exp, pre in ((1e9, "G"), (1e6, "M"), (1e3, "k"), (1, ""), (1e-3, "m"), (1e-6, "µ"),
                     (1e-9, "n"), (1e-12, "p")):
        if abs(v) >= exp:
            return f"{v / exp:.{digits}g} {pre}{unit}"
    return f"{v:.3g} {unit}"
