"""Part library of the minimal board (M1, owner decision 2026-09-30): pin maps, footprints,
sourcing and the datasheet page each choice rests on.

Pin maps were checked against the cited datasheet unless ``verified`` says otherwise.
LCSC codes are checked against lcsc.com / JLCPCB by ``lcsc.py`` (MPN must match; cache in
lcsc_cache.json). Footprints are checked against the official KiCad library by ``fpcheck.py``;
names in the ``OpenLoungePhone:`` library are drawn by layout/footprints/gen_footprints.py.
Passives (R, C) come from lib.py (JLC basic codes).
"""

from __future__ import annotations

from lib import SPECS, spec

# ---------------------------------------------------------------------------------------------
# MCU. WROOM-1U (U.FL + a general-purpose 2.4 GHz antenna, user-upgradable; owner 2026-09-30):
# no board-edge antenna keep-out, so placement is free.
# Datasheet v1.8: pinout p9-11; strapping pins GPIO0/3/45/46 p13-15 (GPIO0 weak pull-up,
# GPIO45/46 weak pull-down, GPIO3 floating and only read if EFUSE_STRAP_JTAG_SEL is burned);
# VDD33 3.0-3.6 V and a supply able to deliver >= 0.5 A p27; Wi-Fi TX peak 355 mA p28;
# peripheral schematic (22 uF + 0.1 uF at 3V3, EN RC 10 k / 1 uF) p41.

spec(
    "ESP32-S3-WROOM-1U", ref="U", mpn="ESP32-S3-WROOM-1U-N16R8", manufacturer="Espressif",
    lcsc="C3013946", footprint="RF_Module:ESP32-S3-WROOM-1U",
    desc="ESP32-S3 module, 16 MB flash, 8 MB octal PSRAM, U.FL for an external 2.4 GHz antenna",
    datasheet="https://www.espressif.com/sites/default/files/documentation/esp32-s3-wroom-1_wroom-1u_datasheet_en.pdf",
    pins=[
        (1, "GND", "pwr_in"), (2, "3V3", "pwr_in"), (3, "EN", "in"),
        (4, "IO4", "io"), (5, "IO5", "io"), (6, "IO6", "io"), (7, "IO7", "io"),
        (8, "IO15", "io"), (9, "IO16", "io"), (10, "IO17", "io"), (11, "IO18", "io"),
        (12, "IO8", "io"), (13, "IO19", "io"), (14, "IO20", "io"), (15, "IO3", "io"),
        (16, "IO46", "io"), (17, "IO9", "io"), (18, "IO10", "io"), (19, "IO11", "io"),
        (20, "IO12", "io"), (21, "IO13", "io"), (22, "IO14", "io"), (23, "IO21", "io"),
        (24, "IO47", "io"), (25, "IO48", "io"), (26, "IO45", "io"), (27, "IO0", "io"),
        (28, "IO35", "io"), (29, "IO36", "io"), (30, "IO37", "io"), (31, "IO38", "io"),
        (32, "IO39", "io"), (33, "IO40", "io"), (34, "IO41", "io"), (35, "IO42", "io"),
        (36, "RXD0", "io"), (37, "TXD0", "io"), (38, "IO2", "io"), (39, "IO1", "io"),
        (40, "GND", "pwr_in"), (41, "GND", "pwr_in"),
    ],
)

# ---------------------------------------------------------------------------------------------
# Power: USB-C (power + native USB), one USB ESD part, one 3.3 V LDO

