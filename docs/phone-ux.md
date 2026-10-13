# Phone UX (minimal board)

The one source of truth for how the hardware phone looks, sounds and responds. The firmware
(`firmware/main/`: `strip.c`, `menu.c`, `signals.c`, `main.c`) and the browser phone
(`apps/device-web/src/`: `strip.ts`, `menu.ts`, `leds.ts`) follow this page; when they differ,
this page wins and the code is the bug.

**The hardware** (`hardware/DESIGN.md`): 12 keys `1 2 3 4 5 MENU` / `6 7 8 9 0 BACK`, a hook
switch under the cradle, a 2.9" e-paper screen (296 × 128, black on white; the 2.13" option is
250 × 122), one red status LED, a piezo ringer (beeps only, no speech) and the handset's
earpiece and mic on the 3.5 mm jack. No speaker, no per-key lights, no battery.

## Screen

- **Text**, upper case, a 5 × 7 pixel font scaled up, each line centred. Three screens are drawn
  as pictures: the boot logo, the setup QR code and About.
- **Status screens: 1 or 2 lines of at most 16 characters**, at 3× (18 px per character,
  288 px wide). This is the protocol's strip: the server never sends more.
- **Menus and setup: 3 or 4 lines of at most 20 characters**, at 2× (12 px per character).
  20 keeps every screen readable on the 2.13" (250 px wide).
- **What's on screen is what to do next.** A second line names the action (`LIFT TO ANSWER`,
  `PRESS A KEY`, `PRESS MENU 4`); digits in menus are the key to press (`1 VOLUME`).
- **Refresh:** fast partial refresh on every change, a full refresh every 20 changes to clear
  e-paper ghosting. The screen keeps its last image without power.
- The key labels (who is on which key) live on the keycaps: paper labels under the clear caps,
  printed from the app (Manage phone → Print key labels).

## Screens by state

Highest priority first: the first row that applies is shown.

| State | Screen |
|---|---|
| Power-on | the mark (handset over the 2 × 6 keypad) and `OPEN LOUNGE PHONE`, firmware version small, for 2.5 s |
| Holding MENU+BACK at power-on | `KEEP HOLDING` / `FOR WI-FI SETUP`, then `KEEP HOLDING` / `TO RESET` (3 s and 10 s) |
| Updating | `CHECKING UPDATE` / `PLEASE WAIT`, `UPDATING 42%` / `DON'T UNPLUG`, `UPDATED` |
| Menu open | the menu screen (below) |
| Setup network open (no call) | a QR code that joins the setup network (scan it with a phone camera; the setup page opens), beside `SCAN TO SET UP` and the same in words: `OR JOIN` / network name / `PW xxxxxxxx` / `OPEN 192.168.4.1` |
| Server too old or phone too old | `SERVER TOO OLD` or `UPDATE NEEDED` / what to do |
| No server chosen | `SET UP:` / `CHOOSE A SERVER` / `PRESS MENU 4` |
| Pairing | `PAIR 123 456` / `ENTER IN APP` |
| No Wi-Fi saved | `NO WI-FI` / `PRESS MENU 3` |
| Offline | `OFFLINE` / `RECONNECTING`, or why Wi-Fi won't join: `WRONG PASSWORD?`, `WEAK WI-FI` (the router didn't answer: antenna or distance), `NETWORK NOT SEEN` (5 GHz only or out of range), `SECURITY NOT OK`, `CAN'T JOIN WI-FI` |
| Connecting | `CONNECTING` |
| Calling | `CALLING MOM` (or `CALLING` / long name) |
| Ringing | `GRANDMA CALLING` / `LIFT TO ANSWER` |
| In a call | `IN CALL 01:23` / name; recorded: `REC 01:23` / name; while connecting `CONNECTING` / name |
| They put you on hold | `ON HOLD` / name |
| In a room | the room's name / `3 IN ROOM` (`MUTED`, `REC` when they apply); `STILL THERE?` / `PRESS ANY KEY` before an idle room drops you. The phone shows `IN ROOM` / `MUTED` until rooms get audio on the phone (planned) |
| Handset up, nothing dialled | `PRESS A KEY`; after a call that didn't go through: `BUSY`, `NO ANSWER`, `DECLINED`, `UNAVAILABLE`, `NOT ALLOWED` or `CALL FAILED` / `PRESS A KEY` |
| Not answered, voicemail offered | `NO ANSWER` / `HANG UP` (leaving a message from the phone is planned) |
| Ready, missed calls | `MISSED MOM` / `ASK A GROWN-UP` (kids), or `3 MISSED CALLS` / each name in turn (3 s) |
| Ready, quiet hours | `QUIET TIL 07:00` (or `QUIET HOURS`) / the owner line |
| Ready | `READY` / the owner line: `KIDS: SMITHS`, `LOUNGE: STUDIO`, `ANA'S PHONE` |

