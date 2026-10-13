# Open Lounge Phone labs firmware (0.0.0)

The phone firmware plus six experiments, built as its own project so `firmware/` (the phone,
0.9.x) stays as it is. It compiles the same phone sources (`../main`) and adds `main/labs*.c`.

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
| House intercom | `intercom` key: lift, press, the other room rings; `all` rings every room, first to lift answers. Talk in G.711 straight phone to phone | The same Wi-Fi. No server, no internet |
| Doorbell / front desk | `doorbell` key (or mode `doorbell`: any key rings). The house phones ring with the door's name; whoever lifts talks to whoever lifts the door phone's handset | Same Wi-Fi |
| Dinner's ready | `chime` key: every phone beeps and shows the words | Same Wi-Fi |
| Daily check-in | mode `checkin`: key 1 (or a `checkin` key) is I'm OK. Not pressed by the time set: the server puts an alert in every guardian's voicemail inbox ("Grandma didn't check in by 10:00."), their own phones show it missed. Reminders (08:30 PILLS) show from their time until a key is pressed | The phone's server (l1, the hub or your own: `checkin.missed`) |
| Home panel | `ha` key: calls a Home Assistant service (`scene.turn_on` + `scene.night`); mode `home` shows a status entity ("GARAGE: OPEN", every minute) | Home Assistant + a long-lived token |
| Dial-a-story | `story` key: plays an 8 kHz 16-bit mono WAV from a URL in the handset (press, then lift: it waits 15 s). 1 again, 2 next, BACK stop | A web server with the files (`ffmpeg -i in.mp3 -ar 8000 -ac 1 -sample_fmt s16 out.wav`) |
| Macro pad | mode `macro`: the phone is a USB keyboard; `macro` keys send `ctrl+shift+m`, `f13`, `cmd+space`, `mute`, `play`, `volup` | A computer on the USB-C port. In this mode TinyUSB has the port: no USB console, and flashing may need BOOT held |

## Settings

MENU → 5 LABS shows the phone's address (`OLP-KITCHEN.LOCAL`) and a PIN. Open
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

UDP broadcast on port 47100, one line per message, `OLP1|TYPE|…`: `HELLO|room` every 20 s,
`RING|id|to|from|call|door` (`to` = a room or `*`), `ANSWER|id|from`, `BUSY|id|from`,
`BYE|id|from`, `CHIME|from|text`. Audio: UDP 47101 straight to the other phone, a 4-byte sequence
number and 160 bytes of G.711 µ-law (20 ms). It is meant for a home network: anyone on the Wi-Fi
can ring a room, and the audio isn't encrypted (calls through the server are).

## Status

Host-tested: settings, the intercom state machine (room to room, all rooms, busy, doorbell,
chime), the check-in schedule and the key combos (`make -C firmware/test/host`); the server's
check-in alert (`voicemail.test.ts`). Builds for the board. **Not yet run on the board**: the
intercom between two boards, Home Assistant, the USB keyboard and stories need real hardware.
