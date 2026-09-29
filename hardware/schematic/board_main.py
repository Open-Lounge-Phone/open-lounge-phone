"""The one board (180 x 88 mm, 4 layers). DESIGN.md §3, §4, §5, §8, §9, §11.

Single board (owner decision 2026-09-27): two stacked boards were carried over from the old
long base; one board is cheaper one-off (one fab/assembly setup, no FFC/connectors/standoffs).

H5 (owner decisions 2026-09-30, REQUIREMENTS.md §0 D14-D21): the handset is an ANALOG 3.5 mm
TRRS handset (CTIA) on a jack; the USB host port, its 5 V boost, the handset VBUS switch and
the CH340C are gone, and the power USB-C carries the ESP32's native USB (device mode:
flashing + USB-Serial-JTAG console). No base mic, no speakerphone, no ES7210: the ES8311 records
the handset mic and drives the earpiece; the NS4150B speaker only rings and speaks prompts.

Blocks: USB-C sink + native USB + ESD, BQ24074 power path, 3V3 buck (3.19 V), 3V0 analog LDO,
ESP32-S3 module, ES8311 + NS4150B audio, handset jack (earpiece, mic, button and insertion
sense), the hardware privacy chain (mute switch AND hook sensor -> handset mic supply MIC_VCC
-> two mic lights), DRV5032AJ hook, MAX17048 + 1S battery, LED-data buffer, side controls,
test points, and the UI block (ui.py: 12 hot-swap keys, 13 SK6812MINI-E, AW9523B, e-ink strip,
NFC tag, ambient light, mic lights, recording light).
"""

from __future__ import annotations

import builtins

from skidl import Net

NC = builtins.NC  # SKiDL explicit no-connect net

from config import Variant
from lib import TP, C, NetTie, R, decouple, make, rail, series
from ui import ui


def build(v: Variant) -> None:
    # ---- rails and shared nets -------------------------------------------------------------
    GND = rail("GND")
    VBUS_C = rail("VBUS_C")  # connector side, before the PTC
    VBUS = rail("VBUS")  # after PTC + TVS: BQ24074 IN
    VSYS = rail("VSYS")  # BQ24074 OUT: 4.4 V on USB, = VBAT on battery
    V3V3 = rail("3V3")
    V3V0 = rail("3V0")  # analog: ES8311 AVDD and the handset-mic supply
    VBAT = rail("VBAT")
    n = {name: Net(name) for name in (
        "BOOT", "EN", "CC1", "CC2", "CC1_SENSE", "CC2_SENSE", "HOOK", "HOOK_IN",
        "IRQ", "I2C_SDA", "I2C_SCL", "EPD_CS", "EPD_MOSI", "EPD_SCK", "EPD_DC",
        "EPD_RST", "EPD_BUSY", "I2S_MCLK", "I2S_BCLK", "I2S_WS", "USB_DN", "USB_DP",
        "USB_DN_C", "USB_DP_C", "I2S_DOUT", "I2S_DIN", "PA_EN", "LED_DATA",
        "U0TXD", "U0RXD", "CHG_CE", "CHG_STAT", "PGOOD", "LED_DATA_BUF",
        "MIC_F", "MIC_M", "MIC_VCC", "MIC_SENSE", "JACK_DET", "REC_LED",
        "VOL_DN", "VOL_UP", "MUTE_SENSE", "DAC_OUTP", "DAC_OUTN", "MIC1P", "MIC1N",
    )}

    power(v, n, GND, VBUS_C, VBUS, VSYS, V3V3, V3V0, VBAT)
    mcu(n, GND, V3V3, VSYS)
    audio(n, GND, V3V3, V3V0, VSYS)
    handset_jack(n, GND, V3V3)
    privacy_chain(n, GND, V3V3, V3V0)
    sensors(v, n, GND, V3V3, VBAT)
    side_controls(n, GND, V3V3)
    ui(v, n, GND, V3V3, VSYS)
    test_points(n, GND, VBUS, VSYS, V3V3, V3V0)


