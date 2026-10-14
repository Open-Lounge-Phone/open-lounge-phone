# Team and org spaces: a workplace phone system

Status: **built**. Only spaces of type `team` or `org` have these
features; homes (families, kids' phones, quiet hours) are unchanged. There is no phone-network
(PSTN) bridge, now or later: everyone here is reached by extension, by `handle@host`, or through
a connection.

## Roles

| Role | Stored as | May |
|---|---|---|
| **Owner** | the space's first admin (whoever made it) | everything an admin may, plus make and unmake admins, invite admins, remove admins. The owner can't be demoted or removed. |
| **Admin** | membership role `guardian` | manage people (invite members, remove members), phones, extensions, ring groups, business hours, privacy and recording; read the space's call log and audit trail |
| **Member** | membership role `contact` | the directory, dialing extensions and groups, their groups' shared voicemail |

`PATCH /api/users/:id/role {role: "admin" | "member"}` (owner only). The companion shows
"Admin"/"Member" in team and org spaces and keeps "Guardian"/"Contact" in homes.

## Directory

`GET /api/directory?q=` lists the space's members (name, address `handle@host`, role, extension,
whether they take calls), its phones (personal desk phones and Lounge phones; never kids'
phones), rooms and ring groups, each with its extension. `q` matches a name, a handle or the
start of an extension. Members only see their own space; there is still no directory across
spaces or servers. Companion: the **Directory** tab (search, "Dial an extension", Call/Join).

## Extensions

A short number (2–6 digits, e.g. `201`) per member, phone, room or ring group, unique in its
space; each target has at most one (`PUT /api/extensions/:number {kind, targetId}`, admins;
`DELETE` to free it). A number goes with its target (a member leaving, a phone removed, a room
or group deleted).

Dialing: `call.extension {number}` from the companion (the Directory tab, and the Add caller /
Transfer picker) or from a phone: **MENU → 6 Dial ext**, the digits, then **MENU** to dial
(**BACK** deletes a digit). The phone's `config.extensions` says the space has extensions. A
member's extension rings them everywhere they are (like calling them); a phone's rings that
phone (a Lounge phone only while someone is signed in); a room's joins it; a group's rings the
group. An unknown number ends with `denied` and the note "No such extension". Prompt ids for
firmware (`WorkplacePrompt`): `ext.enter` "Enter the extension, then press menu.",
`ext.unknown` "There's no such extension.", `ext.closed` "We're closed right now. Please leave a
message."

## Ring (hunt) groups

`POST /api/groups {name, extension, strategy, ringSeconds, members}` (admins). A group always has
an extension.

- **simultaneous**: every available member at once; the first to answer takes it.
- **sequential**: one member at a time, in list order, `ringSeconds` each.
- **round_robin**: like sequential, starting with the member after whoever came first last time.

Members who aren't taking calls, are busy, or are already ringing for another group call are
skipped; a member declining only stops their own ringing (the others, or the next step, go on).
A group rings its members' sessions and phones **in this space** (keep the space active in the
companion). After the last step the call ends with `timeout` and the caller gets a voicemail
offer for the group's **shared voicemail box**.

## Business hours

