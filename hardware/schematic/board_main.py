"""The minimal board (M1, owner decision 2026-09-30): core only plus one status LED.

2 layers, ~160 x 88 mm (proposal, DESIGN.md §9). Blocks (one review page each):

- power:   USB-C receptacle (5 V sink, 2 x 5.1 k Rd, D+/D- to the ESP32 native USB through one
           USBLC6-2SC6), SGM2212-3.3 LDO (800 mA), bulk + decoupling per the module datasheet.
- mcu:     ESP32-S3-WROOM-1U-N16R8 (U.FL antenna), EN RC reset + RESET button, BOOT on GPIO0.
- keys:    12 MX hot-swap sockets straight to GPIOs (internal pull-ups), plus the hook switch
           (a 13th socket under the hook plunger).
- audio:   ES8311 codec (datasheet reference parts) + 3.5 mm TRRS handset jack (CTIA):
           earpiece on tip + ring 1, mic on sleeve with an RC-filtered bias, insertion detect
           on the tip's normally-closed contact.
- ui:      1x8 header for a ready-made SPI display module, piezo ringer on one GPIO through an
           NPN, one status LED, board marking (logo + name) and four M3 mounting holes.

Not on this board (owner): NFC, battery/charger/fuel gauge, per-key LEDs, I/O expander, hall
sensor, privacy-light circuits, mute switch, speaker/amp, accelerometer, radar, extra ESD
networks, test-pad farms, level shifters.
"""

from __future__ import annotations

import builtins

import yaml
from pathlib import Path
from skidl import Net

from config import KEYS, Design
from lib import BLOCK, C, R, decouple, graphic, make, rail, series

NC = builtins.NC  # SKiDL explicit no-connect
PIN_TABLE = yaml.safe_load((Path(__file__).with_name("pin_table.yaml")).read_text())["gpio"]


def build(d: Design) -> None:
    GND = rail("GND")
    VBUS = rail("VBUS")
    V3V3 = rail("3V3")
    nets = {row["net"]: Net(row["net"]) for row in PIN_TABLE.values() if row.get("net")}
    nets["EN"] = Net("EN")

    for name, fn, args in (("power", power, (nets, GND, VBUS, V3V3)),
                           ("mcu", mcu, (nets, GND, V3V3)),
                           ("keys", keys, (d, nets, GND)),
                           ("audio", audio, (nets, GND, V3V3)),
                           ("ui", ui, (nets, GND, VBUS, V3V3))):
        BLOCK["name"] = name
        fn(*args)


# ---------------------------------------------------------------------------------------------
def power(n, GND, VBUS, V3V3):
    """USB-C sink: 5.1 k Rd on each CC pin = a plain 5 V sink at USB default power (no PD).
    No fuse: a compliant USB source current-limits its VBUS, the board has no battery, and the
    LDO limits (>= 810 mA) and shuts down on over-temperature (SGM2212 p6, p10)."""
    j = make("USB-C", ref="J1", note="power + native USB (flash/console)")
    j["VBUS"] += VBUS
    j["GND"] += GND
    j["SHIELD"] += GND
    cc1, cc2 = Net("CC1"), Net("CC2")
    j["CC1"] += cc1
    j["CC2"] += cc2
    j["DP"] += n["USB_DP"]
    j["DN"] += n["USB_DN"]
    series(cc1, GND, R("5.1k", note="Rd CC1"))
    series(cc2, GND, R("5.1k", note="Rd CC2"))

    esd = make("USBLC6-2SC6", ref="D1", note="USB D+/D- ESD, at the connector")
    esd["IO1"] += n["USB_DP"]
    esd["IO2"] += n["USB_DN"]
    esd["VBUS"] += VBUS
    esd["GND"] += GND

    # 3.3 V LDO. C_IN: 10 uF (the USB attach limit is 10 uF, SGM2212 p10 asks >= 2.2 uF);
    # C_OUT: 2.2 uF at the LDO (p10) + 22 uF/100 nF at the module (WROOM-1 p41).
    u = make("SGM2212-3.3", ref="U2", note="3V3 LDO, 800 mA")
    u["VIN"] += VBUS
    u["VOUT"] += V3V3
    u["GND"] += GND
    decouple(VBUS, GND, "10u", note="LDO C_IN / VBUS bulk (<= 10 uF USB attach)")
    decouple(V3V3, GND, "2.2u", note="LDO C_OUT (SGM2212 p10)")


def mcu(n, GND, V3V3):
    u = make("ESP32-S3-WROOM-1U", ref="U1")
    u["GND"] += GND
    u["3V3"] += V3V3
    u["EN"] += n["EN"]
    for gpio, row in PIN_TABLE.items():
        pin = {43: "TXD0", 44: "RXD0"}.get(gpio, f"IO{gpio}")
        u[pin] += n[row["net"]] if row.get("net") else NC
    decouple(V3V3, GND, "22u", "100n", note="module 3V3 at pin 2 (WROOM-1 datasheet p41)")
    # EN: RC delay 10 k / 1 uF (p41) + RESET button
    series(n["EN"], V3V3, R("10k", note="EN pull-up (p41)"))
    series(n["EN"], GND, C("1u", note="EN delay (p41)"))
    rst = make("TACT", ref="SW1", note="RESET")
    rst["A"] += n["EN"]
    rst["B"] += GND
    # BOOT: GPIO0 has an internal weak pull-up (p13); the button pulls it low at reset
    boot = make("TACT", ref="SW2", note="BOOT (hold + RESET = download mode)")
    boot["A"] += n["BOOT"]
    boot["B"] += GND


