"""The one board (180 x 88 mm, 4 layers). DESIGN.md §3, §4, §5, §8, §9, §11.

Single board (owner decision 2026-09-27): two stacked boards were carried over from the old
long base; one board is cheaper one-off (one fab/assembly setup, no FFC/connectors/standoffs).

Blocks: USB-C sink + ESD + CH340C, BQ24074 power path, 3V3 buck, 3V0 analog LDO, ESP32-S3
module, ES8311 + ES7210 + NS4150B audio with AEC reference loopback, USB-C handset port (host),
base mic, mic bias / privacy-LED sense, DRV5032 hook (+ DNP IR option), LIS2DH12, ATECC608B
(DNP), MAX17048 + battery (B-option), LD2410C radar (Lounge), supercap hold-up (Lounge),
LED-data buffer, side controls, test points, and the UI block (ui.py: 12 hot-swap keys,
13 SK6812MINI-E, AW9523B, e-ink strip, NFC tag, ambient light, privacy LED, Qwiic).
"""

from __future__ import annotations

import builtins

from skidl import Net

NC = builtins.NC  # SKiDL explicit no-connect net

from config import Variant
from lib import TP, C, NetTie, R, SJ, decouple, make, rail, series
from ui import ui


def build(v: Variant) -> None:
    # ---- rails and shared nets -------------------------------------------------------------
    GND = rail("GND")
    VBUS_C = rail("VBUS_C")  # connector side, before the PTC
    VBUS = rail("VBUS")  # after PTC + TVS: BQ24074 IN, radar switch
    VSYS = rail("VSYS")  # BQ24074 OUT: 4.4 V on USB, = VBAT on battery
    V3V3 = rail("3V3")
    V3V0 = rail("3V0")  # analog: ES8311/ES7210 AVDD, mic bias source
    VBAT = rail("VBAT")
    n = {name: Net(name) for name in (
        "BOOT", "EN", "CC1", "CC2", "CC1_SENSE", "CC2_SENSE", "HS_VBUS_EN", "HS_VBUS_SENSE",
        "HOOK", "HS_USB_DP", "HS_USB_DN",
        "LD_OUT", "IRQ", "I2C_SDA", "I2C_SCL", "EPD_CS", "EPD_MOSI", "EPD_SCK", "EPD_DC",
        "EPD_RST", "EPD_BUSY", "I2S_MCLK", "I2S_BCLK", "I2S_WS", "USB_DN", "USB_DP",
        "USB_DN_C", "USB_DP_C", "I2S_DOUT", "I2S_DIN", "LD_RX", "LD_TX", "PA_EN", "LED_DATA",
        "U0TXD", "U0RXD", "CHG_CE", "LD_PWR_EN", "CHG_STAT", "PGOOD", "LED_DATA_BUF",
        "MICBIAS_IN", "MICBIAS_OUT", "PRIV_LED_K", "VOL_DN", "VOL_UP", "MUTE_SENSE",
    )}

    power(v, n, GND, VBUS_C, VBUS, VSYS, V3V3, V3V0, VBAT)
    mcu(n, GND, V3V3, VSYS)
    audio(n, GND, V3V3, V3V0, VSYS)
    sensors(v, n, GND, V3V3, VBAT)
    radar(v, n, GND, VBUS)
    handset_port(n, GND, VBUS, VSYS, V3V3)
    usb_uart(n, GND, V3V3)
    side_controls(n, GND, V3V3)
    ui(v, n, GND, V3V3, VSYS)
    test_points(n, GND, VBUS, VSYS, V3V3, V3V0)


