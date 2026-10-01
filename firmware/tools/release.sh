#!/usr/bin/env bash
# Firmware releases: build a signed image, write its signed manifest, and (only when asked)
# upload both to a GitHub release. Official releases go to Open-Lounge-Phone/open-lounge-phone;
# anyone can run their own channel for their own phones with --repo you/your-fork and their own key.
#
# Tags: hardware releases are hw-vX.Y (fab files), firmware releases fw-vX.Y.Z (image + manifest).
# Phones never look at /releases/latest (that can be a hardware release): they read the fixed
# channel fw-stable/firmware-manifest.json, which `publish --release` replaces.
#
#   firmware/tools/release.sh keygen            your key pair: firmware/keys/ota_signing_key.pem
#                                               and keys/ota_signing_pub.pem (both gitignored)
#   firmware/tools/release.sh build             signed build of PROJECT_VER into build-release/dist/
#   firmware/tools/release.sh publish --draft   a DRAFT fw-vX.Y.Z release (default); the channel is
#                                               untouched, so no phone sees it
#   firmware/tools/release.sh publish --release the real release + the channel update: phones
#                                               install it (ask the owner first; it asks too)
#   --repo owner/name (after the command)       your repo: your key (keys/ota_signing_pub.pem) and
#                                               your channel; default: the official one, whose
#                                               public key is main/ota_signing_pub.pem
#
# Source builds have no update key and no channel (updates off). Only these release builds embed
# one: the official key and channel (sdkconfig.release), or yours with --repo. The private key
# never leaves firmware/keys/ and is never printed; a new key needs a USB flash of every phone.
set -euo pipefail
FW="$(cd "$(dirname "$0")/.." && pwd)"
cd "$FW"
OFFICIAL="Open-Lounge-Phone/open-lounge-phone"
REPO="$OFFICIAL"
KEY="keys/ota_signing_key.pem"
B="build-release"
CHANNEL="fw-stable"
cmd="${1:-}"
[ $# -gt 0 ] && shift
args=()
while [ $# -gt 0 ]; do
  case "$1" in
    --repo) REPO="${2:?--repo owner/name}"; shift 2 ;;
    *) args+=("$1"); shift ;;
  esac
done
# The official key's public half is in the repo; anyone else's sits next to their private key.
if [ "$REPO" = "$OFFICIAL" ]; then PUB="main/ota_signing_pub.pem"; else PUB="keys/ota_signing_pub.pem"; fi
CHANNEL_URL="https://github.com/$REPO/releases/download/$CHANNEL/firmware-manifest.json"
if [ "$cmd" = build ] && ! command -v idf.py >/dev/null; then
  idf="${IDF_PATH:-}"
  [ -n "$idf" ] || { [ -d "$HOME/esp/esp-idf-v5.5.5" ] && idf="$HOME/esp/esp-idf-v5.5.5"; }
  # shellcheck disable=SC1091
  . "${idf:-$HOME/esp/esp-idf}/export.sh" >/dev/null
fi
version() { sed -n 's/^set(PROJECT_VER "\(.*\)")$/\1/p' CMakeLists.txt; }
board() { sed -n '/^config OLP_BOARD_ID/,/^config/s/^    default "\(.*\)"$/\1/p' main/Kconfig.projbuild; }

