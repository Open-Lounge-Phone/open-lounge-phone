"""Design-rule checks that SKiDL's ERC does not do. Each returns a list of (level, message).

level is "ERROR" (fails the build) or "WARN" (reported in checks.txt).
"""

from __future__ import annotations

import re
from pathlib import Path

import yaml

from lib import SPECS, norm_mpn
from lcsc import load_cache

HERE = Path(__file__).parent
PIN_TABLE = yaml.safe_load((HERE / "pin_table.yaml").read_text())

GND_NAMES = {"GND"}
RTC_GPIOS = set(range(0, 22))
ADC1_GPIOS = set(range(1, 11))


def _net_of(pin):
    """The pin's net, or None if unconnected / explicitly no-connect (SKiDL NC)."""
    net = getattr(pin, "net", None)
    if net is None or net.name == "__NOCONNECT":
        return None
    return net


def _name(net):
    return net.name if net is not None else None


def pins_on(net):
    return [p for p in net.pins]


def _resistors_to(net, target_names):
    """Resistors with one end on `net` and the other on a net named in target_names."""
    found = []
    for p in pins_on(net):
        part = p.part
        if part.ref_prefix != "R" or part.fields.get("DNP"):
            continue
        other = [q for q in part.pins if q is not p][0]
        if _name(_net_of(other)) in target_names:
            found.append(part)
    return found


def check_pin_table(circuit):
    out = []
    mods = [p for p in circuit.parts if p.fields.get("SpecKey") == "ESP32-S3-WROOM-1"]
    if len(mods) != 1:
        return [("ERROR", f"expected one ESP32-S3-WROOM-1, found {len(mods)}")]
    mod = mods[0]
    by_gpio = {}
    for pin in mod.pins:
        m = re.fullmatch(r"IO(\d+)", pin.name)
        if m:
            by_gpio[int(m.group(1))] = pin
        elif pin.name == "TXD0":
            by_gpio[43] = pin
        elif pin.name == "RXD0":
            by_gpio[44] = pin
    for gpio, row in PIN_TABLE["gpio"].items():
        pin = by_gpio.get(gpio)
        if pin is None:
            out.append(("ERROR", f"GPIO{gpio} not found on module symbol"))
            continue
        net = _net_of(pin)
        want = row.get("net")
        got = _name(net)
        if want is None:
            if net is not None and len(net.pins) > 1:
                out.append(("ERROR", f"GPIO{gpio} must be unconnected ({row.get('note')}), is on {got}"))
            continue
        if got != want:
            out.append(("ERROR", f"GPIO{gpio}: pin table says {want}, schematic has {got}"))
            continue
        if row.get("adc1") and gpio not in ADC1_GPIOS:
            out.append(("ERROR", f"GPIO{gpio} ({want}) is analog but not on ADC1"))
        if row.get("rtc") and gpio not in RTC_GPIOS:
            out.append(("ERROR", f"GPIO{gpio} ({want}) is a wake source but not an RTC GPIO"))
        for key in ("strap", "strap_like", "pull"):
            kind = row.get(key)
            if not kind:
                continue
            kind = {"up": "pullup", "down": "pulldown"}.get(kind, kind)
            ups = _resistors_to(net, {"3V3"})
            downs = _resistors_to(net, GND_NAMES)
            if kind == "pullup" and (not ups or downs):
                out.append(("ERROR", f"GPIO{gpio} ({want}) needs a pull-up only; up={len(ups)} down={len(downs)}"))
            if kind == "pulldown" and (not downs or ups):
                out.append(("ERROR", f"GPIO{gpio} ({want}) needs a pull-down only; up={len(ups)} down={len(downs)}"))
    # every IO pad not in the table must be unconnected (catches accidental extra use)
    for gpio, pin in by_gpio.items():
        if gpio not in PIN_TABLE["gpio"] and _net_of(pin) is not None:
            out.append(("ERROR", f"GPIO{gpio} is connected ({_name(_net_of(pin))}) but not in pin_table.yaml"))
    return out


def check_i2c(circuit):
    """Per-board: derived addresses must match DESIGN.md's I2C map for known parts."""
    out = []
    expected = {k.split("-")[0]: v for k, v in PIN_TABLE["i2c_expected"].items()}
    for a, ref, key, _ in i2c_devices(circuit):
        want = expected.get(key.split("-")[0].split("FA")[0])
        if want is None:
            continue
        wants = want if isinstance(want, list) else [want]
        if a not in wants:
            out.append(("ERROR", f"{ref} ({key}) strapped to 0x{a:02X}, DESIGN.md says "
                                 + "/".join(f"0x{w:02X}" for w in wants)))
    return out


