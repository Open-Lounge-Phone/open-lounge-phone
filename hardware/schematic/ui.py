"""User-interface block of the single board: keys, key LEDs, e-ink strip, NFC tag, ambient
light, privacy LED. DESIGN.md §5 (AW9523B map), §6, §7, §8, §11.

Single board (owner decision 2026-09-27): this used to be the separate deck board behind a
24-pin FFC; it is now part of the main board's netlist (``board_main.build`` calls ``ui``).
Placement (sockets/LEDs on the bottom, strip window, NFC coil in a free end region) is a layout
task. Key count comes from the build variant (owner decision 2026-09-27: 12 keys, rear row
1 2 3 4 5 MENU, front row 6 7 8 9 0 BACK).
"""

from __future__ import annotations

import builtins

from skidl import Net

NC = builtins.NC  # SKiDL explicit no-connect net

from config import Variant
from lib import TP, C, R, decouple, make, rail, series


def key_rows(n_keys: int) -> tuple[list[str], list[str]]:
    """(rear row, front row), left to right. Owner layout 2026-09-27 for 12 keys:
    rear 1 2 3 4 5 MENU, front 6 7 8 9 0 BACK. Digits fill the first columns of each row,
    MENU/BACK the last column. n_keys stays a parameter (even, 4..12)."""
    digits = n_keys - 2
    if digits < 2 or digits % 2 or n_keys > 12:
        raise ValueError("n_keys must be even, 4..12 (two rows of digits + MENU + BACK)")
    labels = [str((i + 1) % 10) for i in range(digits)]
    half = digits // 2
    return labels[:half] + ["MENU"], labels[half:] + ["BACK"]


def key_names(n_keys: int) -> list[str]:
    """Key order on the AW9523B ports: digits in dialling order (1..9, 0), then MENU, BACK."""
    rear, front = key_rows(n_keys)
    return rear[:-1] + front[:-1] + ["MENU", "BACK"]


def led_chain(n_keys: int) -> list[str]:
    """SK6812 data chain in physical order (short hops), one serpentine that starts next to
    the ESP32 (right of centre): rear row right->left (MENU first), front row left->right,
    then the status pixel beside BACK. Firmware maps LED index -> key with this list."""
    rear, front = key_rows(n_keys)
    return rear[::-1] + front + ["STATUS"]


# AW9523B port per signal in bus order (A3, 2026-09-28): the AW9523B sits at the right end of
# the key rows and each row arrives as a straight parallel bus on one side. Keys and side
# controls are plain inputs (any port); LED_PWR_EN must stay on port 1 (push-pull). Firmware
# reads the key map from this table.
AW_PORTS = {
    # left side, top -> bottom: the rear-row bus (nearest key on the top lane)
    "KEY_MENU": "P1_0", "KEY_5": "P1_1", "KEY_4": "P1_2", "KEY_3": "P1_3", "KEY_2": "P0_0",
    "KEY_1": "P0_1",
    # bottom side, left -> right, then the corner: the front-row bus
    "KEY_6": "P0_2", "KEY_7": "P0_3", "KEY_8": "P0_4", "KEY_9": "P0_5", "KEY_0": "P0_6",
    "KEY_BACK": "P0_7",
    # right side, bottom -> top: side controls from the right edge (VOL- lowest), LED enable
    "VOL_DN": "P1_4", "VOL_UP": "P1_5", "MUTE_SENSE": "P1_6", "LED_PWR_EN": "P1_7",
}
KEY_PORTS = sorted({p for n, p in AW_PORTS.items() if n.startswith("KEY_")})  # 12-key set


