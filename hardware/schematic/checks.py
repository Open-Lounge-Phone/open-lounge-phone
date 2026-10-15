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


RAILS_HIGH = {"3V3", "VBUS", "V5", "ETH_3V3", "ETH_3V3A", "POE_5V"}
# Tri-state outputs that are Hi-Z while their enable input is high (part -> output -> enable):
# such an output cannot drive a strap at reset if `_held_high_at_reset` holds for the enable net.
TRISTATE = {"W5500": {"MISO": "SCSn"}}   # W5500 datasheet v1.1.0 p10 (MISO Hi-Z while SCSn high)


def _held_high_at_reset(net) -> bool:
    """A pull-up to a 3.3 V rail, no pull-down, and nothing that can pull it low at reset except a
    pushbutton (a human holding BOOT is the one case allowed)."""
    if not _resistors_to(net, {"3V3", "ETH_3V3"}) or _resistors_to(net, GND_NAMES):
        return False
    for p in net.pins:
        k = p.part.fields.get("SpecKey", "")
        if k in (MODULE,) or k.startswith("_R_"):
            continue
        if p.func not in (p.types.INPUT,):      # only inputs (and the module) may sit on it
            return False
    return True


def _can_pull_high(net) -> list[str]:
    """What on `net` could hold it high at reset: a resistor to a supply rail, a direct rail, or
    any IC output. Switches to GND, transistor bases, LED anodes and IC inputs cannot; nor can a
    tri-state output whose enable is held high at reset (TRISTATE)."""
    if net.name in RAILS_HIGH:
        return [net.name]
    why = [f"{r.ref} to {_name(_net_of([q for q in r.pins if _net_of(q) is not net][0]))}"
           for r in _resistors_to(net, RAILS_HIGH)]
    for p in net.pins:
        k = p.part.fields.get("SpecKey", "")
        if k in (MODULE,) or k.startswith("_R_"):
            continue
        if k in ("HOTSWAP", "TACT", "LED_RED", "MMBT3904"):
            continue
        if p.func == p.types.INPUT:
            continue
        en = TRISTATE.get(k, {}).get(p.name)
        if en and _net_of(p.part[en]) is not None and _held_high_at_reset(_net_of(p.part[en])):
            continue
        why.append(f"{p.part.ref}.{p.name}")
    return why


def _boot_low_v(net, vdd=3.3):
    """GPIO0 with BOOT held: the voltage the button (to GND, directly or through one series
    resistor) makes against the pull-ups to 3V3. None if no BOOT button reaches the net."""
    def ohms(part):
        return _parse_ohms(part.value.split()[0])
    ups = [ohms(r) for r in _resistors_to(net, {"3V3"})]
    r_up = 1 / sum(1 / r for r in ups) if ups else float("inf")
    for p in net.pins:
        part = p.part
        if part.fields.get("SpecKey") == "TACT":
            return 0.0
        if part.fields.get("SpecKey", "").startswith("_R_"):
            other = _net_of([q for q in part.pins if q is not p][0])
            if other is None:
                continue
            for q in other.pins:
                if q.part.fields.get("SpecKey") == "TACT":
                    sw_other = _net_of([x for x in q.part.pins if x is not q][0])
                    if _name(sw_other) in GND_NAMES:
                        rs = ohms(part)
                        return vdd * rs / (rs + r_up)
    return None


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
        if row.get("low_only"):
            high = _can_pull_high(net)
            if high:
                out.append(("ERROR", f"GPIO{gpio} ({want}) strap could be pulled high at reset "
                                     f"by {', '.join(high)}"))
        if gpio == 0:
            # high at reset = SPI boot (pull-ups are fine); BOOT held must still read low
            # (VIL max 0.25 x VDD = 0.83 V; ask for half of it)
            v = _boot_low_v(net)
            if v is None:
                out.append(("ERROR", "GPIO0: no BOOT button reaches it"))
            elif v > 0.41:
                out.append(("ERROR", f"GPIO0: BOOT held gives {v:.2f} V against its pull-ups "
                                     "(> 0.41 V): download mode is not reliable"))
            if _resistors_to(net, GND_NAMES):
                out.append(("ERROR", "GPIO0 has a pull-down: the board would boot into download mode"))
            low = [f"{p.part.ref}.{p.name}" for p in net.pins
                   if not p.part.fields.get("SpecKey", "").startswith("_R_")
                   and p.part.fields.get("SpecKey") not in (MODULE,) and p.func != p.types.INPUT]
            if low:
                out.append(("ERROR", f"GPIO0 is driven by {', '.join(low)}: only inputs may share it"))
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


def _at(table: dict, ma: float) -> float:
    """The table's value at the first point >= ma (datasheet worst-case points)."""
    k = min((i for i in table if i >= ma), default=None)
    if k is None:
        raise ValueError(f"{ma} mA is beyond the table {table}")
    return table[k]


