# Open Lounge Phone enclosure (r0.1, form factor "A — Compact")

Code-CAD (build123d, Python) for the 3D-printable base and hook rest, plus reference models of the
handset. Everything comes from `params.yaml`; board geometry is synced from the KiCad files.

```
cd hardware/enclosure
make            # STL + STEP per part, checks, renders, web GLBs  (fails on any FAIL check)
make sync       # re-read hardware/kicad/*/*.kicad_pcb into the SYNCED block of params.yaml
make fast       # same as make without the PNG renders
```

The toolchain is build123d 0.13 (OpenCascade 7.8) in `.venv/` (Python 3.13; `make venv` creates it, no
sudo). Renders use matplotlib; GLBs use trimesh. A full build takes about 14 minutes on the owner's Mac (most of it is the matplotlib renders;
`make fast` skips them). The web export is 18 GLBs, 1.4 MB in total, at most 22.5k triangles per part.

## 1. What it looks like

- **Base:** a compact cream slab, 186 × 94 × 33 mm, 45° chamfered top edge, in two printed
  pieces: a top shell and a bottom tray. They meet at a step joint at z = 14 (two-tone line) and are
  closed by four M2.5 screws from underneath, so no fasteners show on top.
- **Keypad:** 12 captive DSA keycaps (`1 2 3 4 5 MENU / 6 7 8 9 0 BACK`), with the e-ink window
  between the rows. The Lite variant of the top shell has no window.
- **Hook rest:** two short drop-in metal tube posts, each with a printed saddle insert. The
  handset lies with its cups on the saddles, toward the rear, with its handle bridging above the
  keys (34 mm finger clearance). The overall height is 96 mm with the POP-type handset.
- **Hook switch:** a spring plunger inside each tube. The handset's cup face pushes it down, and
  the 3 × 1.5 mm magnet in its tip then sits 4–5 mm above the DRV5032 hall sensor on the main
  board.
- **Handset:** an off-the-shelf USB-C retro handset (Native Union POP class). A classic Western
  Electric G1/G3 also fits, using the `g1` saddle inserts. An optional printable DIY G1 handset is
  included (lower priority, see §9).

Renders: `build/renders/` (`assembled_3q.png`, `assembled_g1_3q.png`, `assembled_top.png`,
`assembled_front.png`, `assembled_rear.png`, `exploded.png`, `section_key_stack.png`,
`section_hook_post.png`, `handset_vs_reference.png`, `parts/*.png` in print orientation).
Earlier concept stills `look_*.png` were used for choosing A/B/C. Their generator has been removed:
they are superseded by these renders.

## 2. Handset research (sources, and what is estimated)

