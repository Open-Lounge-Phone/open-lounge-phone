# Account export format

`GET /api/account/export` (companion: Account → Your data → Download my data) returns everything
a server keeps about one account as one JSON document. It is meant for people leaving a server
and, later, for **moving an account** to another server while keeping its connections.

## Version 1

```json
{
  "format": "openloungephone-export",
  "version": 1,
  "exportedAt": "2026-09-28T12:00:00.000Z",
  "server": "hub.openloungephone.app",
  "account": {
    "id": "acc_…",
    "handle": "jesse",
    "name": "Jesse",
    "address": "jesse@hub.openloungephone.app",
    "createdAt": "2026-09-01T09:30:00.000Z",
    "sharePresence": false
  },
  "connections": [
    {
      "address": "bob@l1.openloungephone.app",
      "peerId": "acc_…",
      "name": "Bob",
      "state": "active",
      "since": "2026-09-10T18:00:00.000Z"
    }
  ],
  "blockedServers": ["spam.example"],
  "spaces": [
    {
      "id": "hh_…",
      "name": "Jesse's home",
      "type": "home",
      "timeZone": "Europe/Amsterdam",
      "role": "guardian",
      "nameThere": "Jesse",
      "phones": [{ "id": "dev_…", "name": "Kid phone", "kind": "kids", "own": false }],
      "quietHours": [{ "days": [0, 1, 2, 3, 4], "start": "19:30", "end": "07:00" }]
    }
  ],
  "calls": [
    {
      "peer": "bob@l1.openloungephone.app",
      "peerLabel": "Bob",
      "direction": "out",
      "startedAt": "2026-09-12T17:00:00.000Z",
      "answered": true,
      "durationMs": 420000,
      "endReason": "hangup"
    },
    {
      "peer": "bob@l1.openloungephone.app",
      "peerLabel": "Bob",
      "direction": "in",
      "startedAt": "2026-09-13T08:00:00.000Z",
      "answered": false,
      "durationMs": 0,
      "endReason": "timeout",
      "voicemailId": "vm_…",
      "voicemail": "/api/voicemails/vm_…/audio"
    }
  ]
}
```

- `connections` holds `active` and `blocked` people (pending knocks and declines are not
  exported). `peerId` is the other person's stable id on their server; `address` their current
  address. Whole-server blocks are in `blockedServers`.
- `spaces` lists every space the account is in. Phones are listed for guardians (all of the
  space's phones) and for owners (their own phone). Quiet hours are included for guardians of
  homes.
- `calls` is the account's call log (newest first, up to 1,000). `peer` is `handle@host` for
  someone on another server or connected across households, `user:<id>` / `device:<id>` inside
  a space. A missed call that ended in a voicemail for you carries `voicemailId` and
  `voicemail`, the path of its audio on this server (signed-in `GET`, the same audio as the
  Voicemail tab); the transcript is in the inbox.
- Not included: passkeys (they're bound to the old server's name), sessions, voicemail audio
  (download it from the Voicemail tab), other people's data.

Readers must reject documents whose `format` differs, and should accept any `version` they know;
new fields may be added within a version.

## Moving an account (design, not built yet)

1. On the new server, create an account and choose **Import** with the export file.
2. The new server re-creates spaces and settings (phones must be re-paired: their keys are bound
   to their pairing).
3. For each `active` connection, the new server sends a signed `POST /fed/v1/connections/moved`
   to the peer's server with `{from: <new party>, previous: <old address>, peerId}`; the old
   server co-signs the move (a signed statement from the old server that `previous` moved to the
   new address), so a peer can update the connection without a new knock.
4. The old account can then be deleted; its handle stays reserved for 90 days so nobody else can
   take it in the meantime.
