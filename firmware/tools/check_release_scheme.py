#!/usr/bin/env python3
"""CI check of the firmware release scheme (README "Updates", "Your keys, your server"). Fails if:

- a source build (the Kconfig defaults, sdkconfig.defaults) would turn updates on, embed an
  update key or URL, or connect to a server: those defaults are empty;
- the official release build (sdkconfig.defaults + sdkconfig.release, what tools/release.sh build
  uses) doesn't embed the project's public key (main/ota_signing_pub.pem, a public key only) and
  the official channel fw-stable/firmware-manifest.json, or uses /releases/latest (the newest
  release can be a hardware release, hw-v*);
- a private key is anywhere under firmware/ outside the gitignored keys/;
- tools/release.sh would create a firmware release under another tag than fw-vX.Y.Z, mark it
  as the repo's latest release, or update another channel;
- the manifest's signed text differs between the firmware (main/ota_core.c) and the release tool
  (tools/ota_manifest.py), or either drops the board id;
- the board ids aren't what phones expect: rev A (the default board) minimal-revA, hw v0.2
  minimal-v02, distinct, chosen by the board choice and not settable by hand; a board's
  sdkconfig fragment sets anything but the board; each board has its own manifest in the
  channel (rev A keeps firmware-manifest.json, the name its phones read).

With --default-build DIR (a build from the defaults, e.g. CI's `idf.py build`) it also checks the
built image: no update key, no update URL, no server, no project host to call, the rev A board,
and no wired network code linked (no esp_eth object). With --board-build DIR (a build with
sdkconfig.v02) it checks the same of that image, its board id and that its W5500 driver is in.

With --release-build DIR (tools/release.sh build → build-release) it checks the image embeds the
project's public key and the official channel.
"""
import argparse
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


OFFICIAL = "https://github.com/Open-Lounge-Phone/open-lounge-phone/releases/download/fw-stable/firmware-manifest.json"


def bool_default(symbol: str) -> str:
    m = re.search(rf"^config {symbol}\n(?:    .*\n|\n)*?    default (y|n)\n", kconfig, re.M)
    return m.group(1) if m else ""


def layered(*files: str) -> dict:
    """The CONFIG_ values a build gets from these sdkconfig defaults files, later ones winning."""
    out = {}
    for f in files:
        for line in (FW / f).read_text().splitlines():
            m = re.match(r"^(CONFIG_\w+)=(.*)$", line)
            if m:
                out[m.group(1)] = m.group(2).strip('"')
            m = re.match(r"^# (CONFIG_\w+) is not set$", line)
            if m:
                out[m.group(1)] = "n"
    return out


# Source builds: no updates, no key, no URL, no server.
check(bool_default("OLP_OTA") == "n", "updates (OLP_OTA) are on by default")
check(default("OLP_OTA_MANIFEST_URL") == "", "a default update URL is set")
check(default("OLP_SERVER_URL") == "", f"a default server is set: {default('OLP_SERVER_URL')!r}")
check(not default("OLP_OTA_PUBKEY").startswith("main/"),
      "the default update key is in the tree (source builds must use the builder's own key)")
src = layered("sdkconfig.defaults")
for sym in ("CONFIG_OLP_OTA", "CONFIG_OLP_OTA_PUBKEY", "CONFIG_OLP_OTA_MANIFEST_URL",
            "CONFIG_OLP_SERVER_URL"):
    check(sym not in src, f"sdkconfig.defaults sets {sym}")
for f in ("sdkconfig.sim", "sdkconfig.qemu", "sdkconfig.v02"):
    for sym, v in layered(f).items():
        check(not (sym.startswith("CONFIG_OLP_OTA") or sym == "CONFIG_OLP_SERVER_URL"),
              f"{f} sets {sym}={v!r}")

# The official release build embeds the project's key and channel.
rel = layered("sdkconfig.defaults", "sdkconfig.release")
url = rel.get("CONFIG_OLP_OTA_MANIFEST_URL", "")
check(rel.get("CONFIG_OLP_OTA") == "y", "the release build doesn't turn updates on")
check(rel.get("CONFIG_OLP_OTA_PUBKEY") == "main/ota_signing_pub.pem",
      f"the release build's key: {rel.get('CONFIG_OLP_OTA_PUBKEY')!r}")
check(url == OFFICIAL, f"the release build's update URL is not the official fw-stable channel: {url!r}")
check("/releases/latest" not in url, "the release update URL uses /releases/latest")
check(rel.get("CONFIG_SECURE_BOOT_SIGNING_KEY") == "keys/ota_signing_key.pem", "release signing key")
check("CONFIG_OLP_SERVER_URL" not in rel, "the release build bakes in a server")
pub = (FW / "main/ota_signing_pub.pem").read_text()
check(pub.startswith("-----BEGIN PUBLIC KEY-----") and "PRIVATE" not in pub,
      "main/ota_signing_pub.pem is not a public key")
for f in FW.rglob("*"):
    rel_path = f.relative_to(FW).parts
    if not f.is_file() or rel_path[0] in ("keys", "managed_components") or rel_path[0].startswith("build"):
        continue
    if f.suffix in (".pem", ".key", ".defaults", "") or f.name.startswith("sdkconfig"):
        try:
            check("PRIVATE KEY-----" not in f.read_text(errors="ignore"), f"a private key in {f}")
        except OSError:
            pass

