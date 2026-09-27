"""Part library: pin maps, footprints and sourcing for every non-passive part.

Pin maps were checked against the cited datasheet unless ``verified`` says otherwise.
LCSC codes are checked against lcsc.com by ``lcsc.py`` (MPN must match; see lcsc_cache.json).
Footprints are checked against the official KiCad library by ``fpcheck.py``; names in the
``OpenTinCan:`` library still have to be drawn.
"""

from __future__ import annotations

from lib import CAP_EXTRA, RES_EXTRA, SPECS, spec

# ---------------------------------------------------------------------------------------------
# MCU

spec(
    "ESP32-S3-WROOM-1", ref="U", mpn="ESP32-S3-WROOM-1-N16R8", manufacturer="Espressif",
    lcsc="C2913202", footprint="RF_Module:ESP32-S3-WROOM-1",
    desc="ESP32-S3 module, 16 MB flash, 8 MB octal PSRAM, PCB antenna",
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
# Audio

spec(
    "ES8311", ref="U", mpn="ES8311", manufacturer="Everest Semiconductor", lcsc="C962342",
    footprint="Package_DFN_QFN:QFN-20-1EP_3x3mm_P0.4mm_EP1.65x1.65mm",
    desc="Mono audio codec (DAC drives 16/32 ohm earpiece differentially); I2C 0x18 (CE=0)",
    datasheet="https://dl.espressif.com/dl/schematics/Audio_ES8311.pdf",
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
    "ES7210", ref="U", mpn="ES7210", manufacturer="Everest Semiconductor", lcsc="C365743",
    footprint="Package_DFN_QFN:QFN-32-1EP_4x4mm_P0.4mm_EP2.65x2.65mm",
    desc="4-ch audio ADC, TDM out; CH1 handset mic, CH2 base mic, CH3 AEC reference; I2C 0x40",
    datasheet="https://e2e.ti.com/cfs-file/__key/communityserver-discussions-components-files/6/7563.ES7210.pdf",
    verified="pins 3/4 (CDATA/CCLK) follow the datasheet pinout drawing and Korvo-2 schematic; the "
             "datasheet pin table lists them swapped",
    i2c={"I2C": 0x40}, i2c_straps=[("AD0", 0), ("AD1", 1)],
    pins=[
        (1, "AD0", "in"), (2, "AD1", "in"), (3, "CDATA", "io"), (4, "CCLK", "in"),
        (5, "MCLK", "in"), (6, "VDDP", "pwr_in"), (7, "VDDD", "pwr_in"), (8, "GNDD", "pwr_in"),
        (9, "SCLK", "in"), (10, "LRCK", "in"), (11, "SDOUT1", "out"), (12, "SDOUT2", "io"),
        (13, "INT", "out"), (14, "DMIC_CLK", "out"), (15, "MIC1N", "in"), (16, "MIC1P", "in"),
        (17, "REFP12", "pas"), (18, "REFQ12", "pas"), (19, "MIC2P", "in"), (20, "MIC2N", "in"),
        (21, "GNDA", "pwr_in"), (22, "VDDA", "pwr_in"), (23, "VDDM", "pwr_in"),
        (24, "MICBIAS12", "pwr_out"), (25, "REFQM", "pas"), (26, "MICBIAS34", "pwr_out"),
        (27, "MIC4N", "in"), (28, "MIC4P", "in"), (29, "REFP34", "pas"), (30, "REFQ34", "pas"),
        (31, "MIC3P", "in"), (32, "MIC3N", "in"), (33, "EP", "pwr_in"),
    ],
)

spec(
    "NS4150B", ref="U", mpn="NS4150B", manufacturer="Nsiway", lcsc="C189961",
    footprint="Package_SO:MSOP-8_3x3mm_P0.65mm",
    desc="3 W class-D mono speaker amp; gain = 240k/Rin; CTRL high = on",
    datasheet="https://wmsc.lcsc.com/wmsc/upload/file/pdf/v2/lcsc/2209161630_Shenzhen-Nsiway-Tech-NS4150B_C189961.pdf",
    pins=[
        (1, "CTRL", "in"), (2, "BYPASS", "pas"), (3, "INP", "in"), (4, "INN", "in"),
        (5, "VON", "out"), (6, "VCC", "pwr_in"), (7, "GND", "pwr_in"), (8, "VOP", "out"),
    ],
)

spec(
    "TS5A3166", ref="U", mpn="TS5A3166DCKR", manufacturer="Texas Instruments", lcsc="C133819",
    footprint="Package_TO_SOT_SMD:SOT-353_SC-70-5",
    desc="SPST analog switch, 0.9 ohm, normally open (IN high = on); EAR_EN",
    datasheet="https://www.ti.com/lit/ds/symlink/ts5a3166.pdf",
    pins=[(1, "NO", "pas"), (2, "COM", "pas"), (3, "GND", "pwr_in"), (4, "IN", "in"),
          (5, "VCC", "pwr_in")],
)

spec(
    "SRV05-4", ref="D", mpn="SRV05-4.TCT", manufacturer="Semtech", lcsc="C13612",
    footprint="Package_TO_SOT_SMD:SOT-23-6",
    desc="4-line ESD array (REF1=GND, REF2=VCC or float)",
    datasheet="https://www.semtech.com/products/circuit-protection/low-capacitance/srv05-4",
    pins=[(1, "IO1", "pas"), (2, "REF1", "pas"), (3, "IO2", "pas"), (4, "IO3", "pas"),
          (5, "REF2", "pas"), (6, "IO4", "pas")],
)

spec(
    "RJ9", ref="J", mpn="5301-4P4C", manufacturer="EVERCOM", lcsc="C3097715",
    footprint="OpenTinCan:RJ9_4P4C_EVERCOM_5301-4P4C",
    desc="4P4C handset jack, right-angle THT",
    verified="pin order and body width not checked (datasheet not reachable); the 4 solder "
             "jumpers cover either pair assignment",
    pins=[(1, "1", "pas"), (2, "2", "pas"), (3, "3", "pas"), (4, "4", "pas")],
)

spec(
    "ELECTRET", ref="MK", mpn="GMI6027-2C42DB", manufacturer="INGHAi", lcsc="C233885",
    footprint="OpenTinCan:Electret_6mm_SMD_pads",
    desc="6 mm electret capsule, -42 dB, 2.2k load (base speakerphone mic, in rubber boot)",
    verified="ground (can) pad identification not checked against drawing",
    pins=[(1, "OUT", "pas"), (2, "GND", "pas")],
)

spec(
    "FB600", ref="FB", mpn="BLM15AG601SN1D", manufacturer="Murata", lcsc="C76884",
    footprint="Inductor_SMD:L_0402_1005Metric", desc="Ferrite bead 600R@100MHz 300mA 0402",
    datasheet="https://www.murata.com/en-us/products/productdetail?partno=BLM15AG601SN1D",
    pins=[(1, "1", "pas"), (2, "2", "pas")],
)


# ---------------------------------------------------------------------------------------------
# Power

spec(
    "USB-C", ref="J", mpn="TYPE-C-31-M-12", manufacturer="HRO (Korean Hroparts)", lcsc="C165948",
    footprint="Connector_USB:USB_C_Receptacle_HRO_TYPE-C-31-M-12",
    desc="USB-C 16P receptacle (USB 2.0), sink only",
    datasheet="https://www.lcsc.com/product-detail/C165948.html",
    pins=[
        ("A1", "GND", "pwr_in"), ("A4", "VBUS", "pas"), ("A5", "CC1", "pas"),
        ("A6", "DP", "pas"), ("A7", "DN", "pas"), ("A8", "SBU1", "nc"), ("A9", "VBUS", "pas"),
        ("A12", "GND", "pwr_in"), ("B1", "GND", "pwr_in"), ("B4", "VBUS", "pas"),
        ("B5", "CC2", "pas"), ("B6", "DP", "pas"), ("B7", "DN", "pas"), ("B8", "SBU2", "nc"),
        ("B9", "VBUS", "pas"), ("B12", "GND", "pwr_in"), ("SH", "SHIELD", "pas"),
    ],
)

spec(
    "USBLC6-2SC6", ref="D", mpn="USBLC6-2SC6", manufacturer="STMicroelectronics", lcsc="C7519",
    footprint="Package_TO_SOT_SMD:SOT-23-6", desc="2-line low-cap ESD (USB D+/D-, or CC1/CC2)",
    datasheet="https://www.st.com/resource/en/datasheet/usblc6-2.pdf",
    pins=[(1, "IO1", "pas"), (2, "GND", "pas"), (3, "IO2", "pas"), (4, "IO2", "pas"),
          (5, "VBUS", "pas"), (6, "IO1", "pas")],
)

spec(
    "SMF5.0A", ref="D", mpn="SMF5.0A", manufacturer="Littelfuse", lcsc="C151296",
    footprint="Diode_SMD:D_SOD-123F", desc="TVS 5 V unidirectional 200 W (VBUS)",
    datasheet="https://www.lcsc.com/product-detail/C151296.html",
    pins=[(1, "K", "pas"), (2, "A", "pas")],
)

spec(
    "PTC1A5", ref="F", mpn="SMD1206P150TFT", manufacturer="PTTC", lcsc="C495353",
    footprint="Fuse:Fuse_1206_3216Metric", desc="PTC resettable fuse, hold 1.5 A, trip 3 A, 8 V",
    datasheet="https://www.lcsc.com/product-detail/C495353.html",
    pins=[(1, "1", "pas"), (2, "2", "pas")],
)

spec(
    "BQ24074", ref="U", mpn="BQ24074RGTR", manufacturer="Texas Instruments", lcsc="C54313",
    footprint="Package_DFN_QFN:VQFN-16-1EP_3x3mm_P0.5mm_EP1.68x1.68mm",
    desc="1S Li-ion charger with power path; OVP 10.5 V; OUT regulated 4.4 V on input power",
    datasheet="https://www.ti.com/lit/ds/symlink/bq24074.pdf",
    pins=[
        (1, "TS", "in"), (2, "BAT", "pwr_out"), (3, "BAT", "pas"), (4, "CE_N", "in"),
        (5, "EN2", "in"), (6, "EN1", "in"), (7, "PGOOD_N", "oc"), (8, "VSS", "pwr_in"),
        (9, "CHG_N", "oc"), (10, "OUT", "pwr_out"), (11, "OUT", "pas"), (12, "ILIM", "pas"),
        (13, "IN", "pwr_in"), (14, "TMR", "pas"), (15, "ITERM", "pas"), (16, "ISET", "pas"),
        (17, "EP", "pwr_in"),
    ],
)

spec(
    "TLV62569", ref="U", mpn="TLV62569DBVR", manufacturer="Texas Instruments", lcsc="C141836",
    footprint="Package_TO_SOT_SMD:SOT-23-5", desc="2 A sync buck, VFB 0.6 V, 100% duty",
    datasheet="https://www.ti.com/lit/ds/symlink/tlv62569.pdf",
    pins=[(1, "EN", "in"), (2, "GND", "pwr_in"), (3, "SW", "pwr_out"), (4, "VIN", "pwr_in"),
          (5, "FB", "in")],
)

spec(
    "LP5907-3.0", ref="U", mpn="LP5907MFX-3.0/NOPB", manufacturer="Texas Instruments",
    lcsc="C475492", footprint="Package_TO_SOT_SMD:SOT-23-5",
    desc="250 mA ultra-low-noise LDO 3.0 V (6.5 uVrms) - codec/mic AVDD",
    datasheet="https://www.ti.com/lit/ds/symlink/lp5907.pdf",
    pins=[(1, "IN", "pwr_in"), (2, "GND", "pwr_in"), (3, "EN", "in"), (4, "NC", "nc"),
          (5, "OUT", "pwr_out")],
)

spec(
    "MAX17048", ref="U", mpn="MAX17048G+T10", manufacturer="Analog Devices (Maxim)",
    lcsc="C2682616", footprint="Package_DFN_QFN:DFN-8-1EP_2x2mm_P0.5mm_EP0.8x1.6mm",
    desc="1S fuel gauge (B-option only); I2C 0x36",
    datasheet="https://www.analog.com/media/en/technical-documentation/data-sheets/MAX17048-MAX17049.pdf",
    verified="pin map from datasheet text via search (PDF fetch timed out); EP-to-GND assumed; "
             "footprint EP size to confirm",
    i2c={"I2C": 0x36},
    pins=[(1, "CTG", "in"), (2, "CELL", "in"), (3, "VDD", "pwr_in"), (4, "GND", "pwr_in"),
          (5, "ALRT_N", "oc"), (6, "QSTRT", "in"), (7, "SCL", "in"), (8, "SDA", "io"),
          (9, "EP", "pas")],
)

spec(
    "AO3401A", ref="Q", mpn="AO3401A", manufacturer="Alpha & Omega", lcsc="C15127",
    footprint="Package_TO_SOT_SMD:SOT-23", desc="P-MOSFET -30 V -4 A (load switch)",
    datasheet="https://www.aosmd.com/res/datasheets/AO3401A.pdf",
    pins=[(1, "G", "pas"), (2, "S", "pas"), (3, "D", "pas")],
)

spec(
    "AO3400A", ref="Q", mpn="AO3400A", manufacturer="Alpha & Omega", lcsc="C20917",
    footprint="Package_TO_SOT_SMD:SOT-23", desc="N-MOSFET 30 V 5.7 A (gate driver / e-ink boost)",
    datasheet="https://www.aosmd.com/res/datasheets/AO3400A.pdf",
    pins=[(1, "G", "pas"), (2, "S", "pas"), (3, "D", "pas")],
)

spec(
    "SUPERCAP", ref="C", mpn="SE-5R5-D474VYV", manufacturer="Kamcap", lcsc=None,
    footprint="OpenTinCan:Supercap_D11.5mm_P5.0mm",
    desc="0.47 F 5.5 V supercap, power-fail hold-up (Lounge)",
    verified="no LCSC/JLCPCB listing found for 0.47 F 5.5 V (C150565 did not resolve); part, "
             "lead pitch and footprint to choose; ESR ~40 ohm is fine for 0.9 W hold-up",
    pins=[(1, "+", "pas"), (2, "-", "pas")],
)

spec(
    "B5819W", ref="D", mpn="B5819W SL", manufacturer="JSCJ", lcsc="C8598",
    footprint="Diode_SMD:D_SOD-123", desc="Schottky 40 V 1 A (supercap discharge path)",
    pins=[(1, "K", "pas"), (2, "A", "pas")],
)

spec(
    "MBR0530", ref="D", mpn="MBR0530T1G", manufacturer="onsemi", lcsc="C82046",
    footprint="Diode_SMD:D_SOD-123", desc="Schottky 30 V 0.5 A (e-ink boost)",
    datasheet="https://www.onsemi.com/pdf/datasheet/mbr0530t1-d.pdf",
    pins=[(1, "K", "pas"), (2, "A", "pas")],
)

spec(
    "JST-PH-2", ref="J", mpn="S2B-PH-SM4-TB(LF)(SN)", manufacturer="JST", lcsc="C295747",
    footprint="Connector_JST:JST_PH_S2B-PH-SM4-TB_1x02-1MP_P2.00mm_Horizontal",
    desc="JST PH 2-pin SMD right-angle (speaker)",
    pins=[(1, "1", "pas"), (2, "2", "pas"), ("MP", "MP", "pas")],
)

spec(
    "SN74LV1T125", ref="U", mpn="SN74LV1T125DBVR", manufacturer="Texas Instruments",
    lcsc="C473338", footprint="Package_TO_SOT_SMD:SOT-23-5",
    desc="Single buffer, level-shifting inputs (3.3 V in valid at VCC 4.4 V); LED data",
    datasheet="https://www.ti.com/lit/ds/symlink/sn74lv1t125.pdf",
    pins=[(1, "OE_N", "in"), (2, "A", "in"), (3, "GND", "pwr_in"), (4, "Y", "out"),
          (5, "VCC", "pwr_in")],
)

spec(
    "L2u2", ref="L", mpn="SWPA4020S2R2MT", manufacturer="Sunlord", lcsc="C83423",
    footprint="Inductor_SMD:L_Sunlord_SWPA4020S", desc="2.2 uH power inductor 4x4 mm (buck)",
    pins=[(1, "1", "pas"), (2, "2", "pas")],
)

spec(
    "L10u", ref="L", mpn="SWPA3015S100MT", manufacturer="Sunlord", lcsc="C45403",
    footprint="Inductor_SMD:L_Sunlord_SWPA3015S", desc="10 uH power inductor 3x3 mm (e-ink boost)",
    pins=[(1, "1", "pas"), (2, "2", "pas")],
)

# ---------------------------------------------------------------------------------------------
# Sensors, misc main-board parts

spec(
    "DRV5032FA", ref="U", mpn="DRV5032FADBZR", manufacturer="Texas Instruments", lcsc="C140921",
    footprint="Package_TO_SOT_SMD:SOT-23",
    desc="Hall switch, omnipolar, 20 Hz, push-pull, BOP +-3 mT typ (hook)",
    datasheet="https://www.ti.com/lit/ds/symlink/drv5032.pdf",
    pins=[(1, "VCC", "pwr_in"), (2, "OUT", "out"), (3, "GND", "pwr_in")],
)

spec(
    "ITR8307", ref="U", mpn="ITR8307", manufacturer="Everlight", lcsc="C63451",
    footprint="OptoDevice:Everlight_ITR8307",
    desc="IR reflective sensor (hook option for magnet-less handsets)",
    datasheet="https://www.everlight.com/wp-content/plugins/ItemRelationship/product_files/pdf/ITR8307-F43.pdf",
    verified="pin map from the ITR8307/F43 datasheet; confirm it matches the C63451 variant",
    pins=[(1, "K", "pas"), (2, "A", "pas"), (3, "C", "pas"), (4, "E", "pas")],
)

spec(
    "LIS2DH12", ref="U", mpn="LIS2DH12TR", manufacturer="STMicroelectronics", lcsc="C110926",
    footprint="Package_LGA:LGA-12_2x2mm_P0.5mm",
    desc="3-axis accelerometer; I2C 0x19 (SA0=1); INT pins push-pull only",
    datasheet="https://www.st.com/resource/en/datasheet/lis2dh12.pdf",
    i2c={"I2C": 0x18}, i2c_straps=[("SA0", 0)],
    pins=[(1, "SCL", "in"), (2, "CS", "in"), (3, "SA0", "in"), (4, "SDA", "io"),
          (5, "RES", "in"), (6, "GND", "pwr_in"), (7, "GND", "pwr_in"), (8, "GND", "pwr_in"),
          (9, "VDD", "pwr_in"), (10, "VDD_IO", "pwr_in"), (11, "INT2", "out"),
          (12, "INT1", "out")],
)

spec(
    "ATECC608B", ref="U", mpn="ATECC608B-SSHDA-T", manufacturer="Microchip", lcsc="C1518769",
    footprint="Package_SO:SOIC-8_3.9x4.9mm_P1.27mm",
    desc="Secure element (P-256), DNP footprint; I2C 0x60",
    datasheet="https://ww1.microchip.com/downloads/aemDocuments/documents/SCBU/ProductDocuments/DataSheets/ATECC608B-CryptoAuthentication-Device-Summary-Data-Sheet-DS40002239B.pdf",
    i2c={"I2C": 0x60},
    pins=[(1, "NC1", "nc"), (2, "NC2", "nc"), (3, "NC3", "nc"), (4, "GND", "pwr_in"),
          (5, "SDA", "io"), (6, "SCL", "in"), (7, "NC7", "nc"), (8, "VCC", "pwr_in")],
)

spec(
    "TACT", ref="SW", mpn="TS-1187A-B-A-B", manufacturer="XKB", lcsc="C318884",
    footprint="Button_Switch_SMD:SW_Push_1P1T_XKB_TS-1187A",
    desc="Tactile switch 5.1x5.1 mm (pads 1-1 and 2-2 internally joined)",
    pins=[(1, "A", "pas"), (2, "B", "pas")],
)

spec(
    "MMBT3904", ref="Q", mpn="MMBT3904", manufacturer="JSCJ", lcsc="C20526",
    footprint="Package_TO_SOT_SMD:SOT-23", desc="NPN 40 V 200 mA",
    verified="standard SOT-23 B/E/C order; JSCJ datasheet text not readable",
    pins=[(1, "B", "pas"), (2, "E", "pas"), (3, "C", "pas")],
)

spec(
    "LD2410C-HDR", ref="J", mpn="2.54-1*5P (right angle)", manufacturer="BOOMELE",
    lcsc="C35167", footprint="Connector_PinSocket_2.54mm:PinSocket_1x05_P2.54mm_Horizontal",
    desc="5-pin right-angle socket for the HLK-LD2410C radar (module bought separately)",
    datasheet="https://naylampmechatronics.com/img/cms/001080/HLK-LD2410C_datasheet.pdf",
    pins=[(1, "TX", "pas"), (2, "RX", "pas"), (3, "OUT", "pas"), (4, "GND", "pas"),
          (5, "VCC", "pas")],
)

spec(
    "JST-PH-3", ref="J", mpn="S3B-PH-SM4-TB(LF)(SN)", manufacturer="JST", lcsc="C265101",
    footprint="Connector_JST:JST_PH_S3B-PH-SM4-TB_1x03-1MP_P2.00mm_Horizontal",
    desc="JST PH 3-pin SMD right-angle (B-option battery: VBAT, NTC, GND)",
    pins=[(1, "1", "pas"), (2, "2", "pas"), (3, "3", "pas"), ("MP", "MP", "pas")],
)

_FFC_PINS = [(i, str(i), "pas") for i in range(1, 25)] + [("MP", "MP", "pas")]
spec(
    "FFC24", ref="J", mpn="FH12-24S-0.5SH(55)", manufacturer="Hirose", lcsc="C202112",
    footprint="Connector_FFC-FPC:Hirose_FH12-24S-0.5SH_1x24-1MP_P0.50mm_Horizontal",
    desc="24P 0.5 mm FFC/FPC connector, bottom contact, flip lock (main <-> deck FFC)",
    pins=_FFC_PINS,
)

# ---------------------------------------------------------------------------------------------
# Deck board

spec(
    "AW9523B", ref="U", mpn="AW9523BTQR", manufacturer="Awinic", lcsc="C148077",
    footprint="Package_DFN_QFN:TQFN-24-1EP_4x4mm_P0.5mm_EP2.6x2.6mm",
    desc="16-bit I2C I/O expander (keys, side controls, LED power enable); I2C 0x58",
    datasheet="https://xpulabs.github.io/files/datasheet/DS_AW9523B_EN_V2.4.pdf",
    verified="pin map checked (datasheet V1.1.1 + V2.4); exposed-pad size of the land pattern "
             "not checked against the package drawing",
    i2c={"I2C": 0x58}, i2c_straps=[("AD0", 0), ("AD1", 1)],
    pins=[
        (1, "P1_0", "io"), (2, "P1_1", "io"), (3, "P1_2", "io"), (4, "P1_3", "io"),
        (5, "P0_0", "io"), (6, "P0_1", "io"), (7, "P0_2", "io"), (8, "P0_3", "io"),
        (9, "GND", "pwr_in"), (10, "P0_4", "io"), (11, "P0_5", "io"), (12, "P0_6", "io"),
        (13, "P0_7", "io"), (14, "P1_4", "io"), (15, "P1_5", "io"), (16, "P1_6", "io"),
        (17, "P1_7", "io"), (18, "AD0", "in"), (19, "SCL", "in"), (20, "SDA", "io"),
        (21, "VCC", "pwr_in"), (22, "INTN", "oc"), (23, "RSTN", "in"), (24, "AD1", "in"),
        (25, "EP", "pwr_in"),
    ],
)

spec(
    "LTR-303ALS", ref="U", mpn="LTR-303ALS-01", manufacturer="Lite-On", lcsc="C364577",
    footprint="OptoDevice:Lite-On_LTR-303ALS-01", desc="Ambient light sensor; I2C 0x29",
    datasheet="https://datasheet.lcsc.com/datasheet/pdf/e082d25eee9d8954f5ed8e86defb8a71.pdf",
    i2c={"I2C": 0x29},
    pins=[(1, "VDD", "pwr_in"), (2, "NC", "nc"), (3, "GND", "pwr_in"), (4, "SCL", "in"),
          (5, "INT", "oc"), (6, "SDA", "io")],
)

spec(
    "ST25DV04K", ref="U", mpn="ST25DV04K-IER6S3", manufacturer="STMicroelectronics",
    lcsc="C155601", footprint="Package_SO:SOIC-8_3.9x4.9mm_P1.27mm",
    desc="NFC dynamic tag 4 kbit, I2C 0x53 (user) / 0x57 (system), GPO open-drain",
    datasheet="https://www.st.com/resource/en/datasheet/st25dv04k.pdf",
    i2c={"I2C": [0x53, 0x57]},
    pins=[(1, "V_EH", "pwr_out"), (2, "AC0", "pas"), (3, "AC1", "pas"), (4, "VSS", "pwr_in"),
          (5, "SDA", "io"), (6, "SCL", "in"), (7, "GPO", "oc"), (8, "VCC", "pwr_in")],
)

spec(
    "NFC_COIL", ref="L", mpn="PCB coil (copper)", manufacturer="", lcsc=None,
    footprint="OpenTinCan:NFC_Coil_Strip_4T",
    desc="13.56 MHz PCB antenna, target ~4.8 uH (ST25DV CTUN 28.5 pF), 3-4 turns",
    verified="coil geometry to be designed/simulated (ST eDesignSuite) and tuned in EVT",
    pins=[(1, "1", "pas"), (2, "2", "pas")],
)

spec(
    "HOTSWAP", ref="SW", mpn="CPG151101S11-2", manufacturer="Kailh", lcsc="C49352235",
    footprint="OpenTinCan:Kailh_MX_Hotswap_CPG151101S11",
    desc="MX hot-swap socket (switch plugs in; 2 pads)",
    verified="C49352235 (-2 suffix, in stock) assumed to be the same socket as DESIGN.md's "
             "C5156480 (-16 suffix, zero stock); confirm with Kailh/LCSC drawing",
    datasheet="https://datasheet.lcsc.com/datasheet/pdf/5ea75d84e431b4d0c68ab6e4e17d332c.pdf",
    pins=[(1, "1", "pas"), (2, "2", "pas")],
)

spec(
    "SIDE_TACT", ref="SW", mpn="SKRTLAE010", manufacturer="Alps Alpine", lcsc="C110293",
    footprint="Button_Switch_SMD:SW_Push_1P1T-MP_NO_Horizontal_Alps_SKRTLAE010",
    desc="Side-push SMD tactile switch (VOL-/VOL+ on the right end face)",
    pins=[(1, "A", "pas"), (2, "B", "pas"), ("MP", "MP", "pas")],
)

spec(
    "SLIDE_DPDT", ref="SW", mpn="JS202011JAQN", manufacturer="C&K", lcsc="C221664",
    footprint="Button_Switch_SMD:SW_DPDT_CK_JS202011JCQN",
    desc="DPDT slide switch, SMD J-lead (MUTE)",
    verified="pole pinout assumed 1-2-3 / 4-5-6 with commons 2 and 5 (usual C&K JS); JAQN "
             "assumed to share the JS202011JCQN land pattern (JCQN had no stock)",
    pins=[(1, "1A", "pas"), (2, "1COM", "pas"), (3, "1B", "pas"), (4, "2A", "pas"),
          (5, "2COM", "pas"), (6, "2B", "pas")],
)

spec(
    "SK6812MINI-E", ref="D", mpn="SK6812MINI-E", manufacturer="OPSCO", lcsc="C5149201",
    footprint="LED_SMD:LED_SK6812MINI-E_3.2x2.8mm_P1.5mm_ReverseMount",
    desc="RGB LED with driver, reverse mount (VDD 3.7-5.5 V, VIH 0.7 VDD)",
    datasheet="https://cdn-shop.adafruit.com/product-files/4960/4960_SK6812MINI-E_REV02_EN.pdf",
    pins=[(1, "VDD", "pwr_in"), (2, "DOUT", "out"), (3, "GND", "pwr_in"), (4, "DIN", "in")],
)

spec(
    "LED_RED", ref="D", mpn="KT-0603R", manufacturer="Hubei KENTO", lcsc="C2286",
    footprint="LED_SMD:LED_0603_1608Metric", desc="Red LED 0603 (privacy indicator)",
    verified="cathode mark not checked against the drawing (KiCad pad 1 = K)",
    pins=[(1, "K", "pas"), (2, "A", "pas")],
)

_EPD = ["NC1", "GDR", "RESE", "NC4", "VSH2", "TSCL", "TSDA", "BS1", "BUSY", "RES", "DC", "CS",
        "SCL", "SDA", "VDDIO", "VCI", "VSS", "VDD", "VPP", "VSH1", "PREVGH", "VSL", "PREVGL",
        "VCOM"]
spec(
    "FPC24_EPD", ref="J", mpn="FH12-24S-0.5SH(55)", manufacturer="Hirose", lcsc="C202112",
    footprint="Connector_FFC-FPC:Hirose_FH12-24S-0.5SH_1x24-1MP_P0.50mm_Horizontal",
    desc="24P 0.5 mm FPC connector for the GDEY029T94 tail (pin names per panel datasheet)",
    datasheet="https://files.seeedstudio.com/wiki/Other_Display/29-epaper/GDEY029T94.pdf",
    verified="panel pin table checked; which pins get caps read from a small reference drawing; "
             "FPC contact side vs connector (bottom contact) to confirm with a sample",
    pins=[(i + 1, name, "pas") for i, name in enumerate(_EPD)] + [("MP", "MP", "pas")],
)

spec(
    "EPD_NFET", ref="Q", mpn="SI1308EDL-T1-GE3", manufacturer="Vishay", lcsc="C469327",
    footprint="Package_TO_SOT_SMD:SOT-323_SC-70",
    desc="N-MOSFET 30 V 1.5 A (e-ink boost switch, Good Display reference part)",
    datasheet="https://www.vishay.com/docs/63399/si1308edl.pdf",
    pins=[(1, "G", "pas"), (2, "S", "pas"), (3, "D", "pas")],
)

spec(
    "L47u", ref="L", mpn="SWPA4020S470MT", manufacturer="Sunlord", lcsc="C83427",
    footprint="Inductor_SMD:L_Sunlord_SWPA4020S",
    desc="47 uH 440 mA power inductor 4x4 mm (e-ink boost, GD reference 47 uH/500 mA)",
    pins=[(1, "1", "pas"), (2, "2", "pas")],
)

# Non-basic passive values (JLC "extended"; codes found via JLCPCB search, checked by lcsc.py)
RES_EXTRA.update({
    ("1.1k", "0402"): ("C25860", "0402WGF1101TCE"),
    ("1.8k", "0402"): ("C25871", "0402WGF1801TCE"),
    ("20k", "0402"): ("C25765", "0402WGF2002TCE"),
    ("4.3k", "0402"): ("C25899", "0402WGF4301TCE"),
    ("150k", "0402"): ("C25755", "0402WGF1503TCE"),
    ("3.3k", "0402"): ("C25890", "0402WGF3301TCE"),
    ("2.2", "0603"): ("C22939", "0603WAF220KT5E"),
    ("47", "2512"): ("C15261", "25121WJ0470T4E"),
})
CAP_EXTRA.update({
    "1u@50V": ("C15849", "0603", "50V X5R", "CL10A105KB8NNNC"),
    "470n": ("C92361", "0402", "25V X5R", "CL05A474KA5NNNC"),
    "220n": ("C47129", "0402", "25V X5R", "CL05A224KA5NNNC"),
    "220p": ("C39122", "0402", "50V C0G", "0402CG221J500NT"),
    "100u": ("C15008", "1206", "6.3V X5R", "CL31A107MQHNNNE"),
    "4.7u@25V": ("C1779", "0805", "25V X5R", "CL21A475KAQNNNE"),
})


spec(
    "FB220_2A", ref="FB", mpn="BLM18KG221SN1D", manufacturer="Murata", lcsc="C88980",
    footprint="Inductor_SMD:L_0603_1608Metric",
    desc="Ferrite bead 220R@100MHz 2.2 A 50 mOhm 0603 (speaker outputs)",
    pins=[(1, "1", "pas"), (2, "2", "pas")],
)


def all_lcsc_codes() -> set[str]:
    from lib import CAP, RES_0402

    codes = {s.lcsc for s in SPECS.values() if s.lcsc}
    codes |= set(RES_0402.values()) | {v[0] for v in CAP.values()}
    codes |= {v[0] for v in RES_EXTRA.values()} | {v[0] for v in CAP_EXTRA.values()}
    return codes
