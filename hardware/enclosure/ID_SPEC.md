# Industrial design spec — Open Lounge Phone r1

The source of truth for the enclosure's look, fit and rendering. The CAD in this folder
implements it, and renders are judged against it. Every number below is either a real part
dimension (with its source) or a deliberate design choice (marked **choice**).

## 1. Design language

- **One calm object.** A low, soft-rectangular slab (the base) with a handset resting above it
  on two slim metal posts. Think Braun / Dieter Rams desk objects, not a toy and not a gadget.
- **Plan view:** rounded rectangle, **corner radius 14 mm** (choice), no other plan-view features.
- **Profile:** vertical side walls with a **continuous top edge made of a 5 mm × 45° chamfer
  blended by 1.5 mm fillets** on both chamfer edges (choice). Printing chamfers face-down and
  support-free still reads as a soft edge. No other steps on the top surface except the key
  field and the display window.
- **Split line:** one horizontal parting line, **8 mm above the table**, with a **0.6 × 0.6 mm
  shadow-gap reveal** (choice) so print tolerances disappear into a deliberate line. The tray
  is one colour and the top shell can be another.
- **Consistent radii:** 1.5 mm on every exterior edge that isn't the main chamfer; 0.5 mm on
  openings. Nothing sharp.
- **Materials (render and print):** matte PETG/PLA. Base top in **Utilitarian cream `#EDE8DC`**,
  tray in **warm graphite `#3B3A37`**, posts in **bead-blasted aluminium** (brushed, roughness
  0.35), handset in the real product's colour. Keycaps cream with graphite legends.

## 2. Real part dimensions (bought parts)

| Part | Dimension used | Source |
|---|---|---|
| Handset: Native Union POP (USB-C) | **230 L × 55 W × 55 H mm, 252 g**; cable exits at the mouthpiece end; built-in pick-up/hang-up button | nativeunion.com/products/pop-phone; MoMA Design Store listing |
| POP handset geometry for modelling | cups ≈ Ø55 mm domes with flat faces; handle ≈ 30 W × 24 H mm, softly rounded; cups hang ≈ 22 mm below the handle top; cup faces tilted **≈ 18°** inward; handle nearly straight on top with ≈ 4 mm convex rise | estimated from product photos; verify with a caliper on the shipped unit |
| MX-compatible switch | plate cutout **14.0 × 14.0 mm**; plate 1.5 mm; housing top 15.6 × 15.6 mm; stem top ≈ 11.6 mm above plate top; travel 4.0 mm | Cherry MX datasheet |
| Hot-swap socket Kailh CPG151101S11 | 1.85 mm below the PCB | Kailh datasheet |
| DSA 1u keycap | base **18.2 × 18.2 mm**, top 12.7 × 12.7 mm (spherical dish), height **7.6 mm** | Signature Plastics DSA profile |
| Key pitch | **19.05 mm** | MX standard |
| E-ink GDEY029T94 | outline **79.0 × 36.7 × 1.2 mm**, active 66.9 × 29.06 mm, FPC tail on the short side | Good Display datasheet |
| USB-C receptacle (mid-mount, 16-pin) | shell opening 8.94 × 3.26 mm; plug overmould clearance needs **12.5 × 7.0 mm** | USB Type-C spec; common receptacle datasheets |
| Speaker | 20 × 40 mm rectangular, ≈ 5 mm deep | choice (fits the compact base) |
| PCBs | deck **117 × 84 × 1.6 mm**, main **180 × 88 × 1.6 mm (R ≥ 8.5)** | hardware/layout, ENCLOSURE.md §8 |
| Heat-set inserts | M2.5 × 4 mm (OD 3.5 mm, hole Ø3.2 mm) | standard brass inserts |
| Posts | aluminium tube **Ø12 × 1.0 mm**, cut straight | stock tube |

## 3. Layout (top view, base 186 × 94 mm)

- **Key field:** 2 rows × 6 keys at 19.05 mm pitch = 113.35 mm wide. Rows are separated by the
  display: row-centre spacing = 19.05 + display window height (31 mm) + 2 × 3 mm margins, so
  about **56 mm**. The field is centred left-right and **offset 6 mm toward the front** (choice),
  leaving the rear free for the posts and cable.
- **Display window:** the view opening is **68 × 30 mm** (active 66.9 × 29.06 plus 0.5 mm
  margin), with a 0.8 mm deep recessed bezel lip. The panel pocket is 79.4 × 37.1 mm (outline
  + 0.2 per side). On Lite the top has **no window**: a smooth surface with a subtle 0.3 mm
  debossed rectangle where the window would be (choice, reads as intentional).
- **Posts:** at the two ends, **behind the key field** (centre 18 mm from the rear edge),
  spaced to the handset's cup centres (≈ 175 mm for the POP).

## 4. Tolerances (FDM, 0.4 mm nozzle)

| Interface | Clearance |
|---|---|
| Keycap body ↔ skin opening (above the skirt) | **0.6 mm per side** (the opening is the skirt minus the captive overlap, see below) |
| Captive keycap: skin opening vs skirt | opening **17.4 mm**, so a 0.4 mm lip per side holds the 18.2 mm skirt; the skirt sits 1.0 mm below the skin at rest; the cap top sits **4.5 mm proud** of the skin at rest |
| Switch in plate cutout | 14.0 mm nominal (use a PCB-fab FR4 plate or a printed plate at 14.1 mm) |
| Board ↔ tray wall | 1.0 mm per side |
| Post tube ↔ printed socket | Ø12.25 mm socket, press fit via 3 crush ribs |
| Plunger ↔ tube bore (Ø10.0) | Ø9.6 mm plunger |
| Top shell ↔ tray step joint | 0.2 mm per side, with a 2.0 mm overlap |
| USB-C cut-out | 12.8 × 7.2 mm with 3.4 mm end radii, recessed 1 mm so the plug seats flush |
| Heat-set insert bosses | Ø6.5 mm OD, hole Ø3.2 mm, 5 mm deep |

## 5. Handset rest

- **Saddles:** printed cups contoured to the handset's cup domes (offset +1.0 mm), with a
  2 mm felt pad, and **7° inward cant** so the handset self-centres. Minimal visual mass:
  saddle lip ≤ 6 mm tall.
- **Height:** handset underside ≥ **32 mm above the keycap tops** (finger clearance). Overall
  height ≈ **95 mm** (choice).
- **Hook plunger:** travel 8 mm, return spring, 3 × 1.5 mm N35 magnet in the tip over the hall
  sensor. The POP's own pick-up/hang-up button is a second, digital hook signal (USB HID
  telephony), useful when the handset is off the rest.

## 6. Rendering (owner-facing images)

- **Renderer:** three.js in headless Chromium, loading the exported GLBs.
  `MeshPhysicalMaterial`, `RoomEnvironment` PMREM image-based lighting, ACES Filmic tone
  mapping, sRGB output, soft shadows (PCFSoft, 2048 map) plus a blurred contact-shadow plane,
  neutral warm-grey background `#ECEAE6` (dark variant `#1B1D1C`).
- **Camera:** 30° vertical FOV (reads like a 50 mm lens). Views: hero 3/4 (35° azimuth, 22°
  elevation), front elevation, top, exploded (along Z, with gaps), handset close-up.
- **Output:** 2400 × 1600 PNG. No z-fighting, no faceting (smooth normals, tessellation tolerance
  ≤ 0.05 mm on visible curved surfaces), no placeholder colours.
- **Acceptance:** the hero render would pass as product photography. If it wouldn't, iterate
  before anyone sees it.