def strap_level(pin):
    """0/1 for a pin tied to GND/3V3 directly or through one fitted resistor, else None."""
    net = _net_of(pin)
    if net is None:
        return None
    if net.name in GND_NAMES:
        return 0
    if net.name == "3V3":
        return 1
    ups, downs = _resistors_to(net, {"3V3"}), _resistors_to(net, GND_NAMES)
    if bool(ups) != bool(downs):
        return 1 if ups else 0
    return None


def i2c_devices(circuit) -> list:
    """[(address, ref, spec, fitted)] for every I2C part; strap pins are read from the wiring."""
    out = []
    for part in circuit.parts:
        s = SPECS.get(part.fields.get("SpecKey"))
        if not (s and s.i2c):
            continue
        offset = 0
        for pin_name, bit in s.i2c_straps:
            level = strap_level(part[pin_name])
            if level is None:
                raise ValueError(f"{part.ref}.{pin_name}: I2C address strap not tied high/low")
            offset |= level << bit
        for addrs in s.i2c.values():
            for a in addrs if isinstance(addrs, (list, tuple)) else [addrs]:
                out.append([a + offset, part.ref, s.key, not part.fields.get("DNP")])
    return out


def check_i2c_union(per_board: dict) -> list:
    """Addresses on the one I2C bus must be unique, counting DNP footprints too (they may be
    populated later) and the optional external Qwiic modules."""
    out, seen = [], {}
    for name, a in (PIN_TABLE.get("i2c_optional_external") or {}).items():
        seen[a] = f"qwiic:{name}(optional external)"
    for board, devs in per_board.items():
        for a, ref, key, fitted in devs:
            tag = f"{board}:{ref}({key}{'' if fitted else ',DNP'})"
            if a in seen:
                out.append(("ERROR", f"address 0x{a:02X} used by {seen[a]} and {tag}"))
            seen[a] = tag
    expected = {}
    for name, addr in PIN_TABLE["i2c_expected"].items():
        for a in addr if isinstance(addr, list) else [addr]:
            expected[a] = name
    for a, name in expected.items():
        if a not in seen and a != 0x2D:
            out.append(("WARN", f"DESIGN.md lists {name} at 0x{a:02X}; not on the board"))
    out.append(("INFO", "OK, " + ", ".join(f"0x{a:02X} {t}" for a, t in sorted(seen.items()))))
    return out


# Inputs deliberately left open (explicit NC in the schematic): unused codec mic inputs are
# biased internally (owner 2026-09-28; [UNVERIFIED] "leave floating" against the datasheets).
OPEN_INPUTS = {"ES8311": {"MIC1P", "MIC1N"}, "ES7210": {"MIC1P", "MIC1N", "MIC4P", "MIC4N"}}


def check_nets(circuit):
    out = []
    for net in circuit.nets:
        if net.name == "__NOCONNECT" or not net.pins:
            continue
        real = [p for p in net.pins if p.part.ref_prefix not in ("TP",)]
        if len(net.pins) == 1 and not net.name.startswith("FFC_SPARE"):
            p = net.pins[0]
            out.append(("ERROR", f"net {net.name} has a single pin ({p.part.ref}.{p.name})"))
        elif len(real) == 1 and len(net.pins) > 1:
            out.append(("WARN", f"net {net.name} only reaches {real[0].part.ref}.{real[0].name} and test points"))
    # input / power-in pins left floating
    for part in circuit.parts:
        for pin in part.pins:
            if pin.name in OPEN_INPUTS.get(part.fields.get("SpecKey"), ()):
                continue
            if _net_of(pin) is None and pin.func in (pin.types.INPUT, pin.types.PWRIN):
                out.append(("ERROR", f"{part.ref}.{pin.name} ({pin.num}) is an unconnected input"))
    return out


def _passive_matches(value: str, desc: str) -> bool:
    """'10k' vs 'RES 10kΩ ±1% ...', '100nF 16V X7R' vs 'CAP CER 100nF 16V X7R 0402'."""
    d = desc.replace(" ", "").replace("Ω", "").replace("µ", "u").lower()
    v = value.split()[0].lower()
    if v.endswith("f"):  # capacitor, e.g. 100nf / 1uf / 4.7uf
        return v in d
    v = {"0": "0"}.get(v, v)
    return re.search(rf"(^|[^0-9.]){re.escape(v)}([^0-9.a-z]|$)", d) is not None