# ---------------------------------------------------------------------------------------------
def power(v, n, GND, VBUS_C, VBUS, VSYS, V3V3, V3V0, VBAT):
    # USB-C receptacle: sink-only, separate 5.1k Rd per CC pin (no PD). §9.1. Its D+/D- go
    # straight to the ESP32 native USB (IO19/IO20, device mode: flashing + USB-Serial-JTAG
    # console with any C-to-C or A-to-C cable; owner 2026-09-30, the CH340C is gone).
    j = make("USB-C", ref="J1", note="power + native USB (flash/console)")
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
    # D+/D- to the module (IO19/IO20): 0R placeholders for series termination / CMC in EVT
    series(n["USB_DP_C"], n["USB_DP"], R("0", note="USB D+ series (0R, tune in EVT)"))
    series(n["USB_DN_C"], n["USB_DN"], R("0", note="USB D- series (0R, tune in EVT)"))

    # PTC then TVS. §9.1. 2 A hold (H4 P-07: charger ILIM max 1.56 A)
    f = make("PTC2A", ref="F1")
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
    # (the pack NTC on J2 pin 2 sets TS; with no pack the charger just does not charge)
    decouple(VBUS, GND, "1u")
    # H4 P-08: total VSYS capacitance <= 47 uF (SLUS810N p8): one 10 uF at OUT
    decouple(VSYS, GND, "10u", "100n", note="BQ24074 OUT")
    decouple(VBAT, GND, "4.7u")
    for net, pull in ((n["PGOOD"], "10k"), (n["CHG_STAT"], "10k")):
        series(net, V3V3, R(pull))
    series(n["CHG_CE"], GND, R("10k", note="GPIO45 strap: low = 3.3 V flash, charge enabled"))

    # battery: JST-PH-3 (VBAT, NTC, GND). DESIGN.md said PH-2, which cannot carry the pack NTC
    # to TS - see SCHEMATIC.md deviations.
    jb = make("JST-PH-3", ref="J2", note="LiPo 1S + 10k NTC")
    jb[1] += VBAT
    jb[2] += ts
    jb[3] += GND
    jb["MP"] += GND

    # 3V3 buck (TLV62569): Vout = 0.6 * (1 + 105k/24.3k) = 3.193 V (owner D 2026-09-30, H4 b02
    # P-05): 0.1 % thin film keeps the worst case 3.022-3.287 V, i.e. >= 3.0 V at the module under
    # a 500 mA Wi-Fi step and <= 3.3 V while burning eFuses (ESP32-S3 datasheet v2.2 p64)
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
    series(V3V3, fb, R("105k 0.1%", note="FB top, 0.1 % thin film"))
    series(fb, GND, R("24.3k 0.1%", note="FB bottom, 0.1 % thin film -> 3.19 V"))
    decouple(VSYS, GND, "10u", note="buck input, next to VIN")
    # 22 uF here + 22 uF at the module pin = 44 uF nominal (TI verified range, P-05)
    decouple(V3V3, GND, "22u", note="buck output")

    # 3V0 low-noise analog LDO from VSYS (keeps buck ripple out of codecs / mic bias)
    ldo = make("LP5907-3.0", ref="U4")
    ldo["IN"] += VSYS
    ldo["EN"] += VSYS
    ldo["GND"] += GND
    ldo["OUT"] += V3V0
    ldo["NC"] += NC
    decouple(VSYS, GND, "1u")
    # H4 P-12: no 10 uF on 3V0 (LP5907 C_OUT 0.7-10 uF, SNVS798Q p6): 1 uF here + the codec's
    # 1 uF + 100 nF = 2.1 uF nominal; the mic filter's 10 uF sits behind 100 ohm (privacy_chain)
    decouple(V3V0, GND, "1u", note="LP5907 OUT")