Open hours of the space (`PUT /api/space/hours {hours, afterHours}`, in the space's time zone)
and optionally of a group (`PATCH /api/groups/:id {hours, afterHours}`); a group's own hours win.
No hours = always open. They apply to ring groups — the space's "front door" numbers; calls to a
person follow that person's own availability. While closed, a call to a group follows the
after-hours action: the group's own, else the space's, else **voicemail** (the group's box).
Other actions: **forward to a group** or **to a member**. A call forwards at most once (a
forwarded call reaching another closed group goes to that group's voicemail), so two groups
can't bounce a call between them. The caller hears "Closed right now" (`call.state.note`; phones
play `ext.closed`).

## Shared voicemail boxes

Every ring group has one. Its members (and the space's admins) see its messages in their
Voicemail inbox marked "in Support's shared box"; `voicemail.inbox` carries `box`. The first
member to play one marks it **heard by** them (`heardByName`), for everyone. The box goes when
the group is deleted (audio included); retention follows the space's voicemail setting.

## Public lines

A ring group can be published as a **public line**: an address of its own, like
`orders@acme.example`, that anyone may call from their own phone or app, on any server, without
knocking or connecting first. It is the one exception to knock-first (see
[security-model.md](security-model.md)), so it is **off by default** and every rule below can only
make it stricter.

- **Only owners and admins of a team or organization space** can publish one (homes have no ring
  groups). `PUT /api/groups/:id/line {handle}` gives the group its address (it starts off); the
  handle shares the namespace of people's and rooms' handles (recently released handles
  included); unlike a person, a line may use names like `support` or `help`. Turning it on needs `{enabled: true, confirm: true}`: the companion shows the
  warning first, in these words: "Anyone on a server you haven't blocked can call this line.
  Their verified address shows on every call, and you can block people and whole servers."
  Publishing, turning off, changing the address and every setting go into the audit trail.
  `DELETE /api/groups/:id/line` frees the address.
- **Callers:** any person on this server or another one, from their app, their personal desk
  phone (a line can sit on a speed-dial key: `PUT /api/devices/:id/lines {address, label}`), or a
  Lounge phone they're signed in at. **Never a kids' phone:** its own server refuses the call
  (`denied`, "Kids' phones can't call public lines"), a line can't be put on its keys, and a
  line's server refuses any call flagged as coming from a kids' phone. Members of a line are
  people; their own phones ring, never a kids' phone.
- **Members see who is calling:** the caller's verified address (`handle@host`, vouched for by
  their server's signature) shows with the name on every ring.
- **No enumeration:** a line that doesn't exist, is off, or doesn't take this caller (blocked, not
  allowed, over a limit, a kids' phone) answers exactly like an unavailable one (`ended`
  `unavailable`).
- **Calling:** `call.line {address}` from the companion (Connections → Call a public line), a
  key on a personal phone, or the lines on a member's own phone's keys while they're signed in at
  a Lounge phone. A line is always called as a person: a Lounge phone with nobody signed in is
  refused (`ended` `denied`, note `Sign in at this phone to call a public line`; the phone shows
  `SIGN IN TO CALL`), and its house-line keys can't hold a line. Kids' phones never. The first
  `call.state ringing` carries `line {name, description, address}`.

### The queue

When nobody in the group is free (all busy, offline, not taking calls, or the ring time passed
without an answer), the caller waits in the line's **queue**, first come first served. They get
`call.state ringing` with `queue {position, size, voicemail}`, again whenever their place changes.
When a member frees up, the line rings for the caller at the front (a `ringing` without `queue`);
if nobody answers, they go back to their place. At any time the caller may **leave a voicemail
instead** (`call.voicemail {callId}`; the call ends with the line's voicemail offer, into the
group's shared box). The companion shows "You're 2nd in line" and a "Leave a voicemail instead"
button; a phone shows `IN LINE 2` / `1 VOICEMAIL` and key 1 leaves the message. The longest wait
(10 minutes by default) does what the line says (below); a full queue (10 by default) sends the
next caller to voicemail at once (`busy` with the offer). Outside business hours the group's
after-hours action applies and nobody queues. The queue survives the server sleeping: each
waiting call keeps its place and its longest wait.

**Call me back.** Instead of waiting on, a caller may hang up and keep their place
(`call.callback {callId}`, offered when `queue.callback` is set; the companion's "Call me back",
key 2 on a phone). Their call ends with `call.state ended` carrying `callback {until}`: the place
is kept for up to two hours. When it's their turn and someone in the group is free, the line
calls them back: their apps and their own phones ring (`call.ringing` with `callback`, the line's
name and address) for 30 seconds, while the line holds the front of the queue for them.
Answering calls the line again in their place: the ringing call ends with `transfer` (they are
the caller of the new call, which rings the members). If they decline or don't answer, the line
does what it says (`callbackMissed`): `retry` tries once more when their turn comes again (they
go to the end of the line), then offers voicemail; `voicemail` offers it at once. The offer comes
with the ended ring (apps show "Leave a message"). A call back that rang and wasn't taken (no
answer, or no phone or app free; declining doesn't count) shows on the person's own phones as a
**missed call** naming the line (`config.missed` with `callback`: `MISSED CALL BACK` / the line's
name), until they clear it on the phone (MENU → Voicemail → Clear, `missed.clear`), call the
line, or take its next call back. Their server keeps it (one per person and line, the latest
miss) no longer than the call history of the space they called from. Kids' phones never call
lines, and a Lounge phone with nobody signed in can't call one, so neither is offered a call
back. Recent callers show `call back`, `missed call back` and `call back expired`. The line only rings someone who asked: their server keeps the request
(the line, the waiting call) and ignores any other call back.

### Settings

`GET /api/groups/:id/line` and `PUT /api/groups/:id/line` (owner and admins; the companion: Admin
→ Ring groups → a group → Public line).

| Setting | Default | What it does |
|---|---|---|
| `who` | `anyone` | `anyone` on a server that isn't blocked; `connections`: the space's members and people with an active connection to one of them; `allowlist`: only the servers (`partner.example`) and addresses (`ann@far.example`) in `allow` |
| `displayName`, `description` | the group's name, none | what callers see (64 and 140 characters) |
| ring mode, ring time, members, business hours, after-hours action | the group's own | as for any ring group (above) |
| `queue` | on | off: nobody free goes straight to voicemail (or ends as unavailable without voicemail) |
| `queueMax` | 10 | most callers waiting (1-50); the next one is offered voicemail |
| `queueWaitSeconds` | 600 | the longest wait (30 s to 1 hour) |
| `atMaxWait` | voicemail | `voicemail`; `group` (ring another ring group of the space, once); `user` (ring a member); `end` (with an optional `message`) |
| `showPosition` | on | off: callers see "Waiting in line" without a number |
| `offerVoicemail` | on | "Leave a voicemail instead" while waiting |
| `callback` | on | "Call me back" while waiting (needs the queue) |
| `callbackMissed` | `retry` | a missed call back: `retry` (once more later, then voicemail) or `voicemail` (at once) |
| `voicemail` | on | off: no voicemail at all (no offer when the call isn't answered, the longest wait ends the call) |
| greeting | the spoken default | `PUT /api/groups/:id/line/greeting?kind=custom&durationMs=` (raw audio, 30 s), `DELETE` for the default |
| `callerPerHour`, `serverPerHour` | the server's: 10 and 300 | calls per hour from one address, and from one other server's people; a line can only be stricter |

### Blocking and recent callers

`GET /api/groups/:id/line/callers` lists the line's recent callers (newest first, the last 100):
verified address, name, when, and how it went (`answered`, `voicemail`, `missed`, `hung up`,
`closed`, `line full`, `nobody free`, `refused`). From there an admin can block **the person or
their whole server**: `POST /api/space/line-blocks {entry: "ann@far.example" | "far.example"}`
(one list for all the space's public lines; `GET` lists it, `DELETE
/api/space/line-blocks/:kind/:value` lifts a block). The server operator's blocklist applies
before any of this. Recent callers follow the space's history retention.

### Across servers

A line on another server is called through `/fed/v1/calls` with the target `{kind: "line",
handle}` (federation feature `public-lines`; a server that doesn't list it is never asked, and the
caller hears "That server doesn't take calls to public lines yet"). Queue updates travel as
`call.state` on the server-pair stream, the caller's server sends `call.voicemail` to stop
waiting, and the line's server offers its own box with `ended`; the caller's own server relays the
greeting and the message, as for a transfer. A call back (federation feature `line-callback`; a
caller's server that doesn't list it isn't offered one): the caller's server sends `call.callback`
on the stream and keeps the request; at their turn the line's server sends `POST
/fed/v1/lines/callback`, their server rings them, and answering places the call again with the
`line` target's `callback` (no new rate limit is counted); a miss goes back as `POST
/fed/v1/lines/callback/missed`, whose answer is a retry or the line's voicemail offer, relayed by
the caller's server. See [federation-spec.md](federation-spec.md).

## Call log and audit trail (admins)

- `GET /api/space/calls` — the space's call log, one row per party here (who, which direction,
  the other side, answered, duration, why it ended, whether there was voicemail). `GET
  /api/space/calls.csv` exports it (spreadsheet formulas in names are defused); the export is
  itself audited.
- `GET /api/space/audit` — who changed what: extensions, ring groups, hours, roles, invites,
  removed people, phones added and removed (and changes to phones other than one's own), privacy
  and recording settings, notices, the space's name and time zone, public lines and their
  blocklist. Every space keeps one, homes included; see
  [security-model.md](security-model.md#audit-trail) for who reads it and what it never holds.

Both are kept as long as the space's history retention (`PUT /api/space/privacy`), and deleted
by the same sweep as call history.

## Name and time zone

`PATCH /api/space {name?, timeZone?}` (the companion's Settings page) renames the space or moves
it to another time zone: the owner or an admin in a team or org, any guardian in a home; everyone
else sees the values. The name is 1-64 characters (trimmed), the time zone an IANA name such as
`Europe/Lisbon`. Both changes are audited with the old and new values. Everything timed by the
space's clock follows at once: business hours, public lines' hours, party line hours, quiet hours
(homes), the Lounge "end of day", and the phones' clock (`config.now`, `utcOffsetMin`), which get
fresh config right away.

## Transfer across households and servers

Transferring someone who is in another household or on another server is allowed **only in a
team or org space, and only to that space's own members, phones, ring groups and extensions**
(blind: `call.transfer {to: {userId | deviceId | groupId | extension}}`; attended: the consult
party is a member or phone of the space). The call rings the target under a new id; the other
side's server is told with `call.state ended` + `transfer {callId, ringing, offerer}` (the new
id on the sender's side) and carries its person over to it — through any relays (e.g. their
home hub when they answered in another space). If their server doesn't follow, the new call
ends. If nobody answers the new call, the transferred person gets the **same voicemail offer a
caller from this space would** (the ring group's shared box, or the member's inbox): the space's
server sends its offer with the ended `call.state`, and their own server hands them an offer of
its own that forwards the greeting and the message to it.

Everything else is still refused, because in those cases nobody could vouch for the new pair:

- **Homes**: a transfer there is always the transferred person calling the target *as
  themselves*, with their own permissions. A person on another server has no permissions in
  this household, and a transfer must never become a way around default deny (e.g. connecting a
  stranger to someone who never accepted them).
- **Targets outside the space** (a connection, someone in another space or on another server): the
  space can vouch only for its own people and phones.
- **A kids' phone is never transferred.** Its own server refuses to follow the transfer and ends
  the call, so a transfer can't put a kids' phone with someone who isn't on its list, whatever
  the other server does.
