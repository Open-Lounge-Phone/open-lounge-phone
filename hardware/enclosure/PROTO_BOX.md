# Core shell (proto_box.py)

The **core shell** for the minimal board (156 × 88 mm, [../DESIGN.md](../DESIGN.md) §9): a plain,
functional enclosure that other designs are built around. It holds the board, acts as the MX
switch plate, frames the display module and carries the handset. Four printed parts: **tray**,
**lid** (= switch plate), **bezel** and **cradle**. The lid drops into the tray and the two close with four M3
screws into heat-set inserts; the bezel slips over the display module; the cradle hinges on the lid.

## What a design must keep

Shape, colour, edges, trim and any handset rest are free. A shell built on this one keeps:

- the four M3 board holes H1-H4 and the board's height in the stack (plate top = board top + 5.0 mm,
  the MX plate height);
- the 13 MX cut-outs (12 keys + the hook switch) and room for 1u keycaps round them;
- the display window over the module and the two standoffs under it;
- the rear openings for USB-C J1 and the 3.5 mm jack J2;
- holes over the status LED and the piezo, and pinholes under RESET and BOOT;
- room for the antenna ≥ 15 mm from metal, at the board's left edge;
- the cradle's hinge ears and the space the handset needs at the left end.

```sh
cd hardware/enclosure
make parts     # build/proto/board_parts.json from the placed board (KiCad 10)
make proto     # STL + STEP + fit checks (make render also writes proto.png)
```

Outputs in `build/proto/` (generated, not committed): `tray`, `lid`, `bezel` and the four cradle
styles `cradle-v`, `cradle-claw`, `cradle-balls`, `cradle-fork` as STL + STEP (print one of each
part, and one cradle in the style you like),
`checks.txt` (fit checks; exit 1 on FAIL) and, with `make render`, `proto.png`. The board
geometry in `proto_box.py` mirrors `layout/place.py`; the checks compare it with the placed
board, so a moved part shows up as a FAIL. Without `board_parts.json` the part checks are
skipped.

**Designed for industrial printing (MJF/SLS/SLA class)**, to nominal dimensions with 0.1 mm
clearance per side where printed parts mate. For hobby FDM add ~0.1 mm to the key cutouts
(`KEY_CUT`, default 14.0 = MX nominal) and ~0.2 mm to the bores.

## Geometry