case "$cmd" in
  keygen)
    [ -e "$KEY" ] && { echo "$KEY exists: refusing to replace the release key" >&2; exit 1; }
    command -v espsecure.py >/dev/null || . "${IDF_PATH:-$HOME/esp/esp-idf-v5.5.5}/export.sh" >/dev/null
    mkdir -p keys && chmod 700 keys
    (umask 077 && espsecure.py generate_signing_key --version 2 --scheme rsa3072 "$KEY" >/dev/null)
    openssl pkey -in "$KEY" -pubout -out keys/ota_signing_pub.pem
    echo "your update key: $KEY (back it up offline); public half: keys/ota_signing_pub.pem"
    echo "turn updates on in menuconfig (CONFIG_OLP_OTA), or: $0 build --repo you/your-repo"
    ;;
  build)
    [ -f "$KEY" ] || { echo "no $KEY: run \`$0 keygen\` (or restore your backup)" >&2; exit 1; }
    [ -f "$PUB" ] || { echo "no $PUB: run \`$0 keygen\` (or restore your backup)" >&2; exit 1; }
    # The embedded key must be the one we sign with, or phones would refuse the update.
    cmp -s <(openssl pkey -in "$KEY" -pubout) "$PUB" ||
      { echo "$PUB is not $KEY's public key (another repo? use --repo you/your-repo)" >&2; exit 1; }
    v="$(version)"
    rm -rf "$B"
    mkdir -p "$B"
    defaults="sdkconfig.defaults;sdkconfig.release"
    if [ "$REPO" != "$OFFICIAL" ]; then
      # Your release: your key and your channel instead of the official ones.
      printf 'CONFIG_OLP_OTA_PUBKEY="%s"\nCONFIG_OLP_OTA_MANIFEST_URL="%s"\n' "$PUB" "$CHANNEL_URL" \
        >"$B/sdkconfig.own"
      defaults="$defaults;$B/sdkconfig.own"
    fi
    idf.py -B "$B" -D SDKCONFIG="$B/sdkconfig" -D "SDKCONFIG_DEFAULTS=$defaults" build >"$B.log" 2>&1 ||
      { tail -30 "$B.log"; exit 1; }
    grep -qx "CONFIG_OLP_OTA_MANIFEST_URL=\"$CHANNEL_URL\"" "$B/sdkconfig" ||
      { echo "the build's update channel is not $CHANNEL_URL" >&2; exit 1; }
    mkdir -p "$B/dist"
    bin="$B/dist/openloungephone-$v.bin"
    cp "$B/openloungephone.bin" "$bin"
    espsecure.py verify_signature --version 2 --keyfile "$PUB" "$bin" >/dev/null
    url="https://github.com/$REPO/releases/download/fw-v$v/openloungephone-$v.bin"
    python tools/ota_manifest.py make --bin "$bin" --board "$(board)" --version "$v" --url "$url" \
      --key "$KEY" --out "$B/dist/firmware-manifest.json"
    python tools/ota_manifest.py verify --manifest "$B/dist/firmware-manifest.json" \
      --pub "$PUB" --bin "$bin"
    echo "$REPO" >"$B/dist/repo"
    ls -l "$B/dist"
    ;;
  publish)
    v="$(version)"
    mode="${args[0]:---draft}"
    m="$B/dist/firmware-manifest.json"
    [ -f "$m" ] || { echo "run \`$0 build\` first" >&2; exit 1; }
    [ "$(cat "$B/dist/repo" 2>/dev/null)" = "$REPO" ] ||
      { echo "build-release/ was built for another repo: build again with the same --repo" >&2; exit 1; }
    if [ "$mode" != "--release" ]; then
      gh release create "fw-v$v" --repo "$REPO" --draft --latest=false --title "Firmware $v" \
        --notes "Firmware $v for the $(board) board. See firmware/CHANGELOG.md." \
        "$B/dist/openloungephone-$v.bin" "$m"
      echo "draft fw-v$v created in $REPO; the channel ($CHANNEL) is unchanged"
      exit 0
    fi
    read -r -p "Publish fw-v$v in $REPO as a REAL release (phones will install it)? Type the version: " ok
    [ "$ok" = "$v" ] || { echo "not confirmed" >&2; exit 1; }
    # --latest=false: the newest *release* stays whatever it is (e.g. a hardware release).
    gh release create "fw-v$v" --repo "$REPO" --latest=false --title "Firmware $v" \
      --notes "Firmware $v for the $(board) board. See firmware/CHANGELOG.md." \
      "$B/dist/openloungephone-$v.bin" "$m"
    gh release view "$CHANNEL" --repo "$REPO" >/dev/null 2>&1 ||
      gh release create "$CHANNEL" --repo "$REPO" --prerelease --latest=false \
        --title "Firmware update channel (manifest only)" \
        --notes "Phones read firmware-manifest.json here. Updated by firmware/tools/release.sh."
    gh release upload "$CHANNEL" --repo "$REPO" --clobber "$m"
    ;;
  *)
    sed -n '2,23p' "$0" >&2
    exit 2
    ;;
esac
