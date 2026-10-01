#!/usr/bin/env bash
# Build the simulator firmware and run it in Wokwi.
#   firmware/tools/sim.sh build        build into firmware/build-sim
#   firmware/tools/sim.sh smoke        build + run wokwi/smoke.yaml; log + display PNG in build-sim/
#   firmware/tools/sim.sh interactive  build + run with the console on stdin (type `help`)
# OLP_SIM_SERVER=wss://host builds for that server (your test server); without it the phone has
# no server and shows "SET UP: CHOOSE A SERVER" (smoke needs one: it pairs).
# Needs ESP-IDF (IDF_PATH or ~/esp/esp-idf), wokwi-cli, and a token in firmware/.wokwi-token
# (or WOKWI_CLI_TOKEN). The token is never printed.
set -euo pipefail
FW="$(cd "$(dirname "$0")/.." && pwd)"
cd "$FW"
if ! command -v idf.py >/dev/null; then
  # ESP-IDF v5.5: $IDF_PATH, else ~/esp/esp-idf-v5.5.5, else ~/esp/esp-idf.
  idf="${IDF_PATH:-}"
  [ -n "$idf" ] || { [ -d "$HOME/esp/esp-idf-v5.5.5" ] && idf="$HOME/esp/esp-idf-v5.5.5"; }
  # shellcheck disable=SC1091
  . "${idf:-$HOME/esp/esp-idf}/export.sh" >/dev/null
fi
WOKWI="$(command -v wokwi-cli || echo "$HOME/.local/bin/wokwi-cli")"
build() {
  # sdkconfig.defaults never override an existing sdkconfig: regenerate it when the server changes.
  local defaults="sdkconfig.defaults;sdkconfig.sim" want
  want="${OLP_SIM_SERVER:-default}|$(cat sdkconfig.defaults sdkconfig.sim main/Kconfig.projbuild | shasum | cut -c1-12)"
  if [ -n "${OLP_SIM_SERVER:-}" ]; then
    printf 'CONFIG_OLP_SERVER_URL="%s"\n' "$OLP_SIM_SERVER" >build-sim/sdkconfig.server
    defaults="$defaults;build-sim/sdkconfig.server"
  fi
  if [ "$(cat build-sim/.server 2>/dev/null)" != "$want" ]; then
    rm -f build-sim/sdkconfig
    echo "$want" >build-sim/.server
  fi
  idf.py -B build-sim -D SDKCONFIG=build-sim/sdkconfig \
    -D "SDKCONFIG_DEFAULTS=$defaults" build >build-sim.log 2>&1 ||
    { tail -40 build-sim.log; exit 1; }
  mv build-sim.log build-sim/build.log
}
token() {
  if [ -z "${WOKWI_CLI_TOKEN:-}" ]; then
    [ -s .wokwi-token ] || { echo "no Wokwi token: put it in firmware/.wokwi-token" >&2; exit 1; }
    WOKWI_CLI_TOKEN="$(cat .wokwi-token)"
    export WOKWI_CLI_TOKEN
  fi
}
case "${1:-smoke}" in
  build) mkdir -p build-sim && build ;;
  smoke)
    [ -n "${OLP_SIM_SERVER:-}" ] ||
      { echo "smoke pairs with a server: set OLP_SIM_SERVER=wss://your-test-server" >&2; exit 1; }
    mkdir -p build-sim && build && token
    "$WOKWI" wokwi --scenario "$FW/wokwi/smoke.yaml" --timeout "${TIMEOUT:-240000}" \
      --serial-log-file "$FW/build-sim/serial.log"
    python3 tools/fb2png.py build-sim/serial.log build-sim/display.png
    grep -m1 "PAIRING CODE" build-sim/serial.log
    ;;
  interactive)
    mkdir -p build-sim && build && token
    exec "$WOKWI" wokwi --interactive --timeout "${TIMEOUT:-3600000}"
    ;;
  *) echo "usage: $0 build|smoke|interactive" >&2; exit 2 ;;
esac
