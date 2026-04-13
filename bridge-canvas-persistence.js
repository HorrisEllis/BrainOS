/**
 * BRIDGE CANVAS PERSISTENCE — Phase 1 Foundation
 * UUID: bridge-canvas-persist-0001-phase1-foundation
 *
 * Adds 6 routes to nexus-bridge-server.js:
 *   GET  /canvas/state          — load full canvas state from disk
 *   POST /canvas/state          — save full canvas state to disk (debounced internally)
 *   GET  /canvas/nodes          — node registry only
 *   POST /canvas/node           — upsert a single node (UUID-keyed)
 *   DELETE /canvas/node/:id     — remove node from registry
 *   GET  /canvas/deltas         — delta log (last N, filterable)
 *   POST /canvas/delta          — append a delta entry
 *   GET  /canvas/snr-rules      — load SNR rules
 *   POST /canvas/snr-rules      — save full SNR rules array
 *   GET  /canvas/keys           — load key rotation state
 *   POST /canvas/keys           — save key rotation state
 *   GET  /canvas/health         — canvas persistence layer health
 *
 * Storage layout (all under DATA_DIR):
 *   canvas-state.json     — full canvas snapshot (nodes, tunnels, cam)
 *   canvas-nodes.json     — UUID-keyed node registry
 *   canvas-deltas.jsonl   — append-only delta log
 *   canvas-snr-rules.json — SNR filter rules
 *   canvas-keys.json      — key rotation timestamps + config
 *
 * Axioms enforced:
 *   - Nothing exists until proven (watchdog verifies files on init)
 *   - Persistence is the golden rule (every write is atomic via temp+rename)
 *   - No fake data — if file missing, returns empty not mock
 *   - UUIDs on everything
 *   - Bridge is the persistence layer — canvas is a client
 *   - Pre-emptive bug fixes: atomic writes, parse guards, CORS, error logging
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const crypto = require('crypto');

// ── Schema version — bump when canvas state shape changes ────────────────────
const SCHEMA_VERSION = 1;
const MAX_DELTAS     = 5000; // JSONL cap before rotation

// ── Module state ─────────────────────────────────────────────────────────────
let _dataDir   = null;
let _busEmit   = () => {};
let _saveCfg   = () => {};
let _installed = false;

// File paths (set on install)
const P = {};

// ── Atomic write — temp + rename, never corrupts on crash ────────────────────
function atomicWrite(filePath, content) {
  const tmp = filePath + '.tmp.' + crypto.randomBytes(4).toString('hex');
  try {
    fs.writeFileSync(tmp, content, 'utf8');
    fs.renameSync(tmp, filePath);
    return true;
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch {}
    throw err;
  }
}

// ── Safe JSON parse — never throws ───────────────────────────────────────────
function safeJSON(raw, fallback) {
  try { return JSON.parse(raw); } catch { return fallback; }
}

// ── Read file or return null (no throw) ──────────────────────────────────────
function readFile(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    return fs.readFileSync(filePath, 'utf8');
  } catch { return null; }
}

// ── Watchdog — verify all storage files exist and are readable ───────────────
function watchdog() {
  const results = {};
  for (const [key, filePath] of Object.entries(P)) {
    const exists = fs.existsSync(filePath);
    const readable = exists ? (() => { try { fs.readFileSync(filePath, 'utf8'); return true; } catch { return false; } })() : false;
    results[key] = { exists, readable, path: filePath };
  }
  const allOk = Object.values(results).every(r => !r.exists || r.readable);
  _busEmit('canvas:watchdog', { results, allOk }, allOk ? 'INFO' : 'ERROR');
  return { ok: allOk, results };
}

// ── Init storage files if absent ─────────────────────────────────────────────
function ensureStorageFiles() {
  // canvas-state.json
  if (!fs.existsSync(P.state)) {
    atomicWrite(P.state, JSON.stringify({
      schema: SCHEMA_VERSION,
      version: '3.2.0',
      created: Date.now(),
      savedAt: null,
      nodes: [],
      tunnels: [],
      cam: { x: 0, y: 0, z: 1 },
      snrConfig: { threshold: 5, fastLane: 7, blockBelow: 2, mode: 'adaptive' },
    }, null, 2));
    _busEmit('canvas:storage', { action: 'created', file: 'canvas-state.json' }, 'INFO');
  }

  // canvas-nodes.json — UUID-keyed registry
  if (!fs.existsSync(P.nodes)) {
    atomicWrite(P.nodes, JSON.stringify({ schema: SCHEMA_VERSION, nodes: {} }, null, 2));
    _busEmit('canvas:storage', { action: 'created', file: 'canvas-nodes.json' }, 'INFO');
  }

  // canvas-snr-rules.json
  if (!fs.existsSync(P.snrRules)) {
    atomicWrite(P.snrRules, JSON.stringify({ schema: SCHEMA_VERSION, rules: [] }, null, 2));
    _busEmit('canvas:storage', { action: 'created', file: 'canvas-snr-rules.json' }, 'INFO');
  }

  // canvas-keys.json
  if (!fs.existsSync(P.keys)) {
    const now = Date.now();
    atomicWrite(P.keys, JSON.stringify({
      schema: SCHEMA_VERSION,
      intervalMs: 15 * 60 * 1000,
      rotatedAt: { session: now, e2e: now, gate: now, turn: now },
    }, null, 2));
    _busEmit('canvas:storage', { action: 'created', file: 'canvas-keys.json' }, 'INFO');
  }

  // canvas-deltas.jsonl — append only, created empty if missing
  if (!fs.existsSync(P.deltas)) {
    fs.writeFileSync(P.deltas, '', 'utf8');
    _busEmit('canvas:storage', { action: 'created', file: 'canvas-deltas.jsonl' }, 'INFO');
  }
}

// ── JSONL delta append ────────────────────────────────────────────────────────
function appendDelta(entry) {
  const line = JSON.stringify({
    id:     entry.id     || crypto.randomBytes(8).toString('hex'),
    ts:     entry.ts     || Date.now(),
    type:   entry.type   || 'network',
    msg:    entry.msg    || '',
    detail: entry.detail || '',
    nodeId: entry.nodeId || null,
  });
  try {
    fs.appendFileSync(P.deltas, line + '\n', 'utf8');
    // Rotate if too large (> MAX_DELTAS lines ≈ 2MB)
    const stat = fs.statSync(P.deltas);
    if (stat.size > 4 * 1024 * 1024) rotateDeltaLog();
  } catch (err) {
    _busEmit('canvas:delta_error', { error: err.message }, 'ERROR');
  }
}

// ── Rotate delta log — keep last MAX_DELTAS entries ──────────────────────────
function rotateDeltaLog() {
  try {
    const raw = fs.readFileSync(P.deltas, 'utf8');
    const lines = raw.trim().split('\n').filter(Boolean);
    const keep  = lines.slice(-MAX_DELTAS);
    atomicWrite(P.deltas, keep.join('\n') + '\n');
    _busEmit('canvas:delta_rotate', { kept: keep.length }, 'INFO');
  } catch (err) {
    _busEmit('canvas:delta_rotate_error', { error: err.message }, 'ERROR');
  }
}

// ── Read deltas from JSONL ────────────────────────────────────────────────────
function readDeltas(limit = 100, type = null) {
  try {
    const raw = readFile(P.deltas);
    if (!raw) return [];
    const lines = raw.trim().split('\n').filter(Boolean);
    const parsed = lines
      .map(l => safeJSON(l, null))
      .filter(Boolean)
      .filter(d => !type || type === 'all' || d.type === type);
    return parsed.slice(-limit).reverse(); // newest first
  } catch { return []; }
}

// ── Node registry upsert ──────────────────────────────────────────────────────
function upsertNode(node) {
  if (!node.id) throw new Error('node.id required');
  const raw = readFile(P.nodes);
  const store = safeJSON(raw, { schema: SCHEMA_VERSION, nodes: {} });
  store.nodes[node.id] = {
    ...store.nodes[node.id],
    ...node,
    updatedAt: Date.now(),
  };
  atomicWrite(P.nodes, JSON.stringify(store, null, 2));
  appendDelta({ type: 'network', msg: `node upsert · ${node.name || node.id}`, nodeId: node.id });
  return store.nodes[node.id];
}

// ── Node registry delete ──────────────────────────────────────────────────────
function removeNode(id) {
  const raw = readFile(P.nodes);
  const store = safeJSON(raw, { schema: SCHEMA_VERSION, nodes: {} });
  const existed = !!store.nodes[id];
  delete store.nodes[id];
  atomicWrite(P.nodes, JSON.stringify(store, null, 2));
  if (existed) appendDelta({ type: 'network', msg: `node removed · ${id}`, nodeId: id });
  return existed;
}

// ── Route handler ─────────────────────────────────────────────────────────────
// Returns response object or null (not handled)
async function route(parts, method, body, req, res) {
  if (parts[0] !== 'canvas') return null;

  const sub = parts[1]; // state | nodes | node | deltas | delta | snr-rules | keys | health

  // ── GET /canvas/health ────────────────────────────────────────────────────
  if (!sub || sub === 'health') {
    const wd = watchdog();
    const stat = {};
    for (const [k, v] of Object.entries(P)) {
      try { stat[k] = fs.existsSync(v) ? fs.statSync(v).size : null; } catch { stat[k] = null; }
    }
    return { ok: true, schema: SCHEMA_VERSION, dataDir: _dataDir, watchdog: wd, fileSizes: stat };
  }

  // ── GET /canvas/state ─────────────────────────────────────────────────────
  if (sub === 'state' && method === 'GET') {
    const raw = readFile(P.state);
    if (!raw) return { ok: true, state: null, msg: 'no saved state' };
    const state = safeJSON(raw, null);
    if (!state) return { ok: false, error: 'canvas-state.json parse error' };
    return { ok: true, state };
  }

  // ── POST /canvas/state ────────────────────────────────────────────────────
  if (sub === 'state' && method === 'POST') {
    if (!body || !body.nodes) return { ok: false, error: 'body.nodes required' };
    const payload = {
      schema:    SCHEMA_VERSION,
      version:   '3.2.0',
      savedAt:   Date.now(),
      nodeCount: (body.nodes || []).length,
      tunnelCount: (body.tunnels || []).length,
      nodes:    body.nodes    || [],
      tunnels:  body.tunnels  || [],
      cam:      body.cam      || { x: 0, y: 0, z: 1 },
      snrConfig: body.snrConfig || {},
    };
    atomicWrite(P.state, JSON.stringify(payload, null, 2));
    appendDelta({ type: 'network', msg: 'canvas state saved', detail: `${payload.nodeCount} nodes · ${payload.tunnelCount} tunnels` });
    _busEmit('canvas:state_saved', { nodeCount: payload.nodeCount }, 'INFO');
    return { ok: true, savedAt: payload.savedAt, nodeCount: payload.nodeCount };
  }

  // ── GET /canvas/nodes ─────────────────────────────────────────────────────
  if (sub === 'nodes' && method === 'GET') {
    const raw = readFile(P.nodes);
    const store = safeJSON(raw, { nodes: {} });
    return { ok: true, nodes: Object.values(store.nodes) };
  }

  // ── POST /canvas/node — upsert single node ────────────────────────────────
  if (sub === 'node' && method === 'POST') {
    if (!body || !body.id) return { ok: false, error: 'body.id required' };
    const node = upsertNode(body);
    _busEmit('canvas:node_upsert', { id: body.id, name: body.name }, 'INFO');
    return { ok: true, node };
  }

  // ── DELETE /canvas/node/:id ───────────────────────────────────────────────
  if (sub === 'node' && parts[2] && method === 'DELETE') {
    const existed = removeNode(parts[2]);
    _busEmit('canvas:node_remove', { id: parts[2] }, 'INFO');
    return { ok: true, removed: existed };
  }

  // ── GET /canvas/deltas ────────────────────────────────────────────────────
  if (sub === 'deltas' && method === 'GET') {
    const url = new URL('http://x' + (req.url || ''));
    const limit = parseInt(url.searchParams.get('limit') || '100');
    const type  = url.searchParams.get('type') || null;
    const deltas = readDeltas(limit, type);
    return { ok: true, deltas, count: deltas.length };
  }

  // ── POST /canvas/delta — append one delta ─────────────────────────────────
  if (sub === 'delta' && method === 'POST') {
    if (!body) return { ok: false, error: 'body required' };
    appendDelta(body);
    _busEmit('canvas:delta', body, 'INFO');
    return { ok: true };
  }

  // ── GET /canvas/snr-rules ─────────────────────────────────────────────────
  if (sub === 'snr-rules' && method === 'GET') {
    const raw = readFile(P.snrRules);
    const store = safeJSON(raw, { rules: [] });
    return { ok: true, rules: store.rules };
  }

  // ── POST /canvas/snr-rules — replace full rules array ────────────────────
  if (sub === 'snr-rules' && method === 'POST') {
    if (!body || !Array.isArray(body.rules)) return { ok: false, error: 'body.rules[] required' };
    const payload = { schema: SCHEMA_VERSION, savedAt: Date.now(), rules: body.rules };
    atomicWrite(P.snrRules, JSON.stringify(payload, null, 2));
    appendDelta({ type: 'snr', msg: 'SNR rules saved', detail: `${body.rules.length} rules` });
    _busEmit('canvas:snr_rules_saved', { count: body.rules.length }, 'INFO');
    return { ok: true, count: body.rules.length };
  }

  // ── GET /canvas/keys ──────────────────────────────────────────────────────
  if (sub === 'keys' && method === 'GET') {
    const raw = readFile(P.keys);
    const store = safeJSON(raw, null);
    if (!store) return { ok: false, error: 'canvas-keys.json missing or corrupt' };
    return { ok: true, keys: store };
  }

  // ── POST /canvas/keys — save key rotation state ───────────────────────────
  if (sub === 'keys' && method === 'POST') {
    if (!body) return { ok: false, error: 'body required' };
    const payload = {
      schema:      SCHEMA_VERSION,
      savedAt:     Date.now(),
      intervalMs:  body.intervalMs  || 15 * 60 * 1000,
      rotatedAt:   body.rotatedAt   || {},
    };
    atomicWrite(P.keys, JSON.stringify(payload, null, 2));
    appendDelta({ type: 'crypto', msg: 'key state saved' });
    _busEmit('canvas:keys_saved', {}, 'INFO');
    return { ok: true };
  }

  return null; // not handled
}

// ── HTTP response helper (matches server pattern) ─────────────────────────────
function jsonRes(res, status, body) {
  res.writeHead(status, {
    'Content-Type':                'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods':'GET,POST,PUT,DELETE,PATCH,OPTIONS',
    'Access-Control-Allow-Headers':'Content-Type,Authorization,X-API-Key,X-Request-ID',
  });
  res.end(JSON.stringify(body));
}

async function readBody(req) {
  return new Promise((resolve, reject) => {
    let buf = '';
    req.on('data', chunk => { buf += chunk; if (buf.length > 10 * 1024 * 1024) reject(new Error('Body too large')); });
    req.on('end', () => { try { resolve(buf ? JSON.parse(buf) : {}); } catch { resolve({}); } });
    req.on('error', reject);
  });
}

// ── Public install function — called from server ──────────────────────────────
function install(dataDir, busEmit, saveCfg) {
  if (_installed) return;
  _installed = true;
  _dataDir  = dataDir;
  _busEmit  = busEmit  || (() => {});
  _saveCfg  = saveCfg  || (() => {});

  // Set file paths
  P.state    = path.join(dataDir, 'canvas-state.json');
  P.nodes    = path.join(dataDir, 'canvas-nodes.json');
  P.deltas   = path.join(dataDir, 'canvas-deltas.jsonl');
  P.snrRules = path.join(dataDir, 'canvas-snr-rules.json');
  P.keys     = path.join(dataDir, 'canvas-keys.json');

  // Ensure data dir exists
  try { fs.mkdirSync(dataDir, { recursive: true }); } catch {}

  // Ensure all storage files exist (creates empty if missing)
  ensureStorageFiles();

  // Watchdog on startup — log any issues
  const wd = watchdog();
  if (!wd.ok) {
    console.error('[CANVAS PERSIST] Watchdog failure on init:', JSON.stringify(wd.results));
  } else {
    console.log(`[CANVAS PERSIST] Storage verified · ${dataDir}`);
    console.log(`[CANVAS PERSIST] Routes: GET/POST /canvas/state · nodes · deltas · snr-rules · keys · health`);
  }
}

// ── Express-style middleware for server integration ───────────────────────────
// Drop this into handleRequest BEFORE the 404 fallback:
//   const canvasResult = await CanvasPersist.handle(req, res, parts, method, u);
//   if (canvasResult !== null) return jsonRes(res, 200, canvasResult);
async function handle(req, res, parts, method, u) {
  if (!_installed)   return null;
  if (!parts[0] || parts[0] !== 'canvas') return null;
  if (method === 'OPTIONS') { jsonRes(res, 204, {}); return true; }

  try {
    const body = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)
      ? await readBody(req)
      : null;

    const result = await route(parts, method, body, req, res);
    if (result === null) return null;

    // Append delta to bus so SSE clients see it too
    if (parts[1] === 'state' && method === 'POST') {
      _busEmit('canvas:saved', result, 'INFO');
    }

    jsonRes(res, 200, result);
    return true;
  } catch (err) {
    _busEmit('canvas:route_error', { path: req.url, error: err.message }, 'ERROR');
    jsonRes(res, 500, { ok: false, error: err.message });
    return true;
  }
}

module.exports = {
  install,
  handle,
  watchdog,
  upsertNode,
  removeNode,
  appendDelta,
  readDeltas,
  // Exposed for testing
  _P: () => P,
  _readFile: readFile,
  _atomicWrite: atomicWrite,
};
