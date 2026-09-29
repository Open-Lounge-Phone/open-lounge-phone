# Privacy and retention

This page says what an Open Lounge Phone server keeps — the public hub, or any server run the
same way — why, for how long, and how to leave. Your own server keeps the same things, on your
own infrastructure.

## What the server keeps

| What | Why | How long |
|---|---|---|
| Your account: handle, display name, passkey public keys (never a password, email or phone number) | signing in, your address `handle@host` | until you delete it; the handle is then reserved for 90 days so nobody can pose as you to your connections |
| Your spaces (households, teams): name, time zone, quiet hours, who's a member and their role | running the space | until the space is deleted |
| Phones: name, public key, allow-lists and speed-dial keys; last time seen | pairing, calls, default-deny access | until the phone is removed |
| Connections (buddies): their address, name, state (knocked, connected, declined, blocked), the note on a knock | knock-then-talk, blocking | until either side disconnects; declines are kept 30 days, blocks until you remove them |
| Presence you chose to share | showing your connections if you're available | the latest value only |
| Call log: who called whom, when, how long, how it ended — **never the audio** | your call history (and a per-buddy timeline later) | kept with your account; per-connection expiry is planned |
| Voicemail audio and its transcript | voicemail | until a guardian deletes it |
| Lounge sessions: who used which Lounge phone, when | shown to the space's guardians | kept with the space |
| Usage counters per month (call minutes, voicemails, knocks) | the fair-use allowance | per calendar month |
| Rate-limit counters (with IP addresses **hashed**) | stopping abuse | counted per minute, hour or day; stale counters are pruned after about a month |
| Other servers' public keys and recent signature nonces | federation security | keys while the server is known; nonces ~11 minutes |

**Call audio never passes through the server.** It goes directly between the two people, or
through a TURN relay that only forwards encrypted packets when a direct path is impossible.
There are no ads, no trackers, no text chat, and no connection to the phone network — ever.

## Who can see what

- The people in a space see its members; guardians also see its phones, voicemail and Lounge
  history.
- Your connections see your name and address, and your availability only if you turn on "Share
  my availability".
- Other servers learn only what's needed for a knock, a call or a voicemail between their people
  and yours. Nobody can search for you: there is no directory.
- The server's operator can see account records to fight abuse (for example to suspend an
  account), but not call audio.

## How to leave

In the companion: **Account → Your data**.

1. **Download my data** — one JSON file with your account, connections, spaces, phones and call
   log ([format](export.md)). Save voicemail you want to keep from the Voicemail tab first.
2. **Delete my account** — type your handle to confirm. Your account goes, with every space where
   you are the only guardian (its phones are unpaired and its voicemail deleted). In shared spaces
   only your membership goes. Your connections are told you've left.

Moving an account to another server (keeping your connections) is a later feature; the export
format is designed for it.
