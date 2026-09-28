"""Verify LCSC part codes against LCSC's product-detail endpoint and JLCPCB's parts search.

For each code we record the MPN/package/stock LCSC reports, plus JLCPCB assembly stock and
library type (basic/extended), because boards are assembled at JLCPCB.

Results are cached in ``lcsc_cache.json`` (committed) so that builds and checks work offline.
``python lcsc.py C25744 C1525`` looks codes up (network) and refreshes the cache;
``python lcsc.py --all`` re-checks every code used by the design. Each entry also records the
LCSC USD price ladder, which ``cost.py`` uses for the per-variant cost roll-up.
"""

from __future__ import annotations

import json
import sys
import time
import urllib.request
from pathlib import Path

CACHE = Path(__file__).with_name("lcsc_cache.json")
URL = "https://wmsc.lcsc.com/ftps/wm/product/detail?productCode={}"
JLC = "https://jlcpcb.com/api/overseas-pcb-order/v1/shoppingCart/smtGood/selectSmtComponentList"


def load_cache() -> dict:
    if CACHE.exists():
        return json.loads(CACHE.read_text())
    return {}


def save_cache(cache: dict) -> None:
    CACHE.write_text(json.dumps(dict(sorted(cache.items())), indent=1, ensure_ascii=False) + "\n")


def fetch_jlc(code: str) -> dict | None:
    body = json.dumps({"keyword": code, "currentPage": 1, "pageSize": 5}).encode()
    req = urllib.request.Request(JLC, data=body, headers={
        "User-Agent": "Mozilla/5.0", "content-type": "application/json"})
    with urllib.request.urlopen(req, timeout=20) as resp:
        data = json.load(resp)
    for x in (data.get("data") or {}).get("componentPageInfo", {}).get("list") or []:
        if x.get("componentCode") == code:
            return x
    return None


def fetch(code: str) -> dict:
    req = urllib.request.Request(URL.format(code), headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=20) as resp:
        data = json.load(resp)
    res = data.get("result")
    jlc = fetch_jlc(code)
    jl = {"jlc_stock": jlc.get("stockCount"), "jlc_library": jlc.get("componentLibraryType"),
          # JLCPCB assembly price ladder [[min qty, unit USD], ...] (what a JLC PCBA order pays)
          "jlc_prices": sorted([x["startNumber"], x["productPrice"]]
                               for x in jlc.get("componentPrices") or []
                               if x.get("productPrice") is not None)} \
        if jlc else {"jlc_stock": None, "jlc_library": None, "jlc_prices": []}
    if not res:
        if jlc:  # listed for JLCPCB assembly but not in the LCSC catalogue
            return {"code": code, "found": True, "source": "jlcpcb", "mpn": jlc["componentModelEn"],
                    "brand": None, "package": jlc.get("componentSpecificationEn"),
                    "desc": (jlc.get("describe") or "")[:120], "stock": None,
                    "checked": time.strftime("%Y-%m-%d"), **jl}
        return {"code": code, "found": False}
    return {**jl, "source": "lcsc",
        "code": code,
        "found": True,
        "mpn": res.get("productModel"),
        "brand": res.get("brandNameEn"),
        "package": res.get("encapStandard"),
        "desc": res.get("productNameEn") or res.get("productIntroEn"),
        "stock": res.get("stockNumber"),
        # USD price ladder [[min qty, unit price], ...] for the cost roll-up (cost.py)
        "prices": [[x.get("ladder"), x.get("usdPrice")] for x in res.get("productPriceList") or []
                   if x.get("ladder") and x.get("usdPrice") is not None],
        "checked": time.strftime("%Y-%m-%d"),
    }


def lookup(codes: list[str], refresh: bool = True) -> dict:
    cache = load_cache()
    for code in codes:
        if not refresh and code in cache:
            continue
        try:
            cache[code] = fetch(code)
        except Exception as exc:  # network failure: keep the old entry, report
            print(f"{code}: lookup failed ({exc})", file=sys.stderr)
        time.sleep(0.3)
    save_cache(cache)
    return cache


if __name__ == "__main__":
    args = sys.argv[1:]
    if args == ["--all"]:
        sys.path.insert(0, str(Path(__file__).parent))
        from parts import all_lcsc_codes  # noqa: E402

        args = sorted(all_lcsc_codes())
    cache = lookup(args)
    for c in args:
        e = cache.get(c, {})
        if e.get("found"):
            print(f"{c:10} {e['mpn']:30.30} {e['package'] or '':12.12} lcsc={e['stock']!s:<8} "
                  f"jlc={e.get('jlc_stock')!s:<8} {e.get('jlc_library') or '-':8} {e['desc'][:40]}")
        else:
            print(f"{c:10} NOT FOUND")
