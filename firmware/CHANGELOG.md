# Firmware changelog

## 0.9.9 — unreleased

- **A held phone makes no calls** (Ask me first, server 0.10.0): lifted, and after any key, it
  still shows `ASK A GROWN-UP` / `NEW FIRMWARE` (the server sends it no keys and refuses every
  call until a guardian allows its firmware or turns Ask me first off). The refusal note it maps
  to `ASK A GROWN-UP` is now "Until a grown-up says OK, this phone can't make calls".

## 0.9.8 — unreleased

- **The phone reports the firmware it runs** (`hello.build`, server 0.10.0): the running image's
  SHA-256 (the app ELF hash), its project and version, and `official`. `official` is true only for
  an image the phone installed itself through its signed update path: after an update checks out,
  the phone records that image's hash in NVS for its update slot (`build` namespace, kept through
  both wipes) and compares the running image with it at boot. A build from source or a USB flash
  reports `false` (`build.c`, `build_core.c`; host-tested). The boot log says `BUILD … official=`.
- **`ASK A GROWN-UP` / `NEW FIRMWARE`** while a guardian hasn't allowed new firmware on a kids'
  phone (`config.hold`, Ask me first); calling such a phone says `WAITING FOR OK`.

## 0.9.7 — unreleased

- **Choppy call audio (found on a board): the Opus encoder at complexity 1, not 5.** At 5, SILK's
  delayed-decision search took 13 ms on average and up to 24 ms per 20 ms frame on the board
  (`enc=13326/23937us`), the earpiece ran dry thousands of times (`dry=`) and the task watchdog
  fired on the audio task. Complexity 1 is about 3x cheaper (measured with libopus) for a small
  quality cost at 16 kHz / 24 kbit/s.
- **Calls stalled after "SRTP connected OK" (found on a board).** Internal RAM was down to 9 KB at
  the start of a call (Wi-Fi and lwIP buffers, TLS/DTLS, the 36 KB audio stack), so the phone's
  larger packets (its call offer, the DTLS certificate flight) failed while small ones went: calls
  it placed connected ICE but never carried audio, and the offer reached the other side only at
  hang-up. Now Wi-Fi/lwIP buffers, TLS/DTLS and allocations over 4 KB live in PSRAM, the audio
  task's stack too (its two settings are saved from the main task), and AES runs in software (the
  hardware AES's DMA failed on PSRAM buffers: the simulator reproduced the stall). In the
  simulator a call now starts with about 150 KB of internal RAM free.
- **`mem`** (console): free internal, DMA and PSRAM memory; each RTC state line logs internal free.
- The games extra (Snake, Memory) is gone.
- **Why a call didn't go through.** When the server says why (server 0.9.0 sends a plain-words
  note), the display shows it instead of a bare BUSY: ON ANOTHER CALL, ADD-ON OFFLINE, ADD-ON
  BUSY, TAKES NO CALLS, NO SUCH ADD-ON, ADD-ONS ARE OFF, CAN'T CALL THAT (the same words as the
  browser phone; a test keeps the two tables equal). Host-tested only.
- **The phone of someone who left** (server 0.9.0: `config.owner.mode` `left`): the trust line
  says `DANA LEFT` (or `OWNER LEFT`), a message waiting says ASK A GROWN-UP, and MENU is the kids'
  one (the Network item asks twice) until it's set up again. Host-tested only.

- **Calls the phone places: the phone is the DTLS client.** On a real board such calls (to a
  browser or an add-on) connected (ICE, DTLS) but carried no audio. The phone, as DTLS server
  (it offered `actpass`, the answer said `active`), logged "SRTP connected OK", yet the other side
  never finished its handshake; `esp_peer` never reported the call connected and stopped
  answering consent checks. The offer now says `a=setup:active`, so the phone is the DTLS client,
  as it is when it answers (the case that connects). `rtc dtls auto` puts `actpass` back, for
  comparing.
- **`audio codec opus|pcmu`** (console, not saved): `pcmu` makes every call as in 0.9.5 (PCMU
  alone, one codec in the SDP), for comparing on a board; `opus` (the default) is 0.9.6's.

## 0.9.6 — 2026-10-15: call audio (wideband, the mic level, concealment, sidetone, echo)

All on both boards; nothing changes on the server. See [docs/audio.md](../docs/audio.md), whose
last section lists what only a real board can check (none of this has run on one yet).

