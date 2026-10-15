# Flat-cut case: a wall phone on a desk stand

A laser-cut sandwich for the minimal board. Every part comes from **one 450 × 300 mm sheet of 3 mm
acrylic** (or plywood). It's held together with M3 standoffs, screws and nuts, so you can order
the sheet cut and assemble it at a table. It stands tilted back 25° on two flat legs, like a
wall phone on a desk; take the legs off and it hangs on a wall from two keyholes.

```sh
.venv/bin/python flatcase.py      # build/flatcase/: flatcase-sheet.dxf/.svg, one file per part, STL
```

`flatcase-sheet.dxf` (or `.svg`) is the cut file: send it as it is (red lines are cuts).

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
- **Back plate:** pinholes for the board's RESET and BOOT buttons, a slot at the top for the
  USB-C cable and the handset cord, two keyholes for a wall, and slots for the legs.
- **Six 12 mm standoffs** join the plates outside the board: three at the body's corners, three
  on the tower.
- **The handset** hangs on the tower on the left, its centreline straight above the hook key:
  - its mouthpiece cup sits on the ledge of **one rocker**, which turns on an M3 screw between
    two fixed **ears** just above the hook key;
  - its weight tips the rocker, and the rocker's tail presses the hook key's cap, with several
    times the force the key needs;
  - when you lift the handset, the key's spring pushes the tail back up to the key's top, which
    leaves the ledge level;
  - a **J-hook** at the top reaches over the earpiece so the handset can't tip forward.
- **Hung up, the mouthpiece cup sits over keys 1 and 6,** about 14 mm above their caps. Lift the
  handset to dial, as on a wall phone.
- **The ears, the J-hook and the legs** stand in slots and are held by an M3 screw and a nut in
  a T-slot (the usual laser-cut joint). The ears' and the J-hook's screws go in from under the
  front plate, so they need button heads to fit in the 2 mm under it.
- **Why 25°:** with the handset on, the phone's weight sits close to its front edge. At 15° it
  would tip forward; at 25° the centre of mass is about 20 mm inside the feet.

## What to buy

| Qty | Part | For |
|---|---|---|
| 1 | 450 × 300 mm sheet, 3 mm acrylic or plywood, laser cut | everything (`flatcase-sheet.dxf`) |
| 13 | Gateron KS-8 switches (or any MX-size switch) | the 12 keys and the hook key |
| 13 | 1u XDA keycaps, e.g. clear double-layer caps for paper labels | the keys and the hook key |
| 6 | M3 female-female standoff, 12 mm | front plate to back plate |
| 12 | M3 × 6 screw | the standoffs |
| 4 | M3 × 10 button-head screw, M3 nut, 2 mm M3 spacer | hang the board under the front plate |
| 5 | M3 × 10 button-head screw + M3 nut | the T-slot joints (2 ears, the J-hook, 2 legs) |
| 1 | M3 × 16 screw + M3 nyloc nut | the rocker's pivot |
| 2 | M2 female-female spacer, 6 mm, + an M2 × 5 and an M2 × 4 screw each | the display module's far end |
| 4 | small rubber bumpers (optional) | under the back plate's bottom edge and the legs' feet |

## Assembly

1. **Fins on the front plate:** push the two ears and the J-hook into their slots from the front.
   For each, put a nut in its T-slot and screw it from under the plate with a button-head screw.
2. **Rocker:** put the rocker between the ears and push the M3 × 16 screw through all three.
   Tighten the nyloc nut until the rocker turns freely without wobbling.
3. **Display spacers:** screw the 6 mm spacers onto the front plate with the M2 × 5 screws from
   underneath.
4. **Board under the plate:** put the 2 mm spacers between the board and the plate at the board's
   four holes. Screw it on with the M3 × 10 screws from the front, nuts under the board.
5. **Switches and keycaps:** press each switch through its opening into its hot-swap socket,
   then put the keycaps on. Check that the rocker's tail rests on the hook key's cap.
6. **Display:** plug the module into its socket through the plate and screw its far end to the
   spacers with the M2 × 4 screws.
7. **Close it:** screw the 12 mm standoffs to the back plate, set the front plate's assembly on
   them and screw it down.
8. **Legs:** push them into the back plate's slots and screw them on. Hang the handset with its
   mouthpiece cup on the rocker's ledge and its earpiece under the J-hook.

## Measure first

- **Keycap height.** The rocker's height follows the keycaps' tops: `KEYCAP_TOP` is 20 mm over
  the board, about right for 10 mm XDA caps on MX-size switches. Measure yours (board top to cap
  top, with a cap on a switch) and set it, so the tail meets the hook key's cap.
- **Your handset.** It's drawn for an Opis 60s Micro-sized handset (68 mm cups, 210 mm long).
  The rocker's ledge, the tower's height and the J-hook follow `handset.py`.
- **Sheet thickness.** Acrylic sold as 3 mm is often 2.8–3.2 mm. Set `T` to what you have: the
  tab slots are cut 0.2 mm wider than `T`. The switch openings stay 14 mm. With a thick sheet the
  switches' clips press on the openings' sides; the hot-swap sockets hold the switches.