def check_sourcing(circuit):
    out = []
    cache = load_cache()
    groups = {}
    for part in circuit.parts:
        if part.fields.get("BOM") == "exclude":
            continue
        key = (part.fields.get("LCSC"), part.fields.get("MPN"), part.value,
               part.fields.get("Verified"), bool(part.fields.get("DNP")),
               part.fields.get("SpecKey", "").startswith("_"))
        groups.setdefault(key, []).append(part.ref)
    for (code, mpn, value, ver, dnp, passive), refs in groups.items():
        who = f"{', '.join(refs[:6])}{' ...' if len(refs) > 6 else ''} {mpn or value}"
        if ver != "yes":
            out.append(("WARN", f"{who}: [UNVERIFIED] {ver}"))
        if not code:
            out.append(("WARN", f"{who}: no LCSC code"))
            continue
        c = cache.get(code)
        if not c:
            out.append(("ERROR", f"{who}: LCSC {code} not in lcsc_cache.json (run `make lcsc`)"))
        elif not c.get("found"):
            out.append(("ERROR", f"{who}: LCSC {code} does not exist"))
        elif mpn and norm_mpn(mpn) not in norm_mpn(c["mpn"]) and norm_mpn(c["mpn"]) not in norm_mpn(mpn):
            out.append(("ERROR", f"{who}: LCSC {code} is {c['mpn']}, schematic says {mpn}"))
        elif passive and not _passive_matches(value, c.get("desc") or ""):
            out.append(("ERROR", f"{who}: value {value!r} does not match LCSC {code}: {c['desc']}"))
        elif not c.get("jlc_stock") and not dnp:
            out.append(("WARN", f"{who}: {code} showed zero JLCPCB stock on {c['checked']} "
                                f"(LCSC stock {c.get('stock')})"))
    return out


def check_footprints(circuit):
    import fpcheck

    out = []
    cache = fpcheck.load_cache()
    seen = {}
    for part in circuit.parts:
        seen.setdefault(part.footprint, []).append(part.ref)
    for fp, refs in sorted(seen.items()):
        st = fpcheck.status(fp, cache)
        if st == "missing":
            out.append(("ERROR", f"footprint {fp} not in the KiCad library ({', '.join(refs[:4])})"))
        elif st == "unknown-lib":
            out.append(("ERROR", f"footprint library of {fp} not cached (run `make footprints`)"))
        elif st == "local":
            lib = HERE.parent / "layout" / "footprints" / "openloungephone.pretty"
            if not (lib / f"{fp.split(':')[1]}.kicad_mod").exists():
                out.append(("ERROR", f"footprint {fp} is not in layout/footprints/"
                                     f"openloungephone.pretty ({', '.join(refs[:4])})"))
    return out


EPD_SPECS = {"FPC24_EPD", "L47u", "EPD_NFET", "MBR0530"}  # e-ink connector + SSD1680 boost


def check_one_bom(circuit):
    """One board, one BOM (owner 2026-09-28): the e-ink connector and boost are fitted, and the
    only unfitted part is the NFC tuning cap (value set in EVT)."""
    out = []
    epd = [p for p in circuit.parts if p.fields.get("SpecKey") in EPD_SPECS]
    if not epd:
        out.append(("ERROR", "no e-ink parts found on the board"))
    for p in circuit.parts:
        if p.fields.get("DNP") and "tuning cap" not in p.fields.get("Note", ""):
            out.append(("ERROR", f"{p.ref} ({p.fields.get('SpecKey')}) is DNP: one BOM, no variants"))
    return out


def run_all(circuit, board: str = "main", variant=None):
    results = []
    fns = [check_i2c, check_nets, check_sourcing, check_footprints]
    if board == "main":
        fns.insert(0, check_pin_table)
        fns.append(check_power_budget)
    fns.append(check_one_bom)
    for fn in fns:
        try:
            results += [(lvl, f"[{fn.__name__}] {msg}") for lvl, msg in fn(circuit)]
        except Exception as exc:  # a crashing check is a failing check
            results.append(("ERROR", f"[{fn.__name__}] crashed: {exc!r}"))
    return results


def _parse_ohms(value: str) -> float:
    m = re.fullmatch(r"([\d.]+)([kKmM]?)", value.strip())
    if not m:
        raise ValueError(f"can't parse resistance {value!r}")
    mult = {"": 1, "k": 1e3, "K": 1e3, "m": 1e-3, "M": 1e6}[m.group(2)]
    return float(m.group(1)) * mult


