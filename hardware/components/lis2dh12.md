# LIS2DH12TR — 3-axis accelerometer (U12)

| | |
|---|---|
| MPN / maker | LIS2DH12TR (LGA-12 2 × 2 × 1), STMicroelectronics |
| Function here | Knock/tamper/"knocked over" events (DESIGN §8). I2C 0x19 (SA0 = 1), CS high (I2C mode); INT1 is push-pull, so it drives an AO3400A (Q4) that pulls the shared open-drain IRQ. |
| Requirements | HW-FUNC-17; HW-MFG-03 |
| Datasheet | LIS2DH12 datasheet **DocID025056 Rev 6 (May 2017)**, LCSC copy: https://datasheet.lcsc.com/datasheet/pdf/80fd3cb5c04ce9b30e9bec7b53c4a455.pdf ; official (not reachable from this environment 2026-09-29): https://www.st.com/resource/en/datasheet/lis2dh12.pdf |
| LCSC / JLC | C110926 — **LCSC 0, JLC 0** (2026-09-29); $0.89 @1, $0.54 @1k; **extended** |
| Lifecycle | Active at ST (UNVERIFIED — st.com not reachable); **not buildable at JLC today**. |
| Alternates | SC7A20TR (Silan, C5126709, JLC 683) — marketed as LIS2DH12-compatible; pinout/registers UNVERIFIED. LIS2DW12TR (ST, C189624, 18 969 stock) — LGA-12 2 × 2 but **different pinout** (UNVERIFIED, needs a footprint/netlist check). |
| SPICE (H4) | None needed (digital). |

## Key specs we rely on

| Spec | Value | Source |
|---|---|---|
| Supply | 1.71–3.6 V | [p1] |
| Pins | 1 SCL, 2 CS (1 = I2C), 3 SDO/SA0 (internal pull-up 20–54 kΩ), 4 SDA, 5 Res → GND, 6–8 GND, 9 Vdd, 10 Vdd_IO, 11 INT2, 12 INT1 | [p9 Table 2-3] |
| I2C address | 001100x, x = SA0 (SA0 to supply → 0011001b = **0x19**) | [p25] |
| INT pins | CTRL_REG6 offers INT_POLARITY only; no push-pull/open-drain selection in this revision → push-pull | [p38] |
| Operating temperature | −40 … +85 °C | [p15] |

## Absolute maximum vs our conditions

| Parameter | Abs max [p15] | Ours |
|---|---|---|
| Vdd, Vdd_IO | −0.3 … 4.8 V | 3V3 ✓ |
| Control pins | −0.3 … Vdd_IO + 0.3 V | 3.3 V bus ✓ |
| Shock | 3000 g 0.5 ms / 10 000 g 0.2 ms | drop test ✓ |
| ESD | 2 kV HBM | internal ✓ |

## Pinout vs footprint

`Package_LGA:LGA-12_2x2mm_P0.5mm` (U12) nets: 1 I2C_SCL, 2 3V3 (CS), 3 3V3 (SA0), 4 I2C_SDA, 5 GND
(Res), 6 GND, 7 GND, 8 GND, 9 3V3, 10 3V3, 11 open (INT2), 12 ACC_INT1. ✓ Matches Table 2 [p9].

## Recommended application circuit vs ours

100 nF + 10 µF decoupling (ST application hint) — ours 100 nF + 10 µF ✓. Res to GND ✓.

## Open issues

- **F-16**: zero stock at LCSC and JLCPCB. Either qualify an alternate (SC7A20 claimed compatible,
  LIS2DW12 needs a netlist change) or remove the accelerometer: it has no current software use
  (Lounge presence and tamper are deferred with the radar). Owner decision.