| Item | Value |
|---|---|
| Outside | 163 × 95 × 14.6 mm, R6 corners; a 3 mm round along the top edge that runs from the tray rim onto the lid edge, a 1 mm × 45° chamfer along the bottom edge (no overhangs: the tray prints standing on its flat bottom and the lid on its flat underside, so the round faces up on both); 2.5 mm walls, 2.0 mm floor |
| Tray | the walls rise to the lid top: at z 12.6 they step in to 1.5 mm, leaving a 1 mm ledge the lid drops onto, top flush with the walls. Flat bottom with the feet recesses, screw holes and pinholes cut into it |
| Stack (z from the table) | floor top 2.0 → board bottom 8.0 (6 mm under the board: the jack, 4 mm, is the tallest part there) → board top 9.6 → lid top 14.6 = board top + 5.0 (MX plate height) |
| Lid = switch plate | 2.0 mm; **13** × 14.0 mm cutouts (12 keys + the hook switch) with a 15.2 × 0.5 mm underside pocket; 6.1 × 11.2 mm cut-out for the display socket J3; Ø7 holes for the two display standoffs; Ø3 hole over the status LED. Flat underside with only cut-outs in it, so it prints face down on it; 0.1 mm clearance to the tray walls |
| Hook | the 13th MX switch (SW15, band front-left) clips into the lid like a key and carries a plain 1u keycap; an 18.6 mm square, 6 mm tall collar on the lid shrouds it. Travel: actuation at 2 mm, hard stop at 4 mm (the switch itself). Pressed = on the hook |
| Cradle | one arm along the left end, hinged on two ears on the lid (rear-left, in front of the piezo dome) with an M3 screw as the pin. Its round front foot rests on the hook keycap; the handset lies front to back in two rests ("hands"), so the keys and display stay clear. Four interchangeable hand styles share the same arm, hinge and foot and hold the handle at the same height, so any of them swaps on the pin: **V** (90°, 52 mm opening), **claw** (two crescents, thick at the bottom with horns curving up and in, about 60 mm between the tips), **balls** (two Ø14 balls 36 mm apart that the handle sits between) and **fork** (a flat seat between two round-topped tines, 52 mm apart). All take handles up to about 50 mm wide. 56 % of the handset's weight presses the switch (a handset of 121 g or more for 1.5× a 45 gf linear switch); each arm (18-27 g, by style) puts at most 15 g on the cap, so the switch's spring lifts it when the handset comes off. The handle sits 70 mm above the table so the cups clear the keycaps and the table. Handset numbers in `proto_box.py` (`HANDSET_*`, `HANDLE_W`, `CUP_DROP`): the Opis 60s Micro's listed 21 × 7 × 6 cm, with the handle width and cup drop estimated: measure your handset |
| Piezo | BZ1 (6.5 mm tall) pokes 1.5 mm through the plate: a Ø16 dome on the lid covers it, with a Ø12.8 bore and seven Ø1.5 sound holes on top |
| Display | the WeAct 2.9" module plugs into J3 and rests on two M3 × 11 mm standoffs (H5, H6); its underside is at z 20.6, 6 mm above the plate. The **bezel** (separate print) sits on the plate round the module: 1.2 mm walls, 1.2 mm lip, 68 × 30 mm window (centred on the module; the panel's active area is 66.9 × 29.1, position EST). 1.45 mm is left between the bezel and each keycap row |
| Display, 2.13" option | `make proto DISPLAY=2.13` (outputs in `build/proto-2.13/`) fits the WeAct 2.13" module (72 × 30 mm, same 2×4 header at the same place, so it plugs into J3). Its far end rests on two Ø6 posts on the lid with Ø2.2 pins into its holes (6 mm tall, 69.2 mm from the header end); leave the H5/H6 standoffs off. The bezel keeps the 2.9" footprint (it covers the unused standoff holes) with a 52 × 26 mm window over the 2.13" panel (position EST). Firmware: the driver is set for 296 × 128; the 2.13" is 250 × 122 on the same controller |
| Rear wall | USB-C J1 (bottom side, hanging under the board): 12.8 × 7.2 R3.4 opening at board x 19.5, z 6.4; 3.5 mm jack J2 (bottom side): Ø8 opening at board x 6.5 on the plug axis (≈ 2 mm below the board, UNVERIFIED until a PJ-31060 sample is measured) |
| Floor | Ø2 pinholes under RESET (SW1) and BOOT (SW2), both on the board's bottom side; four Ø13 × 1 recesses for rubber feet; the name debossed |
| Antenna | the U.FL is at the board's left edge: stick a 2.4 GHz FPC antenna inside the left wall, ≥ 15 mm from metal (DESIGN.md §9) |

## Sculpted catches (`make hands`)

The cradle's arm, hinge and switch foot are the same on every cradle; only the catch that holds the
handle changes. Besides the four plain styles, `make hands` builds catches from free sculpted models
on Printables: `hands.py` downloads each model listed in `hands.yaml` once (into `build/hands/src/`),
turns and sizes it, finds where a 40 mm handle comes to rest on it, joins it to the arm with a bar,
and writes `build/hands/cradle-<name>.stl`, `checks.txt`, `hands.png` (a contact sheet) and
`CREDITS.txt`. The models themselves are not in this repository.

