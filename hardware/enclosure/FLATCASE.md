# Flat-cut case: a wall phone like the core

A laser-cut sandwich for the minimal board, with the core wall phone's switchhook. Every part
comes from **one 380 × 190 mm sheet of 3 mm acrylic** (or plywood). It's held together with M3
standoffs, screws and nuts, so you can order the sheet cut and assemble it at a table. It hangs
on a wall from two screws; it needs no stand.

```sh
.venv/bin/python flatcase.py      # build/flatcase/: flatcase-sheet.dxf/.svg, one file per part, STL
```

`flatcase-sheet.dxf` (or `.svg`) is the cut file: send it as it is (red lines are cuts). The
script checks the fit and the switchhook every time it runs (see "Checked" below).

## How it's built

- **The front plate is the switch plate,** as on a keyboard:
  - each switch (the 12 keys and the hook key) stands in its own 14 mm opening;
  - the keycaps float above the plate, 15 mm over it;
  - the display module plugs into its socket through a hole and stands 6 mm over the plate on
    two spacers at its far end;
  - the piezo stands up through a round hole, and the status light shows through a small one.
- **The board hangs under the front plate** on four 2 mm spacers. The plate's top is the
  switches' plate line, 5 mm over the board. Under the board there's 8.4 mm for the USB-C, the
  jack's plug and the hot-swap sockets.
- **Back plate:** two keyholes for the wall screws, and pinholes for the board's RESET and BOOT
  buttons (take it off the wall to reach them).
- **Five 12 mm standoffs** join the plates outside the board. The USB-C cable and the handset
  cord come out of the top edge, between the plates.

## The switchhook

One rocker, its centreline straight above the hook key, as on the core wall phone:

- **The ear** is a wide flat fork standing out from the wall at the top of the face. The earpiece
  cup sits between its two prongs, with the handle hanging down between them. A short post on
  each prong's tip (a lip) keeps the cup from sliding off the front.
- **The stem** is a long fin. It runs from the ear down the face, turns on an M3 screw between
  two lugs, and rests its round end on the hook key's cap.
- **The handset's weight** tips the ear down, and the stem presses the hook key. When you lift the
  handset, the key's own spring pushes the stem back up.
- **Two rests** stand out from the bottom of the face, under the mouthpiece. The handset leans its
  bottom on them, so it hangs straight and stays off the keys.

Hung up, the handset covers the hook key and the left end of the key rows. Lift it to dial, as on
a wall phone.

## What to buy

| Qty | Part | For |
|---|---|---|
| 1 | 380 × 190 mm sheet, 3 mm acrylic or plywood, laser cut | everything (`flatcase-sheet.dxf`) |
| 13 | Gateron KS-8 switches (or any MX-size switch) | the 12 keys and the hook key |
| 13 | 1u XDA keycaps, e.g. clear double-layer caps for paper labels | the keys and the hook key |
| 5 | M3 female-female standoff, 12 mm, + two M3 × 6 screws each | front plate to back plate |
| 4 | M3 × 10 button-head screw, M3 nut, 2 mm M3 spacer | hang the board under the front plate |
| 2 | M3 × 10 button-head screw + M3 nut | the lugs' T-slot joints |
| 1 | M3 × 16 screw + M3 nyloc nut | the rocker's pivot |
| 1 | M3 × 8 screw + M3 nut | holds the ear down on the stem |
| 2 | M3 female-female standoff, 8 mm, + two M3 button-head screws each | the lips on the ear |
| 2 | M3 female-female standoff, 40 mm, + two M3 button-head screws each | the rests |
| 2 | M2 female-female spacer, 6 mm, + an M2 × 5 and an M2 × 4 screw each | the display module's far end |
| 2 | wall screws (head under 9 mm across and 3 mm tall) + wall plugs | hang it |

## Assembly

1. **Lugs and rests on the front plate:** push the two lugs into their slots from the front. For
   each, put a nut in its T-slot and screw it from under the plate with a button-head screw.
   Screw the two 40 mm rests on at the bottom.
2. **Display spacers:** screw the 6 mm spacers onto the front plate with the M2 × 5 screws from
   underneath.
3. **Board under the plate:** put the 2 mm spacers between the board and the plate at the board's
   four holes. Screw it on with the M3 × 10 screws from the front, nuts under the board.
4. **Switches and keycaps:** press each switch through its opening into its hot-swap socket,
   then put the keycaps on.
5. **Display:** plug the module into its socket through the plate and screw its far end to the
   spacers with the M2 × 4 screws.
6. **Rocker:**
   - Screw the two 8 mm lips onto the ear's prong tips.
   - Slide the ear down over the stem's top until it sits on the stem's shoulder. Put the
     M3 × 8 screw through the hole just above it and nut it, so the ear can't lift off.
   - Put the stem between the lugs and push the M3 × 16 screw through all three. Tighten the
     nyloc nut until the rocker turns freely without wobbling.
   - Check that the stem's round end rests on the hook key's cap.
7. **Close it:** screw the 12 mm standoffs to the back plate, set the front plate's assembly on
   them and screw it down.
8. **Hang it:**
   - Mark the keyholes on the wall (they're 80 mm apart). Put in the screws, leaving the heads
     standing about 4 mm out.
   - Hang it so the heads drop to the tops of the slots.
   - Hang the handset with its earpiece cup between the ear's prongs and its back to the wall.

## Checked

Every run of `flatcase.py` checks:
- every part cuts as one piece and fits on the sheet;
- a pressed keycap clears the plate, and there's room for the jack's plug under the board;
- the handset touches nothing but the ear, the lips and the rests;
- the stem rests on the hook key, and the pressed rocker clears everything;
- the force on the hook key: about 140 gf with a 180 g handset, and about 5 gf with nothing on
  the hook (the key needs 30–60, so it comes up when you lift the handset).

## Measure first

- **Keycap height.** The stem's height follows the keycaps' tops: `KEYCAP_TOP` is 20 mm over the
  board, about right for 10 mm XDA caps on MX-size switches. Measure yours (board top to cap top,
  with a cap on a switch) and set it, so the stem meets the hook key's cap.
- **Your handset.** It's drawn for an Opis 60s Micro-sized handset (68 mm cups, 210 mm long,
  `handset.py`). Set `HANDSET_G` to its weight. A different cup shape moves the lips (`LIP_Z`);
  the check says if they miss or touch it.
- **Sheet thickness.** Acrylic sold as 3 mm is often 2.8–3.2 mm. Set `T` to what you have: the
  tab slots are cut 0.2 mm wider than `T`. The switch openings stay 14 mm. With a thick sheet the
  switches' clips press on the openings' sides; the hot-swap sockets hold the switches.