# ---------------------------------------------------------------------------------------------
def power(v, n, GND, VBUS_C, VBUS, VSYS, V3V3, V3V0, VBAT):
    # USB-C receptacle: sink-only, separate 5.1k Rd per CC pin (no PD). §9.1
    j = make("USB-C", ref="J1")
    j["VBUS"] += VBUS_C
    j["GND"] += GND
    j["SHIELD"] += GND  # shell to GND at the connector (EMC: revisit RC to GND in EVT)
    j["CC1"] += n["CC1"]
    j["CC2"] += n["CC2"]
    j["DP"] += n["USB_DP_C"]
    j["DN"] += n["USB_DN_C"]
    series(n["CC1"], GND, R("5.1k", note="Rd CC1"))
    series(n["CC2"], GND, R("5.1k", note="Rd CC2"))
    # CC sense to ADC1 through 1k (limits injected ESD current into the GPIO clamp)
    series(n["CC1"], n["CC1_SENSE"], R("1k"))
    series(n["CC2"], n["CC2_SENSE"], R("1k"))

    # ESD: USBLC6 on D+/D-, second USBLC6 on CC1/CC2 (low-cap ESD on CC per §11.3)
    esd = make("USBLC6-2SC6", ref="D1", note="USB D+/D- ESD")
    esd["IO1"] += n["USB_DP_C"]
    esd["IO2"] += n["USB_DN_C"]
    esd["VBUS"] += VBUS_C
    esd["GND"] += GND
    esd2 = make("USBLC6-2SC6", ref="D2", note="CC1/CC2 ESD")
    esd2["IO1"] += n["CC1"]
    esd2["IO2"] += n["CC2"]
    esd2["VBUS"] += VBUS_C
    esd2["GND"] += GND
    # D+/D- to the module: 0R placeholders for series termination / CMC tuning in EVT
    series(n["USB_DP_C"], n["USB_DP"], R("0", note="USB D+ series (0R, tune in EVT)"))
    series(n["USB_DN_C"], n["USB_DN"], R("0", note="USB D- series (0R, tune in EVT)"))

    # PTC then TVS. §9.1
    f = make("PTC1A5", ref="F1")
    f[1] += VBUS_C
    f[2] += VBUS
    tvs = make("SMF5.0A", ref="D3")
    tvs["K"] += VBUS
    tvs["A"] += GND
    decouple(VBUS, GND, "10u")

    # BQ24074 power path. OVP 10.5 V, VO(REG) 4.4 V (datasheet SLUS810N)
    u = make("BQ24074", ref="U2")
    u["IN"] += VBUS
    u["OUT"] += VSYS
    u["BAT"] += VBAT
    u["VSS"] += GND
    u["EP"] += GND
    u["EN1"] += GND  # EN2=1, EN1=0 -> input limit set by R_ILIM
    u["EN2"] += VSYS
    u["CE_N"] += n["CHG_CE"]  # GPIO45, 10k pull-down (strap) = charging enabled
    u["PGOOD_N"] += n["PGOOD"]
    u["CHG_N"] += n["CHG_STAT"]
    series(u["ILIM"], GND, R("1.1k", note="ILIM 1.46 A (K_ILIM 1610 / 1.1k; 1.1k is the minimum)"))
    series(u["ISET"], GND, R("1.8k", note="ISET 494 mA (K_ISET 890 / 1.8k)"))
    # TMR open = default safety timers; ITERM open = 10 % termination
    u["TMR"] += NC
    u["ITERM"] += NC
    # TS: 10k fixed resistor without a battery (datasheet), pack NTC via J_BAT pin 2 with one
    ts = Net("BQ_TS")
    u["TS"] += ts
    series(ts, GND, R("10k", dnp=v.battery, note="TS fixed 10k (no-battery variant)"))
    decouple(VBUS, GND, "1u")
    decouple(VSYS, GND, "10u", "10u", "100n")
    decouple(VBAT, GND, "4.7u")
    for net, pull in ((n["PGOOD"], "10k"), (n["CHG_STAT"], "10k")):
        series(net, V3V3, R(pull))
    series(n["CHG_CE"], GND, R("10k", note="GPIO45 strap: low = 3.3 V flash, charge enabled"))

    # B-option battery: JST-PH-3 (VBAT, NTC, GND). DESIGN.md said PH-2, which cannot carry
    # the pack NTC to TS - see SCHEMATIC.md deviations.
    jb = make("JST-PH-3", ref="J2", dnp=not v.battery, note="B-option LiPo 1S + 10k NTC")
    jb[1] += VBAT
    jb[2] += ts
    jb[3] += GND
    jb["MP"] += GND

    # Lounge supercap hold-up: VSYS -> 47R -> SCAP, SCAP -> Schottky -> VSYS. §9.5
    scap = Net("SCAP")
    series(VSYS, scap, R("47", size="2512", dnp=not v.supercap,
                         note="supercap charge, tau 22 s; 0.41 W at t=0 -> 2512 1 W"))
    sc = make("SUPERCAP", dnp=not v.supercap)
    sc["+"] += scap
    sc["-"] += GND
    d = make("B5819W", ref="D4", dnp=not v.supercap)
    d["A"] += scap
    d["K"] += VSYS

    # 3V3 buck (TLV62569): Vout = 0.6 * (1 + 100k/22k) = 3.327 V
    b = make("TLV62569", ref="U3")
    b["VIN"] += VSYS
    b["EN"] += VSYS
    b["GND"] += GND
    sw = Net("BUCK_SW")
    fb = Net("BUCK_FB")
    b["SW"] += sw
    b["FB"] += fb
    lb = make("L2u2", ref="L1")
    lb[1] += sw
    lb[2] += V3V3
    series(V3V3, fb, R("100k", note="FB top"))
    series(fb, GND, R("22k", note="FB bottom -> 3.33 V"))
    decouple(VSYS, GND, "10u", note="buck input, next to VIN")
    decouple(V3V3, GND, "22u", "22u")

    # 3V0 low-noise analog LDO from VSYS (keeps buck ripple out of codecs / mic bias)
    ldo = make("LP5907-3.0", ref="U4")
    ldo["IN"] += VSYS
    ldo["EN"] += VSYS
    ldo["GND"] += GND
    ldo["OUT"] += V3V0
    ldo["NC"] += NC
    decouple(VSYS, GND, "1u")
    decouple(V3V0, GND, "1u", "10u")


