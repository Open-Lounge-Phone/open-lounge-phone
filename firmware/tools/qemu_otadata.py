#!/usr/bin/env python3
"""QEMU only: the two otadata writes the ESP-IDF bootloader makes, done on the flash file.

Espressif's QEMU (9.2.2, builds 20250817 and 20260417) hangs on the bootloader's first flash
write: with app rollback on, a blank otadata makes the bootloader record ota_0 (`seed` writes that
entry into the image instead). The bootloader's later otadata writes (NEW -> PENDING_VERIFY when it
boots a new image, PENDING_VERIFY -> ABORTED after a trial boot that never confirmed itself) worked
in the OTA test runs; `boot` makes the same write on a stopped QEMU's flash file in case a run ever
stalls there. Real hardware and Wokwi don't need this tool.

    qemu_otadata.py seed FLASH    blank otadata -> ota_0, VALID (what the first boot writes)
    qemu_otadata.py boot FLASH    the transition of the next boot; prints it
    qemu_otadata.py show FLASH
"""
import struct
import sys
import zlib

OTADATA = 0xF000  # partitions.csv
SECTOR = 0x1000
STATES = {0: "NEW", 1: "PENDING_VERIFY", 2: "VALID", 3: "INVALID", 4: "ABORTED", 0xFFFFFFFF: "UNDEFINED"}


def crc(seq: int) -> int:
    return zlib.crc32(struct.pack("<I", seq), 0xFFFFFFFF)  # bootloader_common_ota_select_crc


def entries(flash: bytearray):
    out = []
    for i in range(2):
        off = OTADATA + i * SECTOR
        seq, label, state, c = struct.unpack_from("<I20sII", flash, off)
        valid = seq not in (0, 0xFFFFFFFF) and c == crc(seq)
        out.append({"off": off, "seq": seq, "state": state, "valid": valid})
    return out


def write(flash: bytearray, off: int, seq: int, state: int) -> None:
    flash[off:off + SECTOR] = b"\xff" * SECTOR  # the bootloader erases the sector first
    struct.pack_into("<I20sII", flash, off, seq, b"\xff" * 20, state, crc(seq))


def main() -> int:
    cmd, path = sys.argv[1], sys.argv[2]
    flash = bytearray(open(path, "rb").read())
    es = entries(flash)
    active = max((e for e in es if e["valid"]), key=lambda e: e["seq"], default=None)
    if cmd == "seed":
        if active is None:
            write(flash, OTADATA, 1, 2)
            print("otadata: ota_0 VALID (seq 1)")
    elif cmd == "boot":
        if active is None:
            raise SystemExit("no valid otadata entry")
        slot = f"ota_{(active['seq'] - 1) % 2}"
        new = {0: 1, 1: 4}.get(active["state"])  # NEW -> PENDING_VERIFY, PENDING_VERIFY -> ABORTED
        if new is None:
            print(f"otadata: {slot} {STATES.get(active['state'], active['state'])}: nothing to do")
        else:
            write(flash, active["off"], active["seq"], new)
            print(f"otadata: {slot} {STATES[active['state']]} -> {STATES[new]}")
    elif cmd == "show":
        for e in es:
            print(e["off"], e["seq"], STATES.get(e["state"], e["state"]), "ok" if e["valid"] else "-")
        return 0
    else:
        raise SystemExit(__doc__)
    open(path, "wb").write(flash)
    return 0


if __name__ == "__main__":
    sys.exit(main())