| Catch | Model (author) | License | Handle rides |
|---|---|---|---|
| `tentacles` | [Octopus Tentacles](https://www.printables.com/model/751736) (Unicorn Dasher), two curling up round the handle | CC0 | +11 mm |
| `allosaurus` | [Allosaurus fragilis Claw](https://www.printables.com/model/1556040) (cjs_3dp), Smithsonian scan, a pair curving in | CC0 | +7 mm |
| `cyberhand` | [Cybernetic Hand Sculpture](https://www.printables.com/model/1280802) (Sueg), two hands in a V | CC0 | +9 mm |
| `antlers` | [Deer Antler, hi resolution scan](https://www.printables.com/model/356636) (billyd), a pair, stems trimmed | CC-BY | +14 mm |
| `healinghands` | [Healing Hands Sculpture](https://www.printables.com/model/131178) (The Next Layer), one hand and its mirror, palms in | CC-BY | +18 mm |
| `lobster` | [Articulated Lobster](https://www.printables.com/model/750316) (AdrianM.), its claws standing up either side | CC-BY | +3 mm |
| `lowpolyhand` | [Low Poly Hand Phone Stand](https://www.printables.com/model/947403) (RyGuy Design), two hands, palms in | CC-BY-SA | +11 mm |
| `raptor` | [Raptor Claw](https://www.printables.com/model/613627) (Protopasta), a pair curving in | CC-BY-SA | +13 mm |

Each catch is a pair: the piece and its mirror image either side of the handle. The script turns
each piece so its curve opens toward the handle, then spreads the pair until a 40 mm handle sits
down between them with both sides rising at least 16 mm up its sides (`CUP_DEPTH`).

"Handle rides" is how much higher than on the plain cradles the catch holds the handle: a sculpture
needs room under the handle, and the cups only clear the keys and table better. The script allows
up to 25 mm (`RAISE_MAX`) and shrinks a model that would need more. Checks for every catch: a 40 mm
handle touches both sides (or rests on the bar between a pair), both sides rise at least 16 mm up
it, and it lifts straight out; 50 and 30 mm handles fit and lift out too; the bar is at least 15 mm above the keycaps and above the
arm; the catch stays between the handset's cups; and the cradle's weight leaves the switch able to
lift it. Scans that aren't closed solids are written as overlapping shells, which slicers and
print services merge; their weight is a voxel estimate.

**Licenses.** Sharing a printed or remixed catch: credit the CC-BY ones (`CREDITS.txt` has the
lines); a CC-BY-SA remix (`lowpolyhand`, `raptor`) stays CC-BY-SA. CC0 needs nothing.

**Adding one:** add an entry to `hands.yaml` with the Printables model id, the file name, author and
license, then `mode` (`pair`, or `single` for one piece the handle sits in), `rot` to stand
it up, `trim` / `select` / `drop_small` to clean it up and `height` or `width`; run `make hands` and look at `build/hands/hands.png`.

## Fasteners and other parts (per box)

| Qty | Part | Where |
|---|---|---|
| 4 | M3 × 12 countersunk (ISO 10642) | lid → spacer → board → tray boss, at the board holes H1-H4 (152.5, 3.5) (152.5, 84.5) (3.5, 84.5) (31, 31) |
| 4 | M3 × 4 heat-set insert, OD 4.2 (hole Ø4.0 × 5) | tops of the four tray bosses |
| 4 | M3 nylon spacer, 3 mm long, OD 6 | between the lid and the board at H1-H4 |
| 2 | M3 × 11 female-female standoff (hex 5.5) + 4 × M3 × 5 screws | display module: board H5/H6 → module's far holes |
| 1 | straight 2x4 2.54 mm male header | replaces the module's right-angle header, pointing down into J3 |
| 4 | rubber feet Ø12-13 × ~3 mm (self-adhesive) | recesses under the tray |
| 1 | 2.4 GHz FPC antenna with U.FL, 100-150 mm cable, ≤ 2.33 dBi | inside the left wall |
| 1 | M3 × 25 screw + M3 nylock nut | cradle hinge pin through the two lid ears |
| 1 | 1u keycap (any, e.g. a spare clear XDA cap) | on the hook switch, under the cradle foot |

## Assembly

1. Heat-set the four inserts into the tray bosses.
2. Screw the two standoffs to H5/H6 from below the board.
3. Put the four spacers on the board holes and the lid on top; plug the 12 switches and the hook switch through the lid into the
   hot-swap sockets (the lid is the plate).
4. Plug the display module into J3 through the lid cut-out and screw its far end to the
   standoffs; put the bezel over it.
5. Stick the antenna to the left wall, plug it onto the U.FL; drop board + lid into the tray
   (the lid sits on the tray's ledge) and fit the four M3 × 12 screws.
6. Put a keycap on the hook switch, set the cradle between the lid ears and push the M3 × 25
   screw through; snug the nylock nut so the arm still swings freely.
7. Keycaps on: clear, blank, double-layer XDA-profile 1u caps for MX switches (about 18.2 mm square, 9 mm tall); the printed key label goes between the two layers. Plug the handset (3.5 mm TRRS, CTIA) and power into the rear wall.

## Checks (`build/proto/checks.txt`)

Bed fit (220 × 220), walls, the printable edges, the lid's flat underside, the spacers, the MX stack (plate top = board top + 5.0), hook travel, the rear
openings (inside the wall, above the floor), bezel vs keycaps, the display stack (socket +
header = standoff length), J1/J2 on the bottom at the rear edge at their cut-outs, bottom parts
vs the 6 mm under the board, top parts taller than the 3 mm under the plate (only J3 and BZ1,
each with its opening), J3 pin 1 and H5/H6 where the WeAct drawing puts them, Ø7 bosses vs
part courtyards, the piezo dome over BZ1, the LED hole over D2, the pinholes under SW1/SW2 and
the 13 switch sockets vs the lid cutouts, and the cradle: both handset cups clear of the keycaps,
piezo dome and table, and for every cradle style the hands ≥ 15 mm above the keycaps and the arm's
own weight on the cap; the handset's share of the hook load, the hinge ears vs the H4 countersink and the piezo dome, and the arm's
swing. Part heights come from a table in `proto_box.py`
(datasheet values where known, otherwise conservative estimates). Last run 2026-10-08: all checks pass.