# ---------------------------------------------------------------------------------------------
PIN_TABLE = {
    # GPIO -> net (must match pin_table.yaml; checks.py enforces it)
    "IO0": "BOOT", "IO1": "CC1_SENSE", "IO2": "CC2_SENSE", "IO3": "HS_VBUS_EN",
    "IO4": "HS_VBUS_SENSE",
    "IO5": "HOOK", "IO6": "LD_OUT", "IO7": "IRQ", "IO8": "I2C_SDA", "IO9": "I2C_SCL",
    "IO10": "EPD_CS", "IO11": "EPD_MOSI", "IO12": "EPD_SCK", "IO13": "EPD_DC", "IO14": "EPD_RST",
    "IO15": "EPD_BUSY", "IO16": "I2S_MCLK", "IO17": "I2S_BCLK", "IO18": "I2S_WS",
    "IO19": "HS_USB_DN", "IO20": "HS_USB_DP", "IO21": "I2S_DOUT", "IO38": "I2S_DIN", "IO39": "LD_RX",
    "IO40": "LD_TX", "IO41": "PA_EN", "IO42": "LED_DATA", "TXD0": "U0TXD", "RXD0": "U0RXD",
    "IO45": "CHG_CE", "IO46": "LD_PWR_EN", "IO47": "CHG_STAT", "IO48": "PGOOD",
}


