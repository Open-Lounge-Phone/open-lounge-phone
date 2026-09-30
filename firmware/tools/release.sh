#!/usr/bin/env bash
# Firmware releases: build a signed image, write its signed manifest, and (only when asked)
# upload both to a GitHub release of Open-Lounge-Phone/open-lounge-phone.
#
# Tags: hardware releases are hw-vX.Y (fab files), firmware releases fw-vX.Y.Z (image + manifest).
# Phones never look at /releases/latest (that can be a hardware release): they read the fixed
# channel fw-stable/firmware-manifest.json, which `publish --release` replaces.
#
#   firmware/tools/release.sh keygen            the release key → firmware/keys/ (gitignored) and
#                                               its public half → main/ota_signing_pub.pem
#   firmware/tools/release.sh build             signed build of PROJECT_VER into build-release/dist/
#   firmware/tools/release.sh publish --draft   a DRAFT fw-vX.Y.Z release (default); the channel is
#                                               untouched, so no phone sees it
#   firmware/tools/release.sh publish --release the real release + the channel update: phones
#                                               install it (ask the owner first; it asks too)
#
# The private key never leaves firmware/keys/ and is never printed. Phones built from this tree
# trust main/ota_signing_pub.pem; a new key needs a USB flash of every phone (README "Updates").
set -euo pipefail
FW="$(cd "$(dirname "$0")/.." && pwd)"
cd "$FW"
REPO="Open-Lounge-Phone/open-lounge-phone"
KEY="keys/ota_signing_key.pem"
B="build-release"
CHANNEL="fw-stable"
if ! command -v idf.py >/dev/null; then
  idf="${IDF_PATH:-}"
  [ -n "$idf" ] || { [ -d "$HOME/esp/esp-idf-v5.5.5" ] && idf="$HOME/esp/esp-idf-v5.5.5"; }
  # shellcheck disable=SC1091
  . "${idf:-$HOME/esp/esp-idf}/export.sh" >/dev/null
fi
version() { sed -n 's/^set(PROJECT_VER "\(.*\)")$/\1/p' CMakeLists.txt; }
board() { sed -n '/^config OLP_BOARD_ID/,/^config/s/^    default "\(.*\)"$/\1/p' main/Kconfig.projbuild; }

case "${1:-}" in
  keygen)
    [ -e "$KEY" ] && { echo "$KEY exists: refusing to replace the release key" >&2; exit 1; }
    mkdir -p keys && chmod 700 keys
    (umask 077 && espsecure.py generate_signing_key --version 2 --scheme rsa3072 "$KEY" >/dev/null)
    openssl pkey -in "$KEY" -pubout -out main/ota_signing_pub.pem
    echo "new release key in $KEY (back it up offline); public half in main/ota_signing_pub.pem"
    ;;
  build)
    [ -f "$KEY" ] || { echo "no $KEY: run \`$0 keygen\` (or restore the backup)" >&2; exit 1; }
    # The key in the tree must be the one we sign with, or phones would refuse the update.
    cmp -s <(openssl pkey -in "$KEY" -pubout) main/ota_signing_pub.pem ||
      { echo "main/ota_signing_pub.pem is not $KEY's public key" >&2; exit 1; }
    v="$(version)"
    rm -rf "$B"
    idf.py -B "$B" -D SDKCONFIG="$B/sdkconfig" \
      -D "SDKCONFIG_DEFAULTS=sdkconfig.defaults;sdkconfig.release" build >"$B.log" 2>&1 ||
      { tail -30 "$B.log"; exit 1; }
    mkdir -p "$B/dist"
    bin="$B/dist/openloungephone-$v.bin"
    cp "$B/openloungephone.bin" "$bin"
    espsecure.py verify_signature --version 2 --keyfile main/ota_signing_pub.pem "$bin" >/dev/null
    url="https://github.com/$REPO/releases/download/fw-v$v/openloungephone-$v.bin"
    python tools/ota_manifest.py make --bin "$bin" --board "$(board)" --version "$v" --url "$url" \
      --key "$KEY" --out "$B/dist/firmware-manifest.json"
    python tools/ota_manifest.py verify --manifest "$B/dist/firmware-manifest.json" \
      --pub main/ota_signing_pub.pem --bin "$bin"
    ls -l "$B/dist"
    ;;
  publish)
    v="$(version)"
    mode="${2:---draft}"
    m="$B/dist/firmware-manifest.json"
    [ -f "$m" ] || { echo "run \`$0 build\` first" >&2; exit 1; }
    if [ "$mode" != "--release" ]; then
      gh release create "fw-v$v" --repo "$REPO" --draft --latest=false --title "Firmware $v" \
        --notes "Firmware $v for the $(board) board. See firmware/CHANGELOG.md." \
        "$B/dist/openloungephone-$v.bin" "$m"
      echo "draft fw-v$v created; the channel ($CHANNEL) is unchanged"
      exit 0
    fi
    read -r -p "Publish fw-v$v as a REAL release (phones will install it)? Type the version: " ok
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
    sed -n '2,15p' "$0" >&2
    exit 2
    ;;
esac