# Board ids: one per board, from the board choice, never typed in.
bid = re.search(r"^config OLP_BOARD_ID\n((?:    .*\n|\n)*?)(?=^\S|\Z)", kconfig, re.M)
bid_body = bid.group(1) if bid else ""
check(re.match(r"    string\n", bid_body) is not None,
      "OLP_BOARD_ID has a prompt: it must come from the board choice only")
board = (re.findall(r'^    default "([^"]*)"$', bid_body, re.M) or [""])[0]
board_v02 = dict(re.findall(r'^    default "([^"]*)" if (OLP_BOARD_\w+)$', bid_body, re.M))
check(board == "minimal-revA", f"rev A board id {board!r}")
check(board_v02.get("minimal-v02") == "OLP_BOARD_V02",
      f"hw v0.2 board id: {board_v02!r}")
check(re.search(r"^choice OLP_BOARD\n(?:    .*\n)*?    default OLP_BOARD_REVA\n", kconfig, re.M)
      is not None, "the default board is not rev A")
frag = layered("sdkconfig.v02")
check(frag == {"CONFIG_OLP_BOARD_V02": "y"}, f"sdkconfig.v02 sets more than the board: {frag}")

release = (FW / "tools/release.sh").read_text()
creates = re.findall(r"gh release create \"([^\"]+)\"", release)
check(set(creates) == {"fw-v$v", "$CHANNEL"}, f"release.sh creates {creates}")
check(re.search(r'^CHANNEL="fw-stable"$', release, re.M) is not None, "channel is not fw-stable")
check(re.search(r'^OFFICIAL="Open-Lounge-Phone/open-lounge-phone"$', release, re.M) is not None,
      "release.sh's official repo")
check('defaults="sdkconfig.defaults;sdkconfig.release$(board_defaults "$b")"' in release,
      "release.sh doesn't build from sdkconfig.release (+ the board's fragment)")
check(re.search(r'^BOARDS="reva v02"$', release, re.M) is not None, "release.sh's boards")
check('manifest_name() { [ "$1" = minimal-revA ] && echo "firmware-manifest.json" || '
      'echo "firmware-manifest-$1.json"; }' in release,
      "release.sh: rev A must keep firmware-manifest.json, other boards their own manifest")
check('PUB="main/ota_signing_pub.pem"' in release, "release.sh's official key")
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


def sdkconfig_h(build: Path) -> str:
    return (build / "config/sdkconfig.h").read_text()


def image(build: Path) -> bytes:
    return (build / "openloungephone.bin").read_bytes()


ap = argparse.ArgumentParser()
ap.add_argument("--default-build", type=Path)
ap.add_argument("--board-build", type=Path, help="a source build with sdkconfig.v02")
ap.add_argument("--release-build", type=Path)
opts = ap.parse_args()


def linked(d: Path, lib: str) -> set:
    """The objects the linker pulled from a library (from the map file)."""
    return set(re.findall(rf"{re.escape(lib)}\(([^)]+)\)", (d / "openloungephone.map").read_text()))


for d, rev_a in ((opts.default_build, True), (opts.board_build, False)):
    if not d:
        continue
    d = FW / d
    h, img = sdkconfig_h(d), image(d)
    want = "minimal-revA" if rev_a else "minimal-v02"
    check(f'#define CONFIG_OLP_BOARD_ID "{want}"' in h, f"{d}: board id is not {want}")
    eth = linked(d, "libesp_eth.a")
    if rev_a:
        check("#define CONFIG_OLP_BOARD_REVA 1" in h, f"{d}: not a rev A build")
        check(not eth, f"{d}: a rev A image links wired network code: {sorted(eth)}")
    else:
        check("#define CONFIG_OLP_BOARD_V02 1" in h, f"{d}: not a hw v0.2 build")
        check("esp_eth_mac_w5500.c.obj" in eth, f"{d}: the W5500 driver isn't linked")
    check("#define CONFIG_OLP_OTA 1" not in h, f"{d}: updates are on")
    check("CONFIG_OLP_OTA_MANIFEST_URL" not in h, f"{d}: an update URL is configured")
    check('#define CONFIG_OLP_SERVER_URL ""' in h, f"{d}: a server is configured")
    body = "".join(l for l in pub.splitlines() if "-----" not in l)
    check(body[:64].encode() not in img, f"{d}: the image embeds the project's update key")
    check(b"_binary_ota_pubkey_pem" not in (d / "openloungephone.map").read_bytes(),
          f"{d}: the image embeds an update key")
    for host in (b"l1.openloungephone.app", b"github.com/Open-Lounge-Phone", b"/releases/download/"):
        check(host not in img, f"{d}: the image contains {host.decode()}")
if opts.release_build:
    d = FW / opts.release_build
    h, img = sdkconfig_h(d), image(d)
    check("#define CONFIG_OLP_OTA 1" in h, f"{d}: updates are off")
    check(f'#define CONFIG_OLP_OTA_MANIFEST_URL "{OFFICIAL}"' in h, f"{d}: not the official channel")
    check(OFFICIAL.encode() in img, f"{d}: the image lacks the official channel URL")
    body = "".join(l for l in pub.splitlines() if "-----" not in l)
    check(body[:64].encode() in img, f"{d}: the image doesn't embed main/ota_signing_pub.pem")

if errors:
    print("release scheme check FAILED:\n  " + "\n  ".join(errors))
    sys.exit(1)
print("release scheme OK: source builds have no server, no update key, no update URL; the "
      "release build embeds the official key and fw-stable channel; tags fw-v*; boards", board, "and", "minimal-v02")
