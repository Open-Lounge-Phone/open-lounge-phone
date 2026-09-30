#!/usr/bin/env python3
"""CI check of the firmware release scheme (README "Updates"). Fails if:

- the phone's default update URL is not the fixed channel fw-stable/firmware-manifest.json, or
  uses /releases/latest (the newest release can be a hardware release, hw-v*);
- tools/release.sh would create a firmware release under another tag than fw-vX.Y.Z, mark it
  as the repo's latest release, or update another channel;
- the manifest's signed text differs between the firmware (main/ota_core.c) and the release tool
  (tools/ota_manifest.py), or either drops the board id;
- the board id isn't set.
"""
import re
import sys
from pathlib import Path

FW = Path(__file__).resolve().parent.parent
errors = []


def check(cond: bool, what: str) -> None:
    if not cond:
        errors.append(what)


kconfig = (FW / "main/Kconfig.projbuild").read_text()


def default(symbol: str) -> str:
    m = re.search(rf"^config {symbol}\n(?:.*\n)*?    default \"([^\"]*)\"", kconfig, re.M)
    return m.group(1) if m else ""


url = default("OLP_OTA_MANIFEST_URL")
check(url.endswith("/releases/download/fw-stable/firmware-manifest.json"),
      f"default update URL is not the fw-stable channel: {url!r}")
check("/releases/latest" not in url, "the default update URL uses /releases/latest")
check(url.startswith("https://github.com/Open-Lounge-Phone/open-lounge-phone/"), f"repo in {url!r}")
board = default("OLP_BOARD_ID")
check(board == "minimal-revA", f"board id {board!r}")

release = (FW / "tools/release.sh").read_text()
creates = re.findall(r"gh release create \"([^\"]+)\"", release)
check(set(creates) == {"fw-v$v", "$CHANNEL"}, f"release.sh creates {creates}")
check(re.search(r'^CHANNEL="fw-stable"$', release, re.M) is not None, "channel is not fw-stable")
for line in release.splitlines():
    if 'gh release create "fw-v$v"' in line:
        check("--latest=false" in line, "a fw-v release would become the repo's latest release")
check("/releases/latest" not in release.replace("# Phones never look at /releases/latest", ""),
      "release.sh refers to /releases/latest")

core = (FW / "main/ota_core.c").read_text()
tool = (FW / "tools/ota_manifest.py").read_text()
c_fmt = re.search(r'"(olp-ota-v1[^"]*)"', core)
check(c_fmt is not None and c_fmt.group(1) == r"olp-ota-v1\n%s\n%s\n%s\n%s\n%lu\n",
      "ota_core.c signed text changed")
check(r"olp-ota-v1\n{m['board']}\n{m['version']}\n{m['url']}\n{m['sha256']}\n{m['size']}\n" in tool,
      "ota_manifest.py signed text changed")
check("m->board, m->version, m->url" in core, "ota_core.c signs the fields in another order")

if errors:
    print("release scheme check FAILED:\n  " + "\n  ".join(errors))
    sys.exit(1)
print("release scheme OK: channel fw-stable, tags fw-v*, board", board)
