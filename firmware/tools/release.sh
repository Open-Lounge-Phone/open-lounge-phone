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
#   firmware/tools/release.sh build             signed builds of PROJECT_VER for every board into
#                                               build-release/dist/ (--board reva|v0901: one)
#   firmware/tools/release.sh publish --draft   a DRAFT fw-vX.Y.Z release (default); the channel is
#                                               untouched, so no phone sees it
#   firmware/tools/release.sh publish --release the real release + the channel update: phones
#                                               install it (ask the owner first; it asks too)
#   --repo owner/name (after the command)       your repo: your key (keys/ota_signing_pub.pem) and
#                                               your channel; default: the official one, whose
#                                               public key is main/ota_signing_pub.pem
#
# Boards: each has its own board id signed into its manifest (a phone refuses another board's) and
# its own manifest in the channel: rev A (minimal-revA) firmware-manifest.json, the name phones
# already read; hw v0.901 (minimal-v0901) firmware-manifest-minimal-v0901.json.
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
BOARDS="reva v0901"
BOARD_ARG=""
cmd="${1:-}"
[ $# -gt 0 ] && shift
args=()
while [ $# -gt 0 ]; do
  case "$1" in
    --repo) REPO="${2:?--repo owner/name}"; shift 2 ;;
    --board) BOARD_ARG="${2:?--board reva|v0901}"; shift 2 ;;
    *) args+=("$1"); shift ;;
  esac
done
# The official key's public half is in the repo; anyone else's sits next to their private key.
if [ "$REPO" = "$OFFICIAL" ]; then PUB="main/ota_signing_pub.pem"; else PUB="keys/ota_signing_pub.pem"; fi
CHANNEL_BASE="https://github.com/$REPO/releases/download/$CHANNEL"
if [ "$cmd" = build ] && ! command -v idf.py >/dev/null; then
  idf="${IDF_PATH:-}"
  [ -n "$idf" ] || { [ -d "$HOME/esp/esp-idf-v5.5.5" ] && idf="$HOME/esp/esp-idf-v5.5.5"; }
  # shellcheck disable=SC1091
  . "${idf:-$HOME/esp/esp-idf}/export.sh" >/dev/null
