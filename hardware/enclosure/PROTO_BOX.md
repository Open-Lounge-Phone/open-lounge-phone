# Prototype box (proto_box.py)

A plain, functional box for bring-up and desk testing of the **single 180 × 88 mm board**
(one board, keys on it). It is not the product enclosure (not designed yet); it only has to
hold the board, act as the MX switch plate, give a cradle for the handset something to mount
to, and provide a **captive** on/off-hook plunger.

```sh
cd hardware/enclosure
make parts     # optional: build/proto/board_parts.json from the placed board (KiCad 10)
make proto     # STL + STEP + fit checks (make render also writes proto.png)
```

Outputs in `build/proto/` (generated, not committed): `tray`, `lid`, `sleeve`, `plunger`,
`retainer` as STL + STEP, `checks.txt` (fit checks; exit 1 on FAIL) and, with `make render`,
`proto.png`. Without `board_parts.json` the checks against the board's parts are skipped; the
geometry checks (captive plunger, hook geometry, jack opening, speaker depth) always run.
`make proto` in `hardware/` runs the same.

**H5 (2026-09-30).** The box follows the H5 schematic: the handset is an **analog 3.5 mm TRRS
jack** on the board's bottom side at the rear edge (the USB-C handset port is gone), the power
USB-C on the right wall also carries flashing and the console, the floor space grew from 7 to
**10 mm** for the **Soberton SP-2040** speaker (8.4 mm deep; the part that meets the ≥ 75 dBA
ringer target, `sim/` b06), the plunger is **captive** with its magnet caged (owner decision D8),
travel **10 mm** (D3, DRV5032AJ), the base-mic pinhole is gone and the lid has a slot for the two
mic lights plus a separate recording-light hole. Until the H6 layout places the jack,
`board_parts.json` (from the H3 board) still shows the USB-C J7: `checks.txt` reports that as a
WARN and positions the jack opening from the schematic decision (x 153.8, bottom side).

**Designed for industrial printing (MJF/SLS/SLA class)**, to nominal dimensions with 0.1 mm
clearance per side where printed parts mate. For hobby FDM add ~0.1 mm to the key cutouts
(`KEY_CUT`, default 14.0 = MX nominal) and ~0.2 mm to the sockets and bores.

## Geometry

| Item | Value |
|---|---|
| Outside | 187 × 95 × 18.6 mm, R6 corners, 1 mm edge fillets; 2.5 mm walls, 2.0 mm floor |
| Stack (z from the table) | floor top 2.0 → board bottom 12.0 (10 mm under-board space) → board top 13.6 → lid top 18.6 = board top + 5.0 (MX plate height) |
| Lid = switch plate | 2.0 mm; 12 × 14.0 mm cutouts with a 15.2 × 0.5 mm underside pocket (1.5 mm at the clips); e-ink panel pocket (79.2 × 36.9 × 1.0) with a 68 × 30 window (0.5 chamfer); light holes: status (127, 62.8) Ø3.2, ambient light (140, 63.6) Ø2, **mic lights** (158.5, 67.5) 4.6 × 2.0 slot, **recording light** (158.5, 77.0) Ø2; Ø1.6 pinholes for RESET and BOOT; 1.2 × 1.5 locating lip |
| Under the lid | 3.0 mm above the board top. Taller top-side parts get a lid pocket automatically (max 1.0 deep: parts ≤ 3.8 mm) |
| Under the board | 10.0 mm: hot-swap sockets, JST-PH connectors, side controls and the handset jack go on the **bottom** |
| Rear wall | Ø8.0 round opening for the **handset jack J7** at board x 153.8, on the plug axis (≈ 2.0 mm below the board bottom, z 10.0; UNVERIFIED until a PJ-31060 sample is measured). Plug overmolds up to 7.6 mm pass through to the jack face at the board edge |
| Right wall | **power USB-C J1** (power + ESP32 native USB for flashing and the console) 12.8 × 7.2 (R3.4) opening + 1 mm outside recess at board y 40, centred on the receptacle (board top + 1.63), open to the lid top; Ø4 holes VOL− / VOL+ and a 9 × 4 slot MUTE at board bottom − 1.8 (controls on the bottom side) |
| Speaker | **Soberton SP-2040**, 40 × 20 × 8.4 mm, 8 Ω 1 W (spec rev B p1), under the board centre (board x 80.5, y 43.8, below the e-ink panel), in a 1.2 × 3 mm rim on the floor, firing down through a Ø2 / 3.5 mm hex grille; 1.6 mm to the board bottom, so bottom parts there stay ≤ 1.0 mm |
| Hook sockets | two Ø12.2 × 8 mm sockets in Ø16 collars on the lid (3 crush ribs), at board (9, 18.8) and (171, 18.8), 162 mm apart, for the Ø12 posts/pegs of any printed, wooden or metal cradle. The right one has no floor: it holds the plunger sleeve (below) |

## Captive hook plunger (HW-MECH-09, HW-SAFE-04)

Three printed parts plus a spring and the magnet, all inside the right socket:

