# Notices

A notice is a short message from a space to its phones: "Bus is here", "Dinner's ready",
"Kitchen closes at 10". Every phone shows it on its ready screen with a chime; lifting the
handset plays a recording if there is one; a key clears it. Notices stay inside the space: they
are never sent to other households or servers.

## Who posts

- In a **home**: its guardians.
- In a **team** or **organization**: the owner and admins.

Members can't post. In the companion app a guardian or admin finds **Notice to the phones** on the
Home screen.

## What a notice is

| | |
|---|---|
| Text | One or two lines of at most 16 characters each (what the phones' screens show). Letters, digits and plain punctuation; shown in capitals. |
| Recording | Optional, up to 30 seconds (8 kHz WAV, recorded in the app like a voicemail greeting). |
| How long | 15 minutes to a day; an hour unless the poster picks another. It can be taken down sooner. |
| Which phones | Every phone of the space (kids', personal and Lounge phones), or only the ones picked. |

A newer notice replaces an older one on the phones it reaches.

## On the phones

- **Ready screen:** the notice's lines, over the time and missed calls, with a short chime
  (short, short, long on the hardware's piezo). No chime during quiet hours, during a call or
  with the handset up; the text still shows.
- **Lift the handset:** a recorded notice plays in the earpiece (the phone then has its dial
  tone as usual). Hanging up stops it.
- **Any key** on the ready screen (BACK too) dismisses it on that phone; MENU still opens the
  menu. A dismissed notice doesn't come back on that phone, even after it reconnects.
- When the notice expires or is taken down it leaves every phone.

## API

All routes are under `/api`, with the session's active space.

| Route | Who | What |
|---|---|---|
| `GET /notices` | guardians / admins | the space's notices, newest first (`live` ones and those that ended in the last week) |
| `POST /notices {text, minutes?, deviceIds?}` | guardians / admins | posts one (`text`: a line break between two lines); `201` with the notice |
| `PUT /notices/:id/audio?durationMs=` | guardians / admins | adds its recording (raw `audio/*`, 30 s); the phones get the notice again with its audio |
| `DELETE /notices/:id` | guardians / admins | takes it down |
| `GET /notices/:id/audio?token=` | phones | the recording, while the notice lasts (the token comes with the notice) |

In team and organization spaces posting, recording and taking down are in the audit trail
(`notice.post`, `notice.audio`, `notice.delete`). Recordings are deleted when the notice ends;
the notice itself a week later.

## Protocol

Device feature `notices` (`config.server.features`).

- Server → phone: `notice {id, lines, from, at, expiresAt, audio?: {token, durationMs}}`, sent
  when the phone connects and whenever what it should show changes (again with the same `id`
  when the recording is added: no second chime); `notice.cleared {id}` when it expires or is
  taken down.
- Phone → server: `notice.dismiss {id}`.

See [protocol.md](protocol.md) for the exact messages.
