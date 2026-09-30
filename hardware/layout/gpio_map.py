"""GPIO map for the firmware: build/main/gpio_map.json (project venv; `make fab`).

    .venv/bin/python layout/gpio_map.py

Sources: schematic/pin_table.yaml (the allocation), build/main/main.net (what the board
actually connects: every GPIO's module pad and net is cross-checked, the key switch behind
each key net is read from it). Fails when the two disagree.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import yaml

HW = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(HW / "layout"))

import netlist as nl  # noqa: E402
from review_placement import GPIO_PAD  # noqa: E402

KEYS = ["1", "2", "3", "4", "5", "MENU", "6", "7", "8", "9", "0", "BACK"]   # rear row, front row
# protocol `button` index (packages/protocol): digits 1-9 -> 0-8, digit 0 -> 9; MENU/BACK stay
# on the device
BUTTON_INDEX = {str(d): d - 1 for d in range(1, 10)} | {"0": 9}
J3_PINS = {1: "EPD_BUSY", 2: "EPD_RST", 3: "EPD_DC", 4: "EPD_CS", 5: "EPD_CLK", 6: "EPD_DIN",
           7: "GND", 8: "3V3"}


def main() -> int:
    table = yaml.safe_load((HW / "schematic" / "pin_table.yaml").read_text())
    net = nl.read(HW / "build" / "main" / "main.net")
    u1 = {pad: n for n, nodes in net.nets.items() for ref, pad in nodes if ref == "U1"}
    gpio, by_net, errors = {}, {}, []
    for g, row in sorted(table["gpio"].items()):
        pad = GPIO_PAD.get(g)
        want = row.get("net")
        have = u1.get(str(pad)) if pad else None
        if pad and (have or None) != (want or None) and not (want is None and have is None):
            errors.append(f"GPIO{g} (pad {pad}): pin table {want}, board {have}")
        entry = {"net": want, "module_pad": pad}
        for k in ("rtc", "strap", "low_only", "pull", "note"):
            if k in row:
                entry[k] = row[k]
        gpio[str(g)] = entry
        if want:
            by_net[want] = g
    if errors:
        print("\n".join(errors))
        return 1

    def switch_of(netname):
        return next((ref for ref, _ in net.nets.get(netname, []) if ref.startswith("SW")), None)

    keys = {}
    for i, label in enumerate(KEYS):
        n = f"KEY_{label}"
        keys[label] = {"gpio": by_net[n], "net": n, "switch": switch_of(n),
                       "row": "rear" if i < 6 else "front", "column": i % 6,
                       "button_index": BUTTON_INDEX.get(label), "active": "low (internal pull-up)"}
    keys["HOOK"] = {"gpio": by_net["HOOK"], "net": "HOOK", "switch": switch_of("HOOK"),
                    "active": "low = handset on the hook (internal pull-up)", "rtc": True}
    data = {
        "board": "Open Lounge Phone main board", "rev": "A (M3)",
        "module": "ESP32-S3-WROOM-1U-N16R8 (16 MB flash, 8 MB octal PSRAM)",
        "sources": ["hardware/schematic/pin_table.yaml", "hardware/build/main/main.net"],
        "gpio": gpio,
        "net_to_gpio": dict(sorted(by_net.items())),
        "keys": keys,
        "peripherals": {
            "codec": {"part": "ES8311", "i2c": {"sda": by_net["I2C_SDA"], "scl": by_net["I2C_SCL"],
                                                "address_7bit": "0x18", "pullups": "4.7k to 3V3"},
                      "i2s": {"mclk": by_net["I2S_MCLK"], "bclk": by_net["I2S_BCLK"],
                              "ws": by_net["I2S_WS"], "data_to_codec": by_net["I2S_DOUT"],
                              "data_from_codec": by_net["I2S_DIN"]},
                      "handset": "3.5 mm TRRS (CTIA): earpiece on T+R1 via 22 uF + 22 R from OUTP;"
                                 " mic on S (bias 3V3 -> 1k/10uF -> 2.2k) into MIC1P, MIC1N to GND"},
            "jack_detect": {"gpio": by_net["JACK_DET"],
                            "active": "low = no plug, high = plug in (internal pull-up)"},
            "display": {"connector": "J3 (WeAct 2.9in e-paper, SSD1680)",
                        "spi": {"clk": by_net["EPD_CLK"], "mosi": by_net["EPD_DIN"],
                                "cs": by_net["EPD_CS"]},
                        "dc": by_net["EPD_DC"], "rst": by_net["EPD_RST"], "busy": by_net["EPD_BUSY"],
                        "j3_pins": {str(k): v for k, v in J3_PINS.items()}},
            "usb": {"d_minus": by_net["USB_DN"], "d_plus": by_net["USB_DP"],
                    "use": "native USB: flashing + USB-Serial-JTAG console"},
            "buzzer": {"gpio": by_net["BUZZER"],
                       "drive": "NPN (MMBT3904) switches the piezo from VBUS; ~4 kHz square wave"},
            "status_led": {"gpio": by_net["STATUS_LED"], "active": "high", "current_mA": 1.5},
            "boot_button": {"gpio": by_net["BOOT"], "active": "low"},
            "reset_button": "EN (SW1), RC 10k/1uF",
        },
        "reserved": [g for g, r in table["gpio"].items() if r.get("net") is None
                     and "PSRAM" in str(r.get("note", ""))],
        "free": [g for g, r in table["gpio"].items() if r.get("net") is None
                 and "PSRAM" not in str(r.get("note", ""))],
    }
    out = HW / "build" / "main" / "gpio_map.json"
    out.write_text(json.dumps(data, indent=2) + "\n")
    print(f"wrote {out.relative_to(HW)}: {len(by_net)} nets, {len(keys)} keys")
    return 0


if __name__ == "__main__":
    sys.exit(main())
