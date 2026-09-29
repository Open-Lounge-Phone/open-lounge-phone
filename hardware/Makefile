# Open Lounge Phone hardware: schematic-as-code (SKiDL). See SCHEMATIC.md.
PY := .venv/bin/python

.PHONY: all venv build lcsc footprints clean layout tools freerouting proto review

# KiCad 10 (bundled Python has pcbnew); override KICAD_APP for a different install location
KICAD_APP ?= $(firstword $(wildcard $(HOME)/Applications/KiCad/KiCad.app /Applications/KiCad/KiCad.app))
KPY := $(KICAD_APP)/Contents/Frameworks/Python.framework/Versions/3.9/bin/python3
FR_VERSION := 2.4.1
JDK_ARCH := $(if $(filter arm64,$(shell uname -m)),aarch64,x64)

all: build layout

venv: .venv/.ok
.venv/.ok: requirements.txt
	python3.13 -m venv .venv || python3 -m venv .venv
	.venv/bin/pip install -q -r requirements.txt
	touch $@

# ERC + checks + netlist + BOM + cost for the board into build/ (offline; uses lcsc_cache.json)
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

# Layout toolchain into .tools/ (git-ignored, no sudo): PyYAML + numpy for KiCad's Python
# (the router is our own, layout/router.py). `make freerouting` fetches the optional
# FreeRouting $(FR_VERSION) + Java 25 runtime for `build_board.py --router freerouting`.
tools: .tools/.ok
.tools/.ok:
	mkdir -p .tools
	$(KPY) -m pip install -q --target .tools/pylib pyyaml "numpy<2.1"
	touch $@

freerouting: .tools/freerouting-$(FR_VERSION).jar
.tools/freerouting-$(FR_VERSION).jar:
	mkdir -p .tools
	curl -fsSL -o .tools/jdk25.tar.gz \
	  "https://api.adoptium.net/v3/binary/latest/25/ga/mac/$(JDK_ARCH)/jdk/hotspot/normal/eclipse"
	cd .tools && tar xzf jdk25.tar.gz && rm jdk25.tar.gz
	curl -fsSL -o $@ \
	  https://github.com/freerouting/freerouting/releases/download/v$(FR_VERSION)/freerouting-$(FR_VERSION).jar

# Board (place + grid router, cached on an input hash), checks, fab outputs into build/.
# FORCE=1 re-routes every board. Fails on DRC errors / unrouted nets / layout-check errors.
layout: tools
	cd layout && $(KPY) run_layout.py $(if $(FORCE),--force,)

# Prototype box (code CAD in enclosure/, see enclosure/PROTO_BOX.md)
proto:
	$(MAKE) -C enclosure proto

# Review pack (build/review/): schematic sheets, per-layer board PDF, 3D renders, DRC summary
review: venv
	layout/review_pack.sh
