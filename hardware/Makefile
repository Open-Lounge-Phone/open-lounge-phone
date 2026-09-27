# OpenTinCan hardware: schematic-as-code (SKiDL). See SCHEMATIC.md.
PY := .venv/bin/python

.PHONY: all venv build lcsc footprints clean

all: build

venv: .venv/.ok
.venv/.ok: requirements.txt
	python3.13 -m venv .venv || python3 -m venv .venv
	.venv/bin/pip install -q -r requirements.txt
	touch $@

# ERC + checks + netlists + BOMs for every board x variant (offline; uses lcsc_cache.json)
build: venv
	cd schematic && ../$(PY) build.py

# Re-verify every LCSC code used by the design against lcsc.com (network) and refresh the cache
lcsc: venv
	cd schematic && ../$(PY) lcsc.py --all

clean:
	rm -rf build

# Refresh the cached KiCad footprint-library listings (network)
footprints: venv
	cd schematic && ../$(PY) fpcheck.py --all