# ---------------------------------------------------------------------------------------------
PIN_TABLE = {
    # GPIO -> net (must match pin_table.yaml; checks.py enforces it). Assignment follows the
    # board geometry (layout/pinswap.py, 2026-09-28); H5 frees IO3/IO9/IO46 and adds the jack
    # sense (IO10 ADC1, IO12) and the recording light (IO13).
    "IO0": "BOOT", "IO1": "I2S_DOUT", "IO2": "I2S_WS", "IO4": "I2S_DIN",
    "IO5": "IRQ", "IO6": "CC2_SENSE", "IO7": "I2C_SCL", "IO8": "CC1_SENSE",
    "IO10": "MIC_SENSE", "IO11": "I2S_MCLK", "IO12": "JACK_DET", "IO13": "REC_LED",
    "IO14": "I2S_BCLK", "IO15": "I2C_SDA", "IO16": "PGOOD", "IO17": "HOOK_IN", "IO18": "CHG_STAT",
    "IO19": "USB_DN", "IO20": "USB_DP",
    "IO21": "LED_DATA", "IO38": "PA_EN", "IO39": "EPD_BUSY", "IO40": "EPD_RST", "IO41": "EPD_CS",
    "IO42": "EPD_SCK", "IO45": "CHG_CE", "IO47": "EPD_MOSI", "IO48": "EPD_DC", "RXD0": "U0RXD",
    "TXD0": "U0TXD",
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
    # default-off pulls (§5)
    series(n["PA_EN"], GND, R("100k", note="GPIO38: amp off at boot (no pop)"))
    # shared I2C pull-ups (4.7k) and shared open-drain IRQ pull-up (10k)
    series(n["I2C_SDA"], V3V3, R("4.7k"))
    series(n["I2C_SCL"], V3V3, R("4.7k"))
    series(n["IRQ"], V3V3, R("10k"))
    # LED data: 3.3 V GPIO21 -> SN74LV1T125 on VSYS -> 330R -> LED chain (SK6812 VIH = 0.7*VDD)
    buf = make("SN74LV1T125", ref="U5")
    buf["VCC"] += VSYS
    buf["GND"] += GND
    buf["OE_N"] += GND
    buf["A"] += n["LED_DATA"]
    series(n["LED_DATA"], GND, R("100k", note="GPIO21 floats at reset: keep LED data low"))
    series(buf["Y"], n["LED_DATA_BUF"],
           R("330", note="LED data series: limits back-feed (<12 mA) into an unpowered chain"))
    decouple(VSYS, GND, "100n", note="SN74LV1T125")


# ---------------------------------------------------------------------------------------------
def audio(n, GND, V3V3, V3V0, VSYS):
    """ES8311 (U6): ADC = handset mic (handset_jack), DAC = earpiece + speaker amp input.
    No base mic, no speakerphone, no ES7210, no analog AEC reference (owner 2026-09-30): with a
    handset only, the acoustic echo is the handset's own receiver-to-mic coupling; if EVT finds
    it too high, firmware AEC uses the playback stream as the reference (same I2S clock as the
    ADC, so it is sample-synchronous)."""
    dac = make("ES8311", ref="U6")
    dac["MCLK"] += n["I2S_MCLK"]
    dac["SCLK"] += n["I2S_BCLK"]
    dac["LRCK"] += n["I2S_WS"]
    dac["DSDIN"] += n["I2S_DOUT"]
    series(dac["ASDOUT"], n["I2S_DIN"], R("47", note="ADC data series (Korvo: 51R)"))
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
    OUTP, OUTN = n["DAC_OUTP"], n["DAC_OUTN"]
    dac["OUTP"] += OUTP
    dac["OUTN"] += OUTN
    # handset mic into MIC1P/MIC1N (pseudo-differential; MIC1N picks up the jack ground)
    dac["MIC1P"] += n["MIC1P"]
    dac["MIC1N"] += n["MIC1N"]

    # ---- NS4150B speaker amp on VSYS: ringer + voice prompts only. R_IN 68k -> A_V 3.5 so the
    # DAC full scale reaches the 1 W firmware cap (H4 b06 P-10: 77 dBA at 1 m, worst unit) ----
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
        series(mid, pa[pin], R("68k", note="R_IN: gain 240k/68k = 3.5 (H4 b06)"))
    # H4 P-08: 22 uF 0805/25 V bulk (was 100 uF 1206) + 1 uF at VCC (NS4150B p7 asks 1 uF)
    decouple(VSYS, GND, "22u", "1u", "100n", note="NS4150B supply, at pin 6")
    spk = make("JST-PH-2", ref="J4", note="speaker 8 ohm 1 W, 20 x 40 mm (Soberton SP-2040)")
    spk["MP"] += GND
    for pin, jpin in (("VOP", 1), ("VON", 2)):
        o = Net(f"SPK_{pin}")
        fb = make("FB220_2A", note="speaker EMI; 2 A rated (1 W into 8 ohm = 0.35 A rms)")
        fb[1] += pa[pin]
        fb[2] += o
        series(o, GND, C("220p", note="EMI"))
        spk[jpin] += o


# ---------------------------------------------------------------------------------------------
def handset_jack(n, GND, V3V3):
    """3.5 mm TRRS handset jack J7 (owner decision 2026-09-30, supersedes the USB-C handset port):
    an off-the-shelf analog handset (e.g. the Opis 60s Micro) plugs straight in. CTIA wiring:
    T = left, R1 = right (both carry the earpiece), R2 = GND, S = mic.

    Earpiece: ES8311 OUTP (single-ended; the ES8311 drives 16/32 ohm headphone loads, User Guide
    rev 1.11 p2) -> TS5A3166 switch (on only OFF-HOOK: IN = HOOK, so the ringer never plays in
    the earpiece and the receiver is disconnected on-hook) -> 2 x 22 uF -> 22 ohm per contact.
    22k across the switch keeps the coupling caps at VMID (no pop when the switch closes).
    Mic: MIC_VCC (privacy_chain) -> 2.2k -> S; 1 uF into MIC1P, MIC1N via 1 uF to the jack
    ground. Button (S shorted to GND) and plug type are read on IO10 (ADC1) through a diode
    that cannot pass current INTO the mic line, so no GPIO can power the mic. Insertion: TN
    (NC contact on the tip spring) opens when a plug is in -> JACK_DET high (IO12)."""
    j = make("JACK_TRRS", ref="J7", note="handset jack, bottom side, rear edge (CTIA)")
    hs_t, hs_r1, hs_mic, hs_det = Net("HS_T"), Net("HS_R1"), Net("HS_MIC"), Net("HS_DET")
    hs_gnd = Net("HS_GND")
    j["T"] += hs_t
    j["R1"] += hs_r1
    j["R2"] += hs_gnd
    j["S"] += hs_mic
    j["TN"] += hs_det
    j["R1N"] += NC
    NetTie(hs_gnd, GND, note="handset ground: single point at the jack")

    # ESD at the connector: bidirectional (the AC-coupled earpiece swings below GND)
    for ref, a, b in (("D7", hs_t, hs_r1), ("D8", hs_mic, hs_det)):
        d = make("PESD5V0S2BT", ref=ref, note="jack ESD at the connector")
        d["K1"] += a
        d["K2"] += b
        d["K"] += GND

    # ---- earpiece ----
    sw = make("TS5A3166", ref="U8", note="earpiece on only off-hook (IN = HOOK)")
    ear_sw, ear_ac = Net("EAR_SW"), Net("EAR_AC")
    sw["COM"] += n["DAC_OUTP"]
    sw["NO"] += ear_sw
    sw["IN"] += n["HOOK"]
    sw["VCC"] += V3V3
    sw["GND"] += GND
    decouple(V3V3, GND, "100n", note="TS5A3166")
    series(n["DAC_OUTP"], ear_sw,
           R("22k", note="keeps the coupling caps at VMID (no pop); on-hook leak -52 dB (b04)"))
    for _ in range(2):
        series(ear_sw, ear_ac, C("22u", note="earpiece coupling, 2 x 22 uF: 86 Hz into 32+22 ohm"))
    for line in (hs_t, hs_r1):
        series(ear_ac, line, R("22", note="earpiece series: short/insertion protection, RF"))
        series(line, GND, C("100p", note="RF shunt at the jack"))
    series(hs_t, GND, R("10k", note="tip DC reference: TN reads low with no plug"))

    # ---- mic ----
    mic_f = Net("HS_MIC_F")
    fb = make("FB220_2A", note="mic line RF bead (Wi-Fi buzz)")
    fb[1] += hs_mic
    fb[2] += mic_f
    series(mic_f, GND, C("100p", note="RF shunt after the bead"))
    series(n["MIC_VCC"], mic_f, R("2.2k", note="electret bias (typical handset capsule)"))
    series(mic_f, n["MIC1P"], C("1u", note="mic AC coupling into MIC1P"))
    series(hs_gnd, n["MIC1N"], C("1u", note="MIC1N: jack ground reference"))
    # sense: diode anode on the mic line -> 100k -> IO10 (ADC1), 1M + 10n to GND. A GPIO driven
    # high reverse-biases the diode: it cannot bias (power) the capsule.
    sd = Net("MIC_SENSE_D")
    d = make("1N4148W", ref="D9", note="mic-line sense: one-way (mic line -> ADC only)")
    d["A"] += mic_f
    d["K"] += sd
    series(sd, n["MIC_SENSE"], R("100k", note="isolates the ADC pin from the mic line"))
    series(n["MIC_SENSE"], GND, R("1M"))
    series(n["MIC_SENSE"], GND, C("10n", note="ADC sample reservoir"))

    # ---- insertion detect ----
    series(hs_det, V3V3, R("1M", note="TN pull-up: 33 mV on the tip with no plug (no click)"))
    series(hs_det, n["JACK_DET"], R("1k", note="GPIO12 series (user-reachable line)"))


def privacy_chain(n, GND, V3V3, V3V0):
    """Handset-mic supply with the hardware privacy guarantee (owner 2026-09-30, HW-PRIV-01..03):
    3V0 -> 100R/10uF filter -> MUTE pole A -> P-FET (on only when the hook sensor says off-hook)
    -> MIC_VCC -> two mic lights in parallel (H4 b05 fallback) + the 2.2k electret bias.
    MIC_VCC exists only when MUTE is off AND the handset is off the hook; the lights hang on
    MIC_VCC, so the mic cannot be powered with the lights off (a single open LED leaves the
    other lit). No firmware-controlled net can drive MIC_VCC: the ESP32 reads HOOK through 47k
    (it can pull HOOK low = mic off, never lift it against the sensor), and reads the mic line
    only through the one-way diode D9. checks.check_privacy proves this on the netlist."""
    series(V3V0, n["MIC_F"], R("100", note="mic supply RC filter (before the switches)"))
    series(n["MIC_F"], GND, C("10u", note="mic supply RC filter"))
    # MUTE pole A (side_controls) connects MIC_F -> MIC_M when unmuted
    qp = make("AO3401A", ref="Q5", note="handset-mic supply switch: on only off-hook")
    g = Net("MIC_SW_G")
    qp["S"] += n["MIC_M"]
    qp["D"] += n["MIC_VCC"]
    qp["G"] += g
    series(n["MIC_M"], g, R("100k", note="P-FET off unless the hook N-FET pulls the gate"))
    qn = make("AO3400A", ref="Q6", note="HOOK high (off-hook) -> mic supply on")
    qn["G"] += n["HOOK"]
    qn["S"] += GND
    qn["D"] += g
    series(n["MIC_VCC"], GND, C("100n", note="MIC_VCC (nothing bigger: dark = dead fast)"))


# ---------------------------------------------------------------------------------------------
def sensors(v, n, GND, V3V3, VBAT):
    # DRV5032AJ omnipolar Hall hook switch, open-drain: low = magnet = on-hook (H4 P-06).
    # 100 ohm + 1 nF at U10 against ESD from the metal hook post above it (BR-ESD-05); 100k
    # pull-up makes HOOK high off-hook. HOOK drives the mic-supply switch and the earpiece switch;
    # the ESP32 reads it on IO17 through 47k (it can never hold HOOK high against the sensor).
    h = make("DRV5032AJ", ref="U10", note="under the right hook post (boards.yaml hook_post_x)")
    h["VCC"] += V3V3
    h["GND"] += GND
    decouple(V3V3, GND, "100n", note="DRV5032")
    series(h["OUT"], n["HOOK"], R("100", note="ESD/EMC series from the hook-post area"))
    series(n["HOOK"], GND, C("1n", note="ESD/EMC RC"))
    series(n["HOOK"], V3V3, R("100k", note="open-drain pull-up: high = off-hook"))
    series(n["HOOK"], n["HOOK_IN"], R("47k", note="GPIO17 read-only in effect (privacy)"))
    if v.ir_hook:
        raise ValueError("the IR hook option was removed (owner audit 2026-09-28)")

    # MAX17048 fuel gauge. ALRT on the shared IRQ (open-drain).
    fg = make("MAX17048", ref="U14")
    fg["VDD"] += VBAT
    fg["CELL"] += VBAT
    fg["GND"] += GND
    fg["EP"] += GND
    fg["CTG"] += GND
    fg["QSTRT"] += GND
    fg["SCL"] += n["I2C_SCL"]
    fg["SDA"] += n["I2C_SDA"]
    fg["ALRT_N"] += n["IRQ"]
    series(VBAT, GND, C("100n", note="MAX17048 VDD"))


def side_controls(n, GND, V3V3):
    """VOL-, VOL+ (right-angle tacts) and MUTE (right-angle DPDT slide, lever outward) at the
    board's right edge (owner decision 2026-09-27). MUTE pole A breaks the handset-mic supply
    (MIC_F -> MIC_M) in hardware; pole B reports to the AW9523B (ui.py).
    SRV05-4 at the switches: they are user-reachable."""
    for name in ("VOL_DN", "VOL_UP"):
        series(n[name], V3V3, R("10k"))
        t = make("SIDE_TACT", note=name)
        t["A"] += n[name]
        t["B"] += GND
        t["MP"] += GND
    series(n["MUTE_SENSE"], V3V3, R("10k"))
    sw = make("SLIDE_DPDT", note="MUTE: pole A breaks the handset-mic supply, pole B reports")
    sw["1COM"] += n["MIC_F"]
    sw["1A"] += n["MIC_M"]  # position A = unmuted
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
    """Essential pads only (owner audit 2026-09-28): rails, GND, UART + EN/BOOT for
    recovery (flashing is over the power USB-C). MIC_VCC added in H5 (BR-TP-01): the production
    test checks mic light = mic power."""
    for net in (VBUS, VSYS, V3V3, V3V0, GND, GND):
        TP(net)
    for name in ("U0TXD", "U0RXD", "EN", "BOOT", "MIC_VCC"):
        TP(n[name])
