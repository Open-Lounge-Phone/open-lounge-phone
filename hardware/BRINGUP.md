# Bring-up: the first real board

What the simulator could not check, in the order to check it on a newly assembled minimal board
(`DESIGN.md`). Every step uses the firmware's serial console (`olp>` on the USB-C port, see
`firmware/README.md`). Write the results into `firmware/TESTLOG.md` (step, PASS/FAIL, numbers).

Tools: a USB-C cable and a computer with ESP-IDF v5.5, a wired handset with a 3.5 mm TRRS (CTIA)
plug, a multimeter; nice to have: a phone with a sound-level-meter app, a second handset or
headset.

## 0. Power and flashing

1. Before the module is powered: no short between 3V3 and GND (> 1 kΩ).
2. Plug USB-C: 3V3 = 3.25-3.35 V at the LDO output. Current with the firmware idle: < 150 mA.
3. `idf.py -p <port> flash monitor`. If the port doesn't appear: hold BOOT, press RESET, release
   (hw v0.2: hold BOOT while plugging USB in instead, §8.2).
4. The boot log shows `Open Lounge Phone firmware`, `fingerprint: …`, the display draws.

## 1. Keys, hook, jack, ringer, LED

1. Press each key: the log prints `KEY 1` … `KEY 0`, `KEY MENU`, `KEY BACK` once per press.
2. Lift/replace the handset: `HOOK up` / `HOOK down`. Plug/unplug the handset: `JACK in` / `JACK out`.
3. `status` shows the state; call the phone from the app to hear the piezo and see the LED ring.
4. Walk through `docs/phone-ux.md`: each screen, the menu (MENU, a digit, BACK, MENU), the LED
   patterns (dim ready, pulse connecting, blink offline, fast flash ringing, on in a call) and
   the beeps. Anything that differs from the page is a bug: note it in `firmware/TESTLOG.md`.

## 2. Codec on I2C

1. The boot log must show `ES8311 (id 8311) ready: 16 kHz, mic PGA 30 dB, scale-up 6 dB` and
   `audio device: es8311`. If it says `ES8311 not found` or `audio device: test`: check SDA IO18 /
   SCL IO17, the 4.7 kΩ pull-ups, CE to GND (address 0x18) and the codec's 3V3.
2. `audio` prints `AUDIO device=es8311 …`.

## 3. Earpiece: tones and the volume cap

The earpiece plays only with the handset lifted; `audio tone` overrides that for bring-up.

1. `audio tone test` (1 kHz): a clean tone in the earpiece. `audio tone none` stops it.
2. `audio tone dialtone`, `ringback`, `busy`, `hold`: compare with a landline (350+440 Hz steady;
   440+480 Hz 2 s on / 4 s off; 480+620 Hz 0.5 s / 0.5 s; a short 440 Hz beep every 4 s).
3. **Level check (the cap):** `volume 10` (the maximum), `audio tone test`, the earpiece held to a
   sound-level meter (a phone app is fine, 1-2 cm from the earpiece): write down the dB SPL.
   The firmware cap is `CONFIG_OLP_EARPIECE_MAX_DB` = -6 dBFS by default (hardware owner question 8:
   full scale was estimated at ≈ 98 dB SPL with the assumed receiver). If volume 10 is
   uncomfortably loud, lower the cap in `idf.py menuconfig` → Open Lounge Phone → Call audio and
   note the value; each volume step is 3 dB (`volume 0`…`volume 10`, also MENU → 1).
4. Unplug the handset while a tone plays: no crackle or pop worse than a click.
5. Hang up (`HOOK down`) with `audio tone` off: the earpiece is silent (DAC muted).

## 4. Microphone: levels

1. `audio loop 300`: the mic plays back in the earpiece 300 ms later (an echo test; the delay
   keeps it from howling). The mic is on only while the loopback runs.