def check_power_budget(circuit):
    """power_budget.yaml, per operating mode and power source: each 3.3 V LDO fits its rating
    with margin, the board fits USB default power (or the PoE module), each LDO stays in
    regulation at its lowest input (source minimum minus the OR diode) and runs cool enough."""
    bud = yaml.safe_load((HERE / "power_budget.yaml").read_text())
    ldo, srcs, regs = bud["ldo"], bud["sources"], bud["regulators"]
    out = []
    found = {p.ref for p in circuit.parts if p.fields.get("SpecKey") == ldo["part"]}
    if found != set(regs):
        return [("ERROR", f"regulators {sorted(found)} vs power_budget.yaml {sorted(regs)}")]
    for ref, rail_name in regs.items():
        part = next(p for p in circuit.parts if p.ref == ref)
        if _name(_net_of(part["VOUT"])) != rail_name or _name(_net_of(part["VIN"])) != "V5":
            out.append(("ERROR", f"{ref}: expected V5 -> {rail_name} in the schematic"))
    if ldo["rated_ma"] < bud["module_supply_min_ma"]:
        out.append(("ERROR", f"regulator rated {ldo['rated_ma']} mA < the module's "
                             f"{bud['module_supply_min_ma']} mA supply requirement"))

    def amount(v, mode, kind):
        x = v[kind]
        return x[mode] if isinstance(x, dict) else x

    lim = ldo["rated_ma"] * (1 - bud["margin"])
    for mode, m in bud["modes"].items():
        level = "WARN" if m.get("warn_only") else "ERROR"
        rails = {r: sum(amount(v, mode, "peak") for v in bud["loads"][r].values())
                 for r in regs.values()}
        avgs = {r: sum(amount(v, mode, "avg") for v in bud["loads"][r].values())
                for r in regs.values()}
        v5_peak = sum(rails.values()) + sum(amount(v, mode, "peak") for v in bud["loads"]["V5"].values())
        v5_avg = sum(avgs.values()) + sum(amount(v, mode, "avg") for v in bud["loads"]["V5"].values())
        for ref, rail_name in regs.items():
            pk = rails[rail_name]
            out.append(("ERROR" if pk > lim else "INFO",
                        f"[{mode}] {ref} {rail_name} peak {pk} mA vs {ldo['rated_ma']} mA rated "
                        f"(limit {lim:.0f} mA); average {avgs[rail_name]} mA"))
        for sname in m["sources"]:
            src = srcs[sname]
            bad = v5_peak > src["limit_ma"] * (1 if sname == "usb" else 1 - bud["margin"])
            out.append((level if bad else "INFO",
                        f"[{mode}] {sname} draw peak {v5_peak} mA vs {src['limit_ma']} mA "
                        f"({src['name']})"))
            if src.get("min_load_ma") and v5_avg < src["min_load_ma"]:
                out.append(("WARN", f"[{mode}] {sname}: average {v5_avg} mA is under the module's "
                                    f"{src['min_load_ma']} mA minimum load (fit the bleeder)"))
            vin_min = src["v_min"] - _at(src["vf_v"], v5_peak)
            for ref, rail_name in regs.items():
                drop = _at(ldo["dropout_max_mv"], rails[rail_name]) / 1000
                head = vin_min - drop - ldo["vout_v"]
                out.append(("ERROR" if head < 0 else "INFO",
                            f"[{mode}] {ref} headroom on {sname}: {src['v_min']} V - "
                            f"{src['diode']} {_at(src['vf_v'], v5_peak):.2f} V = {vin_min:.2f} V in, "
                            f"dropout {drop * 1000:.0f} mV max: {head * 1000:+.0f} mV"))
            for ref, rail_name in regs.items():
                vin_max = src["v_max"] - src["vf_min_v"]
                pd = (vin_max - ldo["vout_v"]) * avgs[rail_name] / 1000
                tj = bud["ambient_max_c"] + pd * ldo["theta_ja_c_per_w"]
                out.append(("ERROR" if tj > ldo["tj_max_c"] else "INFO",
                            f"[{mode}] {ref} on {sname}: {pd:.2f} W at {avgs[rail_name]} mA average "
                            f"-> Tj {tj:.0f} C at {bud['ambient_max_c']} C (limit {ldo['tj_max_c']} C)"))
    return out


POE_SIDE = {"POE_VA1", "POE_VA2", "POE_VB1", "POE_VB2", "POE_VIN_P", "POE_VIN_N"}
POE_PINS = {("RJ45_POE", "VC1+"), ("RJ45_POE", "VC1-"), ("RJ45_POE", "VC2+"),
            ("RJ45_POE", "VC2-"), ("MB10S", "+"), ("MB10S", "-"), ("MB10S", "AC1"),
            ("MB10S", "AC2"), ("SMAJ58A", "K"), ("SMAJ58A", "A"), ("DP9900LP-5V", "VIN+"),
            ("DP9900LP-5V", "VIN-")}


def check_poe(circuit):
    """The PoE input side is isolated (IEEE 802.3 1500 V): its nets reach only the RJ45's
    cable-side centre taps, the bridges, the TVS and the module's input pins; nothing of it
    touches GND or any other net; the module's output is POE_5V/GND."""
    out = []
    nets = {n.name: n for n in circuit.nets}
    for name in sorted(POE_SIDE):
        net = nets.get(name)
        if net is None:
            out.append(("ERROR", f"PoE net {name} missing"))
            continue
        for p in net.pins:
            if (p.part.fields.get("SpecKey"), p.name) not in POE_PINS:
                out.append(("ERROR", f"PoE net {name} reaches {p.part.ref}.{p.name}: the input "
                                     "side must stay isolated"))
    for part in circuit.parts:
        k = part.fields.get("SpecKey")
        for p in part.pins:
            n = _name(_net_of(p))
            if (k, p.name) in POE_PINS and n not in POE_SIDE:
                out.append(("ERROR", f"{part.ref}.{p.name} is on {n}, not a PoE input net"))
        if k == "DP9900LP-5V" and ({_name(_net_of(q)) for q in part.pins if q.name == "+VDC"} != {"POE_5V"}
                                   or {_name(_net_of(q)) for q in part.pins if q.name == "-VDC"} != {"GND"}):
            out.append(("ERROR", f"{part.ref}: output must be POE_5V / GND"))
    if not out:
        out.append(("INFO", f"OK: PoE input side ({len(POE_SIDE)} nets) isolated from GND"))
    return out


def run_all(circuit):
    results = []
    for fn in (check_pin_table, check_keys, check_i2c, check_nets, check_sourcing,
               check_footprints, check_power_budget, check_poe):
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
