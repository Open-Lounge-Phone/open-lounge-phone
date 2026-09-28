"""Check that every footprint name exists in the official KiCad footprint library.

Uses the GitLab API for kicad/libraries/kicad-footprints (master) and caches the list of
footprints per library in ``fp_cache.json`` (committed), so `make build` stays offline.
Footprints in the ``OpenLoungePhone:`` library are project-local and must still be drawn
(listed as TODO by checks.py).

    python fpcheck.py RF_Module Connector_USB     # refresh these libraries (network)
    python fpcheck.py --all                        # refresh every library the design uses
"""

from __future__ import annotations

import json
import sys
import urllib.parse
import urllib.request
from pathlib import Path

CACHE = Path(__file__).with_name("fp_cache.json")
API = ("https://gitlab.com/api/v4/projects/kicad%2Flibraries%2Fkicad-footprints/repository/tree"
       "?path={}.pretty&per_page=100&page={}")


def load_cache() -> dict:
    return json.loads(CACHE.read_text()) if CACHE.exists() else {}


def fetch_lib(lib: str) -> list[str]:
    names, page = [], 1
    while True:
        url = API.format(urllib.parse.quote(lib), page)
        with urllib.request.urlopen(urllib.request.Request(url), timeout=30) as r:
            batch = json.load(r)
        names += [x["name"].removesuffix(".kicad_mod") for x in batch]
        if len(batch) < 100:
            return sorted(names)
        page += 1


def refresh(libs: list[str]) -> dict:
    cache = load_cache()
    for lib in libs:
        try:
            cache[lib] = fetch_lib(lib)
            print(f"{lib}: {len(cache[lib])} footprints")
        except Exception as exc:
            print(f"{lib}: fetch failed ({exc})", file=sys.stderr)
    CACHE.write_text(json.dumps(dict(sorted(cache.items())), indent=0) + "\n")
    return cache


def status(footprint: str, cache: dict | None = None) -> str:
    """'ok', 'local' (OpenLoungePhone: library, to be drawn), 'missing' or 'unknown-lib'."""
    cache = cache if cache is not None else load_cache()
    lib, _, name = footprint.partition(":")
    if lib == "OpenLoungePhone":
        return "local"
    if lib not in cache:
        return "unknown-lib"
    return "ok" if name in cache[lib] else "missing"


if __name__ == "__main__":
    args = sys.argv[1:]
    if args == ["--all"]:
        sys.path.insert(0, str(Path(__file__).parent))
        import parts  # noqa: F401
        from lib import SPECS

        args = sorted({s.footprint.split(":")[0] for s in SPECS.values()} - {"OpenLoungePhone"})
    refresh(args)