spec(
    "USB-C", ref="J", mpn="TYPE-C-31-M-12", manufacturer="HRO (Korean Hroparts)", lcsc="C165948",
    footprint="Connector_USB:USB_C_Receptacle_HRO_TYPE-C-31-M-12",
    desc="USB-C 16P receptacle (USB 2.0): 5 V power sink + ESP32 native USB (flashing, console)",
    datasheet="https://datasheet.lcsc.com/datasheet/pdf/9e56b777c022540fcce7c7f67825f55e.pdf",
    pins=[
        ("A1", "GND", "pwr_in"), ("A4", "VBUS", "pas"), ("A5", "CC1", "pas"),
        ("A6", "DP", "pas"), ("A7", "DN", "pas"), ("A8", "SBU1", "nc"), ("A9", "VBUS", "pas"),
        ("A12", "GND", "pwr_in"), ("B1", "GND", "pwr_in"), ("B4", "VBUS", "pas"),
        ("B5", "CC2", "pas"), ("B6", "DP", "pas"), ("B7", "DN", "pas"), ("B8", "SBU2", "nc"),
        ("B9", "VBUS", "pas"), ("B12", "GND", "pwr_in"), ("SH", "SHIELD", "pas"),
    ],
)

spec(
    # ST USBLC6-2 datasheet: pinout and 3.5 pF max line capacitance p1 (1 I/O1, 2 GND, 3 I/O2,
    # 4 I/O2, 5 VBUS, 6 I/O1; each line passes straight through its pin pair), 5 V standoff p2
    "USBLC6-2SC6", ref="D", mpn="USBLC6-2SC6", manufacturer="STMicroelectronics", lcsc="C7519",
    footprint="Package_TO_SOT_SMD:SOT-23-6", desc="2-line low-capacitance USB ESD protection",
    datasheet="https://www.st.com/resource/en/datasheet/usblc6-2.pdf",
    pins=[(1, "IO1", "pas"), (2, "GND", "pas"), (3, "IO2", "pas"), (4, "IO2", "pas"),
          (5, "VBUS", "pas"), (6, "IO1", "pas")],
)

spec(
    # SG Micro SGM2212 rev A.2 (July 2023): 800 mA p1; SOT-223-3 pinout 1 GND, 2 VOUT, 3 VIN,
    # tab = VOUT p4; dropout (3.3 V) 380 mV max at 500 mA, 610 mV max at 800 mA, current limit
    # >= 810 mA p6; theta_JA 117 C/W (SOT-223-3) p3; ceramic-stable, C_OUT >= 1 uF effective,
    # 2.2 uF typical, larger helps the load transient p10; load transient 0 -> 800 mA with
    # Chosen over the JLC-basic AMS1117-3.3 (C6186): that one needs a 22 uF TANTALUM output cap
    # for stability (AMS DS1117 p4) - an extended part either way - and drops 1.1-1.3 V.
    "SGM2212-3.3", ref="U", mpn="SGM2212-3.3XKC3G/TR", manufacturer="SG Micro", lcsc="C3294699",
    footprint="Package_TO_SOT_SMD:SOT-223-3_TabPin2",
    desc="800 mA low-dropout 3.3 V regulator (ceramic-stable), SOT-223",
    datasheet="https://datasheet.lcsc.com/datasheet/pdf/6f07bb879ae0c9e810e5cf5bf8b1cedc.pdf",
    pins=[(1, "GND", "pwr_in"), (2, "VOUT", "pwr_out"), (3, "VIN", "pwr_in")],
)

# ---------------------------------------------------------------------------------------------
# Audio: ES8311 codec + 3.5 mm TRRS handset jack

spec(
    # Everest ES8311 datasheet rev 7.0 (Jan 2020): pin list p3, typical application circuit p4
    # (1 uF AVDD, 0.1 uF DVDD/PVDD, 1 uF on VMID/ADCVREF/DACVREF, 1 uF MIC1P/MIC1N coupling),
    # supplies 1.7-3.6 V p8, full-scale in/out AVDD/3.3 Vrms p8-9. CE low -> I2C 0x18.
    "ES8311", ref="U", mpn="ES8311", manufacturer="Everest Semiconductor", lcsc="C962342",
    footprint="Package_DFN_QFN:QFN-20-1EP_3x3mm_P0.4mm_EP1.65x1.65mm",
    desc="Mono audio codec: ADC = handset mic (MIC1P/N), DAC = earpiece (HP driver); I2C 0x18",
    datasheet="https://datasheet.lcsc.com/datasheet/pdf/333c4745650c47b22df304e43da4c3e5.pdf",
    i2c={"I2C": 0x18}, i2c_straps=[("CE", 0)],
    pins=[
        (1, "CCLK", "in"), (2, "MCLK", "in"), (3, "PVDD", "pwr_in"), (4, "DVDD", "pwr_in"),
        (5, "DGND", "pwr_in"), (6, "SCLK", "in"), (7, "ASDOUT", "out"), (8, "LRCK", "in"),
        (9, "DSDIN", "in"), (10, "AGND", "pwr_in"), (11, "AVDD", "pwr_in"), (12, "OUTP", "out"),
        (13, "OUTN", "out"), (14, "DACVREF", "pas"), (15, "ADCVREF", "pas"), (16, "VMID", "pas"),
        (17, "MIC1N", "in"), (18, "MIC1P", "in"), (19, "CDATA", "io"), (20, "CE", "in"),
        (21, "EP", "pwr_in"),
    ],
)