def keys(d, n, GND):
    """12 keys + the hook switch, each an MX switch in a hot-swap socket between its GPIO and
    GND. Internal pull-ups; debounce in firmware. The switch contacts sit inside the switch
    housing (not user-reachable), so no series resistors or ESD parts."""
    assert len(KEYS) == d.n_keys
    for i, legend in enumerate(KEYS):
        s = make("HOTSWAP", ref=f"SW{3 + i}", note=f"key {legend}")
        s[1] += n[f"KEY_{legend}"]
        s[2] += GND
    hook = make("HOTSWAP", ref="SW15", note="hook: MX switch pressed by the hook plunger")
    hook[1] += n["HOOK"]
    hook[2] += GND


def audio(n, GND, V3V3):
    """ES8311 per its typical application circuit (datasheet rev 7.0 p4) + the TRRS jack."""
    u = make("ES8311", ref="U3")
    u["MCLK"] += n["I2S_MCLK"]
    u["SCLK"] += n["I2S_BCLK"]
    u["LRCK"] += n["I2S_WS"]
    u["DSDIN"] += n["I2S_DOUT"]
    u["ASDOUT"] += n["I2S_DIN"]
    u["CCLK"] += n["I2C_SCL"]
    u["CDATA"] += n["I2C_SDA"]
    u["CE"] += GND  # I2C address 0x18
    for p in ("PVDD", "DVDD", "AVDD"):
        u[p] += V3V3
    for p in ("DGND", "AGND", "EP"):
        u[p] += GND
    decouple(V3V3, GND, "100n", "100n", note="ES8311 PVDD, DVDD (p4)")
    decouple(V3V3, GND, "1u", note="ES8311 AVDD (p4)")
    for p in ("VMID", "ADCVREF", "DACVREF"):
        net = Net(f"ES8311_{p}")
        u[p] += net
        series(net, GND, C("1u", note=f"{p} (p4)"))
    for p in ("I2C_SDA", "I2C_SCL"):
        series(n[p], V3V3, R("4.7k", note="I2C pull-up"))

    j = make("JACK_TRRS", ref="J2", note="handset jack (CTIA)")
    ear, mic, det = Net("HS_EAR"), Net("HS_MIC"), Net("HS_DET")
    j["T"] += ear
    j["R1"] += ear  # mono earpiece: both channels get the signal
    j["R2"] += GND
    j["S"] += mic
    j["TN"] += det
    j["R1N"] += NC

    # earpiece: OUTP (VMID-biased) -> 22 uF -> 22 R -> tip/ring1; OUTN unused
    outp, ear_ac = Net("DAC_OUTP"), Net("EAR_AC")
    u["OUTP"] += outp
    u["OUTN"] += NC
    series(outp, ear_ac, C("22u", note="earpiece coupling: 22 uF into 32+22 ohm -> 134 Hz"))
    series(ear_ac, ear, R("22", note="earpiece series: plug-in short protection"))
    series(ear, GND, R("4.7k", note="tip DC reference: keeps the cap at 0 V, TN reads low"))

    # mic: 3V3 -> 1k/10uF filter -> 2.2k bias -> sleeve; 1 uF into MIC1P, MIC1N 1 uF to GND
    micb = Net("MIC_BIAS")
    series(V3V3, micb, R("1k", note="mic bias RC filter"))
    series(micb, GND, C("10u", note="mic bias RC filter (16 Hz)"))
    series(micb, mic, R("2.2k", note="electret bias"))
    mic1p, mic1n = Net("MIC1P"), Net("MIC1N")
    u["MIC1P"] += mic1p
    u["MIC1N"] += mic1n
    series(mic, mic1p, C("1u", note="mic coupling (p4)"))
    series(mic1n, GND, C("1u", note="MIC1N reference (p4)"))

    # insertion detect: TN touches the tip (4.7k to GND) with no plug; a plug lifts it off
    series(det, n["JACK_DET"], R("1k", note="GPIO series (contact reaches the plug)"))


def ui(n, GND, VBUS, V3V3):
    # display module header (Waveshare 2.9" e-Paper order)
    h = make("DISPLAY_HDR", ref="J3", note="SPI display module")
    h["VCC"] += V3V3
    h["GND"] += GND
    for pin, net in (("DIN", "EPD_DIN"), ("CLK", "EPD_CLK"), ("CS", "EPD_CS"), ("DC", "EPD_DC"),
                     ("RST", "EPD_RST"), ("BUSY", "EPD_BUSY")):
        h[pin] += n[net]

    # piezo ringer from 5 V: GPIO -> 1k -> NPN; 1k across the element (TDK PS p2)
    bz = make("PIEZO", ref="BZ1", note="ringer")
    q = make("MMBT3904", ref="Q1", note="ringer driver")
    drv = Net("BUZZER_DRV")
    bz[1] += VBUS
    bz[2] += drv
    series(VBUS, drv, R("1k", note="piezo charge/discharge (TDK PS p2)"))
    base = Net("BUZZER_B")
    q["C"] += drv
    q["E"] += GND
    q["B"] += base
    series(n["BUZZER"], base, R("1k", note="base resistor"))

    # status LED: GPIO44 -> 1k -> LED -> GND (~1.3 mA)
    led, led_a = make("LED_RED", ref="D2", note="status"), Net("STATUS_LED_A")
    led["A"] += led_a
    led["K"] += GND
    series(n["STATUS_LED"], led_a, R("1k", note="status LED current (~1.3 mA)"))

    # board marking and mounting holes (layout places them; no BOM line)
    graphic("OpenLoungePhone:openloungephone_logo_F", "signature logo")
    graphic("OpenLoungePhone:openloungephone_name_F", "Open Lounge Phone")
    for _ in range(4):
        graphic("MountingHole:MountingHole_3.2mm_M3", "M3 mounting hole", prefix="H")
