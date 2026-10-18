"""Route the minimal board (M3): copper for hardware/kicad/main/main.kicad_pcb (KiCad's Python).

    <KiCad python> route.py            # (make route) after place.py; rewrites the board in place

Deterministic: the same placed board gives the same copper. Frame: mm from the board's
rear-left corner, x right, y down (place.py). Every SMD part is on the bottom, so the bottom
(B.Cu) carries the signals and the top (F.Cu) is a GND plane with a few crossings.

1. Hand routes (this file, coordinates below), following the planned lanes (DESIGN.md §9):
   - rear keys: six parallel tracks from the socket pads down to a lane under the rear sockets,
     left to the module and down its key-side row (IO3, 46, 9, 10, 11, 12)
   - front keys: six parallel tracks up from the front sockets to a lane, left to the module's
     front side (IO43, 44, 42, 41, 40, 39); the hook below them to SW15
   - display: J3 -> module row (IO13, 14, 21, 47, 48) as one bundle with a parallel 45° jog;
     RST (IO38), BOOT, the status LED
   - USB: J1 -> USBLC6 -> IO19/IO20 as a short pair, VBUS (the TVS's VBUS pin is reached
     through the gap between its pad rows, so nothing crosses the pair), CC resistors
   - 3V3: a bottom pour island on the LDO tab (>= 100 mm2 heat copper), one top-layer trunk
     to the module / codec / J3 that passes the USB pair south of its end, one along the rear
     edge to the mic bias resistor
   - handset audio: earpiece chain, mic bias column, mic line to the jack
2. A small grid router (0.05 mm, 8 directions, 45° turns only, minimum run between turns, via
   cost) for the short leftover nets of the codec corner, then a GND via next to every SMD
   ground pad that the bottom fill cannot reach on its own.
3. GND fill on both layers (islands removed), stitching vias, refill, save.
"""

from __future__ import annotations

import heapq
import math
import sys

import kienv  # noqa: F401  (sys.path: numpy in .tools/pylib)
import numpy as np
import pcbnew
from kienv import KICAD_OUT

from place import BOARD, COLS, H, ORIGIN, W, P, save_board, unP

MM = pcbnew.FromMM
F, B = 0, 1                               # router layer index: 0 = F.Cu (top), 1 = B.Cu
LAYER = {F: pcbnew.F_Cu, B: pcbnew.B_Cu}
VIA_D, VIA_DRILL = 0.6, 0.3
EDGE = 0.3
HOLE_CLR = 0.25
HOLE_TO_HOLE = 0.5
CLASS = {  # netclass: (track, clearance) = place.NETCLASSES
    "Default": (0.2, 0.15), "Power": (0.4, 0.2), "USB": (0.3, 0.15), "Audio": (0.25, 0.2),
    "Eth": (0.25, 0.15), "PoE": (0.5, 0.25), "Chassis": (0.5, 0.25)}
POWER = {"VBUS", "3V3", "V5", "POE_5V", "ETH_3V3", "ETH_3V3A"}
USBN = {"USB_DP", "USB_DN"}
AUDIO = {"HS_EAR", "HS_MIC", "EAR_AC", "DAC_OUTP", "MIC1P", "MIC1N", "MIC_BIAS"}
ETHN = {"ETH_TXP", "ETH_TXN", "ETH_RXP", "ETH_RXN", "ETH_RDP_J", "ETH_RDN_J"}
POEN = {"POE_VA1", "POE_VA2", "POE_VB1", "POE_VB2", "POE_VIN_P", "POE_VIN_N"}
CHASSIS = {"ETH_SHIELD"}
POE_ISO, POE_ISO_J4 = 3.0, 1.0      # fab-common.kicad_dru "safety: PoE isolation"


def cls(net: str) -> str:
    if net in POWER:
        return "Power"
    if net in USBN:
        return "USB"
    if net in AUDIO:
        return "Audio"
    if net in ETHN:
        return "Eth"
    if net in POEN:
        return "PoE"
    if net in CHASSIS:
        return "Chassis"
    return "Default"


def iso_clearance(net: str, it: dict) -> float:
    """The PoE isolation rule between the net being routed and an item (0 if it doesn't apply)."""
    if not it["net"] or not net:
        return 0.0
    a, b = cls(net), cls(it["net"])
    if (a == "PoE") == (b == "PoE") or "Chassis" in (a, b):
        return 0.0
    if "pad" in it and it["pad"].GetParentFootprint().GetReference() == "J4":
        return POE_ISO_J4 + 0.05
    return POE_ISO + 0.05


# ---------------------------------------------------------------------------------------------
# board helpers


class Copper:
    def __init__(self, board):
        self.b = board
        self.nets = {}

    def net(self, name):
        if name not in self.nets:
            n = self.b.FindNet(name)
            if n is None:
                raise SystemExit(f"no net {name}")
            self.nets[name] = n
        return self.nets[name]

    def track(self, net, layer, pts, w):
        out = []
        for a, b in zip(pts, pts[1:]):
            if math.dist(a, b) < 1e-6:
                continue
            t = pcbnew.PCB_TRACK(self.b)
            t.SetStart(P(*a))
            t.SetEnd(P(*b))
            t.SetWidth(MM(w))
            t.SetLayer(LAYER[layer])
            t.SetNet(self.net(net))
            self.b.Add(t)
            out.append(t)
        return out

    def via(self, net, x, y):
        v = pcbnew.PCB_VIA(self.b)
        v.SetPosition(P(x, y))
        v.SetWidth(MM(VIA_D))
        v.SetDrill(MM(VIA_DRILL))
        v.SetViaType(pcbnew.VIATYPE_THROUGH)
        v.SetLayerPair(pcbnew.F_Cu, pcbnew.B_Cu)
        v.SetNet(self.net(net))
        self.b.Add(v)
        return v


def pad(board, ref, num, pick=None):
    """Centre of a pad; `pick` chooses among pads sharing a number (e.g. min/max by y)."""
    fp = board.FindFootprintByReference(ref)
    found = [unP(p.GetPosition()) for p in fp.Pads() if p.GetNumber() == num]
    if not found:
        raise SystemExit(f"{ref}:{num} not found")
    return pick(found, key=lambda q: q[1]) if pick else found[0]


def chamfer(pts, c):
    """Orthogonal polyline -> the same path with each 90° corner cut by a 45° chamfer of leg c
    (a list gives one c per corner)."""
    cs = c if isinstance(c, (list, tuple)) else [c] * len(pts)
    out = [pts[0]]
    for k in range(1, len(pts) - 1):
        a, m, b = pts[k - 1], pts[k], pts[k + 1]
        d1 = (m[0] - a[0], m[1] - a[1])
        d2 = (b[0] - m[0], b[1] - m[1])
        l1, l2 = math.hypot(*d1), math.hypot(*d2)
        cc = min(cs[k - 1], l1 * 0.999, l2 * 0.999)
        u1 = (d1[0] / l1, d1[1] / l1)
        u2 = (d2[0] / l2, d2[1] / l2)
        if abs(u1[0] * u2[1] - u1[1] * u2[0]) < 1e-9:   # straight through
            out.append(m)
            continue
        out.append((m[0] - u1[0] * cc, m[1] - u1[1] * cc))
        out.append((m[0] + u2[0] * cc, m[1] + u2[1] * cc))
    out.append(pts[-1])
    return out


# ---------------------------------------------------------------------------------------------
# 1. hand routes

REAR = ["KEY_1", "KEY_2", "KEY_3", "KEY_4", "KEY_5", "KEY_MENU"]      # SW3..SW8
FRONT = ["KEY_6", "KEY_7", "KEY_8", "KEY_9", "KEY_0", "KEY_BACK"]     # SW9..SW14
BUS_W = 0.2
LANE_P = 0.6                       # bus pitch: 0.2 track + 0.4 space
REAR_LANE0, REAR_RISER0 = 21.5, 21.6
FRONT_LANE0 = 66.9
DISP_JOG_X = 27.0                  # display bundle: where its parallel 45° jog starts


def rear_keys(cu):
    """Nested bus: key i drops to lane y_i, runs left to riser x_i, down beside the module's
    key row and left into its pin. Chamfers grow toward the outside so the diagonals stay
    parallel at the bus pitch."""
    d = LANE_P
    for i, net in enumerate(REAR):
        kx, ky = pad(cu.b, f"SW{3 + i}", "1")
        px, py = pad(cu.b, "U1", str(15 + i))
        y = REAR_LANE0 + i * d
        x = REAR_RISER0 + i * d
        c_out = 0.8 + (5 - i) * d * (2 - math.sqrt(2))
        pts = chamfer([(kx, ky), (kx, y), (x, y), (x, py), (px, py)], [0.8, c_out, 0.5])
        cu.track(net, B, pts, BUS_W)


def front_keys(cu):
    for i, net in enumerate(FRONT):
        kx, ky = pad(cu.b, f"SW{9 + i}", "1")
        px, py = pad(cu.b, "U1", str(37 - i))
        y = FRONT_LANE0 - i * LANE_P
        pts = chamfer([(px, py), (px, y), (kx, y), (kx, ky)], [0.8, 0.8])
        cu.track(net, B, pts, BUS_W)
    # hook: straight down left of the risers, under the lowest lane, into SW15
    hx, hy = pad(cu.b, "SW15", "1")
    px, py = pad(cu.b, "U1", "38")
    y = FRONT_LANE0 + 0.7
    cu.track("HOOK", B, chamfer([(px, py), (px, y), (hx, y), (hx, hy)], [0.5, 0.5]), BUS_W)
    # status LED: IO1 -> 1 k -> LED anode, straight down the left edge
    lx, ly = pad(cu.b, "U1", "39")
    r1 = pad(cu.b, "R13", "1")
    r2 = pad(cu.b, "R13", "2")
    d2 = pad(cu.b, "D2", "2")
    cu.track("STATUS_LED", B, [(lx, ly), (lx, r1[1])], BUS_W)
    xm = 3.0
    cu.track("STATUS_LED_A", B, [(xm, r2[1]), (xm, d2[1])], BUS_W)


