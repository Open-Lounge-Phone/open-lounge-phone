# Plush series: the cushion desk case

A fat, cushion-like case that lies flat on a table, for the minimal board. Two pillows fused like
a sofa cushion: one over the keypad, one beside it that is the handset's bed. Rigid print, made
to look inflated. Generate the files with:

```sh
.venv/bin/python handset.py     # the handset (render model + printable shell and caps)
.venv/bin/python plush.py       # the case, the bottom plate and the keycaps
```

Outputs: `build/plush/` and `build/handset/` (STEP for editing, STL for printing).

## What to print

| Part | File | Qty | Notes |
|---|---|---|---|
| Case (top shell) | `plush-case` | 1 | Print upside down (the flat underside up) or on its side; it's 218 x 228 x 46 mm |
| Bottom plate | `plush-bottom` | 1 | Flat on the bed, lip up |
| Keycaps | `caps/puffy-1` ... `puffy-0`, `puffy-menu`, `puffy-back` | 12 | Captive: a flange under the face and a puffy button with an engraved legend |
| Hook key cap | `caps/puffy-hook` | 1 | Round-topped: the bed's tongue presses it |
| Handset shell | `handset-shell` | 1 | Optional: a printed Opis-style handset. One smooth piece, hollow from mouthpiece to earpiece. Print on its back (SLS/MJF ideal; FDM with supports inside the cups) |
| Handset caps | `handset-cap-earpiece`, `handset-cap-mouthpiece` | 1 each | Screw onto the cups from below |

Any rigid material works: PETG, PLA, ABS/ASA, or nylon (SLS/MJF) for the toughest finish.

## What to buy

| Item | Qty | For |
|---|---|---|
| M3 x 8 countersunk screw (ISO 10642) | 7 | bottom plate into the case |
| M3 x 4 heat-set insert, OD 4.0-4.2 | 7 | the case's bottom bosses |
| M3 x 3 heat-set insert + M3 x 5 screw | 4 each | the board, up through its four holes into the case |
| Rubber feet, 10 mm round, stick-on | 4 | recesses in the bottom plate |
| Clear polycarbonate, 58 x 32 x 2 mm | 1 | display lens (VHB tape ring behind the lip) |
| 3 mm clear acrylic rod, about 21 mm | 1 | status light pipe |
| A standard linear MX switch | 13 | the 12 keys and the hook |
| For the printed handset: M2.5 x 6 self-tapping screws | 6 | the two caps |
| For the printed handset: a speaker up to 30 mm, a 9.7 mm electret mic capsule, a coiled 4-wire cord with a 3.5 mm TRRS plug | 1 each | inside the caps |

Or skip the printed handset and use an Opis 60s Micro (or any CTIA 3.5 mm handset): the bed is
shaped for its outline.

## Assembly

1. Press the heat-set inserts into the case: seven in the bottom bosses, four in the board bosses.
2. Fit the lens behind the display window (VHB ring) and push the light pipe into its tube.
3. Put the 13 caps on the switches, then lower the case over the board so every button comes up
   through its opening. Screw the board up into the case with four M3 x 5.
4. Plug the handset cord and the USB-C cable into the board (90-degree plugs fit best) and lead
   them out through the two holes in the bed pillow's side.
5. Drop the bottom plate in (its lip lines it up; it only goes one way) and fit the seven
   countersunk screws. Stick on the feet.

## Before printing: measure and tune

- **Your switches:** board top to the top housing (assumed 11.6 mm) and to the stem top
  (assumed 16.6 mm). They set the face height for the captive caps (`MX_HOUSING_TOP`,
  `MX_STEM_TOP` in `faceplate.py`).
- **The tongue** under the handset's lower cup is the hook mechanism: the cup rests on it and
  bends it onto the hook key. `TONGUE_T` in `plush.py` (1.4 mm) sets how stiff it is; a 200 g
  handset bends it about 4 mm. If the hook doesn't trigger, print it thinner; if it presses too
  hard, thicker.
- **Your handset:** the bed's cup pockets are 70 mm across, for the Opis 60s Micro's 68 mm cups.
