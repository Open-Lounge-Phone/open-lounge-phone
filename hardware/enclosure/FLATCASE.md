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

- **Front plate:** the keys come up through two long row slots (one per row of six), the hook
  key through its own hole, the e-paper through a window. It also has a hole for the status light
  and slots over the ringer.
- **Board:** on four 8 mm standoffs on the back plate.
- **Back plate:** pinholes for the board's RESET and BOOT buttons, a slot at the top for the
  USB-C cable and the handset cord, two keyholes for a wall, and slots for the legs.
- **Six 25 mm standoffs** join the plates: three at the body's corners, three on the tower. They
  stand outside the board, clear of the keycaps.
- **The handset** hangs on the tower on the left, its centreline straight above the hook key:
  - its mouthpiece cup sits on the ledge of **one rocker**, which turns on an M3 screw between
    two fixed **ears** just above the hook key;
  - its weight tips the rocker, and the rocker's tail presses the hook key, with several times
    the 45–60 gf the key needs;
  - when you lift the handset, the key's spring tips the rocker back, and a heel on the rocker
    stops it level;
  - a **J-hook** at the top reaches over the earpiece so the handset can't tip forward.
- **Hung up, the mouthpiece cup sits over keys 1 and 6,** about 14 mm above their caps. Lift the
  handset to dial, as on a wall phone.
- **The ears, the J-hook and the legs** stand in slots and are held by an M3 screw and a nut in
  a T-slot (the usual laser-cut joint).
- **Why 25°:** with the handset on, the phone's weight sits close to its front edge. At 15° it
  would tip forward; at 25° the centre of mass is about 20 mm inside the feet.

## What to buy

| Qty | Part | For |
|---|---|---|
| 1 | 450 × 300 mm sheet, 3 mm acrylic or plywood, laser cut | everything (`flatcase-sheet.dxf`) |
| 6 | M3 female-female standoff, 25 mm | front plate to back plate |
| 4 | M3 female-female standoff, 8 mm | board to back plate |
| 20 | M3 × 6 screw | the standoffs (12 for the long ones, 8 for the board) |
| 5 | M3 × 10 screw + M3 nut | the T-slot joints (2 ears, the J-hook, 2 legs) |
| 1 | M3 × 16 screw + M3 nyloc nut | the rocker's pivot |
| 2 | M2 × 10 screw, M2 nut, 3 mm M2 nylon spacer | hang the display module's far end from the front plate |
| 13 | MX switch (linear) + keycaps | the 12 keys and the hook key |
| 4 | small rubber bumpers (optional) | under the back plate's bottom edge and the legs' feet |

## Assembly

1. **Board:** screw the 8 mm standoffs to the back plate. Set the board on them and screw it
   down from the front (M3 × 6 through its four holes).
2. **Switches and the display:**
   - Put the switches in their sockets.
   - Plug in the display module.
   - Put the keycaps on.
3. **Fins on the front plate:** push the two ears and the J-hook into their slots from the front.
   For each, put a nut in its T-slot and screw it from the back of the plate (do this before the
   plate goes on).
4. **Rocker:** put the rocker between the ears and push the M3 × 16 screw through all three.
   Tighten the nyloc nut until the rocker turns freely without wobbling. Check that its tail
   rests on the hook key's cap.
5. **Display module:** hang its far end from the front plate with the M2 screws and spacers.
6. **Close it:** screw the 25 mm standoffs to the back plate. Set the front plate on them so the
   keycaps come up through the slots, and screw it down.
7. **Legs:** push them into the back plate's slots and screw them on. Hang the handset with its
   mouthpiece cup on the rocker's ledge and its earpiece under the J-hook.

## Measure first

- **Keycap height.** The front plate sits 15.4 mm above the board, which suits keycaps whose tops
  are about 20 mm above the board (`KEYCAP_TOP`). For taller or shorter caps, change `COLUMN`
  (the standoff length) so the caps stand 2–4 mm proud of the front, and set `KEYCAP_TOP` so the
  rocker's tail meets the hook key's cap.
- **Your handset.** It's drawn for an Opis 60s Micro-sized handset (68 mm cups, 210 mm long).
  The rocker's ledge, the tower's height and the J-hook follow
  `handset.py`.
- **Sheet thickness.** Acrylic sold as 3 mm is often 2.8–3.2 mm. Set `T` to what you have: the
  tab slots are cut 0.2 mm wider than `T`.
