# Privacy and retention

This page says what an Open Lounge Phone server keeps — the public hub, or any server run the
same way — why, for how long, and how to leave. Your own server keeps the same things, on your
own infrastructure.

## What the server keeps

| What | Why | How long |
|---|---|---|
| Your account: handle, display name, passkey public keys, a hash of your recovery code (never a password, email or phone number, nor the code itself) | signing in, getting back in, your address `handle@host` | until you delete it; the handle is then reserved for 90 days so nobody can pose as you to your connections |
| Where you're signed in: per session the browser and system ("Chrome on Mac"), how and when it signed in, when it was last used (never the token itself, only its hash) | the session list, signing out | until the session ends (90 days after its last use at most), and then the next sweep |
| Your spaces (households, teams): name, time zone, quiet hours, who's a member and their role | running the space | until the space is deleted |
| Phones: name, public key, allow-lists and speed-dial keys; last time seen | pairing, calls, default-deny access | until the phone is removed |
| Connections (buddies): their address, name, state (knocked, connected, declined, blocked), the note on a knock | knock-then-talk, blocking | until either side disconnects; declines are kept 30 days, blocks until you remove them |
| Presence you chose to share | showing your connections if you're available | the latest value only |
| Call log: who called whom, when, how long, how it ended — **never the audio** | your call history and each buddy's timeline | as long as you choose: per connection, or your account default; else the space's default (30 days, 1 year or forever; forever unless someone changes it) |
| Voicemail audio and its transcript | voicemail — for a phone (its guardians' inbox) or for you (your own inbox) | until deleted, or until the retention runs out: yours by your setting for that person (else the space's voicemail default), a phone's by the space's |
| Your voicemail greeting (a recorded name or greeting) and ring time; a kid's phone's greeting (recorded by its guardians in the app: a kids' phone never records the child) | what callers hear when you can't answer | until you replace or reset it, or delete the account or phone |
| Call recordings (only where a space turned recording on, always announced; never in a home with kids' phones or with a kids' phone on the call) and their transcripts where the space transcribes | the space's record of its calls | by the history retention of whoever recorded it (per connection, account, then the space's history setting) |
| Team and org spaces: extensions, ring groups and their hours, the shared voicemail boxes | the workplace phone system | until removed |
| Every space's audit trail: who changed what and when (phones, allow-lists, quiet hours, invites, roles, privacy, notices, the space's name and time zone…), with ids and names only — never what was said or written, no tokens, no IP addresses | so the people running a space can see who changed it; only its guardians (or owner and admins) read it | by the space's history setting |
| Public lines' call backs you didn't take: the line's name and address, when | showing them on your phones as missed calls | until you clear them, call the line, or the space's history setting runs out |
| Lounge sessions: who used which Lounge phone, when | shown to the space's guardians | by the space's history setting (forever by default) |
| Phones' software version and model, as they report it | the phone's page in the app | until the phone is removed |
| Usage counters per month (call minutes, room minutes, voicemails, knocks) | the fair-use allowance | per calendar month |
| Rooms: a party line's or phone room's name, address, who made it, whether it's locked or open to connections; which phones may join it. Who's in a room right now is kept only while they're in it | rooms | until the room is deleted |
| Rate-limit counters (with IP addresses **hashed**) | stopping abuse | counted per minute, hour or day; stale counters are pruned after about a month |
| Other servers' public keys and recent signature nonces | federation security | keys while the server is known; nonces ~11 minutes |

**Transcription** can be switched off per space (guardians: Settings → Privacy in this space);
then voicemail audio is never sent to speech-to-text.

**Expiry.** Expired call-log rows and voicemails are deleted with their audio by a sweep: once a
day on a self-hosted server, and on a Cloudflare server whenever there is activity in the space
(a phone or app connecting, a call ending) — no timer runs for an idle space. Your timeline and
inbox run the sweep before they are shown, so you never see expired history. Your retention
setting covers your side only: the other person keeps their own history by their settings.

**Call audio never passes through the server.** It goes directly between the two people, or
through a TURN relay that only forwards encrypted packets when a direct path is impossible.
Rooms of up to 4 people without a relay work the same way. A room through the server's relay
(the Cloudflare Realtime SFU or LiveKit) is encrypted in transit, but the relay could hear it;
end-to-end room encryption (SFrame) is planned. The server records nothing itself: where a space
turned recording on, the recording is made by that side's own app or phone (for a room, a
participant's), announced to everyone first, and uploaded like a voicemail.
There are no ads, no trackers, no text chat, and no connection to the phone network — ever.

**A child's voice is never kept.** A kids' phone doesn't record the child: a call it makes that
isn't answered ends without a voicemail, its greeting is recorded by its guardians in the app, and
its calls are never recorded. Messages left *for* the child by the people allowed to call it are
kept like any voicemail, for the guardians.

## Who can see what

- The people in a space see its members; guardians also see its phones, voicemail and Lounge
  history.
- **A kids' phone's call activity** is shown to its guardians only, on the phone's Manage page:
  every call to and from it (answered, not answered, missed, and the ones that never rang, with
  why: not on its list, quiet hours, busy, offline), with time, who and how long, newest first
  (`GET /api/devices/:id/calls`, a page at a time). It's the space's call log for that phone,
  kept as long as the space keeps its call history; it holds no audio or words, only whether a
  missed caller left a voicemail.
- Your connections see your name and address, and your availability only if you turn on "Share
  my availability".
- Other servers learn only what's needed for a knock, a call or a voicemail between their people
  and yours; your greeting is only given to servers asking for someone you're connected with. Nobody can search for you: there is no directory.
- The server's operator can see account records to fight abuse (for example to suspend an
  account), but not call audio.

## How to leave

In the companion: **Account → Your data**.

1. **Download my data** — one JSON file with your account, connections, spaces, phones and call
   log ([format](export.md)). Save voicemail you want to keep from the Voicemail tab first.
2. **Delete my account** — type your handle to confirm. Your account goes, with every space where
   you are the only person (its phones are wiped and its voicemail deleted). A space you own that
   other people are in must be handed to one of them first (People → Make owner); the app lists
   them. Elsewhere only your membership goes. Your connections are told you've left, and you're
   signed out everywhere. To leave just one space, use **Leave** on the Account page.

Moving an account to another server (keeping your connections) is a later feature; the export
format is designed for it.