def mcu(n, GND, V3V3, VSYS):
    u = make("ESP32-S3-WROOM-1", ref="U1")
    u["GND"] += GND
    u["3V3"] += V3V3
    u["EN"] += n["EN"]
    for pin, net in PIN_TABLE.items():
        u[pin] += n[net]
    # IO35-37: octal PSRAM, leave unconnected (explicit no-connects)
    for pin in ("IO35", "IO36", "IO37"):
        u[pin] += NC
    decouple(V3V3, GND, "22u", "100n", note="module 3V3, at pin 2 (WROOM-1 datasheet)")
    # EN: 10k pull-up + 1uF (Espressif checklist RC delay) + RESET button
    series(n["EN"], V3V3, R("10k"))
    series(n["EN"], GND, C("1u"))
    rst = make("TACT", ref="SW1", note="RESET (pinhole)")
    rst["A"] += n["EN"]
    rst["B"] += GND
    # BOOT (GPIO0 strap): 10k pull-up + button; runtime long-press = factory reset
    series(n["BOOT"], V3V3, R("10k"))
    boot = make("TACT", ref="SW2", note="BOOT / service (pinhole)")
    boot["A"] += n["BOOT"]
    boot["B"] += GND
    # strapping / default-off pulls (§5)
    series(n["HS_VBUS_EN"], GND, R("100k", note="GPIO3: handset VBUS off at boot"))
    series(n["PA_EN"], GND, R("100k", note="GPIO41: amp off at boot (no pop)"))
    series(n["LD_PWR_EN"], GND, R("100k", note="GPIO46 strap: radar off at boot"))
    series(n["LD_OUT"], GND, R("100k", note="defined level when radar is DNP/unpowered"))
    # shared I2C pull-ups (4.7k, 400 kHz) and shared open-drain IRQ pull-up (10k)
    series(n["I2C_SDA"], V3V3, R("4.7k"))
    series(n["I2C_SCL"], V3V3, R("4.7k"))
    series(n["IRQ"], V3V3, R("10k"))
    # LED data: 3.3 V GPIO42 -> SN74LV1T125 on VSYS -> 330R -> LED chain (SK6812 VIH = 0.7*VDD)
    buf = make("SN74LV1T125", ref="U5")
    buf["VCC"] += VSYS
    buf["GND"] += GND
    buf["OE_N"] += GND
    buf["A"] += n["LED_DATA"]
    series(n["LED_DATA"], GND, R("100k", note="GPIO42 floats at reset: keep LED data low"))
    series(buf["Y"], n["LED_DATA_BUF"],
           R("330", note="LED data series: limits back-feed (<12 mA) into an unpowered chain"))
    decouple(VSYS, GND, "100n", note="SN74LV1T125")