| Item | Value used | Source / status |
|---|---|---|
| Native Union POP (USB-C retro handset) overall | 230 × 55 × 55 mm, 252 g, coiled cable 50–320 cm, fixed cord with USB-C plug | [nativeunion.com — POP Phone](https://www.nativeunion.com/products/pop-phone) (dimensions/weight quoted verbatim) |
| POP cup diameter | 55 mm | = product width (same source) |
| POP cup-centre distance | 175 mm | **estimated** from product photos (`hardware/art/reference-handset-modern.jpg`) |
| POP cup tilt | 10° | **estimated** from photos |
| POP cable exit | outer end of the mouthpiece cup, low | from the product photo |
| WE G-type handset | angular G1 replaced the F1 on the model 500; model 500/2500 cradles take both F and G | [Wikipedia: Western Electric hand telephone sets](https://en.wikipedia.org/wiki/Western_Electric_hand_telephone_sets), [Wikipedia: Model 500 telephone](https://en.wikipedia.org/wiki/Model_500_telephone), [Bell System Memorial — handsets](https://memorial.bellsystem.com/telephones-technical-handsets.html) |
| T1 transmitter element (sits in a G mouthpiece) | Ø 1.814 in (46.1 mm) × 0.540 in (13.7 mm) | [G-Tel Enterprises — carbon transmitter](https://payphone.com/carbon-xmit.html) |
| G1 overall length | 216 mm (≈ 8.5 in) | **estimated**; no published dimension found |
| G1 cup Ø ear / mouth | 54 / 52 mm | **estimated** (mouthpiece must hold the 46.1 mm T1 plus cap) |
| G1 cup-centre distance | 162 mm | **estimated** from `hardware/art/reference-g-handset.jpg` |
| G1 handle | faceted octagon ≈ 30 × 24 mm, 45° end facets | **estimated** from the photo |
| G1 cup tilt toward each other | 12° | **estimated** (10–15°) |

I could not find any published G1/G3 drawing, and the U1 receiver diameter was not found either. The
saddles are therefore made forgiving on purpose. Each is a self-centring half-dish with a catch rim;
the seat is centred on each family's cup and tilted to its face. The tube posts stay at ±81 mm, so
a different handset only needs a different printed insert.
**Before freezing, measure a real POP and a real G1** (overall length, cup Ø, cup-centre distance,
cup-face tilt, face-to-handle-top height) and update `params.yaml → handset / handset_alt`.

## 3. Parts

Printed parts are exported to `build/stl/<name>.stl` in print orientation, ready to slice, and to
`build/step/<name>.step` in the assembled position for editing. There is also `build/step/assembly.step`,
plus `build/step/ref_handset_{pop,g1}.step` (reference models, not printed).

| Part | Qty | Size on bed (mm) | Orientation | Notes |
|---|---|---|---|---|
| base_top | 1 | 186 × 94 × 24.5 | skin down (upside down) | e-ink window; key holes; tube sockets; speaker box; port labels |
| base_top_lite | (alt) | 186 × 94 × 24.5 | skin down | Kids Lite, no display window |
| base_bottom | 1 | 186 × 94 × 17 | floor down | standoffs, feet, keyholes, text + logo, VOL flexures |
| saddle_pop_left / _right | 1 + 1 | 46.5 × 64 × 10.7 | flat bottom down | for POP-type USB-C handsets |
| saddle_g1_left / _right | (alt) | 40 × 64 × 10.7 | flat bottom down | for WE G1/G3 handsets |
| plunger | 2 | 9 × 9 × 27.5 | tip (magnet end) down | Ø6 pin, Ø9 collar with a 45° underside |
| speaker_lid | 1 | 25 × 51 × 4.5 | flat | closes the top-firing speaker box |
| light_bar | 1 | 63.7 × 4.1 × 3.3 | flange down | translucent PETG, front status light line |
| key_plate_printed | (alt) | 117 × 84 × 1.5 | flat | instead of the FR4 plate from the PCB fab |
| handset_diy_g1_left / _right | (optional) | 218 × 57 × 27 | split face down | **needs supports inside** (see §9) |

Every part fits a 220 × 220 mm bed (checked).

## 4. Print settings

- **Material:** PETG for everything; PLA also works for the key plate. Use translucent PETG for
  `light_bar`.
- **Layers:** 0.2 mm layer height, 0.4 mm nozzle, 4 perimeters (walls are 2.2 mm, about 5 lines).
  Infill 25 % gyroid for the shells, 100 % for the plunger, saddles and key plate.
- **Supports:** none needed for any base part in the stated orientation. The overhang check
  flags only hole and text edges (under 120 mm² on the top shell) and short bridges: the key-hole
  webs and pinhole-tube tops.
- **Bridges:** the top shell prints skin-down, so the only long bridges are the speaker box lid
  step and the keyhole chamber roofs (8.5 mm). Enable bridge settings.
- **Brim:** use a brim for the plunger (small footprint, 27.5 mm tall).
- **Heat-set inserts:** M2.5 × 4 × Ø3.5 knurled brass inserts into Ø3.6 × 5 mm holes. Install at
  about 230 °C with an insert tip before assembly.

## 5. Hardware BOM (per phone)

| Item | Qty | Spec |
|---|---|---|
| Heat-set inserts | 17 | M2.5 × 4 mm, Ø3.5 OD knurled brass: 4 shell bolts, 2 speaker lid, 5 deck-stack top screws (into hex standoffs, no insert), 2 grub-screw sockets in the shell, 2 in the saddles, plus spares |
| Screws, shell | 4 | M2.5 × 12 button head (ISO 7380): tray → main board → top-shell insert |
| Screws, deck stack bottom | 5 | M2.5 × 8 button head: tray → main board → hex standoff |
| Screws, deck stack top | 5 | M2.5 × 6 countersunk (DIN 7991): plate → 3.5 mm spacer → deck board → hex standoff |
| Hex standoffs | 5 | M2.5 × 7 mm female–female (board-to-board) |
| Spacers | 5 | M2.5 × 3.5 mm nylon (deck board → key plate) |
| Screws, speaker lid | 2 | M2.5 × 6 button head |
| Grub screws | 4 | M2.5 × 4 cup point: tube in the shell socket, saddle on the tube |
| Tube posts | 2 | Ø12 × 1 mm aluminium, brass or stainless tube, **17.0 mm long**, straight cut, deburred (cut list: `build/summary.json → tube_cut_list`) |
| Springs | 2 | compression spring, OD 8–8.5 mm, wire 0.25–0.3 mm, free length 20 mm, rate about 0.03 N/mm (any "OD 8 × 0.3 × 20" assortment spring). Pressed to 7 mm on-hook, 15 mm off-hook |
| Magnets | 2 | Ø3 × 1.5 mm N35 disc, press-fit into the plunger tip (only the right post's is sensed; the left is symmetric and spare) |
| Speaker | 1 | 20 × 40 × ≤5.5 mm rectangular 8 Ω 1–2 W (replaces DESIGN.md's Ø40 round; see §8) |
| Foam | — | 1 mm closed-cell gasket around the speaker; EVA foam pad (8 mm) under the e-ink panel; foam pad on the speaker lid |
| Feet | 4 | 12.7 × 3.5 mm self-adhesive bumpons (3M SJ-5302 class), in 1 mm recesses |
| Handset | 1 | off-the-shelf USB-C retro handset (POP class), or a WE G1 with a USB-C adapter handset |
| Cable | — | the handset's own fixed coiled USB-C cord (plugs into the rear `HANDSET` port) |

## 6. Assembly

1. **Heat-set inserts:** top shell (4 bolt bosses, 2 speaker-lid bosses, 2 grub-screw holes in
   the tube sockets) and saddles (1 grub hole each).
2. **Plungers:** press a magnet into each plunger tip. Slide a spring onto each pin from below,
   against the collar.
3. **Posts:** push a plunger up through a tube, then into the socket from the top of the shell,
   pin up; the pin comes out through the socket floor bore. Fix the tube with its grub screw.
   Press the saddle (pop or g1 family, left or right) onto the tube top with the pin through the
   hub, crescent facing outward, and fix it with its grub screw. The pin should stick 8 mm above
   the seat and spring back.
4. **Top shell, from inside:** fit the speaker (with gasket) into its box and put a foam pad on
   its magnet, then screw on the speaker lid. Push the light bar into the front slot from inside.
5. **Key deck:** clip the switches into the key plate. Put the keycaps on the switches **before**
   the top shell goes on (captive keycaps can only go in from inside). Mount the plate on the deck
   board: plate → 3.5 mm spacers → deck board → M2.5 × 7 hex standoffs, with countersunk screws
   from the plate side. Lay the e-ink panel on its foam pad in the plate pocket, FPC through the slot.
6. **Main board:** place it in the tray on the standoffs. Screw the five deck stacks from under
   the tray into the hex standoffs; the deck sits exactly over its footprint. Connect the FFC and
   speaker.
7. **Close:** lower the top shell straight down. The keycaps pass up through their holes, the
   tray lip registers the shell, and the plunger pins drop through the main-board clearance. Drive
   the 4 shell screws from below. Stick on the feet.
8. **Handset:** plug its USB-C cord into the rear `HANDSET` port (the power cable goes into `5V`),
   run the cord along the rear channel to the left end, and hang the handset on the saddles.

## 7. Fit checks performed (automated, `build/checks.txt`)

Latest `make`: **79 pass, 7 warn, 0 fail**; see `build/checks.txt` for every line.
The warnings are the intent main board, intentional thin features, the top-shell hole/text-edge
overhangs, the DIY handset supports and the antenna keep-out. Summary:

- **Bed:** every printed part ≤ 220 × 220 mm.
- **Boards:** the main board (180 × 88, intent) and the deck (117 × 84) sit inside the walls
  (0.6 / 2.8 mm gap). Parts under the deck footprint must be ≤ 4.7 mm tall.
- **Holes:** probe points confirm every main-board hole lands on a tray standoff and every shell
  bolt on a top-shell boss. All 5 deck holes have a main-board hole below them (hex-standoff
  stacks).
- **Interference** (≤ 0.5 mm³), assembled on-hook: the top shell and tray are checked against each
  other and against both PCBs, key plate, switches, keycaps at rest, e-ink panel, speaker, USB-C
  bodies, radar module, hex standoffs, tubes, plungers, speaker lid, light bar, saddles and both
  handsets. The saddles are checked against the handsets, plungers and tubes. Plungers are also
  checked off-hook (lifted 8 mm) against the saddles.
- **Captive keycaps:**
  - The hole is 17.20 mm square, against the DSA skirt of 18.20 mm (0.5 mm lip per side). The cap
    is 16.40 mm wide at skin level, and the skirt sits 2.49 mm under the skin.
  - Pressed caps (4 mm travel) clear the skin; the pressed cap top is 0.89 mm below the skin top.
  - Geometric pull test: 12 of 12 caps hit the skin.
- **Key stack:**
  - Deck PCB top 17.11, plate top 22.11, cap base 28.51, cap top 36.11 mm.
  - Skin 31–33 mm; body height 33 mm.
- **Walls:** 2.2 mm walls and floor, 2.0 mm skin (≥ 2.0). The intentionally thin features are
  listed separately.
- **Overhangs** (> 45° from vertical, off the bed) in print orientation:
  - Every base part passes, apart from a warning on the top shell for hole and text edges.
  - The DIY handset needs internal supports.
- **Hook sensing** (on-axis magnet model):
  - POP handset: 9.2 mT on-hook (5.1 mm, because the POP cup sits 6.5 mm outboard of the pin).
  - G1 handset: 17.1 mT on-hook (4.0 mm).
  - Off-hook: 0.96 mT at 12 mm.
  - Needed: ≥ 6.8 mT on, ≤ 1.2 mT off (DRV5032FA thresholds **UNVERIFIED**, check the datasheet).
- **Spring:** 0.39 N on-hook vs 1.24 N (POP) / 1.47 N (G1) handset weight per cup, and 0.15 N
  to lift the plunger off-hook.
- **Finger clearance** (vertical rays from every keycap top to the handset): 34.0 mm under the
  POP, 33.0 mm under the G1 (target 30–35). The handset is over the 6 rear keys; the front row
  and the e-ink strip are open from above.
- **Overall height:** 96.1 mm with POP, 93.1 mm with G1 (target 95–100).
- **Radar:** the antenna face sits 12.4 mm behind the 0.9 mm radome (target 12.4 ± 1.2). The
  LD2410C position is an intent requirement (see §8).

## 8. Requirements for the layout agent (main board, from `params.yaml → main_intent`)

The synced main board (200 × 100) does not fit base A, so the enclosure is built around this
**intent** until the KiCad board matches. `make sync` switches to the real board automatically
once it fits. The board frame used below is KiCad's: x right, y down from the rear edge.

| Requirement | Board coordinates (mm) |
|---|---|
| Outline | **180 × 88**, corner radius **≥ 8.5** (clears the shell's inner corner radius) |
| Deck footprint (deck board on 7 mm hex standoffs) | x 31.5–148.5, y 1.8–85.8. Parts under it must be **≤ 4.7 mm** tall |
| Mounting holes, deck stack (M2.5, under the 5 deck holes) | (34.7, 5.0) (145.3, 5.0) (34.7, 82.6) (145.3, 82.6) (145.1, 29.4) |
| Mounting holes, shell bolts | (5.0, 29.8) (26.0, 29.8) (154.0, 29.8) (176.0, 29.8) |
| Hall sensor U10 (DRV5032) | **(171.0, 18.8)**, centred under the right plunger. Keep Ø12 mm around it free of parts taller than 3 mm |
| Left plunger passes at | (9.0, 18.8): keep Ø10 free of parts taller than 4 mm |
| USB-C power J1 | x 159.0 at the rear edge (same footprint and edge position as now) |
| **USB-C handset port** (replaces RJ9) | x 24.0 at the rear edge (same footprint as J1) |
| LD2410C socket J5 | (162.0, 66.4), facing the front; the module face ends 12.4 mm behind the radome |
| Base mic MK1 | (155.0, 58.8), ported up through the shell top |
| RESET / BOOT pinholes SW1 / SW2 | (157.0, 46.8), (165.0, 46.8), top side, tact switches ≤ 1.5 mm |
| **VOL− / VOL+ / MUTE** (moved from the deck: the deck edge is now buried inside the shell) | right edge x ≈ 179, y 70.8 / 62.8 / 53.8, right-angle side-actuated switches reaching the flexure tabs / slot in the right end wall at z ≈ 10 mm |
| Speaker connector J4 | around (17, 35.8), left end, outside the deck footprint (the speaker box above is at z ≥ 15) |
| Tall parts (supercap, FFC, battery/speaker connectors) | outside the deck footprint, in the end regions x < 31.5 or x > 148.5 |
| ESP32 antenna | at a board edge ≥ 15 mm from the metal tubes (board (9, 18.8) and (171, 18.8)), the hex standoffs and the brass inserts |
| Status light line | side-view LEDs on the deck front edge behind the 60 mm light bar (x centred, z ≈ 16) |

Other electrical consequences to raise:
- **Second USB-C port for the handset.** The ESP32-S3 has one USB PHY, shared by USB-Serial/JTAG
  and OTG. A USB-C *handset* port (USB audio, host mode) alongside a USB-C *power/programming*
  port needs a hub, a mux, or a USB-audio bridge. This is a schematic decision, flagged here only.
- **Speaker:** DESIGN.md's Ø40 round speaker does not fit next to the key deck in base A. The
  enclosure has a sealed top-firing box (about 9 cm³ net) for a **20 × 40 mm** rectangular speaker.

## 9. Known gaps / not done

- **Main board:** the enclosure is built against the `main_intent` requirements, not the current
  KiCad board (200 × 100, which does not fit base A). Re-run `make sync && make` after the layout
  changes.
- **Hall thresholds:** the DRV5032FA BOP/BRP values (6.8 / 1.2 mT) are placeholders. Check the
  datasheet; the magnet model is on-axis only (no tolerance stack or temperature).
- **Handset dimensions:** POP cup spacing/tilt and all G1 dimensions are estimated from photos.
  Measure real handsets. The handset models are envelope models for renders, fit checks and the
  configurator, not product-accurate surfaces.
- **DIY printable handset** (optional): modelled with a USB-C receptacle on a 30 × 20 mm PCB
  (rails), receiver ring and grille, and mic ring and ports. It needs tree supports inside the
  halves (inner cavity ceilings), and it is untested.
- **Unverified key stack:** the MX/DSA heights come from DESIGN.md. Print a test coupon of one key
  hole plus a switch and cap before printing the shell.
- **Side buttons:** VOL± use 1.2 mm flexure tabs with nubs, and MUTE is a slot. They only work
  once the switches move to the main-board edge (see §8). The tab stiffness is untested.
- **Wall mount:** two keyholes 100 mm apart, but the handset is not retained when the base hangs
  on a wall. Wall use needs a clip (not designed).
- **Cord channel:** the rear channel suits right-angle USB-C plugs. A straight plug just sticks
  out behind the base.
- **No FEA or drop test:** the tube posts are retained by grub screws only (no pull-out analysis).
- **Web GLBs:** the handset GLBs are the envelope models; keycaps are generic DSA; the MX switch is
  simplified (housing + coloured stem).

## 10. Questions for the owner

1. Is the rectangular 20 × 40 mm speaker acceptable (the Ø40 round speaker does not fit base A)?
2. Is the Ø3 × 1.5 mm N35 magnet with 8 mm plunger travel OK? It was chosen over the 6 × 3 mm:
   that one never drops below the hall release threshold with less than about 10 mm of travel, and
   a longer stack would raise the rest.
3. Which handset will ship (exact product), so its cup spacing and tilt can be measured and the
   `pop` insert tuned?
4. Metal tube finish (aluminium, brass, black anodised) — cosmetic only, same part.
5. Should the base carry a handset retaining clip for wall mounting, or drop wall-mount?

## Web export (configurator)

`build/web/*.glb` + `build/web/manifest.json`:
- Units are metres, Y up, +Z out of the phone's front, origin at the footprint centre on the table.
- Each GLB is in its part's local frame, with instances giving the assembled position (rotation
  identity).
- Roles: `base_top` (plus the `base_top_lite` alternative), `base_bottom`, `hook_rest` (saddles per
  family and side), `hook_rest_post` (tube, 2 instances), `plunger` (2 instances, travel given),
  `handset` (`pop`, `g1`), `keycap_1u` (12 instances in order 1 2 3 4 5 MENU 6 7 8 9 0 BACK, press
  travel given), `mx_switch` (12 instances; recolourable node `stem`), `key_plate`, `light_bar`,
  `pcb_main`, `pcb_deck`, `eink`.
- Anchors: the 12 key centres (cap base and cap top), the handset rest pose per family, the cord
  attach point on the handset (local and world), the base handset port and power port, the post
  tops, and the e-ink view centre.
- Triangle counts and total size are printed by the build.
