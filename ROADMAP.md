# BrainOS — Roadmap
v5.0.0 · SISO-native · Enterprise Grade

---

## Phase 0 — Critical Bug Fixes ✓ COMPLETE (v5.0)
- [x] Fatal `const url = ;` syntax error
- [x] Duplicate `uid()` declaration in strict mode
- [x] Double `display:none` on overlays
- [x] All errors toast + log — nothing pretends

## Phase 1 — Event Bus ✓ COMPLETE (v5.0)
- [x] `bus.js` — SISO-native typed event bus
- [x] All modules wired to bus (no direct calls)
- [x] Wildcard subscriptions, replay buffer, audit log

## Phase 2 — Network Stack ✓ COMPLETE (v5.0)
- [x] `dns-server.js` — Custom DNS from scratch
- [x] `ddns.js` — Dynamic DNS, no port-forward
- [x] `reverse-proxy.js` — HTTP/HTTPS reverse proxy
- [x] `firewall.js` — Rule engine + OS integration
- [x] JSON filter import (variables, sigmas, deltas, invariants)
- [x] Cloudflare + No-IP + DynDNS2 DDNS providers
- [x] Blocked request logging (JSONL, loud)

## Phase 3 — Agent Routing ✓ COMPLETE (v5.0)
- [x] `routing-engine.js` — if/then/when/fail chains
- [x] Timer, cron, heartbeat, CLI, intent, data triggers
- [x] Clocky / Make / n8n / Zapier integration
- [x] Framework injection per step
- [x] Conversation capture to log
- [x] Input→output feedback loops
- [x] Bridge + API step types

## Phase 4 — Jaa Integration PLANNED
- [ ] Jaa SQL engine as persistence backend (replace localStorage + JSONL)
- [ ] Workflow state in Jaa tables
- [ ] Delta log queryable via SQL
- [ ] Bridge `/jaa/query` endpoint

## Phase 5 — NEXUS Plugin Integration PLANNED
- [ ] Plugin Phase 3: Claude.ai chat listener per agent
- [ ] MutationObserver — live conversation capture
- [ ] Idea extraction pipeline → bridge `/delta/idea`
- [ ] Plugin ↔ BrainOS routing trigger hook

## Phase 6 — Mesh Intelligence PLANNED
- [ ] Topology auto-layout (force-directed)
- [ ] Delta replay — scrub timeline, reconstruct state
- [ ] Anomaly detection from delta history
- [ ] Auto-heal — detect failed tunnels, suggest reroutes
- [ ] Invariant alerts — sigma threshold notifications

## Phase 7 — Hardening PLANNED
- [ ] Onion routing — multi-hop relay
- [ ] DHT discovery — Kademlia, no central signaling
- [ ] Ed25519 + ChaCha20-Poly1305 cipher support
- [ ] Distributed key authority — Shamir secret sharing
- [ ] Hardware bridge nodes (Raspberry Pi image)
