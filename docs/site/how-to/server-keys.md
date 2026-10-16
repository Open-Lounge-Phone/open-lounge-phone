---
title: Server keys (for operators)
description: Rotate your server's federation key without breaking connections, and decide about another server whose key changed.
sidebar:
  order: 10
---

Every Open Lounge Phone server has a federation key. Other servers **pin** it the first time they
hear from yours (like SSH remembers a host), and refuse a different key later. This page is for
the people who run a server: the handles in `OPERATORS` (self-hosted) or `--operator`
(Cloudflare). Open **Operator** in the app.

## Rotate your key

Rotate routinely, or at once if you think the key may have leaked.

- **In the app:** Operator → *This server's federation key* → **Rotate key**, then confirm.
- **From a terminal** (either kind of server, e.g. from a script):

  ```sh
  OLP_SESSION_TOKEN=… npx openloungephone federation rotate-key --url https://phone.example.com
  ```

  Get the token from Operator → **Copy session for the CLI** (treat it like a password; leave it
  out and you're asked for it without echo). Add `--yes` to skip the question.

What happens:

1. Your server makes a new key and signs with it straight away.
2. For **7 days** its public discovery document lists both keys, with the old key's signed
   hand-over to the new one.
3. Servers that contact yours in those 7 days check the hand-over and switch to the new key by
   themselves. Calls in progress carry on.
4. A server that doesn't hear from you for the whole week can't follow; its operator will see
   your key change as refused and can re-trust it (below). Tell them your new fingerprint.
5. Servers that don't support following a rotation at all (they don't list `key-rotation`)
   are named when you rotate, so you know whose operators to tell. The Operator view shows what
   each server you know runs: its software, federation versions, and the extras it lacks.

A second rotation during the 7 days is refused unless you force it (`--force`, or confirm in the
app), because servers still on your first key would lose track.

**Where the key lives.** Self-hosted: `federation-key.jwk` in your data directory, plus
`federation-key.previous.json` during the hand-over — back them up together. Cloudflare: the
new key is kept in your D1 database, sealed by the `FED_PRIVATE_KEY` secret, so rotating needs
no redeploy. Never replace that secret: the deploy script sets it once and leaves it alone.
Keys are never shown or printed; you only ever see **fingerprints** (`SHA256:…`).

## Another server's key changed

Operator → *Other servers' keys* lists every server yours has talked to: its fingerprint, when
you first saw it, and **pinned** or **key change refused**.

A refused change means that server now presents a key without a valid hand-over — it lost its
key, rotated while you weren't in touch, or someone else took its name. Until you decide,
nothing from it gets through.

- **Re-trust…** shows the pinned and the new fingerprint and replaces the pin once you confirm.
  Only do it after that server's operator has told you the new fingerprint some other way
  (a message, a call).
- **Block server…** fills in the block form instead, if you'd rather not talk to it at all.

## Audit trail

The bottom of the Operator view lists what operators did — rotations, re-trusts, blocks,
suspensions, fair-use exemptions — and the key changes your server followed or refused by
itself, with who and when.

The exact rules are in the [federation spec](/reference/federation-spec/#32-rotation); the
overview is in [Federation](/reference/federation/#key-rotation-implemented).