def display(cu):
    """J3 -> module pins 21-25: the right-column pins slip between the left-column pads, then
    all five run left at 1.27 mm pitch and jog down together (parallel 45°)."""
    order = [("EPD_CLK", "5", "21"), ("EPD_DIN", "6", "22"), ("EPD_DC", "3", "23"),
             ("EPD_CS", "4", "24"), ("EPD_BUSY", "1", "25")]
    for k, (net, jp, up) in enumerate(order):
        jx, jy = pad(cu.b, "J3", jp)
        px, py = pad(cu.b, "U1", up)
        lane = pad(cu.b, "J3", "5")[1] + k * 1.27
        pts = [(jx, jy)]
        if abs(lane - jy) > 0.01:          # right column: 45° down-left between two pads
            pts.append((jx - (lane - jy), lane))
        drop = py - lane
        pts += [(DISP_JOG_X, lane), (DISP_JOG_X - drop, py), (px, py)]
        cu.track(net, B, pts, BUS_W)
    # RST (IO38, front side): down, under SW2, up the right column into J3 pin 2
    rx, ry = pad(cu.b, "U1", "31")
    jx, jy = pad(cu.b, "J3", "2")
    y = 56.5
    cu.track("EPD_RST", B, chamfer([(rx, ry), (rx, y), (jx, y), (jx, jy)], [0.6, 0.7]), BUS_W)
    # IO0 = ETH_CS (hw v0.2): out of the corner pin into R14 (1 k), R14 -> SW2 (BOOT, both pads
    # of its contact); ETH_CS itself hops onto the top layer toward the W5500 (eth_hand())
    bx, by = pad(cu.b, "U1", "27")
    r14a, r14b = pad(cu.b, "R14", "1"), pad(cu.b, "R14", "2")
    s1 = [p for p in pads_of(cu.b, "SW2") if p[1] == "BOOT_SW"]
    (ax, ay), (cx, cy) = sorted([p[0] for p in s1])
    cu.track("ETH_CS", B, [(bx, by), r14a], BUS_W)
    cu.track("BOOT_SW", B, [r14b, (ax, by - (ax - r14b[0])), (ax, ay), (cx, cy)], BUS_W)
    # 3V3 to J3 pin 8 comes with the top trunk (power())


def v5_trunk(cu):
    """hw v0.2: the PoE side's 5 V (D5's cathode, at the right end) to the V5 node at the LDO,
    on the top layer along y 18.5 (between the rear switches' holes and their legends), with a
    short bottom hop under the top 3V3 trunk at x 36; a branch down to the Ethernet LDO U5."""
    b = cu.b
    W5 = 0.8
    vk = pad(b, "D5", "1")
    xe, ye = 137.2, 18.5
    cu.track("V5", B, [vk, (xe + 0.5, vk[1]), (xe, ye)], W5)
    cu.via("V5", xe, ye)
    u5in = pad(b, "U5", "3")                          # branch to U5: down the top layer west
    xb, yb = 102.0, u5in[1] + 2.2                     # of the Ethernet parts, then east under
    cu.track("V5", F, [(xe, ye), (37.4, ye)], W5)     # U5 into its input pin from the south
    cu.track("V5", F, [(xb, ye), (xb, yb)], 0.6)
    cu.via("V5", xb, yb)
    cu.track("V5", B, [(xb, yb), (u5in[0], yb), u5in], 0.6)
    cu.via("V5", 37.4, ye)
    cu.track("V5", B, [(37.4, ye), (34.4, ye)], W5)
    cu.via("V5", 34.4, ye)
    xv, yv = 22.75, 17.65                             # on the V5 diagonal D3 -> LDO input
    cu.track("V5", F, [(34.4, ye), (xv + (ye - yv), ye), (xv, yv)], W5)
    cu.via("V5", xv, yv)


def eth_hand(cu):
    """hw v0.2: the structured part of the wired network, by hand (the router joins the rest
    in ETH_WINDOW).

    - SPI: one bottom bundle from J3 / the module, top to bottom in the W5500's pin order (DIN,
      MISO, CLK, CS at 0.6 mm), parallel 45° fan into pins 35-32; MISO and CS hop over the
      display and BOOT lines on the top layer, CLK leaves J3 on the top between pins 6 and 4.
    - the crystal's XO / XI around their pins (30/31) to Y1, south-west of the W5500.
    - TX pair: its 49.9 R terminations north of the PHY pins, then a via pair onto the top layer
      over the RX pair to the RJ45's pins 1/2 (the W5500 has TX north of RX, the RJ45 the other
      way round; one hop instead of a crossing).
    - four GND vias under the W5500 for its ground pins (eth_gnd()).
    - the PoE input side (poe_hand())."""
    b = cu.b
    # ---- SPI bundle
    yd, ym, yc, ys = 42.73, 43.33, 43.93, 44.53          # DIN, MISO, CLK, CS
    d6 = pad(b, "J3", "6")
    c5 = pad(b, "J3", "5")
    cu.track("EPD_CLK", F, [c5, (c5[0] + yc - c5[1], yc), (47.5, yc)], BUS_W)
    cu.via("EPD_CLK", 47.5, yc)
    m = pad(b, "U1", "26")
    cu.track("ETH_MISO", B, [m, (21.4, m[1])], BUS_W)
    cu.via("ETH_MISO", 21.4, m[1])
    cu.track("ETH_MISO", F, [(21.4, m[1]), (46.5, m[1]), (48.5, m[1] - 2.0), (48.5, ym)], BUS_W)
    cu.via("ETH_MISO", 48.5, ym)
    by = pad(b, "U1", "27")[1]
    yt = 53.6
    cu.via("ETH_CS", 24.0, by)
    cu.track("ETH_CS", F, [(24.0, by), (24.0 + yt - by, yt), (49.5, yt), (49.5, ys)], BUS_W)
    cu.via("ETH_CS", 49.5, ys)
    # fan into U4: line k on y = x + c_k (parallel 45°), c 0.85 apart (0.6 mm pitch)
    c_cs = 47.75 - 113.0
    for k, (net, y0, pin, x0) in enumerate((("EPD_DIN", yd, "35", d6[0]), ("ETH_MISO", ym, "34", 48.5),
                                            ("EPD_CLK", yc, "33", 47.5), ("ETH_CS", ys, "32", 49.5))):
        px, py = pad(b, "U4", pin)
        c = c_cs - (3 - k) * 0.85
        cu.track(net, B, [(x0, y0), (y0 - c, y0), (py - c, py), (px, py)], BUS_W)
    # ---- crystal: XO (pin 31) to Y1's NE pad, XI (pin 30) round its east side to the SW pad
    xo, xi = pad(b, "U4", "31"), pad(b, "U4", "30")
    yo, yi = pad(b, "Y1", "3"), pad(b, "Y1", "1")
    cu.track("W5500_XO", B, [xo, (yo[0] + (yo[1] - xo[1]), xo[1]), yo], BUS_W)
    xv = yo[0] + 1.25
    cu.track("W5500_XI", B, [xi, (xv + 1.0, xi[1]), (xv, xi[1] + 1.0), (xv, yi[1] + 1.0),
                             (yi[0], yi[1] + 1.0), yi], BUS_W)
    # ---- TX pair: terminations, via hop, top layer to the RJ45 (pins 1 TX+, 2 TX-)
    W = CLASS["Eth"][0]
    tn, tp = pad(b, "U4", "1"), pad(b, "U4", "2")
    r21, r20 = pad(b, "R21", "1"), pad(b, "R20", "1")
    vn, vp = (r21[0], tn[1] - 0.4), (r20[0], tp[1])
    cu.track("ETH_TXN", B, [tn, (vn[0] - 0.4, tn[1]), vn, r21], W)
    cu.track("ETH_TXP", B, [tp, vp, r20], W)
    cu.via("ETH_TXN", *vn)
    cu.via("ETH_TXP", *vp)
    j1, j2 = pad(b, "J4", "1"), pad(b, "J4", "2")
    yn, yp = j1[1] + 1.38, j1[1] + 0.68
    cu.track("ETH_TXN", F, [vn, (vn[0], yn), (j2[0], yn), j2], W)
    cu.track("ETH_TXP", F, [vp, (vp[0], yp), (j1[0] - (yp - j1[1]), yp), j1], W)
    u4_escape(cu)
    phy_rx(cu)
    eth_leds(cu)
    poe_hand(cu)


def u4_escape(cu):
    """hw v0.2: the W5500's supply and ground pins at 0.5 mm pitch: each ground pin inward to its
    own GND via under the package (the top GND pour joins them); AVDD pins 4/8 and 21 inward
    (the router finishes them, with a via of its own), pin 11 round the free corner to pin 15;
    VDD (28) and the LED pins (25, 27) outward west to vias beside the package (the crystal's XI
    runs past them)."""
    b = cu.b
    U = lambda n: pad(b, "U4", str(n))     # noqa: E731
    w = 0.2
    xe, xw, ys = U(1)[0] - 0.74, U(25)[0] + 0.74, U(13)[1] - 0.74    # pad inner ends
    yn = U(37)[1] + 0.74
    # ground: each pin straight (or one 45° step) to its own via inside the pin ring
    g3, g48 = (121.0, U(3)[1]), (U(48)[0] - (46.4 - yn), 46.4)
    g29, g9 = (118.4, U(29)[1]), (121.6, U(9)[1])
    cu.track("GND", B, [(xe, U(3)[1]), g3], w)
    cu.track("GND", B, [(U(48)[0], yn), g48], w)
    cu.track("GND", B, [(xw, U(29)[1]), g29], w)
    cu.track("GND", B, [(xe, U(9)[1]), g9], w)
    gs = [(U(n)[0], 51.0) for n in (14, 16, 19, 23)]
    for n, v in zip((14, 16, 19, 23), gs):
        cu.track("GND", B, [(U(n)[0], ys), v], w)
    for v in [g3, g48, g29, g9] + gs:
        cu.via("GND", *v)
    a4, a21 = (123.5, 47.9), (U(21)[0], 50.75)
    cu.track("ETH_3V3A", B, [(xe, U(4)[1]), (a4[0] + 0.35, U(4)[1]), (a4[0], U(4)[1] + 0.35), a4], w)
    cu.track("ETH_3V3A", B, [(xe, U(8)[1]), (a4[0] + 0.35, U(8)[1]), (a4[0], U(8)[1] - 0.35), a4], w)
    # pin 11: outward round the package's free corner (pins 12/13 unused) to pin 15's line south
    xo, yo = U(11)[0] + 1.14, U(13)[1] + 1.09
    cu.track("ETH_3V3A", B, [U(11), (xo, U(11)[1]), (xo, yo), (U(15)[0], yo), U(15)], w)
    cu.track("ETH_3V3A", B, [(U(21)[0], ys), a21], w)
    # VDD and the LEDs: outward west to vias beside the package
    vd, va, vl = (115.5, 49.85), (115.5, 50.85), (115.5, 51.85)
    cu.track("ETH_3V3", B, [U(28), (vd[0] + 0.1, U(28)[1]), vd], w)
    cu.track("ETH_ACTLED", B, [U(27), (116.0, U(27)[1]), (va[0], U(27)[1] + 0.5), va], w)
    cu.track("ETH_LINKLED", B, [U(25), (116.1, U(25)[1]), vl], w)
    cu.via("ETH_3V3", *vd)
    cu.via("ETH_ACTLED", *va)
    cu.via("ETH_LINKLED", *vl)
    # EXRES1 out to R15 (upright beside the package), R15's ground via below it
    r15a, r15b = pad(b, "R15", "1"), pad(b, "R15", "2")
    cu.track("W5500_EXRES", B, [U(10), (r15a[0] - (r15a[1] - U(10)[1]), U(10)[1]), r15a], w)
    vg = (r15b[0] + 0.8, r15b[1] + 0.8)                       # east of the TX- top track
    cu.track("GND", B, [r15b, vg], 0.3)
    cu.via("GND", *vg)
    # the Ethernet LDO's output pin to its tab (the same pin 2; no pour joins them here)
    u5 = [unP(q.GetPosition()) for q in b.FindFootprintByReference("U5").Pads() if q.GetNumber() == "2"]
    cu.track("ETH_3V3", B, sorted(u5), 0.5)