## Keys by state

Digits 1-9 and 0 are the speed-dial keys (protocol button 0-8 and 9). MENU and BACK never
leave the phone.

| State | Digits | MENU | BACK | Hook |
|---|---|---|---|---|
| Ready (handset down) | nothing (a click) | open the menu | nothing | lift: dial tone |
| Handset up | call that key's person | open the menu | nothing | down: back to ready |
| Calling | nothing | open the menu | nothing | down: cancel |
| Ringing | nothing | open the menu | nothing | lift: answer |
| In a call | nothing | open the menu (volume; hold, merge and transfer are planned) | nothing | down: hang up |
| In a room | any key: "still here" | open the menu (mute is planned) | nothing | down: leave |
| Menu open | the option shown | close the menu | one level up (closes at the top) | as in the state underneath |
| Power-on with MENU+BACK held | | | | 3 s: setup network, 10 s: factory reset |

The menu closes by itself after 20 s without a key.

### Menu

| Key | Item | On the phone |
|---|---|---|
| 1 | Volume: 1 quieter, 2 louder (0-10, 3 dB steps, capped) | yes |
| 2 | Voicemail: how many new messages (`PLAY IN APP`); greetings are planned | yes |
| 3 | Wi-Fi: network, signal, address; 1 opens the setup network | yes |
| 4 | Server: which one; 1 opens the setup network to change it | yes |
| 5 | Lounge: open to chat on / off | planned |
| 6 | Dial an extension (team and organization spaces) | planned |
| 8 | Lounge: log out | planned |
| 9 | Update now (official firmware with updates on) | yes |
| 0 | About: a page with the firmware, board and server, and the public key part (the four fingerprint words, `WORD-WORD-WORD-WORD`) that the app shows for the same phone | yes |

Root screen: `MENU` / `1 VOLUME 2 VOICEMAIL` / `3 WI-FI 4 SERVER` / `9 UPDATE 0 ABOUT` (items
that don't apply are left out).

## Status LED (red)

| Pattern | Means |
|---|---|
| Off | no power, or starting up |
| Dim (8 %) | ready |
| Slow breathe (4 s) | ready, with missed calls or new voicemail |
| Pulse (1 s) | pairing, or connecting to the server |
| Short blink every 2 s | offline: no Wi-Fi or no server |
| Fast flash (4 per second) | ringing |
| On | calling, in a call or in a room |
| Double flash every second | this call or room is being recorded (it is also the recording light) |

## Sounds

**Piezo** (4 kHz, in the base):

| Sound | Pattern |
|---|---|
| Ring | 1 s warble, 2 s silence, repeating while it rings |
| Key click | 30 ms (every key press) |
| Pairing code shown | 3 × 120 ms |
| Paired / done | 2 × 60 ms |
| Error | 400 ms |

**Earpiece** (only with the handset up):

| Tone | When |
|---|---|
| Dial tone, 350 + 440 Hz steady | handset up, nothing dialled |
| Ringback, 440 + 480 Hz, 2 s on / 4 s off | calling |
| Busy, 480 + 620 Hz, 0.5 s on / 0.5 s off | the call didn't go through |
| Hold beep | they put you on hold |

Spoken prompts (the pairing code, "This call is recorded.", menu read-outs, voicemail greetings)
are planned as recorded clips; until then the phone uses the screen and these tones. The
browser phone speaks them already.
