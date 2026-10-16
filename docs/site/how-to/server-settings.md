---
title: Server settings (for operators)
description: What each row of the Operator view's This server card means, and how to change it on a self-hosted server or a Cloudflare one.
sidebar:
  order: 11
---

Operators (the accounts in `OPERATORS` on a self-hosted server, or `--operator` on Cloudflare)
see **Operator → This server** in the app: how the server is set up, one setting per row. It
never shows a secret: a key or token only shows as *set up* or not. The settings come from how
the server is started, so you change them there and restart (self-hosted) or deploy again
(Cloudflare, `apps/server-cloudflare/scripts/deploy.ts`; every deploy sets the flags, so leaving
one out turns it off again).

| Row | What it means | Self-hosted | Cloudflare |
| --- | --- | --- | --- |
| Version | The server software, and the phone protocol it speaks. | Update and restart. | Deploy a newer release. |
| Sign-up | *Open to anyone*: anyone can make an account (with their own household). *Invite only*: people join through invites. | `OPEN_SIGNUP=1` | `--open-signup` (needs TURN) |
| Bot check on sign-up | A Cloudflare Turnstile check on the sign-up form. | `TURNSTILE_SITE_KEY` and `TURNSTILE_SECRET` | `--turnstile-site-key`, `--turnstile-secret` |
| Add-ons | Whether people may link add-ons ([add-ons](../add-ons/)). Off: nobody can link one, and linked ones can't connect or be called. | `ADDONS=on` | `--addons` |
| Fair use | The monthly allowance per account, or *Unlimited*. Over it, new calls and messages are refused until next month; you can exempt an account. | `FAIR_USE=hub` and/or `FAIR_USE_CALL_MINUTES`, `FAIR_USE_ROOM_MINUTES`, `FAIR_USE_VOICEMAILS`, `FAIR_USE_VOICEMAIL_MB`, `FAIR_USE_KNOCKS`, `FAIR_USE_PHONES_PER_SPACE`, `FAIR_USE_SPACES_PER_ACCOUNT` | `--fair-use hub\|none` (on with `--open-signup`) |
| Call relay (TURN) | A relay so calls connect when two people can't reach each other directly. | `TURN_URLS` and `TURN_SECRET` (coturn) | `--turn-key-id`, `--turn-key-token` (or `TURN_KEY_ID`, `TURN_KEY_API_TOKEN`) |
| Rooms' audio | *Direct between people* (up to 4 in a room), or through a media relay (Cloudflare's SFU or your LiveKit). 1:1 calls never use it. | `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET` (or `SFU_APP_ID`, `SFU_APP_SECRET`) | `--sfu-app-id`, `--sfu-app-secret` |
| Transcripts | Speech-to-text for voicemail and recordings (each space can still turn it off). | `TRANSCRIBE_URL` (an OpenAI-compatible endpoint; `TRANSCRIBE_MODEL`, `TRANSCRIBE_API_KEY`) | Workers AI, on unless `--no-ai` |
| Call recording | Always each space's choice: off unless its admins turn it on, announced, never with a kids' phone ([call recording](../call-recording/)). | — | — |
| Calls other servers record | *Refused*: a recorded call from another server never reaches people here. | `REFUSE_RECORDED_CALLS=1` | `--refuse-recorded-calls` |
| Public address | The server's name in everyone's address; passkeys belong to it. Set it before people sign up. | `PUBLIC_URL` | `--domain` |
| Federation, Federation key, Offered to other servers | Whether people here can connect with other servers, this server's key fingerprint ([server keys](../server-keys/)) and the features other servers may use with it (add-on features only while add-ons are on). | On unless `FEDERATION=0`; needs `PUBLIC_URL` | Always on (`--domain`) |
| Funding shown, Sponsor button | The funding card (how many people the balance serves) and the Sponsor link in the app. | `FUNDING_BALANCE_USD` (and `BASE_COST_USD_PER_MONTH`, `COST_PER_ACTIVE_USER_USD_PER_MONTH`), `SPONSOR_URL` | `--funding-balance`, `--sponsor-url` |
| Operators | Who sees the Operator view. *An unknown account* is an id that matches nobody here. | `OPERATORS` (account ids, `acc_…`; the server logs the id for a handle) | `--operator handle` (looked up once; `--operator none` removes them) |
| Behind a proxy | Whether visitors' addresses come from your reverse proxy (for rate limits). | `TRUST_PROXY=1` | — |
| Changed limits | Rate limits set differently from the defaults (for example speed-dial pages per phone). | Set by the host code (`limits` in the server's environment) | — |

The same view lists **suspended** accounts and those **exempt from fair use**, each with its undo,
along with blocked servers, other servers' keys and the audit trail of every operator action.
