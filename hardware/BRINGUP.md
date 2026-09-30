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
3. `idf.py -p <port> flash monitor`. If the port doesn't appear: hold BOOT, press RESET, release.
4. The boot log shows `Open Lounge Phone firmware`, `fingerprint: …`, the display draws.

## 1. Keys, hook, jack, ringer, LED

1. Press each key: the log prints `KEY 1` … `KEY 0`, `KEY MENU`, `KEY BACK` once per press.
2. Lift/replace the handset: `HOOK up` / `HOOK down`. Plug/unplug the handset: `JACK in` / `JACK out`.
3. `status` shows the state; call the phone from the app to hear the piezo and see the LED ring.

## 2. Codec on I2C

1. The boot log must show `ES8311 (id 8311) ready: 8 kHz, mic PGA 18 dB` and
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
2. Speak normally into the handset: `audio` shows `miclevel=` about -30 to -20 dBFS; silence
   below -55 dBFS. If speech is below -35 dBFS raise `CONFIG_OLP_MIC_PGA_DB` (3 dB steps); if it
   clips (near 0 dBFS) lower it.
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
5. **Echo with the handset:** talk from the companion with the phone's handset lying on a table
   and then held normally. The companion should not hear itself back. The browser's echo
   canceller only handles echo it can model; receiver-to-mic acoustic or electrical coupling in the
   handset shows up here. If there is echo, note the level (`miclevel` while only the companion
   talks) and report it: the fix is AEC on the phone with the earpiece stream as the reference
   (not in this firmware yet), or a lower earpiece volume.
6. `rtc` shows the selected ICE servers; `ice tcp` then a new call forces TURN over TCP/TLS (for
   networks that block UDP): the call must still connect.
7. Hang up with the hook: `call media off (mic off)` in the log; the companion shows the call
   ended.

## 6. What to record

Board serial / date, 3V3, idle current, the ES8311 id, the SPL at volume 10, the chosen cap,
`miclevel` for speech and for silence, the PGA gain used, call setup time (`RTC CONNECTED … ms`),
underruns per minute, and whether echo was heard.