# ---------------------------------------------------------------------------------------------
def audio(n, GND, V3V3, V3V0, VSYS):
    I2S = dict(MCLK=n["I2S_MCLK"], SCLK=n["I2S_BCLK"], LRCK=n["I2S_WS"])

    # ---- ES8311: DAC for earpiece/speaker/reference; I2C 0x18 (CE low) ----
    dac = make("ES8311", ref="U6")
    for pin, net in I2S.items():
        dac[pin] += net
    dac["DSDIN"] += n["I2S_DOUT"]
    asd = Net("ES8311_ASDOUT")  # ES8311 ADC unused (not on the I2S bus); test pad only
    dac["ASDOUT"] += asd
    TP(asd)
    dac["CCLK"] += n["I2C_SCL"]
    dac["CDATA"] += n["I2C_SDA"]
    series(dac["CE"], GND, R("10k", note="CE low -> I2C 0x18"))
    dac["PVDD"] += V3V3
    dac["DVDD"] += V3V3
    dac["AVDD"] += V3V0
    for p in ("DGND", "AGND", "EP"):
        dac[p] += GND
    decouple(V3V3, GND, "100n", "100n", note="ES8311 PVDD/DVDD")
    decouple(V3V0, GND, "1u", "100n", note="ES8311 AVDD")
    for p in ("VMID", "ADCVREF", "DACVREF"):
        net = Net(f"ES8311_{p}")
        dac[p] += net
        series(net, GND, C("1u"))
    OUTP, OUTN = Net("DAC_OUTP"), Net("DAC_OUTN")
    dac["OUTP"] += OUTP
    dac["OUTN"] += OUTN

    # ---- ES7210: 4-ch ADC, TDM on SDOUT1; I2C 0x40 (AD0=AD1=0) ----
    adc = make("ES7210", ref="U7")
    for pin, net in I2S.items():
        adc[pin] += net
    series(adc["SDOUT1"], n["I2S_DIN"], R("47", note="TDM data series (Korvo: 51R)"))
    adc["SDOUT2"] += NC
    adc["INT"] += NC
    adc["DMIC_CLK"] += NC
    adc["CCLK"] += n["I2C_SCL"]
    adc["CDATA"] += n["I2C_SDA"]
    series(adc["AD0"], GND, R("10k", note="AD0=0"))
    series(adc["AD1"], GND, R("10k", note="AD1=0 -> 0x40"))
    adc["VDDP"] += V3V3
    adc["VDDD"] += V3V3
    adc["VDDA"] += V3V0
    adc["VDDM"] += V3V0
    for p in ("GNDD", "GNDA", "EP"):
        adc[p] += GND
    decouple(V3V3, GND, "100n", "100n", note="ES7210 VDDP/VDDD")
    decouple(V3V0, GND, "1u", "1u", note="ES7210 VDDA/VDDM")
    for p in ("REFP12", "REFQ12", "REFP34", "REFQ34", "REFQM"):
        net = Net(f"ES7210_{p}")
        adc[p] += net
        series(net, GND, C("1u"))
    micbias = n["MICBIAS_IN"]  # MICBIAS12 -> MUTE slide (pole A) -> MICBIAS_OUT
    adc["MICBIAS12"] += micbias
    series(micbias, GND, C("1u"))
    adc["MICBIAS34"] += NC  # CH3 = line-level reference, CH4 spare: no bias

    # ---- mic bias return from the mute switch, filtered, feeds both electrets ----
    mb_out = n["MICBIAS_OUT"]
    series(mb_out, GND, R("100k", note="bleeds bias to 0 when MUTE opens (privacy LED off fast)"))
    mb_f = Net("MICBIAS_F")
    series(mb_out, mb_f, R("100", note="bias RC filter"))
    series(mb_f, GND, C("10u"))
    # Hardwired privacy LED: NPN senses post-switch bias, sinks the privacy LED cathode (ui.py).
    q = make("MMBT3904", ref="Q1", note="privacy LED sink; firmware cannot bypass")
    qb = Net("PRIV_Q_B")
    series(mb_out, qb, R("22k", note="~75 uA base drive at 2.5 V bias"))
    series(qb, GND, R("100k"))
    q["B"] += qb
    q["E"] += GND
    q["C"] += n["PRIV_LED_K"]

    # ---- handset: off-the-shelf USB-C (UAC) handset on its own USB-C host port (see
    # handset_port()); the codecs serve the base speaker, base mic and the AEC reference.
    # ES7210 CH1 (was the analog handset mic) is unused: inputs AC-grounded like CH4.
    series(adc["MIC1P"], GND, C("1u"))
    series(adc["MIC1N"], GND, C("1u"))
    series(dac["MIC1P"], GND, C("1u"))  # ES8311 ADC input unused: AC-grounded
    series(dac["MIC1N"], GND, C("1u"))

    # ---- base (speakerphone) electret -> ES7210 CH2 ----
    mk = make("ELECTRET", ref="MK1", note="front wall, rubber boot")
    bm_p, bm_n = Net("BASEMIC_P"), Net("BASEMIC_N")
    mk["OUT"] += bm_p
    mk["GND"] += bm_n
    series(mb_f, bm_p, R("2.2k", note="base electret bias"))
    series(bm_p, GND, C("33p", note="RF"))
    NetTie(bm_n, GND, note="base mic return")
    series(bm_p, adc["MIC2P"], C("1u"))
    series(bm_n, adc["MIC2N"], C("1u"))

    # ---- AEC reference: ES8311 OUTP/OUTN -> AC couple -> divider -> ES7210 CH3 (Korvo-2) ----
    # per leg: 1u -> 20k ; shunt 4.3k across the pair (~ -24 dB) ; 100 pF ; 1u into MIC3x
    rp, rn = Net("REF_DIV_P"), Net("REF_DIV_N")
    for out, div, mic in ((OUTP, rp, "MIC3P"), (OUTN, rn, "MIC3N")):
        mid = Net(f"REF_AC_{mic}")
        series(out, mid, C("470n"))
        series(mid, div, R("20k"))
        series(div, adc[mic], C("1u"))
    series(rp, rn, R("4.3k", note="AEC ref divider shunt (tune in EVT)"))
    series(rp, rn, C("100p"))
    # CH4 spare: inputs AC-grounded
    series(adc["MIC4P"], GND, C("1u"))
    series(adc["MIC4N"], GND, C("1u"))

    # ---- NS4150B speaker amp on VSYS: Rin 150k -> gain 1.6 (Korvo-2), CTRL = PA_EN ----
    pa = make("NS4150B", ref="U9")
    pa["VCC"] += VSYS
    pa["GND"] += GND
    pa["CTRL"] += n["PA_EN"]
    bp = Net("PA_BYPASS")
    pa["BYPASS"] += bp
    series(bp, GND, C("1u"))
    for out, pin in ((OUTP, "INP"), (OUTN, "INN")):
        mid = Net(f"PA_IN_{pin}")
        series(out, mid, C("100n"))
        series(mid, pa[pin], R("150k"))
    # EVT: total VSYS capacitance is ~140 uF (+ supercap via 47R on Lounge); TI recommends
    # 4.7-47 uF on BQ24074 OUT - verify start-up / short-circuit detection with this load.
    decouple(VSYS, GND, "100u", "10u", "100n", note="NS4150B supply, at pin 6")
    spk = make("JST-PH-2", ref="J4", note="speaker 4 ohm 3 W")
    spk["MP"] += GND
    for pin, jpin in (("VOP", 1), ("VON", 2)):
        o = Net(f"SPK_{pin}")
        fb = make("FB220_2A", note="speaker EMI; 2 A (3 W into 4 ohm = 0.87 A rms)")
        fb[1] += pa[pin]
        fb[2] += o
        series(o, GND, C("220p", note="EMI"))
        spk[jpin] += o


