"""Thin ngspice runner for the H4 testbenches.

Uses the ``ngspice`` command line (Homebrew: ``brew install ngspice``) when it is on PATH, else
the shared library KiCad ships (``KiCad.app/Contents/Frameworks/libngspice.0.dylib``; set
``NGSPICE_LIB`` to point elsewhere). Both run the same netlist in PSpice-compatible mode
(``ngbehavior=psa``) so the TI PSpice models load unchanged.

A bench hands over a netlist (without ``.control``) plus the analysis and the vectors it wants;
this module appends a ``.control`` block that runs the analysis and writes the vectors with
``wrdata``, runs ngspice in a subprocess (a crashing model cannot take the runner down) and
returns the vectors as numpy arrays.
"""

from __future__ import annotations

import ctypes
import os
import shutil
import subprocess
import sys
from pathlib import Path

import numpy as np

KICAD_LIBS = [
    Path.home() / "Applications/KiCad/KiCad.app/Contents/Frameworks/libngspice.0.dylib",
    Path("/Applications/KiCad/KiCad.app/Contents/Frameworks/libngspice.0.dylib"),
    Path("/usr/lib/x86_64-linux-gnu/libngspice.so.0"),
    Path("/usr/lib/libngspice.so.0"),
]


class SimError(RuntimeError):
    pass


def engine() -> tuple[str, str]:
    """('cli', path) or ('lib', path) - which ngspice this machine has."""
    cli = shutil.which("ngspice")
    if cli and not os.environ.get("NGSPICE_LIB"):
        return "cli", cli
    for p in [os.environ.get("NGSPICE_LIB")] + [str(x) for x in KICAD_LIBS]:
        if p and Path(p).exists():
            return "lib", p
    raise SimError("ngspice not found: `brew install ngspice`, or install KiCad (libngspice)")


def version() -> str:
    kind, path = engine()
    if kind == "cli":
        out = subprocess.run([path, "-v"], capture_output=True, text=True, timeout=30).stdout
    else:
        out = _lib_subprocess(path, None, ["version"])
    for line in out.splitlines():
        if "ngspice-" in line:
            return f"{line.strip(' *').split(':')[0].strip()} ({kind}: {path})"
    return f"ngspice ({kind}: {path})"


def run(netlist: str, analysis: str | list[str], vectors: list[str], workdir: Path,
        name: str, timeout: int = 900, extra_control: list[str] | None = None) -> dict:
    """Run ``analysis`` (e.g. ``tran 10n 2m``) on ``netlist`` and return {vector: ndarray}.

    The first column (time / frequency) is returned under key ``x``. Complex AC vectors are
    written as magnitude (``mag(v)``) or phase by the caller's expressions.
    """
    workdir.mkdir(parents=True, exist_ok=True)
    cir = workdir / f"{name}.cir"
    data = workdir / f"{name}.dat"
    if data.exists():
        data.unlink()
    analyses = [analysis] if isinstance(analysis, str) else analysis
    ctl = [".control", "set wr_singlescale", "set wr_vecnames", "option numdgt=9"]
    ctl += list(extra_control or [])
    ctl += analyses
    ctl += [f"wrdata {data.name} " + " ".join(vectors), "quit", ".endc"]
    text = netlist.rstrip() + "\n" + "\n".join(ctl) + "\n.end\n"
    cir.write_text(text)
    kind, path = engine()
    if kind == "cli":
        proc = subprocess.run([path, "-b", "-D", "ngbehavior=psa", cir.name], cwd=workdir,
                              capture_output=True, text=True, timeout=timeout)
        log = proc.stdout + proc.stderr
    else:
        log = _lib_subprocess(path, workdir, _codemodels(path) + [
            "set ngbehavior=psa", f"source {cir.name}"], timeout=timeout)
    (workdir / f"{name}.log").write_text(log)
    if not data.exists():
        tail = "\n".join(log.splitlines()[-25:])
        raise SimError(f"{name}: ngspice wrote no data (see {workdir / (name + '.log')})\n{tail}")
    return _read_wrdata(data, vectors)


