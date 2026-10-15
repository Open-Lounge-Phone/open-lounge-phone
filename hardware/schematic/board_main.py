"""The minimal board (M1, owner decision 2026-09-30): core only plus one status LED; hw v0.901
adds a wired network (RJ45, W5500, isolated PoE).

2 layers, 156 x 88 mm (M2 placement, DESIGN.md §9). Blocks (one review page each):

- power:   USB-C receptacle (5 V sink, 2 x 5.1 k Rd, D+/D- to the ESP32 native USB through one
           USBLC6-2SC6), a Schottky OR of USB VBUS and the PoE 5 V into the 5 V rail V5,
           SGM2212-3.3 LDO (800 mA), bulk + decoupling per the module datasheet.
- mcu:     ESP32-S3-WROOM-1U-N16R8 (U.FL antenna), EN RC reset + RESET button, BOOT on GPIO0.
- keys:    12 MX hot-swap sockets straight to GPIOs (internal pull-ups), plus the hook switch
           (a 13th socket under the hook plunger).
- audio:   ES8311 codec (datasheet reference parts) + 3.5 mm TRRS handset jack (CTIA):
           earpiece on tip + ring 1, mic on sleeve with an RC-filtered bias, insertion detect
           on the tip's normally-closed contact.
- ui:      2x4 socket for the WeAct 2.13" e-paper module (2 standoff holes for the 2.9" option), piezo ringer on one
           GPIO through an NPN, one reverse-mount status LED, board marking (logo + name) and
           four M3 mounting holes.
- ethernet: W5500 (SPI: the display's clock and data lines, CS on GPIO0 = BOOT, MISO on GPIO45)
           per WIZnet's joined-centre-tap reference, its own SGM2212-3.3, the RJ45's chip side
           and LEDs (hw v0.901).
- poe:     the RJ45's cable-side centre taps -> two bridges (mode A + B) -> SMAJ58A -> an
           isolated DP9900LP-5V module -> a Schottky into V5 (hw v0.901).

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
    V5 = rail("V5")
    V3V3 = rail("3V3")
    nets = {row["net"]: Net(row["net"]) for row in PIN_TABLE.values() if row.get("net")}
    nets["EN"] = Net("EN")

    nets["POE_5V"] = rail("POE_5V")
    nets["_VBUS"] = VBUS
    for name, fn, args in (("power", power, (nets, GND, VBUS, V5, V3V3)),
                           ("mcu", mcu, (nets, GND, V3V3)),
                           ("keys", keys, (d, nets, GND)),
                           ("audio", audio, (nets, GND, V3V3)),
                           ("ui", ui, (nets, GND, V5, V3V3)),
                           ("ethernet", ethernet, (nets, GND, V5, V3V3)),
                           ("poe", poe, (nets, GND, V5))):
        BLOCK["name"] = name
        fn(*args)


# ---------------------------------------------------------------------------------------------
def power(n, GND, VBUS, V5, V3V3):
    """USB-C sink: 5.1 k Rd on each CC pin = a plain 5 V sink at USB default power (no PD).
    No fuse: a compliant USB source current-limits its VBUS, the board has no battery, and the
    LDO limits (>= 810 mA) and shuts down on over-temperature (SGM2212 p6, p10).
    hw v0.901: VBUS reaches the 5 V rail V5 through a Schottky (the PoE 5 V comes in through
    another, poe()), so neither source can feed the other. Only the receptacle's A9/B4 VBUS
    pad is routed (the plug joins all four VBUS contacts; 0.5 A on two contacts)."""
    j = make("USB-C", ref="J1", note="power + native USB (flash/console)")
    j["VBUS_E"] += VBUS
    j["VBUS_W"] += Net("VBUS_W")    # the plug's VBUS too, unrouted (its two pads overlap)
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
    esd["VBUS"] += V5      # the clamp's supply reference: the 5 V rail behind the OR
    esd["GND"] += GND

    # USB into the 5 V OR
    du = make("B5819W", ref="D3", note="USB VBUS -> V5 (OR)")
    du["A"] += VBUS
    du["K"] += V5
    # No VBUS bleeder: D3's reverse leakage (uA at 5 V) only lets an open receptacle's VBUS float,
    # it can't source current into a host (no room for one beside the receptacle).

    # 3.3 V LDO. C_IN 4.7 uF here + 4.7 uF at the Ethernet LDO: the whole V5 rail stays under the
    # 10 uF USB attach limit (SGM2212 p10 asks >= 2.2 uF); C_OUT: 2.2 uF at the LDO (p10) +
    # 22 uF/100 nF at the module (WROOM-1 p41).
    u = make("SGM2212-3.3", ref="U2", note="3V3 LDO, 800 mA")
    u["VIN"] += V5
    u["VOUT"] += V3V3
    u["GND"] += GND
    decouple(V5, GND, "4.7u", note="LDO C_IN / V5 bulk (V5 total <= 10 uF: USB attach)")
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
    # BOOT: GPIO0 has an internal weak pull-up (p13); the button pulls it low at reset.
    # hw v0.901: GPIO0 is also the W5500's chip select (ETH_CS, 10 k pull-up in ethernet()), so
    # the button reaches it through 1 k: 3.3 V x 1k / 11k = 0.30 V at reset (download mode), and
    # a press while firmware drives CS only costs 3.3 mA.
    sw = n["BOOT_SW"] = Net("BOOT_SW")    # its 1 k series resistor is made in ethernet()
    boot = make("TACT", ref="SW2", note="BOOT (hold + RESET = download mode)")
    boot["A"] += sw
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


def ui(n, GND, V5, V3V3):
    # display module socket (WeAct e-Paper 2x4 order, 2.13" or 2.9"; the module plugs in directly)
    h = make("DISPLAY_HDR", ref="J3", note="SPI display module (WeAct 2.9\" plugs in)")
    h["VCC"] += V3V3
    h["GND"] += GND
    for pin, net in (("DIN", "EPD_DIN"), ("CLK", "EPD_CLK"), ("CS", "EPD_CS"), ("DC", "EPD_DC"),
                     ("RST", "EPD_RST"), ("BUSY", "EPD_BUSY")):
        h[pin] += n[net]

    # piezo ringer from 5 V: GPIO -> 1k -> NPN; 1k across the element (TDK PS p2)
    bz = make("PIEZO", ref="BZ1", note="ringer")
    q = make("MMBT3904", ref="Q1", note="ringer driver")
    drv = Net("BUZZER_DRV")
    bz[1] += V5
    bz[2] += drv
    series(V5, drv, R("1k", note="piezo charge/discharge (TDK PS p2)"))
    base = Net("BUZZER_B")
    q["C"] += drv
    q["E"] += GND
    q["B"] += base
    series(n["BUZZER"], base, R("1k", note="base resistor"))

    # status LED: GPIO -> 1k -> reverse-mount LED -> GND (~1.5 mA), seen through a board hole
    led, led_a = make("LED_RED", ref="D2", note="status"), Net("STATUS_LED_A")
    led["A"] += led_a
    led["K"] += GND
    series(n["STATUS_LED"], led_a, R("1k", note="status LED current (~1.5 mA)"))

    # board marking and mounting holes (layout places them; no BOM line)
    graphic("OpenLoungePhone:openloungephone_logo_F", "signature logo")
    graphic("OpenLoungePhone:openloungephone_name_F", "Open Lounge Phone")
    for _ in range(4):
        graphic("MountingHole:MountingHole_3.2mm_M3", "M3 mounting hole", prefix="H")
    # the display module's far end rests on two M3 standoffs (its own holes are M3, WeAct
    # drawing: 86.2 x 31.9 mm hole pattern); the 2x4 socket J3 holds the other end
    for _ in range(2):
        graphic("MountingHole:MountingHole_3.2mm_M3", "M3 display standoff", prefix="H")


def ethernet(n, GND, V5, V3V3):
    """W5500 on the display's SPI bus (EPD_CLK/EPD_DIN = SCLK/MOSI, separate chip selects),
    WIZnet's reference circuit for magnetics with joined TX/RX centre taps (the HR871150C's P3):
    TX+/- 49.9 R to the analog 3.3 V, RX+/- AC-coupled (6.8 nF, required with a joined centre tap)
    into 2 x 49.9 R to a 10 nF node, the centre tap fed through 10 R with 100 nF.

    GPIO budget: no free GPIO for RSTn or INTn. INTn stays open (ESP-IDF polls: int_gpio_num -1,
    poll_period_ms > 0); RSTn has its own power-on RC (10 k / 4.7 uF, ~47 ms: still in reset when
    the module latches its straps 10 ms + 3 ms after power-up); firmware soft-resets it (MR.RST)
    at init.
    Straps: SCSn = GPIO0 with a 10 k pull-up (high at reset = SPI boot, and MISO is then Hi-Z,
    W5500 p10); MISO = GPIO45 (VDD_SPI strap, must read low) with a 10 k pull-down."""
    E3, EA = rail("ETH_3V3"), rail("ETH_3V3A")
    series(n["ETH_CS"], n["BOOT_SW"], R("1k", note="BOOT button series (GPIO0 is also ETH_CS)"))
    # own regulator: keeps the W5500's 130 mA off the module's LDO (heat) and its supply clean
    ldo = make("SGM2212-3.3", ref="U5", note="ETH_3V3 LDO (W5500)")
    ldo["VIN"] += V5
    ldo["VOUT"] += E3
    ldo["GND"] += GND
    decouple(V5, GND, "4.7u", note="Ethernet LDO C_IN (V5 total <= 10 uF: USB attach)")
    decouple(E3, GND, "2.2u", note="Ethernet LDO C_OUT (SGM2212 p10)")
    fb = make("BEAD_600R", ref="FB1", note="digital -> analog 3.3 V (WIZnet ref)")
    fb[1] += E3
    fb[2] += EA

    u = make("W5500", ref="U4")
    u["VDD"] += E3
    u["GND"] += GND
    u["AVDD"] += EA
    u["AGND"] += GND
    decouple(E3, GND, "10u", "100n", note="W5500 VDD pin 28")
    decouple(EA, GND, "10u", note="W5500 AVDD bulk")
    decouple(EA, GND, "100n", "100n", "100n", note="W5500 AVDD (east pins 8/11, south 15/17, 21)")
    # PMODE[2:0] open: internal pull-ups = 111, all capable with auto-negotiation (p10; WIZnet's
    # magjack reference leaves them open too)
    for p in ("DNC", "NC12", "NC13", "VBG", "NC46", "NC47", "RSVD38", "RSVD39", "RSVD40",
              "RSVD41", "RSVD42", "SPDLED", "DUPLED", "INTn", "PMODE0", "PMODE1", "PMODE2"):
        u[p] += NC
    u["RSVD23"] += GND                       # "must be tied to GND" (p9)
    for pin, net, part in (("EXRES1", "W5500_EXRES", R("12.4k", note="EXRES1 12.4 k 1 % (p11)")),
                           ("TOCAP", "W5500_TOCAP", C("4.7u", note="TOCAP (p8)")),
                           ("1V2O", "W5500_1V2O", C("10n", note="1V2O (p8)"))):
        x = Net(net)
        u[pin] += x
        series(x, GND, part)

    # 25 MHz crystal, 18 pF load caps (12 pF crystal), 1 M across (p11 fig. 3)
    y = make("XTAL_25M", ref="Y1")
    xi, xo = Net("W5500_XI"), Net("W5500_XO")
    u["XI"] += xi
    u["XO"] += xo
    y["X1"] += xi
    y["X2"] += xo
    y["GND"] += GND
    series(xi, GND, C("18p", note="crystal load"))
    series(xo, GND, C("18p", note="crystal load"))
    series(xi, xo, R("1M", note="crystal bias (W5500 p11)"))

    # SPI: shared clock/data with the display; own CS and MISO
    u["SCLK"] += n["EPD_CLK"]
    u["MOSI"] += n["EPD_DIN"]
    u["SCSn"] += n["ETH_CS"]
    u["MISO"] += n["ETH_MISO"]
    series(n["ETH_CS"], E3, R("10k", note="ETH_CS pull-up: high at reset (SPI boot, MISO Hi-Z)"))
    series(n["ETH_MISO"], GND, R("10k", note="ETH_MISO pull-down: GPIO45 strap low at reset"))
    # reset: power-on RC (no free GPIO), longer than the module's EN delay
    rst = Net("ETH_RST")
    u["RSTn"] += rst
    series(rst, E3, R("10k", note="RSTn power-on RC (no free GPIO)"))
    series(rst, GND, C("4.7u", note="RSTn power-on RC: ~47 ms, past the strap window"))

    # magnetics (chip side of the RJ45; its cable side is in poe())
    j = make("RJ45_POE", ref="J4", note="Ethernet + PoE")
    n["_J4"] = j                             # poe() wires its cable side
    txp, txn, rxp, rxn = Net("ETH_TXP"), Net("ETH_TXN"), Net("ETH_RXP"), Net("ETH_RXN")
    u["TXP"] += txp
    u["TXN"] += txn
    u["RXP"] += rxp
    u["RXN"] += rxn
    j["TD+"] += txp
    j["TD-"] += txn
    series(txp, EA, R("49.9", note="TX+ termination (WIZnet ref)"))
    series(txn, EA, R("49.9", note="TX- termination (WIZnet ref)"))
    jrp, jrn = Net("ETH_RDP_J"), Net("ETH_RDN_J")
    j["RD+"] += jrp
    j["RD-"] += jrn
    series(jrp, rxp, C("6.8n", note="RX+ AC coupling (joined centre tap)"))
    series(jrn, rxn, C("6.8n", note="RX- AC coupling (joined centre tap)"))
    rxc = Net("ETH_RXC")
    series(rxp, rxc, R("49.9", note="RX termination"))
    series(rxn, rxc, R("49.9", note="RX termination"))
    series(rxc, GND, C("10n", note="RX termination centre"))
    ct = Net("ETH_CT")
    j["CT"] += ct
    series(EA, ct, R("10", note="centre-tap feed (WIZnet joined-CT ref)"))
    series(ct, GND, C("100n", note="centre-tap bypass"))
    shield = Net("ETH_SHIELD")
    j["SHIELD"] += shield
    series(shield, GND, C("1n@2kV", note="RJ45 shield to GND (2 kV)"))
    # LEDs: green = link (W5500 LINKLED), yellow = activity (ACTLED); active low, ~4 mA
    for a, k, pin, what in (("LEDG_A", "LEDG_K", "LINKLED", "link"),
                            ("LEDY_A", "LEDY_K", "ACTLED", "activity")):
        j[a] += E3
        kn = Net(f"ETH_LED_{what.upper()}_K")
        j[k] += kn
        pn = Net(f"ETH_{pin}")
        u[pin] += pn
        series(kn, pn, R("330", note=f"RJ45 {what} LED"))


def poe(n, GND, V5):
    """IEEE 802.3af PD (DP9900LP-5V typical connection, p3): the RJ45's cable-side centre taps
    -> two bridges (mode A data pairs, mode B spare pairs) -> SMAJ58A -> the isolated module ->
    100 uF + 10 uF -> a Schottky into V5. ADJ 100 k to -VDC lifts the output to 5.27 V (p4), which
    pays the OR diode's drop. Everything on the bridge side is isolated from GND (1500 V, layout
    keeps 3 mm, checks.check_poe)."""
    j = n["_J4"]
    va1, va2, vb1, vb2 = Net("POE_VA1"), Net("POE_VA2"), Net("POE_VB1"), Net("POE_VB2")
    j["VC1+"] += va1
    j["VC1-"] += va2
    j["VC2+"] += vb1
    j["VC2-"] += vb2
    vp, vn = Net("POE_VIN_P"), Net("POE_VIN_N")
    # (a bridge's two AC pins are interchangeable: BR1's are swapped so its tracks don't cross)
    for ref, a, b in (("BR1", va2, va1), ("BR2", vb1, vb2)):
        br = make("MB10S", ref=ref, note="PoE input bridge (mode A)" if ref == "BR1" else
                  "PoE input bridge (mode B)")
        br["AC1"] += a
        br["AC2"] += b
        br["+"] += vp
        br["-"] += vn
    tvs = make("SMAJ58A", ref="D4", note="PoE input TVS")
    tvs["K"] += vp
    tvs["A"] += vn
    m = make("DP9900LP-5V", ref="PS1", note="isolated PoE PD, 5 V")
    m["VIN+"] += vp
    m["VIN-"] += vn
    m["+VDC"] += n["POE_5V"]
    m["-VDC"] += GND
    adj = Net("POE_ADJ")
    m["ADJ"] += adj
    series(adj, GND, R("100k", note="ADJ to -VDC: 5.27 V (DP9900 p4)"))
    ct = make("TANT_100U", note="PoE module output (>= 100 uF low ESR, p3)")
    ct["+"] += n["POE_5V"]
    ct["-"] += GND
    series(n["POE_5V"], GND, C("10u@25V", note="PoE module output (p3)"))
    series(n["POE_5V"], GND, R("51", size="2512", dnp=True,
                               note="minimum-load bleeder (100 mA, p6): fit if the board idles below it"))
    d = make("SS34", ref="D5", note="PoE 5 V -> V5 (OR)")
    d["A"] += n["POE_5V"]
    d["K"] += V5