# ---------------------------------------------------------------------------------------------
def sensors(v, n, GND, V3V3, VBAT):
    # DRV5032 omnipolar hall hook switch (push-pull out) -> HOOK via 0R (IR option alternative)
    h = make("DRV5032FA", ref="U10", note="under one hook-rest post (boards.yaml hook_post_x)")
    h["VCC"] += V3V3
    h["GND"] += GND
    hall = Net("HOOK_HALL")
    h["OUT"] += hall
    decouple(V3V3, GND, "100n", note="DRV5032")
    series(hall, n["HOOK"], R("0", dnp=v.ir_hook, note="hall -> HOOK"))
    # IR reflective option for magnet-less third-party handsets (DNP), §6.4
    ir = make("ITR8307", ref="U11", dnp=not v.ir_hook)
    ir_a, ir_c = Net("IR_LED_A"), Net("IR_PT_C")
    series(V3V3, ir_a, R("330", dnp=not v.ir_hook, note="IR LED ~6 mA"))
    ir["A"] += ir_a
    ir["K"] += GND
    ir["C"] += ir_c
    ir["E"] += GND
    series(ir_c, V3V3, R("10k", dnp=not v.ir_hook))
    series(ir_c, n["HOOK"], R("0", dnp=not v.ir_hook, note="IR -> HOOK"))

    # LIS2DH12 accelerometer, I2C 0x19 (SA0=1), INT1 -> shared IRQ (open-drain mode in FW)
    a = make("LIS2DH12", ref="U12")
    a["VDD"] += V3V3
    a["VDD_IO"] += V3V3
    a["GND"] += GND
    a["SCL"] += n["I2C_SCL"]
    a["SDA"] += n["I2C_SDA"]
    a["SA0"] += V3V3
    a["CS"] += V3V3  # I2C mode
    a["RES"] += GND  # datasheet: connect to GND
    # INT1 is push-pull only (no open-drain option) -> N-FET makes it open-drain on IRQ.
    # Keep INT1 active-high (default polarity): INT1 high -> IRQ pulled low.
    int1 = Net("ACC_INT1")
    a["INT1"] += int1
    series(int1, GND, R("100k", note="defined gate level"))
    qi = make("AO3400A", ref="Q4", note="LIS2DH12 INT1 -> open-drain IRQ")
    qi["G"] += int1
    qi["S"] += GND
    qi["D"] += n["IRQ"]
    a["INT2"] += NC
    decouple(V3V3, GND, "100n", "10u", note="LIS2DH12")

    # ATECC608B footprint, DNP until the protocol adopts p256 (§10.1)
    se = make("ATECC608B", ref="U13", dnp=not v.secure_element)
    se["VCC"] += V3V3
    se["GND"] += GND
    se["SDA"] += n["I2C_SDA"]
    se["SCL"] += n["I2C_SCL"]
    series(V3V3, GND, C("100n", dnp=not v.secure_element, note="ATECC608B"))

    # MAX17048 fuel gauge (B-option). ALRT on the shared IRQ (open-drain).
    fg = make("MAX17048", ref="U14", dnp=not v.battery)
    fg["VDD"] += VBAT
    fg["CELL"] += VBAT
    fg["GND"] += GND
    fg["EP"] += GND
    fg["CTG"] += GND
    fg["QSTRT"] += GND
    fg["SCL"] += n["I2C_SCL"]
    fg["SDA"] += n["I2C_SDA"]
    fg["ALRT_N"] += n["IRQ"]
    series(VBAT, GND, C("100n", dnp=not v.battery, note="MAX17048 VDD"))


