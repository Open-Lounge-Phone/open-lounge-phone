# Hardware phone lifecycle

Status: **design** (owner decisions 2026-09-28). The server and app parts can be built now against
the browser phone (`/device/`). The firmware parts wait for the board.

## Modes (set when a phone is claimed)

| Mode | Owned by | Signed in as | When idle |
|---|---|---|---|
| **Kids** | a home space; guardians manage it | always the child | never idle: allow-list, quiet hours, voicemail |
| **Personal / desk** | one person | always that person | never idle: it is their own phone (bedside, desk) |
| **Lounge** | a space (venue, office, common room) | whoever signs in | **dead by default** until someone signs in |

**Idle Lounge phones** can optionally be configured per space. These are all **off by default**:
- **house-line keys:** idle keys ring the front desk, a staff group or a party line, calling *as the space*
- **who's here:** shows who is signed in on the space's other Lounge phones and open to chat
- ...and more configurations later

**Session length** is a per-space setting managed by the space's operators/admins. Examples: 10
idle minutes for a venue, end of day or until logout for an office desk (hot-desking). Sessions also
end on Log out, Leave, a new takeover, or a disconnect after the 60-second grace period. Nothing
stays on the phone.

## Lifecycle

1. **Out of the box:** no owner and no Wi-Fi. The phone generates its own device key on first boot.
   The strip shows "Set me up", the key lights breathe, and lifting the handset plays a spoken
   prompt.
2. **Wi-Fi setup:**
   - **Universal path:** the phone opens a temporary network "OpenLoungePhone-XXXX", and a setup
     page lets you choose your Wi-Fi.
   - **Android:** Bluetooth setup from the companion is optional.
   - **Later:** an NFC tap or the sticker opens the page directly.
3. **Claim:** an NFC tap (an NDEF URL, which iPhones read natively), the QR code on the base, or the
   6-digit code on the strip. You pick the space and the mode.
4. **Daily use:** per mode, as above.
5. **Updates and health:**
   - Signed OTA updates install only while the phone is hung up and idle, overnight by default.
   - The firmware has two slots, so a bad update rolls back automatically.
   - The owner sees battery, signal, offline alerts and reduced-power mode.
6. **Remove, reset, retire:**
   - **Remove in the app:** the server forgets the device key, and the phone wipes itself the next
     time it connects.
   - **Factory reset** (MENU+BACK held at power-on): wipes Wi-Fi, owner and keys, and generates a new
     device key.
   - **Changing mode or owner:** always goes through a wipe. No data ever carries over.
   - **No claim lock (owner decision).** A removed phone holds nothing of value (no contacts, no
     history, no keys that still work), so anyone can reset it and claim it again. That keeps
     second-hand and handed-down phones easy.

See [security-model.md](security-model.md) for the protections and trust signals. It covers the
hardware mute, the mic-power light, the handset being unpowered on-hook, secure boot, and the
four-word device fingerprint.
