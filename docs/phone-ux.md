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
| Offline | `OFFLINE` / `RECONNECTING`, or why Wi-Fi won't join: `JOINING WI-FI` (a handshake failed; one at power-on is usually just timing), `WRONG PASSWORD?` (three failed handshakes in a row), `WI-FI DROPPED` (a working connection was lost), `WEAK WI-FI` (the router didn't answer: antenna or distance), `NETWORK NOT SEEN` (5 GHz only or out of range), `SECURITY NOT OK`, `CAN'T JOIN WI-FI` |
| Connecting | `CONNECTING` |
| Calling | `CALLING MOM` (or `CALLING` / long name) |
| Waiting in a public line's queue | `IN LINE 2` / `1 VOICEMAIL` (with a call back too: `1 VM 2 CALL BACK`; only a call back: `2 CALL ME BACK`; neither: the line's name; `WAITING IN LINE` when it shows no places) |
| Asked a public line to call back | `PLACE KEPT` / `WE'LL CALL BACK` (with the handset up, as the key map's footer) |
| A public line calling you back | the line's name / `CALLS YOU BACK` (lift to answer: the call to the line goes on, `CALLING` or `IN LINE 1`) |
| You put the call on hold | `ON HOLD` / name (`MENU 1 RESUMES`) |
| Choosing who to transfer to | `TRANSFER TO?` / `PRESS A KEY` |
| Ringing | `GRANDMA CALLING` / `LIFT TO ANSWER`, with `BACK: SILENCE` in turn on the second line (every 3 s). After BACK the ringer stops on this phone (the LED keeps flashing; the call still rings the person's other phones and apps, and goes to voicemail at the usual time): `GRANDMA CALLING` / `LIFT TO ANSWER` |
| In a call | `IN CALL 01:23` / name, with `MENU 3: MUTE` in turn on the second line (every 3 s); muted: `MUTED 01:23` / name, in turn with `MENU 3: UNMUTE`; recorded: `REC 01:23` (muted: `REC MUTED 01:23`) / name; while connecting `CONNECTING` / name. When the audio connection drops: after 2 s (the other side hanging up drops it too, a moment before the server says the call ended: that's a normal end) `RECONNECTING` / name while it is restored (the call's timer and status come back only once audio flows again); if it can't be restored within 20 s the call ends (`CONNECTION LOST`, below). On the browser phone, when packet loss or jitter make the audio poor: the second line says `POOR CONNECTION` until it's better (not on the hardware phone: its WebRTC library doesn't report it) |
| They put you on hold | `ON HOLD` / name |
| In a call, another call waiting | `WAITING: MOM` (a long name: `CALL WAITING` / the name, in turn with the keys) / `1 TAKE 2 IGNORE`, with the call-waiting beep in the earpiece (see "Call waiting") |
| In a room | the room's name / `3 IN ROOM` (`MUTED`, `REC` when they apply); `STILL THERE?` / `PRESS ANY KEY` before an idle room drops you; `CLOSING SOON` / the room's name a minute before a party line's hours end. When a party line with hours opens, a phone with its key shows `PARTY LINE OPEN` / its name with a chime (a notice): lift and press the key to join. The phone shows `IN ROOM` / `MUTED` until rooms get audio on the phone (planned) |
| Handset up, nothing dialled | the **key map**, drawn as a page: whose phone it is in the title bar (`KIDS: SMITHS`, `ANA'S PHONE`, `LOUNGE: STUDIO`; `SPEED DIAL` before the server says), then who is on each digit key in two columns like the key rows (1-5 left, 6-0 right; a filled keycap = someone is on it, `-` = nobody), and at the bottom `PRESS A KEY TO CALL`, or after a call that didn't go through `BUSY`, `NO ANSWER`, `DECLINED`, `UNAVAILABLE`, `NOT ALLOWED`, `CALL FAILED` or `CONNECTION LOST` (the call's audio connection dropped and couldn't be restored, on either side) `- PRESS A KEY` (a Lounge phone with nobody signed in that tried a public line: `SIGN IN TO CALL - PRESS A KEY`) |
| Not answered, voicemail offered | `LEAVE A MESSAGE` / name, a beep, then `RECORDING 01:59` / `HANG UP TO SEND` (counting down to the limit, 2 minutes) |
| Just hung up after a message | `SENDING MESSAGE`, then `MESSAGE SENT` or `MESSAGE NOT SENT` (4 s) |
| Listening to voicemail | `MESSAGE 1 OF 3` / who / `00:04 OF 00:12` / `1 AGAIN 2 NEXT`; then `NO MORE MESSAGES` |
| Ready, a notice from the space | its one or two lines (`BUS IS HERE`), with a chime when it arrives (none during quiet hours); any key clears it, lifting the handset plays its recording over and over until the handset goes down or a key clears the notice (that key doesn't dial) ([notices.md](notices.md)) |
| Ready, missed calls | one message: `MISSED MOM` / `ASK A GROWN-UP` (kids) or `PLAY IN APP`; one missed call: `MISSED MOM` / `MENU 5: MISSED`; several: `3 MISSED CALLS` / each name in turn (3 s). Messages go once heard (played on the phone, MENU 2 `3 CLEAR`, or opened in the app), missed calls once cleared (MENU 5 `3 CLEAR`, or in the app). A public line's call back that nobody took (a person's own phone): `MISSED CALL BACK` / the line's name, or among the names; it goes with MENU 5 `3 CLEAR`, by calling the line, or by taking its next call back |
| Ready, quiet hours | `QUIET TIL 07:00` (or `QUIET HOURS`) / the owner line |
| Lounge phone | see "Lounge phone" below: the takeover code, `PRESS KEY 7`, `HI ANA` |
| Ready | `READY 14:05` (local time, once the server has sent its clock; `READY` before) / the owner line: `KIDS: SMITHS`, `LOUNGE: STUDIO`, `ANA'S PHONE` |

## Keys by state

Digits 1-9 and 0 are the speed-dial keys (protocol button 0-8 and 9). MENU and BACK never
leave the phone.

| State | Digits | MENU | BACK | Hook |
|---|---|---|---|---|
| Ready (handset down) | nothing (a click); with a notice showing: clear it | open the menu | with a notice showing: clear it | lift: dial tone (and a notice's recording) |
| Handset up | call that key's person (while a notice's recording plays: stop it and clear the notice) | open the menu | nothing (while a notice's recording plays: stop it and clear the notice) | down: back to ready |
| Calling | nothing | open the menu | nothing | down: cancel |
| Waiting in a public line's queue | 1: leave a voicemail instead; 2: call me back (each when offered) | open the menu | nothing | down: cancel |
| Ringing | nothing | open the menu | silence the ringer on this phone | lift: answer |
| In a call | nothing (after MENU 2 Transfer: the key's person gets the call) | the call screen (1 Hold, 2 Transfer, 3 Mute / Unmute, 9 Volume) | nothing | down: hang up |
| In a call, another call waiting | 1: take it (this call goes on hold; on the hardware phone this call ends); 2: ignore it (it goes to voicemail at the usual time) | the call screen | nothing | down: hang up this call; the waiting one then rings like any call (lift to answer) |
| Call on hold | nothing (one call has audio at a time) | the call screen (1 Resume) | nothing | down: hang up both |
| Leaving a message | nothing | nothing | nothing | down: send it (under 1.5 s: dropped) |
| In a room | any key: "still here" | the call screen (3 Mute / Unmute, 9 Volume) | nothing | down: leave |
| Self-test | ticks that key off | ticks it off | ticks it off | ticks it off (and works as usual) |
| Menu open | the option shown | close the menu | one level up (closes at the top) | as in the state underneath |
| Power-on with MENU+BACK held | | | | 3 s: setup network, 10 s: factory reset |

The menu closes by itself after 20 s without a key.

### Menu

| Key | Item | On the phone |
|---|---|---|
| 1 | Volume: earpiece 1 quieter, 2 louder (0-10, 3 dB steps, capped); ringer 4 soft / medium / loud, 5 style classic / double / beeps (each press plays it) | yes |
| 2 | Voicemail: how many new messages. A person's own phone: `1 PLAY` (handset up) plays each unheard message in the earpiece, oldest first (1 again, 2 next, BACK stop; one played to the end is marked heard, everywhere), `3 CLEAR` marks them all heard (missed calls and call backs are on 5, not here); a message recorded before phones could play it says `PLAY IN APP`. A kids' phone: `ASK A GROWN-UP` (they listen in the app). `4 GREETING`: 1 record your name, 2 a whole greeting, 3 back to the standard one (the browser phone; planned on hardware) | yes |
| 3 | Network: the Wi-Fi network and signal, and the server; `1 CHANGE` opens the setup network (Wi-Fi and server). A kids' phone asks `PRESS 1 AGAIN` first; a Lounge phone doesn't offer it (`ADMIN: SEE GUIDE`: hold MENU+BACK at power-on) | yes |
| 4 | The same screen as 3 | yes |
| 5 | Missed calls (not on a Lounge phone; a Lounge phone in use: open to chat on / off): see "Missed calls" below | yes |
| 6 | Dial an extension (team and organization spaces; shown when the space has extensions): `EXT 204_`, digits, BACK deletes, MENU dials (handset up) | yes |
| 7 | Phone check: a page with Wi-Fi (network, signal, channel), address, server (online, for how long), the last Wi-Fi problem, handset and jack, the mic level, time running and clock, memory; 1 starts the self-test. With the handset up the page switches the handset's mic on and shows its live level (`MIC -38 DBFS PEAK -21`, every second; speak into it) until the page closes, for setting the mic gain (`audio gain` on the console, [BRINGUP.md](../hardware/BRINGUP.md)); handset down: `LIFT TO TEST` | yes |
| 8 | Redial (not on a Lounge phone; a Lounge phone in use: log out, the phone forgets the person): with the handset up, calls again what this phone last called (a key, an extension or a call back); handset down: `LIFT THE HANDSET` / `THEN MENU 8`; nothing called yet: `NOTHING TO REDIAL`. The phone remembers it across restarts until it's removed | yes |
| 9 | Update now (official firmware with updates on) | yes |
| 0 | About: a page with the mark and `OPEN LOUNGE PHONE`, the firmware, board and server, the public key part (the four fingerprint words, `WORD-WORD-WORD-WORD`) that the app shows for the same phone, and `OPEN SOURCE  OPENLOUNGEPHONE.APP` along the bottom | yes |

Root screen: `MENU`, then the items that apply, packed into up to five lines that fit (20
characters at 2x on the 2.13-inch; six lines of 20 px fill its 122 px): `1 VOLUME 2 VOICEMAIL` /
`3 NETWORK 5 MISSED` / `6 EXT 7 CHECK` / `8 REDIAL 0 ABOUT` / `9 UPDATE` (no `6 EXT` outside team
and organization spaces); a Lounge phone in use: `1 VOLUME 5 CHAT` / `8 LOG OUT 3 NETWORK` /
`7 CHECK 0 ABOUT` / `9 UPDATE`. `9 UPDATE` comes last and is left off when it doesn't fit (9 works
either way). The browser phone has no Network, Check or Update items.

### Missed calls

A **missed call** rang this phone (or, on a person's own phone, any of the person's phones and
apps, in any of their spaces) and nobody answered, and the caller left no message: no answer in
time, or the caller gave up while it rang. Declining a call isn't missing it. A message left
after it makes it voicemail instead (MENU 2). A public line's **call back** that nobody took is
listed here too. Lounge phones keep none.

`MENU 5`: `MISSED 1 OF 3` / who (scrolls when long) / how many and when (`2 CALLS 14:05`,
`YESTERDAY 09:12`, `12 OCT 18:30`; a line: `CALLED BACK 14:05`) / `1 CALL BACK 2 NEXT` /
`3 CLEAR ALL`, newest first; with none: `NO MISSED CALLS`.

- **1 calls the shown one back** (handset up; handset down: `LIFT THE HANDSET` / `THEN MENU 5`),
  like pressing a key: a kids' phone only calls people on its allow-list it may call, within its
  quiet hours, so anyone else is refused (`NOT ALLOWED - PRESS A KEY`); a person's own phone
  calls as its owner would from their app. Someone the phone can't reach from its space (a
  member of the owner's other space) is `UNAVAILABLE`: call them back from the app there.
- **2** shows the next one; **3 clears them all**: marked seen on this phone and, for a person,
  on all their phones and apps (the app's Missed calls clears them the same way).
- The ready screen shows them with the voicemail: `MISSED MOM` / `MENU 5: MISSED` for one missed
  call, `MISSED MOM` / `PLAY IN APP` (or `ASK A GROWN-UP`) for one message, `3 MISSED CALLS` /
  each name in turn for several, and the light breathes until they're cleared or heard.
- On a server older than 0.7.0 (no `missed-calls`) the phone lists only missed call backs here,
  as before.

### Lounge phone

A shared phone (set up as a Lounge phone in the app). Free: the takeover QR code with
`SCAN TO USE THIS PHONE`, a hint (`THIS PHONE`, `HERE: BEN` when someone is open to chat at
another Lounge phone, `OR PRESS A KEY` when the space gave free phones house-line keys; those
call people of the space, never a public line: only someone signed in calls a line) and the
space's name. Scanning asks for proof the person is at the phone: `PRESS KEY 7` / `TO START`
(the red LED flashes fast) until they press it. In use: `HI ANA` / `MENU = OPTIONS` (or
`OPEN TO CHAT`), their people on the keys. When the session ends (log out, the space's time limit,
someone else takes it over) the phone forgets them and shows `SIGNED OUT` / `SEE YOU` (or
`TIME'S UP`, `SOMEONE ELSE`) for 4 s, then the code again. Digit keys do nothing on a free phone
without house-line keys.

**Call screen** (MENU in a call or a room). Each action keeps its digit everywhere (the
browser phone too): **1** hold, resume or merge, **2** transfer, **3** mute or unmute, **9**
volume. In a call: `CALL` / `1 HOLD` / `2 TRANSFER` / `3 MUTE 9 VOLUME` (`3 UNMUTE` when muted).
On hold: `1 RESUME`. In a room: `ROOM` / `3 MUTE` (or `3 UNMUTE`) / `9 VOLUME`. Transfer without
a held call is blind: the next key picks who gets it. Mute stops the handset's mic for this call
(the other side hears silence; the server isn't told, so it lasts until you unmute, hang up or the
call is held): the screen says `MUTED` and the status LED blinks slowly in pairs. In a room the
room's server is told (everyone sees you muted). The hardware phone has audio for one call at a
time, so holding doesn't add a second caller; adding a caller, merging and transferring to the
held call are in the app and the browser phone.

**Call waiting.** A second call to someone who is in a call no longer gets busy: it rings
softly where they're talking. On the phone: a beep in the earpiece every 5 s and `WAITING: MOM`
/ `1 TAKE 2 IGNORE`. **1** takes it: on the browser phone (and in the app) the call you're in
goes on hold (the other person hears the hold tone) and you talk with the new caller; when that
call ends the first one is on hold (`ON HOLD` / name, `MENU 1 RESUMES`), and MENU offers
`1 MERGE` and `2 TRANSFER` meanwhile. The hardware phone has audio for one call at a time (one
WebRTC connection; a held call would come back without sound), so there **1** ends the call
you're in and answers the waiting one. **2** ignores it: it stops beeping here and goes to voicemail after the
callee's usual ring time, as an unanswered call does. Hanging up the call you're in makes the
waiting call ring like any call. A second call waiting, a call you're holding, or being in a
room: busy, as before. Kids' phones get call waiting too; their allow-list and quiet hours
decide exactly as for a first call (someone not allowed is refused without a beep). It's on
unless turned off: a person in the app (Settings → Calls; their apps and own phones follow
it), a kids' phone by its guardians (Manage phone). Phones get it only if they say they show it
(`hello.features` `call-waiting`); older phones stay busy.

**Reconnecting.** When a call's audio connection drops (Wi-Fi blips, a network change), the
phone says `RECONNECTING` instead of sitting in silence. The side that placed the call restarts
the connection (an ICE restart: new routes, same call), every few seconds, for up to 20 s; then
the call ends for both sides with `CONNECTION LOST` (the server tells the other side why). The
hardware phone can't restart a connection (its WebRTC library, esp_peer 1.5.6, has no ICE
restart): it shows `RECONNECTING` while the connection is down, waits up to 15 s for it to come
back by itself, then hangs up the same way. A browser phone or app restarting a call with a
hardware phone gets no answer to its restart, so such a call ends after the wait.

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
| Slow double blink (two 0.25 s blinks every 2 s) | in a call or a room with the mic muted (MENU 3) |
| Double flash every second | this call or room is being recorded (it is also the recording light; it wins over muted) |

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
| Call-waiting beep, 440 Hz, 0.3 s every 5 s | in a call, another call is waiting |
| Beep, 1 kHz, 0.6 s | start speaking: the message is recording |
| 1 kHz steady | the self-test |

Leaving a message: the phone records the handset mic as 8 kHz WAV and sends it when you hang up.
Recorded greetings aren't played on the hardware phone yet (the beep starts the message).
Spoken prompts (the pairing code, "This call is recorded.", "Please leave a message", menu
read-outs) are planned as recorded clips; until then the phone uses the screen and these tones.
The browser phone speaks them already.
