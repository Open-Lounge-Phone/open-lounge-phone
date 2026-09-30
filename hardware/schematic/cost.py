"""Cost per board at 1 / 100 / 1000 (JLCPCB reference), plus the off-board parts per phone.

    python cost.py            # after build.py; writes ../build/main/cost.txt, returns a summary

Inputs: ../build/main/bom.csv and main.net (joint counts), lcsc_cache.json price ladders (JLCPCB
assembly price first, LCSC second), cost_model.yaml (dated estimates for the PCB, assembly
fees and off-board parts). Every number that is not a cached distributor price is marked EST.
"""

from __future__ import annotations

import csv
import re
import sys
from pathlib import Path

import yaml

HERE = Path(__file__).resolve().parent
OUT = HERE.parent / "build" / "main"
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parent / "layout"))

from lcsc import load_cache  # noqa: E402


def ladder_price(ladder: list, qty: int) -> float | None:
    best = None
    for mq, price in sorted(ladder or []):
        if qty >= mq or best is None:
            best = price
    return best


def unit_price(entry: dict, qty: int) -> tuple[float | None, str]:
    for key, src in (("jlc_prices", "JLC"), ("prices", "LCSC")):
        p = ladder_price(entry.get(key) or [], qty)
        if p is not None:
            return p, src
    return None, ""


def bom_rows() -> list[dict]:
    with (OUT / "bom.csv").open() as f:
        rows = list(csv.DictReader(f))
    for r in rows:
        r["Qty"] = int(r["Qty"])
    return rows


def joints(tht_prefixes) -> tuple[int, int]:
    """(SMD joints, THT joints) per board from the netlist node count of BOM parts."""
    import netlist as nl

    net = nl.read(OUT / "main.net")
    pins = {}
    for nodes in net.nets.values():
        for ref, _ in nodes:
            pins[ref] = pins.get(ref, 0) + 1
    smd = tht = 0
    for ref, c in net.comps.items():
        if c.fields.get("BOM") == "exclude":
            continue
        if any(ref == p or re.fullmatch(rf"{p}\d+", ref) for p in tht_prefixes):
            tht += pins.get(ref, 0)
        else:
            smd += pins.get(ref, 0)
    return smd, tht


def main() -> str:
    cache = load_cache()
    m = yaml.safe_load((HERE / "cost_model.yaml").read_text())
    rows = bom_rows()
    asm = m["assembly"]
    n_smd, n_tht = joints(asm["tht_refs_prefix"])
    ext = sorted({r["MPN"] or r["LCSC"] for r in rows
                  if (cache.get(r["LCSC"]) or {}).get("jlc_library") == "expand"})
    n_parts = sum(r["Qty"] for r in rows)
    out = [f"Cost per board (USD), JLCPCB reference; prices from lcsc_cache.json, EST = "
           f"cost_model.yaml dated {m['date']}",
           f"{n_parts} parts on {len(rows)} BOM lines; {n_smd} SMD + {n_tht} THT joints; "
           f"{len(ext)} JLC extended parts: {', '.join(ext)}", ""]
    per_board, order_total = {}, {}
    for q in m["quantities"]:
        built = max(q, asm["min_boards"])
        parts, missing, lines = 0.0, [], []
        for r in rows:
            p, src = unit_price(cache.get(r["LCSC"]) or {}, r["Qty"] * built)
            if p is None:
                missing.append(r["MPN"] or r["Value"])
                continue
            parts += p * r["Qty"]
            lines.append((p * r["Qty"], f"{r['Refs'][:24]:24} {(r['MPN'] or r['Value'])[:24]}"))
        fixed = (m["pcb"]["order_usd"][q] + m["shipping_usd"][q] + asm["setup_usd"]
                 + asm["stencil_usd"] + asm["extended_fee_usd"] * len(ext)
                 + asm["tht_setup_usd"])
        var = parts + n_smd * asm["per_joint_usd"] + n_tht * asm["tht_per_joint_usd"]
        total = fixed + var * built
        order_total[q] = total
        per_board[q] = total / built
        out.append(f"== {q} board{'s' if q > 1 else ''} (order builds {built}) ==")
        out.append(f"  parts per board         {parts:8.2f}")
        out.append(f"  joints per board        {n_smd * asm['per_joint_usd'] + n_tht * asm['tht_per_joint_usd']:8.2f}  EST")
        out.append(f"  fixed per order         {fixed:8.2f}  EST (PCB {m['pcb']['order_usd'][q]:.2f}, "
                   f"shipping {m['shipping_usd'][q]:.2f}, setup+stencil "
                   f"{asm['setup_usd'] + asm['stencil_usd']:.2f}, extended fees "
                   f"{asm['extended_fee_usd'] * len(ext):.2f}, THT {asm['tht_setup_usd']:.2f})")
        out.append(f"  ORDER TOTAL             {total:8.2f}")
        out.append(f"  PER BOARD               {per_board[q]:8.2f}")
        if missing:
            out.append(f"  WARN no price for: {', '.join(missing)}")
        if q == 1000:
            out.append("  top 5 part costs:")
            for c, d in sorted(lines, reverse=True)[:5]:
                out.append(f"    {c:6.2f}  {d}")
        out.append("")
    off = m["off_board"]
    scale = sum(v["scale"] for v in off.values())
    retail = sum(v["retail"] for v in off.values())
    out.append(f"Off-board per phone (EST): {scale:.2f} at scale, {retail:.2f} retail "
               f"({', '.join(off)})")
    out.append(f"Phone electronics at 1000: {per_board[1000] + scale:.2f}; one-off (1 board "
               f"+ retail off-board): {order_total[1] + retail:.2f}")
    (OUT / "cost.txt").write_text("\n".join(out) + "\n")
    return (f"cost per board: 1 = ${order_total[1]:.2f} (minimum order, builds "
            f"{max(1, asm['min_boards'])}: ${per_board[1]:.2f} each), 100 = "
            f"${per_board[100]:.2f}, 1000 = ${per_board[1000]:.2f}; {n_parts} parts, "
            f"{len(rows)} BOM lines, {len(ext)} extended; off-board ${scale:.2f} at scale "
            "(build/main/cost.txt)\n")