spec(
    # 3.5 mm TRRS, CTIA (T = left, R1 = right, R2 = GND, S = mic). TN is the normally-closed
    # contact on the tip spring: it opens when a plug is in (free insertion detect).
    "JACK_TRRS", ref="J", mpn="PJ-31060", manufacturer="HOOYA (Haoyu)", lcsc="C2939583",
    footprint="Connector_Audio:Jack_3.5mm_PJ31060-I_Horizontal",
    desc="3.5 mm TRRS jack, SMD, tip/ring1 normally-closed detect contacts; handset (CTIA)",
    datasheet="https://datasheet.lcsc.com/datasheet/pdf/7dc9ea9e7b9d02a0df1c6839d34c2747.pdf",
    verified="HOOYA drawing (rev A2, 2021-11-04, p1) numbers terminals 1-6 on the same grid as "
             "KiCad's PJ31060-I footprint; the mapping of HOOYA 1-6 to KiCad's T/TN/R1/R1N/R2/S "
             "pads is to be confirmed on a sample before layout freeze (M2)",
    pins=[("T", "T", "pas"), ("TN", "TN", "pas"), ("R1", "R1", "pas"), ("R1N", "R1N", "pas"),
          ("R2", "R2", "pas"), ("S", "S", "pas")],
)

# ---------------------------------------------------------------------------------------------
# User interface: keys, hook, display header, ringer, status LED, service buttons

spec(
    # Kailh CPG151101S11 land (HanElectricity -2: same body/holes/land, tin plating; drawing p1).
    # Used for the 12 keys AND the hook switch (an MX switch under the hook plunger).
    "HOTSWAP", ref="SW", mpn="CPG151101S11-2", manufacturer="HanElectricity", lcsc="C49352235",
    footprint="OpenLoungePhone:Kailh_MX_Hotswap_CPG151101S11",
    desc="MX hot-swap socket (Kailh CPG151101S11 land; an MX switch plugs in)",
    datasheet="https://datasheet.lcsc.com/datasheet/pdf/1ee2260e25d7adfa886a86560701dea9.pdf",
    pins=[(1, "1", "pas"), (2, "2", "pas")],
)

spec(
    # 2x4 2.54 mm female socket: the WeAct Studio 2.9" e-Paper module (the standard display,
    # owner M2 2026-09-30) plugs straight in with its 2x4 header, pin order from its drawing and
    # schematic (WeActStudio.EpaperModule, Hardware/, P1): 1 BUSY, 2 RES, 3 D/C, 4 CS, 5 SCL
    # (CLK), 6 SDA (DIN), 7 GND, 8 VDD (3.3-5 V; its own LDO). Two M3 standoffs at the far end
    # hold the module (H5, H6). Other modules (Waveshare, OLED, TFT) use female-male jumpers.
    "DISPLAY_HDR", ref="J", mpn="HX PM2.54-2x4P ZC", manufacturer="HX (Hanxia)", lcsc="C32713305",
    footprint="Connector_PinSocket_2.54mm:PinSocket_2x04_P2.54mm_Vertical",
    desc="2x4 2.54 mm female socket: WeAct 2.9\" e-Paper module (BUSY RES DC CS CLK DIN GND VCC)",
    datasheet="https://datasheet.lcsc.com/datasheet/pdf/482b54eeb534f75792299da9df2c4b10.pdf",
    verified="WeAct drawing and schematic give the header order; which end of the module's 2x4 "
             "header is pin 1 (as seen from the panel side) is to be confirmed on a sample",
    pins=[(1, "BUSY", "pas"), (2, "RST", "pas"), (3, "DC", "pas"), (4, "CS", "pas"),
          (5, "CLK", "pas"), (6, "DIN", "pas"), (7, "GND", "pas"), (8, "VCC", "pas")],
)

