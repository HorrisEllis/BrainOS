/**
 * NEXUS Port Registry — v1.0.0
 * UUID: port-registry-module-v1000-0000-000000000001
 *
 * Standalone module. Tracks port → service mapping.
 * Probes port availability. Auto-remaps when blocked.
 * Persists remap history as deltas. Bridge routes /ports/*
 *
 * Axioms:
 *   - A port is either open or it isn't — probe before use
 *   - Remap is atomic — new port proven before old abandoned
 *   - Every remap is a delta — full history preserved
 *   - Dynamic range 10000–65535 for remaps
 */

'use strict';

const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');
const net    = require('net');

const VERSION     = '1.0.0';
const MODULE_UUID = 'port-registry-module-v1000-0000-000000000001';
const DYNAMIC_MIN = 10000;
const DYNAMIC_MAX = 65535;
const PROBE_TIMEOUT = 2000;

const HOOKS = {
  REGISTERED:   'port.registered',
  REMAPPED:     'port.remapped',
  PROBE_OK:     'port.probe_ok',
  PROBE_FAIL:   'port.probe_fail',
  ERROR:        'port.error',
};

function atomicWrite(filePath, content) {
  const tmp = filePath + '.tmp.' + crypto.randomBytes(4).toString('hex');
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(tmp, content, 'utf8');
    fs.renameSync(tmp, filePath);
    return true;
  } catch (e) { try { fs.unlinkSync(tmp); } catch {} throw e; }
}

function safeJSON(raw, fallback = null) {
  try { return JSON.parse(raw); } catch { return fallback; }
}

class PortRegistry {
  constructor(opts = {}) {
    this.id       = opts.id   || 'ports:' + crypto.randomBytes(4).toString('hex');
    this.uuid     = MODULE_UUID;
    this.version  = VERSION;
    this.name     = opts.name || 'Port Registry';

    // Registry: port (number) → entry
    this._ports   = new Map();

    // Remap log
    this._log     = [];
    this._maxLog  = 500;

    // Stats
    this._stats   = { registered: 0, remapped: 0, probeFails: 0, probeOks: 0 };

    // Persistence
    this._persistPath = opts.persist || null;

    // Bus + hooks
    this._busEmit = null;
    this._hooks   = new Map();

    this._load();

    // Register default bridge ports
    if (opts.defaults !== false) this._registerDefaults();
  }

  // ─── BUS ────────────────────────────────────────────────────────────────────
  connectBus(busEmit) { this._busEmit = typeof busEmit === 'function' ? busEmit : null; }
  _bus(type, data, level = 'INFO') { if (this._busEmit) try { this._busEmit('ports:' + type, data, level); } catch {} }
  on(hookId, fn) {
    if (!this._hooks.has(hookId)) this._hooks.set(hookId, []);
    this._hooks.get(hookId).push(fn);
    return () => this._hooks.set(hookId, (this._hooks.get(hookId)||[]).filter(f=>f!==fn));
  }
  _emit(hookId, data) {
    const fire = arr => arr.forEach(fn => { try { fn({ hookId, data, ts: Date.now() }); } catch {} });
    fire(this._hooks.get(hookId) || []);
    fire(this._hooks.get('*')    || []);
  }

  // ─── DEFAULTS ────────────────────────────────────────────────────────────────
  _registerDefaults() {
    const defaults = [
      { port: 3747, service: 'Bridge',    description: 'Primary bridge server' },
      { port: 3748, service: 'Hub',       description: 'Hub API proxy' },
      { port: 3749, service: 'Sentinel',  description: 'Security monitoring' },
      { port: 3750, service: 'Bridge-alt',description: 'Spare bridge port' },
      { port: 3478, service: 'TURN',      description: 'TURN server' },
      { port: 3479, service: 'STUN',      description: 'STUN server' },
      { port: 5000, service: 'Hub-backend', description: 'Hub Python backend' },
      { port: 9222, service: 'CDP',       description: 'Chrome DevTools Protocol' },
    ];
    defaults.forEach(d => {
      if (!this._ports.has(d.port)) this.register(d.port, d.service, d.description);
    });
  }

