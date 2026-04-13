/**
 * NEXUS Bridge Modules — v1.0.0
 * UUID: bridge-modules-wire-v1000-0000-000000000001
 *
 * Single require() that installs all standalone modules into nexus-bridge-server.js.
 * Each module is independent. This file only wires them together.
 *
 * Adds routes:
 *   /snr/*    — SNR Filter
 *   /keys/*   — Key Manager
 *   /hosts/*  — Host Rotation
 *   /ports/*  — Port Registry
 *   /canvas/* — Canvas Persistence (Phase 1)
 *   /crypto/* — Crypto Engine health
 *
 * Install:
 *   const BridgeModules = require('./nexus-bridge-modules');
 *   setImmediate(() => BridgeModules.install(DATA_DIR, busEmit, saveCfg));
 *   // In handleRequest before 404:
 *   const modResult = await BridgeModules.handle(req, res, parts, method, u);
 *   if (modResult !== null) return;
 */

'use strict';

const path   = require('path');
const crypto = require('crypto');

// ─── Lazy module loading with error isolation ─────────────────────────────────
function loadModule(name, modulePath) {
  try {
    return require(modulePath);
  } catch (e) {
    console.error(`[BridgeModules] Failed to load ${name}: ${e.message}`);
    return null;
  }
}

// ─── Module instances ─────────────────────────────────────────────────────────
let _snr      = null;
let _keys     = null;
let _hosts    = null;
let _ports    = null;
let _canvas   = null;
let _engine   = null;
let _installed = false;
let _dataDir   = null;
let _busEmit   = () => {};

// ─── JSON response helper ─────────────────────────────────────────────────────
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

// ─── INSTALL ──────────────────────────────────────────────────────────────────
function install(dataDir, busEmit, saveCfg) {
  if (_installed) return;
  _installed = true;
  _dataDir   = dataDir;
  _busEmit   = busEmit || (() => {});

  // ── Crypto Engine (no persistence, just primitives) ──────────────────────
  const CryptoModule = loadModule('crypto-engine', path.join(__dirname, 'crypto-engine'));
  if (CryptoModule) {
    _engine = CryptoModule.CryptoEngine ? new CryptoModule.CryptoEngine() : CryptoModule;
    const h = _engine.health?.();
    if (h?.allOk) {
      console.log('[BridgeModules] CryptoEngine ready · all primitives healthy');
    } else {
      console.warn('[BridgeModules] CryptoEngine partial:', h?.checks);
    }
  }

  // ── SNR Filter ────────────────────────────────────────────────────────────
  const SNRFilter = loadModule('snr-filter', path.join(__dirname, 'snr-filter'));
  if (SNRFilter) {
    _snr = new SNRFilter({
      name:    'Bridge SNR Gate',
      persist: path.join(dataDir, 'snr-rules.json'),
      logFile: path.join(dataDir, 'snr-decisions.jsonl'),
    });
    _snr.connectBus(busEmit);
    // Apply default security preset
    SNRFilter.PRESETS.security(_snr);
    console.log(`[BridgeModules] SNR Filter ready · ${_snr.size} rules`);
  }

  // ── Key Manager ───────────────────────────────────────────────────────────
  const KeyManager = loadModule('key-manager', path.join(__dirname, 'key-manager'));
  if (KeyManager) {
    _keys = new KeyManager({
      name:         'Bridge Key Manager',
      persist:      path.join(dataDir, 'canvas-keys.json'),
      cryptoEngine: _engine || null,
      intervals: {
        session: 60 * 60 * 1000,      // 1 hour
        e2e:     15 * 60 * 1000,      // 15 min
        gate:    24 * 60 * 60 * 1000, // 24 hours
        turn:    24 * 60 * 60 * 1000, // 24 hours
      },
    });
    _keys.connectBus(busEmit);
    // Start auto-rotation schedules (use unref timers — won't block exit)
    _keys.startAllSchedules();
    console.log(`[BridgeModules] Key Manager ready · ${_keys.listKeys().length} keys · schedules active`);
  }

  // ── Host Rotation ─────────────────────────────────────────────────────────
  const HostRotation = loadModule('host-rotation', path.join(__dirname, 'host-rotation'));
  if (HostRotation) {
    _hosts = new HostRotation({
      name:    'Bridge Host Rotation',
      persist: path.join(dataDir, 'canvas-hosts.json'),
    });
    _hosts.connectBus(busEmit);
    console.log(`[BridgeModules] Host Rotation ready · ${_hosts._hosts.length} hosts`);
  }

  // ── Port Registry ─────────────────────────────────────────────────────────
  const PortRegistry = loadModule('port-registry', path.join(__dirname, 'port-registry'));
  if (PortRegistry) {
    _ports = new PortRegistry({
      name:     'Bridge Port Registry',
      persist:  path.join(dataDir, 'canvas-ports.json'),
      defaults: true, // registers 3747, 3748, 3478, etc.
    });
    _ports.connectBus(busEmit);
    console.log(`[BridgeModules] Port Registry ready · ${_ports._ports.size} ports`);
  }

  // ── Canvas Persistence (Phase 1) ──────────────────────────────────────────
  const CanvasPersist = loadModule('canvas-persistence', path.join(__dirname, 'bridge-canvas-persistence'));
  if (CanvasPersist) {
    CanvasPersist.install(dataDir, busEmit, saveCfg);
    _canvas = CanvasPersist;
    console.log(`[BridgeModules] Canvas Persistence ready`);
  }

  busEmit('modules:ready', {
    snr:    !!_snr,
    keys:   !!_keys,
    hosts:  !!_hosts,
    ports:  !!_ports,
    canvas: !!_canvas,
    engine: !!_engine,
  }, 'INFO');
}

