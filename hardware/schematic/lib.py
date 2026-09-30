"""Small helper layer over SKiDL: part specs with sourcing data, passives, pinless board items.

Every part in the design is created through ``make()`` (ICs, connectors) or the passive helpers
``R() C() L() FB()``. Each part carries these fields, which end up in the KiCad netlist and BOM:

- ``MPN`` / ``Manufacturer`` - orderable part number
- ``LCSC``  - LCSC/JLCPCB code, checked against LCSC by ``lcsc.py`` (cache: lcsc_cache.json)
- ``Verified`` - "yes" when the pin map was checked against the cited datasheet, otherwise the
  reason it is not (rendered as ``[UNVERIFIED] ...`` in the BOM)
- ``DNP`` - "1" when the part is not fitted (the minimal board fits everything)
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field

from skidl import SKIDL, TEMPLATE, Net, Part, Pin

PT = Pin.types
_TYPES = {
    "pwr_in": PT.PWRIN,
    "pwr_out": PT.PWROUT,
    "in": PT.INPUT,
    "out": PT.OUTPUT,
    "io": PT.BIDIR,
    "tri": PT.TRISTATE,
    "pas": PT.PASSIVE,
    "oc": PT.OPENCOLL,
    "nc": PT.NOCONNECT,
}


@dataclass
class Spec:
    key: str
    ref: str  # reference prefix, e.g. "U"
    mpn: str
    manufacturer: str
    lcsc: str | None  # None = no LCSC source (bare pad, custom part, module bought elsewhere)
    footprint: str
    pins: list[tuple]  # (number, name, type)
    desc: str
    datasheet: str = ""
    verified: str = "yes"  # "yes" or the reason the data is unverified
    i2c: dict = field(default_factory=dict)  # bus -> 7-bit base address, e.g. {"I2C": 0x18}
    i2c_straps: list = field(default_factory=list)  # [(pin name, bit)]: address |= level << bit
    template: Part | None = None


SPECS: dict[str, Spec] = {}
BLOCK = {"name": ""}  # schematic block of the parts being made (review.py: one page per block)
_counters: dict[str, int] = {}
_used: set[str] = set()


def spec(key: str, **kw) -> Spec:
    s = Spec(key=key, **kw)
    pins = []
    for num, name, typ in s.pins:
        pins.append(Pin(num=str(num), name=name, func=_TYPES[typ]))
    s.template = Part(
        tool=SKIDL,
        name=key,
        ref_prefix=s.ref,
        dest=TEMPLATE,
        footprint=s.footprint,
        description=s.desc,
        pins=pins,
    )
    SPECS[key] = s
    return s


def _next_ref(prefix: str) -> str:
    while True:
        _counters[prefix] = _counters.get(prefix, 0) + 1
        ref = f"{prefix}{_counters[prefix]}"
        if ref not in _used:
            return ref


def reset_refs() -> None:
    _counters.clear()
    _used.clear()


def make(key: str, ref: str | None = None, value: str | None = None, dnp: bool = False,
         note: str = "") -> Part:
    s = SPECS[key]
    if ref and ref in _used:
        raise ValueError(f"reference {ref} already used (explicit refs must be unique)")
    ref = ref or _next_ref(s.ref)
    _used.add(ref)
    p = s.template(value=value or s.mpn, ref=ref, tag=ref)
    p.fields["MPN"] = s.mpn
    p.fields["Manufacturer"] = s.manufacturer
    p.fields["LCSC"] = s.lcsc or ""
    p.fields["Verified"] = s.verified
    p.fields["Datasheet"] = s.datasheet
    p.fields["DNP"] = "1" if dnp else ""
    p.fields["Note"] = note
    p.fields["SpecKey"] = key
    p.fields["Block"] = BLOCK["name"]
    return p


# --------------------------------------------------------------------------------------------
# Passives. Codes are JLCPCB "basic" parts, verified with lcsc.py (see lcsc_cache.json).
# Default size is 0603 (owner requirement 2026-09-27: hand-solderable one-offs; 0603 costs
# nothing electrically at these frequencies). 0402 stays available via size="0402".

RES_0603 = {
    "0": "C21189", "1": "C22936", "22": "C23345", "33": "C23140", "47": "C23182", "100": "C22775",
    "200": "C8218", "330": "C23138", "470": "C23179", "1k": "C21190", "2.2k": "C4190",
    "4.7k": "C23162", "5.1k": "C23186", "10k": "C25804", "22k": "C31850", "47k": "C25819",
    "100k": "C25803", "1M": "C22935", "15k": "C22809", "33k": "C4216", "68k": "C23231",
    "680": "C23228",
}
RES_0402 = {
    "0": "C17168", "1": "C25086", "22": "C25092", "33": "C25105", "47": "C25118", "100": "C25076",
    "200": "C25087", "330": "C25104", "470": "C25117", "1k": "C11702", "2.2k": "C25879",
    "4.7k": "C25900", "5.1k": "C25905", "10k": "C25744", "22k": "C25768", "47k": "C25792",
    "100k": "C25741", "1M": "C26083",
}
RES_EXTRA = {}  # (value, size) -> (lcsc, mpn); filled by parts.py for non-basic values
CAP = {
    # value -> (lcsc, package, voltage)
    "22p": ("C1653", "0603", "50V C0G"),
    "33p": ("C1663", "0603", "50V C0G"),
    "47p": ("C1671", "0603", "50V C0G"),
    "100p": ("C14858", "0603", "50V C0G"),
    "1n": ("C1588", "0603", "50V X7R"),
    "100n": ("C14663", "0603", "50V X7R"),
    "1u": ("C15849", "0603", "50V X5R"),
    "2.2u": ("C23630", "0603", "16V X5R"),
    "4.7u": ("C19666", "0603", "16V X5R"),
    "10u": ("C19702", "0603", "10V X5R"),
    "22u": ("C45783", "0805", "25V X5R"),
}
CAP_EXTRA = {}  # value-key -> (lcsc, package, voltage, mpn); filled by parts.py

_FP_R = {"0402": "Resistor_SMD:R_0402_1005Metric", "0603": "Resistor_SMD:R_0603_1608Metric",
         "2512": "Resistor_SMD:R_2512_6332Metric"}
_FP_C = {
    "0402": "Capacitor_SMD:C_0402_1005Metric",
    "0603": "Capacitor_SMD:C_0603_1608Metric",
    "0805": "Capacitor_SMD:C_0805_2012Metric",
    "1206": "Capacitor_SMD:C_1206_3216Metric",
}


_LCSC_CACHE = None


def _cache_mpn(lcsc: str | None) -> str:
    """MPN of a passive, taken from the verified LCSC cache (so BOM rows carry an MPN)."""
    global _LCSC_CACHE
    if _LCSC_CACHE is None:
        from lcsc import load_cache

        _LCSC_CACHE = load_cache()
    return (_LCSC_CACHE.get(lcsc or "") or {}).get("mpn") or ""


def _two_pin(prefix, name, value, footprint, lcsc, mpn, dnp, note, verified="yes", manu=""):
    mpn = mpn or _cache_mpn(lcsc)
    key = f"_{prefix}_{footprint}"
    if key not in SPECS:
        spec(key, ref=prefix, mpn="", manufacturer="", lcsc=None, footprint=footprint,
             pins=[(1, "1", "pas"), (2, "2", "pas")], desc=name)
    p = make(key, value=value, dnp=dnp, note=note)
    p.fields["MPN"] = mpn
    p.fields["Manufacturer"] = manu
    p.fields["LCSC"] = lcsc or ""
    p.fields["Verified"] = verified
    return p


def R(value: str, dnp: bool = False, note: str = "", size: str = "0603") -> Part:
    basic = {"0603": RES_0603, "0402": RES_0402}.get(size, {})
    if (value, size) in RES_EXTRA:
        lcsc, mpn = RES_EXTRA[(value, size)]
        verified = "yes"
    elif value in basic:
        lcsc, mpn, verified = basic[value], "", "yes"
    else:
        lcsc, mpn, verified = None, "", f"no LCSC code chosen for {value} {size}"
    return _two_pin("R", "resistor", value, _FP_R[size], lcsc, mpn, dnp, note, verified)


def C(value: str, dnp: bool = False, note: str = "") -> Part:
    if value in CAP_EXTRA:
        lcsc, size, volt, mpn = CAP_EXTRA[value]
        v = value.split("@")[0]
    elif value in CAP:
        lcsc, size, volt = CAP[value]
        mpn, v = "", value
    else:
        raise KeyError(f"no capacitor entry for {value!r}; add it to CAP/CAP_EXTRA")
    return _two_pin("C", "capacitor", f"{v}F {volt}", _FP_C[size], lcsc, mpn, dnp, note)


def graphic(footprint: str, value: str, prefix: str = "G") -> Part:
    """A pinless board item (mounting hole, silkscreen logo/text): in the netlist so layout
    places it, never in the BOM."""
    key = f"_{prefix}_{footprint}"
    if key not in SPECS:
        spec(key, ref=prefix, mpn="", manufacturer="", lcsc=None, footprint=footprint, pins=[],
             desc=value)
    p = make(key, value=value)
    p.fields["BOM"] = "exclude"
    return p


def series(a: Net, b: Net, part: Part) -> Part:
    part[1] += a
    part[2] += b
    return part


def decouple(rail: Net, gnd: Net, *values: str, note: str = "") -> None:
    for v in values:
        series(rail, gnd, C(v, note=note))


def rail(name: str) -> Net:
    """A power net (acts as its own PWR_FLAG for ERC)."""
    n = Net(name)
    n.drive = Pin.drives.POWER  # acts as PWR_FLAG
    return n


def norm_mpn(s: str) -> str:
    return re.sub(r"[^A-Z0-9]", "", (s or "").upper())
