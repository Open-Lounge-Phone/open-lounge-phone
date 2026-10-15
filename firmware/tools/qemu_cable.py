#!/usr/bin/env python3
"""The wired network (hw v0.901) end to end in QEMU, with QEMU's Ethernet as the cable.

    firmware/tools/qemu_cable.py            build (build-qemu-v0901) + run, ~4 minutes
    OLP_FW_NO_BUILD=1 firmware/tools/qemu_cable.py

QEMU has no W5500: a QEMU build for hw v0.901 (sdkconfig.v0901) drives its OpenCores Ethernet
through the same network choice (netsel.c), the same esp_netif/DHCP and the same app code; the
QEMU monitor's `set_link cable off|on` pulls the cable out and plugs it back in. QEMU has no Wi-Fi
either, so a "saved Wi-Fi" (sdkconfig.qemu names one) is never joined: the phone falls back to it,
powers the cable's PHY down and looks for the cable now and then, exactly as on the board.

Checks, in order:
  A. Wi-Fi saved, cable in: the cable is used (no setup network), `eth`, MENU 4 shows WIRED
     NETWORK and the address, `status`; cable out: OFFLINE / CABLE UNPLUGGED, Wi-Fi on, the PHY
     powers down after a moment and looks again every 30 s; cable back: found at the next look.
  B. No Wi-Fi (`wifi forget`, reboot): the cable alone, no setup network; cable out: the PHY stays
     on and the cable is back within seconds; the setup page says Wi-Fi is optional, saves a
     server with no Wi-Fi, and the phone restarts on the cable.
  C. No Wi-Fi, no cable at power-on: the setup network opens; plugging the cable in closes it.
Not covered (needs the board, hardware/BRINGUP.md §8): the W5500 itself (SPI, PHYCFGR power-down,
link LEDs), real Wi-Fi fallback and a call moving between networks.
"""
from __future__ import annotations

import os
import re
import socket
import subprocess
import sys
import time
import urllib.request

FW = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
QEMU_SH = os.path.join(FW, "tools", "qemu.sh")
BUILD = os.environ.get("OLP_QEMU_BUILD", "build-qemu-v0901")
MONITOR = int(os.environ.get("QEMU_CABLE_MONITOR", "47731"))
HTTP = int(os.environ.get("QEMU_CABLE_HTTP", "47732"))
ENV = {**os.environ, "OLP_QEMU_BUILD": BUILD, "OLP_QEMU_EXTRA_DEFAULTS": "sdkconfig.v0901",
       "QEMU_MONITOR": str(MONITOR), "QEMU_HOSTFWD": f"tcp::{HTTP}-:80"}
ENV.pop("OLP_SIM_SERVER", None)  # no server baked in: the test sets a dead local one


