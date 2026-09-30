# USBLC6-2SC6 — USB ESD protection (D1)

| | |
|---|---|
| MPN / maker | USBLC6-2SC6 (SOT-23-6L), STMicroelectronics |
| Function here | the one USB ESD part: D+/D- between J1 and the ESP32 (VBUS pin on VBUS, GND) |
| Datasheet | https://www.st.com/resource/en/datasheet/usblc6-2.pdf |
| LCSC / JLC | C7519; ~$0.18 @1; **extended** (pin-compatible clones such as C2687116 cost ~$0.05) |

| Spec | Value | Source |
|---|---|---|
| Pinout | 1 I/O1, 2 GND, 3 I/O2, 4 I/O2, 5 VBUS, 6 I/O1 (each line passes through its pin pair) | [p1] |
| Line capacitance | 3.5 pF max (USB 2.0 full speed needs no more) | [p1] |
| Stand-off | 5 V | [p2] |

Place it at the connector; route D+/D- through its pads.
