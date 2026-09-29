# ST25DV04K-IER6S3 — dynamic NFC/RFID tag, I2C + RF (U19)

> **H5 (2026-09-30):** the BOM carries **ST25DV04KC-IE6S3** (C3304276, SO8N; F-17): same pinout (DS13519 rev 4 p4 Fig. 2), same device select A6h/AEh = 0x53/0x57 (p165 Table B.1), CTUN 28.5 pF (p1). The 0x2D entry is gone from `pin_table.yaml` (F-27). The tuning cap C62 is fitted: 12 pF C0G for the 7-turn coil (`sim/` b08).

| | |
|---|---|
| MPN / maker | ST25DV04K-IER6S3 (SO-8N), STMicroelectronics |
| Function here | NFC Forum Type 5 tag with 4 kbit EEPROM for tap-to-setup / claim / lounge takeover (NDEF URL written over I2C). AC0/AC1 to the PCB coil (L2) with a DNP tuning cap (C78, 22 pF placeholder); GPO (open drain, "-IE") on the shared IRQ; VCC 3V3; V_EH open. |
| Requirements | HW-FUNC-07; HW-MECH-08; HW-ELEC-21 |
| Datasheet | ST25DV04K/16K/64K datasheet **DocID027603 Rev 4 (Dec 2017)**, LCSC copy: https://datasheet.lcsc.com/datasheet/pdf/ce116a756a0243a590825dacea97af3c.pdf ; product page https://www.st.com/en/nfc/st25dv04k.html |
| LCSC / JLC | C155601 — LCSC 4 993, JLC 5 065 (2026-09-29); $1.41 @1, $0.83 @1k; **extended** |
| Lifecycle | **NRND** — "not recommended for new designs", replacement **ST25DV04KC-IE6S3** (search result citing ST and distributors, 2026-09-29: https://octopart.com/part/stmicroelectronics/ST25DV04K-IER6S3) |
| Alternates | **ST25DV04KC-IE6S3** (C3304276, JLC 17 805, $0.94 @1, $0.50 @1k, SO-8) — cheaper and in stock; pinout and I2C addresses of the KC family UNVERIFIED (check its datasheet DS13519 before the swap). |
| SPICE (H4) | None. **Behavioural** for coil tuning: internal tuning capacitance 28.5 pF [p1] in parallel with the coil (L, R from the field solver), f = 1/(2π√(L·C)). |

## Key specs we rely on

| Spec | Value | Source |
|---|---|---|
| RF | ISO/IEC 15693, NFC Forum Type 5 certified | [p1] |
| Internal tuning capacitance | 28.5 pF | [p1] |
| Supply | 1.8–5.5 V (I2C side) | [p1] |
| GPO | -IE: open drain, needs a pull-up > 4.7 kΩ | [p21] |
| 8-pin signals | V_EH, AC0, AC1, VSS, SDA, SCL, GPO, VCC; NC and EP (UFDFPN only) must be left floating | [p18] |
| I2C device select | 1010 E2 1 1 + R/W: E2 = 0 user memory → **0x53**; E2 = 1 system area → **0x57** | [p88 Table 51] |
| Operating temperature | −40 … +85 °C (range 6) | [p170] |

## Absolute maximum vs our conditions

| Parameter | Abs max [p170] | Ours |
|---|---|---|
| VCC, I2C I/O | −0.5 … 6.5 V | 3.3 V ✓ |
| GPO open-drain sink | 1.5 mA | 3.3 V/10 kΩ = 0.33 mA ✓ |
| AC0–AC1 peak-to-peak | 11 V | field-limited by the reader; UNVERIFIED in our coil (characterized, not tested, per note) |
| ESD (HBM) | 2000 V | coil is inside the enclosure ✓ |

## Pinout vs footprint

SO-8 pin figure [p18] vs `Package_SO:SOIC-8_3.9x4.9mm_P1.27mm` (U19): 1 V_EH = open, 2 AC0 =
NFC_AC0, 3 AC1 = NFC_AC1, 4 VSS = GND, 5 SDA = I2C_SDA, 6 SCL = I2C_SCL, 7 GPO = IRQ, 8 VCC = 3V3.
✓ (pins 3–6 read directly from the figure [p18]; 1, 2, 7, 8 from the same figure's text layer.)

`schematic/pin_table.yaml` also lists **0x2D** for the ST25DV04K; this datasheet revision uses only
0x53/0x57 [p88]. The extra entry is harmless for the uniqueness check but should be removed or
justified (F-27).

## Recommended application circuit vs ours

| Datasheet | Ours | Note |
|---|---|---|
| Coil tuned to 13.56 MHz with the 28.5 pF internal cap (ST eDesignSuite) | 9-turn 26 × 42 mm PCB coil, ≈ 4.8 µH **calculated** + DNP cap | f with 4.8 µH and 28.5 pF = 13.6 MHz ✓ on paper; F-18: measure L and Q with a VNA in EVT |
| GPO pull-up > 4.7 kΩ | 10 kΩ shared IRQ pull-up | ✓ |
| 100 nF at VCC | 100 nF | ✓ |

## Open issues

- F-17: NRND → move to ST25DV04KC-IE6S3 after checking its datasheet.
- F-18: coil inductance is a filament estimate only.
- F-27: stray 0x2D address in the pin table.