- **Opus wideband calls**: 16 kHz mono, about 24 kbit/s, with in-band error correction; PCMU
  (8 kHz) stays the fallback. Answering an offer without Opus, the phone sends PCMU. A call the
  phone places sends Opus: a phone on 0.9.5 or older that it calls would answer PCMU only and
  couldn't decode it (update both). The log's `CODEC send=… recv=…` says what a call uses.
  The audio path runs at 16 kHz; voicemail and greetings stay 8 kHz WAV (resampled with proper
  filters), and so does the house intercom.
- **The right mic level**: the mic's analog gain goes up (PGA 30 dB + 6 dB) and an automatic
  gain control brings speech to about -24 dBFS, following only speech. The phone check
  (MENU 7, handset up) shows `SPEAK NOW: -26 DB OK` (or `WEAK`, `TOO LOUD`).
- **Smoother over a poor connection**: an adaptive jitter buffer (40-120 ms, starting at 60);
  lost packets come from the next one's error correction or are concealed (G.711: the last
  pitch period repeated, fading out over 60 ms). The `AUDIO` line counts them (`conceal=`,
  `fec=`, `late=`).
- **Sidetone**: you hear yourself faintly in a call (about 4 ms mic to ear: the codec is read
  and written in 1 ms blocks), never while muted. MENU 1 → 6: off / low / normal (the default).
