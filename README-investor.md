# NEXUS — Investor Brief

**The problem with AI in 2025 is not capability. It is access.**

Every frontier AI model is locked behind an API. Every API has a price, a rate limit, a terms of service that restricts commercial use, and a latency cost that compounds at scale. Developers pay twice — once for compute, once in engineering time building and maintaining provider integrations that break every time a model updates.

There is a second problem nobody talks about: the best AI is not the one with the best model. It is the one the user is already logged into, with their full context, their conversation history, their documents. That AI is locked behind a browser. Nobody has figured out how to use it programmatically without violating terms of service or building brittle scrapers.

NEXUS solves both problems simultaneously.

---

## What It Does

NEXUS is a local AI orchestration runtime — a desktop application that lets any software system route messages to any AI model, with or without an API key, over a simple HTTP interface at `localhost:3747`.

The Firefox extension (Guardian) acts as a programmatic user. It captures any input element on any AI website, registers it as an addressable endpoint, and becomes the hands that type and the eyes that read. When a NEXUS client sends `POST /v1/messages {provider:'guardian', agentId:'chatgpt'}`, Guardian types the message into the actual ChatGPT interface and returns the response — no API key, no rate limit, no per-token cost beyond whatever the user already pays.

The same HTTP interface routes to Ollama (local models), DeepSeek, Claude, GPT-4, Gemini, LM Studio, and Open WebUI with a single unified API. Switching models is a parameter change. Fallback chains are configurable. Intent routing automatically selects the best model for the task type.

---

## The Numbers

| Metric | Value |
|---|---|
| Codebase | 60,000 lines |
| Test coverage | 76/76 passing |
| Core languages | JavaScript / Node.js / Python |
| External dependencies for core functionality | Zero |
| API keys required for browser AI routing | Zero |
| Time from zero to AI response | ~3 seconds |
| Supported AI providers | 9 (Ollama, DeepSeek, Claude, ChatGPT, Gemini, Grok, LM Studio, Open WebUI, Guardian) |
| Bridge protocol overhead | ~2ms per request |
| Concurrent SSE subscribers | Up to 100 |

---

## The Architecture Advantage

Three things are genuinely hard to replicate:

**1. The callto system.** Guardian's element picker uses a zero-reflow algorithm — it fingerprints DOM elements without triggering layout recalculation, generating stable CSS selectors that survive page refreshes and minor DOM changes. The capture-to-execution pipeline is 11 steps, fully observable via a causal event graph, and reconnects automatically after disconnection. This is not a scraper. It is a typed, addressable interface to any web UI.

**2. The causal event engine.** Causal-Nexus (587 tests, 14 modules) is a deterministic causal instrumentation runtime. Every action has a traceable cause. Every session is fully replayable. The kernel uses a ring buffer with O(1) push and eviction, an O(1) typeIndex based on `Set<id>`, LRU-capped seen maps, and atomic gate output — six proven hostile attack vectors were identified and eliminated in a structured adversarial audit. The query language (CQL) executes causal path queries across the event graph. This is the infrastructure layer for reasoning about what an AI did and why.

**3. The unified HTTP interface.** The bridge exposes a single `POST /v1/messages` endpoint that accepts any provider. The client does not need to know whether the response comes from a browser, a local model, or a commercial API. The intent routing system automatically chains providers in order of preference based on task type. This is the abstraction layer that makes AI provider lock-in irrelevant.

---

## Market Position

The AI infrastructure market is bifurcating. On one side: hyperscale API providers (OpenAI, Anthropic, Google) targeting enterprise. On the other: local model runners (Ollama, LM Studio) targeting privacy-conscious developers. Nobody is building the glue layer — the orchestration runtime that sits between the developer and every provider simultaneously, handles fallback, manages state, and makes the browser AI accessible programmatically.

The closest commercial analogues are LangChain (Python, API-only, no browser routing, no local UI) and LiteLLM (Python, API proxy, no GUI, no causal tracking). Neither has a browser extension component. Neither can route through a logged-in browser session.

---

## Leverage Points

**The Guardian extension is a moat.** The zero-reflow picker, the IR layer, the callto pipeline, and the causal graph integration took months of iterative engineering to get right. It is not something a weekend project can replicate. The extension works on any AI website without website cooperation — it is fully autonomous.