def phy_rx(cu):
    """hw v0.2: the RX pair from the W5500 (pins 5 RX-, 6 RX+) through its AC coupling (C30, C29)
    to the RJ45 (pins 5 RD-, 4 RD+), 3 mm south of the PoE side until it is inside the RJ45's own
    pin grid; terminations R23/R22 to C31 south of it (RX- reaches R23 over a via pair); the
    joined centre tap (pin 3) to R24 / C32."""
    b = cu.b
    W = CLASS["Eth"][0]
    n5, p6 = pad(b, "U4", "5"), pad(b, "U4", "6")
    c30a, c30b = pad(b, "C30", "2"), pad(b, "C30", "1")       # RXN, RDN_J
    c29a, c29b = pad(b, "C29", "2"), pad(b, "C29", "1")       # RXP, RDP_J
    j5, j4, j3 = pad(b, "J4", "5"), pad(b, "J4", "4"), pad(b, "J4", "3")
    yn, yp = c30a[1], c29a[1]
    cu.track("ETH_RXN", B, [n5, (129.3, n5[1]), (129.3, yn), c30a], W)
    cu.track("ETH_RXP", B, [p6, (128.6, p6[1]), (128.6, yp), c29a], W)
    xj = 138.05                                                 # the RJ45's courtyard
    cu.track("ETH_RDN_J", B, [c30b, (xj, yn), (xj + (yn - j5[1]), j5[1]), j5], W)
    xd = 137.8
    cu.track("ETH_RDP_J", B, [c29b, (xd, yp), (xd + (yp - j4[1]), j4[1]), j4], W)
    # terminations: RX- over a via pair (it would cross RX+), RX+ straight down
    r23, r22 = pad(b, "R23", "1"), pad(b, "R22", "1")
    v1, v2 = (r23[0], yn), (r23[0], r23[1] - 0.6)
    cu.via("ETH_RXN", *v1)
    cu.track("ETH_RXN", F, [v1, v2], W)
    cu.via("ETH_RXN", *v2)
    cu.track("ETH_RXN", B, [v2, r23], W)
    cu.track("ETH_RXP", B, [(r22[0], yp), r22], W)
    r23c, r22c, c31 = pad(b, "R23", "2"), pad(b, "R22", "2"), pad(b, "C31", "1")
    cu.track("ETH_RXC", B, [r23c, r22c, (r22c[0] + 0.4, r22c[1]), (r22c[0] + 0.4, c31[1]), c31], W)
    # centre tap: out of pin 3 south of RD+, west to C32 and R24
    c32, r24 = pad(b, "C32", "1"), pad(b, "R24", "2")
    yc = 53.6
    cu.track("ETH_CT", B, [j3, (j3[0] - (yc - j3[1]), yc), (r24[0], yc), r24], 0.25)
    cu.track("ETH_CT", B, [(c32[0], yc), c32], 0.25)


def eth_leds(cu):
    """hw v0.2: the W5500's LED lines (vias beside its west side, u4_escape) on the top layer
    down to the front and east along it to the LED resistors at the right edge; the ETH_3V3 feed
    for the RJ45's LED anodes (pins 11, 13) on the top layer round the RJ45's shield tab."""
    b = cu.b
    w = 0.2
    va, vl = (115.5, 50.85), (115.5, 51.85)
    r26, r25 = pad(b, "R26", "2"), pad(b, "R25", "2")
    ya, yl, xa, xl = 62.6, 62.0, r26[0], r25[0] - 0.6    # 0.25 mm past H6's hole
    cu.track("ETH_ACTLED", F, [va, (114.7, va[1] + 0.8), (114.7, ya), (xa, ya), (xa, r26[1] - 0.9)], w)
    cu.via("ETH_ACTLED", xa, r26[1] - 0.9)
    cu.track("ETH_ACTLED", B, [(xa, r26[1] - 0.9), r26], w)
    cu.track("ETH_LINKLED", F, [vl, (vl[0], yl), (xl, yl), (xl, r25[1] + 0.6)], w)
    cu.via("ETH_LINKLED", xl, r25[1] + 0.6)   # one 45° step to R25's pad
    cu.track("ETH_LINKLED", B, [(xl, r25[1] + 0.6), r25], w)
    # ETH_3V3 top trunk: from a via south-east of the supply parts east under the TX pair, round
    # the RJ45's front shield tab, up beside its LED pins
    e1 = (116.8, 57.3)
    p11, p13 = pad(b, "J4", "11"), pad(b, "J4", "13")
    xv = 151.3
    cu.via("ETH_3V3", *e1)
    cu.track("ETH_3V3", F, [e1, (142.8, e1[1]), (144.3, 58.8), (xv, 58.8), (xv, p13[1]), p13], 0.3)
    cu.track("ETH_3V3", F, [(xv, p11[1]), p11], 0.3)


def poe_hand(cu):
    """hw v0.2: the isolated PoE input side (net class PoE, 0.5 mm), by hand: the RJ45's
    cable-side centre taps to the bridges (BR1 mode A west of the RJ45, BR2 mode B under the
    module), VIN+ along the module's input half to the TVS and pins 5/6, VIN- on the top layer
    along y 35.6 and 39.6 to pins 7/8. 3 mm from everything else (fab-common.kicad_dru)."""
    b = cu.b
    W = CLASS["PoE"][0]
    J = lambda n: pad(b, "J4", n)          # noqa: E731
    P = lambda n: pad(b, "PS1", n)         # noqa: E731
    br1 = {n: pad(b, "BR1", n) for n in "1234"}
    br2 = {n: pad(b, "BR2", n) for n in "1234"}
    dk, da = pad(b, "D4", "1"), pad(b, "D4", "2")
    # mode A (data-pair centre taps) -> BR1's AC pins (VA2 east, VA1 west)
    cu.track("POE_VA2", B, [J("8"), (br1["3"][0], J("8")[1])], W)
    cu.track("POE_VA1", B, [J("7"), (br1["4"][0], J("7")[1]), br1["4"]], W)
    # mode B (spare pairs) -> BR2's AC pins, north under the module
    xb = J("9")[0] + 0.14
    cu.track("POE_VB1", B, [J("9"), (xb, J("9")[1] - 0.14),
                            (xb, br2["3"][1] + 0.4 + br2["3"][0] - xb),
                            (br2["3"][0], br2["3"][1] + 0.4), br2["3"]], W)
    cu.track("POE_VB2", B, [J("10"), (J("10")[0], br2["4"][1]), br2["4"]], W)
    # VIN+: BR2 + -> along y 31.0 -> TVS cathode -> BR1 + ; module pins 5/6
    yv = 31.0
    cu.track("POE_VIN_P", B, [br2["1"], (br2["1"][0], yv), (dk[0], yv), dk], W)
    cu.track("POE_VIN_P", B, [dk, (dk[0], br1["1"][1] - 0.62 - (dk[0] - br1["1"][0])),
                              (br1["1"][0], br1["1"][1] - 0.62), br1["1"]], W)
    cu.track("POE_VIN_P", B, [(dk[0], P("5")[1]), P("5"), P("6")], W)
    # VIN-: BR2 - -> pin 7 (bottom); pins 7-8; TVS anode and BR1 - on the top layer
    p7, p8 = P("7"), P("8")
    cu.track("POE_VIN_N", B, [br2["2"], (br2["2"][0], 35.9), (p7[0] - 1.94, 35.9), p7, p8], W)
    cu.track("POE_VIN_N", B, [da, (da[0], 35.25)], W)
    cu.via("POE_VIN_N", da[0], 35.25)
    cu.track("POE_VIN_N", F, [(da[0], 35.25), (da[0] + 0.35, 35.6), (p7[0] - 1.26, 35.6),
                              (p7[0], 36.86), p7], W)
    v1 = (br1["2"][0] + 0.68, br1["2"][1] + 0.68)
    cu.track("POE_VIN_N", B, [br1["2"], v1], W)
    cu.via("POE_VIN_N", *v1)
    cu.track("POE_VIN_N", F, [v1, (v1[0] + (v1[1] - 39.6), 39.6), (p7[0] - (39.6 - p7[1]), 39.6), p7], W)


def pads_of(board, ref):
    fp = board.FindFootprintByReference(ref)
    return [(unP(p.GetPosition()), p.GetNetname(), p.GetNumber()) for p in fp.Pads()]


def usb(cu):
    """J1 -> D1 (USBLC6, flow-through) -> module IO19/IO20. D- joins its two receptacle pads
    over the top of the pad row (inside the receptacle's footprint), D+ joins below it."""
    b = cu.b
    a6, a7 = pad(b, "J1", "A6"), pad(b, "J1", "A7")
    b6, b7 = pad(b, "J1", "B6"), pad(b, "J1", "B7")
    yb = 6.5
    # D- bridge B7 <-> A7 above the pads (0.2 mm between 0.3 mm pads)
    cu.track("USB_DN", B, [a7, (a7[0], yb + 0.3), (a7[0] - 0.3, yb), (b7[0] + 0.3, yb),
                          (b7[0], yb + 0.3), b7], 0.2)
    d4, d3 = pad(b, "D1", "4"), pad(b, "D1", "3")
    d6, d1 = pad(b, "D1", "6"), pad(b, "D1", "1")
    u13, u14 = pad(b, "U1", "13"), pad(b, "U1", "14")
    # D-: B7 straight down, 45° onto the TVS column, through D1, down to IO19
    cu.track("USB_DN", B, [b7, (b7[0], 8.8)], 0.2)
    j = b7[0] - d4[0]
    cu.track("USB_DN", B, [(b7[0], 8.8), (b7[0], 13.9), (d4[0], 13.9 + j), d4], 0.3)
    # D+: A6 and B6 meet under the pad row on the TVS column
    yj = 9.4
    cu.track("USB_DP", B, [a6, (a6[0], yj - (d6[0] - a6[0])), (d6[0], yj)], 0.2)
    cu.track("USB_DP", B, [b6, (b6[0], yj - (b6[0] - d6[0])), (d6[0], yj)], 0.2)
    cu.track("USB_DP", B, [(d6[0], yj), d6], 0.3)
    # out of the TVS: parallel 45° jogs onto the module's USB pins
    y0 = 31.0
    cu.track("USB_DN", B, [d3, (d3[0], y0), (u13[0], y0 + (d3[0] - u13[0])), u13], 0.3)
    cu.track("USB_DP", B, [d1, (d1[0], y0), (u14[0], y0 + (d1[0] - u14[0])), u14], 0.3)
    # TVS ground: its own via right below the pin, between the pair
    g = pad(b, "D1", "2")
    cu.track("GND", B, [g, (g[0], 20.45)], 0.3)
    cu.via("GND", g[0], 20.45)
    # CC resistors straight below their pins; R1/R2 ground vias
    a5, b5 = pad(b, "J1", "A5"), pad(b, "J1", "B5")
    r1, r2 = pad(b, "R1", "1"), pad(b, "R2", "1")
    cu.track("CC1", B, [a5, (a5[0], r1[1] - (a5[0] - r1[0])), r1], 0.2)
    cu.track("CC2", B, [b5, (b5[0], r2[1])], 0.2)
    gx, gy = pad(b, "R1", "2")
    cu.track("GND", B, [(gx, gy), (gx, 12.7)], 0.3)
    cu.via("GND", gx, 12.7)
    # R2's via sits west of its pad (hw v0.2: the USB OR diode D3 is east of it)
    gx, gy = pad(b, "R2", "2")
    cu.track("GND", B, [(gx, gy), (20.55, gy + gx - 20.55), (20.55, 12.45)], 0.3)
    cu.via("GND", 20.55, 12.45)


