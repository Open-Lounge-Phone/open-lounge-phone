#!/usr/bin/env python3
"""Boot smoke test in QEMU (CI and local): fresh flash, boot, network up, console answers.

    firmware/tools/qemu.sh build && python3 firmware/tools/qemu_smoke.py

Checks the boot banner, the test audio device, the DTLS certificate (esp_peer), an IP on QEMU's
Ethernet, and that `status`, `audio`, `rtc` and `volume` answer on the console. It doesn't need a
server: build with OLP_SIM_SERVER=ws://127.0.0.1:9 so nothing on the internet is contacted.
"""
import os
import re
import subprocess
import sys
import time

FW = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
QEMU_SH = os.path.join(FW, "tools", "qemu.sh")


def main() -> int:
    timeout = float(os.environ.get("QEMU_SMOKE_TIMEOUT", "120"))
    subprocess.run([QEMU_SH, "fresh"], check=True, cwd=FW)
    proc = subprocess.Popen([QEMU_SH, "resume"], cwd=FW, stdin=subprocess.PIPE,
                            stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    os.set_blocking(proc.stdout.fileno(), False)
    log = ""  # everything printed
    cursor = 0  # command replies are looked for after this point
    end = time.time() + timeout

    def wait(pattern: str, anywhere: bool = False) -> re.Match:
        """Boot facts may come in any order (anywhere=True); replies come after the command."""
        nonlocal log, cursor
        rx = re.compile(pattern)
        while time.time() < end:
            chunk = proc.stdout.read()
            if chunk:
                text = chunk.decode("utf-8", "replace")
                sys.stdout.write(text)
                log += text
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
        wait(r"olp> ", True)
        cursor = len(log)
        send("status")
        wait(r"STATUS state=idle conn=\w+ authed=0")
        send("audio")
        wait(r"AUDIO device=test call=0 volume=6/10")
        send("volume 4")
        wait(r"volume 4/10")
        send("rtc")
        wait(r"RTC call=- state=")
        print("\nQEMU SMOKE PASS")
        return 0
    finally:
        proc.kill()
        proc.wait()


if __name__ == "__main__":
    sys.exit(main())
