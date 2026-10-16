---
title: Recording calls
description: Turn on call recording for a team (or a home without kids' phones). Every call is announced to everyone on it, and nothing is ever recorded silently.
sidebar:
  order: 9
---

Some teams need a record of their calls — a support line, say. Open Lounge Phone can record, but
only in the open:

- **Off unless you turn it on.** A guardian or admin switches it on for one space: **Account →
  Privacy in this space → Record calls**.
- **Never with kids.** A home with a kids' phone can't turn it on, and a home that records can't
  add a kids' phone. A call with a kids' phone — yours or one on another server — is never
  recorded.
- **Always announced to everyone.** When a recorded call starts, *everyone* on it hears "This call
  is recorded." — including people on other servers, from their own app or phone. The app shows
  a red **Recording** mark, and a phone lights its **recording light** (its status light) and shows `REC`,
  until the call ends. If you don't want to be recorded, hang up. There is no hidden mode.

## Where the recording is made

Calls go straight between the two people; the server never hears them. So the recording is made
by the recording side's own app or browser phone, which then uploads it — like leaving a
voicemail. In a room (a party line, a phone room or a 3-way call) the host's app records it, and
everyone in the room sees the mark.

## Where recordings go

- In the **buddy timeline** of the people on the call ("Recorded" with a Play button), and for
  admins in the space's **call log** (Directory → Admin → Call log).
- **Transcribed** only if the space transcribes voicemail.
- In your **account export**.
- **Deleted** with your call history: the space's history setting (30 days, a year, or forever),
  or your own setting for that person.

Only the people on the call and the space's guardians or admins can play a recording.

## Other servers

A call from a recording space tells the other server up front, and **a server can refuse recorded
calls** for its people: then the call doesn't go through (or ends as soon as recording is
announced), and they're told why. Self-hosters set `REFUSE_RECORDED_CALLS=1`.

More: [Privacy and retention](/project/privacy/).