def power(cu):
    b = cu.b
    # ---- hw v0.2: VBUS (east pad A9/B4) -> D3 (USB OR diode) -> V5 -> LDO + C_IN; the
    # piezo, its 1 k and the TVS's supply pin hang off V5 west of it, reached through the gap
    # between the TVS's pad rows (crosses nothing). The west pad A4/B9 is the plug's VBUS too and
    # stays unrouted. The PoE 5 V comes in on the top layer (v5_trunk()).
    a9 = pad(b, "J1", "A9")
    d3a, d3k = pad(b, "D3", "2"), pad(b, "D3", "1")
    u3in, c1 = pad(b, "U2", "3"), pad(b, "C1", "1")
    xt = d3k[0]
    cu.track("VBUS", B, [a9, (a9[0], 8.6), (d3a[0], 8.6 + d3a[0] - a9[0]), d3a], 0.4)
    cu.track("V5", B, [d3k, (xt, 17.0), (xt + u3in[1] - 17.0, u3in[1]), u3in], 0.6)
    cu.track("V5", B, [u3in, (u3in[0], c1[1])], 0.6)
    bz, r11 = pad(b, "BZ1", "1"), pad(b, "R11", "1")
    cu.track("V5", B, [bz, (r11[0], bz[1] + r11[0] - bz[0]), r11], 0.4)
    d5 = pad(b, "D1", "5")
    yg = 18.0
    cu.track("V5", B, [r11, (r11[0], 15.05), (17.25, 15.75), (17.25, 17.7), (17.55, yg),
                       (xt - 0.4, yg), (xt, yg - 0.4)], 0.3)
    cu.track("V5", B, [(d5[0], yg), d5], 0.3)
    # ---- 3V3: LDO tab pour island (zones()); pin 2 and C_OUT
    p2, c2 = pad(b, "U2", "2", max), pad(b, "C2", "1")
    cu.track("3V3", B, [(p2[0], p2[1]), (p2[0], 16.3)], 0.5)
    cu.track("3V3", B, [(p2[0] + 0.4, p2[1]), (p2[0] + 0.4, 19.4), (c2[0], 19.4 + c2[0] - p2[0] - 0.4),
                        c2], 0.5)
    # rear-edge top track to the mic bias resistor R8
    r8 = pad(b, "R8", "1")
    ya = 0.95
    cu.via("3V3", 25.0, 1.3)
    cu.track("3V3", F, [(25.0, 1.3), (24.65, ya), (r8[0] + 0.95, ya), (r8[0], ya + 0.95)], 0.4)
    cu.via("3V3", r8[0], ya + 0.95)
    cu.track("3V3", B, [(r8[0], ya + 0.95), r8], 0.4)
    # south trunk (top): island -> J3 pin 8, and west under the module (south of the USB
    # pair's end) to the module's 3V3 pin
    xs, ys = 36.0, 38.4
    j8 = pad(b, "J3", "8")
    u2p = pad(b, "U1", "2")
    cu.via("3V3", xs, 15.8)
    cu.track("3V3", F, [(xs, 15.8), (xs, ys)], 0.5)
    cu.track("3V3", F, chamfer([(xs, ys), (j8[0], ys), j8], 0.5), 0.5)
    cu.track("3V3", F, chamfer([(xs, ys), (u2p[0], ys), (u2p[0], 37.2)], 0.5), 0.5)
    cu.via("3V3", u2p[0], 37.2)
    cu.track("3V3", B, [(u2p[0], 37.2), u2p, (u2p[0], pad(b, "C4", "1")[1])], 0.5)
    # the codec's supply pins join the module's 3V3 locally (router, LEFTOVER)


def audio(cu):
    b = cu.b
    # earpiece: DAC_OUTP up to 22 uF, 22 R, then T and R1 of the jack (4.7 k to GND beside it)
    o, c12a = pad(b, "U3", "12"), pad(b, "C12", "1")
    cu.track("DAC_OUTP", B, [o, (o[0], 24.9)], 0.18)
    cu.track("DAC_OUTP", B, [(o[0], 24.9), c12a], 0.25)
    cu.track("EAR_AC", B, [pad(b, "C12", "2"), pad(b, "R6", "1")], 0.25)
    r6, r7 = pad(b, "R6", "2"), pad(b, "R7", "1")
    ring, tip = pad(b, "J2", "R1"), pad(b, "J2", "T")
    xe, ye = ring[0], 11.0
    # the ring pad's normally-closed contact (R1N, no net) sits right below it: the earpiece
    # line leaves the ring pad, turns west above R1N to the tip, and drops to R6/R7 in the
    # channel between R1N and the jack's locating hole
    cu.track("HS_EAR", B, [ring, (xe, ye), (tip[0], ye)], 0.25)
    xc = 8.1
    cu.track("HS_EAR", B, [(xc + 0.5, ye), (xc, ye + 0.5), (xc, r6[1] - (r6[0] - 0.725 - xc)),
                           (r6[0] - 0.725, r6[1]), r7], 0.25)
    # mic bias column: R8 (3V3) -> C13 -> R9, around C13's ground pad
    r8b, c13, r9a = pad(b, "R8", "2"), pad(b, "C13", "1"), pad(b, "R9", "1")
    xb = 13.9
    cu.track("MIC_BIAS", B, [r8b, (xb, r8b[1] + xb - r8b[0]), (xb, c13[1] - 0.4), (xb - 0.4, c13[1]),
                             c13, r9a], 0.25)
    # mic: jack sleeve -> down beside the ring pad -> R9 (the rest goes to the codec corner)
    s, r9b = pad(b, "J2", "S"), pad(b, "R9", "2")
    xm = 11.8
    cu.track("HS_MIC", B, [s, (xm, s[1]), (xm, r9b[1] - (r9b[0] - xm)), r9b], 0.25)


