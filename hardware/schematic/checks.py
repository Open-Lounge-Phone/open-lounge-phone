"""Design-rule checks that SKiDL's ERC does not do. Each returns a list of (level, message).

level is "ERROR" (fails the build), "WARN" or "INFO" (reported in checks.txt).
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



MODULE = "ESP32-S3-WROOM-1U"


def _module_gpios(circuit):
    mods = [p for p in circuit.parts if p.fields.get("SpecKey") == MODULE]
    if len(mods) != 1:
        raise ValueError(f"expected one {MODULE}, found {len(mods)}")
    by_gpio = {}
    for pin in mods[0].pins:
        m = re.fullmatch(r"IO(\d+)", pin.name)
        if m:
            by_gpio[int(m.group(1))] = pin
        elif pin.name in ("TXD0", "RXD0"):
            by_gpio[{"TXD0": 43, "RXD0": 44}[pin.name]] = pin
    return by_gpio


def _can_pull_high(net) -> list[str]:
    """What on `net` could hold it high at reset: a resistor to 3V3/VBUS, a direct rail, or any
    IC output. Switches to GND, transistor bases and LED anodes cannot."""
    if net.name in ("3V3", "VBUS"):
        return [net.name]
    why = [f"{r.ref} to {_name(_net_of([q for q in r.pins if _net_of(q) is not net][0]))}"
           for r in _resistors_to(net, {"3V3", "VBUS"})]
    for p in net.pins:
        k = p.part.fields.get("SpecKey", "")
        if k in (MODULE,) or k.startswith("_R_"):
            continue
        if k in ("HOTSWAP", "TACT", "LED_RED", "MMBT3904"):
            continue
        why.append(f"{p.part.ref}.{p.name}")
    return why


def check_pin_table(circuit):
    """Every module GPIO matches pin_table.yaml; strap, RTC and pull-up rules hold."""
    out = []
    by_gpio = _module_gpios(circuit)
    for gpio, row in PIN_TABLE["gpio"].items():
        pin = by_gpio.get(gpio)
        if pin is None:
            out.append(("ERROR", f"GPIO{gpio} not found on the module symbol"))
            continue
        net, want = _net_of(pin), row.get("net")
        got = _name(net)
        if want is None:
            if net is not None:
                out.append(("ERROR", f"GPIO{gpio} must stay unconnected ({row.get('note')}), "
                                     f"is on {got}"))
            continue
        if got != want:
            out.append(("ERROR", f"GPIO{gpio}: pin table says {want}, schematic has {got}"))
            continue
        if row.get("rtc") and gpio not in RTC_GPIOS:
            out.append(("ERROR", f"GPIO{gpio} ({want}) is a wake source but not an RTC GPIO"))
        if row.get("strap") and gpio not in (0, 3, 45, 46):
            out.append(("ERROR", f"GPIO{gpio} marked strap, but the S3 straps are 0/3/45/46"))
        if gpio in (3, 45, 46) and not row.get("low_only"):
            out.append(("ERROR", f"GPIO{gpio} is a strap: only low-only circuits allowed"))
        if row.get("low_only") or gpio == 0:
            high = _can_pull_high(net)
            if high:
                out.append(("ERROR", f"GPIO{gpio} ({want}) strap could be pulled high at reset "
                                     f"by {', '.join(high)}"))
        if gpio == 0 and _resistors_to(net, GND_NAMES):
            out.append(("ERROR", "GPIO0 has a pull-down: the board would boot into download mode"))
        if row.get("pull") == "up":
            ups = _resistors_to(net, {"3V3"})
            if len(ups) != 1 or _resistors_to(net, GND_NAMES):
                out.append(("ERROR", f"GPIO{gpio} ({want}) needs exactly one pull-up to 3V3"))
    for gpio, pin in by_gpio.items():
        if gpio not in PIN_TABLE["gpio"] and _net_of(pin) is not None:
            out.append(("ERROR", f"GPIO{gpio} is connected ({_name(_net_of(pin))}) but not in "
                                 "pin_table.yaml"))
    used = sum(1 for r in PIN_TABLE["gpio"].values() if r.get("net"))
    if not out:
        out.append(("INFO", f"OK: {used} GPIOs used, straps 0/3/45/46 safe at reset, PSRAM "
                            "35-37 unconnected"))
    return out


def check_keys(circuit):
    """Each key and the hook: one hot-swap socket between its own GPIO and GND, nothing else on
    the net (no matrix, no expander)."""
    from config import KEYS

    out = []
    nets = {n.name: n for n in circuit.nets}
    for name in [f"KEY_{k}" for k in KEYS] + ["HOOK"]:
        net = nets.get(name)
        if net is None:
            out.append(("ERROR", f"{name} missing"))
            continue
        keys = {p.part.fields.get("SpecKey") for p in net.pins}
        if sorted(p.part.fields.get("SpecKey") for p in net.pins) != sorted(["HOTSWAP", MODULE]):
            out.append(("ERROR", f"{name}: expected one socket + one GPIO, found {keys}"))
            continue
        sock = next(p.part for p in net.pins if p.part.fields.get("SpecKey") == "HOTSWAP")
        other = [q for q in sock.pins if _net_of(q) is not net]
        if len(other) != 1 or _name(_net_of(other[0])) != "GND":
            out.append(("ERROR", f"{name}: socket {sock.ref} must switch to GND"))
    if not out:
        out.append(("INFO", f"OK: {len(KEYS)} keys + hook, one GPIO each, switch to GND"))
    return out


def _parse_ohms(value: str) -> float:
    m = re.fullmatch(r"([\d.]+)([kKmM]?)", value.strip())
    if not m:
        raise ValueError(f"can't parse resistance {value!r}")
    return float(m.group(1)) * {"": 1, "k": 1e3, "K": 1e3, "m": 1e-3, "M": 1e6}[m.group(2)]


def check_power_budget(circuit):
    """power_budget.yaml: the 3.3 V loads fit the LDO, the whole board fits a USB default-power
    source, the LDO stays in regulation at the lowest VBUS and runs cool enough."""
    bud = yaml.safe_load((HERE / "power_budget.yaml").read_text())
    ldo, src = bud["ldo"], bud["source"]
    out = []
    ldos = [p for p in circuit.parts if p.fields.get("SpecKey") == ldo["part"]]
    if len(ldos) != 1:
        return [("ERROR", f"expected one {ldo['part']}, found {len(ldos)}")]
    peak = sum(v["peak_ma"] for v in bud["loads_3v3"].values())
    avg = sum(v["avg_ma"] for v in bud["loads_3v3"].values())
    vbus_peak = peak + sum(v["peak_ma"] for v in bud["loads_vbus"].values())
    lim = ldo["rated_ma"] * (1 - bud["margin"])
    out.append(("ERROR" if peak > lim else "INFO",
                f"3V3 peak {peak} mA vs {ldo['rated_ma']} mA rated (limit with "
                f"{bud['margin']:.0%} margin: {lim:.0f} mA); average {avg} mA"))
    if ldo["rated_ma"] < bud["module_supply_min_ma"]:
        out.append(("ERROR", f"regulator rated {ldo['rated_ma']} mA < the module's "
                             f"{bud['module_supply_min_ma']} mA supply requirement"))
    out.append(("ERROR" if vbus_peak > src["limit_ma"] else "INFO",
                f"USB draw peak {vbus_peak} mA vs {src['limit_ma']} mA ({src['name']})"))
    # dropout at the lowest VBUS, at the peak current
    table = ldo["dropout_max_mv"]  # {load mA: max dropout mV}, datasheet points
    at = min((i for i in table if i >= peak), default=None)
    if at is None:
        return out + [("ERROR", f"peak {peak} mA is beyond the dropout table")]
    drop = table[at] / 1000
    vin_min = src["vbus_min_v"] - src["cable_ohm"] * vbus_peak / 1000
    head = vin_min - drop - ldo["vout_v"]
    out.append(("ERROR" if head < 0 else "INFO",
                f"LDO headroom at VBUS {src['vbus_min_v']} V - cable {src['cable_ohm']} ohm at "
                f"{vbus_peak} mA = {vin_min:.2f} V in, dropout {drop * 1000:.0f} mV max: "
                f"{head * 1000:+.0f} mV"))
    pd = (src["vbus_max_v"] - ldo["vout_v"]) * avg / 1000
    tj = bud["ambient_max_c"] + pd * ldo["theta_ja_c_per_w"]
    out.append(("ERROR" if tj > ldo["tj_max_c"] else "INFO",
                f"LDO {pd:.2f} W at {avg} mA average -> Tj {tj:.0f} C at "
                f"{bud['ambient_max_c']} C ambient (limit {ldo['tj_max_c']} C)"))
    return out


def run_all(circuit):
    results = []
    for fn in (check_pin_table, check_keys, check_i2c, check_nets, check_sourcing,
               check_footprints, check_power_budget):
        try:
            results += [(lvl, f"[{fn.__name__}] {msg}") for lvl, msg in fn(circuit)]
        except Exception as exc:  # a crashing check is a failing check
            results.append(("ERROR", f"[{fn.__name__}] crashed: {exc!r}"))
    return results


def check_i2c(circuit):
    """Derived addresses must match pin_table.yaml's I2C map and be unique on the bus."""
    out, seen = [], {}
    for a, ref, key, _ in i2c_devices(circuit):
        if a in seen:
            out.append(("ERROR", f"I2C address 0x{a:02X} used by {seen[a]} and {ref}"))
        seen[a] = ref
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


OPEN_INPUTS: dict = {}  # SpecKey -> pin names deliberately left open


def check_nets(circuit):
    out = []
    for net in circuit.nets:
        if net.name == "__NOCONNECT" or not net.pins:
            continue
        real = [p for p in net.pins if p.part.ref_prefix not in ("TP",)]
        if len(net.pins) == 1:
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