def order(boards: int) -> str:
    """One JLCPCB order of `boards` assembled boards (<= 5: the 5-piece PCB minimum, the small
    order's shipping); the same price ladders and EST fees as main()."""
    cache = load_cache()
    m = yaml.safe_load((HERE / "cost_model.yaml").read_text())
    rows, asm = bom_rows(), m["assembly"]
    if boards > m["pcb"]["min_order"]:
        raise SystemExit(f"order() models up to {m['pcb']['min_order']} boards")
    n_smd, n_tht = joints(asm["tht_refs_prefix"])
    ext = sorted({r["MPN"] or r["LCSC"] for r in rows
                  if (cache.get(r["LCSC"]) or {}).get("jlc_library") == "expand"})
    built = max(boards, asm["min_boards"])
    parts = sum((unit_price(cache.get(r["LCSC"]) or {}, r["Qty"] * built)[0] or 0.0) * r["Qty"]
                for r in rows)
    fees = {"PCB (5 pcs, 2 layers)": m["pcb"]["order_usd"][1], "shipping": m["shipping_usd"][1],
            "PCBA setup + stencil": asm["setup_usd"] + asm["stencil_usd"],
            f"extended-part fees ({len(ext)} x {asm['extended_fee_usd']:.2f})": asm["extended_fee_usd"] * len(ext),
            "THT soldering setup (J3, BZ1)": asm["tht_setup_usd"]}
    joints_usd = n_smd * asm["per_joint_usd"] + n_tht * asm["tht_per_joint_usd"]
    total = sum(fees.values()) + (parts + joints_usd) * built
    out = [f"JLCPCB reference quote: {built} assembled boards in one order (EST, cost_model.yaml "
           f"{m['date']}; parts from lcsc_cache.json)"]
    out += [f"  {k:34} {v:8.2f}" for k, v in fees.items()]
    out.append(f"  {'parts per board':34} {parts:8.2f}  x {built}")
    out.append(f"  {'joints per board':34} {joints_usd:8.2f}  x {built}")
    out.append(f"  {'ORDER TOTAL':34} {total:8.2f}")
    out.append(f"  {'PER BOARD':34} {total / built:8.2f}")
    out.append("Not included: MX switches, keycaps, display module, antenna, handset (off-board).")
    return "\n".join(out) + "\n"


if __name__ == "__main__":
    import argparse

    ap = argparse.ArgumentParser()
    ap.add_argument("--boards", type=int, help="quote one order of N assembled boards (N <= 5)")
    a = ap.parse_args()
    print(order(a.boards) if a.boards else main(), end="")
