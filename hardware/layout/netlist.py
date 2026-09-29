"""Read a KiCad netlist (the SKiDL output in build/<board>/<board>.net).

Tiny s-expression reader, no KiCad dependency, so it runs under KiCad's bundled Python and the
project venv alike.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from pathlib import Path

_TOKEN = re.compile(r'\(|\)|"(?:[^"\\]|\\.)*"|[^\s()"]+')


def parse_sexpr(text: str):
    stack, cur = [], []
    for m in _TOKEN.finditer(text):
        t = m.group(0)
        if t == "(":
            stack.append(cur)
            cur = []
        elif t == ")":
            done = cur
            cur = stack.pop()
            cur.append(done)
        elif t.startswith('"'):
            cur.append(t[1:-1].replace('\\"', '"').replace("\\\\", "\\"))
        else:
            cur.append(t)
    return cur[0]


def _find(node, key):
    return [x for x in node if isinstance(x, list) and x and x[0] == key]


def _val(node, key, default=None):
    f = _find(node, key)
    return f[0][1] if f and len(f[0]) > 1 else default


@dataclass
class Comp:
    ref: str
    value: str
    footprint: str
    description: str = ""
    fields: dict = field(default_factory=dict)

    @property
    def dnp(self) -> bool:
        return bool(self.fields.get("DNP"))

    @property
    def lcsc(self) -> str:
        return self.fields.get("LCSC", "")


@dataclass
class Netlist:
    comps: dict  # ref -> Comp
    nets: dict  # net name -> [(ref, pin)]

    def pin_net(self) -> dict:
        """(ref, pin) -> net name"""
        return {(r, p): n for n, nodes in self.nets.items() for r, p in nodes}


def read(path: str | Path) -> Netlist:
    tree = parse_sexpr(Path(path).read_text())
    comps = {}
    for comp in _find(_find(tree, "components")[0], "comp"):
        fields = {}
        for fs in _find(comp, "fields"):
            for f in _find(fs, "field"):
                name = _val(f, "name")
                fields[name] = f[2] if len(f) > 2 and isinstance(f[2], str) else ""
        c = Comp(ref=_val(comp, "ref"), value=_val(comp, "value", ""),
                 footprint=_val(comp, "footprint", ""), description=_val(comp, "description", ""),
                 fields=fields)
        comps[c.ref] = c
    nets = {}
    for net in _find(_find(tree, "nets")[0], "net"):
        name = _val(net, "name")
        nets[name] = [(_val(n, "ref"), _val(n, "pin")) for n in _find(net, "node")]
    return Netlist(comps, nets)