2. Speak normally into the handset: `audio` shows `miclevel=` (at the ADC, before the AGC)
   about -30 to -20 dBFS and `speech=` (after the AGC) near -24; silence below -55 dBFS. The
   phone check shows it without a console: MENU 7 with the handset up switches the mic on and
   its `MIC` row reads `SPEAK NOW: -24 DB OK` every second. **This sets the analog gain
   default** (PGA 30 dB + 6 dB scale-up, a first board read speech peaks around -38 dBFS at PGA
   18 dB): with each handset, a normal voice must read `OK` (not `WEAK`) and shouting must not
   read `TOO LOUD` (`micpeak=` in `audio` stays below -1 dBFS). If not, try other gains live with
   `audio gain <pga 0-30 dB> [scale-up 0-42 dB]` (for example `audio gain 30 0`, `audio gain 30
   12`) and put the one that works for all handsets in `CONFIG_OLP_MIC_PGA_DB` /
   `CONFIG_OLP_MIC_SCALE_DB` (`audio gain` isn't saved). `audio agc off` compares without the
   AGC.
3. You hear yourself 0.3 s later, clearly, with no hum or buzz. A 50/60 Hz hum points at the mic
   bias filter (1 kΩ / 10 µF) or a ground loop through the USB supply.
4. Tap the handset's button (if it has one): note whether the log shows a level spike (the board
   doesn't wire the button; `DESIGN.md` §7).
5. `audio loop off`. `audio` must now show the mic off (`call=0`, no `miclevel` updates): the mic is
   captured only in a call or in this test.

## 5. A real call

1. Pair the phone (README "Pairing a phone"), put the companion on the allow-list.
2. Lift, press the key for the companion: ringback in the earpiece; the companion rings.
3. Answer in the companion: the log shows `RTC CONNECTED: ICE + DTLS-SRTP up in … ms` and every
   5 s `AUDIO tx=… rx=… under=…`. `tx` and `rx` grow by ~250 per 5 s; `under` (underruns) stays
   small (a few per minute at most).
4. Talk both ways. The companion hears the handset clearly; the handset hears the companion at a
   comfortable level at the default volume (6/10).
5. **Codec and timing:** the `AUDIO` line says `codec=opus/opus` with the companion, `dry=0`
   (the earpiece never ran dry with the 1 ms DMA blocks), `conceal=` small, and the CPU per
   20 ms frame: `enc=` (Opus encode), `dec=` and `aec=` (average/worst µs; together well under
   20000). Note them. A listening test against firmware 0.9.5 (PCMU): s, f and th should be
   clearer.
6. **Sidetone:** in a call you hear yourself faintly, right away (no echo-like delay); MENU 1 6
   cycles off / low / normal. Note which sounds right. Mute (MENU 3): the sidetone stops.
7. **Echo with the handset:** with the handset held normally, MENU 7 then 2 (the echo test):
   note the `ECHO` row (`38 DB OK, 4 MS`) for each reference handset, and at volumes 6 and 10.
   The `MS` is the sidetone's delay too: it must be under 5. Then talk from the companion with
   the handset on a table and held normally: the companion should not hear itself back; note
   `erl=` / `erlbest=` in the `AUDIO` line. Repeat with MENU 1 7 `ECHO CANCEL ON` (next call):
   `erle=` shows what it removed; the companion's echo should be gone and the phone user's voice
   unchanged when both talk at once. These numbers decide whether the canceller is on by
   default (`CONFIG_OLP_ECHO_CANCEL`).
8. `rtc` shows the selected ICE servers; `ice tcp` then a new call forces TURN over TCP/TLS (for
   networks that block UDP): the call must still connect.
9. Hang up with the hook: `call media off (mic off)` in the log; the companion shows the call
   ended.

## 6. Wi-Fi setup network

1. `wifi forget`, `reboot`: the display shows `WI-FI SETUP: JOIN`, `OPENLOUNGEPHONE-XXXX`,
   `PASSWORD dddddddd`, `OPEN 192.168.4.1`; the log shows `PROV AP UP`.
2. From an iPhone and an Android phone: join the network with the displayed password. The OS
   should open the setup page by itself (captive portal); if not, open http://192.168.4.1/.
   Note which OS did what.
3. The page lists nearby networks. Try a wrong-length password (refused on the page), then the
   right one: "Saved", the phone restarts, joins, and pairs as usual.
4. Hold MENU+BACK while plugging in USB: `KEEP HOLDING` → after 3 s `RELEASE: WI-FI` (release:
   setup opens) → after 10 s `FACTORY RESET` (release: Wi-Fi, owner and keys erased; it asks for
   Wi-Fi setup again).
5. Turn the home router off for 3+ minutes: the setup network opens; turn it back on: it closes
   and the phone reconnects.

## 7. Release firmware on a board (encrypted storage, signed updates)

Only on a board meant to stay a phone: a release build burns an eFuse key on its first boot,
**one-time and irreversible** (firmware/README.md "Encrypted storage").

1. `idf.py -B build-release … flash` of a release build (`tools/release.sh build`), or an update to one.
2. First boot: `FIRST ENCRYPTED BOOT: burning a new NVS HMAC key into eFuse KEY5`, then
   `STORAGE encrypted (… new)`. `espefuse.py summary` shows KEY5 with purpose `HMAC_UP` and
   read-protected.
3. Set up Wi-Fi and pair; restart: `STORAGE encrypted (… existing)`, same four words, signs in.
4. `esptool.py read_flash 0x9000 0x6000 nvs.bin`: the Wi-Fi name and password don't appear in it.
5. Remove the phone in the app: `WIPE: NVS partition erased`, a new pairing code, Wi-Fi kept.

## 8. hw v0.2 only: wired network and PoE

The v0.2 board adds an RJ45 (J4) with PoE magnetics, a W5500 (U4) on the display's SPI bus and
an isolated 802.3af PoE module (PS1), diode-OR'd with USB into the 5 V rail V5 (`DESIGN.md` §12a).
Flash the **v0.2 build** (`firmware/README.md` "Building for each board": `sdkconfig.v02`,
board id `minimal-v02`); the rev A build never touches the W5500. How the firmware drives it
and chooses between the cable and Wi-Fi: `firmware/README.md` "Wired network". Until the
firmware runs, the PHY idles at ~65 mA in auto-negotiation (USB peak 526 mA vs 500 in the
budget: fine on any real charger, but note it); the firmware powers it down while on Wi-Fi.

**Power for these tests** (hardware/README.md "Power"): a v0.2 phone runs from PoE or a real
USB-C charger. The debug setup is **PoE plus a computer's USB for the console**: the PoE cable
carries the load, the computer port only flashes and reads the console. Don't run the network
tests from a computer port alone: with the PHY and Wi-Fi on together the board draws more than its
500 mA. Steps 1-2 (straps, download mode) are fine on a computer port alone (no network yet).

1. **Straps, before anything else.** USB only, no Ethernet cable. Measure GPIO45 (U4 pin 34,
   ETH_MISO) and GPIO0 (U4 pin 32, ETH_CS) at power-up and while RESET is held: GPIO45 < 0.4 V,
   GPIO0 > 3.0 V. The boot log must show the flash and PSRAM as before (a 1.8 V VDD_SPI shows up
   as a flash ID failure).
2. **Download mode with BOOT.** Hold BOOT and plug USB in (a power-up, so the W5500 is still in
   reset when the straps latch): the port appears in download mode, `esptool.py flash_id` reads the
   3.3 V flash. Holding BOOT and pressing only RESET is the one case where the W5500 is not reset;
   prefer a power cycle (or the USB-JTAG auto-download, which never uses GPIO0). A BOOT press while
   the phone runs can't select the W5500: the GPIO drives CS high against the 1 kΩ (3.3 mA).
3. **5 V OR.** USB only: V5 ≈ VBUS − 0.4 V. PoE only (a PoE switch or injector, USB unplugged):
   POE_5V ≈ 5.27 V at PS1, V5 ≈ 4.9 V, VBUS at an open receptacle may float a little through D3's leakage (harmless, no current). Both:
   V5 follows the higher source, nothing gets warm, the USB console still works.
4. **PoE classification.** On the switch: class 0, ~3 W drawn in a call. The module must not
   whine at idle (< 100 mA load): if it does, fit R28 (51 Ω 2512, not fitted by default).
5. **Isolation.** Unpowered, PS1 and J4 in place: > 10 MΩ from J4's PoE pins (7-10) and BR1/BR2
   to GND at 500 V DC if a megger is at hand; never connect the PoE side to the USB ground.
6. **The W5500 answers.** USB only, no cable, Wi-Fi saved. The boot log shows
   `ETH W5500 ready, mac xx:xx:…` (the chip's Ethernet MAC, the eFuse base + 3) and
   `ETH PHY on (looking for a link)`; `ETH: no W5500 answering` means SPI: check U4's supply (U5,
   3.3 V), its 25 MHz crystal, the CS (IO0) and MISO (IO45) lines with a scope during the first
   second. After ~5 s: `NET settled: Wi-Fi (no usable cable)`, `NET Wi-Fi radio on`,
   `ETH PHY off (power-down)`. Measure the 5 V current with the PHY off and during a look (every
   30 s, `ETH PHY on` for ~6 s): the difference is the PHY's (~65 mA expected).
7. **Link and DHCP.** Plug a cable from a switch with a DHCP server. Within 30 s (the next look):
   the RJ45's green LED (link) lights, yellow (activity) flickers, the log shows
   `ETH link up 100 Mbit/s full duplex`, `ETH got ip=…`, `NET uplink wired ip=…`,
   `NET Wi-Fi off …`, `NET Wi-Fi radio off`. `eth` prints
   `ETH controller=W5500 phy=on link=up 100M full ip=… mac=… uplink=wired cable="WIRED NETWORK"`;
   MENU 3 shows `WIRED NETWORK` / the address. Try a 10 Mbit/s port or a forced half-duplex port
   if there is one (`eth` shows what was negotiated). Pair or sign in and make a call over the
   cable both ways (the audio counters in `audio` grow, no underruns beyond the usual).
8. **Unplug and replug.** Pull the cable: `ETH link down`, `NET uplink none: CABLE UNPLUGGED`,
   the screen `OFFLINE` / `CABLE UNPLUGGED`, Wi-Fi joins within seconds (`NET uplink wifi`,
   `NET switched to Wi-Fi: reconnecting to the server`), back `READY`; the PHY powers down 6 s
   after the pull. Plug it back within those 6 s: straight back on the cable. Later: back on the
   cable at the next look (≤ 30 s), Wi-Fi off. A call on Wi-Fi while the cable comes back stays
   on Wi-Fi (MENU 3: `CABLE AFTER CALL`) and moves when it ends; pulling the cable during a call
   ends the call (expected) and the phone comes back on Wi-Fi.
9. **Cable only.** `wifi forget`, `reboot` with the cable in: no setup network opens
   (`PROV open` never appears), the phone comes online on the cable. Pull it: `CABLE UNPLUGGED`,
   the PHY stays on (no `ETH PHY off`), replug: online again within a few seconds. MENU 3 → 1:
   the setup page says the cable is connected and Wi-Fi is optional, and saves a server alone.
   A switch port with no DHCP server: `NO DHCP ON CABLE` after 15 s.
10. **PoE only.** Unplug USB: the phone keeps running from the cable alone (no reset, no
    reconnect: the diode-OR hands over). Power it up from PoE alone too (a PoE switch or an
    802.3af/at injector; a passive 24 V injector must not power it): it boots, gets its address
    on the cable and makes a call. The console is gone (no USB), so watch the screen and the
    switch's per-port power reading. Power-cycle it a few times from the switch. **Minimum
    load:** the PoE module needs at least 100 mA at 5 V or it whines and the switch may drop it
    (DESIGN.md §12a); measure the 5 V current at the module's output (a USB power meter can't
    see it: use a series shunt on POE_5V, or the switch's reading ÷ ~48 V × efficiency) idle and
    in a call in every network mode: on the cable; on Wi-Fi with the PHY powered down (unplug
    the data side, e.g. a PoE injector whose LAN port is disconnected, so the phone falls back
    to Wi-Fi while still powered: the lowest draw, the one to watch); and during a cable check.
    Every mode must stay above 100 mA with margin; if Wi-Fi with the PHY down comes close, fit
    R28 (51 Ω 2512, ~100 mA) and record it.
11. **Display + Ethernet.** A full e-paper refresh while a call streams over Ethernet (MENU 0
    About, MENU 7 Phone check): no audio underruns beyond the usual (`audio`), the picture is
    clean (the two share SCLK/MOSI), no `PHYCFGR write … failed` or SPI errors in the log.
12. **BOOT while running.** Press BOOT with the phone on the cable: nothing happens to the network
    (CS stays high through the 1 kΩ).

## 9. What to record

Board serial / date, 3V3, idle current, the ES8311 id, the SPL at volume 10, the chosen cap,
`miclevel` for speech and for silence, the PGA gain and scale-up used, the phone check's `MIC`
word per handset, call setup time (`RTC CONNECTED … ms`), underruns per minute, `dry=`, the
`enc=` / `dec=` / `aec=` times, the echo test per handset (loss and delay), `erl=` in calls,
whether echo was heard with the canceller off and on, the sidetone level chosen, and how each phone OS handled the setup page. On
hw v0.2: the `eth` line, the 5 V current with the PHY off and on, how long a plugged cable took
to be used, the switch's PoE class and power, and any audio underruns during an e-paper refresh.
