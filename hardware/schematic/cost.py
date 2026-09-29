"""Cost roll-up: at scale (1k / 10k phones) and one-off (a maker's first order).

    python cost.py            # after build.py; writes ../build/main/cost.txt

Inputs: ../build/main/bom.csv (fitted rows), lcsc_cache.json price ladders
(JLCPCB assembly price first, LCSC second), cost_model.yaml (dated estimates for PCBs,
assembly fees and off-board parts). Every number that is not a cached distributor price is
marked EST. Returns WARN lines (never errors) when the 1k total exceeds warn_at_scale_usd.
"""

from __future__ import annotations

import csv
import math
import sys
from pathlib import Path

import yaml

HERE = Path(__file__).resolve().parent
BUILD = HERE.parent / "build"
sys.path.insert(0, str(HERE))

from lcsc import load_cache  # noqa: E402

BOARDS = ("main",)


def ladder_price(ladder: list, qty: int) -> float | None:
    """Unit price at `qty` from [[min_qty, price], ...]."""
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


def fitted_rows(variant: str, board: str) -> list[dict]:
    rows = []
    with (BUILD / board / "bom.csv").open() as f:
        for r in csv.DictReader(f):
            if r["Fitted"] == "yes":
                r["Qty"] = int(r["Qty"])
                rows.append(r)
    return rows


def variant_flags(variant: str) -> dict:
    from config import VARIANTS

    return {"sku": VARIANTS[variant].name}   # one board: no per-variant cost items


def applies(item: dict, flags: dict) -> bool:
    return all(flags.get(k) == want for k, want in (item.get("when") or {}).items())


def parts_cost(rows, cache, model, qty_phones: int, retail: bool = False):
    """(total $, [(line $, desc)], missing) for one board at `qty_phones` phones."""
    total, lines, missing = 0.0, [], []
    for r in rows:
        e = cache.get(r["LCSC"]) or {}
        p, src = unit_price(e, r["Qty"] * qty_phones)
        tag = src
        if p is None:
            est = (model["unpriced"].get(r["MPN"]) or model["unpriced"].get(r["Value"]))
            if est is None:
                missing.append(r["MPN"] or r["Value"])
                continue
            p, tag = est["retail" if retail else "scale"], "EST"
            line = p  # per phone
        else:
            line = p * r["Qty"]
            if retail:
                line = max(line, model["one_off"]["hand_assembly_min_line_usd"])
        total += line
        lines.append((line, f"{r['Refs'][:28]:28} {(r['MPN'] or r['Value'])[:26]:26} {tag}"))
    return total, lines, missing


def extended_parts(rows, cache) -> list[str]:
    return sorted({r["MPN"] or r["LCSC"] for r in rows
                   if (cache.get(r["LCSC"]) or {}).get("jlc_library") == "expand"})


