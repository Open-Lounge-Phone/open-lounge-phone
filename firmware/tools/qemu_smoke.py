#!/usr/bin/env python3
"""Boot smoke test in QEMU (CI and local): a clean default build, fresh flash, boot, console.

    firmware/tools/qemu.sh build && python3 firmware/tools/qemu_smoke.py

Build it WITHOUT OLP_SIM_SERVER: the defaults (no server, no update key) are what's tested.
Checks the boot banner, the test audio device, the DTLS certificate (esp_peer), an IP on QEMU's
Ethernet, the "SET UP: CHOOSE A SERVER" screen, MENU 4 (Server) and `server`, that updates are
off (`ota now` makes no calls), and that `status`, `audio`, `rtc` and `volume` answer. Then it
reads the phone's network traffic (QEMU_PCAP): apart from DHCP, the phone sent nothing at all —
no DNS lookup, no TCP connection, no UDP (NTP included) to anyone, project hosts included.
"""
from __future__ import annotations

import os
import re
import struct
import subprocess
import sys
import time

FW = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
QEMU_SH = os.path.join(FW, "tools", "qemu.sh")
DHCP_PORTS = {67, 68}


def outbound(pcap: str) -> list[str]:
    """Every TCP/UDP packet in the capture other than DHCP, as 'proto src -> dst:port'."""
    data = open(pcap, "rb").read()
    if len(data) < 24:
        raise SystemExit(f"no packet capture in {pcap}")
    endian = "<" if data[:4] == b"\xd4\xc3\xb2\xa1" else ">"
    off, found, frames = 24, [], 0
    while off + 16 <= len(data):
        _, _, incl, _ = struct.unpack(endian + "IIII", data[off:off + 16])
        frame = data[off + 16:off + 16 + incl]
        off += 16 + incl
        frames += 1
        if len(frame) < 14:
            continue
        etype = struct.unpack(">H", frame[12:14])[0]
        if etype == 0x0800 and len(frame) >= 34:  # IPv4
            ihl = (frame[14] & 0x0F) * 4
            proto = frame[23]
            src, dst = ".".join(map(str, frame[26:30])), ".".join(map(str, frame[30:34]))
            l4 = frame[14 + ihl:]
        elif etype == 0x86DD and len(frame) >= 54:  # IPv6
            proto = frame[20]
            src, dst = frame[22:38].hex(), frame[38:54].hex()
            l4 = frame[54:]
        else:
            continue  # ARP and the like
        if proto not in (6, 17) or len(l4) < 4:
            continue  # ICMP / ICMPv6 (neighbour discovery)
        sport, dport = struct.unpack(">HH", l4[:4])
        if proto == 17 and (sport in DHCP_PORTS or dport in DHCP_PORTS):
            continue
        found.append(f"{'tcp' if proto == 6 else 'udp'} {src}:{sport} -> {dst}:{dport}")
    print(f"\npcap: {frames} frames, {len(found)} non-DHCP TCP/UDP packets")
    return found


def main() -> int:
    timeout = float(os.environ.get("QEMU_SMOKE_TIMEOUT", "120"))
    pcap = os.path.join(FW, os.environ.get("OLP_QEMU_BUILD", "build-qemu"), "smoke.pcap")
    if os.path.exists(pcap):
        os.remove(pcap)
    subprocess.run([QEMU_SH, "fresh"], check=True, cwd=FW)
    proc = subprocess.Popen([QEMU_SH, "resume"], cwd=FW, stdin=subprocess.PIPE,
                            stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                            env={**os.environ, "QEMU_PCAP": pcap})
    os.set_blocking(proc.stdout.fileno(), False)
    log = ""  # everything printed
    cursor = 0  # command replies are looked for after this point
    end = time.time() + timeout

    def pump() -> None:
        nonlocal log
        chunk = proc.stdout.read()
        if chunk:
            text = chunk.decode("utf-8", "replace")
            sys.stdout.write(text)
            log += text

    def wait(pattern: str, anywhere: bool = False) -> re.Match:
        """Boot facts may come in any order (anywhere=True); replies come after the command."""
        nonlocal cursor
        rx = re.compile(pattern)
        while time.time() < end:
            pump()
            m = rx.search(log, 0 if anywhere else cursor)
            if m:
                if not anywhere:
                    cursor = m.end()
                return m
            if proc.poll() is not None:
                raise SystemExit(f"QEMU exited before /{pattern}/")
            time.sleep(0.1)
        raise SystemExit(f"timed out waiting for /{pattern}/")

    def send(cmd: str) -> None:
        proc.stdin.write((cmd + "\n").encode())
        proc.stdin.flush()

    try:
        wait(r"Open Lounge Phone firmware [\d.]+ \(simulator build: QEMU\)", True)
        wait(r"audio device: test", True)
        wait(r"DTLS certificate ready \(0,", True)
        wait(r"WIFI connected ip=10\.0\.2\.\d+ \(QEMU Ethernet\)", True)
        # No server by default: the phone asks for one and connects to nothing.
        wait(r"NO SERVER: not connecting", True)
        wait(r"STRIP \[SET UP:\|CHOOSE A SERVER\|PRESS MENU 4\]", True)
        wait(r"olp> ", True)
        cursor = len(log)
        send("server")
        wait(r"server: none")
        send("key menu")
        wait(r"MENU root")
        send("key 4")
        wait(r"MENU server")
        wait(r"STRIP \[SERVER\|NOT SET\|1 CHANGE\]", True)
        send("key back")
        wait(r"MENU root")
        send("key back")
        wait(r"MENU closed")
        # Updates are off in a source build: no update key, no URL, no calls.
        send("ota")
        wait(r"OTA running=\S+ slot=\S+ updates=off \(no update key in this build\)[^\n]* url=-")
        send("ota now")
        wait(r"OTA OFF: updates not set up")
        wait(r"STRIP \[UPDATES\|NOT SET UP\]", True)
        send("ota url https://example.com/firmware-manifest.json")
        wait(r"updates are off in this build")
        send("status")
        wait(r"STATUS state=idle conn=\w+ authed=0")
        send("audio")
        wait(r"AUDIO device=test call=0 volume=6/10")
        send("volume 4")
        wait(r"volume 4/10")
        send("rtc")
        wait(r"RTC call=- state=")
        # Give anything that would call out (a socket, an update check, a clock) time to try.
        quiet_until = time.time() + float(os.environ.get("QEMU_SMOKE_QUIET_S", "15"))
        while time.time() < quiet_until:
            pump()
            time.sleep(0.2)
        for bad in ("WS connecting", "OTA CHECK", "openloungephone.app", "github.com"):
            if bad in log:
                raise SystemExit(f"FAIL: the log shows {bad!r}: the phone tried to reach a server")
    finally:
        proc.kill()
        proc.wait()
    sent = outbound(pcap)
    if sent:
        raise SystemExit("FAIL: the phone made network connections:\n  " + "\n  ".join(sent[:20]))
    print("QEMU SMOKE PASS")
    return 0


if __name__ == "__main__":
    sys.exit(main())
