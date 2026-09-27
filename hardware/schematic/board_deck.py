"""Deck board (98 x 84 mm, under the keys). DESIGN.md §5 (AW9523B map), §6, §7, §8, §11.

Electrical content only - placement (sockets/LEDs on the bottom, strip window, NFC coil keep-out)
is a layout task. Key count comes from the build variant (DESIGN.md: 10 = 8 contacts + SPEAKER +
END; §15 Q2 is open).
"""

from __future__ import annotations

import builtins

from skidl import Net

NC = builtins.NC  # SKiDL explicit no-connect net

from config import Variant
from ffc import FFC_PINS
from lib import TP, C, R, decouple, make, rail, series


def key_names(n_keys: int) -> list[str]:
    contacts = n_keys - 2
    if contacts < 2 or contacts % 2 or n_keys > 12:
        raise ValueError("n_keys must be even, 4..12 (two rows of contacts + SPEAKER + END)")
    half = contacts // 2
    return [f"F{i}" for i in range(1, half + 1)] + [f"R{i}" for i in range(1, half + 1)] + [
        "SPEAKER", "END"]


# AW9523B port order per DESIGN.md §5: P0_0-7 = F1-F4, R1-R4; P1_0-1 = SPEAKER, END;
# P1_2-3 = VOL-, VOL+; P1_4 = MUTE_SENSE; P1_5 = LED_PWR_EN; P1_6-7 spare (keys 11-12 if ever)
KEY_PORTS = ["P0_0", "P0_1", "P0_2", "P0_3", "P0_4", "P0_5", "P0_6", "P0_7", "P1_0", "P1_1",
             "P1_6", "P1_7"]


def build(v: Variant) -> dict:
    GND = rail("GND")
    V3V3 = rail("3V3")
    VSYS = rail("VSYS")
    nets = {"GND": GND, "3V3": V3V3, "VSYS": VSYS}

    # ---- FFC from the main board ----
    j = make("FFC24", ref="J1", note="deck <-> main")
    for pin, name in FFC_PINS.items():
        if name not in nets:
            nets[name] = Net(name)
        net = nets[name]
        j[str(pin)] += net
    j["MP"] += GND
    ffc_map = {str(p): j[str(p)].net.name for p in FFC_PINS}
    TP(nets["FFC_SPARE"], "FFC_SPARE")
    decouple(V3V3, GND, "10u", "100n")
    decouple(VSYS, GND, "10u")
    n = nets

    # ---- AW9523B I/O expander, I2C 0x58 (AD0=AD1=0 -> all outputs low at power-up) ----
    x = make("AW9523B", ref="U1")
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
    for name, port in zip(names, KEY_PORTS):
        k = Net(f"KEY_{name}")
        x[port] += k
        used.add(port)
        series(k, V3V3, R("10k", note="AW9523B has no internal pull-ups"))
        s = make("HOTSWAP", note=f"key {name}")
        s[1] += k
        s[2] += GND

    # side controls (right end face): VOL-, VOL+ tacts; MUTE DPDT slide
    for name, port in (("VOL_DN", "P1_2"), ("VOL_UP", "P1_3")):
        k = Net(name)
        x[port] += k
        used.add(port)
        series(k, V3V3, R("10k"))
        t = make("SIDE_TACT", note=name)
        t["A"] += k
        t["B"] += GND
        t["MP"] += GND
    mute = Net("MUTE_SENSE")
    x["P1_4"] += mute
    used.add("P1_4")
    series(mute, V3V3, R("10k"))
    sw = make("SLIDE_DPDT", note="MUTE: pole A breaks mic bias, pole B reports")
    sw["1COM"] += n["MICBIAS_IN"]
    sw["1A"] += n["MICBIAS_OUT"]  # position A = unmuted
    sw["1B"] += NC
    sw["2COM"] += GND
    sw["2A"] += NC
    sw["2B"] += mute  # position B = muted -> MUTE_SENSE low
    # ESD on the lines that exit the enclosure edge (§11.3)
    tvs = make("SRV05-4", note="side-switch ESD")
    tvs["IO1"] += Net.get("VOL_DN")
    tvs["IO2"] += Net.get("VOL_UP")
    tvs["IO3"] += mute
    tvs["IO4"] += NC
    tvs["REF1"] += GND
    tvs["REF2"] += V3V3

    # ---- per-key RGB LEDs: SK6812MINI-E x (keys + 1 status) on switched VSYS ----
    led_en = Net("LED_PWR_EN")
    x["P1_5"] += led_en
    used.add("P1_5")
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
    for i, name in enumerate(names + ["STATUS"], start=1):
        led = make("SK6812MINI-E", note=f"LED {i}: {name}")
        led["VDD"] += vled
        led["GND"] += GND
        led["DIN"] += din
        dout = Net(f"LED_D{i}") if name != "STATUS" else NC
        led["DOUT"] += dout
        series(vled, GND, C("100n", note=f"LED {i}"))
        din = dout

    for port in ("P1_6", "P1_7"):
        if port not in used:
            x[port] += Net(f"AW_{port}_SPARE")
            TP(Net.get(f"AW_{port}_SPARE"), f"AW_{port}")
            used.add(port)
    for port in KEY_PORTS:  # fewer keys than ports: leave the rest explicitly unconnected
        if port not in used:
            x[port] += NC

    # ---- privacy LED (red): lit by the main-board NPN whenever mic bias is present ----
    pa = Net("PRIV_LED_A")
    series(V3V3, pa, R("470", note="~2.5 mA"))
    pl = make("LED_RED", note="PRIVACY (hardwired to mic bias)")
    pl["A"] += pa
    pl["K"] += n["PRIV_LED_K"]

    # ---- LTR-303ALS ambient light, I2C 0x29 (INT unused: polled; not on shared IRQ per §5) ----
    als = make("LTR-303ALS", ref="U2")
    als["VDD"] += V3V3
    als["GND"] += GND
    als["SCL"] += n["I2C_SCL"]
    als["SDA"] += n["I2C_SDA"]
    als["INT"] += NC
    als["NC"] += NC
    decouple(V3V3, GND, "1u", note="LTR-303")

    nfc(n, GND, V3V3)
    eink(n, GND, V3V3)
    return ffc_map


