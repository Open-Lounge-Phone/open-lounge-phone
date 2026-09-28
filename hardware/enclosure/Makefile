# Open Lounge Phone enclosure (code CAD, build123d). See ENCLOSURE.md.
#   make            -> build/stl, build/step, build/renders, build/web, build/checks.txt (fails on FAIL)
#   make sync       -> re-read board geometry from hardware/kicad/*/*.kicad_pcb into params.yaml
#   make fast       -> exports + checks + web, no PNG renders
PY := .venv/bin/python

.PHONY: enclosure fast sync venv clean
enclosure: venv
	$(PY) build.py

fast: venv
	$(PY) build.py --no-render

sync: venv
	$(PY) sync_params.py

venv: .venv/.ok
.venv/.ok: requirements.txt
	python3.12 -m venv .venv || python3.13 -m venv .venv || python3 -m venv .venv
	.venv/bin/pip install -q --upgrade pip
	.venv/bin/pip install -q -r requirements.txt
	touch $@

clean:
	rm -rf build