- **Echo**: every call measures how much of the earpiece comes back in the mic (`erl=`); the
  phone check's echo test (MENU 7 → 2) plays a sweep and shows it with the delay (`38 DB OK,
  4 MS`). An echo canceller (SpeexDSP's, 64 ms) is there, off by default until the reference
  handsets are measured: MENU 1 → 7 turns it on for a phone, and so does an echo test that finds
  a poor result. A delay over 5 ms turns the sidetone off.
- **Fix**: a server that gives no ICE servers (a LAN-only self-hosted one without STUN or TURN)
  can now place and take calls with the phone (`esp_peer` refused an empty list).
- Console: `audio agc on|off`, `audio sidetone off|low|normal`, `audio echo on|off|test`,
  `audio source <hz>` (the test device's tone); `audio` shows the codecs' and echo's numbers.

## 0.9.5 — 2026-10-15: wired network for hw v0.2, a board choice

Nothing changes on the boards that exist (rev A, hw v0.1): a default build is the rev A build,
with no wired network code in it, and behaves as 0.9.4.

- **Board choice** (menuconfig → Open Lounge Phone → Board): rev A (the default) or hw v0.2 (the
  RJ45 + PoE revision; `sdkconfig.v02`). It decides the pins in use and the board id updates are
  signed for: `minimal-revA` or `minimal-v02` (no longer settable by hand), so an update for one
  board never installs on the other. Each board has its own manifest in the update channel; rev A
  keeps `firmware-manifest.json`, hw v0.2 reads `firmware-manifest-minimal-v02.json`.
  `tools/release.sh build` signs both (`--board` for one).
- **Wired network** (hw v0.2): the W5500 on the display's SPI bus (polled, no INT/RST lines;
  the e-paper and the W5500 take turns on the bus), DHCP, the same DNS, TLS and call paths as
  Wi-Fi. A cable with a link and an address is used and the Wi-Fi radio is off; no cable, no
  address, or the cable pulled: Wi-Fi, with the cable's PHY powered down and woken every 30 s to
  look for one (5 minutes after a cable that gave no address). A call on Wi-Fi stays there until
  it ends; losing the network a call is on ends the call (the server connection starts again on
  the other network). A board whose W5500 doesn't answer runs on Wi-Fi.
- **Setup with a cable**: a working cable is a network, so setup no longer demands Wi-Fi: the
  setup network doesn't open, and when it is opened (MENU 3/4 → 1) its page says Wi-Fi is
  optional and saves a server alone. A setup network that opened only because there was no
  network closes when the cable comes up.
- **Screens**: `OFFLINE` / `CABLE UNPLUGGED` or `NO DHCP ON CABLE`; MENU 3 heads the network
  screen with the cable (`WIRED NETWORK` and the address, `CABLE UNPLUGGED`, `CABLE CONNECTING`,
  `CABLE AFTER CALL`, `NO DHCP ON CABLE`); the phone check shows the cable's speed instead of
  Wi-Fi while it's in use.
- **Console**: `eth` (link, speed and duplex, address, MAC); on rev A it says there is no wired
  network. `status` adds a `NET` line on hw v0.2.
- **QEMU**: a QEMU build for hw v0.2 uses QEMU's Ethernet as the cable; `tools/qemu_cable.py`
  pulls it out and plugs it back in through the QEMU monitor (`QEMU_MONITOR` in `tools/qemu.sh`).

## 0.9.4 — 2026-10-15: mute, call waiting, missed calls, redial, the house intercom

Needs a server 0.7.0 for missed calls, call waiting, the check-in, the chime and the intercom (an
older server leaves them out; the phone behaves as 0.9.3 there).

- **Mute**: MENU 3 in a call (and in a room, which moves from 1 to 3): the codec's mic is switched
  off and silence is sent; the screen says `MUTED 01:23` (`REC MUTED` when recorded) and the LED
  blinks slowly in pairs. The call screen keeps one digit per action: 1 hold / resume, 2
  transfer, 3 mute / unmute, 9 volume. The second line shows `MENU 3: MUTE` (`MENU 3: UNMUTE`) in
  turn with the name.
- **Call waiting**: a second call while you're in one shows `WAITING: MOM` / `1 TAKE 2 IGNORE`
  with a soft beep in the earpiece. One call has audio at a time on this phone, so 1 ends the
  call you're in and answers the new one (the browser phone and the app hold the first instead);
  2 lets it go to voicemail at the usual time; hanging up makes it ring. The phone says it shows
  call waiting (`hello.features`); without that a second call is busy, as before.
- **Missed calls** (MENU 5): calls that rang and nobody answered, with no message, and public
  lines' call backs, one at a time (`MISSED 1 OF 3` / who / `2 CALLS 14:05`): 1 calls back
  (`call.back`; a kids' phone only people on its allow-list, within its quiet hours), 2 next,
  3 clears them everywhere. The ready screen points one at MENU 5. MENU 2's Clear now clears
  messages only.
- **Redial** (MENU 8): the last key, extension or call back again, kept across restarts. Not on
  Lounge phones (5 and 8 stay chat and log out there).
- **Reconnecting**: when the call's connection drops after it was up, the phone waits: after 2 s
  `RECONNECTING`, and after 15 s it hangs up with `lost` (`CONNECTION LOST` on both sides). The
  other side hanging up (its DTLS close comes ~0.3 s before the server's ended) is no longer shown
  as `CALL FAILED` with a busy tone, and a repeated ended for a finished call is ignored.
  `esp_peer` 1.5.6 can't restart ICE: an offer mid-call (another side's restart) is ignored.
- **Remote candidates**: Chrome sends ~16 (IPv6, TCP, many relays) and `esp_peer` keeps 8: the
  phone pools them for 400 ms after the other side's SDP and gives it the best (IPv4 UDP only;
  host, then server-reflexive, then relay; mDNS names last).
- **BACK while ringing** silences the ringer on this phone (`BACK: SILENCE` in turn on the
  second line); lifting still answers; the call still goes to voicemail at the usual time.
- **Notices**: a recording plays over and over while the handset is up, until it goes down or a
  key clears the notice.
- **The phone check** (MENU 7) shows the handset mic's live level and peak with the handset up
  (the mic is on only then), for tuning `audio gain` (README, BRINGUP).
- **Moved in from labs**: the **house intercom** (MENU 4: the rooms heard, 0 every room; off
  unless turned on in the app; control lines HMAC-signed and audio encrypted with the space's
  key, see README "House intercom"), the **chime** (MENU 4, or 9 on the intercom: posts the
  phone's words as a notice to every phone of the space), and the **daily check-in**
  (`CHECK IN BY 10:00` / `PRESS 1: I'M OK`; the server watches the time and tells the guardians).
- Text screens hold six lines (the root menu uses up to five rows: `1 VOLUME 2 VOICEMAIL` /
  `3 NETWORK 4 INTERCOM` / `5 MISSED 6 EXT` / `7 CHECK 8 REDIAL` / `0 ABOUT 9 UPDATE`).
- From the board test of 0.9.3 (in 49762b4): the mic reads one slot (calls and voicemail no longer
  mush), `audio gain`, no Wi-Fi power save, `JOINING WI-FI` and `WI-FI DROPPED`.

