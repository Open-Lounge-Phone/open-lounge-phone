# Contributing

Thanks for helping! A few ground rules keep Open Lounge Phone dependable enough to hand to a child.

## Principles

1. **The protocol is the contract.** The browser emulator, desktop app, and ESP32 firmware all
   speak [docs/protocol.md](docs/protocol.md). Change `packages/protocol` deliberately: additive
   fields are fine; anything else bumps `PROTOCOL_VERSION`. Run `npm run docs:protocol` after edits.
2. **Default deny.** Access-control code must fail closed. New paths that can ring a device go
   through `authorizeInbound` / `authorizeOutbound` in `packages/core`.
3. **Pure core, thin adapters.** Domain logic lives in `packages/core` with no I/O so it runs on
   Cloudflare Workers, Node, and serves as the reference for firmware. Backends only adapt storage,
   sockets, and media.
4. **No hosted dependency.** Everything must work on a self-hosted box with no third-party
   accounts. Cloudflare is a first-class deploy target, never a requirement.

## Conventions

These apply to everyone, human or AI.

- **npm workspaces**, Node 22.18 or newer. `npm install` at the root sets up every package; there
  is no build step for the libraries in `packages/`: they export `src/index.ts` directly.
- **TypeScript:** `moduleResolution: Bundler`, and relative imports use the `.ts` extension
  (`import { x } from "./x.ts"`) so Node runs the sources directly. `erasableSyntaxOnly` is on:
  no enums, namespaces or constructor parameter properties.
- **Web-standard APIs in shared packages** (WebCrypto, fetch, WebSocket) so they run on Node,
  Workers and browsers. Node-only code goes in `*/node.ts` entry points or
  `apps/server-selfhost`.
- **`packages/core` stays pure:** no I/O and no clock reads; pass `now` in.
- **Biome** for lint and format: `npm run lint`, fix with `npx biome check --write .`
  (2 spaces, 100 columns).
- **Vitest**, with tests next to the code as `*.test.ts`.
- **Protocol:** `packages/protocol/src/messages.ts` (zod) is the source of truth. Messages are
  flat JSON `{ t: "type", id?, ... }` of at most 16 KiB. After a change run
  `npm run docs:protocol` and commit `docs/protocol.md`; CI fails if it is out of date. Additive
  optional fields keep `PROTOCOL_VERSION`; anything else bumps it.
- **Federation:** `docs/federation-spec.md` is the normative `/fed/v1` spec. Its endpoint, type
  and stream sections are generated from `packages/federation` (the zod schemas and
  `FED_ENDPOINTS`): run `npm run docs:federation` after changing them; CI fails if it is out of
  date. Follow its versioning rules (§9): only additive changes within `/fed/v1`.
- **Versions and features:** a version number means wire compatibility; features are additive
  capabilities within a version. A server advertises both (`.well-known` `versions`/`features`,
  `config.server`), uses an optional feature with a peer only if the peer lists it, and degrades
  in plain words otherwise. Receivers ignore unknown fields (no strict schemas on inbound
  payloads; size limits stay) and answer unknown messages "not supported" without hanging up.
  New federation features go into `FEATURES` in `packages/federation` (spec §9.2).
- **Frozen v1 vectors:** `tests/conformance/` holds golden vectors for the wire mechanics
  (RFC 9421 signature bases and signatures, `Content-Digest`, key-rotation and stream
  statements, example messages for every endpoint and the device protocol) and a snapshot of
  every v1 schema. **Never edit a v1 vector: a change that needs one is breaking, and breaking
  changes need v2** (a new federation version or `PROTOCOL_VERSION`, with new vectors beside
  the old). The snapshot only grows: after an additive change run
  `node tests/conformance/generate.ts snapshot`, which refuses anything that removes, renames,
  makes required or narrows a field. A new value in a closed enum is allowed in v1 only behind
  a feature (list it in `GATED` in `tests/conformance/schemas.ts`).
- **Default deny:** every path that can ring a device goes through `authorizeInbound` /
  `authorizeOutbound`; single-use tokens must be consumed atomically.
- **Hardware** sources are code under `hardware/` (see [hardware/README.md](hardware/README.md));
  generated outputs are not committed: `make build` / `make review` regenerate them.

## Workflow

- `npm run check` must pass (Biome lint/format, TypeScript, Vitest).
- The `Interop` workflow runs two servers against each other (self-hosted, and Workers under
  `wrangler dev`), and this server against the previous release in both directions
  (`tests/e2e/crossVersion.test.ts`); run `tests/e2e/cloudflare.test.ts` locally when you touch
  federation. To run the cross-version test locally, check out the pinned release tag somewhere,
  `npm ci` there, and set `OLP_BASELINE_DIR` to it.
- **Releases** of the server are git tags `server-vX.Y.Z` on main, where `X.Y.Z` is the root
  `package.json` version (also `SERVER_VERSION` in `packages/server-app/src/version.ts`; a test
  keeps them equal, and `.well-known` publishes it as `software`). After tagging, pin the new
  tag as `OLP_BASELINE_REF` in `.github/workflows/interop.yml`, so every later change is tested
  against it. Firmware (`fw-v*`) and hardware (`hw-v*`) have their own tags.
- Tests should fail when the behaviour they cover is broken — try reverting your fix and confirm.
- By contributing you agree your work is licensed under AGPL-3.0-or-later (software) or
  CERN-OHL-S-2.0 (hardware).
