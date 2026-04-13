# BrainOS v5.0
**Integrated Control Canvas · SISO-native · Enterprise Grade · Military Security**

> Event → Gate → Stream. Everything is alive. Everything fails loudly.

BrainOS is a unified control canvas for managing AI agent pipelines, peer-to-peer mesh networks, workflow automation, DNS infrastructure, firewall rules, and real-time Bayesian routing intelligence — all wired through a typed event bus built on the SISO framework.

---

## Quick Start

```bash
# 1. Start the bridge server
node nexus-bridge-server-v2.js

# 2. Open the control canvas
open BrainOS.html

# 3. Optional: start DNS server (requires Node 16+)
node -e "const {BrainOSDNS}=require('./dns-server'); new BrainOSDNS({port:5353}).start()"
```

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│  BrainOS.html — Integrated Control Canvas v5.0                      │
├──────────┬─────────┬──────────┬──────────┬────────────┬────────────┤
│  CANVAS  │PIPELINE │AUTOMATION│  CONTROL │    DNS     │    HELP    │
│  BAYES   │WORKFLOW │ ROUTING  │   KEYS   │  FIREWALL  │  SETTINGS  │
├──────────┴─────────┴──────────┴──────────┴────────────┴────────────┤
│  bus.js — SISO-native Event Bus (Event → Gate → Stream)             │
├──────────┬──────────┬──────────┬────────────┬────────────┬─────────┤
│ snr-     │ crypto-  │ key-     │  routing-  │ dns-       │firewall │
│ filter   │ engine   │ manager  │  engine    │ server     │         │
├──────────┴──────────┴──────────┴────────────┴────────────┴─────────┤
│  host-rotation · port-registry · ddns · reverse-proxy               │
├─────────────────────────────────────────────────────────────────────┤
│  nexus-bridge-server-v2.js — HTTP transport + AI proxy              │
│  bridge-canvas-persistence.js — Storage foundation                  │
├─────────────────────────────────────────────────────────────────────┤
│  src/siso/ — SISO Core (Event · Gate · Stream · StreamLog)          │
│  data/     — All persistent state (atomic writes)                   │
└─────────────────────────────────────────────────────────────────────┘
```

---

## Module Registry

| Module | File | UUID | Version |
|--------|------|------|---------|
| Event Bus | `bus.js` | `brainos-bus-module-v5000-0000-000000000001` | 5.0.0 |
| DNS Server | `dns-server.js` | `brainos-dns-server-v5000-0000-000000000002` | 5.0.0 |
| Firewall | `firewall.js` | `brainos-firewall-v5000-0000-000000000003` | 5.0.0 |
| Routing Engine | `routing-engine.js` | `brainos-routing-v5000-0000-000000000004` | 5.0.0 |
| DDNS Client | `ddns.js` | `brainos-ddns-module-v5000-0000-000000000005` | 5.0.0 |
| Reverse Proxy | `reverse-proxy.js` | `brainos-rproxy-v5000-0000-000000000006` | 5.0.0 |
| SNR Filter | `snr-filter.js` | `snr-filter-module-v1000-0000-000000000001` | 1.0.0 |
| Crypto Engine | `crypto-engine.js` | `crypto-engine-module-v1000-0000-000000000001` | 1.0.0 |
| Key Manager | `key-manager.js` | `key-manager-module-v1000-0000-000000000001` | 1.0.0 |
| Host Rotation | `host-rotation.js` | `host-rotation-module-v1000-0000-000000000001` | 1.0.0 |
| Port Registry | `port-registry.js` | `port-registry-module-v1000-0000-000000000001` | 1.0.0 |
| Canvas Persist | `bridge-canvas-persistence.js` | `bridge-canvas-persist-0001-phase1-foundation` | 1.0.0 |
| SISO Core | `src/siso/` | `siso-core-f0und4t10n-layer-0000-000000000001` | 1.0.0 |

---

## Tabs

| Tab | Description |
|-----|-------------|
| **CANVAS** | Live mesh node visualization. Pan, zoom, drag nodes. |
| **CONTROL** | SNR gate, invariant comparison, delta log, sessions. |
| **DEPLOY** | Add/deploy new bridge nodes. |
| **PLAYWRIGHT** | Browser automation via bridge. |
| **KEYS** | Key rotation — session, e2e, gate, TURN. |
| **BAYES** | Bayesian belief engine for routing decisions. |
| **PIPELINE** | Visual agent pipeline builder. Step chains, run, log. |
| **AUTOMATION** | Workflow builder. If/then/when/fail. Multi-schedule. |
| **NETWORK** | DNS server, DDNS, firewall rules, reverse proxy. |
| **HELP** | Full in-app documentation. |

---

## Design Axioms

1. **Everything fails loudly** — toast + log + event. Never silent.
2. **Nothing pretends to work** — no stubs, no mock data, no silent failures.
3. **Everything has a UUID** — modules, rules, workflows, nodes, events.
4. **Event bus only** — modules communicate via bus, not direct function calls.
5. **Bottom-up only** — storage first, transport second, UI last.
6. **Enterprise grade code, military grade security.**
7. **Persistence is the golden rule** — atomic writes, nothing lost on crash.
8. **SISO native** — Event → Gate → Stream for all module logic.

---

## SISO Foundation

BrainOS is built on the [SISO Core](src/siso/) framework:
- `Event` — a datum flowing through the system. Type + data.
- `Gate` — recognizes one event type, transforms it. O(1) lookup.
- `Stream` — the processing loop. Depth-first, synchronous.
- `StreamLog` — shared audit trail across all streams.

The event bus (`bus.js`) is a SISO Stream exposed as a typed pub/sub interface.

---

## Related Projects

- **SISO Core** — Foundation event framework. `src/siso/`
- **Jaa** — SQL database engine built on SISO. Planned integration for BrainOS state persistence.
- **NEXUS Plugin** — Browser extension connecting claude.ai to BrainOS bridge.

---

## File Map

### Essential (always deploy)
```
BrainOS.html                ← Control canvas (open in browser)
nexus-bridge-server-v2.js   ← Bridge server (node nexus-bridge-server-v2.js)
nexus-bridge-modules.js     ← Module wire layer
bridge-canvas-persistence.js← Storage
snr-filter.js               ← SNR gate
crypto-engine.js            ← Crypto primitives
key-manager.js              ← Key lifecycle
host-rotation.js            ← Host rotation
port-registry.js            ← Port registry
bus.js                      ← Event bus (v5 new)
routing-engine.js           ← Agent routing (v5 new)
```

### Network stack (optional, enable per-feature)
```
dns-server.js               ← Custom DNS server (UDP :5353)
ddns.js                     ← Dynamic DNS client
firewall.js                 ← Firewall rule engine
reverse-proxy.js            ← HTTP reverse proxy
```

### Data (auto-created)
```
data/
  canvas-state.json         ← Canvas snapshot
  dns-config.json           ← DNS zones + blocklist
  fw-rules.json             ← Firewall rules
  routing-workflows.json    ← Automation workflows
  conversation-log.jsonl    ← Full conversation capture
  dns-blocked.jsonl         ← Blocked request log
  fw-blocked.jsonl          ← Firewall block log
```
