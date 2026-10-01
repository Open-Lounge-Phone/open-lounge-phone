#!/usr/bin/env bash
# Build the QEMU firmware (sdkconfig.qemu) and run it in Espressif's QEMU (esp32s3 machine).
#   firmware/tools/qemu.sh build        build into firmware/build-qemu
#   firmware/tools/qemu.sh image        build + a fresh 4 MB flash image and eFuse file
#   firmware/tools/qemu.sh run          image + run with the console on this terminal (Ctrl-A X quits)
#   firmware/tools/qemu.sh fresh        a fresh flash image and eFuse file from the last build
#   firmware/tools/qemu.sh resume       run the existing flash/eFuse files again (keeps NVS, OTA state)
# OLP_SIM_SERVER=wss://host builds for that server; without it the phone has no server (the default).
# QEMU: $OLP_QEMU, else ~/.local/qemu-esp/bin/qemu-system-xtensa, else on PATH. Espressif's
# x86_64 macOS build esp-develop-9.2.2-20250817 works on macOS 13 (needs `brew install libgcrypt`);
# the newer 20260417 "x86_64" archive actually holds an arm64 binary.
# QEMU_HOSTFWD="tcp::8080-:80" forwards host ports to the phone (e.g. the setup page).
# QEMU_PCAP=file.pcap records the phone's network traffic.
set -euo pipefail
FW="$(cd "$(dirname "$0")/.." && pwd)"
cd "$FW"
B="${OLP_QEMU_BUILD:-build-qemu}"
if ! command -v idf.py >/dev/null; then
  idf="${IDF_PATH:-}"
  [ -n "$idf" ] || { [ -d "$HOME/esp/esp-idf-v5.5.5" ] && idf="$HOME/esp/esp-idf-v5.5.5"; }
  # shellcheck disable=SC1091
  . "${idf:-$HOME/esp/esp-idf}/export.sh" >/dev/null
fi
QEMU="${OLP_QEMU:-}"
[ -n "$QEMU" ] || { [ -x "$HOME/.local/qemu-esp/bin/qemu-system-xtensa" ] && QEMU="$HOME/.local/qemu-esp/bin/qemu-system-xtensa"; }
QEMU="${QEMU:-qemu-system-xtensa}"

build() {
  mkdir -p "$B"
  local defaults="sdkconfig.defaults;sdkconfig.qemu${OLP_QEMU_EXTRA_DEFAULTS:+;$OLP_QEMU_EXTRA_DEFAULTS}"
  local want
  local extra
  extra="$(echo "${OLP_QEMU_EXTRA_DEFAULTS:-}" | tr ';' ' ')"
  # shellcheck disable=SC2086
  want="${OLP_SIM_SERVER:-default}|${OLP_QEMU_EXTRA_DEFAULTS:-}|${OLP_FW_VERSION:-}|$(cat sdkconfig.defaults \
    sdkconfig.qemu main/Kconfig.projbuild $extra | shasum | cut -c1-12)"
  if [ -n "${OLP_SIM_SERVER:-}" ]; then
    printf 'CONFIG_OLP_SERVER_URL="%s"\n' "$OLP_SIM_SERVER" >"$B/sdkconfig.server"
    defaults="$defaults;$B/sdkconfig.server"
  fi
  # sdkconfig.defaults never override an existing sdkconfig: regenerate it when the inputs change.
  if [ "$(cat "$B/.inputs" 2>/dev/null)" != "$want" ]; then
    rm -f "$B/sdkconfig" "$B/CMakeCache.txt"  # a new version (OLP_FW_VERSION) needs a fresh configure
    echo "$want" >"$B/.inputs"
  fi
  idf.py -B "$B" -D SDKCONFIG="$B/sdkconfig" -D "SDKCONFIG_DEFAULTS=$defaults" build \
    >"$B/build.log" 2>&1 || { tail -40 "$B/build.log"; exit 1; }
}
image() {
  [ -f "$B/flash_args" ] || { echo "no build in $B: run \`$0 build\` first" >&2; exit 1; }
  (cd "$B" && python -m esptool --chip esp32s3 merge_bin --output qemu_flash.bin \
    --fill-flash-size 4MB @flash_args >/dev/null)
  # A blank eFuse block with the chip revision (what `idf.py qemu` writes).
  python - "$B/qemu_efuse.bin" <<'EOF'
import sys
b = bytearray(1024)
b[38] = 0x0C
open(sys.argv[1], "wb").write(bytes(b))
EOF
  # QEMU hangs when the bootloader writes flash: write the first boot's otadata ourselves
  # (tools/qemu_otadata.py explains).
  python tools/qemu_otadata.py seed "$B/qemu_flash.bin" >/dev/null
}
run() {
  local fwd=()
  [ -n "${QEMU_HOSTFWD:-}" ] && fwd=(-nic "user,model=open_eth,hostfwd=${QEMU_HOSTFWD}")
  [ ${#fwd[@]} -eq 0 ] && fwd=(-nic user,model=open_eth)
  if [ -n "${QEMU_PCAP:-}" ]; then
    # Every frame on the phone's network into a pcap file (the smoke test reads it).
    fwd=(-netdev "user,id=n0${QEMU_HOSTFWD:+,hostfwd=${QEMU_HOSTFWD}}" -net nic,model=open_eth,netdev=n0
      -object "filter-dump,id=dump0,netdev=n0,file=${QEMU_PCAP}")
  fi
  exec "$QEMU" -M esp32s3 -m 8M \
    -drive "file=$B/qemu_flash.bin,if=mtd,format=raw" \
    -drive "file=$B/qemu_efuse.bin,if=none,format=raw,id=efuse" \
    -global driver=nvram.esp32s3.efuse,property=drive,value=efuse \
    -global driver=timer.esp32s3.timg,property=wdt_disable,value=true \
    -global driver=ssi_psram,property=is_octal,value=true \
    "${fwd[@]}" -nographic -serial mon:stdio
}
case "${1:-run}" in
  build) build ;;
  image) build && image ;;
  run) build && image && run ;;
  fresh) image ;;
  resume) run ;;
  *) echo "usage: $0 build|image|fresh|run|resume" >&2; exit 2 ;;
esac
