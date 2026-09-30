# Board requirements: layout checklist for the minimal board (M2)

What the M2 layout must satisfy. 2 layers, the cheapest process everywhere. Each item names how
it is checked (DRC = KiCad DRC with `layout/fab-common.kicad_dru`, I = inspection of the
rendered board). Placement choices still open are in [DESIGN.md](DESIGN.md) §12.

## 1. Board and stackup

| ID | Requirement | Check |
|---|---|---|
| BR-01 | 2 layers, FR-4 1.6 mm, 1 oz copper, HASL lead-free, green mask, white silkscreen. | fab order |
| BR-02 | Outline 156 × 88 mm (M2), R3 corners; 4 × M3 (3.2 mm) non-plated holes with 3.5 mm copper keep-out: three corners + one next to the connector band (the rear-left corner holds the jack J2); two more M3 holes (H5, H6) for the display standoffs. | I |
| BR-03 | Rules = common 2-layer capability with margin: track/space ≥ 0.15/0.15 mm (0.2 mm preferred), drill ≥ 0.3 mm, via 0.6/0.3 mm, copper-to-edge ≥ 0.3 mm, hole-to-hole ≥ 0.5 mm. | DRC |

## 2. Placement

| ID | Requirement | Check |
|---|---|---|
| BR-10 | Keys on a 19.05 mm grid, two rows of six (`1 2 3 4 5 MENU` rear, `6 7 8 9 0 BACK` front), row gap wide enough for the display window between them; hot-swap sockets on the bottom. | I |
| BR-11 | Every SMD part on the bottom (one-sided economic PCBA; M2 placement); the top carries only the plugged switches, J3 and BZ1 (THT). The status LED is reverse-mount, seen through its board cut-out. | I |
| BR-12 | U1 (WROOM-1U) with its U.FL connector reachable for the antenna cable; no copper pour under the U.FL area on the top layer other than its GND. | I |
| BR-13 | U2 (LDO) with a ≥ 100 mm² copper area on its VOUT tab for heat; C_IN and C_OUT (2.2 µF) within 3 mm of its pins; the 22 µF + 100 nF within 3 mm of U1 pin 2. | I |
| BR-14 | D1 (USBLC6) right at J1, D+/D- routed through its pads; J1 at a board edge. | I |
| BR-15 | J2 (TRRS jack) at a board edge; U3 (ES8311) within ~20 mm of J2; its 1 µF reference caps within 2 mm of their pins; the mic path (bias, MIC1P/N caps) away from the USB pair, I2S clocks and the piezo drive. | I |
| BR-16 | The hook socket (SW15) where the enclosure's hook rest presses it (band front-left in M2); J3 where the WeAct module's header lands, H5/H6 at its far holes; BZ1 under the lid's sound holes. | I |
| BR-17 | RESET and BOOT (SW1, SW2) where enclosure pinholes can reach them. | I |
| BR-18 | Silkscreen: the signature logo (G1) and "Open Lounge Phone" (G2) in a clear area, plus "CERN-OHL-S-2.0", the revision, key legends by the sockets, J1/J2/J3 labels and the J3 pin order. | I |

## 3. Routing

| ID | Requirement | Check |
|---|---|---|
| BR-20 | Bottom layer mostly a GND pour, stitched to a top GND pour with vias every ~10 mm and along the edges; no signal slot cuts across the return path of the USB pair, I2S or the mic lines. | I |
| BR-21 | USB D+/D- (full speed, 12 Mbit/s): a short (< 50 mm) side-by-side pair from J1 through D1 to U1, length-matched within 0.15 mm, no via changes, GND on both sides. At full speed a 90 Ω target is good practice, not critical; on 1.6 mm 2-layer it needs a coplanar-with-ground geometry from the fab's calculator. | I |
| BR-22 | Widths: VBUS and 3V3 ≥ 0.5 mm (or pours); signals 0.2 mm; audio 0.25 mm. | DRC / I |
| BR-23 | I2S MCLK/BCLK short and over GND; SPI to J3 may be longer (slow). | I |
| BR-24 | Every decoupling capacitor between its pin and its GND via, ≤ 2 mm from the pin. | I |

## 4. Review gates

1. `make build` passes (ERC 0 errors, all checks).
2. KiCad DRC 0 errors, 0 unconnected items.
3. A written review against the installed `kicad`, `emc` and `pcb-layout-review` skills
   (`hardware/tools/install-skills.sh`) with every finding fixed or explained.
4. Rendered top/bottom/3D images inspected.
