# NEXUS · Guardian · Causal-Nexus
## Technical Reference — v0.51.0 / Bridge v3.11.0 / Guardian v3.4.0

> **60,000 lines. 76 tests passing. Zero external AI API keys required for browser routing.**

---

## Table of Contents

1. [Architecture Overview](#1-architecture-overview)
2. [System Components](#2-system-components)
3. [NEXUS Electron Application](#3-nexus-electron-application)
4. [Guardian Firefox Extension](#4-guardian-firefox-extension)
5. [Bridge Server v3.11.0](#5-bridge-server-v3110)
6. [Causal-Nexus Event Engine](#6-causal-nexus-event-engine)
7. [BrainOS Canvas](#7-brainos-canvas)
8. [Process Architecture & Crash Recovery](#8-process-architecture--crash-recovery)
9. [Network & LAN/DDNS](#9-network--landdns)
10. [AI Routing & Intent System](#10-ai-routing--intent-system)
11. [Callto Pipeline](#11-callto-pipeline)
12. [IR Layer & Causal Graph](#12-ir-layer--causal-graph)
13. [UUID & Hook Registry](#13-uuid--hook-registry)
14. [Test Environment](#14-test-environment)
15. [Forge IDE & DeepScan](#15-forge-ide--deepscan)
16. [APK Builder](#16-apk-builder)
17. [Build, Package & Deploy](#17-build-package--deploy)
18. [API Reference — All Endpoints](#18-api-reference--all-endpoints)
19. [SSE Event Reference](#19-sse-event-reference)
20. [Integration Guide](#20-integration-guide)

---

## 1. Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────┐
│  NEXUS Electron App  (Chromium renderer + Node main process)        │
│  ┌───────────┐  ┌──────────┐  ┌──────────┐  ┌──────────────────┐  │
│  │  FORGE    │  │ CONSOLE  │  │ BUILDER  │  │ TEST ENV / DIAG  │  │
│  │  IDE      │  │ AI chat  │  │ Projects │  │ 25-check suite   │  │
│  └───────────┘  └──────────┘  └──────────┘  └──────────────────┘  │
│              IPC / contextBridge (preload.js)                        │
├─────────────────────────────────────────────────────────────────────┤
│  main.js  (Electron main — single instance lock, tray, crash log)   │
│  ┌──────────────────┐  ┌──────────────┐  ┌──────────────────────┐  │
│  │  Bridge process  │  │ Watchdog     │  │  Crash logger        │  │
│  │  detached:true   │  │ detached:true│  │  ring buffer 500     │  │
│  │  :3747 all ifs   │  │ nexus-svc.js │  │  nexus-crash.log     │  │
│  └──────────────────┘  └──────────────┘  └──────────────────────┘  │
└─────────────────────────────────────────────────────────────────────┘
         │ HTTP/SSE                              │ HTTP/SSE
         ▼                                       ▼
┌─────────────────────┐           ┌──────────────────────────┐
│  Guardian v3.4.0    │           │  BrainOS Canvas           │
│  Firefox Extension  │           │  Single HTML file         │
│  MV2                │◄──────────│  Live mesh visualization  │
│  IR Layer           │           │  WebRTC / TURN / SSE      │
│  URCK causal        │           │  Pipeline builder         │
└─────────────────────┘           └──────────────────────────┘
         │ HTTP                              
         ▼                                  
┌─────────────────────────────────────────────────────────┐
│  Causal-Nexus v4.3.0 / v1.0.0                           │
│  14 modules · 587 tests                                  │
│  identity / time / causality / kernel / adapter          │
│  projection / lazy / delta / compress / gui              │
│  forge / loader / persist / query                        │
└─────────────────────────────────────────────────────────┘
```

### Data flows

**Browser AI routing (no API key):**
```
Your code → POST /v1/messages {provider:'guardian', agentId:'chatgpt'}
         → Bridge → SSE guardian:ai:request → Guardian extension
         → Guardian types text into ChatGPT tab
         → Listener captures ChatGPT response
         → POST /ingest guardian.link.event → Bridge SSE → Your code
```

**Direct API routing:**
```
POST /v1/messages {provider:'deepseek', messages:[...]}
  → Bridge → resolves intent chain → deepseekChat()
  → DeepSeek API → response
  → Response 200 synchronous
```

**Causal event chain:**
```
Any action → kernel.ingest(type, payload, source)
  → identity layer: UUID v4, contentHash, dedupKey
  → time layer: kernel-local clock tick
  → causality layer: EDGE_CAUSAL_EXPLICIT edge
  → gate pipeline: ErrorEscalation / DOMStability / SessionBoundary
  → listeners + SSE bus emit
  → ring buffer (500 events hot)
  → WAL flush → archive (cold)
```

---

## 2. System Components

| Component | Location | Language | Lines | Tests |
|---|---|---|---|---|
| NEXUS Electron app | `nexus.html` + `src/ui/` | HTML/JS | ~30,400 | 76 |
| Electron main | `main.js` | Node.js | 955 | — |
| Preload bridge | `preload.js` | Node.js | 126 | — |
| Bridge server | `bridge/nexus-bridge-server.js` | Node.js | 2,364 | 76 |
| Ollama Python service | `bridge/nexus-ollama-service.py` | Python/FastAPI | 570 | — |
| Guardian extension | `GUARDIAN-v3/` | JS MV2 | ~3,600 | — |
| Causal-Nexus engine | `modules/` | ESM JS | ~12,000 | 587 |
| BrainOS canvas | `BrainOS-v2.html` | Single HTML | 5,523 | — |
| Service layer | `service/` | Node.js | 1,766 | — |
| Crash logger | `src/crash-logger.js` | Node.js | 352 | — |

---

## 3. NEXUS Electron Application

### Main tabs

| Tab | Purpose |
|---|---|
| HOME | AI mode selector, project overview, quick actions |
| CONSOLE | Multi-agent AI chat, Guardian-wired sessions |
| FORGE | Full IDE: editor, co-pilot, compiler, test bridge |
| PROJECTS | Project manager with UUID tracking |
| ROADMAP | Structured roadmap and milestone tracking |
| IDEAS | Idea capture with causal tagging |
| ENGINES | AI provider configuration and testing |
| ENHANCE | AI-powered code enhancement |
| OPTIONS | Bridge, AI settings, diagnose, hooks |
| LOG | UUID registry, session timeline, event inspector |
| BUILDER | New project wizard and code generation |
| TESTS | Full test runner with live results |

### Options sub-tabs

| Sub-tab | Purpose |
|---|---|
| AI SETTINGS | Provider keys, model selection, intent mapping |
| CONSOLE | Console configuration and Guardian wiring |
| BUILDER | Build target and compiler settings |
| DATA | Data directory, WAL, archive management |
| BRIDGE | Bridge URL, LAN, DDNS, endpoint health |
| DIAGNOSE | 25-check diagnostic suite, crash log viewer |
| HOOKS | Hook registry browser, UUID inspector |

### Process model

```
NEXUS.exe (Electron main)
├── Renderer process (Chromium — nexus.html)
├── Bridge (Node.js — detached, survives crash)
│   └── :3747 HTTP/SSE server
├── Ollama Python (FastAPI — detached)
│   └── :3748 HTTP REST
└── Watchdog (Node.js — detached, survives crash)
    └── Monitors nexus-app.pid every 3s
```

### Single-instance enforcement

`app.requestSingleInstanceLock()` — Electron's OS-level lock. If a second instance launches:
- New instance: `app.quit()` + `process.exit(0)` immediately
- First instance receives `second-instance` event → shows hidden window

**Critical implementation note:** When window is hidden to tray, `mainWindow.isVisible() === false` but `mainWindow.isMinimized() === false`. The `second-instance` handler must check `!mainWindow.isVisible()` and call `show()`, not just `focus()`.

### Tray behavior

| Setting | Default | Effect |
|---|---|---|
| Close to Tray | ON | X button hides window, bridge keeps running |
| Minimize to Tray | ON | Minimize hides to tray |

Persisted to `{userData}/nexus-tray-prefs.json`. `window-all-closed` does **not** call `app.quit()` — uses `app.exit(0)` to avoid the recursive event loop.

### IPC surface (preload.js contextBridge)

```javascript
window.electronAPI = {
  getCrashLog:    () => ipcRenderer.invoke('nexus:crash-log'),
  clearCrashLog:  () => ipcRenderer.invoke('nexus:crash-log-clear'),
  getNetworkInfo: () => ipcRenderer.invoke('nexus:network-info'),
  runFullDiag:    () => ipcRenderer.invoke('nexus:diag-full'),
  // + 20 more: bridge-start, bridge-stop, open-external, version, etc.
}
```

---

## 4. Guardian Firefox Extension

### Files

| File | Purpose |
|---|---|
| `manifest.json` | MV2 manifest, permissions, content script declaration |
| `background.js` | Bridge communication, Guardian state machine, callto registry |
| `content.js` | Element picker, callto popup, listener modal, ZERO-REFLOW picker |
| `popup.js` | Extension popup UI, connection status, callto list |
| `popup.html` | Extension popup HTML |
| `ir-layer.js` | Causal IR layer — pulse, ingest, node discovery |
| `urck.js` | URCK causal engine adapter — typeIndex pruning, seenMap LRU |

### How element capture works

1. User clicks Guardian icon → activates picker mode
2. `content.js` intercepts hover events with ZERO-REFLOW algorithm:
   - Uses `elementsFromPoint()` — no style mutation, no reflow
   - `fingerprint(el)` generates a stable CSS selector via tag + classes + position
   - SVG-safe: handles `<svg>`, `<use>`, `<foreignObject>` correctly
3. User clicks element → popup appears with:
   - CSS selector
   - Element type detection (input, button, contenteditable, etc.)
   - Action options: CLICK, TYPE, SUBMIT, LISTEN
4. User clicks CALLTO → `genCalltoId()` → UUID-based callto ID
5. `POST /userscript/callto` registers with bridge
6. Bridge emits `guardian.callto.captured` on SSE bus
7. Bridge persists to `bridge/data/agent-hooks.json`

### Callto actions

| Action | What Guardian does |
|---|---|
| `click` | `element.click()` |
| `type` | Focuses element, dispatches keyboard events char by char |
| `submit` | Finds and submits parent form |
| `listen` | Adds MutationObserver, captures DOM changes as response |

### IR Layer (ir-layer.js)

The IR (Intermediate Representation) layer sits between the extension and the bridge. It:
- Sends `POST /pulse` every 1.5s with `instanceId`, `logicalId`, `status`
- Sends `POST /ingest` for every causal event (callto running, resolved, error)
- Discovers other nodes via `GET /network/info`
- Maintains a local causal graph via URCK kernel

```javascript
// IR pulse payload
{
  type:       'guardian:pulse',
  instanceId: 'guardian-6f5a028e-4589-43f3-9a61-0c83ce2e9715',
  logicalId:  'guardian',
  nexusUrl:   'http://127.0.0.1:3747',
  bridgeUrl:  'http://127.0.0.1:3747',
  status:     'online',
  ts:         1234567890123
}
```

### instanceId format

```
guardian-{uuid-v4}
Example: guardian-6f5a028e-4589-43f3-9a61-0c83ce2e9715
ShortId:          6f5a028e   ← first 8 chars after prefix
```

---

## 5. Bridge Server v3.11.0

### Configuration

```bash
NEXUS_HOST=0.0.0.0        # default — all interfaces
NEXUS_PORT=3747            # default
NEXUS_NODE_BIN=/path/node  # override node binary (critical for packaged Electron)
DATA_DIR=/path/to/data     # bridge data directory
PROFILES_DIR=/path/prof    # browser profile directory
```

### Network binding

Bridge now binds `0.0.0.0` by default — accepts LAN connections. `getLocalIP()` detects the first non-internal IPv4 at startup.

```
🧠 NEXUS Bridge v3.11.0  →  http://192.168.1.42:3747
   Local:    http://127.0.0.1:3747
   Network:  http://192.168.1.42:3747  ← LAN connections
   DDNS:     http://home.example.com:3747  (if configured)
```

### Complete endpoint table

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/health` | none | Bridge status, version, LAN IP, uptime |
| GET | `/network/info` | none | All addresses: local/lan/ddns/shortId/endpoints |
| POST | `/pulse` | optional | Heartbeat — emits `guardian-pulse` on bus |
| GET | `/pulse` | none | Probe only |
| POST | `/ingest` | optional | IR layer causal event ingest |
| POST | `/guardian/handshake` | none | Register, receive 60s token |
| POST | `/guardian/heartbeat` | token | Refresh token TTL |
| GET | `/guardian/status` | none | Connection state, sessions, nodes |
| POST | `/guardian/agent-hook` | none | Wire agentId → calltoId |
| GET | `/guardian/agent-hooks` | none | All wired hooks |
| POST | `/userscript/callto` | none | Register a callto element |
| GET | `/userscript/callto` | none | List all calltos |
| POST | `/userscript/callto/:id/exec` | none | Execute callto action |
| POST | `/v1/messages` | optional | AI routing — all providers |
| POST | `/bus/emit` | none | Broadcast to all SSE subscribers |
| GET | `/events` | none | SSE stream — all bus events |
| GET | `/log` | none | Recent bridge log entries |
| POST | `/config` | none | Set API keys, DDNS URL |
| GET | `/intent` | none | Get intent routing map |
| PUT | `/intent/:name` | none | Update intent chain |
| POST | `/intent/reset` | none | Reset to defaults |
| GET | `/profiles/detect` | none | Detect browser profiles |
| GET | `/profiles/active` | none | Active profile |
| POST | `/profiles/activate` | none | Activate a profile |
| GET | `/direct/ollama` | none | Probe Ollama availability |
| GET | `/direct/lmstudio` | none | Probe LM Studio |
| GET | `/direct/deepseek` | none | Probe DeepSeek |
| POST | `/deepscan/run` | apiKey | Run adversarial code audit |
| GET | `/deepscan/history` | none | Last 50 scan results |
| GET | `/gen/human-profile` | none | Generate synthetic user data |
| GET | `/delta/recent` | none | Recent delta events |
| GET | `/delta/stats` | none | Delta statistics |
| GET | `/chain` | none | Chain status |

### AI provider resolution

```javascript
// Intent chains — resolved at request time
DEFAULT_INTENT = {
  code:        { providers: ['deepseek','claude','chatgpt'] },
  analysis:    { providers: ['deepseek','claude','gemini'] },
  reasoning:   { providers: ['deepseek','claude','chatgpt'] },
  creative:    { providers: ['claude','chatgpt','gemini'] },
  research:    { providers: ['perplexity','deepseek','claude'] },
  fast:        { providers: ['gemini','grok','chatgpt'] },
  local:       { providers: ['ollama','lmstudio'] },
  default:     { providers: ['ollama','deepseek','claude','chatgpt'] }
}

// Resolution order for provider:'auto':
// 1. intent chain (if intent param present)
// 2. DEFAULT_INTENT.default: ollama → deepseek → claude → chatgpt
// 3. First provider with configured key wins

// Guardian provider (no API key, uses browser):
// POST /v1/messages {provider:'guardian', agentId:'chatgpt'}
// → looks up agent-hooks.json for chatgpt calltoId
// → dispatches via callto, response arrives async via SSE
```

### SSE bus

The bridge maintains a single `EventEmitter` (`BUS`) with up to 100 listeners. All SSE connections subscribe to `BUS.on('event', ...)`. Events are emitted with `busEmit(type, payload, level)` which:
1. Pushes to in-memory `EVENTS[]` array (last 500)
2. Emits on `BUS`
3. All active SSE connections write `data: {json}\n\n`

### CORS

All responses include:
```
Access-Control-Allow-Origin: *
Access-Control-Allow-Methods: GET, POST, PUT, DELETE, OPTIONS
Access-Control-Allow-Headers: Content-Type, X-Guardian-Token, Authorization
```
OPTIONS preflight returns 204 with no body.

---

## 6. Causal-Nexus Event Engine

### Module dependency graph

```
identity   ──────────────────────────────────── (no deps)
time       ──────────────────────────────────── (no deps)
causality  ──────────────────────────────────── (no deps)
projection ──────────────────────────────────── (no deps)
lazy       ──────────────────────────────────── (no deps)
kernel     ← identity, time, causality
adapter    ← causality, kernel
delta      ← identity, lazy
compress   ← kernel, adapter
gui        ← kernel, adapter, compress, delta, projection, lazy
forge      ← kernel, compress
loader     ← kernel
persist    ← kernel, compress
query      ← kernel
```

### Design laws (inviolable)

| Law | Rule |
|---|---|
| I-1 | `event.id` is UUID v4 — never deterministic, never reused |
| I-2 | `contentHash` is orthogonal to `eventId` |
| C-1 | Every edge has explicit `edgeType` declared at ingestion |
| C-2 | `macro:detected` never a kernel event — projection only |
| C-4 | Gates execute before listeners |
| T-1 | Each kernel instance has its own clock — no global state |
| A-2 | Gates return `GateOutput[]` — never call `ingest()` directly |
| H-1 | Edge graph bounded — pruned on ring eviction |
| H-2 | `typeIndex` is O(1) — `Set<id>` per type |
| H-3 | `query.typeIds()` returns defensive copy |
| H-6 | `seenMap` LRU-capped at 10,000 entries |

### Kernel pipeline (per ingest)

```
kernel.ingest(type, payload, source, causedBy?)
  │
  ├── 1. Identity: newEventId(), contentHash(), dedupKey()
  ├── 2. Time: clock.nextTick() → eventTs
  ├── 3. Causality: createEdge(EDGE_CAUSAL_EXPLICIT)
  ├── 4. Ring buffer push (evicts oldest if at cap)
  │   └── On evict: causal.pruneEdgesFor(evictedId)
  ├── 5. idIndex update (O(1) findById)
  ├── 6. typeIndex update (Set<id> per type — O(1))
  ├── 6b. calltoMap TTL check
  ├── 7. Macro detection (macrosByPattern Map — O(1))
  ├── 8. Gate pipeline (sorted by priority)
  │   ├── ErrorEscalation (priority 10)
  │   ├── DOMStability (priority 20)
  │   ├── SessionBoundary (priority 30)
  │   └── Custom gates (default priority 50)
  │   Gate output: GateOutput[] → applied atomically after all gates run
  ├── 9. Listeners called
  └── 10. version++
```

### CQL — Causal Query Language

```sql
FIND events WHERE type = 'command:failed' AND payload.retryCount >= 3 LIMIT 20
FIND events WHERE CAUSED_BY type = 'command:running'
FIND events WHERE type = 'dom:changed' AND WITHIN 500 ticks OF 'page:navigated'
FIND chains WHERE type = 'alert:critical' ORDER BY depth DESC LIMIT 5
FIND events WHERE source ~= 'element' AND type IN ('command:running','command:failed')
```

Scopes: `events` | `chains`
Operators: `=` `!=` `>` `<` `>=` `<=` `~=` `IN`
Conditions: `AND` `OR` `NOT` `CAUSED_BY` `HAS_CHILD` `WITHIN N ticks OF`

Execution plans:
- `typeIndex` scan: O(1) seed from Set<id> per type, then O(k) filter
- `full-scan`: O(n) when no type constraint

### Persistence tiers

| Tier | Storage | Implementation |
|---|---|---|
| HOT | Kernel ring buffer | In-memory, 500 events, O(1) push/evict |
| WARM | WAL | Flushed every N ingests, cleared after snapshot |
| COLD | Archive | Evicted events moved here instead of discarded |

Backends: `memory` (tests), `indexeddb` (browser), `filesystem` (Node.js — `.causal-nexus/`)

Recovery sequence: snapshot restore → WAL replay → `nexus:persist:recovered`

---

## 7. BrainOS Canvas

### Node types

| Type | Color | Icon | Radius | Role |
|---|---|---|---|---|
| `guardian` | `#00ff88` | ⟁ | 32px | Firefox extension |
| `nexus` | `#00d4ff` | ◈ | 30px | NEXUS Electron app |
| `bridge` | `#00e5a0` | ◎ | 34px | Bridge server |
| `callto` | `#cc44ff` | ⬡ | 20px | Captured page element |
| `vps` | `#ff6b35` | ⬢ | 30px | Remote VPS node |
| `relay` | `#7c4dff` | ⬡ | 26px | P2P relay |
| `stun` | `#ffd740` | ✦ | 22px | STUN server |
| `peer` | `#4fc3f7` | ○ | 22px | Peer connection |

### Heartbeat visualization

| Age since last pulse | Status | Visual |
|---|---|---|
| < 15s | online | Triple-ring glow, color shadow |
| 15–30s | idle | Cyan, no glow |
| > 30s | dead | Red pulsing ring + ✕ overlay |

### Right-click context menu

`canvas.addEventListener('contextmenu')` → `hitCluster(wx, wy)` hit-test → `openCtxMenu(node, x, y)`

Wire section built with `createElement` (no string concatenation) — shows:
- shortId + copy button
- Callto list with wired/unwired state dots
- Click to wire: `_wireNodeToCallto(nodeId, calltoId)` → syncs to `POST /guardian/agent-hook`

### Auto node creation from SSE

```javascript
// On guardian-pulse event:
gEnsureNode('guardian-' + sid, 'Guardian', 'guardian', instanceId)
// On guardian.callto.captured:
gEnsureNode('callto-' + ct.id, selector.slice(0,14), 'callto', ct.id)
// On handshake success:
gEnsureNode('nexus-bridge', 'Bridge', 'bridge', 'bridge')
```

`gEnsureNode()` auto-connects new nodes to the nearest bridge with a typed tunnel.

### Labeled pulse packets

```javascript
// Tunnel packets — multiple per tunnel, type-colored
{ speed: 1500, type: 'guardian', label: '⟁' }  // green, 2.5px
{ speed: 800,  type: 'callto',   label: '↩' }   // purple, 3px, oneshot
{ speed: 2000, type: 'data',     label: '' }     // cyan, 1.8px
```

---

## 8. Process Architecture & Crash Recovery

### Process tree

```
NEXUS.exe (Electron)
├── [detached] node bridge/nexus-bridge-server.js   ← survives crash
├── [detached] python nexus-ollama-service.py        ← survives crash
└── [detached] node service/nexus-svc.js watch       ← survives crash
    │
    └── Monitors nexus-app.pid every 3s
        If PID dead + file exists + age > 20s:
        → spawn service/crash-prompt.js
```

### PID sentinel

```javascript
// Written on app.whenReady()
bridge/data/nexus-app.pid = {
  pid: 12345,
  started: 1234567890123,
  version: '0.51.0',
  exe: 'C:\\...\\NEXUS.exe'
}
// Deleted on before-quit (clean exit)
// NOT deleted on crash → watchdog detects
```

### Crash detection timeline

```
T+0s    NEXUS crashes
T+0–3s  nexus-svc.js polls PID file
T+3s    process.kill(pid, 0) throws ESRCH
T+3s    age check: (Date.now() - data.started) > 20000? yes
T+3s    spawn crash-prompt.js --exe NEXUS.exe --log nexus-crash.log
T+4s    PowerShell WinForms dialog appears (Windows)
        Shows last 5 crash log entries
        Buttons: [Run Diagnostics] [Skip] [Open Log]
T=user  Click "Run Diagnostics"
        spawn NEXUS.exe --run-diag
T+6s    NEXUS opens
        preload.js receives nexus:run-diag-on-start IPC
        Navigates OPTIONS → DIAGNOSE
        nxRunFullDiag() runs all 25 checks automatically
```

### Crash logger paths (priority order)

1. `path.dirname(process.execPath)/nexus-crash.log` — always writable on Windows install
2. `app.getPath('userData')/nexus-crash.log` — after app ready
3. `%APPDATA%/nexus/nexus-crash.log` — fallback

**Critical:** path resolved lazily on first write — never at `require()` time.

### 25-check diagnostic suite

Categories: `system` (7) · `fs` (4) · `network` (8) · `scripts` (1+N) · `guardian` (1) · `crashlog` (2)

```javascript
// network checks
'/health', '/network/info', '/pulse',
'/userscript/callto', '/guardian/agent-hooks',
'/guardian/handshake', '/events'

// scripts check
// parses nexus.html, extracts all <script src="">, syntax-checks each file
// reports: "N OK / M errors / K missing of T total"
```

---

## 9. Network & LAN/DDNS

### Bridge binding

```javascript
HOST = process.env.NEXUS_HOST || '0.0.0.0'  // all interfaces
PORT = process.env.NEXUS_PORT || 3747
LOCAL_IP = getLocalIP()  // first non-internal IPv4
```

### GET /network/info response

```json
{
  "ok": true,
  "version": "3.11.0",
  "local": "http://127.0.0.1:3747",
  "lan": "http://192.168.1.42:3747",
  "lanIp": "192.168.1.42",
  "ddns": "http://home.example.com:3747",
  "port": 3747,
  "host": "0.0.0.0",
  "shortId": "19cf7c2e",
  "endpoints": ["/health", "/pulse", "/ingest", "..."],
  "ts": 1234567890123
}
```

### DDNS configuration

```bash
POST /config
{ "noipUrl": "http://your.no-ip.hostname.com" }
```

Once set, `GET /network/info` includes `ddns` field. BrainOS DDNS panel syncs automatically.

### Token auth

Tokens are optional for local connections. For remote/multi-node:
```
Header: X-Guardian-Token: {token}
Token TTL: 60s
Renewal: POST /guardian/heartbeat or fresh POST /guardian/handshake
Auto re-handshake: when 401 received
```

---

## 10. AI Routing & Intent System

### POST /v1/messages — full schema

```javascript
{
  // Required
  messages: [{ role: 'user'|'assistant'|'system', content: string }],

  // Provider selection
  provider: 'auto'|'guardian'|'ollama'|'deepseek'|'claude'|
            'chatgpt'|'gemini'|'grok'|'lmstudio'|'webui',

  // Guardian-specific (when provider='guardian')
  agentId:  'chatgpt'|'claude'|'deepseek'|'gemini'|'ollama'|'grok',

  // Intent routing (when provider='auto')
  intent:   'code'|'analysis'|'reasoning'|'creative'|'research'|
            'fast'|'local'|'summarize'|'translate'|'math'|'adversarial',

  // Optional
  model:    string,        // override model selection
  api_key:  string,        // per-request key override
  base_url: string,        // custom endpoint URL
  timeout_ms: number,      // default 150000
}
```

### Response shapes

```javascript
// Synchronous (direct API providers) — 200
{
  content: [{ type: 'text', text: 'response here' }],
  model: 'deepseek-chat',
  _meta: { provider: 'deepseek', model: 'deepseek-chat' }
}

// Async (guardian provider) — 202
{
  ok: true,
  status: 'dispatched',
  provider: 'guardian',
  agentId: 'chatgpt',
  calltoId: 'callto-abc123',
  message: 'Dispatched. Response arrives via GET /events → guardian.link.event'
}

// Error — 503
{
  error: 'No AI configured for provider=chatgpt.',
  hint:  'Options: 1. Guardian mode ... 2. Ollama ... 3. POST /config ...',
  action: 'open_options'
}
```

---

## 11. Callto Pipeline

### Full execution flow

```
1. Guardian picks element → fingerprint() → selector
2. POST /userscript/callto → bridge stores, emits guardian.callto.captured
3. POST /guardian/agent-hook {agentId, calltoId} → wires agent to input
4. POST /v1/messages {provider:'guardian', agentId:'chatgpt', messages:[...]}
5. Bridge: resolve hook → find calltoId for chatgpt
6. Bridge: emit guardian:ai:request on SSE bus
7. Guardian extension: receives via EventSource
8. Guardian: finds callto → types text → dispatches
9. [ChatGPT processes...]
10. Guardian listener (MutationObserver): captures response text
11. Guardian: POST /ingest {type:'guardian.link.event', text:'...'}
12. Bridge: emit guardian.link.event on SSE bus
13. Your SSE subscriber receives { type: 'guardian.link.event', text: '...' }
```

### Callto object schema

```javascript
{
  id:        'callto-6f5a028e',     // UUID-based, 8-char suffix
  selector:  'div.my-2.5.flex',     // CSS selector
  label:     'ChatGPT input',        // human label
  url:       'https://chatgpt.com', // page URL
  host:      'chatgpt.com',          // hostname
  action:    'type',                 // click|type|submit|listen
  ts:        1234567890123,          // registration timestamp
}
```

---

## 12. IR Layer & Causal Graph

### URCK kernel in Guardian

The Guardian extension runs a lightweight URCK kernel (via `urck.js`) that:
- Tracks every callto action as a causal event with `EDGE_CAUSAL_EXPLICIT`
- Maintains a local ring buffer (500 events)
- Prunes edges on eviction (H-1)
- Uses `Set<id>` typeIndex (H-2)
- Caps seenMap at 10,000 entries (H-6)

### Event types emitted by IR layer

```javascript
'element:callto:running'    // callto dispatched
'element:callto:resolved'   // response captured
'element:callto:error'      // dispatch failed
'element:listener:mutation' // DOM changed under listener
'element:fingerprint'       // element picked
'guardian:session:start'    // new session
'guardian:session:end'      // session closed
```

---

## 13. UUID & Hook Registry

### Three levels of UUIDs

```
Project UUID  eecaa718-c6a6-4433-b02a-11ecbefd4740   (1, permanent)
Module UUIDs  one per module                          (14, permanent)
Symbol UUIDs  one per exported symbol                 (85, permanent)
```

All derived: `SHA-256("scope:name")` formatted as UUID v4. Deterministic — regenerating always produces the same ID.

### Hook annotation format

```javascript
// In source
// @hook ef1a2535-a366-48cd-a325-c1c98b91ca3c  kernel:createKernel  kind:factory
export function createKernel({ cap = 500, calltoTtlTicks = 0 } = {}) { ... }

// In hook-index.json
{
  "ef1a2535-a366-48cd-a325-c1c98b91ca3c": {
    "symbol":      "createKernel",
    "kind":        "factory",
    "module":      "kernel",
    "module_uuid": "5d90c63d-c55f-43e8-bc2e-169b960fddd9",
    "exec_order":  5,
    "stable":      true,
    "since":       "4.0.0"
  }
}
```

### Build system rules

**Auto-updated:** version, phase, updated_at, compatibility hashes, new UUID entries, new hook entries, new delta patches

**Locked forever:** all existing UUIDs, all existing hook UUIDs, project_uuid, module UUIDs, Project.spec.md, source files

---

## 14. Test Environment

The TESTENV tab provides a local development environment manager:

| Service | Control | Port |
|---|---|---|
| Apache | start/stop/status | 80/443 |
| PHP | start/stop/status | — |
| MySQL | start/stop/status | 3306 |
| Redis | start/stop/status | 6379 |
| MailHog | start/stop/status | 8025 |
| Node.js | version, status | — |

### PHP Runner

Executes PHP code against the bridge CLI endpoint. Requires bridge running with CLI executor enabled in OPTIONS → BRIDGE.

### MySQL Console

Query, inspect tables, migrate. Connects to local MySQL via bridge CLI. Includes:
- Database selector
- Table list with row counts
- Query editor with syntax highlighting
- Result grid

### Network Monitor

HTTP and WebSocket traffic monitor. Captures:
- Request/response pairs
- WebSocket frames
- Timing data
- Headers

---

## 15. Forge IDE & DeepScan

### Forge IDE

Full in-browser IDE with:
- Monaco-style editor (syntax highlighting, tab completion)
- Co-pilot mode: AI rewrites selected code, entire files, or generates from prompt
- Compiler: builds to HTML, JS module, APK, or custom target
- Test bridge: runs test suite against current file
- AST viewer: parses and visualizes the abstract syntax tree
- UCE panel: Universal Code Encyclopedia — tag, categorize, and search code patterns

### DeepScan (adversarial code audit)

```javascript
// ADVERSARY prompt system
// Scans for: vulnerabilities, logic errors, security risks, performance issues
// Uses: DeepSeek (default), Claude, or ChatGPT
// Output: findings[], verdict, severity ratings

POST /deepscan/run
{
  type:    'code',
  code:    '...source code...',
  lang:    'javascript',
  depth:   'full',
  api_key: 'sk-...'  // optional — uses configured key
}
```

Findings include severity (CRITICAL/HIGH/MEDIUM/LOW), location (line/column), description, and fix suggestion. All scans stored in `SCANS` Map, accessible via `GET /deepscan/history`.

---

## 16. APK Builder

9-step wizard for Android APK generation:

1. App name and package ID
2. Version and SDK targets (min API 21, target 34)
3. Permissions selector (categorized: camera/microphone/location/storage/network/system)
4. Architecture targets: `arm64-v8a`, `armeabi-v7a`, `x86_64`
5. Build type: debug / release
6. Signing configuration
7. Asset bundling
8. Build execution
9. Output download

Architectures: `arm64-v8a` (modern Android), `armeabi-v7a` (compatibility), `x86_64` (emulator/Chromebook).

---

## 17. Build, Package & Deploy

### Development

```bash
cd nexus-v040
node bridge/nexus-bridge-server.js   # start bridge
# open nexus.html in Electron or browser
```

### Running tests

```bash
node tests/run-all.js                    # all suites (76 tests)
node tests/run-all.js --suite ui         # UI syntax + structure
node tests/run-all.js --suite bridge     # all bridge endpoints
node tests/run-all.js --verbose          # detailed output
```

### Bridge as standalone service

```bash
# Windows service (requires admin)
sc create NexusBridge binPath= "node bridge/nexus-bridge-server.js" start= auto

# Watchdog (no admin required, cross-platform)
node service/nexus-svc.js watch

# NSM (full service manager)
node service/nsm.js install bridge
node service/nsm.js start bridge
node service/nsm.js status
node service/nsm.js logs bridge
```

### Environment variables

```bash
NEXUS_PORT=3747
NEXUS_HOST=0.0.0.0
NEXUS_NODE_BIN=/usr/local/bin/node   # CRITICAL for packaged Electron
DATA_DIR=/path/to/data
PROFILES_DIR=/path/to/profiles
```

### Guardian extension

1. Open Firefox → `about:debugging` → This Firefox
2. Load Temporary Add-on → select `manifest.json`
3. Or package: `web-ext build` → `.xpi` file for distribution

### Electron build (electron-builder)

```json
// package.json
{
  "build": {
    "appId": "com.nexus.app",
    "win": { "target": "nsis", "icon": "assets/icon.ico" },
    "mac": { "target": "dmg" },
    "linux": { "target": "AppImage" },
    "extraResources": ["bridge/", "service/"]
  }
}
```

---

## 18. API Reference — All Endpoints

See `guardian-bridge-api.html` for the full interactive reference with request/response shapes for every endpoint.

Key patterns:

```javascript
// Discovery
const info = await fetch('http://127.0.0.1:3747/network/info').then(r=>r.json());
const bridgeUrl = info.lan;  // use for LAN; info.ddns for remote

// Handshake
const { token } = await fetch(bridgeUrl+'/guardian/handshake', {
  method:'POST', headers:{'Content-Type':'application/json'},
  body: JSON.stringify({ instanceId:'myapp-'+crypto.randomUUID(), logicalId:'myapp' })
}).then(r=>r.json());

// Pulse loop
setInterval(() => fetch(bridgeUrl+'/pulse', {
  method:'POST', headers:{'Content-Type':'application/json','X-Guardian-Token':token},
  body: JSON.stringify({ instanceId, status:'online', ts:Date.now() })
}), 1500);

// SSE subscribe
const evs = new EventSource(bridgeUrl+'/events');
evs.onmessage = e => { const d = JSON.parse(e.data); handleEvent(d); };

// Send via Guardian (no API key)
fetch(bridgeUrl+'/v1/messages', {
  method:'POST', headers:{'Content-Type':'application/json'},
  body: JSON.stringify({ provider:'guardian', agentId:'chatgpt',
    messages:[{role:'user',content:'Hello'}] })
});
// Response arrives via SSE: { type:'guardian.link.event', text:'...' }
```

---

## 19. SSE Event Reference

All events arrive on `GET /events` as `data: {json}\n\n`.

| Event type | When | Key fields |
|---|---|---|
| `guardian-pulse` | Extension heartbeat 1.5s | `instanceId, logicalId, status, ts` |
| `guardian:init` | Extension first connect | `instanceId, version` |
| `guardian:handshake` | Handshake complete | `token, instanceId` |
| `guardian.callto.captured` | Element picked | `id, selector, url, host, action, ts` |
| `guardian:ai:request` | Message dispatched | `agentId, calltoId, text, requestId, ts` |
| `guardian.link.event` | Response captured | `text, listenerId, calltoId, ts` |
| `guardian:ai:response` | Alias for link.event | `text, agentId, requestId` |
| `guardian.ir.ingest` | IR causal event | `type, calltoId, ts` |
| `guardian:agent:hook` | Hook created/updated | `agentId, calltoId, intent` |
| `nexus:connected` | NEXUS connects | `instanceId, version` |
| `deepscan:start` | Scan begins | `scanId, type` |
| `ollama:py:chat` | Python Ollama chat | `model, prompt_tokens` |
| `system:bus:unknown` | Unmapped bus event | `type, payload` |

---

## 20. Integration Guide

### Causal-Nexus adapter pattern

```javascript
import { createKernel } from 'causal-nexus';
const kernel = createKernel();

const evs = new EventSource('http://127.0.0.1:3747/events');
evs.onmessage = e => {
  const d = JSON.parse(e.data);
  if (d.type?.startsWith('guardian')) {
    kernel.ingest(d.type.replace(/\./g, ':'), d.payload || d, 'bridge');
  }
};

// Query: FIND events WHERE type = 'guardian:link:event' LIMIT 20
```

### Python integration

```python
import requests, sseclient, threading

BRIDGE = 'http://192.168.1.42:3747'

# Handshake
r = requests.post(f'{BRIDGE}/guardian/handshake', json={
    'instanceId': f'python-{uuid.uuid4()}', 'logicalId': 'python'})
token = r.json()['token']

# SSE in background thread
def listen():
    resp = requests.get(f'{BRIDGE}/events', stream=True)
    client = sseclient.SSEClient(resp)
    for event in client.events():
        data = json.loads(event.data)
        if data['type'] == 'guardian.link.event':
            print('AI:', data['text'])

threading.Thread(target=listen, daemon=True).start()

# Send via Guardian
requests.post(f'{BRIDGE}/v1/messages', json={
    'provider': 'guardian', 'agentId': 'chatgpt',
    'messages': [{'role': 'user', 'content': 'Hello from Python'}]
})
```

---

*NEXUS v0.51.0 · Bridge v3.11.0 · Guardian v3.4.0 · Causal-Nexus v4.3.0/v1.0.0*
*76/76 tests passing · 60,000 lines · Zero external AI API keys required for browser routing*
