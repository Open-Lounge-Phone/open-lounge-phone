# Open Lounge Phone hardware: schematic-as-code (SKiDL). See SCHEMATIC.md.
PY := .venv/bin/python

.PHONY: all venv build review lcsc footprints sim proto tools freerouting clean

# KiCad 10 (bundled Python has pcbnew); override KICAD_APP for a different install location
KICAD_APP ?= $(firstword $(wildcard $(HOME)/Applications/KiCad/KiCad.app /Applications/KiCad/KiCad.app))
KPY := $(KICAD_APP)/Contents/Frameworks/Python.framework/Versions/3.9/bin/python3
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

# Prototype box (code CAD in enclosure/; regenerated for the minimal board in M2)
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
