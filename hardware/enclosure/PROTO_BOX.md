# Prototype box (proto_box.py)

A plain, functional box for bring-up and desk testing of the **single 180 × 88 mm board**
(owner decision 2026-09-27: one board, keys on it). It is not the product enclosure (`olp/`,
ID_SPEC.md); it only has to hold the board, act as the MX switch plate, and give a cradle for
the handset something to mount to, plus an on/off-hook switch for prototyping.

```sh
cd hardware/layout && <KiCad python> dump_parts.py main ../enclosure/build/proto/board_parts.json
cd ../enclosure && .venv/bin/python proto_box.py [--render]
```

Outputs in `build/proto/`: `tray`, `lid`, `plunger`, `sleeve` as STL + STEP (git-ignored),
`checks.txt` (fit checks against the board's parts; exit 1 on FAIL) and `proto.png`.
`make` does not build it; run it by hand as above.

**Designed for industrial printing (MJF/SLS/SLA class)**, to nominal dimensions with 0.1 mm
clearance per side where printed parts mate. For hobby FDM add ~0.1 mm to the key cutouts
(`KEY_CUT`, default 14.0 = MX nominal) and ~0.2 mm to the sockets and bores.

## Geometry

| Item | Value |
|---|---|
| Outside | 187 × 95 × 15.6 mm, R6 corners, 1 mm edge fillets; 2.5 mm walls, 2.0 mm floor |
| Stack (z from the table) | floor top 2.0 → board bottom 9.0 (7 mm under-board space) → board top 10.6 → lid top 15.6 = board top + 5.0 (MX plate height) |
| Lid = switch plate | 2.0 mm; 12 × 14.0 mm cutouts with a 15.2 × 0.5 mm underside pocket (1.5 mm at the clips); e-ink panel pocket (79.2 × 36.9 × 1.0) with a 68 × 30 window (0.5 chamfer); light holes Ø3.2/Ø2/Ø2; Ø1.6 pinholes for RESET, BOOT and the base mic; 1.2 × 1.5 locating lip |
| Under the lid | 3.0 mm above the board top. Taller top-side parts get a lid pocket automatically (max 1.0 deep: parts ≤ 3.8 mm) |
| Under the board | 7.0 mm: hot-swap sockets, JST-PH connectors and side controls go on the **bottom** |
| Rear wall | two USB-C openings 12.8 × 7.2 (R3.4) + 1 mm outside recess at J7 (x 24) and J1 (x 159), centred on the receptacles (board top + 1.63). They are open to the lid top: a plug overmold on a top-mount receptacle reaches 0.1 mm below the plate top |
| Right wall | Ø4 holes VOL− / VOL+, 9 × 4 slot MUTE, at board bottom − 1.8 (controls on the bottom side) |
| Speaker | 40 × 20 × ≤ 5 mm, under the board centre (board x 80.5, y 43.8, below the e-ink panel), in a 1.2 × 3 mm rim on the floor, firing down through a Ø2 / 3.5 mm hex grille; the feet lift it off the table |
| Hook sockets | two Ø12.2 × 8 mm sockets in Ø16 collars on the lid (3 crush ribs), at board (9, 18.8) and (171, 18.8), 162 mm apart, for the Ø12 posts/pegs of any printed, wooden or metal cradle |

## Fasteners and other parts (per box)

| Qty | Part | Where |
|---|---|---|
| 4 | M2.5 × 10 countersunk (ISO 10642) | lid → integral spacer → board → tray boss, at the shell-bolt holes (5, 29.8) (26, 29.8) (154, 29.8) (176, 29.8) |
| 4 | M2.5 × 4 heat-set insert, OD 3.5 (hole Ø3.2 × 5) | tops of the four tray bosses |
| 4 | rubber feet Ø12–13 × ~3 mm (self-adhesive) | Ø13 × 1 mm recesses under the tray |
| 1 | 20 × 40 mm speaker (≈ 4 Ω/8 Ω, ≤ 5 mm thick) | speaker rim on the floor |
| 1 | N35 disc magnet Ø3 × 1.5 | plunger tip (glue) |
| 1 | compression spring OD ≤ 9.4, ID ≥ 7.4 (e.g. 0.5 wire × OD 9), free length ≈ 15, solid < 4 mm | plunger sleeve |

The five other board holes (34.7, 5) (145.3, 5) (34.7, 82.6) (145.3, 82.6) (145.1, 29.4) sit on
plain Ø4.6 support bosses (no screws; Ø4.6 clears the hot-swap sockets beside them). The MX switches clip into the lid, so the lid takes the
keystroke force.

## Assembly

1. Heat-set the four inserts into the tray bosses. Put the speaker into its rim (wires to J4).
2. Plug the 12 switches through the lid into the board's hot-swap sockets (the lid is the
   plate), fit the e-ink panel into its lid pocket (FPC to the ZIF).
3. Drop board + lid into the tray (lid lip locates it) and fit the four M2.5 × 10 screws.
4. Keycaps on.

## On/off hook for prototyping

- **No hardware:** the Native Union POP-style USB-C handset has its own hook/answer button that
  arrives over USB (HID); it works as on/off hook with nothing else fitted.
- **Magnet plunger:** glue the magnet into the plunger tip, drop the spring into the sleeve,
  push the sleeve into the right socket, insert the plunger. Pressed (handset resting on it,
  body flush with the sleeve top = hard stop) the magnet is 2.0 mm above the DRV5032 U10 =
  on hook; released it rises 8 mm (field ≈ 70 mT → ≈ 1.6 mT, well past the DRV5032's release
  point). The plunger is held in by gravity and the handset only; it lifts out.
  (The requested 5 mm spring seat did not fit a spring that pushes up from the socket floor;
  the spring sits on the step inside the sleeve instead.)
- A cradle with a Ø12 **tube** post (ID ≥ 10.4) can sit in the right socket with the plunger
  running inside the tube instead of the sleeve (the socket floor has a Ø10 bore).

## Checks (`build/proto/checks.txt`)

Bed fit (220 × 220), wall/floor/lid thickness, the MX stack (plate top = board top + 5.0),
every top part vs the 3.0 mm under the lid (auto pocket or FAIL), bottom parts vs the 7.0 mm
under the board, Ø6 bosses/spacers vs part courtyards, the speaker keep-out, the plunger vs
parts around U10, USB-C and side-control positions vs their cut-outs, and the 12 switch
sockets vs the lid cutouts. Part heights come from a table in `proto_box.py` (datasheet
values where known, otherwise conservative estimates).

Layout rules this box sets for the single board: top-side parts ≤ 3.0 mm except where a lid
pocket fits (≤ 3.8 mm); JST-PH J2/J4 and the side controls SW3–SW5 on the
bottom side at the right edge; nothing on the bottom inside the speaker area
(board x 59–102, y 32.5–55) taller than 1.0 mm; Ø6 around every mounting hole on both sides.
Light holes: status LED (128, 50) Ø3.2, privacy LED (141.5, 53.4) and ALS (141.5, 57.8) Ø2.
Checked against the routed board on 2026-09-28: all checks pass.

(The Lounge radar that used to need a lid cut-out is no longer on the board: one board, one BOM
since 2026-09-28.)
