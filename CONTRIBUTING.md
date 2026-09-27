# Contributing

Thanks for helping! A few ground rules keep OpenTinCan dependable enough to hand to a child.

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

## Workflow

- `npm run check` must pass (Biome lint/format, TypeScript, Vitest).
- Tests should fail when the behaviour they cover is broken — try reverting your fix and confirm.
- By contributing you agree your work is licensed under AGPL-3.0-or-later (software) or
  CERN-OHL-S-2.0 (hardware).
