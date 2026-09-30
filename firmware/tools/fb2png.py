#!/usr/bin/env python3
"""Turn the console's `screen` dump (FB / FBROW lines in a serial log) into a PNG (stdlib only).

  python3 firmware/tools/fb2png.py build-sim/serial.log build-sim/display.png
Uses the last dump in the log. Black on an e-paper-grey background, scaled 2x.
"""
import struct
import sys
import zlib


def main() -> None:
    log, out = sys.argv[1], sys.argv[2]
    rows, w, h, cur = [], 0, 0, None
    for line in open(log, errors="replace"):
        line = line.strip()
        if line.startswith("FB ") and line != "FB END":
            _, w, h = line.split()[:3]
            w, h, cur = int(w), int(h), []
        elif line.startswith("FBROW ") and cur is not None:
            cur.append(bytes.fromhex(line[6:]))
        elif line == "FB END" and cur is not None:
            rows = cur
    if not rows:
        sys.exit("no framebuffer dump in the log (run `screen` on the console)")
    scale, fg, bg = 2, (20, 20, 20), (222, 222, 214)
    raw = bytearray()
    for r in rows:
        line = bytearray()
        for x in range(w):
            on = r[x // 8] & (0x80 >> (x % 8))
            line += bytes(fg if on else bg) * scale
        for _ in range(scale):
            raw += b"\x00" + line
    def chunk(tag, data):
        return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data))
    png = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w * scale, len(rows) * scale, 8, 2, 0, 0, 0))
    png += chunk(b"IDAT", zlib.compress(bytes(raw), 9)) + chunk(b"IEND", b"")
    open(out, "wb").write(png)
    print(f"wrote {out} ({w}x{len(rows)})")


if __name__ == "__main__":
    main()