def nfc(n, GND, V3V3):
    """ST25DV04K dynamic tag + PCB coil around the strip band (§8, §11.3)."""
    u = make("ST25DV04K", ref="U3")
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
    coil = make("NFC_COIL", note="PCB coil ~4.7 uH target, 3-4 turns around strip")
    coil[1] += ac0
    coil[2] += ac1
    series(ac0, ac1, C("22p", dnp=True, note="tuning cap, fit only if coil L falls short"))


def eink(n, GND, V3V3):
    """GDEY029T94 (SSD1680) 24-pin FPC + Good Display reference boost (datasheet p.29, §7)."""
    j = make("FPC24_EPD", ref="J2", note="GDEY029T94 panel tail")
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
    decouple(V3V3, GND, "1u@50V", note="EPD VCI/VDDIO (GD C6)")
    # 1 uF/25 V on each internal-supply pin (GD C2, C7, C9, C10, C11, C12); 50 V parts here
    for pin in ("VSH2", "VDD", "VSH1", "VSL", "PREVGL", "VCOM"):
        net = Net(f"EPD_{pin}")
        j[pin] += net
        series(net, GND, C("1u@50V", note=f"EPD {pin}"))
    vgh = Net("EPD_PREVGH")
    j["PREVGH"] += vgh
    series(vgh, GND, C("1u@50V", note="EPD PREVGH (GD C5)"))
    # boost: 47 uH from 3V3 to SW, Si1308EDL switched by GDR (1M pull-down), 2.2R on RESE
    gdr, rese, swn = Net("EPD_GDR"), Net("EPD_RESE"), Net("EPD_SW")
    j["GDR"] += gdr
    j["RESE"] += rese
    lb = make("L47u")
    lb[1] += V3V3
    lb[2] += swn
    decouple(V3V3, GND, "4.7u@25V", note="boost input (GD C4)")
    q = make("EPD_NFET")
    q["G"] += gdr
    q["D"] += swn
    q["S"] += rese
    series(gdr, GND, R("1M", note="GDR pull-down (GD R1)"))
    series(rese, GND, R("2.2", size="0603", note="current sense (GD R2)"))
    # PREVGH: SW -D3-> PREVGH. PREVGL charge pump: SW -C3- X ; X -D2-> GND ; PREVGL -D1-> X
    d3 = make("MBR0530")
    d3["A"] += swn
    d3["K"] += vgh
    x = Net("EPD_CP")
    series(swn, x, C("4.7u@25V", note="charge pump (GD C3)"))
    d2 = make("MBR0530")
    d2["A"] += x
    d2["K"] += GND
    d1 = make("MBR0530")
    d1["A"] += Net.get("EPD_PREVGL")
    d1["K"] += x
