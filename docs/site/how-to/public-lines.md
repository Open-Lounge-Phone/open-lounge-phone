---
title: Public lines
description: Give a team's ring group its own address, like orders@acme.example, that anyone on any server can call without connecting first. With a queue, voicemail, blocking and limits.
sidebar:
  order: 9
---

Normally nobody can call you until you've accepted their knock. A **public line** is the one
exception, and you choose it: a team or organization publishes one of its **ring groups** at its
own address, say `orders@acme.example` or `help@cafe.example`, and anyone on any Open Lounge
Phone server may call it straight away. It's how a shop, a clinic's front desk or a venue can be
reached by people who aren't connected to anyone there yet.

Homes don't have public lines, and **kids' phones can never call one**.

## Turn one on

1. In a team or organization space, open **Directory → Admin → Ring groups** and open the group
   (or make one first: see [A phone system for your team](/how-to/workplace-phone-system/)).
2. Under **Public line**, choose its address (`orders` becomes `orders@your.server`) and press
   **Choose address**. Lines share names with people and rooms, but may use names such as
   `support` or `help`.
3. The line starts **off**. Tick the switch and read the warning:

   > Anyone on a server you haven't blocked can call this line. Their verified address shows on
   > every call, and you can block people and whole servers.

   Press **Make it public** to turn it on. Turning a line on or off, changing it and blocking
   callers all show up in the space's list of changes (**Settings → Changes**).

**Remove the line** frees its address; the ring group itself stays.

## Every option

| Option | What it does |
|---|---|
| **Name callers see** | The name on the caller's screen (the group's name if empty). |
| **One line about it** | An optional description, such as "Questions about your order". |
| **Who can call** | **Anyone** (on a server you haven't blocked), **Only people connected to someone here**, or **Only these servers and addresses** (one per line: `partner.example`, `ann@far.example`). |
| **Callers wait in line** | On: when nobody is free, callers wait their turn. Off: they go straight to voicemail. |
| **At most … callers waiting** | The longest line (1 to 50, 10 by default). The next caller is offered voicemail. |
| **For at most … minutes, then** | The longest wait (30 seconds to an hour, 10 minutes by default), then **offer voicemail**, **forward** to another ring group or to one person, or **end the call**. |
| **Show callers their place in line** | Off: callers hear "waiting in line" without a number. |
| **Offer "Leave a voicemail instead"** | Callers may stop waiting and leave a message. |
| **Offer "Call me back"** | Callers may hang up and keep their place; the line calls them back (on by default). |
| **If they miss the call back** | **Try once more later, then offer voicemail**, or **offer voicemail** at once. |
| **Callers can leave a message** | Off: no voicemail at all; an unanswered call simply ends. Messages go to the group's **shared voicemail box**. |
| **Greeting** | The standard one, or **Record a greeting (30 s)** of your own. |
| **Limits (calls per hour)** | **Each caller** and **Each other server**. Empty = the server's limits (10 and 300); a line can only be stricter. |

The ring group's own settings still apply: who it rings and how, the ring time, its business
hours and what happens after hours. Outside business hours nobody waits in line: the after-hours
action applies.

## How people call a line

- **The companion app:** **Connections → Call a public line**, type the address, **Call**.
- **A personal (desk) phone:** on the phone's page in the app, under **Public lines and
  add-ons**, add the line's address with a label (**Add**), then put it on a key. Lift the handset and press
  the key.
- **A Lounge phone:** someone signed in at a [Lounge phone](/how-to/lounge-phone/) gets the
  lines that are on their own desk phone's keys. A line is always called as a person, so a
  Lounge phone with nobody signed in can't call one (it shows `SIGN IN TO CALL`).

The members the line rings see the caller's **verified address** (`ann@far.example`, vouched for
by their server) along with the name, and which line was called.

## The queue

When everyone in the group is busy, offline or not taking calls, the caller waits in line, first
come, first served:

- the app shows **"You're 2nd in line"** (or "You're next") with **Leave a voicemail instead**;
- a phone shows `IN LINE 2` / `1 VOICEMAIL`, and key **1** leaves a message instead.

As soon as a member is free, the line rings for the caller at the front. If nobody answers, they
go back to their place. The longest wait and the longest line do what the line's settings say.

## Call me back

Nobody likes holding. While waiting, a caller can choose **Call me back** in the app (key **2**
on a phone, which shows `1 VM 2 CALL BACK`). They hang up and keep their place in line for up to
two hours (`PLACE KEPT` / `WE'LL CALL BACK`).

When it's their turn and someone at the line is free, their app and their own phones ring:
"Acme support is calling you back" (`ACME SUPPORT` / `CALLS YOU BACK` on a phone). Answering
puts them through to the line in their place. If they decline or don't answer, the line tries
once more when their turn comes again, then offers voicemail, or offers voicemail at once,
whichever you chose. A call back nobody answered shows on the caller's own phones as a missed
call, `MISSED CALL BACK` / the line's name, until they clear it (MENU 5, then 3), call the line,
or answer its next call back. A line only ever rings someone who asked it to call back, and
kids' phones can't call lines at all. It works for callers on other servers too, when their server knows how
(servers that don't simply aren't offered it).

## Blocking and recent callers

Under the line, **Recent callers** lists the last 100 calls: who (verified address), when, and
how it went (answered, voicemail, missed, hung up, call back, missed call back, call back
expired, closed, line full, nobody free, refused). Next
to each, **Block person** blocks that address and **Block server** blocks everyone on their
server. Blocks cover all of the space's public lines and are listed under **Blocked from your
public lines**, where **Unblock** lifts them. The server operator's own blocklist applies before
any of this.

A line that doesn't take someone (off, blocked, not on the allow-list, over a limit, or a kids'
phone) answers exactly like a line that doesn't exist, so nobody can probe for lines or blocks.

## Limits

- Calls per hour from one address (10 by default) and from one other server's people (300 by
  default); members of the space aren't counted.
- The queue: at most 50 callers, waiting at most an hour; a place kept for a call back lasts up
  to two hours.
- Recent callers follow the space's history setting (**Privacy**).
- There's no connection to the regular phone network: callers need an Open Lounge Phone account
  (on any server, or the free hub).

More detail for admins and developers: [Team and org spaces → Public lines](/reference/workplace/#public-lines).