# ---------------------------------------------------------------------------------------------
def radar(v, n, GND, VBUS):
    """HLK-LD2410C on a 5-pin right-angle socket, 5 V switched by P-FET (Lounge). §8"""
    dnp = not v.radar
    vld = Net("VBUS_LD")
    gate = Net("LD_PFET_G")
    qp = make("AO3401A", ref="Q2", dnp=dnp, note="radar 5 V switch")
    qp["S"] += VBUS
    qp["D"] += vld
    qp["G"] += gate
    series(VBUS, gate, R("100k", dnp=dnp))
    # 3.3 V GPIO cannot turn a 5 V P-FET off -> N-FET pulls the gate low when LD_PWR_EN = 1
    qn = make("AO3400A", ref="Q3", dnp=dnp)
    qn["D"] += gate
    qn["S"] += GND
    qn["G"] += n["LD_PWR_EN"]
    j = make("LD2410C-HDR", ref="J5", dnp=dnp, note="HLK-LD2410C plugs in (not soldered)")
    j["VCC"] += vld
    j["GND"] += GND
    series(vld, GND, C("10u", dnp=dnp))
    # 1k series on every IO: the module may be unpowered while the S3 drives its RX
    series(n["LD_TX"], j["RX"], R("1k", dnp=dnp))
    series(j["TX"], n["LD_RX"], R("1k", dnp=dnp))
    series(j["OUT"], n["LD_OUT"], R("1k", dnp=dnp))


# ---------------------------------------------------------------------------------------------
def handset_port(n, GND, VBUS, VSYS, V3V3):
    """USB-C receptacle for an off-the-shelf USB Audio Class handset/headset (owner decision
    2026-09-27; replaces the RJ9 analog handset). The ESP32-S3 native USB OTG is the host
    (GPIO19/20). Source role: Rp 33 k to 3V3 on CC1/CC2 (Default-USB advertisement, 36 k
    nominal -8 %), VBUS through a current-limited switch (SY6280, 6800/15k = 0.45 A) fed from
    VBUS or VSYS (diode-OR, so the handset also works on the B-option battery), GPIO3 enables it
    (off at boot), GPIO4 reads VBUS through 100k/100k (overload shows as a sagging VBUS).
    SRV05-4 at the connector on D+/D-/CC1/CC2."""
    j = make("USB-C", ref="J7", note="handset port (USB host, UAC)")
    hs_vbus = Net("HS_VBUS")
    j["VBUS"] += hs_vbus
    j["GND"] += GND
    j["SHIELD"] += GND
    cc1, cc2 = Net("HS_CC1"), Net("HS_CC2")
    j["CC1"] += cc1
    j["CC2"] += cc2
    j["DP"] += n["HS_USB_DP"]
    j["DN"] += n["HS_USB_DN"]
    series(cc1, V3V3, R("33k", note="Rp Default USB (source)"))
    series(cc2, V3V3, R("33k", note="Rp Default USB (source)"))
    tvs = make("SRV05-4", ref="D7", note="handset port ESD at the connector")
    tvs["IO1"] += n["HS_USB_DP"]
    tvs["IO2"] += n["HS_USB_DN"]
    tvs["IO3"] += cc1
    tvs["IO4"] += cc2
    tvs["REF1"] += GND
    tvs["REF2"] += hs_vbus
    hs_vin = rail("HS_VIN")  # diode-OR supply node
    d = make("B5819W", ref="D8", note="handset supply from VBUS (USB)")
    d["A"] += VBUS
    d["K"] += hs_vin
    d = make("B5819W", ref="D9", note="handset supply from VSYS (battery option)")
    d["A"] += VSYS
    d["K"] += hs_vin
    sw = make("SY6280AAC", ref="U15", note="handset VBUS switch, 0.45 A limit")
    sw["IN"] += hs_vin
    sw["OUT"] += hs_vbus
    sw["GND"] += GND
    sw["EN"] += n["HS_VBUS_EN"]
    series(sw["ISET"], GND, R("15k", note="ILIM = 6800/15k = 0.45 A"))
    decouple(hs_vin, GND, "1u")
    decouple(hs_vbus, GND, "10u", note="handset VBUS bulk")
    series(hs_vbus, n["HS_VBUS_SENSE"], R("100k"))
    series(n["HS_VBUS_SENSE"], GND, R("100k"))
    series(n["HS_VBUS_SENSE"], GND, C("100n"))


