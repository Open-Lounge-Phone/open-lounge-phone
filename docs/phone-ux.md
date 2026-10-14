# Phone UX (minimal board)

The one source of truth for how the hardware phone looks, sounds and responds. The firmware
(`firmware/main/`: `strip.c`, `menu.c`, `signals.c`, `main.c`) and the browser phone
(`apps/device-web/src/`: `strip.ts`, `menu.ts`, `leds.ts`) follow this page; when they differ,
this page wins and the code is the bug.

**The hardware** (`hardware/DESIGN.md`): 12 keys `1 2 3 4 5 MENU` / `6 7 8 9 0 BACK`, a hook
switch under the cradle, a 2.13" e-paper screen (250 × 122, black on white; the 2.9" option is
296 × 128), one red status LED, a piezo ringer (beeps only, no speech) and the handset's
earpiece and mic on the 3.5 mm jack. No speaker, no per-key lights, no battery.

## Screen

- **Text**, upper case, a 5 × 7 pixel font scaled up, each line centred. Some screens are drawn
  as pictures: the boot logo, the setup QR code, About, the key map (handset up), the phone check
  and the self-test.
- **Status screens: 1 or 2 lines of at most 16 characters**, at 3× (18 px per character,
  288 px wide). This is the protocol's strip: the server never sends more.
