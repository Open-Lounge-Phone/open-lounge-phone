# Team and org spaces: a workplace phone system

Status: **built** (batch C1, 2026-09-29). Only spaces of type `team` or `org` have these
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

## Call log and audit trail (admins)

- `GET /api/space/calls` — the space's call log, one row per party here (who, which direction,
  the other side, answered, duration, why it ended, whether there was voicemail). `GET
  /api/space/calls.csv` exports it (spreadsheet formulas in names are defused); the export is
  itself audited.
- `GET /api/space/audit` — who changed what: extensions, ring groups, hours, roles, invites,
  removed people, phones added and removed, privacy and recording settings.

Both are kept as long as the space's history retention (`PUT /api/space/privacy`), and deleted
by the same sweep as call history.

## Transfer across households and servers

Transferring someone who is in another household or on another server is allowed **only in a
team or org space, and only to that space's own members, phones, ring groups and extensions**
(blind: `call.transfer {to: {userId | deviceId | groupId | extension}}`; attended: the consult
party is a member or phone of the space). The call rings the target under a new id; the other
side's server is told with `call.state ended` + `transfer {callId, ringing, offerer}` (the new
id on the sender's side) and carries its person over to it — through any relays (e.g. their
home hub when they answered in another space). If their server doesn't follow, the new call
ends.

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