def usb_uart(n, GND, V3V3):
    """The native USB PHY now serves the handset port, so the power/programming USB-C port
    gets a CH340C USB-UART bridge to UART0 (GPIO43/44) with the usual DTR/RTS auto-reset
    (two NPNs to EN and GPIO0) for flashing and the console. Powered from 3V3 (V3 = VCC)."""
    u = make("CH340C", ref="U16", note="USB-UART on the power port (flash + console)")
    u["VCC"] += V3V3
    u["V3"] += V3V3
    u["GND"] += GND
    u["UD+"] += n["USB_DP"]
    u["UD-"] += n["USB_DN"]
    u["TXD"] += n["U0RXD"]
    u["RXD"] += n["U0TXD"]
    dtr, rts = Net("UART_DTR"), Net("UART_RTS")
    u["DTR"] += dtr
    u["RTS"] += rts
    for pin in ("CTS", "DSR", "RI", "DCD", "R232", "NC7", "OUT"):
        u[pin] += NC
    decouple(V3V3, GND, "100n", note="CH340C")
    # auto-reset: DTR low & RTS high -> EN low; RTS low & DTR high -> GPIO0 low
    for q_ref, base_sig, emit_sig, target in (("Q5", dtr, rts, n["EN"]),
                                              ("Q6", rts, dtr, n["BOOT"])):
        q = make("MMBT3904", ref=q_ref, note="auto-reset")
        b_ = Net(f"{q_ref}_B")
        series(base_sig, b_, R("10k"))
        q["B"] += b_
        q["E"] += emit_sig
        q["C"] += target


def side_controls(n, GND, V3V3):
    """VOL-, VOL+ (right-angle tacts) and MUTE (right-angle DPDT slide, lever outward) at the
    board's right edge (owner decision 2026-09-27). MUTE pole A breaks the ES7210 mic bias
    (MICBIAS_IN -> MICBIAS_OUT) in hardware; pole B reports to the AW9523B (ui.py).
    SRV05-4 at the switches: they are user-reachable."""
    for name in ("VOL_DN", "VOL_UP"):
        series(n[name], V3V3, R("10k"))
        t = make("SIDE_TACT", note=name)
        t["A"] += n[name]
        t["B"] += GND
        t["MP"] += GND
    series(n["MUTE_SENSE"], V3V3, R("10k"))
    sw = make("SLIDE_DPDT", note="MUTE: pole A breaks mic bias, pole B reports")
    sw["1COM"] += n["MICBIAS_IN"]
    sw["1A"] += n["MICBIAS_OUT"]  # position A = unmuted
    sw["1B"] += NC
    sw["2COM"] += GND
    sw["2A"] += NC
    sw["2B"] += n["MUTE_SENSE"]  # position B = muted -> MUTE_SENSE low
    tvs = make("SRV05-4", note="side-switch ESD at the board edge")
    tvs["IO1"] += n["VOL_DN"]
    tvs["IO2"] += n["VOL_UP"]
    tvs["IO3"] += n["MUTE_SENSE"]
    tvs["IO4"] += NC
    tvs["REF1"] += GND
    tvs["REF2"] += V3V3


def test_points(n, GND, VBUS, VSYS, V3V3, V3V0):
    for net in (VBUS, VSYS, V3V3, V3V0, GND, GND, GND, GND):
        TP(net)
    for name in ("USB_DP", "USB_DN", "U0TXD", "U0RXD", "EN", "BOOT", "I2S_BCLK", "I2S_WS",
                 "I2S_DIN", "I2S_DOUT", "I2C_SDA", "I2C_SCL", "HOOK", "PA_EN"):
        TP(n[name])
    # no test pads on HS_USB_DP/DN: the matched pair is hand-routed on L1 without vias or stubs
    for name in ("SPK_VOP", "SPK_VON", "HS_VBUS"):
        TP(Net.get(name), name)
