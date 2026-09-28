"""Summarise a kicad-cli DRC JSON report: python3 drcsum.py report.json [type-filter]"""
import json, sys, collections
d = json.load(open(sys.argv[1]))
flt = sys.argv[2] if len(sys.argv) > 2 else None
c = collections.Counter(v["type"] for v in d["violations"])
print("violations:", dict(c), "unconnected:", len(d.get("unconnected_items", [])),
      "parity:", len(d.get("schematic_parity", [])))
for v in d["violations"]:
    if flt and v["type"] != flt:
        continue
    items = "; ".join(i["description"][:70] for i in v["items"])
    print(f'{v["type"]:24} {items}')