  // ─── REGISTRATION ────────────────────────────────────────────────────────────
  register(port, service, description = '') {
    if (!Number.isInteger(port) || port < 1 || port > 65535)
      return { ok: false, error: `Invalid port: ${port}` };

    const entry = {
      port,
      service:     service || `service-${port}`,
      description: description || '',
      status:      'unknown',  // unknown | open | blocked
      lastProbed:  null,
      latency:     null,
      remappedTo:  null,       // if remapped, what port is active now
      originalPort: port,
      probeCount:  0,
      failCount:   0,
      registeredAt: Date.now(),
    };
    this._ports.set(port, entry);
    this._stats.registered++;
    this._persist();
    this._emit(HOOKS.REGISTERED, { port, service });
    this._bus('registered', { port, service });
    return { ok: true, port, service };
  }

  getPort(port) {
    const e = this._ports.get(port);
    return e ? { ...e } : null;
  }

  /**
   * Get the currently active port for a service.
   * If remapped, returns the remap target.
   */
  getActivePort(port) {
    const e = this._ports.get(port);
    if (!e) return null;
    return e.remappedTo || port;
  }

  getByService(service) {
    return [...this._ports.values()].find(e => e.service.toLowerCase() === service.toLowerCase()) || null;
  }

  listPorts() {
    return [...this._ports.values()].map(e => ({ ...e }));
  }

  // ─── PROBE ───────────────────────────────────────────────────────────────────
  /**
   * Probe whether a TCP port is open on localhost.
   * Uses net.connect — checks port availability, not HTTP.
   */
  probePort(port, host = '127.0.0.1') {
    return new Promise(resolve => {
      const t0     = Date.now();
      const socket = new net.Socket();
      const timer  = setTimeout(() => {
        socket.destroy();
        resolve({ ok: false, port, error: 'timeout', latency: Date.now() - t0 });
      }, PROBE_TIMEOUT);

      socket.connect(port, host, () => {
        clearTimeout(timer);
        socket.destroy();
        resolve({ ok: true, port, latency: Date.now() - t0 });
      });

      socket.on('error', e => {
        clearTimeout(timer);
        resolve({ ok: false, port, error: e.message, latency: Date.now() - t0 });
      });
    });
  }

  /**
   * Probe all registered ports.
   */
  async probeAll(host = '127.0.0.1') {
    const results = [];
    for (const [port, entry] of this._ports.entries()) {
      const r = await this.probePort(port, host);
      entry.lastProbed = Date.now();
      entry.probeCount++;
      if (r.ok) {
        entry.status  = 'open';
        entry.latency = r.latency;
        this._stats.probeOks++;
        this._emit(HOOKS.PROBE_OK, { port, latency: r.latency });
      } else {
        entry.status = 'blocked';
        entry.failCount++;
        this._stats.probeFails++;
        this._emit(HOOKS.PROBE_FAIL, { port, error: r.error });
        this._bus('probe_fail', { port, service: entry.service, error: r.error }, 'WARN');
      }
      results.push({ port, service: entry.service, status: entry.status, latency: entry.latency });
    }
    this._persist();
    return { ok: true, results, open: results.filter(r=>r.status==='open').length, blocked: results.filter(r=>r.status==='blocked').length };
  }

  // ─── REMAP ───────────────────────────────────────────────────────────────────
  /**
   * Find an available port in the dynamic range.
   */
  async findAvailablePort(host = '127.0.0.1', attempts = 20) {
    const used = new Set(this._ports.keys());
    for (let i = 0; i < attempts; i++) {
      const candidate = Math.floor(Math.random() * (DYNAMIC_MAX - DYNAMIC_MIN + 1)) + DYNAMIC_MIN;
      if (used.has(candidate)) continue;
      // Probe it — available if connection REFUSED (nothing listening)
      // We want a port where nothing is listening so we can bind to it
      const r = await this.probePort(candidate, host);
      if (!r.ok) return candidate; // connection refused = port available
    }
    return null;
  }

  /**
   * Remap a port to a new available port.
   * Proves new port available before recording remap.
   */
  async remapPort(port, opts = {}) {
    const entry = this._ports.get(port);
    if (!entry) return { ok: false, error: `Port ${port} not registered` };

    const host     = opts.host || '127.0.0.1';
    const newPort  = opts.targetPort || await this.findAvailablePort(host);

    if (!newPort) return { ok: false, error: 'No available port found in dynamic range' };

    const from = entry.remappedTo || port;
    entry.remappedTo = newPort;
    entry.status     = 'remapped';
    this._stats.remapped++;

    const logEntry = {
      ts:       Date.now(),
      port,
      service:  entry.service,
      from,
      to:       newPort,
      reason:   opts.reason || 'manual',
    };
    this._log.unshift(logEntry);
    if (this._log.length > this._maxLog) this._log.pop();

    // Register the new port in the registry too
    if (!this._ports.has(newPort)) {
      this.register(newPort, entry.service + '-remapped', `Remapped from :${port}`);
    }

    this._persist();
    this._emit(HOOKS.REMAPPED, logEntry);
    this._bus('remapped', logEntry);
    return { ok: true, ...logEntry };
  }