spec(
    # TDK PS series (Feb 2022): external-drive piezo, recommended circuit p2 = transistor
    # low side with ~1 kOhm across the element (charge/discharge); PS1240P02BT 4 kHz, 12.2 mm
    "PIEZO", ref="BZ", mpn="PS1240P02BT", manufacturer="TDK", lcsc="C76871",
    footprint="Buzzer_Beeper:Buzzer_TDK_PS1240P02BT_D12.2mm_H6.5mm",
    desc="Piezo buzzer, external drive, 12.2 mm, 4 kHz (ringer)",
    datasheet="https://datasheet.lcsc.com/datasheet/pdf/b82b1254cb55646d45aaa9841e8f9db1.pdf",
    pins=[(1, "1", "pas"), (2, "2", "pas")],
)

spec(
    # JSCJ MMBT3904 rev 2.1 p1: 1 base, 2 emitter, 3 collector; 40 V, 200 mA
    "MMBT3904", ref="Q", mpn="MMBT3904", manufacturer="JSCJ", lcsc="C20526",
    footprint="Package_TO_SOT_SMD:SOT-23", desc="NPN 40 V 200 mA (buzzer driver)",
    datasheet="https://datasheet.lcsc.com/datasheet/pdf/9335632bcfa83df8351353eab379720e.pdf",
    pins=[(1, "B", "pas"), (2, "E", "pas"), (3, "C", "pas")],
)

spec(
    # Lite-On LTST-C230KRKT: 1206 REVERSE-MOUNT red LED (p1): soldered on the bottom side like
    # every SMD part, it shines up through the footprint's 1.8 x 2.4 mm board cut-out to the lid
    # light hole. p1 marks the cathode end; KiCad's reverse-mount footprint has pad 1 = K.
    # Vf 2.0 V typ at 20 mA (p3): ~1.5 mA through 1 k from 3V3.
    "LED_RED", ref="D", mpn="LTST-C230KRKT", manufacturer="Lite-On", lcsc="C125107",
    footprint="LED_SMD:LED_1206_3216Metric_ReverseMount_Hole1.8x2.4mm",
    desc="Red LED 1206 reverse mount (status, seen through a board hole)",
    datasheet="https://datasheet.lcsc.com/datasheet/pdf/cf37e35ae11a8ff066e5cc002dd1bf84.pdf",
    pins=[(1, "K", "pas"), (2, "A", "pas")],
)

spec(
    "TACT", ref="SW", mpn="TS-1187A-B-A-B", manufacturer="XKB", lcsc="C318884",
    footprint="Button_Switch_SMD:SW_Push_1P1T_XKB_TS-1187A",
    desc="Tactile switch 5.1x5.1 mm (RESET, BOOT)",
    datasheet="https://datasheet.lcsc.com/datasheet/pdf/56c8799ae5193945a16a1ffbe378246a.pdf",
    pins=[(1, "A", "pas"), (2, "B", "pas")],
)


def all_lcsc_codes() -> set[str]:
    """Every LCSC code the design uses (for `make lcsc`)."""
    import builtins

    import board_main
    from config import DESIGN

    board_main.build(DESIGN)
    return {p.fields.get("LCSC") for p in builtins.default_circuit.parts
            if p.fields.get("LCSC")} | {s.lcsc for s in SPECS.values() if s.lcsc}
