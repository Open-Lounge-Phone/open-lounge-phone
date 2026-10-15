# Open Lounge Phone labs firmware (0.0.0)

The phone firmware plus its experiments, built as its own project so `firmware/` (the phone,
0.9.x) stays as it is. It compiles the same phone sources (`../main`) and adds `main/labs*.c`.

**Moved into the phone firmware (0.9.4):** the **house intercom** (`intercom.c`, its sockets and
audio `lan.c`, now with every control line signed and the audio encrypted with the space's key,
`lan_crypto.c`), the **chime** (now a notice through the server: MENU 4 on a phone given a chime
in the app) and the **daily check-in** (its time is set in the app, Manage phone → Home features,
and the server watches it). Labs reuses them: its `intercom`, `all`, `doorbell` and `chime` keys
go through the phone's intercom, so they need it turned on for the phone in the app (and the
phone paired: the key comes from the server); the labs settings' `checkin.by` is no longer used,
and labs keeps the reminders. See [../README.md](../README.md) "House intercom" and
[docs/phone-ux.md](../../docs/phone-ux.md).

```sh
firmware/labs/labs.sh build            # into firmware/labs/build
firmware/labs/labs.sh flash            # build + flash the board on /dev/cu.usbmodem*
firmware/labs/labs.sh monitor
```

Go back to the phone firmware with `idf.py flash` in `firmware/`: settings in NVS are kept, the
labs settings too (namespace `labs`).

## What it adds

Each digit key can get an **action** (keys left as `phone` stay the server's speed dial), and the
phone has a **mode** that decides its idle screen.

| Idea | How | Needs |
|---|---|---|
| House intercom keys | `intercom` key: lift, press, the other room rings; `all` rings every room, first to lift answers (the phone's own intercom, 0.9.4) | The same Wi-Fi, the intercom on in the app |
| Doorbell / front desk | `doorbell` key (or mode `doorbell`: any key rings). The house phones ring with the door's name; whoever lifts talks to whoever lifts the door phone's handset | Same Wi-Fi |
| Dinner's ready (LAN) | `chime` key: every phone on the intercom beeps and shows the words (the phone's own chime, MENU 4, is a notice through the server) | The intercom on |
| Reminders | 08:30 PILLS show from their time until a key is pressed; a `checkin` key is I'm OK for the phone's daily check-in (set in the app) | Nothing |
| Home panel | `ha` key: calls a Home Assistant service (`scene.turn_on` + `scene.night`); mode `home` shows a status entity ("GARAGE: OPEN", every minute) | Home Assistant + a long-lived token |
| Dial-a-story | `story` key: plays an 8 kHz 16-bit mono WAV from a URL in the handset (press, then lift: it waits 15 s). 1 again, 2 next, BACK stop | A web server with the files (`ffmpeg -i in.mp3 -ar 8000 -ac 1 -sample_fmt s16 out.wav`) |
| Macro pad | mode `macro`: the phone is a USB keyboard; `macro` keys send `ctrl+shift+m`, `f13`, `cmd+space`, `mute`, `play`, `volup` | A computer on the USB-C port. In this mode TinyUSB has the port: no USB console, and flashing may need BOOT held |

## Settings

MENU → 4 LABS (or MENU → 3 → 2, when 4 is the phone's house intercom or chime) shows the phone's address (`OLP-KITCHEN.LOCAL`) and a PIN. Open
`http://olp-kitchen.local` on any device on the same Wi-Fi, enter the PIN (so only someone at the
phone can change it; 5 wrong tries lock it for a minute) and edit the room name, mode, keys, Home
Assistant, check-in and doorbell. The Home Assistant token is write-only: the page never shows it
again. Settings are the JSON in `main/labs_cfg.h`, for example:

```json
{"name": "Kitchen", "mode": "intercom",
 "keys": [{"key": "1", "action": "intercom", "target": "Kid's room"},
          {"key": "2", "action": "all", "label": "Everyone"},
          {"key": "3", "action": "chime", "target": "Dinner's ready"},
          {"key": "4", "action": "ha", "service": "scene.turn_on", "target": "scene.night", "label": "Lights off"},
          {"key": "5", "action": "story", "url": "http://nas.local/stories/bear.wav", "label": "Bear story"}],
 "ha": {"url": "http://homeassistant.local:8123", "token": "…", "status": "cover.garage_door", "status_label": "Garage"},
 "checkin": {"by": "10:00", "reminders": [{"at": "08:30", "text": "Pills"}]},
 "door_label": "Front door"}
```

## The intercom on the wire

The phone firmware's ([../README.md](../README.md) "House intercom"): UDP broadcast on port 47100,
`OLP1|TYPE|…` lines (`HELLO`, `RING`, `ANSWER`, `BUSY`, `BYE`, `CHIME`, `TAKEN`) each sealed as
`OLP2|time|nonce|line|HMAC`, and encrypted G.711 on UDP 47101. Labs 0.0.0 builds before it sent
the lines unsigned and the audio in the clear; phones now ignore those.

## Tests

- Host tests (`make -C firmware/test/host`): settings, the reminders, the macro pad's key combos
  (the intercom's are the phone firmware's now).
- The labs firmware in QEMU, end to end (opt-in, about 10 minutes, nothing leaves the machine):

  ```sh
  OLP_LABS_QEMU=1 npx vitest run tests/e2e/live/labs.test.ts
  ```

  It builds the QEMU image (`OLP_QEMU_LABS=1 firmware/tools/qemu.sh build`; `OLP_FW_NO_BUILD=1`
  reuses it), then runs **den**: one phone with a fake Home Assistant and a web server with a
  story on this machine. The console stands in for the keys and the hook, and QEMU's test audio
  device for the codec. Logs: `firmware/build-qemu-labs/e2e/`. The intercom and the check-in are
  tested with the phone firmware: `OLP_HOME_QEMU=1 npx vitest run tests/e2e/live/home.test.ts`.

## Status

Proven in QEMU (the tests above, real firmware):

- **Settings page**: the PIN (wrong PIN refused, five wrong tries lock it for a minute), saving,
  and the Home Assistant token never comes back (a blank one keeps it).
- **Home panel**: the status entity is read with the token every minute and shown; an `ha` key
  calls the service.
- **Dial-a-story**: downloads the WAV and plays it to the earpiece to the end; press then lift;
  1 again, 2 next, BACK stops.
- **Games**: MENU ten times; Snake moves, turns and ends at the wall; Memory's rounds grow and a
  wrong digit ends it with the score.

Host-tested only: the **macro pad** (QEMU has no USB device for the phone).

On the board it runs (its screens and the settings page). Still needs trying there: the intercom over real Wi-Fi between two boards (QEMU uses Ethernet),
how the audio sounds through the codec and handset (level, echo, delay), the piezo and ringer,
the `olp-<room>.local` name (mDNS; the tests use the address), the USB keyboard, and the games
on the e-paper.