def roll_up(variant: str, cache: dict, model: dict) -> tuple[str, list[str], dict]:
    flags = variant_flags(variant)
    rows = {b: fitted_rows(variant, b) for b in BOARDS}
    out, warns, summary = [], [], {}
    out.append(f"Cost roll-up: {variant}  (prices: lcsc_cache.json; EST = estimate from "
               f"cost_model.yaml dated {model['date']})")
    off = {k: v for k, v in model["off_board"].items() if applies(v, flags)}

    # ---- at scale ----
    for n in model["scales"]:
        pcb = model["pcb_at_scale"][n]
        parts = {}
        drivers = []
        for b in BOARDS:
            t, lines, missing = parts_cost(rows[b], cache, model, n)
            parts[b] = t
            drivers += [(c, f"{b}: {d}") for c, d in lines]
            for m in missing:
                warns.append(f"{variant}: no price for {m} ({b}); excluded")
        offb = sum(v["scale"] for v in off.values())
        drivers += [(v["scale"], f"off-board: {k} EST") for k, v in off.items()]
        pcbs = sum(pcb.values())
        asm = model["assembly_at_scale"][n]
        total = sum(parts.values()) + pcbs + asm + offb
        summary[n] = total
        out.append("")
        out.append(f"== At scale, {n} phones (USD per phone) ==")
        out.append(f"  board parts           {parts['main']:7.2f}")
        out.append(f"  PCB                   {pcbs:7.2f}  EST")
        out.append(f"  assembly              {asm:7.2f}  EST")
        out.append(f"  off-board electronics {offb:7.2f}  EST ({', '.join(off)})")
        out.append(f"  TOTAL                 {total:7.2f}")
        if n == model["scales"][0]:
            out.append("  top 5 cost drivers:")
            for c, d in sorted(drivers, reverse=True)[:5]:
                out.append(f"    {c:6.2f}  {d}")
            if total > model["warn_at_scale_usd"]:
                warns.append(f"{variant}: ${total:.2f} at {n} exceeds "
                             f"${model['warn_at_scale_usd']}")

    # ---- one-off (JLC PCBA reference) ----
    oo = model["one_off"]
    jlc = oo["jlc"]
    k = oo["phones"]
    ext = {b: extended_parts(rows[b], cache) for b in BOARDS}
    pcb = sum(jlc["pcb"].values()) + jlc["shipping"]
    fees = sum(jlc["pcba_setup"].values()) + sum(jlc["stencil"].values())
    extfee = jlc["extended_fee"] * sum(len(v) for v in ext.values())
    joints = jlc["per_joint"] * sum(jlc["joints"].values()) * k
    parts2 = sum(parts_cost(rows[b], cache, model, k)[0] for b in BOARDS) * k
    offr = sum(v["retail"] for v in off.values())
    per_phone = (pcb + fees + extfee + joints + parts2) / k + offr
    summary["one_off_jlc"] = per_phone
    out.append("")
    out.append(f"== One-off, JLCPCB PCBA reference quote ({oo['boards_ordered']} boards each, "
               f"{k} assembled) ==")
    out.append(f"  bare PCBs + shipping  {pcb:7.2f}  EST")
    out.append(f"  PCBA setup + stencils {fees:7.2f}  EST")
    out.append(f"  extended-part fees    {extfee:7.2f}  EST ({len(ext['main'])} unique extended "
               f"parts x ${jlc['extended_fee']})")
    out.append(f"  joints                {joints:7.2f}  EST")
    out.append(f"  parts for {k} phones    {parts2:7.2f}")
    out.append(f"  off-board (retail)    {offr:7.2f}  EST per phone")
    out.append(f"  PER PHONE             {per_phone:7.2f}")

    # ---- one-off, bare boards from OSH Park + hand assembly ----
    osh = oo["osh_park"]
    area = {b: (w / 25.4) * (h / 25.4) for b, (w, h) in osh["boards_mm"].items()}
    bare = area["main"] * osh["per_sq_in_4layer"]
    hand = sum(parts_cost(rows[b], cache, model, 1, retail=True)[0] for b in BOARDS)
    diy = bare + hand + offr
    summary["one_off_osh_diy"] = diy
    out.append("")
    out.append(f"== One-off, bare boards (OSH Park formula, {osh['copies']} copies) + "
               "self-sourced parts + hand assembly, 1 phone ==")
    out.append(f"  OSH Park boards       {bare:7.2f}  (${osh['per_sq_in_4layer']}/in^2 4L board "
               f"{area['main']:.1f} in^2)")
    out.append(f"  parts, qty 1          {hand:7.2f}  (each BOM line >= "
               f"${oo['hand_assembly_min_line_usd']:.2f} for cut-tape minimums)")
    out.append(f"  off-board (retail)    {offr:7.2f}  EST")
    out.append(f"  TOTAL (1 phone)       {diy:7.2f}")

    out.append("")
    out.append("== JLCPCB extended-library parts (each ~$3 setup on small orders) ==")
    for b in BOARDS:
        out.append(f"  {b} ({len(ext[b])}): {', '.join(ext[b])}")
    summary["extended"] = {b: len(ext[b]) for b in BOARDS}
    return "\n".join(out) + "\n", warns, summary


def main() -> int:
    from config import VARIANTS

    cache = load_cache()
    model = yaml.safe_load((HERE / "cost_model.yaml").read_text())
    lines = []
    for variant in VARIANTS:
        text, warns, s = roll_up(variant, cache, model)
        d = BUILD / variant
        d.mkdir(parents=True, exist_ok=True)
        (d / "cost.txt").write_text(text + "".join(f"WARN {w}\n" for w in warns))
        n0, n1 = model["scales"][:2]
        lines.append(f"cost ({variant}): ${s[n0]:.2f} @{n0 // 1000}k, ${s[n1]:.2f} @{n1 // 1000}k;"
                     f" one-off ${s['one_off_jlc']:.2f}/phone (JLC PCBA, 2 built), "
                     f"${s['one_off_osh_diy']:.2f} (OSH Park bare + hand); extended parts "
                     f"{s['extended']['main']}"
                     + "".join(f"; WARN {w}" for w in warns))
    return "\n".join(lines) + "\n"


if __name__ == "__main__":
    print(main(), end="")