**The local-first architecture is a positioning advantage.** All processing happens on the user's machine. No data leaves the computer except what the user explicitly sends to an AI. This makes enterprise and regulated-industry adoption far easier than cloud-dependent solutions.

**The causal event system is a foundation, not a feature.** Every action is causally traced. This means NEXUS can answer questions that other tools cannot: not just "what happened" but "why did that happen, and what caused that, back to the root." For debugging, auditing, compliance, and autonomous agent systems, this is the substrate.

**The unified API surface is composable.** Any system that speaks HTTP can connect to NEXUS. The bridge already serves BrainOS (visual canvas), the NEXUS desktop app, Guardian, and external Python clients simultaneously. Adding a new client takes minutes. The SSE event bus means all clients stay in sync in real time without polling.

---

## What It Is Worth — A Grounded View

NEXUS is pre-revenue infrastructure. The question of valuation depends entirely on which outcome is being pursued:

**As a developer tool (SaaS):** A hosted version of the bridge — cloud-deployed, multi-tenant, with managed Guardian farm — addresses the market for teams who cannot run local infrastructure. Comparable SaaS developer tools in the AI space (Weights & Biases, Replicate, Modal) are valued at $100M–$2B at Series A/B on $1M–$10M ARR. The differentiation is the no-API-key browser routing — something no other hosted product offers.

**As infrastructure (API product):** The bridge protocol is a standard. If it becomes the de facto interface for AI routing — the way S3 became the de facto interface for object storage — network effects compound. Every client library written for it, every tool that exposes a compatible endpoint, increases the switching cost.

**As an acquisition target:** The callto system plus the causal event engine is a clean acquisition thesis for any company building AI agent infrastructure: OpenAI (browser use layer), Anthropic (computer use layer), Microsoft (Copilot routing), or any enterprise software company adding AI automation to existing products. The browser-to-AI pipeline is the hardest part of computer use to get right. NEXUS has it working.

**Current honest valuation range:** $500K–$3M as a pre-revenue technical asset with working code, documentation, and a defensible architecture. The ceiling scales with demonstrated revenue or a clear path to it.

---

## How to Expose It Publicly

**Step 1 — Self-hosted bridge as a service**
Package the bridge as a Docker container. Add multi-tenant authentication (token per user, rate limiting, usage metering). Deploy behind a reverse proxy (nginx + Let's Encrypt). This gives every developer their own bridge instance accessible from anywhere.

```dockerfile
FROM node:20-alpine
COPY bridge/ /app/bridge/
WORKDIR /app
CMD ["node", "bridge/nexus-bridge-server.js"]
EXPOSE 3747
```

**Step 2 — Guardian distribution**
Sign the Firefox extension and list it on addons.mozilla.org. This removes the "load temporary add-on" friction and gives automatic updates. Chrome version requires MV3 migration (the content script architecture is compatible).

**Step 3 — NEXUS desktop via electron-builder**
Package as a signed Windows installer (NSIS), Mac DMG, and Linux AppImage. Distribute via GitHub Releases, a direct download page, or Homebrew (Mac). Code signing on Windows ($200/year EV cert) removes the "Windows protected your PC" warning.

**Step 4 — Bridge API as a public product**
The `/v1/messages` interface is already OpenAI-compatible in shape. Publish it as a drop-in replacement endpoint. Any tool that works with OpenAI's API can point at NEXUS instead. This is the fastest path to adoption — zero integration cost for existing tools.

**Step 5 — The managed Guardian farm (enterprise)**
The logical commercial product: a fleet of browser instances running Guardian, managed by the bridge, accessible via API. Customers get no-API-key AI access without running their own browser. This is the enterprise version of what Browserless does for Puppeteer — but for AI.

---

## The Ask

The honest pitch: this is a technically sophisticated, working system that solves a real problem in a novel way. It is not yet a business — it is the infrastructure that a business could be built on. The right next step is not a seed round. It is:

1. Packaging for public distribution (2–4 weeks of polish)
2. A closed beta with 100 developers to validate the use cases
3. One clear monetization wedge: managed bridge hosting or the Guardian farm

The moat is real. The technology is working. The market is ready.

---

*NEXUS v0.51.0 · 60,000 lines · 76/76 tests · Guardian v3.4.0 · Bridge v3.11.0*
*github.com/HorrisEllis/Nexus · github.com/HorrisEllis/Guardian · github.com/HorrisEllis/BrainOS*
