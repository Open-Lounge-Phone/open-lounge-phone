"""Paths and small helpers shared by the layout scripts (run under KiCad's bundled Python)."""

from __future__ import annotations

import os
import sys
from pathlib import Path

HW = Path(__file__).resolve().parent.parent          # hardware/
LAYOUT = HW / "layout"
BUILD = HW / "build"
KICAD_OUT = HW / "kicad"
TOOLS = HW / ".tools"

KICAD_APP = Path(os.environ.get("KICAD_APP", Path.home() / "Applications/KiCad/KiCad.app"))
if not KICAD_APP.exists():
    KICAD_APP = Path("/Applications/KiCad/KiCad.app")
KICAD_CLI = os.environ.get("KICAD_CLI", str(KICAD_APP / "Contents/MacOS/kicad-cli"))
KICAD_SHARE = KICAD_APP / "Contents/SharedSupport"
FP_DIR = Path(os.environ.get("KICAD10_FOOTPRINT_DIR", KICAD_SHARE / "footprints"))
MODEL_DIR = Path(os.environ.get("KICAD10_3DMODEL_DIR", KICAD_SHARE / "3dmodels"))
PROJECT_FP_LIB = LAYOUT / "footprints" / "openloungephone.pretty"
FREEROUTING_VERSION = "2.4.1"
FREEROUTING_JAR = Path(os.environ.get("FREEROUTING_JAR",
                                      TOOLS / f"freerouting-{FREEROUTING_VERSION}.jar"))
# FreeRouting 2.4 needs Java 25: `make tools` unpacks Temurin 25 into .tools/ (no sudo)
_jdk = sorted(TOOLS.glob("jdk-25*/Contents/Home/bin/java")) + sorted(TOOLS.glob("jdk-25*/bin/java"))
JAVA = os.environ.get("JAVA", str(_jdk[-1]) if _jdk else "java")

# PyYAML is not bundled with KiCad's Python: `make layout` installs it into .tools/pylib.
sys.path.insert(0, str(TOOLS / "pylib"))
sys.path.insert(0, str(LAYOUT))


def lib_path(lib: str) -> Path:
    if lib == "OpenLoungePhone":
        return PROJECT_FP_LIB
    return FP_DIR / f"{lib}.pretty"


def load_yaml(path: Path):
    import yaml

    return yaml.safe_load(path.read_text())