fi
version() { sed -n 's/^set(PROJECT_VER "\(.*\)")$/\1/p' CMakeLists.txt; }
# Per board: its sdkconfig fragment (on top of sdkconfig.defaults;sdkconfig.release), build
# directory, image and manifest names. The board id itself comes from the build (Kconfig).
board_defaults() { [ "$1" = reva ] && echo "" || echo ";sdkconfig.$1"; }
board_dir() { [ "$1" = reva ] && echo "$B" || echo "$B-$1"; }
board_id() { sed -n 's/^CONFIG_OLP_BOARD_ID="\(.*\)"$/\1/p' "$(board_dir "$1")/sdkconfig"; }
manifest_name() { [ "$1" = minimal-revA ] && echo "firmware-manifest.json" || echo "firmware-manifest-$1.json"; }
image_name() { [ "$1" = minimal-revA ] && echo "openloungephone-$2.bin" || echo "openloungephone-$1-$2.bin"; }
manifest_board() { python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["board"])' "$1"; }

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
    boards="${BOARD_ARG:-$BOARDS}"
    for b in $boards; do
      case " $BOARDS " in *" $b "*) ;; *) echo "unknown board $b (reva, v0901)" >&2; exit 1 ;; esac
    done
    rm -rf "$B" "$B"-v0901
    mkdir -p "$B/dist"
    for b in $boards; do
      d="$(board_dir "$b")"
      mkdir -p "$d"
      # The board's channel URL: its own manifest name in this repo's fw-stable.
      id="$( [ "$b" = reva ] && echo minimal-revA || echo "minimal-$b")"
      url_m="$CHANNEL_BASE/$(manifest_name "$id")"
      defaults="sdkconfig.defaults;sdkconfig.release$(board_defaults "$b")"
      if [ "$REPO" != "$OFFICIAL" ] || [ "$b" != reva ]; then
        # Your key (another repo), and the board's own manifest in the channel.
        printf 'CONFIG_OLP_OTA_PUBKEY="%s"\nCONFIG_OLP_OTA_MANIFEST_URL="%s"\n' "$PUB" "$url_m" \
          >"$d/sdkconfig.own"
        defaults="$defaults;$d/sdkconfig.own"
      fi
      idf.py -B "$d" -D SDKCONFIG="$d/sdkconfig" -D "SDKCONFIG_DEFAULTS=$defaults" build >"$d.log" 2>&1 ||
        { tail -30 "$d.log"; exit 1; }
      [ "$(board_id "$b")" = "$id" ] || { echo "$d: board id $(board_id "$b"), expected $id" >&2; exit 1; }
      grep -qx "CONFIG_OLP_OTA_MANIFEST_URL=\"$url_m\"" "$d/sdkconfig" ||
        { echo "$d: the build's update channel is not $url_m" >&2; exit 1; }
      bin="$B/dist/$(image_name "$id" "$v")"
      cp "$d/openloungephone.bin" "$bin"
      espsecure.py verify_signature --version 2 --keyfile "$PUB" "$bin" >/dev/null
      url="https://github.com/$REPO/releases/download/fw-v$v/$(basename "$bin")"
      python tools/ota_manifest.py make --bin "$bin" --board "$id" --version "$v" --url "$url" \
        --key "$KEY" --out "$B/dist/$(manifest_name "$id")"
      python tools/ota_manifest.py verify --manifest "$B/dist/$(manifest_name "$id")" \
        --pub "$PUB" --bin "$bin"
    done
    echo "$REPO" >"$B/dist/repo"
    ls -l "$B/dist"
    ;;
  publish)
    v="$(version)"
    mode="${args[0]:---draft}"
    shopt -s nullglob
    manifests=("$B/dist/"firmware-manifest*.json)
    images=("$B/dist/"openloungephone-*.bin)
    [ ${#manifests[@]} -gt 0 ] || { echo "run \`$0 build\` first" >&2; exit 1; }
    boards=""
    for m in "${manifests[@]}"; do boards="$boards $(manifest_board "$m")"; done
    [ "$(cat "$B/dist/repo" 2>/dev/null)" = "$REPO" ] ||
      { echo "build-release/ was built for another repo: build again with the same --repo" >&2; exit 1; }
    if [ "$mode" != "--release" ]; then
      gh release create "fw-v$v" --repo "$REPO" --draft --latest=false --title "Firmware $v" \
        --notes "Firmware $v for the boards:$boards. See firmware/CHANGELOG.md." \
        "${images[@]}" "${manifests[@]}"
      echo "draft fw-v$v created in $REPO; the channel ($CHANNEL) is unchanged"
      exit 0
    fi
    read -r -p "Publish fw-v$v in $REPO as a REAL release (phones will install it)? Type the version: " ok
    [ "$ok" = "$v" ] || { echo "not confirmed" >&2; exit 1; }
    # --latest=false: the newest *release* stays whatever it is (e.g. a hardware release).
    gh release create "fw-v$v" --repo "$REPO" --latest=false --title "Firmware $v" \
      --notes "Firmware $v for the boards:$boards. See firmware/CHANGELOG.md." \
      "${images[@]}" "${manifests[@]}"
    gh release view "$CHANNEL" --repo "$REPO" >/dev/null 2>&1 ||
      gh release create "$CHANNEL" --repo "$REPO" --prerelease --latest=false \
        --title "Firmware update channel (manifest only)" \
        --notes "Phones read firmware-manifest.json here. Updated by firmware/tools/release.sh."
    gh release upload "$CHANNEL" --repo "$REPO" --clobber "${manifests[@]}"
    ;;
  *)
    sed -n '2,23p' "$0" >&2
    exit 2
    ;;
esac