def ui(v: Variant, n: dict, GND, V3V3, VSYS) -> None:
    """``n``: the main board's named nets (I2C, IRQ, EPD_*, LED_DATA_BUF, PRIV_LED_K, VOL_*,
    MUTE_SENSE)."""
    # ---- AW9523B I/O expander (C148077), I2C 0x58 = 0x58 + AD1<<1 + AD0 with AD0=AD1=0.
    # Datasheet: AD0/AD1 also select the power-on state of the outputs; tied low the outputs
    # come up low, so LED_PWR_EN (port 1, AW_PORTS) is off and nothing is powered before firmware runs.
    # RSTN has an internal 100k pull-DOWN (external pull-up below); INTN is open-drain (IRQ
    # pull-up on this board, mcu()); P0 is open-drain by default and there are no internal
    # pull-ups (every key has an external 10k pull-up; P1 drives LED_PWR_EN push-pull).
    x = make("AW9523B", ref="U17")
    x["VCC"] += V3V3
    x["GND"] += GND
    x["EP"] += GND
    x["AD0"] += GND
    x["AD1"] += GND
    x["SCL"] += n["I2C_SCL"]
    x["SDA"] += n["I2C_SDA"]
    x["INTN"] += n["IRQ"]  # open-drain; pull-up on main
    rstn = Net("AW_RSTN")
    x["RSTN"] += rstn
    series(rstn, V3V3, R("10k", note="RSTN has an internal 100k pull-DOWN; must be pulled up"))
    series(rstn, GND, C("100n"))
    decouple(V3V3, GND, "100n", note="AW9523B")

    names = key_names(v.n_keys)
    used = set()
    spare = [p for p in KEY_PORTS if p not in {AW_PORTS.get(f"KEY_{n}") for n in names}]
    for name in names:
        port = AW_PORTS.get(f"KEY_{name}") or spare.pop(0)
        k = Net(f"KEY_{name}")
        x[port] += k
        used.add(port)
        series(k, V3V3, R("10k", note="AW9523B has no internal pull-ups"))
        s = make("HOTSWAP", note=f"key {name}")
        s[1] += k
        s[2] += GND

    # side controls (VOL-, VOL+, MUTE) at the board edge (pull-ups and ESD in side_controls())
    for name in ("VOL_DN", "VOL_UP", "MUTE_SENSE"):
        port = AW_PORTS[name]
        x[port] += n[name]
        used.add(port)

    # ---- per-key RGB LEDs: SK6812MINI-E x (keys + 1 status) on switched VSYS ----
    led_en = Net("LED_PWR_EN")
    x[AW_PORTS["LED_PWR_EN"]] += led_en
    used.add(AW_PORTS["LED_PWR_EN"])
    series(led_en, GND, R("100k", note="LEDs off until firmware enables"))
    vled = rail("VLED")
    g = Net("VLED_PFET_G")
    qp = make("AO3401A", note="LED chain power gate (cuts ~1 mA/LED quiescent)")
    qp["S"] += VSYS
    qp["D"] += vled
    qp["G"] += g
    series(VSYS, g, R("100k"))
    qn = make("AO3400A", note="3.3 V logic cannot turn a VSYS P-FET fully off")
    qn["D"] += g
    qn["S"] += GND
    qn["G"] += led_en
    decouple(vled, GND, "22u", "22u")
    din = n["LED_DATA_BUF"]
    for i, name in enumerate(led_chain(v.n_keys), start=1):
        led = make("SK6812MINI-E", note=f"LED {i}: {name}")
        led["VDD"] += vled
        led["GND"] += GND
        led["DIN"] += din
        dout = Net(f"LED_D{i}") if name != "STATUS" else NC
        led["DOUT"] += dout
        series(vled, GND, C("100n", note=f"LED {i}"))
        din = dout

    for port in ("P1_6", "P1_7"):
        if port not in used and port not in AW_PORTS.values():
            x[port] += Net(f"AW_{port}_SPARE")
            TP(Net.get(f"AW_{port}_SPARE"), f"AW_{port}")
            used.add(port)
    for port in KEY_PORTS:  # fewer keys than ports: leave the rest explicitly unconnected
        if port not in used:
            x[port] += NC

    # ---- privacy LED (red): lit by the NPN Q1 (audio()) whenever mic bias is present ----
    pa = Net("PRIV_LED_A")
    series(V3V3, pa, R("470", note="~2.5 mA"))
    pl = make("LED_RED", note="PRIVACY (hardwired to mic bias)")
    pl["A"] += pa
    pl["K"] += n["PRIV_LED_K"]

    # ---- LTR-303ALS-01 (C364577) ambient light, I2C 0x29; pins 1 VDD, 2 NC, 3 GND, 4 SCL,
    # 5 INT (open-drain, unused: polled; not on the shared IRQ per §5), 6 SDA ----
    als = make("LTR-303ALS", ref="U18")
    als["VDD"] += V3V3
    als["GND"] += GND
    als["SCL"] += n["I2C_SCL"]
    als["SDA"] += n["I2C_SDA"]
    als["INT"] += NC
    als["NC"] += NC
    decouple(V3V3, GND, "1u", note="LTR-303")

    nfc(n, GND, V3V3)
    eink(n, GND, V3V3)


