# SMF5.0A — 200 W unidirectional TVS on VBUS (D3)

| | |
|---|---|
| MPN / maker | SMF5.0A (SOD-123FL), Littelfuse |
| Function here | Clamps the power-port VBUS after the PTC (K = VBUS, A = GND), protecting the BQ24074 input and the handset diode. |
| Requirements | HW-ELEC-04, -22; HW-SAFE-03 |
| Datasheet | Littelfuse SMF series, **revised 06/07/17**: https://datasheet.lcsc.com/datasheet/pdf/72868a41320942b18a109aa69d362751.pdf |
| LCSC / JLC | C151296 — LCSC 35 930, JLC 36 072 (2026-09-29); $0.12 @1, $0.080 @1k; **extended** |
| Lifecycle | Active (UNVERIFIED — Littelfuse page not fetched) |
| Alternates | SMF5.0A from other makers on JLC: C193402 (574 k stock), C169426 (both SOD-123FL, pin-compatible by name — UNVERIFIED maker specs) |
| SPICE (H4) | Littelfuse publishes TVS SPICE models (UNVERIFIED for SMF5.0A). **Behavioural**: Zener VBR 6.4–7.0 V, VC 9.2 V at 21.7 A. |

## Key specs we rely on

| Spec | Value | Source |
|---|---|---|
| VR (stand-off) | 5.0 V; IR ≤ 400 µA at VR | [p2] |
| VBR | 6.40–7.00 V at 10 mA | [p2] |
| VC / IPP | 9.2 V at 21.7 A (10/1000 µs) | [p2] |
| Peak power | 200 W (10/1000 µs) | [p1] |
| IEC 61000-4-2 | 30 kV air / 30 kV contact | [p1] |

## Absolute maximum vs our conditions

| Parameter | Datasheet | Ours |
|---|---|---|
| Stand-off | 5.0 V | VBUS up to 5.25 V (USB max) → leakage above the 400 µA IR spec possible at the top of the range (UNVERIFIED curve) — acceptable, but it is a standing load on the source |
| Clamp vs downstream | 9.2 V at 21.7 A | BQ24074 IN abs max 28 V ✓, OVP trips at 10.2–10.8 V ✓; SY6280 IN 6 V abs max via the B5819W: a sustained 6.4–9 V fault exceeds the SY6280 rating (F-07 note) |

## Pinout vs footprint

`Diode_SMD:D_SOD-123F` pad 1 = K = VBUS, pad 2 = A = GND ✓ (cathode band per the datasheet
outline).

## Recommended application circuit vs ours

TVS at the connector, before sensitive parts ✓ (placed after the PTC; the PTC limits the energy
of a sustained fault).

## Open issues

- A faulty charger above ≈ 6 V: the TVS conducts, the PTC (Vmax 8 V) must trip; between 6 and
  10 V the SY6280 input (abs max 6 V) is exposed through D8 — see F-07.
