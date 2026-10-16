# Flat-cut case: a desk phone with a hinged cradle

A laser-cut sandwich for the minimal board. It lies flat on the table, with the core shell's
hinged handset cradle (`proto_box.py`). Every part comes from **one 380 × 160 mm sheet of 3 mm
acrylic** (or plywood). It's held together with M3 standoffs, screws and nuts, so you can order
the sheet cut and put it together at a table.

```sh
.venv/bin/python flatcase.py            # build/flatcase/: flatcase-sheet.dxf/.svg, one file per part, STL
.venv/bin/python flatcase.py --render   # also assembled.png
```

`flatcase-sheet.dxf` (or `.svg`) is the cut file: send it as it is (red lines are cuts). The
script checks the fit and the cradle every time it runs (see "Checked" below).

## How it's built

- **The front plate is the switch plate,** as on a keyboard:
  - each switch (the 12 keys and the hook key) stands in its own 14 mm opening;
  - the keycaps float above the plate, about 17 mm over it;
  - the display module plugs into its socket through a hole and stands 6 mm over the plate on
    two spacers at its far end;
  - the piezo stands up through a round hole, and the status light shows through a small one;
  - on the wired board, a notch at the right end leaves room for the RJ45 and the PoE module.
- **The board hangs under the front plate** on four 2 mm spacers. The plate's top is the
  switches' plate line, 5 mm over the board. Under the board there's 8.4 mm for the USB-C, the
  jack's plug and the hot-swap sockets.
- **Back plate:** four stick-on rubber feet, and pinholes for the board's RESET and BOOT buttons
  (lift the phone to reach them).
- **Five 12 mm standoffs** join the plates outside the board. The USB-C cable and the handset
  cord come out of the rear edge, between the plates.

It's 176 × 108 mm and 38 mm tall to the keycaps' tops, 89 mm with the handset on.

## The cradle

One arm, the only moving part, like the core shell's:

- **The arm** runs front to back over the hook key, at the left end. It's a small ladder: two
  fins 6 mm apart, joined by the two catches with halving joints.
- **The hinge** is at the rear-left, in front of the piezo: an M3 screw through two ears, which
  stand on the front plate, and through both fins.
- **The foot:** the fins' round front ends rest on the hook key's cap.
- **The catches** are two wide 90° V's (46 mm across) between the key rows. The handset lies front
  to back in them, earpiece to the rear.
- **The handset's weight** presses the hook key. Lift the handset and the key's own spring raises
  the arm.

The handset hangs out past the left, front and rear edges, as on the core shell. It's over the
hook key and one corner of the **1** key, and 5 mm clear of that key's cap. The other 11 keys and
the display stay free.

## What to buy

| Qty | Part | For |
|---|---|---|
| 1 | 380 × 160 mm sheet, 3 mm acrylic or plywood, laser cut | everything (`flatcase-sheet.dxf`) |
| 13 | Gateron KS-8 switches (or any MX-size switch) | the 12 keys and the hook key |
| 13 | 1u XDA keycaps, e.g. clear double-layer caps for paper labels | the keys and the hook key |
| 5 | M3 female-female standoff, 12 mm, + two M3 × 6 screws each | front plate to back plate |
| 4 | M3 × 10 button-head screw, M3 nut, 2 mm M3 spacer | hang the board under the front plate |
| 2 | M3 × 10 button-head screw + M3 nut | the ears' T-slot joints |
| 1 | M3 × 25 screw + M3 nyloc nut | the hinge pin |
| 2 | M2 female-female spacer, 6 mm, + an M2 × 5 and an M2 × 4 screw each | the display module's far end |
| 4 | stick-on rubber feet, about 12.7 mm across and 3.5 mm tall | under the back plate |
| | acrylic cement (or wood glue for plywood) | the arm's four halving joints |

## Assembly

1. **Ears on the front plate:** push the two ears' tabs into their slots from the top. For each,
   put a nut in its T-slot and screw it from under the plate with a button-head screw.
2. **Display spacers:** screw the 6 mm spacers onto the front plate with the M2 × 5 screws from
   underneath.
3. **Board under the plate:** put the 2 mm spacers between the board and the plate at the board's
   four holes. Screw it on with the M3 × 10 screws from the top, nuts under the board.
4. **Switches and keycaps:** press each switch through its opening into its hot-swap socket,
   then put the keycaps on (the hook key gets one too).
5. **Display:** plug the module into its socket through the plate and screw its far end to the
   spacers with the M2 × 4 screws.
6. **Arm:**
   - Slot the two catches down onto the two fins (the V's up, the fins' round ends to the
     front). Glue the four joints and let them set.
   - Lower the arm between the ears, round ends on the hook key's cap. Push the M3 × 25 screw
     through the ears and both fins.
   - Tighten the nyloc nut until the arm swings freely without wobbling. Press the arm's front
     end: the hook key should click and come back up when you let go.
7. **Close it:** screw the 12 mm standoffs to the back plate, set the front plate's assembly on
   them and screw it down. Stick a rubber foot near each corner of the back plate, clear of the
   screw heads.
8. Lay the handset in the catches, earpiece to the rear.

## Checked

Every run of `flatcase.py` checks:
- every part cuts as one piece and fits on the sheet;
- a pressed keycap clears the plate, and there's room for the jack's plug under the board;
- the arm's foot sits on the hook key's cap (within 0.05 mm);
- the handset sits in both catches and stays at least 2 mm from everything else, with the key
  pressed;
- the arm, with the key pressed, clears everything;
- the force on the hook key: about 106 gf with a 180 g handset (the key needs 60 at the bottom
  of its travel; a handset of about 100 g or more is enough), and 6 gf from the empty arm (under
  the key's 30, so it comes up when you lift the handset);
- nothing of the cradle is over the keys the handset leaves free, and the handset hangs over at
  most two keys.

## Measure first

- **Keycap height.** The foot's height follows the keycaps' tops, 22 mm over the board: the
  prototype box's estimate for XDA caps (`CAP_TOP` in `proto_box.py`, 17 mm over the plate line).
  Measure yours (plate line to cap top, with a cap on a switch) and set `CAP_TOP`, so the foot
  meets the hook key's cap. Both cases follow it.
- **Your handset.** It's drawn for an Opis 60s Micro-sized handset (68 mm cups, 210 mm long,
  `handset.py`). Set `HANDSET_G` to its weight. The catches take a handle up to about 46 mm
  wide; the check says if the cups come too close to the keys (raise `APEX` if they do).
- **Sheet thickness.** Acrylic sold as 3 mm is often 2.8–3.2 mm. Set `T` to what you have: the
  tab slots and halving joints are cut 0.2 mm wider than `T`. The switch openings stay 14 mm. With
  a thick sheet the switches' clips press on the openings' sides; the hot-swap sockets hold the
  switches.