def nfc(n, GND, V3V3):
    """ST25DV04K dynamic tag + PCB coil in a free end region of the board (§8, §11.3)."""
    u = make("ST25DV04K", ref="U19")
    u["VCC"] += V3V3
    u["VSS"] += GND
    u["SDA"] += n["I2C_SDA"]
    u["SCL"] += n["I2C_SCL"]
    u["GPO"] += n["IRQ"]
    u["V_EH"] += NC
    ac0, ac1 = Net("NFC_AC0"), Net("NFC_AC1")
    u["AC0"] += ac0
    u["AC1"] += ac1
    decouple(V3V3, GND, "100n", note="ST25DV")
    coil = make("NFC_COIL", note="PCB coil (est. L in gen_footprints.py), front-left end region")
    coil[1] += ac0
    coil[2] += ac1
    series(ac0, ac1, C("22p", dnp=True, note="tuning cap placeholder: value set in EVT from the measured coil L"))


def eink(n, GND, V3V3, dnp: bool = False):
    """GDEY029T94 (SSD1680) 24-pin FPC + Good Display reference boost (datasheet p.29, §7).
    Always fitted (one board, 2026-09-28); ``dnp`` stays for a future display-less board."""
    j = make("FPC24_EPD", ref="J6", dnp=dnp, note="GDEY029T94 panel tail")
    j["MP"] += GND
    sig = {
        "BUSY": "EPD_BUSY", "RES": "EPD_RST", "DC": "EPD_DC", "CS": "EPD_CS",
        "SCL": "EPD_SCK", "SDA": "EPD_MOSI",
    }
    for pin, net in sig.items():
        j[pin] += n[net]
    j["BS1"] += GND  # 4-wire SPI
    j["VDDIO"] += V3V3
    j["VCI"] += V3V3
    j["VSS"] += GND
    for pin in ("NC1", "NC4", "TSCL", "TSDA", "VPP"):  # VPP is a factory test pin: leave open
        j[pin] += NC
    series(V3V3, GND, C("1u@50V", dnp=dnp, note="EPD VCI/VDDIO (GD C6)"))
    # 1 uF/25 V on each internal-supply pin (GD C2, C7, C9, C10, C11, C12); 50 V parts here
    for pin in ("VSH2", "VDD", "VSH1", "VSL", "PREVGL", "VCOM"):
        net = Net(f"EPD_{pin}")
        j[pin] += net
        series(net, GND, C("1u@50V", dnp=dnp, note=f"EPD {pin}"))
    vgh = Net("EPD_PREVGH")
    j["PREVGH"] += vgh
    series(vgh, GND, C("1u@50V", dnp=dnp, note="EPD PREVGH (GD C5)"))
    # boost: 47 uH from 3V3 to SW, Si1308EDL switched by GDR (1M pull-down), 2.2R on RESE
    gdr, rese, swn = Net("EPD_GDR"), Net("EPD_RESE"), Net("EPD_SW")
    j["GDR"] += gdr
    j["RESE"] += rese
    lb = make("L47u", dnp=dnp)
    lb[1] += V3V3
    lb[2] += swn
    series(V3V3, GND, C("4.7u@25V", dnp=dnp, note="boost input (GD C4)"))
    q = make("EPD_NFET", dnp=dnp)
    q["G"] += gdr
    q["D"] += swn
    q["S"] += rese
    series(gdr, GND, R("1M", dnp=dnp, note="GDR pull-down (GD R1)"))
    series(rese, GND, R("2.2", size="0603", dnp=dnp, note="current sense (GD R2)"))
    # PREVGH: SW -D3-> PREVGH. PREVGL charge pump: SW -C3- X ; X -D2-> GND ; PREVGL -D1-> X
    d3 = make("MBR0530", dnp=dnp)
    d3["A"] += swn
    d3["K"] += vgh
    x = Net("EPD_CP")
    series(swn, x, C("4.7u@25V", dnp=dnp, note="charge pump (GD C3)"))
    d2 = make("MBR0530", dnp=dnp)
    d2["A"] += x
    d2["K"] += GND
    d1 = make("MBR0530", dnp=dnp)
    d1["A"] += Net.get("EPD_PREVGL")
    d1["K"] += x
