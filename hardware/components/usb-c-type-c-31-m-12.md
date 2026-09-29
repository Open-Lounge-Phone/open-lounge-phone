# HRO TYPE-C-31-M-12 — USB-C 16-pin receptacle (J1 power, J7 handset)

> **H5 (2026-09-30, owner D14):** only **J1** remains (power sink + ESP32 native USB for flashing and the USB-Serial-JTAG console). The handset USB-C J7 is gone: the handset is on a 3.5 mm jack ([pj-31060.md](pj-31060.md)). F-01 closed (flashing over J1 needs no switch), F-22 closed (PROTO_BOX.md follows proto_box.py).

| | |
|---|---|
| MPN / maker | TYPE-C-31-M-12, Korean Hroparts (HRO) Electronics |
| Function here | J1: power/programming port (sink, 5.1 kΩ Rd on each CC), right edge at y 40. J7: handset port (USB host + source, 33 kΩ Rp to 3V3), rear edge at x 153.8. |
| Requirements | HW-ELEC-01, -18, -19, -20, -22; HW-MECH-02, -03, -06; HW-ENV-02, -04 |
| Datasheet | HRO drawing TYPE-C-31-M-12, **rev A, drawn 2020-12-08** (PDF modified 2022-05-25): https://datasheet.lcsc.com/datasheet/pdf/9e56b777c022540fcce7c7f67825f55e.pdf |
| LCSC / JLC | C165948 — LCSC 428 555, JLC 440 643 (2026-09-29); $0.19 @1, $0.10 @1k; **extended** |
| Lifecycle | UNVERIFIED (HRO publishes none); very high stock. |
| Alternates | Other 16-pin top-mount USB 2.0 receptacles with the same land (e.g. GCT USB4105-GF-A has a **different** land — UNVERIFIED); KiCad has a dedicated footprint for this exact part. |
| SPICE (H4) | n/a (connector); model the pair as 90 Ω transmission line in SI checks. |

## Key specs we rely on (drawing notes and tables)

| Spec | Value | Source |
|---|---|---|
| Current / voltage rating | 5 A / 20 V | [drawing note 4] |
| Durability | 10 000 cycles; insertion 0.5–2.0 kgf, withdrawal 0.8–2.0 kgf | [note 3] |
| Operating temperature | −30 … +80 °C | [note 5] |
| Contacts / plating | copper alloy, Ni 50 µ" + Au on contact area; stainless mid-plate | [notes 1–2] |
| Body height above PCB | 3.26 mm (side view) | [drawing] |
| Mounting | 4 shell tabs in plated slots (through-hole) | [PCB layout] |
| Pin table | A1/B12, B1/A12 GND; A4/A9/B4/B9 VBUS; A5 CC1; B5 CC2; A6/B6 DP; A7/B7 DN; A8 SBU1; B8 SBU2 | [pin table] |
| Reflow | 260 °C peak for 10 s | [note 6] |

## Absolute maximum vs our conditions

5 A / 20 V rating vs ≤ 1.6 A / 5.25 V ✓. −30 °C lower limit vs storage −20 °C ✓.

## Pinout vs footprint

KiCad `Connector_USB:USB_C_Receptacle_HRO_TYPE-C-31-M-12` (made for this part). Pad nets:

| Pads | J1 (power) | J7 (handset) |
|---|---|---|
| A1, A12, B1, B12 | GND | GND |
| A4, A9, B4, B9 | VBUS_C | HS_VBUS |
| A5 / B5 | CC1 / CC2 | HS_CC1 / HS_CC2 |
| A6, B6 | USB_DP_C | HS_USB_DP |
| A7, B7 | USB_DN_C | HS_USB_DN |
| A8 / B8 | open (SBU) | open |
| SH (×4) | GND | GND |

✓ Matches the pin table; both DP and both DN contacts joined (orientation-independent USB 2.0).

## Recommended application circuit vs ours

Shell to GND at the connector ✓ (SCHEMATIC notes an RC-to-GND option for EMC in EVT).

## Open issues

- J7 must work as a **device** (Rd) port during download mode if flashing moves there (F-01).
- 3.26 mm body height exceeds the 3.0 mm lid clearance → lid pocket (PROTO_BOX) ✓.