- **Longer text scrolls** instead of being cut off: a long name (a caller, a key's person, the
  owner line, a Wi-Fi network) holds at its start for 2 s, then moves one character every 0.6 s
  through to the end and round again.
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
| Self-test running | the keypad drawn as 2 × 6 boxes plus HOOK and JACK; each fills in when pressed or moved; `ALL GOOD` at the end |
| Menu open | the menu screen (below) |
| Setup network open (no call) | a QR code that joins the setup network (scan it with a phone camera; the setup page opens), beside `SCAN TO SET UP` and the same in words: `OR JOIN` / network name / `PW xxxxxxxx` / `OPEN 192.168.4.1` |
| Server too old or phone too old | `SERVER TOO OLD` or `UPDATE NEEDED` / what to do |
| No server chosen | `SET UP:` / `CHOOSE A SERVER` / `PRESS MENU 4` |
| Pairing | `PAIR 123 456` / `ENTER IN APP` |
| No Wi-Fi saved | `NO WI-FI` / `PRESS MENU 3` |
| Offline | `OFFLINE` / `RECONNECTING`, or why Wi-Fi won't join: `WRONG PASSWORD?`, `WEAK WI-FI` (the router didn't answer: antenna or distance), `NETWORK NOT SEEN` (5 GHz only or out of range), `SECURITY NOT OK`, `CAN'T JOIN WI-FI` |
| Connecting | `CONNECTING` |
| Calling | `CALLING MOM` (or `CALLING` / long name) |
| Waiting in a public line's queue | `IN LINE 2` / `1 VOICEMAIL` (with a call back too: `1 VM 2 CALL BACK`; only a call back: `2 CALL ME BACK`; neither: the line's name; `WAITING IN LINE` when it shows no places) |
| Asked a public line to call back | `PLACE KEPT` / `WE'LL CALL BACK` (with the handset up, as the key map's footer) |
| A public line calling you back | the line's name / `CALLS YOU BACK` (lift to answer: the call to the line goes on, `CALLING` or `IN LINE 1`) |
| You put the call on hold | `ON HOLD` / name (`MENU 1 RESUMES`) |
| Choosing who to transfer to | `TRANSFER TO?` / `PRESS A KEY` |
| Ringing | `GRANDMA CALLING` / `LIFT TO ANSWER` |
| In a call | `IN CALL 01:23` / name; recorded: `REC 01:23` / name; while connecting `CONNECTING` / name |
| They put you on hold | `ON HOLD` / name |
| In a room | the room's name / `3 IN ROOM` (`MUTED`, `REC` when they apply); `STILL THERE?` / `PRESS ANY KEY` before an idle room drops you. The phone shows `IN ROOM` / `MUTED` until rooms get audio on the phone (planned) |
| Handset up, nothing dialled | the **key map**, drawn as a page: whose phone it is in the title bar (`KIDS: SMITHS`, `ANA'S PHONE`, `LOUNGE: STUDIO`; `SPEED DIAL` before the server says), then who is on each digit key in two columns like the key rows (1-5 left, 6-0 right; a filled keycap = someone is on it, `-` = nobody), and at the bottom `PRESS A KEY TO CALL`, or after a call that didn't go through `BUSY`, `NO ANSWER`, `DECLINED`, `UNAVAILABLE`, `NOT ALLOWED` or `CALL FAILED` `- PRESS A KEY` |
| Not answered, voicemail offered | `LEAVE A MESSAGE` / name, a beep, then `RECORDING 01:59` / `HANG UP TO SEND` (counting down to the limit, 2 minutes) |
| Just hung up after a message | `SENDING MESSAGE`, then `MESSAGE SENT` or `MESSAGE NOT SENT` (4 s) |
| Listening to voicemail | `MESSAGE 1 OF 3` / who / `00:04 OF 00:12` / `1 AGAIN 2 NEXT`; then `NO MORE MESSAGES` |
| Ready, a notice from the space | its one or two lines (`BUS IS HERE`), with a chime when it arrives (none during quiet hours); any key clears it, lifting the handset plays its recording ([notices.md](notices.md)) |
| Ready, missed calls | `MISSED MOM` / `ASK A GROWN-UP` (kids) or `PLAY IN APP`, or `3 MISSED CALLS` / each name in turn (3 s). Goes away once the messages are heard (played on the phone, `3 CLEAR`, or opened in the app) |
| Ready, quiet hours | `QUIET TIL 07:00` (or `QUIET HOURS`) / the owner line |
| Lounge phone | see "Lounge phone" below: the takeover code, `PRESS KEY 7`, `HI ANA` |
| Ready | `READY 14:05` (local time, once the server has sent its clock; `READY` before) / the owner line: `KIDS: SMITHS`, `LOUNGE: STUDIO`, `ANA'S PHONE` |

## Keys by state

Digits 1-9 and 0 are the speed-dial keys (protocol button 0-8 and 9). MENU and BACK never
leave the phone.

| State | Digits | MENU | BACK | Hook |
|---|---|---|---|---|
| Ready (handset down) | nothing (a click); with a notice showing: clear it | open the menu | with a notice showing: clear it | lift: dial tone (and a notice's recording) |
| Handset up | call that key's person | open the menu | nothing | down: back to ready |
| Calling | nothing | open the menu | nothing | down: cancel |
| Waiting in a public line's queue | 1: leave a voicemail instead; 2: call me back (each when offered) | open the menu | nothing | down: cancel |
| Ringing | nothing | open the menu | nothing | lift: answer |
| In a call | nothing (after MENU 2 Transfer: the key's person gets the call) | the call screen | nothing | down: hang up |
| Call on hold | nothing (one call has audio at a time) | the call screen (1 Resume) | nothing | down: hang up both |
| Leaving a message | nothing | nothing | nothing | down: send it (under 1.5 s: dropped) |
| In a room | any key: "still here" | the call screen (1 Mute / Unmute) | nothing | down: leave |
| Self-test | ticks that key off | ticks it off | ticks it off | ticks it off (and works as usual) |
| Menu open | the option shown | close the menu | one level up (closes at the top) | as in the state underneath |
| Power-on with MENU+BACK held | | | | 3 s: setup network, 10 s: factory reset |

The menu closes by itself after 20 s without a key.

### Menu

| Key | Item | On the phone |
|---|---|---|
| 1 | Volume: earpiece 1 quieter, 2 louder (0-10, 3 dB steps, capped); ringer 4 soft / medium / loud, 5 style classic / double / beeps (each press plays it) | yes |
| 2 | Voicemail: how many new messages. A person's own phone: `1 PLAY` (handset up) plays each unheard message in the earpiece, oldest first (1 again, 2 next, BACK stop; one played to the end is marked heard, everywhere), `3 CLEAR` marks them all heard; a message recorded before phones could play it says `PLAY IN APP`. A kids' phone: `ASK A GROWN-UP` (they listen in the app). Greetings from the phone are planned | yes |
| 3 | Network: the Wi-Fi network and signal, and the server; `1 CHANGE` opens the setup network (Wi-Fi and server). A kids' phone asks `PRESS 1 AGAIN` first; a Lounge phone doesn't offer it (`ADMIN: SEE GUIDE`: hold MENU+BACK at power-on) | yes |
| 4 | The same screen as 3 | yes |
| 5 | Lounge phone in use: open to chat on / off | yes |
| 6 | Dial an extension (team and organization spaces; shown when the space has extensions): `EXT 204_`, digits, BACK deletes, MENU dials (handset up) | yes |
| 7 | Phone check: a page with Wi-Fi (network, signal, channel), address, server (online, for how long), the last Wi-Fi problem, handset and jack, time running and clock, memory; 1 starts the self-test | yes |
| 8 | Lounge phone in use: log out (the phone forgets the person) | yes |
| 9 | Update now (official firmware with updates on) | yes |
| 0 | About: a page with the mark and `OPEN LOUNGE PHONE`, the firmware, board and server, the public key part (the four fingerprint words, `WORD-WORD-WORD-WORD`) that the app shows for the same phone, and `OPEN SOURCE  OPENLOUNGEPHONE.APP` along the bottom | yes |

Root screen: `MENU`, then the items that apply, packed into three lines that fit (20 characters
on the 2.13-inch): `1 VOLUME 2 VOICEMAIL` / `3 NETWORK 6 EXT` / `7 CHECK 0 ABOUT`; a Lounge
phone in use: `1 VOLUME 5 CHAT` / `8 LOG OUT 3 NETWORK` / `7 CHECK 0 ABOUT`. `9 UPDATE` comes
last and is left off when it doesn't fit (9 works either way).

### Lounge phone

A shared phone (set up as a Lounge phone in the app). Free: the takeover QR code with
`SCAN TO USE THIS PHONE`, a hint (`THIS PHONE`, `HERE: BEN` when someone is open to chat at
another Lounge phone, `OR PRESS A KEY` when the space gave free phones house-line keys) and the
space's name. Scanning asks for proof the person is at the phone: `PRESS KEY 7` / `TO START`
(the red LED flashes fast) until they press it. In use: `HI ANA` / `MENU = OPTIONS` (or
`OPEN TO CHAT`), their people on the keys. When the session ends (log out, the space's time limit,
someone else takes it over) the phone forgets them and shows `SIGNED OUT` / `SEE YOU` (or
`TIME'S UP`, `SOMEONE ELSE`) for 4 s, then the code again. Digit keys do nothing on a free phone
without house-line keys.

**Call screen** (MENU in a call or a room): `CALL` (or `ROOM`) / `1 HOLD` / `2 TRANSFER` /
`9 VOLUME`. On hold: `1 RESUME`. In a room: `1 MUTE` or `1 UNMUTE`. Transfer without a held call
is blind: the next key picks who gets it. The hardware phone has audio for one call at a time, so
holding doesn't add a second caller; adding a caller, merging and transferring to the held call
are in the app and the browser phone.

**Self-test** (MENU 7 then 1): press every key, lift and hang up the handset, plug the handset
in and out. The earpiece plays a 1 kHz tone meanwhile (lift the handset to hear it) and each key
clicks the piezo. It ends with a short double beep when every key and the hook are ticked (the
jack is optional), with a long beep after 30 s without input, or when a call rings.

## Status LED (red)

| Pattern | Means |
|---|---|
| Off | no power, or starting up |
| Dim (8 %) | ready |
| Slow breathe (4 s) | ready, with missed calls or new voicemail |
| Pulse (1 s) | pairing, or connecting to the server |
| Fast flash (4 per second) | ringing, or a Lounge phone waiting for its `PRESS KEY` proof |
| Short blink every 2 s | offline: no Wi-Fi or no server |
| On | calling, in a call or in a room |
| Double flash every second | this call or room is being recorded (it is also the recording light) |

## Sounds

**Piezo** (4 kHz, in the base):

| Sound | Pattern |
|---|---|
| Ring | every 3 s while it rings: classic = 1 s warble; double = two 0.4 s warbles; beeps = three 0.15 s beeps. Soft, medium or loud (MENU 1, 4 and 5) |
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
| Hold beep | they put you on hold, or a call you put on hold is waiting |
| Beep, 1 kHz, 0.6 s | start speaking: the message is recording |
| 1 kHz steady | the self-test |

Leaving a message: the phone records the handset mic as 8 kHz WAV and sends it when you hang up.
Recorded greetings aren't played on the hardware phone yet (the beep starts the message).
Spoken prompts (the pairing code, "This call is recorded.", "Please leave a message", menu
read-outs) are planned as recorded clips; until then the phone uses the screen and these tones.
The browser phone speaks them already.
