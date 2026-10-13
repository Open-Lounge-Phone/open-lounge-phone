#!/usr/bin/env bash
# The LABS firmware (0.0.0), built apart from the phone firmware (firmware/), which it leaves alone.
#   firmware/labs/labs.sh build                 into firmware/labs/build
#   firmware/labs/labs.sh flash [port]          build + flash (default: the first /dev/cu.usbmodem*)
#   firmware/labs/labs.sh monitor [port]
# Flash the phone firmware back with `idf.py flash` in firmware/ (its settings in NVS are kept).
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
cd "$HERE"
if ! command -v idf.py >/dev/null; then
  # shellcheck disable=SC1091
  . "${IDF_PATH:-$HOME/esp/esp-idf-v5.5.5}/export.sh" >/dev/null
fi
port() { echo "${1:-$(ls /dev/cu.usbmodem* 2>/dev/null | head -1)}"; }
case "${1:-build}" in
  build) idf.py build ;;
  flash) idf.py -p "$(port "${2:-}")" build flash ;;
  monitor) idf.py -p "$(port "${2:-}")" monitor ;;
  *) echo "usage: $0 build|flash [port]|monitor [port]" >&2; exit 2 ;;
esac