| Part | Shape | What keeps it in |
|---|---|---|
| **Sleeve** (post stub) | Ø12 × 20.5 mm tube with a Ø15 × 1.0 flange at its bottom; Ø9.8 chamber, Ø7.4 top lip | inserted **from below** the lid: its flange sits in a Ø15.2 × 1.0 counterbore in the lid underside and cannot pass the Ø12.2 bore; the lid is screwed to the tray |
| **Plunger** | Ø7 cap (the handset presses it) – Ø9.4 × 2 flange – Ø6 × 6.8 stem with a Ø3.2 × 1.6 magnet pocket in the tip | the flange cannot pass the Ø7.4 lip (up) nor the retainer's Ø6.4 bore (down) |
| **Retainer** | Ø9.8 × 3 ring (spring seat, stem guide) on a Ø11 × 0.6 floor with a Ø2 hole | pressed and glued into the sleeve bottom; its floor cages the Ø3 magnet (the hole is smaller than the magnet) |

Pressed (handset down, cap flush with the sleeve top = hard stop) the magnet is **2.0 mm above
the DRV5032AJ U10** (on hook, 31 mT); released it rises **10 mm** (0.9 mT): 3.3× margin both
ways against the AJ thresholds (`sim/` b11). The retainer floor clears the top of U10 by 1.2 mm.
Nothing in the assembly — plunger, spring, magnet — can be removed without opening the screwed
box. Assembly: magnet (glued) into the plunger tip → plunger cap-first up into the sleeve from
below → spring over the stem → retainer pressed + glued into the sleeve bottom → sleeve pushed
up through the lid from below (flange into the counterbore, crush-rib press fit) → lid onto the
board.

## Fasteners and other parts (per box)

| Qty | Part | Where |
|---|---|---|
| 4 | M2.5 × 10 countersunk (ISO 10642) | lid → integral spacer → board → tray boss, at the shell-bolt holes (5, 29.8) (26, 29.8) (154, 29.8) (176, 29.8) |
| 4 | M2.5 × 4 heat-set insert, OD 3.5 (hole Ø3.2 × 5) | tops of the four tray bosses |
| 4 | rubber feet Ø12–13 × ~3 mm (self-adhesive) | Ø13 × 1 mm recesses under the tray |
| 1 | Soberton SP-2040 speaker, 20 × 40 × 8.4 mm, 8 Ω 1 W | speaker rim on the floor, wires to J4 |
| 1 | N35 disc magnet Ø3 × 1.5 | plunger tip (glue), caged by the retainer |
| 1 | compression spring OD ≤ 9.4, ID ≥ 6.4 (e.g. 0.5 wire × OD 9), free length ≈ 16, solid < 4 mm | between the retainer and the plunger flange (4 mm pressed, 14 mm released) |
| 1 | general-purpose 2.4 GHz antenna with U.FL/IPEX (see DESIGN §4 for the certification caveat) | inside the shell wall, ≥ 15 mm from metal |

The five other board holes (34.7, 5) (145.3, 5) (34.7, 82.6) (145.3, 82.6) (145.1, 29.4) sit on
plain Ø4.6 support bosses (no screws; Ø4.6 clears the hot-swap sockets beside them). The MX
switches clip into the lid, so the lid takes the keystroke force.

## Assembly

1. Heat-set the four inserts into the tray bosses. Put the speaker into its rim (wires to J4).
2. Build the plunger stack (above) and push the sleeve up through the lid's right socket from
   below.
3. Plug the 12 switches through the lid into the board's hot-swap sockets (the lid is the
   plate), fit the e-ink panel into its lid pocket (FPC to the ZIF).
4. Drop board + lid into the tray (lid lip locates it) and fit the four M2.5 × 10 screws.
5. Keycaps on. Plug the handset (3.5 mm TRRS, CTIA) into the rear jack, power into the right
   USB-C.

## On/off hook

The handset rests on the plunger cap (or on a cradle whose right post is a tube over the
sleeve). Down = on hook: the Hall sensor sees the magnet, and in hardware the earpiece is
disconnected and the handset mic is unpowered (HW-PRIV-03). Lifting it releases the plunger
10 mm: off hook, earpiece and mic (if MUTE is off) come on, and the two mic lights with them.

## Checks (`build/proto/checks.txt`)

Bed fit (220 × 220), wall/floor/lid thickness, the MX stack (plate top = board top + 5.0), the
**captive plunger + magnet** (flange vs lip and retainer bore, magnet vs cage hole, sleeve
flange vs lid bore), the **hook geometry** (2.0 mm magnet gap, 10 mm travel, spring lengths),
retainer floor vs U10, the **handset-jack opening** (inside the wall, jack body fits under the
board), the **speaker depth** (8.4 mm + bottom parts + air ≤ 10 mm), every top part vs the 3.0 mm
under the lid (auto pocket or FAIL), bottom parts vs the space under the board, Ø6 bosses/spacers
vs part courtyards, the speaker keep-out, the battery pocket, parts under the retainer, the
power USB-C and side-control positions vs their cut-outs, J7 (WARN until the H6 board places the
jack) and the 12 switch sockets vs the lid cutouts. Part heights come from a table in
`proto_box.py` (datasheet values where known, otherwise conservative estimates).

Layout rules this box sets for the single board: top-side parts ≤ 3.0 mm except where a lid
pocket fits (≤ 3.8 mm); JST-PH J2/J4, the side controls SW3–SW5 and the handset jack J7 on the
bottom side at their edges; nothing on the bottom inside the speaker area (board x 59–102,
y 32.5–55) taller than 1.0 mm; nothing taller than 2.2 mm on the top inside Ø11 around U10;
Ø6 around every mounting hole on both sides. Last run 2026-09-30 (H5): all checks pass, one WARN
(J7 in the H3 board data).