  /**
   * Remap all blocked ports.
   */
  async remapAllBlocked(opts = {}) {
    const results = [];
    for (const [port, entry] of this._ports.entries()) {
      if (entry.status === 'blocked') {
        const r = await this.remapPort(port, { ...opts, reason: 'auto-remap-blocked' });
        results.push(r);
      }
    }
    return { ok: true, results, remapped: results.filter(r=>r.ok).length };
  }

  // ─── STATS ───────────────────────────────────────────────────────────────────
  stats() {
    const ports  = this.listPorts();
    return {
      ...this._stats,
      total:    ports.length,
      open:     ports.filter(p=>p.status==='open').length,
      blocked:  ports.filter(p=>p.status==='blocked').length,
      remapped: ports.filter(p=>p.remappedTo).length,
      unknown:  ports.filter(p=>p.status==='unknown').length,
      recentLog: this._log.slice(0, 10),
    };
  }

  // ─── PERSISTENCE ─────────────────────────────────────────────────────────────
  _persist() {
    if (!this._persistPath) return false;
    try {
      atomicWrite(this._persistPath, JSON.stringify({
        version: VERSION, id: this.id, uuid: MODULE_UUID, savedAt: Date.now(),
        ports:   [...this._ports.entries()].map(([,e])=>e),
        stats:   this._stats, log: this._log.slice(0, 100),
      }, null, 2));
      return true;
    } catch { return false; }
  }

  persist(savePath) { if (savePath) this._persistPath = savePath; return this._persist(); }

  _load() {
    if (!this._persistPath || !fs.existsSync(this._persistPath)) return;
    try {
      const data = safeJSON(fs.readFileSync(this._persistPath, 'utf8'), {});
      (data.ports || []).forEach(e => { if (e.port) this._ports.set(e.port, e); });
      if (data.stats) Object.assign(this._stats, data.stats);
      if (data.log)   this._log = data.log;
    } catch {}
  }

  // ─── BRIDGE ROUTES /ports/* ───────────────────────────────────────────────────
  async bridgeRoute(parts, method, body, req) {
    if (!parts[0] || parts[0] !== 'ports') return null;
    const sub = parts[1];

    if (!sub || sub === 'health')   return { ok: true, ...this.stats(), version: VERSION };
    if (sub === 'list'   && method === 'GET') return { ok: true, ports: this.listPorts() };
    if (sub === 'stats'  && method === 'GET') return { ok: true, ...this.stats() };
    if (sub === 'log'    && method === 'GET') return { ok: true, log: this._log };

    if (sub === 'register' && method === 'POST') {
      if (!body?.port) return { ok: false, error: 'body.port required' };
      return this.register(body.port, body.service, body.description);
    }
    if (sub === 'probe' && method === 'POST') {
      if (body?.port) {
        const e = this._ports.get(body.port);
        if (!e) return { ok: false, error: `Port ${body.port} not registered` };
        return await this.probePort(body.port, body.host);
      }
      return await this.probeAll(body?.host);
    }
    if (sub === 'remap' && method === 'POST') {
      if (body?.port) return await this.remapPort(body.port, body);
      return await this.remapAllBlocked(body || {});
    }
    if (sub === 'remap-all' && method === 'POST') {
      return await this.remapAllBlocked(body || {});
    }
    if (sub === 'active' && method === 'GET') {
      const url = new URL('http://x' + (req?.url||''));
      const port = parseInt(url.searchParams.get('port'));
      if (!port) return { ok: false, error: 'port query param required' };
      return { ok: true, port, active: this.getActivePort(port) };
    }

    return null;
  }
}

PortRegistry.HOOKS       = HOOKS;
PortRegistry.VERSION     = VERSION;
PortRegistry.MODULE_UUID = MODULE_UUID;
PortRegistry.DYNAMIC_MIN = DYNAMIC_MIN;
PortRegistry.DYNAMIC_MAX = DYNAMIC_MAX;
module.exports = PortRegistry;
