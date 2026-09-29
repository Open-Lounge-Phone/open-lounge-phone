"""Shared bits for the H4 benches: the check record, the context, units and helpers."""

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
    reqs: str = ""      # requirement IDs this check verifies
    note: str = ""
    scope: str = "both"  # "current" = today's schematic only, "proposal" = the H5 proposal only,
    #                      "alt" = a rejected alternative, "both" = applies to both

    def __post_init__(self):
        n = self.name.lower()
        if self.scope == "both":   # naming convention used by the benches
            if "(current" in n or "[current" in n or n.startswith("current schematic"):
                self.scope = "current"
            elif "(proposed" in n or "[proposed" in n or "(proposal" in n:
                self.scope = "proposal"

    @property
    def verdict(self) -> str:
        return {True: "PASS", False: "FAIL", None: "INFO"}[self.ok]


@dataclass
class Bench:
    key: str
    title: str
    reqs: str
    provenance: list[str]
    assumptions: list[str]
    checks: list[Check] = field(default_factory=list)
    notes: list[str] = field(default_factory=list)
    error: str = ""

    def add(self, *a, key: bool = False, **k) -> Check:
        c = Check(*a, **k)
        c.key = key  # shown in the README summary
        self.checks.append(c)
        return c

    def _v(self, scopes) -> str:
        if self.error:
            return "ERROR"
        judged = [c.ok for c in self.checks if c.ok is not None and c.scope in scopes]
        return "PASS" if all(judged) else "FAIL"

    @property
    def verdict(self) -> str:
        """Verdict for the H5 proposal (what the board will be)."""
        return self._v(("both", "proposal"))

    @property
    def verdict_current(self) -> str:
        """Verdict for the schematic as it is today."""
        return self._v(("both", "current"))


class Ctx:
    def __init__(self, quick: bool = False, vendor: bool = False):
        self.quick = quick
        self.vendor = vendor
        self.models = BUILD / "models"

    def dir(self, key: str) -> Path:
        d = BUILD / key
        d.mkdir(parents=True, exist_ok=True)
        return d

    def sim(self, key: str, name: str, netlist: str, analysis, vectors, **kw) -> dict:
        head = f"* {key}/{name}\n.include {LIB}\n"
        return spice.run(head + netlist, analysis, vectors, self.dir(key), name, **kw)


def at(r: dict, vec: str, t: float) -> float:
    i = min(np.searchsorted(r["x"], t), len(r["x"]) - 1)
    return float(r[vec][i])


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


def a_weight_db(f: np.ndarray) -> np.ndarray:
    """IEC 61672-1 A-weighting in dB."""
    f2 = np.asarray(f, float) ** 2
    ra = (12194.0**2 * f2**2) / ((f2 + 20.6**2) * np.sqrt((f2 + 107.7**2) * (f2 + 737.9**2))
                                 * (f2 + 12194.0**2))
    return 20 * np.log10(ra) + 2.00
