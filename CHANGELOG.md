# BrainOS — Changelog

## [5.0.0] — 2026-04-12

### Critical Bug Fixes (were causing blank screen / JS failure)
- **FIXED** Fatal syntax error `const url = ;` in `bayesForceUpdate()` at line 3131 — killed entire script block
- **FIXED** Duplicate `uid()` declaration — `const` at line 1480 AND `function` at line 3809 — caused `SyntaxError` in strict mode
- **FIXED** Double `display:none` on `#pipeline-overlay` and `#automation-overlay` — fought JS `display:flex` toggle

### New Modules (v5)
- **bus.js** — SISO-native typed event bus. All modules now communicate via bus only. Wildcard subscriptions, replay buffer, full audit log.
- **routing-engine.js** — Agent routing engine. If/then/when/fail condition chains. Timer, cron, heartbeat, CLI, data, intent triggers. Feedback loops. Framework injection. Conversation capture to log.
- **dns-server.js** — Full DNS server from scratch (UDP/53). Local zone, recursive resolver, blocklist, DDNS, cache. Import blocklists (uBlock/Pi-hole/hosts format).
- **ddns.js** — Dynamic DNS client. No-port-forward. Cloudflare, No-IP, DynDNS2, internal. Auto-detects public IP change.
- **firewall.js** — Rule-based firewall engine. IP/CIDR, port, protocol, intent, path, user-agent. JSON filter import with variables, sigmas, deltas, invariants. Windows Defender + Linux UFW sync hooks. Request logging.
- **reverse-proxy.js** — HTTP/HTTPS reverse proxy. SNI routing. WebSocket tunnel (CONNECT). Firewall middleware hookpoint.

### New Features (BrainOS.html)
- **NETWORK tab** — DNS server control, DDNS management, firewall rules, reverse proxy config
- **HELP tab** — Full in-app documentation from README + docs/
- **JSON filter import** — Import firewall/SNR filters via JSON engine. Variables, sigmas, deltas, invariants. Format documented in help tab.
- **Conversation logging** — Capture full workflow conversation to structured JSONL log
- **Integration adapters** — Clocky, Make, n8n, Zapier as first-class pipeline step types
- **Framework injection** — Inject engine/framework per step in routing workflows
- **NEXUS Plugin roadmap** — Phase 3 updated: Claude.ai chat listener for each agent chat

### Architecture
- All modules now emit bus events instead of calling functions directly
- SISO Core bundled at `src/siso/` (Event, Gate, Stream, StreamLog)
- CJS wrapper at `src/siso/index.cjs` for Node.js require() compatibility

### Docs
- Full `README.md` at root
- `CHANGELOG.md` (this file)
- `MANIFEST.json` updated with all new module UUIDs
- `ROADMAP.md` updated through Phase 6
- Per-module `.md` files in `docs/modules/`

## [4.0.0] — 2026-04-08 (previous)
- Pipeline canvas, automation tab, Bayesian engine, SNR gate, key manager UI
- Bridge canvas persistence, host rotation, port registry
- 364/364 module tests passing

## [3.2.0] — 2026-04-07
- Phase 1 complete: storage layer, SNR filter v1, crypto engine, key manager, host rotation, port registry
- 364/364 tests passing
