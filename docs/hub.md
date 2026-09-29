# The public hub

`hub.openloungephone.app` is a public Open Lounge Phone server with open sign-up, run by the
project owner so anyone can try the service without running their own. It is **free, funded by
donations**, and it federates with every other server as an equal — there is no paid plan and
no special treatment. Status: **live** at https://hub.openloungephone.app since 2026-09-29.

## Always free, with fair use

The hub will always be free to use. To keep it fair for everyone, each account has a generous
monthly **fair-use allowance**. It stops abuse; it isn't a plan. When you reach a limit, new calls,
voicemails or knocks are refused with a clear message until the month resets (the 1st, UTC).
**Calls in progress are never cut off** — the allowance is checked when something starts and
metered when it ends.

| Allowance (per account per month) | Hub default | Variable |
|---|---|---|
| Call minutes | 1,000 | `FAIR_USE_CALL_MINUTES` |
| Voicemails | 100 | `FAIR_USE_VOICEMAILS` |
| Voicemail storage | 100 MB | `FAIR_USE_VOICEMAIL_MB` |
| Knocks | 100 (and 10 a day, everywhere) | `FAIR_USE_KNOCKS` |
| Phones per space | 5 | `FAIR_USE_PHONES_PER_SPACE` |
| Spaces per account | 5 | `FAIR_USE_SPACES_PER_ACCOUNT` |
| Room minutes (time in rooms: 3 people for 10 minutes = 10 each) | 1,000 | `FAIR_USE_ROOM_MINUTES` |

`FAIR_USE=hub` turns these defaults on; each variable overrides one (a number, or `unlimited`).
**A self-hosted server has no allowance unless you set one.** An operator can exempt an account
(for example a venue with Lounge phones). The companion shows "Fair use this month: … of …" with
the reset date, only on servers that have an allowance. Minutes count against the person who
placed the call (for a household phone, the space's first guardian).

## Why it's cheap

Most calls are **peer to peer**: the audio goes directly between the two people and never touches
the hub. Only about **20 % of calls** need Cloudflare's TURN relay (both people behind strict
networks), at roughly **$0.04 per 1,000 relayed minutes**, and clients use Opus DTX so silence
costs almost nothing. The rest is small: Workers requests, Durable Objects that hibernate when
idle (the server-pair streams close after a minute without calls), D1 rows, and voicemail audio in
R2. So the main costs are **TURN relay traffic and Durable Object / D1 usage**, on top of the $5
Workers Paid plan.

| Kind of use | What it costs the hub | Estimate |
|---|---|---|
| Base: Workers Paid plan | fixed | $5 / month |
| A peer-to-peer call minute | signaling only (a few Durable Object messages) | ≈ $0 |
| A relayed call minute | TURN relay traffic | ≈ $0.00004 ($0.04 per 1,000) |
| An average call minute (≈ 80 % direct, 20 % relayed) | | ≈ $0.000008 |
| A voicemail | R2 storage, a Workers AI transcript | a small fraction of a cent |
| A typical active person per month (300 min, 30 voicemails) | all of the above | ≈ $0.02 |

**Rooms** (party lines, phone rooms, 3-way calls) are the one thing that goes through the hub's
media relay, the Cloudflare Realtime SFU: it bills **$0.05 per GB of egress** (what it sends to
listeners) after the first 1,000 GB a month, shared with TURN; what people send into it is free.
A listener receiving one speaker at a time with Opus (≈ 32 kbit/s) costs about 0.25 MB a minute,
so a room minute costs roughly **$0.0000125–0.000025** ($0.013–0.025 per 1,000). The controls
that keep it there:
- **Small rooms need no relay.** Without one, a room is a peer-to-peer mesh of up to 4 people
  (like calls, ≈ $0); 1:1 calls never use the relay, and a 3-way call made by merging uses the
  relay only on servers that have one.
- **Opus DTX** on every connection: silence sends (almost) nothing.
- **Top 3 speakers** in rooms of more than 4: each person gets only the three most active
  speakers, and muted people aren't forwarded at all.
- **Idle drop**: someone silent with no interaction for 10 minutes is warned, and dropped a minute
  later unless they speak or tap "I'm here".
- **Room minutes** count toward the fair-use allowance above (metered when someone leaves).

These are the estimates the funding numbers below are computed from
(`COST_PER_ACTIVE_USER_USD_PER_MONTH`, `BASE_COST_USD_PER_MONTH`), not measurements; they'll be
updated from the hub's real bills.

## Funding transparency

The hub shows how far its donations go, computed from its configuration by
`fundingSummary` in `packages/core/src/funding.ts` (tested; never hand-written). With the current
configuration — `FUNDING_BALANCE_USD=150`, `BASE_COST_USD_PER_MONTH=5`,
`COST_PER_ACTIVE_USER_USD_PER_MONTH=0.02` — that is: **$150 in funding**, **every $1/month
covers about 50 people**, and **$150 keeps the hub running for ~375 people for a year (or ~1,000
people for 6 months)**. The [website](https://github.com/Open-Lounge-Phone/website)'s funding
page and home page card and the companion's funding card all use the same function.

Donations go through **GitHub Sponsors**. The link is one setting, `SPONSOR_URL`, used by the
website build and by the hub; while it's unset the Sponsor button is hidden (never a placeholder).
The project is proudly supported by [unsubscribe.llc](https://www.unsubscribe.llc/).

## For full assurance, run your own

The hub is the easy way in. For **full security assurance, run your own server** on your own
domain — on your Cloudflare account ([deploy guide](cloudflare.md)) or with Docker
([self-hosting](self-hosting.md)): your data, your keys, still federated with everyone, and no
allowance unless you set one.

## Running the hub (operators)

Deploy (don't run this without the owner's go-ahead):

```sh
cd apps/server-cloudflare
npm run deploy:instance -- --instance hub --domain hub.openloungephone.app --open-signup \
  --turn-key-id <id> --turn-key-token <token> \
  --turnstile-site-key <key> --turnstile-secret <secret> \
  --operator <your handle> --funding-balance 150 [--sponsor-url <GitHub Sponsors URL>] \
  [--sfu-app-id <id> --sfu-app-secret <secret>]
```

- **Rooms' relay** (optional): the Realtime SFU app's id and secret (dashboard → Realtime → SFU),
  stored as secrets; the script also reads them from `instances/sfu.env` when present. Without
  them rooms are peer to peer and hold 4 people.

- **TURN is required** for a public instance; the script refuses `--open-signup` without a key
  (Cloudflare dashboard → Realtime → TURN).
- **Turnstile** protects sign-up (dashboard → Turnstile → add a widget for the domain). Without
  keys there is no check.
- **Abuse controls:** passkey-only accounts; per-IP limits on sign-up and sign-in (IP addresses
  are hashed before they're counted); a per-account limit on changes; the fair-use allowance;
  knock limits; per-server budgets and signature checks for federation.
- **Operator view** (companion → Operator, for `--operator` handles): counts, find an account,
  suspend or exempt it, block a server, and see refused server-key changes.
- What the hub stores and for how long: [privacy.md](privacy.md). How people take their data
  with them: [export.md](export.md).
