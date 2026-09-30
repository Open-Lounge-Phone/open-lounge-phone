# Hardware phone lifecycle

Status: owner decisions 2026-09-28. The **server and app parts are built** (modes at claim,
per-space session length, idle options, remove = wipe) and run on the browser phone
(`/device/`); the firmware parts wait for the board.

## Modes (set when a phone is claimed)

| Mode | Owned by | Signed in as | When idle |
|---|---|---|---|
| **Kids** | a home space; guardians manage it | always the child | never idle: allow-list, quiet hours, voicemail |
| **Personal / desk** | one person | always that person | never idle: it is their own phone (bedside, desk) |
| **Lounge** | a space (venue, office, common room) | whoever signs in | **dead by default** until someone signs in |

The mode is picked when the phone is claimed (`POST /api/devices/pair` with `mode`; the phone's
own first-run choice arrives in `pair.begin.kind` and is preselected, `POST
/api/devices/pair/preview`). Kids and Lounge phones are claimed by the space's guardians, and kids'
phones only in a home; anyone may claim a phone as their own (**personal** reuses the phone's
owner: calls to that person ring it, its keys dial as them). The phone learns its mode and owner
from `config.owner` and shows them on the strip.

**Idle Lounge phones** can optionally be configured per space (`PUT /api/lounge/settings`,
guardians). These are all **off by default**:
- **house-line keys** (`houseLine: {enabled, keys}`): idle keys call *as the space* (the phone's
  name) — a member (rung wherever they are), someone's personal desk phone in the space, or a
  **group** of members where the first to answer takes the call. Kids' phones and people outside
  the space can't be targets. Party lines come with rooms (P3.5).
- **who's here** (`whosHere`): shows who is signed in at the space's other Lounge phones and open
  to chat (`config.here`); people who aren't open to chat aren't listed.
- ...and more configurations later

**Session length** is a per-space setting managed by the space's guardians (its admins):
`session: "idle"` (after `idleMinutes` hung up and unused, default 10 — a venue), `"end_of_day"`
(at `dayEnd`, local time, default 00:00 — hot desks) or `"until_logout"` (an office desk).
Sessions also end on Log out, Leave, a new takeover, or a disconnect after the 60-second grace
period. The end of day uses the space's one alarm, only while a session is open. Nothing stays on
the phone.

## Lifecycle

1. **Out of the box:** no owner and no Wi-Fi. The phone generates its own device key on first boot.
   The display shows "Set me up", the status light breathes, and lifting the handset plays a spoken
   prompt.
2. **Wi-Fi setup:**
   - **Universal path** (**built**, firmware 0.3): with no Wi-Fi saved the phone opens a temporary
     network "OpenLoungePhone-XXXX" (WPA2; its 8-digit password is on the display, so only
     someone at the phone can join) and a setup page at http://192.168.4.1/ (phones open it as a
     captive portal) lets you pick your Wi-Fi and type its password; the phone saves it and
     restarts. It also opens when the saved Wi-Fi has been unreachable for 3 minutes (moved, new
     password), from MENU → 3 Wi-Fi → 1, or with MENU+BACK held 3 s at power-on.
   - **Android:** Bluetooth setup from the companion is optional.
   - **Later:** the QR sticker on the base opens the page directly.
3. **Claim:** the QR code on the base or the 6-digit code on the display (the minimal board has no
   NFC). You pick the space and the mode.
4. **Daily use:** per mode, as above.
5. **Updates and health:**
   - Signed OTA updates install only while the phone is hung up and idle, overnight by default.
   - The firmware has two slots, so a bad update rolls back automatically.
   - The owner sees signal, offline alerts and (on phones that report them) battery and
     reduced-power mode.
6. **Remove, reset, retire:**
   - **Remove in the app:** the server forgets the device key, and the phone wipes itself: at once
     if it's connected (`wipe`), otherwise the next time it connects — the server remembers the
     removed id and key (`removed_devices`, a year) and sends `wipe` only after the phone signs
     the challenge with that key, so nobody else can trigger it. Deleting an account or space
     wipes its phones the same way. The browser phone deletes its key from IndexedDB, its id and
     its first-run choice, and starts over.
   - **Factory reset** (MENU+BACK held **10 s** at power-on; released after 3 s it opens the
     Wi-Fi setup network instead; the display says which): wipes Wi-Fi, owner and keys, and generates a new
     device key.
   - **Changing mode or owner:** always goes through a wipe. No data ever carries over. The server
     enforces it: `PATCH /api/devices/:id` only renames a phone and answers `409` to any owner or
     mode field.
   - **No claim lock (owner decision).** A removed phone holds nothing of value (no contacts, no
     history, no keys that still work), so anyone can reset it and claim it again. That keeps
     second-hand and handed-down phones easy.

See [security-model.md](security-model.md) for the protections and trust signals. It covers what
the minimal board's hardware does and doesn't guarantee (no hardware mute switch or mic lights),
secure boot, and the four-word device fingerprint.
