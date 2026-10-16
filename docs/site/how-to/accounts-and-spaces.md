---
title: Your account & spaces
description: Creating an account with a passkey, your recovery code, your handle, households, teams and organizations, owners, inviting people, leaving, and taking your data with you.
sidebar:
  order: 2
---

You need an account to use the companion app, and every phone belongs to a **space**: a
household, a team or an organization. This page covers both.

## Creating an account

On the free public hub, open [hub.openloungephone.app](https://hub.openloungephone.app) and choose
**Create an account**. On your own server, the first person uses the one-time setup link the
server prints when it starts; after that, people join with invite links (or sign up, if the
server's owner turned that on).

There are **no passwords**. You sign in with a **passkey**: the fingerprint, face or PIN unlock
your phone or computer already uses. Nothing to remember, nothing to phish. No fingerprint or
face sign-in on your device? Use your phone, a security key or a password manager instead:
[Passkeys](/how-to/passkeys/) explains how, and why passkeys are safer than passwords. Add a
second passkey under **Account → Your passkeys → Add a passkey**, so losing one device doesn't
lock you out.

Right after your account is made, the app shows your **recovery code** once. Print it or keep it
in a password manager, then type its last four characters to show you saved it. If you ever lose
every passkey, **Lost your passkey?** on the sign-in screen takes your handle and this code. See
[Your recovery code](/how-to/passkeys/#your-recovery-code).

## Where you're signed in

**Account → Where you're signed in** lists each browser and app signed in to your account. Sign
one out, or choose **Sign out everywhere else** (for a lost phone, say). Signing out closes that
app at once. Sessions you keep using stay signed in until 90 days after you last used them.

## Your handle and address

When you sign up you pick a **handle**, which becomes your address: `ana@hub.openloungephone.app`.
It's how people [connect with you](/how-to/connections/). You can change it once a day; your old
handle stays reserved for you for 90 days so nobody can take it over while your connections
catch up. Your **name** (Account → Change name) is what your connections see; each household or
team shows its own name for you on its phones' keys, which its guardians or admins can change on
their **People** page (**Rename**).

## Spaces: households, teams and organizations

A space is a group of people and the phones they share. There are three kinds:

| Space | For | What's different |
|---|---|---|
| **Household** | A family | Kids' phones, quiet hours and guardians. The only kind where children's phones exist |
| **Team** | Colleagues, a club, a shared house | Ring groups, extensions, business hours, shared voicemail, public lines |
| **Organization** | A bigger workplace | The same as a team |

You can belong to several spaces at once (your own household, your parents' household, your
team at work) with one account. Switch between them under **Your households and teams**. Calls
to you ring wherever you are: in the app and on your own phones in every space.

Signing up gives you your own household for your own phones. Create more with **Create
household** or a team or organization from the same place.

## Inviting people

Use **Invite someone** (or **Invite a co-guardian**) to create an invite link. It works once and
expires after 7 days. The person opens it and joins: as someone new, or, if they already have an
account on the server, as themselves (the link offers to sign in first). Already in the space?
The link says so. Guardians and admins see the links not used yet under **People → Links not used
yet**, and can cancel them.

A **sign-in link** (People → Sign-in link) signs an existing person in on a new device without a
passkey: for someone who lost theirs and has no recovery code. It works only for someone whose
only household or team on the server is yours, and a new one cancels the old.

Who can do what depends on the space:

- **In a household**, a **guardian** manages phones, people, quiet hours and privacy; a
  **contact** can call the phones they're allowed on (grandparents, a babysitter).
- **In a team or organization**, **admins** manage phones, groups, hours and lines; **members**
  call and are called.

## Owners

Every household, team and organization has one **owner**: whoever made it, until they hand it on.
Only the owner changes roles (**Make guardian** / **Make contact** in a household, **Make admin**
/ **Make member** in a team), and nobody else can remove the owner or send them a sign-in link.

To hand it on, the owner opens **People** and chooses **Make owner** next to another guardian
(an admin in a team), then confirms. Someone who's a contact must be made a guardian first. The
old owner stays a guardian or admin. Changes like this show in the space's **Changes**.

People who are already connected with you on other servers don't need to join your space at
all: you can put them on a phone's list directly (see
[Connections](/how-to/connections/#putting-a-connection-on-a-kids-phone)).

## Your space's settings

Open **Settings** to see the space's name and time zone. In a household any guardian can change
them; in a team or organization the owner and admins can. Everyone else sees them.

- **Name** — shown at the top of the app and on the phones.
- **Time zone** — everything that follows a clock uses it: quiet hours, business hours and the
  hours of public lines and party lines, the end of the day for Lounge phones, and the clock on
  the phones' screens. After a change the phones get the new time straight away.

**Privacy in this space**, on the same page, sets how long call history is kept and whether
voicemail is transcribed. Each person can also choose, per connection, how long your shared
history is kept (**Keep our history**). See [Privacy](/project/privacy/) for what the server
stores and for how long.

**Changes** lists who changed what in the space, and when: phones added or removed, who a kid's
phone can call and its keys, quiet hours, invites, privacy, notices, the name and time zone, and
more. Only a household's guardians, or a team's owner and admins, can see it. Nobody can edit or
delete it; entries are removed only when they're older than the space keeps its call history.
It never holds what anyone said or wrote: not a notice's text, not voicemail, not recordings.

## Leaving and taking your data

- **Leave** a household or team from **Account → Leave**; you keep your account and your other
  spaces. The owner hands it to someone else first; an owner who's alone in it can leave, and that
  deletes it with its phones. If it's your only space on the server, delete your account instead.
- **Removed by a guardian or admin?** If it was your only space there, removing you deletes your
  account (your connections are told, and you'd need a new invite to come back); otherwise you
  keep your other spaces. The app says which before they confirm.
- **Your data → Download my data** gives you everything the server holds about you: your account, your
  connections, your call history and your voicemail, as files you can read
  ([what's in it](/reference/export/)).
- **Your data → Delete my account** removes your account and its data from this server. Households
  and teams where you're the only person are deleted with it (their phones are wiped). One you own
  that other people are in must be handed on first; the app lists them. Your connections are told
  you've left, you're signed out everywhere, and your handle stays reserved for 90 days.

## On the public hub

The hub is free and funded by donations. To keep it fair for everyone there's a generous
monthly allowance (calls, voicemail and phones per space; see [the hub](/project/hub/)). Calls
in progress are never cut off. For full control, [run your own server](/how-to/deploy-cloudflare/):
your account there reaches everyone on the hub and on every other server just the same.