def _read_wrdata(path: Path, vectors: list[str]) -> dict:
    lines = path.read_text().splitlines()
    head = lines[0].split()
    arr = np.loadtxt(lines[1:], ndmin=2)
    out = {"x": arr[:, 0]}
    # wr_singlescale: one scale column then one column per vector (in the order asked for)
    for i, v in enumerate(vectors):
        out[v] = arr[:, 1 + i]
    out["_header"] = head
    return out


# --- shared-library mode: run ngspice in a child process ------------------------------------
def _codemodels(lib: str) -> list[str]:
    """KiCad's libngspice has no spinit: load its XSPICE code models by hand (the PSpice
    VSWITCH/ABM translations in psa mode need analog.cm)."""
    here = Path(lib).resolve().parent
    for d in (here.parent / "PlugIns/sim/ngspice", here / "ngspice", Path("/usr/lib/ngspice")):
        if d.is_dir():
            return [f"codemodel {cm}" for cm in sorted(d.glob("*.cm"))]
    return []


def _lib_subprocess(lib: str, cwd: Path | None, commands: list[str], timeout: int = 900) -> str:
    proc = subprocess.run([sys.executable, __file__, "--lib", lib, *commands], cwd=cwd,
                          capture_output=True, text=True, timeout=timeout)
    return proc.stdout + proc.stderr


def _lib_main(lib: str, commands: list[str]) -> None:
    ng = ctypes.CDLL(lib)
    out_cb = ctypes.CFUNCTYPE(ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_void_p)
    exit_cb = ctypes.CFUNCTYPE(ctypes.c_int, ctypes.c_int, ctypes.c_bool, ctypes.c_bool,
                               ctypes.c_int, ctypes.c_void_p)

    def printer(s, _i, _p):
        print(s.decode(errors="replace").removeprefix("stdout ").removeprefix("stderr "))
        return 0

    def on_exit(*_a):
        sys.stdout.flush()
        os._exit(0)

    p, e = out_cb(printer), exit_cb(on_exit)
    ng.ngSpice_Init(p, p, e, None, None, None, None)
    for c in commands:
        ng.ngSpice_Command(c.encode())
    sys.stdout.flush()


if __name__ == "__main__" and len(sys.argv) > 2 and sys.argv[1] == "--lib":
    _lib_main(sys.argv[2], sys.argv[3:])


def native_switches(text: str) -> str:
    """Rewrite PSpice ``.MODEL x VSWITCH Ron= Roff= Von= Voff=`` as ngspice's native ``SW``
    model (VT = mid-point, VH = half the gap). In psa mode ngspice otherwise maps VSWITCH onto
    the XSPICE ``aswitch`` code model, which loses the small-signal path in AC analysis
    (seen with the LP5907 model: the PSRR path vanished). Documented model transformation;
    the electrical parameters are unchanged."""
    import re

    def conv(m: re.Match) -> str:
        p = {k.lower(): v for k, v in re.findall(r"(\w+)\s*=\s*([-+0-9.eE]+[a-zA-Z]*)", m.group(2))}
        von, voff = _num(p.get("von", "1")), _num(p.get("voff", "0"))
        vt, vh = (von + voff) / 2, abs(von - voff) / 2
        return (f".model {m.group(1)} SW(RON={p.get('ron', '1')} ROFF={p.get('roff', '1e6')} "
                f"VT={vt:.6g} VH={vh:.6g})")

    return re.sub(r"^\s*\.model\s+(\S+)\s+VSWITCH\b(.*)$", conv, text, flags=re.I | re.M)


def _num(s: str) -> float:
    """SPICE number with an optional scale suffix ('1m', '100e6', '1meg', '0.5V')."""
    import re

    m = re.fullmatch(r"([-+]?[0-9.]+(?:e[-+]?[0-9]+)?)(meg|[kmunpfgt])?v?", s.strip().lower())
    if not m:
        raise ValueError(f"not a SPICE number: {s!r}")
    mult = {"meg": 1e6, "k": 1e3, "m": 1e-3, "u": 1e-6, "n": 1e-9, "p": 1e-12, "f": 1e-15,
            "g": 1e9, "t": 1e12}
    return float(m.group(1)) * mult.get(m.group(2) or "", 1.0)
