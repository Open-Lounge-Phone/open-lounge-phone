# Plush series: the cushion desk case

A fat, cushion-like case that lies flat on a table, for the minimal board. Two pillows fused like
a sofa cushion: the keypad pillow, whose rounded top is the key face, and beside it a taller
pillow that is the handset's bed. Every edge is rounded and the bed is one solid cushion with a
soft-rimmed pocket for each cup. Rigid print, made to look inflated. Generate the files with:

```sh
.venv/bin/python handset.py     # the handset (render model + printable shell and caps)
.venv/bin/python plush.py       # the case, the bottom plate and the keycaps
```

Outputs: `build/plush/` and `build/handset/` (STEP for editing, STL for printing).

## How it works

- **Keys:** captive caps. A flange sits under the face and a puffy button comes up through it,
  so a cap can't be pulled off and the switch can't be pulled out.
- **Hook:** the hook key's button rises through the floor of the lower cup's pocket, like a
  classic cradle's plunger. When the handset is on the bed, the weight of its lower cup presses the
  button about 2.7 mm (the switch triggers at 2) and the pocket floor stops it. There are no springs
  or levers beyond the switch itself.
- **Status light:** a straight light pipe runs from the board's LED to a jewel on the bed's front.
- **Buzzer:** it sounds out through a slotted grille in the bottom plate. The feet lift the plate
  enough to let the sound out.
- **Closing it:** the bottom plate drops in on a locating lip (it only fits one way). Five
  countersunk screws, hidden under the rubber feet, go up into heat-set inserts in columns
  moulded into the top shell.

## What to print

| Part | File | Qty | Notes |
|---|---|---|---|
| Case (top shell) | `plush-case` | 1 | 222 x 228 x 46 mm. Print upside down (open side up) |
| Bottom plate | `plush-bottom` | 1 | 3.5 mm thick. Print flat with the lip up |
| Keycaps | `caps/puffy-1` ... `puffy-0`, `puffy-menu`, `puffy-back` | 12 | Captive: a flange under the face and a puffy button with an engraved legend |
| Hook key cap | `caps/puffy-hook` | 1 | Round-topped: the lower cup rests on it |
| Handset shell | `handset-shell` | 1 | Optional: a printed handset. One smooth piece, hollow from mouthpiece to earpiece. Print on its back (SLS/MJF is ideal; on FDM, use supports inside the cups) |
| Handset caps | `handset-cap-earpiece`, `handset-cap-mouthpiece` | 1 each | Screw onto the cups from below |

Any rigid material works: PETG, PLA, ABS/ASA, or nylon (SLS/MJF) for the toughest finish.

## What to buy

| Item | Qty | For |
|---|---|---|
| M3 x 8 countersunk screw (ISO 10642) | 5 | the bottom plate into the case |
| M3 x 4 heat-set insert, OD 4.0-4.2 | 5 | the case's columns |
| M3 x 3 heat-set insert + M3 x 5 screw | 4 each | the board, up through its four holes into the case |
| Rubber feet, 10 mm round, stick-on | 5 | the recesses over the plate screws |
| Clear polycarbonate, 58 x 32 x 2 mm | 1 | display lens (VHB tape ring behind the lip) |
| 3 mm clear acrylic rod, about 62 mm | 1 | status light pipe |
| A standard linear MX switch | 13 | the 12 keys and the hook |
| For the printed handset: M2.5 x 6 self-tapping screws | 6 | the two caps |
| For the printed handset: a speaker up to 30 mm, a 9.7 mm electret mic capsule, a coiled 4-wire cord with a 3.5 mm TRRS plug | 1 each | inside the caps |

Or skip the printed handset and use an Opis 60s Micro (or any CTIA 3.5 mm handset). The bed's
pockets are 70 mm across, sized for its 68 mm cups.

## Assembly

1. Press in the heat-set inserts: five in the columns, four in the board bosses.
2. Fit the lens behind the display window (VHB ring) and push the light pipe into its tube until
   it sits in the jewel.
3. Put the 13 caps on the switches, then lower the case over the board so every button comes up
   through its opening. Screw the board up into the case with four M3 x 5 screws.
4. Plug the handset cord and the USB-C cable into the board (90-degree plugs fit best) and lead
   them out through the two holes in the side of the bed pillow.
5. Drop the bottom plate in and fit the five countersunk screws. Stick a foot over each one.

## Before printing: measure and tune

- **Your switches:** measure from the board top to the top of the switch housing (assumed
  11.6 mm) and to the top of the stem (assumed 16.6 mm). These set the face height for the
  captive caps (`MX_HOUSING_TOP`, `MX_STEM_TOP` in `faceplate.py`).
- **Your handset:** the hook needs the lower cup to press the button at least 2 mm. With the
  modelled handset it presses about 2.7 mm. If yours is lighter, use a lighter switch; if it
  doesn't sit flat, check that its cups fit the 70 mm pockets.
