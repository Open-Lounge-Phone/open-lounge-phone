# Capacitors — MLCC (C1-C15)

All JLC **basic** parts (Samsung CL series; Yageo CC0603 for 100 nF). Values and refs:
`build/main/bom.csv`.

| Value | Package / rating | LCSC | Where |
|---|---|---|---|
| 22 µF | 0805 25 V X5R | C45783 | module 3V3 bulk (WROOM-1 [p41]); earpiece coupling |
| 10 µF | 0603 10 V X5R | C19702 | LDO input / VBUS (≤ 10 µF USB attach limit); mic-bias filter |
| 2.2 µF | 0603 16 V X5R | C23630 | LDO output (SGM2212 [p10]) |
| 1 µF | 0603 50 V X5R | C15849 | EN delay; ES8311 AVDD, VMID, ADCVREF, DACVREF, MIC1P/MIC1N (ES8311 [p4]) |
| 100 nF | 0603 50 V X7R | C14663 | module 3V3; ES8311 PVDD, DVDD |

X5R at DC bias keeps roughly 45-70 % of its nominal value (assumed in `sim/` b01).
