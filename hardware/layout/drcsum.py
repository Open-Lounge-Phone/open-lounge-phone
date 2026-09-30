"""Summarise a kicad-cli DRC JSON report: python3 drcsum.py report.json [type-filter] [--strict]
(--strict: exit 1 on any error-severity violation or unconnected item)"""
import json, sys, collections
args = [a for a in sys.argv[1:] if a != "--strict"]
d = json.load(open(args[0]))
flt = args[1] if len(args) > 1 else None
c = collections.Counter(v["type"] for v in d["violations"])
print("violations:", dict(c), "unconnected:", len(d.get("unconnected_items", [])),
      "parity:", len(d.get("schematic_parity", [])))
for v in d["violations"]:
    if flt and v["type"] != flt:
        continue
    items = "; ".join(i["description"][:70] for i in v["items"])
    print(f'{v["type"]:24} {items}')
if "--strict" in sys.argv:
    errors = [v for v in d["violations"] if v.get("severity") == "error"]
    sys.exit(1 if errors or d.get("unconnected_items") else 0)
