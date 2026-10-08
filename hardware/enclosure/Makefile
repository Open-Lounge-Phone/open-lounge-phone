# Open Lounge Phone core shell (code CAD, build123d). See PROTO_BOX.md.
#   make        -> build/proto/{tray,lid,bezel}.{stl,step} + checks.txt (fails on FAIL)
#   make render -> the same plus build/proto/proto.png
#   make parts  -> build/proto/board_parts.json from the placed board (needs KiCad 10); without
#                  it the part-fit checks against the board are skipped
PY := .venv/bin/python
KICAD_APP ?= $(firstword $(wildcard $(HOME)/Applications/KiCad/KiCad.app /Applications/KiCad/KiCad.app))
KPY := $(KICAD_APP)/Contents/Frameworks/Python.framework/Versions/3.9/bin/python3

.PHONY: proto render parts venv clean
proto: venv
	$(PY) proto_box.py

render: venv
	$(PY) proto_box.py --render

parts:
	mkdir -p build/proto
	cd ../layout && $(KPY) dump_parts.py main ../enclosure/build/proto/board_parts.json

venv: .venv/.ok
.venv/.ok: requirements.txt
	python3.12 -m venv .venv || python3.13 -m venv .venv || python3 -m venv .venv
	.venv/bin/pip install -q --upgrade pip
	.venv/bin/pip install -q -r requirements.txt
	touch $@

clean:
	rm -rf build
