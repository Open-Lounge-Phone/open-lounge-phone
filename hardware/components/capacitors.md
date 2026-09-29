# Capacitors — MLCC (all C)

> **H5 (2026-09-30):** new values 12 pF C0G (C38523), 4.7 nF (C53987), 10 nF (C57112), all JLC basic; 100 µF/1206 and 470 nF gone; see `build/main/bom.csv` for the current list.

| | |
|---|---|
| Makers / series | Samsung Electro-Mechanics CL series (most values); Yageo CC0603 X7R (100 nF) |
| Requirements | HW-ELEC-07, -09, -10, -13, -15; HW-FUNC-03; HW-MFG-02 |
| Datasheets | Samsung MLCC catalogue (LCSC copy, "MLCC_2014", PDF 2015-11-18): https://datasheet.lcsc.com/datasheet/pdf/02336ea48ea44ca18c72517dd3cb7b47.pdf — dielectric codes C = C0G, A = X5R, B = X7R [p4]; Yageo "General purpose & high capacitance, Class 2, X7R" **V.26, 2024-11-19**: https://datasheet.lcsc.com/datasheet/pdf/23ccee80ee542e7cf156a772bb589942.pdf |
| Temperature ranges | C0G −55 … +125 °C; X7R −55 … +125 °C; X5R −55 … +85 °C (EIA class definitions; Samsung table [p5]) |
| Lifecycle | Active; all JLC basic |
| Alternates | any MLCC of equal or better dielectric, voltage and size |
| SPICE (H4) | Samsung provides DC-bias-aware MLCC models through its component library tool (UNVERIFIED URL/format); otherwise use datasheet DC-bias curves as C(V) tables. Murata SimSurfing has equivalent parts. |

## BOM lines (LCSC/JLC data 2026-09-29)

| Value / rating | Qty | MPN | LCSC | JLC stock | $ @1k | Key uses | Voltage check |
|---|---|---|---|---|---|---|---|
| 22 pF 50 V C0G 0603 | 1 | CL10C220JB8NNNC | C1653 | 3.0 M | 0.0044 | C78 NFC tuning placeholder (**DNP**) | n/a (value to be set, see nfc-coil.md) |
| 33 pF 50 V C0G 0603 | 1 | CL10C330JB8NNNC | C1663 | 1.05 M | 0.0046 | C35 electret RF | ✓ |
| 100 pF 50 V C0G 0603 | 1 | CL10C101JB8NNNC | C14858 | 4.0 M | 0.0065 | C42 AEC divider | ✓ |
| 220 pF 50 V X7R 0603 | 2 | CL10B221KB8NNNC | C1603 | 783 k | 0.0066 | C49/C50 speaker EMI | ✓ |
| 100 nF 50 V X7R 0603 | 32 | CC0603KRX7R9BB104 | C14663 | 55.8 M | 0.0088 | decoupling, AW RSTN, HS_VBUS sense, 13 LEDs | ✓ |
| 470 nF 25 V X7R 0603 | 2 | CL10B474KA8NNNC | C1623 | 956 k | 0.0202 | C38/C40 AEC ref coupling | ✓ |
| 1 µF 50 V X5R 0603 | 31 | CL10A105KB8NNNC | C15849 | 6.4 M (LCSC 0) | 0.0131 | codec VREF/VMID/REF pins, MICBIAS, e-ink VSH/VGH/VGL/VCOM/VDD, mic coupling, LDO, EN RC | e-ink gate rails ≈ ±20 V (UNVERIFIED exact) < 50 V ✓ (GD reference asks 25 V [GDEY029T94 p29]) |
| 4.7 µF 16 V X5R 0603 | 1 | CL10A475KO8NNNC | C19666 | 2.6 M | 0.0146 | C6 VBAT | 4.2 V ✓ |
| 4.7 µF 25 V X5R 0805 | 2 | CL21A475KAQNNNE | C1779 | 3.0 M | 0.0225 | C87 boost input, C88 charge pump (GD C4/C3) | as GD reference (4.7 µF/25 V) ✓ |
| 10 µF 10 V X5R 0603 | 9 | CL10A106KP8NNNC | C19702 | 10.6 M | 0.0213 | VBUS, VSYS, buck input, 3V0, HS_VBUS, mic-bias RC, LIS2DH12 | VBUS 5.25 V on 10 V (≈ 50 % DC-bias loss, UNVERIFIED curve) ✓; transient clamp 9.2 V < 10 V ✓ (just) |
| 22 µF 25 V X5R 0805 | 5 | CL21A226MAQNNNE | C45783 | 4.1 M | 0.1362 | 3V3 (2 at the buck, 1 at the module), VLED (2) | ✓ |
| 100 µF 6.3 V X5R 1206 | 1 | CL31A107MQHNNNE | C15008 | 2.0 M | 0.0738 | C46 amplifier bulk on VSYS | 4.5 V on 6.3 V (71 %) — large DC-bias loss (UNVERIFIED curve) |

## Rail capacitance checks (nominal, before DC-bias derating)

| Rail | Sum | Limit | Status |
|---|---|---|---|
| VSYS (BQ24074 OUT) | 100 + 10 × 4 + ≈ 1 µF small = ≈ 141 µF (+ VLED 44 µF behind Q2) | 4.7–47 µF [BQ24074 p8] | ✗ F-11 |
| 3V0 (LP5907 OUT) | 1 + 10 + 1 + 0.1 + 1 + 1 = 14.1 µF | 0.7–10 µF [LP5907 p6] | ✗ F-08 |
| 3V3 (TLV62569 OUT) | 22 × 3 + ≈ 3 µF of 1 µF/100 nF | 10–47 µF verified matrix, 2 × 22 µF checked [TLV62569 p9-10] | △ F-19 |
| HS_VIN (SY6280 IN) | 1 µF | 10 µF strongly recommended [SY6280 p5] | ✗ F-05 |

## Open issues

- F-05, F-08, F-11, F-19 (above). DC-bias derating is UNVERIFIED for every X5R value — take the
  curves from Samsung's tool in H4 and re-check the limits with effective capacitance.