def codec(cu):
    """The codec corner (ES8311 on the bottom next to the module's pins 3-12), by hand.

    West: JACK_DET, WS and BCLK come straight down to module pins 4-6; DOUT and DIN swap order
    between the codec and the module, so they hop over on the top layer (a via pair each).
    South: MCLK, SCL, SDA run down at 0.4 mm pitch and fan out to pins 9-11 and the pull-ups.
    East: MIC1P goes straight into C14, the mic line leaves C14 northward between C10 and Q1;
    VMID and MIC1N (AC-grounded reference nodes) reach C9/C15 through a via pair each.
    3V3: three short top-layer spurs off the trunk under the module (R3 + C8, C6/C7, R4/R5).
    """
    b = cu.b
    T = lambda n: pad(b, "U3", n)                                   # noqa: E731
    W = 0.2
    # ---- ground pins into the exposed pad (0.15 mm: the corner pins sit 0.2 mm apart)
    cu.track("GND", B, [(8.6, 26.25), (9.4, 26.25)], 0.15)           # pin 10
    cu.track("GND", B, [(9.225, 28.3), (9.225, 27.6)], 0.15)         # pin 5
    cu.track("GND", B, [(T("20")[0], T("20")[1]), (10.7, T("20")[1])], 0.15)
    cu.via("GND", 10.0, 27.0)
    # ---- west: I2S + jack detect
    jx = 5.9
    r10 = pad(b, "R10", "2")
    cu.track("JACK_DET", B, [r10, (r10[0], 21.5), (jx, 21.5 + r10[0] - jx), (jx, pad(b, "U1", "4")[1])], W)
    xw, xb, xd = 6.45, 7.62, 7.05
    ws, u5 = T("8"), pad(b, "U1", "5")
    cu.track("I2S_WS", B, [ws, (xw + 0.3, ws[1]), (xw, ws[1] + 0.3), (xw, 33.8),
                           (u5[0], 33.8 + u5[0] - xw), u5], W)
    bc, u6 = T("6"), pad(b, "U1", "6")
    cu.track("I2S_BCLK", B, [bc, (xb + 0.3, bc[1]), (xb, bc[1] + 0.3), (xb, 32.4),
                             (u6[0], 32.4 + u6[0] - xb), u6], W)
    di, u7 = T("7"), pad(b, "U1", "7")
    cu.track("I2S_DIN", B, [di, (xd + 0.4, di[1]), (xd, di[1] + 0.4), (xd, 28.75)], W)
    cu.via("I2S_DIN", xd, 28.75)
    cu.track("I2S_DIN", F, [(xd, 28.75), (xd, 32.2), (xd + 1.2, 33.4), (u7[0], 33.4)], W)
    cu.via("I2S_DIN", u7[0], 33.4)
    cu.track("I2S_DIN", B, [(u7[0], 33.4), u7], W)
    do, u8 = T("9"), pad(b, "U1", "8")
    cu.track("I2S_DOUT", B, [do, (8.0, do[1]), (7.6, do[1] - 0.4)], W)
    cu.via("I2S_DOUT", 7.6, do[1] - 0.4)
    ydo = do[1] - 0.4 + (u8[0] - 7.6)
    cu.track("I2S_DOUT", F, [(7.6, do[1] - 0.4), (u8[0], ydo), (u8[0], 33.4)], W)
    cu.via("I2S_DOUT", u8[0], 33.4)
    cu.track("I2S_DOUT", B, [(u8[0], 33.4), u8], W)
    # ---- south: MCLK, SCL, SDA and the I2C pull-ups
    mc, u9 = T("2"), pad(b, "U1", "9")
    xm = 11.6
    cu.track("I2S_MCLK", B, [mc, (mc[0], 29.0), (xm, 29.0 + xm - mc[0]), (xm, 33.95),
                             (u9[0], 33.95 + u9[0] - xm), u9], W)
    sc, u10, r5 = T("1"), pad(b, "U1", "10"), pad(b, "R5", "1")
    xs = 12.0
    cu.track("I2C_SCL", B, [sc, (xs, sc[1] + xs - sc[0]), (xs, 32.55),
                            (xs + r5[1] - 32.55, r5[1]), r5, (r5[0], u10[1])], W)
    sd, u11, r4 = T("19"), pad(b, "U1", "11"), pad(b, "R4", "1")
    xa, xc = 12.4, 14.35
    cu.track("I2C_SDA", B, [sd, (12.0, sd[1]), (xa, sd[1] + 0.4), (xa, 29.0),
                            (xc, 29.0 + xc - xa), (xc, 33.95), (u11[0], 33.95 + u11[0] - xc), u11], W)
    cu.track("I2C_SDA", B, [(xc, r4[1]), r4], W)
    # ---- east: mic, VMID, MIC1N, references
    m18, c14b = T("18"), pad(b, "C14", "2")
    cu.track("MIC1P", B, [m18, (12.2, m18[1])], 0.18)
    cu.track("MIC1P", B, [(12.2, m18[1]), c14b], 0.25)
    r9b, c14a = pad(b, "R9", "2"), pad(b, "C14", "1")
    xh = 13.9
    cu.track("HS_MIC", B, [r9b, (xh, r9b[1] + xh - r9b[0]), (xh, 24.4),
                           (c14a[0], 24.4 + c14a[0] - xh), c14a], 0.25)
    vm, c9a = T("16"), pad(b, "C9", "1")
    v1, v2 = (12.15, 25.5), (11.2, 19.9)
    cu.track("ES8311_VMID", B, [vm, (11.55, vm[1]), (12.15, 25.6)], W)
    cu.via("ES8311_VMID", *v1)
    cu.track("ES8311_VMID", F, [v1, (v1[0], v2[1] + v1[0] - v2[0]), v2], W)
    cu.via("ES8311_VMID", *v2)
    cu.track("ES8311_VMID", B, [v2, (v2[0], c9a[1])], W)
    mn, c15a = T("17"), pad(b, "C15", "1")
    v3, v4 = (13.0, 26.0), (12.3, 19.95)
    cu.track("MIC1N", B, [mn, (12.4, mn[1]), v3], W)
    cu.via("MIC1N", *v3)
    cu.track("MIC1N", F, [v3, (v3[0], v4[1] + v3[0] - v4[0]), v4], W)
    cu.via("MIC1N", *v4)
    cu.track("MIC1N", B, [v4, (v4[0] - 0.55, v4[1] + 0.55)], W)
    ad, c10 = T("15"), pad(b, "C10", "1")
    cu.track("ES8311_ADCVREF", B, [ad, (ad[0], 25.15), (11.05, 24.9), (11.95, 24.9), (12.45, 24.4)], W)
    da = T("14")
    cu.track("ES8311_DACVREF", B, [da, (da[0], 24.9), (10.9, 24.4)], W)
    # ---- 3V3
    P3 = 0.4
    c7, c6 = pad(b, "C7", "1"), pad(b, "C6", "1")
    cu.track("3V3", B, [(T("4")[0], T("4")[1]), (T("4")[0], 29.6)], W)
    cu.track("3V3", B, [(T("3")[0], T("3")[1]), (T("3")[0], 29.6)], W)
    cu.track("3V3", B, [c7, (9.2, c7[1]), (c6[0], c7[1])], P3)
    cu.via("3V3", 9.2, c7[1])
    cu.track("3V3", F, [(9.2, c7[1]), (9.2, 31.9), (10.245, 32.945)], P3)
    cu.track("3V3", F, [(10.245, 32.945), (10.245, 38.4)], 0.25)      # between two vias
    p11, c8 = T("11"), pad(b, "C8", "1")
    cu.track("3V3", B, [p11, (p11[0], 25.0), (8.6, 24.4)], W)          # ends in C8's pad
    cu.track("3V3", B, [(c8[0], 24.3), (7.2, 24.3)], P3)
    cu.via("3V3", 7.2, 24.3)
    xsp = 5.025
    cu.track("3V3", F, [(7.2, 24.3), (xsp, 24.3 + 7.2 - xsp), (xsp, 38.4)], P3)
    r3 = pad(b, "R3", "2")
    cu.via("3V3", xsp, 28.3)
    cu.track("3V3", B, [r3, (xsp, 28.3)], P3)
    r5b, r4b = pad(b, "R5", "2"), pad(b, "R4", "2")
    cu.via("3V3", 12.9, 30.5)
    cu.via("3V3", 15.3, 30.5)
    cu.track("3V3", B, [(12.9, 30.5), (13.4, 31.0), r5b], P3)
    cu.track("3V3", B, [(15.3, 30.5), r4b], P3)
    cu.track("3V3", F, [(15.3, 30.5), (12.9, 30.5), (12.9, 38.4)], P3)
    c3, c4 = pad(b, "C3", "1"), pad(b, "C4", "1")
    cu.track("3V3", B, [(c3[0], 33.2), (c4[0], 33.2)], P3)
    # ---- EN: pin 3 -> R3 -> C5 -> both pads of RESET
    u3, r3a, c5, s1 = pad(b, "U1", "3"), pad(b, "R3", "1"), pad(b, "C5", "1"), pad(b, "SW1", "1", max)
    xe = 4.2
    cu.track("EN", B, [(4.75, u3[1]), (4.75, r3a[1]), (xe, r3a[1]), (xe, c5[1])], W)
    cu.track("EN", B, [c5, (c5[0], 27.1), (c5[0] - 1.025, 26.075), (s1[0], 26.075)], W)
    cu.track("EN", B, [s1, pad(b, "SW1", "1", min)], W)
    # ---- jack detect's other side, ringer
    tn, r10a = pad(b, "J2", "TN"), pad(b, "R10", "1")
    cu.track("HS_DET", B, [tn, (4.8, tn[1]), (r10a[0], tn[1] + r10a[0] - 4.8), r10a], W)
    q3, bz2, r11b = pad(b, "Q1", "3"), pad(b, "BZ1", "2"), pad(b, "R11", "2")
    cu.track("BUZZER_DRV", B, [q3, (q3[0], 18.0)], 0.3)
    cu.track("BUZZER_DRV", B, [r11b, (r11b[0], 15.8), (15.65, 16.55)], 0.3)
    r12a, r12b, q1b, u12 = pad(b, "R12", "1"), pad(b, "R12", "2"), pad(b, "Q1", "1"), pad(b, "U1", "12")
    cu.track("BUZZER_B", B, [r12b, (r12b[0], 24.2), (q1b[0], 24.2 - (q1b[0] - r12b[0])), q1b], W)
    cu.track("BUZZER", B, [r12a, (r12a[0], 33.8), (u12[0], 33.8 + r12a[0] - u12[0]), u12], W)


# ---------------------------------------------------------------------------------------------
# 2. grid router for the leftovers

RES = 0.05
MARGIN = 0.01
NARROW = 0.15            # neck-down width near the net's own pads (fine-pitch escapes)
NEAR = 0.8               # mm around own pads where the neck-down is allowed
MIN_RUN = 5              # cells between turns (0.25 mm straight, 0.35 mm diagonal)
TURN = 6.0               # cost of a 45° turn (cells)
VIA_COST = {"Default": 50.0, "Power": 40.0, "Audio": 400.0, "USB": 1e9, "Eth": 300.0,
            "PoE": 60.0, "Chassis": 50.0}
TOP_COST = 1.6           # the top is the GND plane: signals prefer the bottom
DIRS = [(1, 0), (1, 1), (0, 1), (-1, 1), (-1, 0), (-1, -1), (0, -1), (1, -1)]