// ─── HANDLE — route to correct module ────────────────────────────────────────
async function handle(req, res, parts, method, u) {
  if (!_installed) return null;
  if (!parts[0])   return null;

  // OPTIONS preflight
  if (method === 'OPTIONS') {
    jsonRes(res, 204, {});
    return true;
  }

  const first = parts[0];
  let result  = null;

  try {
    const body = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)
      ? await readBody(req)
      : null;

    // ── /snr/* ──────────────────────────────────────────────────────────────
    if (first === 'snr' && _snr) {
      result = await _snr.bridgeRoute(parts, method, body, req);
    }

    // ── /keys/* ─────────────────────────────────────────────────────────────
    else if (first === 'keys' && _keys) {
      result = await _keys.bridgeRoute(parts, method, body, req);
    }

    // ── /hosts/* ────────────────────────────────────────────────────────────
    else if (first === 'hosts' && _hosts) {
      result = await _hosts.bridgeRoute(parts, method, body, req);
    }

    // ── /ports/* ────────────────────────────────────────────────────────────
    else if (first === 'ports' && _ports) {
      result = await _ports.bridgeRoute(parts, method, body, req);
    }

    // ── /canvas/* ───────────────────────────────────────────────────────────
    else if (first === 'canvas' && _canvas) {
      // Canvas persistence handles its own response writing
      const r = await _canvas.handle(req, res, parts, method, u);
      return r; // true or null — already wrote response
    }

    // ── /crypto/* ───────────────────────────────────────────────────────────
    else if (first === 'crypto') {
      if (!_engine) { result = { ok: false, error: 'crypto-engine not loaded' }; }
      else if (parts[1] === 'health' || !parts[1]) { result = _engine.health(); }
      else { result = null; }
    }

    // ── /modules/* — combined status ─────────────────────────────────────────
    else if (first === 'modules') {
      result = {
        ok:      true,
        modules: {
          snr:    _snr    ? { ok: true, rules: _snr.size, ...(_snr.stats()) }         : { ok: false },
          keys:   _keys   ? { ok: true, ...(_keys.stats()) }                           : { ok: false },
          hosts:  _hosts  ? { ok: true, ...(_hosts.stats()) }                          : { ok: false },
          ports:  _ports  ? { ok: true, ...(_ports.stats()) }                          : { ok: false },
          engine: _engine ? { ok: true, ...(_engine.health()) }                        : { ok: false },
          canvas: _canvas ? { ok: true, ..._canvas.watchdog() }                        : { ok: false },
        },
      };
    }

    if (result === null) return null;
    jsonRes(res, 200, result);
    return true;

  } catch (err) {
    _busEmit('modules:route_error', { path: req.url, error: err.message }, 'ERROR');
    jsonRes(res, 500, { ok: false, error: err.message });
    return true;
  }
}

// ─── Accessors for other server code ──────────────────────────────────────────
module.exports = {
  install,
  handle,
  get snr()    { return _snr;    },
  get keys()   { return _keys;   },
  get hosts()  { return _hosts;  },
  get ports()  { return _ports;  },
  get canvas() { return _canvas; },
  get engine() { return _engine; },
  VERSION:     '1.0.0',
  UUID:        'bridge-modules-wire-v1000-0000-000000000001',
};