class Phone:
    def __init__(self) -> None:
        self.proc = subprocess.Popen([QEMU_SH, "resume"], cwd=FW, env=ENV, stdin=subprocess.PIPE,
                                     stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
        os.set_blocking(self.proc.stdout.fileno(), False)
        self.log = ""
        self.cursor = 0
        self.mon = None

    def pump(self) -> None:
        chunk = self.proc.stdout.read()
        if chunk:
            text = chunk.decode("utf-8", "replace")
            sys.stdout.write(text)
            self.log += text

    def wait(self, pattern: str, timeout: float = 60) -> re.Match:
        """The next match after the cursor (and moves the cursor past it)."""
        rx = re.compile(pattern)
        end = time.time() + timeout
        while time.time() < end:
            self.pump()
            m = rx.search(self.log, self.cursor)
            if m:
                self.cursor = m.end()
                return m
            if self.proc.poll() is not None:
                raise SystemExit(f"FAIL: QEMU exited before /{pattern}/")
            time.sleep(0.1)
        raise SystemExit(f"FAIL: timed out ({timeout:.0f} s) waiting for /{pattern}/")

    def absent(self, pattern: str, seconds: float) -> None:
        """Nothing matching for this long (from the cursor)."""
        end = time.time() + seconds
        rx = re.compile(pattern)
        while time.time() < end:
            self.pump()
            if rx.search(self.log, self.cursor):
                raise SystemExit(f"FAIL: /{pattern}/ appeared")
            time.sleep(0.2)

    def mark(self) -> None:
        self.pump()
        self.cursor = len(self.log)

    def send(self, cmd: str) -> None:
        self.mark()
        self.proc.stdin.write((cmd + "\n").encode())
        self.proc.stdin.flush()

    def monitor(self, cmd: str) -> None:
        """A QEMU monitor command (set_link cable off|on)."""
        if self.mon is None:
            for _ in range(50):
                try:
                    self.mon = socket.create_connection(("127.0.0.1", MONITOR), timeout=5)
                    break
                except OSError:
                    time.sleep(0.2)
            self.read_prompt()
        print(f"\n>>> QEMU monitor: {cmd}")
        self.mark()
        self.mon.sendall((cmd + "\n").encode())
        self.read_prompt()

    def read_prompt(self) -> None:
        buf = b""
        while not buf.rstrip().endswith(b"(qemu)"):
            buf += self.mon.recv(4096)

    def stop(self) -> None:
        if self.mon:
            self.mon.close()
        self.proc.kill()
        self.proc.wait()


def http(path: str, body: str | None = None) -> str:
    req = urllib.request.Request(f"http://127.0.0.1:{HTTP}{path}",
                                 data=body.encode() if body else None)
    with urllib.request.urlopen(req, timeout=20) as r:
        return r.read().decode("utf-8", "replace")


def main() -> int:
    if os.environ.get("OLP_FW_NO_BUILD") != "1":
        subprocess.run([QEMU_SH, "build"], cwd=FW, env=ENV, check=True)
    subprocess.run([QEMU_SH, "fresh"], cwd=FW, env=ENV, check=True)
    p = Phone()
    try:
        # --- A. Wi-Fi saved (never joinable in QEMU), cable in ------------------------------
        p.wait(r"Open Lounge Phone firmware [\d.]+ \(simulator build: QEMU\)")
        p.wait(r"saved Wi-Fi: qemu-ethernet")
        p.wait(r"ETH QEMU Ethernet \(standing in for the W5500\) ready")
        p.wait(r"ETH link up (10|100) Mbit/s (full|half) duplex")  # QEMU says 10 full
        p.wait(r"ETH got ip=10\.0\.2\.\d+")
        p.wait(r"NET settled: the cable")
        p.wait(r"NET uplink wired ip=10\.0\.2\.\d+")
        p.wait(r"STRIP \[SET UP:\|CHOOSE A SERVER\|PRESS MENU 4\]")  # the console is up by now
        if re.search(r"PROV open", p.log):
            raise SystemExit("FAIL: the setup network opened although the cable works")
        p.send("eth")
        p.wait(r"ETH controller=qemu-ethernet phy=on link=up (10|100)M (full|half) ip=10\.0\.2\.\d+ "
               r"mac=([0-9a-f]{2}:){5}[0-9a-f]{2} uplink=wired cable=\"WIRED NETWORK\"")
        p.send("status")
        p.wait(r"NET uplink=wired ip=10\.0\.2\.\d+ cable=WIRED NETWORK")
        p.send("key menu")
        p.wait(r"MENU root")
        p.send("key 4")
        p.wait(r"STRIP \[WIRED NETWORK\|10\.0\.2\.\d+\|NOT SET\|1 CHANGE\]")
        p.send("key back")
        p.send("key back")
        p.wait(r"MENU closed")
        # A server that never answers (QEMU's host, a closed port): OFFLINE shows the reason.
        p.send("server ws://10.0.2.2:9")
        p.wait(r"server saved: ws://10\.0\.2\.2:9")
        p.wait(r"STRIP \[OFFLINE\|RECONNECTING\]", 60)

        p.monitor("set_link cable off")
        p.wait(r"ETH link down", 10)
        p.wait(r"NET Wi-Fi on")  # at once
        p.wait(r"NET uplink none: CABLE UNPLUGGED")
        p.wait(r"STRIP \[OFFLINE\|CABLE UNPLUGGED\]", 20)
        t0 = time.time()
        p.wait(r"ETH PHY off \(power-down\)", 15)  # after a short look for a bumped cable
        p.wait(r"ETH PHY on \(looking for a link\)", 40)  # the next look (every 30 s)
        looked = time.time() - t0
        p.wait(r"ETH PHY off \(power-down\)", 15)  # still unplugged: off again
        print(f"\n>>> looks: first after {looked:.0f} s")
        p.monitor("set_link cable on")
        t0 = time.time()
        p.wait(r"ETH PHY on \(looking for a link\)", 40)  # found at the next look
        p.wait(r"ETH link up", 10)
        p.wait(r"NET Wi-Fi off", 20)
        p.wait(r"NET uplink wired ip=10\.0\.2\.\d+", 5)
        print(f"\n>>> cable back in use {time.time() - t0:.0f} s after it was plugged in")
        p.send("eth")
        p.wait(r"ETH controller=qemu-ethernet phy=on link=up .* uplink=wired")

        # --- B. no Wi-Fi: the cable alone --------------------------------------------------
        p.send("wifi forget")
        p.wait(r"wifi forgotten")
        p.send("reboot")
        p.wait(r"saved Wi-Fi: \(none\)", 60)
        p.wait(r"NET settled: the cable", 30)
        p.wait(r"NET uplink wired", 10)
        p.absent(r"PROV open", 8)
        p.monitor("set_link cable off")
        p.wait(r"NET uplink none: CABLE UNPLUGGED", 10)
        p.wait(r"STRIP \[OFFLINE\|CABLE UNPLUGGED\]", 20)
        p.absent(r"ETH PHY off|NET Wi-Fi on", 10)  # nothing else to use: the PHY stays on
        p.monitor("set_link cable on")
        p.wait(r"NET uplink wired ip=10\.0\.2\.\d+", 15)
        # The setup page on a working cable: Wi-Fi is optional; save a server only.
        p.send("setup")
        p.wait(r"PROV open \(asked for\)")
        p.wait(r"PROV AP UP")
        page = http("/")
        for want in ("Wi-Fi is optional", "No Wi-Fi: use the cable", "name=srv value=own"):
            if want not in page:
                raise SystemExit(f"FAIL: the setup page lacks {want!r}")
        done = http("/save", "ssid=&other=&pass=&srv=own&addr=ws%3A%2F%2F10.0.2.2%3A9")
        if "restarts on its network cable" not in done:
            raise SystemExit("FAIL: saving a server with no Wi-Fi was refused:\n" + done[:400])
        p.wait(r"PROV SAVED ssid=\(none: cable\) server=ws://10\.0\.2\.2:9 \(restarting\)")
        p.wait(r"saved Wi-Fi: \(none\)", 60)
        p.wait(r"NET uplink wired", 30)
        p.absent(r"PROV open", 8)

        # --- C. no Wi-Fi, no cable at power-on: setup opens; the cable closes it ----------------
        p.monitor("set_link cable off")
        p.send("reboot")
        p.wait(r"saved Wi-Fi: \(none\)", 60)
        p.wait(r"NET settled: waiting for a cable", 20)
        p.wait(r"PROV open \(no Wi-Fi saved, no cable\)", 10)
        p.monitor("set_link cable on")
        p.wait(r"NET uplink wired", 15)
        p.wait(r"PROV close \(online over the cable\)", 5)
    finally:
        p.stop()
    print("\nQEMU CABLE PASS")
    return 0


if __name__ == "__main__":
    sys.exit(main())
