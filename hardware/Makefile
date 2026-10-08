# Open Lounge Phone hardware: schematic-as-code (SKiDL). See SCHEMATIC.md.
PY := .venv/bin/python

.PHONY: all venv build review lcsc footprints sim proto tools freerouting place placement route fab clean

# KiCad 10 (bundled Python has pcbnew); override KICAD_APP for a different install location
KICAD_APP ?= $(firstword $(wildcard $(HOME)/Applications/KiCad/KiCad.app /Applications/KiCad/KiCad.app))
KPY := $(KICAD_APP)/Contents/Frameworks/Python.framework/Versions/3.9/bin/python3
KICAD_CLI := $(KICAD_APP)/Contents/MacOS/kicad-cli
# `make fab PREVIEWS=dir` also copies routed-top.png, routed-bottom.png and layers.pdf there
PREVIEWS ?=
FR_VERSION := 2.4.1
JDK_ARCH := $(if $(filter arm64,$(shell uname -m)),aarch64,x64)

all: build review

venv: .venv/.ok
.venv/.ok: requirements.txt
	python3.13 -m venv .venv || python3 -m venv .venv
	.venv/bin/pip install -q -r requirements.txt
	touch $@

# ERC + checks + netlist + BOM + part count + cost into build/ (offline; uses the caches)
build: venv
	cd schematic && ../$(PY) build.py

# Readable schematic PDF, one page per block: build/review/schematic.pdf
review: build
	cd schematic && ../$(PY) review.py --out ../build/review/schematic.pdf

# Re-verify every LCSC code used by the design against lcsc.com + JLCPCB (network)
lcsc: venv
	cd schematic && ../$(PY) lcsc.py --all

# Refresh the cached KiCad footprint-library listings (network)
footprints: venv
	cd schematic && ../$(PY) fpcheck.py --all

# Regulator load-step bench (sim/README.md): ngspice from PATH or KiCad's libngspice
sim: venv
	$(PY) sim/run.py

# M2 placement: kicad/main/main.kicad_pcb from the netlist (layout/place.py, KiCad's Python)
place: build tools
	cd layout && $(KPY) place.py

# Placement review: DRC (build/review/main-drc.json), straight-line wiring length + crossings,
# decoupling gaps and the owner image build/review/placement.png (lanes drawn in the image only).
# It re-places the board (unrouted) for the review, then runs `make route` so the committed
# kicad/main/main.kicad_pcb always keeps its copper.
placement: place
	mkdir -p build/review
	cd layout && $(KPY) dump_parts.py main ../build/review/placement.json
	$(KICAD_APP)/Contents/MacOS/kicad-cli pcb drc --format json --severity-all \
	  -o build/review/main-drc.json kicad/main/main.kicad_pcb >/dev/null
	python3 layout/drcsum.py build/review/main-drc.json
	$(PY) layout/review_placement.py
	$(MAKE) route

# M3 routing (layout/route.py): the placed board -> copper, GND fills, stitching, then the
# route checks (build/review/route-metrics.txt) and KiCad DRC; fails on any DRC error or
# unconnected item. Deterministic: the same placement gives the same copper.
route: place
	cd layout && $(KPY) route.py
	mkdir -p build/review
	cd layout && $(KPY) route_metrics.py ../build/review/route-metrics.txt
	$(KICAD_CLI) pcb drc --format json --severity-all \
	  -o build/review/main-drc.json kicad/main/main.kicad_pcb >/dev/null
	python3 layout/drcsum.py build/review/main-drc.json --strict

# Fab + review outputs into build/main/fab/ (Gerbers, drill, JLC BOM/CPL, IPC-2581, STEP,
# renders, layers PDF, routed images), the GPIO map for the firmware and a 5-board JLC quote
fab: route
	cd layout && $(KPY) export.py main $(if $(PREVIEWS),--previews $(abspath $(PREVIEWS)))
	$(PY) layout/gpio_map.py
	$(PY) schematic/cost.py --boards 5 > build/main/fab/jlc-order.txt
	cat build/main/fab/jlc-order.txt

# Core shell (code CAD in enclosure/)
proto:
	$(MAKE) -C enclosure proto

# Layout tooling for M2 into .tools/ (git-ignored, no sudo): PyYAML + numpy for KiCad's Python
# (layout/export.py, layout/dump_parts.py). `make freerouting` fetches FreeRouting + a JDK.
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

clean:
	rm -rf build