## 0.9.3 — 2026-10-14: add-on callers

- **Add-ons** (services someone linked to their account, such as an AI companion): when one calls,
  the phone shows its name with a label, `SEAT - ADD-ON` / `LIFT TO ANSWER` (or the name and
  `ADD-ON CALLING` when both don't fit on one line), and the label stays on the call screen. The
  display's font has no middle dot, so the browser phone's `SEAT · ADD-ON` reads `SEAT - ADD-ON`
  here. Older firmware shows such a call like any other (`SEAT CALLING`).

## 0.9.2 — 2026-10-14: public lines, notices, call backs

- **Missed call backs**: when a public line calls you back and nobody takes it, your own phone
  shows it like a missed call: `MISSED CALL BACK` / the line's name (or among `3 MISSED CALLS`),
  with the slow-breathing light. MENU 2 shows `1 MISSED CALL BACK` and `3 CLEAR` clears it
  (`missed.clear`, on all your phones); calling the line, or taking its next call back, clears it
  too. Missed call backs aren't counted as voicemail. Older firmware shows them as a missed
  caller named after the line and counts them as voicemail.
- **Lounge phones**: a free phone (nobody signed in) that tries a public line shows
  `SIGN IN TO CALL` / `PRESS A KEY`; only someone signed in can call a line.
- **Setup page**: a network name, password or server address too long for what the phone stores
  is refused with a message (a typed name that didn't fit used to fall back silently to the
  network picked in the list). Typing a server address picks "My own server" by itself. The
  grey example in the address box is gone (it read as filled in); the example is under it. A
  64-character password says it can only use 0-9 and a-f, and a long form shows the page again
  with a message instead of a bare error.
- **Public lines**: a line put on a key (a business's address, from the companion) can be called
  from a personal phone. While waiting in the line's queue the screen shows `IN LINE 2` /
  `1 VOICEMAIL` with the soft waiting tone, and key 1 leaves a voicemail instead
  (`call.voicemail`). Older firmware ignores the queue and just shows `CALLING`.
- **Notices** from the space: the ready screen shows the notice's lines with a short-short-long
  chime (none during quiet hours); lifting the handset plays its recording; any key clears it.
- **Call me back** from a public line's queue: `1 VM 2 CALL BACK` while waiting, key 2 hangs up
  and keeps the place (`PLACE KEPT` / `WE'LL CALL BACK`); when it's your turn the phone rings
  with the line's name and `CALLS YOU BACK`, and lifting the handset calls the line again in
  your place. Older firmware never shows the choice.
- **Labs intercom**: when two rooms answer an all-rooms ring at the same instant, the caller
  keeps the first and tells the other (`TAKEN`), which shows `ANSWERED ELSEWHERE` and goes back
  to idle instead of staying connected to nobody. A late room's hang-up no longer ends the call.

## 0.9.1 — 2026-10-13: Lounge phones, extensions, safer setup

- **Lounge phones** work on the hardware: the takeover QR code on the e-paper, `PRESS KEY 7`
  for the proof (the LED flashes fast), `HI ANA` while in use, MENU 5 open to chat, MENU 8 log
  out, "who's here" and house-line keys; the phone forgets the person when the session ends.
- **MENU 6 dials an extension** in team and organization spaces.
- **MENU 3 Network** shows Wi-Fi and server together (4 opens it too); kids' phones ask for a
  second press before the setup network, Lounge phones don't offer it at all.
- The root menu fits whatever applies into three lines; console `lounge` prints the takeover link.
- Fixed: the dial tone no longer plays over a voicemail you're listening to.
- Builds with the games extra (`CONFIG_OLP_SNAKE`, off by default, on in labs): MENU ten times
  opens a games menu, 1 Snake, 2 Memory (watch the digits, key them back).
- The labs firmware (`firmware/labs/`, 0.0.0) builds from the same sources; nothing changes for
  this build.

## 0.9.0 — 2026-10-13: listen on the phone

- **Voicemail plays on the phone** (a person's own phone): MENU 2 → 1 with the handset up plays
  each unheard message in the earpiece (1 again, 2 next, BACK stop) and marks it heard; 3 clears
  them all. Needs a server with `voicemail-play` (messages are now recorded as 8 kHz WAV).
- **Long text scrolls** in a loop instead of being cut off (names, the owner line, networks).
- **About** shows the mark, `OPEN LOUNGE PHONE` and `OPEN SOURCE  OPENLOUNGEPHONE.APP`.

## 0.8.0 — 2026-10-13: messages, call menu, phone check

- **Key map** when the handset is up: whose phone it is, then who is on each digit key (1-5 and
  6-0), and `PRESS A KEY TO CALL` (or why the last call didn't go through).
- **Leave a message** when a call isn't answered: a beep, the handset mic records (8 kHz WAV, up
  to the server's limit), hanging up sends it. Under 1.5 s is dropped. Recorded greetings aren't
  played yet.
- **Call screen** (MENU in a call): 1 Hold / Resume, 2 Transfer (blind: the next key picks who),
  9 Volume; in a room, 1 Mute / Unmute. One call has audio at a time, so holding doesn't add a
  second caller. While on hold the mic is off and silence is sent.
- **Clock** on the ready screen (`READY 14:05`) from the server's `config.now` and the space's
  UTC offset; no time server needed.
- **Phone check** (MENU 7): Wi-Fi network, signal and channel, address, server state and for how
  long, the last Wi-Fi problem, handset and jack, time running, clock, memory. 1 starts the
  **self-test**: every key, the hook and the jack tick off on a keypad picture, with a 1 kHz tone
  in the earpiece and a click per key.
- **Ringer** volume (soft, medium, loud) and style (classic, double, beeps) in MENU 1 (4 and 5),
  saved on the phone; each press plays it.

## 0.7.1 — 2026-10-13: first boards

- Display: the WeAct 2.13" e-paper (250 × 122) is the default; the 2.9" is `CONFIG_OLP_EPD_213=n`.
  Each refresh logs its time; the console's `epd` checks the module answers.
- Screens follow `docs/phone-ux.md`: a boot logo, a QR code that joins the setup network, an
  About page (firmware, board, server, `PUBLIC KEY PART` words), a MENU title, the recording light (double flash) and `REC`, Voicemail in the menu (2), plain
  pairing and Wi-Fi texts.
- Wi-Fi: WPA3 and mixed WPA2/WPA3 routers, mesh systems (strongest access point), and why a
  join fails (`WEAK WI-FI`, `WRONG PASSWORD?`, `NETWORK NOT SEEN`, `SECURITY NOT OK`) in the log
  and on the screen. The setup page refuses an empty password for a secured network.
- Optional, off by default: framed screens (`CONFIG_OLP_UI_V2`) and Snake (`CONFIG_OLP_SNAKE`:
  MENU ten times in a row; 3/8/7/9 steer, BACK quits).
- Fixed: pixel screens (boot logo, setup QR, Snake) use the display's packed framebuffer; a
  padded row layout skewed Snake diagonally and overran the buffer.

## 0.7.0 — 2026-10-01: versions and compatibility

- **Says which side needs an update.** A server that no longer accepts this phone's protocol
  version (a `config` with `update`, or `error` `unsupported_version`) puts `UPDATE NEEDED / FOR
  THIS SERVER` on the display; a server older than the phone puts `SERVER TOO OLD / ASK ITS
  OWNER`. Either way the phone stops reconnecting every few seconds and tries again hourly
  (`compat.c`, host-tested).
- Logs what the server speaks (`config.server`: software and protocol range) once per sign-in.
- Unchanged and now tested: unknown fields and unknown message types from a newer server are
  ignored. Protocol version still 1 (docs/protocol.md "Versions and compatibility").

## 0.6.0 — 2026-09-30: your keys, your server

- **No server by default.** `CONFIG_OLP_SERVER_URL` is empty: a phone built from source connects
  to nothing and shows `SET UP: CHOOSE A SERVER` until one is chosen. The setup page now asks for
  the server too: "My own server" (an address) or "Public hub (free, to try it)". Also MENU → 4
  (→ 1 re-opens setup) and the console `server <address> | hub | none`. Another server means
  pairing again. The simulator configs no longer name a server (`OLP_SIM_SERVER`).
- **Updates off in source builds.** New `CONFIG_OLP_OTA` (off): no update key and no update URL
  are embedded, there are no update checks and no SNTP; MENU → 9 says `UPDATES / NOT SET UP`.
  Only official release builds (`sdkconfig.release`) embed the project's public key and the
  `fw-stable` channel. Builders turn updates on with their own key (`tools/release.sh keygen`,
  then `build --repo you/your-repo`); with updates on and no key the build stops and says how.
- CI: the QEMU smoke test boots a default build and checks from a packet capture that it sends
  nothing but DHCP; `check_release_scheme.py` checks the defaults, the release config and (with
  `--default-build` / `--release-build`) the built images.

## 0.5.0 — 2026-09-30: encrypted storage

- `CONFIG_OLP_STORAGE_ENCRYPTED` (on in `sdkconfig.release`, off for development and the
  simulators): ESP-IDF's HMAC-based NVS encryption. The device key, its id and the Wi-Fi password
  are encrypted at rest with keys derived from a random eFuse key (KEY5, purpose HMAC_UP) burned on
  the first boot: **one-time and irreversible** (README "Encrypted storage" says what happens).
- Wipes erase the whole NVS partition physically (remote removal, the console `wipe`, and the
  factory reset); a removal writes back only the Wi-Fi, the server and the update URL. Before, a
  removal marked the identity namespace deleted and the old key stayed in the flash until reused.
- `status` shows `storage=encrypted|plain`.
- QEMU e2e: step 12 (a build with encryption on: the key is burned once, nothing readable in the
  flash, decrypts after a restart, a removal erases and keeps the Wi-Fi) and step 6 now checks the
  old device id is gone from the flash after a wipe.

## 0.4.0 — 2026-09-30: signed over-the-air updates

- Two app slots (`partitions.csv`, 4 MB layout) with bootloader rollback. **A USB flash is needed
  once** to move from the one-slot table.
- Updates come from one fixed channel, the `fw-stable` release's `firmware-manifest.json` (never
  GitHub's `/releases/latest`, which can be a hardware release). Firmware releases are `fw-vX.Y.Z`
  (made with `--latest=false`); hardware releases are `hw-vX.Y`. CI checks the scheme.
- The manifest names the board (`minimal-revA`) and is signed (RSA-PSS, the release key built into
  the phone); the phone refuses another board, an older or equal version, a bad signature, a size
  or SHA-256 that differs, and (release builds) an image whose own Secure Boot V2 signature isn't by
  its key. A new image runs on trial and is kept once it reaches the server; a crash or 5 minutes
  without the server rolls it back.
- Automatic updates only while hung up and idle for 10 minutes, at night (SNTP + the space's UTC
  offset, a new optional `utcOffsetMin` in `config`); MENU → 9 updates now. Console `ota`.
- `tools/release.sh` (keygen, signed build, draft by default, a confirmed real release that also
  updates the channel), `tools/ota_manifest.py`, `sdkconfig.release`. The release key was generated
  into `firmware/keys/` (gitignored); its public half is `main/ota_signing_pub.pem`.
- The firmware version comes from the app descriptor (`PROJECT_VER`), one place.

Found and fixed on the way (TESTLOG.md): the QEMU bootloader hangs on its own flash writes (an
emulator bug; the OTA test makes those writes for it); a new Kconfig symbol didn't reach cached QEMU
builds (the build key now includes `Kconfig.projbuild`).

## 0.3.0 — 2026-09-30: Wi-Fi setup network

- With no Wi-Fi saved the phone opens "OpenLoungePhone-XXXX" (WPA2, a fresh 8-digit password shown
  on the display) with a captive-portal DNS and a one-page setup site at http://192.168.4.1/:
  nearby networks or a typed name, a checked password, Save and restart. The page answers only on
  the setup network.
- It also opens after 3 minutes without the saved Wi-Fi (and closes when it's back), from
  MENU → 3 Wi-Fi → 1, from the console (`setup`), and with MENU+BACK held 3 s at power-on;
  held 10 s it's a factory reset (erases everything, as docs/device-lifecycle.md says).
- The display shows the steps. Console: `setup`, `setup test` (the phone fetches and posts its own
  page), `wifi forget`.
- Wi-Fi reconnects use a timer instead of sleeping in the event handler (which stalled every other
  Wi-Fi event), and retry once a minute while the setup network is up.
- Pure logic in `main/prov_core.c` with host tests; QEMU e2e step 10 drives the page from Chromium.

Found and fixed (TESTLOG.md): a phone without saved Wi-Fi closed the setup network as soon as any
link came up; the setup site answered 403 because the HTTP server listens dual-stack (IPv4
clients appear as `::ffff:a.b.c.d`).

## 0.2.0 — 2026-09-30: call audio

Two-way call audio between the phone and the apps.

- WebRTC with Espressif's `esp_peer` (component registry, `~1.5.6`): ICE with the server's
  STUN and TURN over UDP from `rtc.config`, DTLS-SRTP, RTP. TURN over TCP/TLS is opt-in
  (`CONFIG_OLP_ICE_TCP_RELAY`, `ice tcp|tls`) because it doesn't work in `esp_peer` 1.5.6 (README). The caller offers; the other side's trickled `rtc.ice`
  candidates are applied (queued until its SDP). No media, no call: a failed or lost connection
  hangs up. The old signaling-only SDP (audio rejected) is gone.
- G.711 µ-law (PCMU) at 8 kHz, chosen over Opus for robustness (README "Call audio").
- Audio device interface: the ES8311 over I2S (8 kHz mono, MCLK 2.048 MHz, init over I2C on the
  new `i2c_master` driver) or a test device (1 kHz source, analysing sink) for the simulators and
  bring-up. The mic is captured only while a call's media is up.
- Earpiece: call-progress tones mixed in locally (dial, ringback, busy, hold), volume 0-10 in 3 dB
  steps under a -6 dBFS cap (Kconfig), MENU → 1 Volume. Muted on the hook.
- Console: `audio` (counters, levels, `tone`, `loop` echo test, `watch`), `volume`, `rtc`,
  `ice all|udp|tcp|tls`.
  TURN credentials are never logged (`rtc.config` is logged without them; `esp_peer`'s agent log
  stays at WARN).
- ESP-IDF v5.5 (v5.5.5) is now required: `esp_peer`'s prebuilt libraries need `esp_log()`.
- QEMU build (`sdkconfig.qemu`, `tools/qemu.sh`): Espressif's esp32s3 machine with its OpenCores
  Ethernet standing in for Wi-Fi; CI boots it (`tools/qemu_smoke.py`). The e2e test runs on QEMU
  by default (Wokwi's free plan ran out of CI minutes).
- Host unit tests (`firmware/test/host`, in CI): G.711, tones and cadences, meters, ICE choice.
- `hardware/BRINGUP.md`: the checklist for the first real board (codec, levels, cap, echo).

Found and fixed on the way (TESTLOG.md): the test device's catch-up loop starved the idle task
(watchdog); one-second sample buffers cost 48 KB of RAM (now running meters); the console's terminal
probe swallowed the first command typed after boot (the e2e now waits for the prompt); QEMU with
32 MB PSRAM left no address space for the flash (8 MB, like the board's module); QEMU's Ethernet
dropped RTP bursts with 4 RX buffers (16).

## 0.1.0 (v0) — 2026-09-30

First firmware for the minimal board (ESP32-S3, ESP-IDF v5.4). No call audio yet.

- Pin map generated from the hardware build (`tools/gen_board.py` → `main/board.h`).
- 12 keys, hook and jack detect: GPIO interrupts + debounce; piezo ring and beeps (LEDC);
  status LED patterns: idle, pairing, connecting, offline, ringing, missed.
- Display interface with the WeAct 2.9" e-paper (SSD1680) driver and an ILI9341 stand-in for
  the Wokwi simulator; the protocol's strip model in large type; `screen` dumps the framebuffer.
- Wi-Fi from NVS or Kconfig; server from NVS or Kconfig (default `wss://l1.openloungephone.app`);
  WebSocket over TLS with the certificate bundle; keep-alive and `status`.
- Protocol: `hello` → `pair.begin` (P-256) → `pair.code` → `pair.done` → reconnect →
  `auth.challenge`/`auth.proof` → `config`; `deviceStep` mirrored in C; `wipe` → reboot, new key.
- Signaling-only calls: SDP with the audio section rejected, so calls go `active` without media.
- MENU → Wi-Fi status and About (version + the four fingerprint words).
- Console: `wifi`, `server`, `status`, `key`, `hook`, `drop`, `wipe`, `screen`, `reboot`.
- Wokwi: diagram, smoke scenario, `tools/sim.sh`; live e2e `tests/e2e/live/firmware.test.ts`.

Fixes found by the simulator and the e2e run (see TESTLOG.md):
- A board without a display module no longer waits 45 s at boot (BUSY pulled down, init gives up
  after 1 s).
- `screen` rows can no longer be split by other tasks' log lines.