def check_power_budget(circuit):
    """Proves every load scenario fits the charger's *guaranteed* input current limit, the
    VSYS rail stays within every part's rating, and the charger stays cool enough."""
    budget = yaml.safe_load((HERE / "power_budget.yaml").read_text())
    ch, supply = budget["charger"], budget["supply"]
    out = []
    chargers = [p for p in circuit.parts if p.fields.get("SpecKey") in ("BQ24074",)]
    if len(chargers) != 1:
        return [("ERROR", f"expected one BQ24074, found {len(chargers)}")]
    ilim_net = _net_of(chargers[0]["ILIM"])
    rs = _resistors_to(ilim_net, GND_NAMES) if ilim_net else []
    if len(rs) != 1:
        return [("ERROR", f"expected one R_ILIM to GND, found {len(rs)}")]
    r_nom = _parse_ohms(str(rs[0].value))
    tol = ch["r_ilim_tolerance"]
    k = ch["k_ilim_aohm"]
    i_min = k["min"] / (r_nom * (1 + tol)) * 1000
    i_typ = k["typ"] / r_nom * 1000
    i_max = k["max"] / (r_nom * (1 - tol)) * 1000
    out.append(("INFO", f"ILIM with R={r_nom:g} Ω: {i_min:.0f} mA guaranteed, {i_typ:.0f} typ, "
                        f"{i_max:.0f} max"))
    if r_nom < 1100:
        out.append(("ERROR", f"R_ILIM {r_nom:g} Ω is below the 1.1 kΩ minimum"))

    margin = budget["policy_margin"]
    for name, (total, direct, source, kind) in budget["scenarios"].items():
        through = total - direct
        headroom = (i_min - through) / i_min
        line = (f"{name}: {through} mA through charger (limit ≥{i_min:.0f}, headroom "
                f"{headroom:+.0%}); {total} mA from USB (source {source})")
        if kind == "policy":
            if through > i_min * (1 - margin):
                out.append(("ERROR", line + f" — needs ≥{margin:.0%} headroom"))
            elif total > source:
                out.append(("ERROR", line + " — exceeds what the USB source may supply"))
            else:
                out.append(("INFO", line))
        elif kind == "uncapped":
            out.append(("ERROR" if through > i_min else "INFO", line))
        else:  # advisory: documents why a policy exists; reported, never fails
            out.append(("INFO", line + " (advisory)"))

    # One board: full features need the >=1.5 A source, reduced mode fits any USB source.
    need = budget["required_source_ma"]
    for name, (total, _direct, source, kind) in budget["scenarios"].items():
        if kind == "policy" and not name.startswith("default_usb") and source < need["full"]:
            out.append(("ERROR", f"{name}: full-feature scenario assumes a {source} mA source, "
                                 f"below the required {need['full']} mA"))
    for mode, ma in need.items():
        peak = max(t for n, (t, _d, _s, k) in budget["scenarios"].items() if k == "policy"
                   and n.startswith("default_usb") == (mode == "reduced"))
        if peak > ma:
            out.append(("ERROR", f"{mode}: needs {peak} mA but only requires a {ma} mA source"))
        else:
            out.append(("INFO", f"{mode} mode: requires a ≥{ma} mA USB source; peak {peak} mA"))

    worst_rating = min(budget["vsys_parts_max_v"].values())
    if ch["vsys_max_v"] > worst_rating:
        out.append(("ERROR", f"VSYS can reach {ch['vsys_max_v']} V but a part on it is rated "
                             f"{worst_rating} V"))
    else:
        out.append(("INFO", f"VSYS ≤{ch['vsys_max_v']} V; lowest rating on VSYS "
                            f"{worst_rating} V"))

    # Linear power path: the charger drops VBUS -> 4.4 V at full load current.
    through_worst = max(t - d for t, d, _, kind in budget["scenarios"].values()
                        if kind == "policy")
    watts = (supply["vbus_max_v"] - 4.4) * through_worst / 1000
    tj = supply["ambient_max_c"] + watts * ch["theta_ja_c_per_w"]
    lvl = "ERROR" if tj >= ch["tj_reg_c"] else "INFO"
    out.append((lvl, f"charger dissipation {watts:.2f} W at {through_worst} mA -> Tj ≈ "
                     f"{tj:.0f} °C (fold-back at {ch['tj_reg_c']} °C)"))
    return out