class Router:
    def __init__(self, board, window):
        self.b = board
        self.x0, self.y0, self.x1, self.y1 = window
        self.nx = int(round((self.x1 - self.x0) / RES)) + 1
        self.ny = int(round((self.y1 - self.y0) / RES)) + 1
        self.X = self.x0 + np.arange(self.nx)[None, :] * RES
        self.Y = self.y0 + np.arange(self.ny)[:, None] * RES
        self.items = []
        self.log = []
        self.extend_ends = False
        self._collect()
        self.edge_d = self._edge_distance()
        self.protect = [np.zeros((self.ny, self.nx), bool), np.zeros((self.ny, self.nx), bool)]

    # ---- obstacles
    def _collect(self):
        for fp in self.b.GetFootprints():
            for p in fp.Pads():
                x, y = unP(p.GetPosition())
                bb = p.GetBoundingBox()
                (bx0, by0), (bx1, by1) = unP(bb.GetOrigin()), unP(bb.GetEnd())
                if bx1 < self.x0 - 3 or bx0 > self.x1 + 3 or by1 < self.y0 - 3 or by0 > self.y1 + 3:
                    continue
                if p.GetAttribute() == pcbnew.PAD_ATTRIB_NPTH:
                    dx, dy = pcbnew.ToMM(p.GetDrillSize().x), pcbnew.ToMM(p.GetDrillSize().y)
                    g = ("circle", x, y, dx / 2) if abs(dx - dy) < 1e-3 else ("rect", bx0, by0, bx1, by1)
                    self.items.append(dict(layers=(F, B), g=g, net="", clr=HOLE_CLR, drill=max(dx, dy) / 2))
                    continue
                layers = tuple(L for L in (F, B) if p.IsOnLayer(LAYER[L]))
                if not layers:                 # paste-only aperture pads
                    continue
                sx, sy = pcbnew.ToMM(p.GetSize().x), pcbnew.ToMM(p.GetSize().y)
                circ = p.GetShape(LAYER[layers[0]]) == pcbnew.PAD_SHAPE_CIRCLE and abs(sx - sy) < 1e-3
                g = ("circle", x, y, sx / 2) if circ else ("rect", bx0, by0, bx1, by1)
                drill = pcbnew.ToMM(p.GetDrillSize().x) / 2 if p.HasHole() else 0.0
                self.items.append(dict(layers=layers, g=g, net=p.GetNetname(),
                                       clr=CLASS[cls(p.GetNetname())][1], drill=drill, pad=p))
        for t in self.b.GetTracks():
            self.add_track(t)

    def add_track(self, t):
        net = t.GetNetname()
        if t.Type() == pcbnew.PCB_VIA_T:
            x, y = unP(t.GetPosition())
            it = dict(layers=(F, B), g=("circle", x, y, VIA_D / 2), net=net, clr=CLASS[cls(net)][1],
                      drill=VIA_DRILL / 2)
        else:
            (ax, ay), (bx, by) = unP(t.GetStart()), unP(t.GetEnd())
            L = F if t.GetLayer() == pcbnew.F_Cu else B
            it = dict(layers=(L,), g=("seg", ax, ay, bx, by, pcbnew.ToMM(t.GetWidth()) / 2), net=net,
                      clr=CLASS[cls(net)][1], drill=0.0)
        self.items.append(it)
        return it

    def _edge_distance(self):
        """distance from each cell to the rounded-rectangle outline (inside positive)."""
        r = 3.0
        X, Y = self.X, self.Y
        cx = np.clip(X, r, W - r)
        cy = np.clip(Y, r, H - r)
        corner = np.hypot(X - cx, Y - cy)
        inner = np.minimum(np.minimum(X, W - X), np.minimum(Y, H - Y))
        in_corner = (corner > 0)
        return np.where(in_corner, r - corner, inner)

    def _dist(self, g):
        """(j0, j1, i0, i1, distance array) of a geometry over its window neighbourhood."""
        pad_ = 1.2
        if g[0] == "rect":
            _, a, b_, c, d = g
            bx0, by0, bx1, by1 = a, b_, c, d
        elif g[0] == "circle":
            _, cx, cy, r = g
            bx0, by0, bx1, by1 = cx - r, cy - r, cx + r, cy + r
        else:
            _, ax, ay, bx, by, hw = g
            bx0, by0, bx1, by1 = min(ax, bx) - hw, min(ay, by) - hw, max(ax, bx) + hw, max(ay, by) + hw
        i0 = max(0, int(math.floor((bx0 - pad_ - self.x0) / RES)))
        i1 = min(self.nx, int(math.ceil((bx1 + pad_ - self.x0) / RES)) + 1)
        j0 = max(0, int(math.floor((by0 - pad_ - self.y0) / RES)))
        j1 = min(self.ny, int(math.ceil((by1 + pad_ - self.y0) / RES)) + 1)
        if i0 >= i1 or j0 >= j1:
            return None
        X = self.x0 + np.arange(i0, i1)[None, :] * RES
        Y = self.y0 + np.arange(j0, j1)[:, None] * RES
        if g[0] == "rect":
            dx = np.maximum(np.maximum(a - X, 0), X - c)
            dy = np.maximum(np.maximum(b_ - Y, 0), Y - d)
            dist = np.hypot(dx, dy)
        elif g[0] == "circle":
            dist = np.maximum(np.hypot(X - cx, Y - cy) - r, 0)
        else:
            vx, vy = bx - ax, by - ay
            L2 = vx * vx + vy * vy
            t = np.clip(((X - ax) * vx + (Y - ay) * vy) / L2, 0, 1) if L2 > 0 else 0.0
            dist = np.maximum(np.hypot(ax + t * vx - X, ay + t * vy - Y) - hw, 0)
        return j0, j1, i0, i1, dist

    def masks(self, net, w):
        c_own = CLASS[cls(net)][1]
        shape = (self.ny, self.nx)
        full = [self.edge_d < EDGE + w / 2 + MARGIN for _ in (F, B)]
        narrow = [self.edge_d < EDGE + NARROW / 2 + MARGIN for _ in (F, B)]
        via_bad = self.edge_d < EDGE + VIA_D / 2 + MARGIN
        near = np.zeros(shape, bool)
        for it in self.items:
            r = self._dist(it["g"])
            if r is None:
                continue
            j0, j1, i0, i1, dist = r
            if it["net"] == net and net:
                if "pad" in it:
                    near[j0:j1, i0:i1] |= dist < NEAR
                if it["drill"] > 0:
                    cx, cy = self._centre(it["g"])
                    via_bad[j0:j1, i0:i1] |= np.hypot(
                        self.x0 + np.arange(i0, i1)[None, :] * RES - cx,
                        self.y0 + np.arange(j0, j1)[:, None] * RES - cy) \
                        < it["drill"] + HOLE_TO_HOLE + VIA_DRILL / 2 + MARGIN
                continue
            c = max(c_own, it["clr"], iso_clearance(net, it))
            for L in it["layers"]:
                full[L][j0:j1, i0:i1] |= dist < c + w / 2 + MARGIN
                narrow[L][j0:j1, i0:i1] |= dist < c + NARROW / 2 + MARGIN
            via_bad[j0:j1, i0:i1] |= dist < c + VIA_D / 2 + MARGIN
            if it["drill"] > 0:
                cx, cy = self._centre(it["g"])
                via_bad[j0:j1, i0:i1] |= np.hypot(self.x0 + np.arange(i0, i1)[None, :] * RES - cx,
                                                   self.y0 + np.arange(j0, j1)[:, None] * RES - cy) \
                    < it["drill"] + HOLE_TO_HOLE + VIA_DRILL / 2 + MARGIN
        for L in (F, B):
            full[L] |= self.protect[L]
            narrow[L] |= self.protect[L]
        via_bad |= self.protect[F] | self.protect[B]
        ok_full = [~full[L] for L in (F, B)]
        ok = [~full[L] | (~narrow[L] & near) for L in (F, B)]
        return ok, ok_full, ~via_bad

    @staticmethod
    def _centre(g):
        if g[0] == "circle":
            return g[1], g[2]
        if g[0] == "rect":
            return (g[1] + g[3]) / 2, (g[2] + g[4]) / 2
        return (g[1] + g[3]) / 2, (g[2] + g[4]) / 2

    def protect_under(self, nets, layer, dist):
        """Keep other nets' copper off `layer` within `dist` of these nets' bottom copper (no
        slots in the top GND plane under the USB pair and the audio lines)."""
        for it in self.items:
            if it["net"] in nets and B in it["layers"]:
                r = self._dist(it["g"])
                if r is None:
                    continue
                j0, j1, i0, i1, d = r
                self.protect[layer][j0:j1, i0:i1] |= d < dist

    # ---- islands of a net (cells covered by its copper, per layer)
    def cells(self, it):
        r = self._dist(it["g"])
        out = {}
        if r is None:
            return out
        j0, j1, i0, i1, dist = r
        inside = dist <= 0.0
        js, is_ = np.nonzero(inside)
        s = set(((js + j0) * self.nx + (is_ + i0)).tolist())
        for L in it["layers"]:
            out[L] = s
        return out

    def islands(self, net):
        its = [it for it in self.items if it["net"] == net]
        cs = [self.cells(it) for it in its]
        parent = list(range(len(its)))

        def find(a):
            while parent[a] != a:
                parent[a] = parent[parent[a]]
                a = parent[a]
            return a

        index = {}
        for k, c in enumerate(cs):
            for L, s in c.items():
                for cell in s:
                    key = (L, cell)
                    if key in index:
                        ra, rb = find(k), find(index[key])
                        if ra != rb:
                            parent[ra] = rb
                    else:
                        index[key] = k
        groups = {}
        for k in range(len(its)):
            groups.setdefault(find(k), []).append(k)
        out = []
        for ks in groups.values():
            m = {}
            for k in ks:
                for L, s in cs[k].items():
                    m.setdefault(L, set()).update(s)
            if any(m.values()):
                out.append(dict(cells=m, items=[its[k] for k in ks]))
        out.sort(key=lambda g: min(min(s) for s in g["cells"].values() if s))
        return out

    # ---- A* over (layer, cell, direction, run)
    def astar(self, src, tgt, ok, via_ok, cost_via, max_expand=2000000):
        nx, N = self.nx, self.nx * self.ny
        okb = [bytes(o.ravel().astype(np.uint8)) for o in ok]
        vb = bytes(via_ok.ravel().astype(np.uint8))
        tset = set()
        for L, s in tgt.items():
            for c in s:
                tset.add(L * N + c)
        if not tset:
            return None
        tj = [((t % N) // nx) for t in tset]
        ti = [((t % N) % nx) for t in tset]
        tx0, tx1, ty0, ty1 = min(ti), max(ti), min(tj), max(tj)
        D = math.sqrt(2)

        def h(i, j):
            dx = tx0 - i if i < tx0 else (i - tx1 if i > tx1 else 0)
            dy = ty0 - j if j < ty0 else (j - ty1 if j > ty1 else 0)
            return (dx + dy) + (D - 2) * min(dx, dy)

        openh, g, came = [], {}, {}
        for L, s in src.items():
            for c in s:
                if not okb[L][c]:
                    continue
                st = (L * N + c, 8, MIN_RUN)
                g[st] = 0.0
                j, i = divmod(c, nx)
                heapq.heappush(openh, (h(i, j), 0.0, st))
        closed = set()
        n = 0
        while openh:
            f, gc, st = heapq.heappop(openh)
            if st in closed:
                continue
            closed.add(st)
            lc, d, run = st
            if lc in tset and d != 8:
                path = [st]
                while path[-1] in came:
                    path.append(came[path[-1]])
                return [s[0] for s in path[::-1]]
            n += 1
            if n > max_expand:
                return None
            L, c = divmod(lc, N)
            j, i = divmod(c, nx)
            lcost = TOP_COST if L == F else 1.0
            for nd, (di, dj) in enumerate(DIRS):
                if d != 8:
                    turn = min((nd - d) % 8, (d - nd) % 8)
                    if turn > 1 or (turn == 1 and run < MIN_RUN):
                        continue
                else:
                    turn = 0
                ii, jj = i + di, j + dj
                if ii < 0 or jj < 0 or ii >= nx or jj >= self.ny:
                    continue
                ncell = jj * nx + ii
                if not okb[L][ncell]:
                    continue
                if di and dj and not (okb[L][j * nx + ii] and okb[L][jj * nx + i]):
                    continue
                step = (D if di and dj else 1.0) * lcost + (TURN if turn else 0.0)
                nrun = 1 if (turn or d == 8) else min(run + 1, MIN_RUN)
                ns = (L * N + ncell, nd, nrun)
                ng = gc + step
                if ng < g.get(ns, 1e18):
                    g[ns] = ng
                    came[ns] = st
                    heapq.heappush(openh, (ng + h(ii, jj) * 1.05, ng, ns))
            if vb[c] and (d == 8 or run >= MIN_RUN):
                L2 = 1 - L
                if okb[L2][c]:
                    ns = (L2 * N + c, 8, MIN_RUN)
                    ng = gc + cost_via
                    if ng < g.get(ns, 1e18):
                        g[ns] = ng
                        came[ns] = st
                        heapq.heappush(openh, (ng + h(i, j), ng, ns))
        return None

    def commit(self, cu, net, path, w, ok_full):
        N = self.nx * self.ny
        pts = []
        for lc in path:
            L, c = divmod(lc, N)
            j, i = divmod(c, self.nx)
            pts.append((L, i, j))
        added = []

        def xy(i, j):
            return (round(self.x0 + i * RES, 4), round(self.y0 + j * RES, 4))

        k = 0
        while k < len(pts) - 1:
            L, i, j = pts[k]
            L2, i2, j2 = pts[k + 1]
            if L2 != L:
                added.append(cu.via(net, *xy(i, j)))
                k += 1
                continue
            dv = (i2 - i, j2 - j)
            wide = ok_full[L][j, i] and ok_full[L][j2, i2]
            m = k + 1
            while m + 1 < len(pts):
                L3, i3, j3 = pts[m + 1]
                if L3 != L or (i3 - pts[m][1], j3 - pts[m][2]) != dv:
                    break
                if (ok_full[L][j3, i3] and ok_full[L][pts[m][2], pts[m][1]]) != wide:
                    break
                m += 1
            added += cu.track(net, L, [xy(i, j), xy(pts[m][1], pts[m][2])], w if wide else NARROW)
            k = m
        # a path may end exactly on a pad's or track's edge (the grid touches it), which KiCad
        # doesn't count as connected: carry each end on in its own direction (45° multiples)
        # until it is inside that copper
        def inside(L, e):
            for it in self.items:
                if it["net"] != net or L not in it["layers"]:
                    continue
                g = it["g"]
                if g[0] == "seg":
                    ax, ay, bx, by, hw = g[1:]
                    vx, vy = bx - ax, by - ay
                    L2 = vx * vx + vy * vy
                    t = 0.0 if L2 == 0 else max(0.0, min(1.0, ((e[0] - ax) * vx + (e[1] - ay) * vy) / L2))
                    if math.dist((ax + t * vx, ay + t * vy), e) <= hw - 0.03:
                        return True
                elif g[0] == "circle":
                    if math.dist((g[1], g[2]), e) <= g[3] - 0.03:
                        return True
                else:                              # rect / roundrect pad: keep off its corners
                    m = 0.03
                    if g[1] + m <= e[0] <= g[3] - m and g[2] + m <= e[1] <= g[4] - m:
                        rc = 0.3 * min(g[3] - g[1], g[4] - g[2]) if "pad" in it else 0.0
                        cx_ = min(e[0] - g[1], g[3] - e[0])
                        cy_ = min(e[1] - g[2], g[4] - e[1])
                        if not (cx_ < rc and cy_ < rc):
                            return True
            return False

        for a, b_ in ((pts[1], pts[0]), (pts[-2], pts[-1])) if len(pts) > 1 and self.extend_ends else ():
            if a[0] != b_[0]:
                continue
            e = xy(b_[1], b_[2])
            d = (b_[1] - a[1], b_[2] - a[2])
            n = math.hypot(*d)
            if n == 0 or inside(b_[0], e):
                continue
            u = (d[0] / n * RES, d[1] / n * RES)
            q = e
            for _ in range(10):
                q = (round(q[0] + u[0], 4), round(q[1] + u[1], 4))
                if inside(b_[0], q):
                    added += cu.track(net, b_[0], [e, q], NARROW)
                    break
            else:                                  # e.g. along a pad's edge: into its centre
                for it in self.items:
                    if it["net"] == net and b_[0] in it["layers"] and "pad" in it:
                        g = it["g"]
                        c = self._centre(g)
                        hit = (math.dist(c, e) <= g[3] + 0.02) if g[0] == "circle" else \
                            (g[1] - 0.02 <= e[0] <= g[3] + 0.02 and g[2] - 0.02 <= e[1] <= g[4] + 0.02)
                        if hit:
                            # toward its centre in the nearest 45° direction, else straight in
                            dx, dy = c[0] - e[0], c[1] - e[1]
                            k = round(math.atan2(dy, dx) / (math.pi / 4))
                            u2 = (math.cos(k * math.pi / 4) * RES, math.sin(k * math.pi / 4) * RES)
                            q2 = e
                            for _ in range(40):
                                q2 = (round(q2[0] + u2[0], 4), round(q2[1] + u2[1], 4))
                                if inside(b_[0], q2):
                                    break
                            else:
                                q2 = (round(c[0], 4), round(c[1], 4))
                            added += cu.track(net, b_[0], [e, q2], NARROW)
                            break
        for t in added:
            self.add_track(t)
        return added

    def route_net(self, cu, net, w=None, cost_via=None):
        w = w or CLASS[cls(net)][0]
        cost_via = VIA_COST[cls(net)] if cost_via is None else cost_via
        isl = self.islands(net)
        if len(isl) < 2:
            return 0, 0
        ok, ok_full, via_ok = self.masks(net, w)
        conn, rest = isl[0], isl[1:]
        done = fail = 0
        while rest:
            def gap(g):
                a = [c for s in conn["cells"].values() for c in s]
                b_ = [c for s in g["cells"].values() for c in s]
                ca = (np.mean([c % self.nx for c in a]), np.mean([c // self.nx for c in a]))
                cb = (np.mean([c % self.nx for c in b_]), np.mean([c // self.nx for c in b_]))
                return math.dist(ca, cb)
            rest.sort(key=gap)
            tgt = rest.pop(0)
            path = self.astar(conn["cells"], tgt["cells"], ok, via_ok, cost_via)
            if not path:
                fail += 1
                refs = sorted({f"{it['pad'].GetParentFootprint().GetReference()}.{it['pad'].GetNumber()}"
                               for it in tgt["items"] if "pad" in it})
                self.log.append(f"FAIL {net}: {refs}")
                continue
            self.commit(cu, net, path, w, ok_full)
            done += 1
            N = self.nx * self.ny
            for L, s in tgt["cells"].items():
                conn["cells"].setdefault(L, set()).update(s)
            for lc in path:
                L, c = divmod(lc, N)
                conn["cells"].setdefault(L, set()).add(c)
            ok, ok_full, via_ok = self.masks(net, w)
        return done, fail

    def ascii(self, net, box, w=None, step=0.1):
        """Debug view of a region for `net`: '#' blocked both layers, 'b' bottom free only,
        't' top free only, '.' both free, 'o' the net's own copper (bottom)."""
        w = w or CLASS[cls(net)][0]
        ok, ok_full, via_ok = self.masks(net, w)
        own = np.zeros((self.ny, self.nx), bool)
        for g in self.islands(net):
            for c in g["cells"].get(B, ()):
                own.flat[c] = True
        x0, y0, x1, y1 = box
        k = int(round(step / RES))
        lines = []
        for y in np.arange(y0, y1, step):
            j = int(round((y - self.y0) / RES))
            row = ""
            for x in np.arange(x0, x1, step):
                i = int(round((x - self.x0) / RES))
                if own[j, i]:
                    row += "o"
                elif ok[B][j, i] and ok[F][j, i]:
                    row += "."
                elif ok[B][j, i]:
                    row += "b"
                elif ok[F][j, i]:
                    row += "t"
                else:
                    row += "#"
            lines.append(f"{y:6.2f} {row}")
        return "\n".join(lines)

    def ground_via(self, cu, p, max_d=2.2):
        """A GND via next to an SMD ground pad: the nearest spot where a via fits, joined to the
        pad by one short straight or 45° track."""
        x, y = unP(p.GetPosition())
        ok, ok_full, via_ok = self.masks("GND", 0.3)
        best = None
        for r in np.arange(0.5, max_d + 1e-6, 0.05):
            for k in range(8):
                a = k * math.pi / 4
                vx, vy = x + r * math.cos(a), y + r * math.sin(a)
                # exact point on the 0/45/90° ray from the pad centre; all four grid cells
                # around it must allow a via (the grid is coarser than the point)
                i0, j0 = int(math.floor((vx - self.x0) / RES)), int(math.floor((vy - self.y0) / RES))
                if not (0 <= i0 < self.nx - 1 and 0 <= j0 < self.ny - 1) or \
                        not via_ok[j0:j0 + 2, i0:i0 + 2].all():
                    continue
                if not self._segment_ok(ok, x, y, vx, vy):
                    continue
                best = (vx, vy)
                break
            if best:
                break
        if not best:
            self.log.append(f"no GND via for {p.GetParentFootprint().GetReference()}.{p.GetNumber()}")
            return False
        vx, vy = float(best[0]), float(best[1])
        for t in cu.track("GND", B, [(x, y), (vx, vy)], 0.3):
            self.add_track(t)
        self.add_track(cu.via("GND", vx, vy))
        return True

    def _segment_ok(self, ok, x, y, vx, vy):
        n = max(2, int(math.dist((x, y), (vx, vy)) / (RES / 2)))
        for k in range(n + 1):
            px, py = x + (vx - x) * k / n, y + (vy - y) * k / n
            i, j = int(round((px - self.x0) / RES)), int(round((py - self.y0) / RES))
            if not ok[B][j, i]:
                return False
        return True


# order: analog first, then supplies, then the digital buses of the codec corner
LEFTOVER = ["MIC1P", "HS_MIC", "ES8311_ADCVREF", "ES8311_DACVREF", "MIC1N", "ES8311_VMID",
            "I2C_SDA", "I2C_SCL", "I2S_MCLK", "I2S_BCLK", "I2S_WS", "I2S_DIN", "I2S_DOUT",
            "JACK_DET", "EN", "3V3", "HS_DET", "BUZZER", "BUZZER_B", "BUZZER_DRV"]
# the mic line stays on the bottom over the unbroken top plane; the AC-grounded reference nodes
# may hop through vias like any digital net
VIA_NET = {"MIC1P": 1e9, "HS_MIC": 1e9, "MIC1N": 50.0}
CORNER = (0.0, 0.0, 40.0, 60.0)          # router window: the electronics band
# hw v0.2: second window over the wired network (W5500, RJ45, PoE) at the right end
ETH_WINDOW = (98.0, 15.0, 156.0, 64.0)
# routing order: the isolated PoE side first (the tightest), then the module output, the PHY
# pairs, supplies, the W5500's own pins, the LEDs and the SPI ends
ETH_NETS = ["POE_5V", "POE_ADJ", "W5500_TOCAP", "W5500_1V2O", "ETH_RST", "ETH_3V3A", "ETH_3V3",
            "V5", "W5500_XI", "W5500_XO", "ETH_CS", "ETH_MISO",
            "ETH_LED_LINK_K", "ETH_LED_ACTIVITY_K", "ETH_SHIELD"]
# the PoE module's top-layer keep-out under its body (its footprint's rule area, as rectangles)
# no GND stitching where it would sit within 3 mm of the PoE input side
POE_NO_GND = [(128.4, 27.9, 156.0, 43.2), (129.0, 36.0, 147.0, 51.3)]
PS1_KEEPOUT = [(139.47, 24.17, 150.84, 27.48), (147.85, 27.17, 156.38, 30.48),
               (139.47, 27.17, 142.47, 34.28), (133.77, 31.28, 142.47, 34.28)]


# ---------------------------------------------------------------------------------------------
# 3. zones and stitching


def outline_poly():
    pts = []
    r = 3.0
    for (cx, cy, a0) in ((W - r, r, -90), (W - r, H - r, 0), (r, H - r, 90), (r, r, 180)):
        for k in range(7):
            a = math.radians(a0 + k * 15)
            pts.append((cx + r * math.cos(a), cy + r * math.sin(a)))
    return pts


def add_zone(board, net, layer, pts, priority, name):
    z = pcbnew.ZONE(board)
    z.SetLayer(layer)
    z.SetNet(board.FindNet(net))
    z.SetZoneName(name)
    ol = z.Outline()
    ol.NewOutline()
    for x, y in pts:
        ol.Append(P(x, y))
    z.SetAssignedPriority(priority)
    z.SetLocalClearance(MM(0.25))
    z.SetMinThickness(MM(0.25))
    z.SetPadConnection(pcbnew.ZONE_CONNECTION_THT_THERMAL)
    z.SetThermalReliefGap(MM(0.3))
    z.SetThermalReliefSpokeWidth(MM(0.4))
    z.SetIslandRemovalMode(pcbnew.ISLAND_REMOVAL_MODE_ALWAYS)
    z.SetFillMode(pcbnew.ZONE_FILL_MODE_POLYGONS)
    board.Add(z)
    return z


ISLAND_3V3 = [(23.0, 0.6), (37.0, 0.6), (37.0, 16.6), (23.0, 16.6)]


def zones(board):
    add_zone(board, "3V3", pcbnew.B_Cu, ISLAND_3V3, 2, "3V3 LDO tab island")
    add_zone(board, "GND", pcbnew.F_Cu, outline_poly(), 1, "GND top")
    add_zone(board, "GND", pcbnew.B_Cu, outline_poly(), 1, "GND bottom")
    poe_keepouts(board)


def poe_keepouts(board):
    """hw v0.2: no copper pour within 3 mm of the PoE input side, on both layers (the zone filler
    run from Python doesn't apply fab-common.kicad_dru's custom rules; DRC does, and checks it).
    One rule area per PoE pad / track / via: its bounding box grown by the isolation distance."""
    g = POE_ISO + 0.1
    boxes = []
    for fp in board.GetFootprints():
        for p in fp.Pads():
            if cls(p.GetNetname()) == "PoE":
                boxes.append(p.GetBoundingBox())
    for t in board.GetTracks():
        if cls(t.GetNetname()) == "PoE":
            boxes.append(t.GetBoundingBox())
    for bb in boxes:
        (x0, y0), (x1, y1) = unP(bb.GetOrigin()), unP(bb.GetEnd())
        z = pcbnew.ZONE(board)
        z.SetIsRuleArea(True)
        z.SetDoNotAllowZoneFills(True)
        z.SetDoNotAllowTracks(False)
        z.SetDoNotAllowVias(False)
        z.SetDoNotAllowPads(False)
        z.SetDoNotAllowFootprints(False)
        ls = pcbnew.LSET()
        ls.AddLayer(pcbnew.F_Cu)
        ls.AddLayer(pcbnew.B_Cu)
        z.SetLayerSet(ls)
        z.SetZoneName("PoE isolation (no pour)")
        ol = z.Outline()
        ol.NewOutline()
        for x, y in ((x0 - g, y0 - g), (x1 + g, y0 - g), (x1 + g, y1 + g), (x0 - g, y1 + g)):
            ol.Append(P(x, y))
        board.Add(z)


def fill(board):
    f = pcbnew.ZONE_FILLER(board)
    f.Fill(board.Zones())


def stitch(cu, board):
    """GND vias on a grid (6 mm in the electronics band, 9 mm elsewhere) and every ~6 mm
    along the edges, only where both GND fills surround the via with margin and away from
    parts' bodies on the bottom, holes and the mounting-screw heads."""
    zs = {z.GetLayer(): z for z in board.Zones() if z.GetNetname() == "GND"}
    polys = {L: zs[L].GetFilledPolysList(L) for L in (pcbnew.F_Cu, pcbnew.B_Cu)}
    bodies = []
    for fp in board.GetFootprints():
        ref = fp.GetReference()
        if fp.IsFlipped() and not ref.startswith(("G", "H")):
            bb = fp.GetCourtyard(pcbnew.B_CrtYd).BBox()
            (x0, y0), (x1, y1) = unP(bb.GetOrigin()), unP(bb.GetEnd())
            bodies.append((x0, y0, x1, y1))
    holes = []
    for fp in board.GetFootprints():
        for p in fp.Pads():
            if p.HasHole():
                holes.append((*unP(p.GetPosition()), pcbnew.ToMM(max(p.GetDrillSize().x, p.GetDrillSize().y)) / 2,
                              fp.GetReference()))
    for t in board.GetTracks():
        if t.Type() == pcbnew.PCB_VIA_T:
            holes.append((*unP(t.GetPosition()), VIA_DRILL / 2, "via"))
    screws = [(h[0], h[1]) for h in holes if h[3] in ("H1", "H2", "H3", "H4", "H5", "H6")]

    def inside(x, y):
        for L, ps in polys.items():
            for k in range(9):
                if k == 8:
                    px, py = x, y
                else:
                    a = k * math.pi / 4
                    px, py = x + 0.42 * math.cos(a), y + 0.42 * math.sin(a)
                if not ps.Contains(P(px, py)):
                    return False
        return True

    def free(x, y):
        if any(b[0] - 0.2 <= x <= b[2] + 0.2 and b[1] - 0.2 <= y <= b[3] + 0.2 for b in bodies):
            return False
        if any(k[0] <= x <= k[2] and k[1] <= y <= k[3] for k in POE_NO_GND):
            return False
        if any(math.dist((x, y), s) < 4.2 for s in screws):
            return False
        return all(math.dist((x, y), (hx, hy)) >= hr + VIA_DRILL / 2 + HOLE_TO_HOLE + 0.05
                   for hx, hy, hr, _ in holes)

    cand = []
    for x in np.arange(3.0, W - 2.0, 3.0):
        for y in np.arange(3.0, H - 2.0, 3.0):
            band = x < 40.0
            step = 6.0 if band else 9.0
            if abs((x / step) - round(x / step)) < 1e-6 and abs((y / step) - round(y / step)) < 1e-6:
                cand.append((x, y))
    e = 1.4
    for x in np.arange(6.0, W - 3.0, 6.0):
        cand += [(x, e), (x, H - e)]
    for y in np.arange(6.0, H - 3.0, 6.0):
        cand += [(e, y), (W - e, y)]
    placed = 0
    for x, y in cand:
        # nudge within 1.5 mm to find a legal spot
        for dx, dy in [(0, 0), (0.75, 0), (-0.75, 0), (0, 0.75), (0, -0.75), (1.5, 0), (-1.5, 0),
                       (0, 1.5), (0, -1.5), (0.75, 0.75), (-0.75, -0.75), (0.75, -0.75), (-0.75, 0.75)]:
            px, py = round(float(x + dx), 3), round(float(y + dy), 3)
            if inside(px, py) and free(px, py):
                cu.via("GND", px, py)
                holes.append((px, py, VIA_DRILL / 2, "via"))
                placed += 1
                break
    return placed


# ---------------------------------------------------------------------------------------------


def hand(board):
    cu = Copper(board)
    rear_keys(cu)
    front_keys(cu)
    display(cu)
    usb(cu)
    power(cu)
    v5_trunk(cu)
    eth_hand(cu)
    audio(cu)
    codec(cu)
    r = Router(board, CORNER)
    # the LDO tab island (a zone, filled later) joins its 3V3 copper and keeps other nets out
    x0, y0, x1, y1 = ISLAND_3V3[0] + ISLAND_3V3[2]
    r.items.append(dict(layers=(B,), g=("rect", x0, y0, x1, y1), net="3V3",
                        clr=CLASS["Power"][1], drill=0.0))
    r.protect_under(USBN, F, 0.6)
    r.protect_under({"HS_EAR", "EAR_AC", "DAC_OUTP", "MIC_BIAS", "HS_MIC"}, F, 0.5)
    return cu, r


def leftovers(placed, attempts=8):
    """Route LEFTOVER in order; a net that fails moves to the front and everything is routed
    again from the placed board (deterministic: the same failures give the same next order)."""
    order = list(LEFTOVER)
    for k in range(attempts):
        board = pcbnew.LoadBoard(str(placed))
        cu, r = hand(board)
        failed = []
        for net in order:
            done, fail = r.route_net(cu, net, cost_via=VIA_NET.get(net))
            if fail:
                failed.append(net)
        print(f"  attempt {k + 1}: {len(failed)} nets failed {failed}")
        if not failed:
            return board, cu, r
        order = failed + [n for n in order if n not in failed]
    for line in r.log:
        print("  " + line)
    return board, cu, r


def eth_gnd(r, cu):
    """hw v0.2: each of the W5500's ground pins joined to the GND vias under it (router A*;
    the fills can't reach between 0.5 mm-pitch pins)."""
    b = cu.b
    fp = b.FindFootprintByReference("U4")
    vias = [it for it in r.items if it["net"] == "GND" and it["drill"] > 0
            and any(math.dist(r._centre(it["g"]), v) < 0.01 for v in U4_GND_VIAS)]
    tgt = {}
    for it in vias:
        for L, s_ in r.cells(it).items():
            tgt.setdefault(L, set()).update(s_)
    for p in fp.Pads():
        if p.GetNetname() != "GND":
            continue
        it = next(i for i in r.items if "pad" in i and i["net"] == "GND"
                  and i["pad"].GetParentFootprint().GetReference() == "U4"
                  and i["pad"].GetNumber() == p.GetNumber())
        ok, ok_full, via_ok = r.masks("GND", 0.2)
        path = r.astar(r.cells(it), tgt, [ok[0], ok[1]], np.zeros_like(via_ok), 1e9)
        if not path:
            r.log.append(f"FAIL GND: U4.{p.GetNumber()} to its vias")
            continue
        r.commit(cu, "GND", path, 0.2, ok_full)


ETH_W = {"ETH_3V3": 0.3, "ETH_3V3A": 0.3, "V5": 0.4, "POE_5V": 0.5}


def eth_router(board, cu, order=None):
    """hw v0.2: route ETH_NETS in their window (deterministic order, failures logged)."""
    r = Router(board, ETH_WINDOW)
    r.extend_ends = True
    for x0, y0, x1, y1 in PS1_KEEPOUT:
        r.items.append(dict(layers=(F,), g=("rect", x0, y0, x1, y1), net="", clr=0.0, drill=0.0))
    r.protect_under(ETHN, F, 0.5)
    failed = []
    for net in order or ETH_NETS:
        done, fail = r.route_net(cu, net, w=ETH_W.get(net), cost_via=VIA_COST[cls(net)])
        if fail:
            failed.append(net)
    print(f"  eth: {len(failed)} nets failed {failed}", flush=True)
    return r, failed


def route(pcb) -> int:
    placed = pcb.parent / "route" / "placed.kicad_pcb"
    if not placed.exists():
        raise SystemExit(f"{placed} missing: run place.py (make place) first")
    order = list(ETH_NETS)
    for k in range(4):                     # failed nets first, from the placed board again
        board, cu, r = leftovers(placed)
        re_, failed = eth_router(board, cu, order)
        if not failed:
            break
        order = failed + [n for n in order if n not in failed]
    # GND vias: every SMD ground pad in the band (not the key sockets: the bottom fill joins
    # them), plus the codec's exposed pad
    for fp in board.GetFootprints():
        ref = fp.GetReference()
        if not fp.IsFlipped() or ref.startswith(("SW3", "SW4", "SW5", "SW6", "SW7", "SW8", "SW9",
                                                 "SW10", "SW11", "SW12", "SW13", "SW14", "SW15",
                                                 "U1", "J1", "D1", "R1", "R2", "U4")):
            continue
        for p in fp.Pads():
            if p.GetNetname() == "GND" and p.GetAttribute() == pcbnew.PAD_ATTRIB_SMD \
                    and not (ref == "U3" and p.GetNumber() == "21"):
                x, y = unP(p.GetPosition())
                rr = re_ if ETH_WINDOW[0] <= x <= ETH_WINDOW[2] and ETH_WINDOW[1] <= y <= ETH_WINDOW[3] \
                    else r
                rr.ground_via(cu, p)
    r.log += re_.log
    for line in r.log:
        print("  " + line)

    zones(board)
    fill(board)
    n = stitch(cu, board)
    print(f"  stitching vias: {n}")
    fill(board)
    save_board(board, pcb)
    return 1 if any(l.startswith("FAIL") for l in r.log) else 0


if __name__ == "__main__":
    sys.exit(route(KICAD_OUT / BOARD / f"{BOARD}.kicad_pcb"))
