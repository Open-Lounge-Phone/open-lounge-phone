#!/usr/bin/env bash
# Installs the third-party PCB design skills used for layout and review into .claude/skills/
# (gitignored), pinned to reviewed commits. All MIT licensed. Re-run after changing a pin.
set -euo pipefail
cd "$(dirname "$0")/../.."
dest=.claude/skills
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

fetch() { # repo commit
  git -C "$tmp" init -q "$(basename "$1")"
  git -C "$tmp/$(basename "$1")" fetch -q --depth 1 "https://github.com/$1" "$2"
  git -C "$tmp/$(basename "$1")" checkout -q FETCH_HEAD
}

fetch aklofas/kicad-happy a6bba1add1e18b89e3aa0824b9769ed1d9d79174          # design review + EMC pre-compliance
fetch Keitark/pcba-design-skills d41e9996f052016727403236cf0f7476f8f23a1b   # layout review policy/checklists
fetch bluzername/specs-to-pcb 5bf0c9837b0d07f851023c540060702ff4a01edc      # reference: headless KiCad 10 + FreeRouting pipeline

mkdir -p "$dest"
rm -rf "$dest"/kicad "$dest"/emc "$dest"/pcb-layout-review "$dest"/specs-to-pcb
cp -R "$tmp/kicad-happy/skills/kicad" "$dest/kicad"
cp -R "$tmp/kicad-happy/skills/emc" "$dest/emc"
cp -R "$tmp/pcba-design-skills/.agents/skills/pcb-layout-review" "$dest/pcb-layout-review"
cp -R "$tmp/specs-to-pcb" "$dest/specs-to-pcb"
rm -rf "$dest/specs-to-pcb/.git"
echo "installed: kicad, emc, pcb-layout-review, specs-to-pcb -> $dest"
