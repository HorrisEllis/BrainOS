/**
 * NEXUS Host Rotation — v1.0.0
 * UUID: host-rotation-module-v1000-0000-000000000001
 *
 * Standalone module. Manages alternating host list for bridge connections.
 * Probes hosts, rotates on failure, bounces to prevent traffic analysis.
 * Persists host list + rotation log to disk.
 * Bridge routes /hosts/*
 *
 * Axioms:
 *   - Dead hosts are never used — probe before rotate
 *   - Rotation log is a delta record — every change persisted
 *   - Module never silently falls back to a bad host
 *   - Bounce = intentional rotation regardless of health
 */

'use strict';

const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');
const http   = require('http');
const https  = require('https');

const VERSION     = '1.0.0';
const MODULE_UUID = 'host-rotation-module-v1000-0000-000000000001';

const HOOKS = {
  ROTATED:    'host.rotated',
  BOUNCED:    'host.bounced',
  PROBE_FAIL: 'host.probe_fail',
  PROBE_OK:   'host.probe_ok',
  ADDED:      'host.added',
  REMOVED:    'host.removed',
  ERROR:      'host.error',
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

class HostRotation {
  constructor(opts = {}) {
    this.id       = opts.id   || 'hosts:' + crypto.randomBytes(4).toString('hex');
    this.uuid     = MODULE_UUID;
    this.version  = VERSION;
    this.name     = opts.name || 'Host Rotation';

    // Host list — [{ url, name, healthy, lastProbed, latency, probeCount, failCount }]
    this._hosts   = [];
    this._current = 0; // index into _hosts

    // Config
    this._probeTimeoutMs  = opts.probeTimeout  || 2500;
    this._probeEndpoint   = opts.probeEndpoint  || '/health';
    this._rotateIntervalMs = opts.rotateInterval || 0; // 0 = manual only
    this._bounceIntervalMs = opts.bounceInterval || 0; // 0 = manual only

    // Timers
    this._rotateTimer = null;
    this._bounceTimer = null;

    // Stats
    this._stats = { rotations: 0, bounces: 0, probeFails: 0, probeOks: 0 };

    // Log
    this._log = []; // rotation events
    this._maxLog = 200;

    // Persistence
    this._persistPath = opts.persist || null;

    // Bus + hooks
    this._busEmit = null;
    this._hooks   = new Map();

    this._load();

    // Add initial hosts
    if (opts.hosts) opts.hosts.forEach(h => this.addHost(h));
  }

  // ─── BUS ────────────────────────────────────────────────────────────────────
  connectBus(busEmit) { this._busEmit = typeof busEmit === 'function' ? busEmit : null; }
  _bus(type, data, level = 'INFO') { if (this._busEmit) try { this._busEmit('hosts:' + type, data, level); } catch {} }

  // ─── HOOKS ──────────────────────────────────────────────────────────────────
  on(hookId, fn) {
    if (!this._hooks.has(hookId)) this._hooks.set(hookId, []);
    this._hooks.get(hookId).push(fn);
    return () => this._hooks.set(hookId, (this._hooks.get(hookId)||[]).filter(f=>f!==fn));
  }
  _emit(hookId, data) {
    const ts = Date.now();
    const fire = arr => arr.forEach(fn => { try { fn({ hookId, data, ts }); } catch {} });
    fire(this._hooks.get(hookId) || []);
    fire(this._hooks.get('*')    || []);
  }

  // ─── HOST MANAGEMENT ────────────────────────────────────────────────────────
  addHost(urlOrObj) {
    const url  = typeof urlOrObj === 'string' ? urlOrObj : urlOrObj.url;
    const name = typeof urlOrObj === 'object' ? (urlOrObj.name || url) : url;
    if (!url) return { ok: false, error: 'url required' };

    const existing = this._hosts.find(h => h.url === url);
    if (existing) return { ok: false, error: 'Host already exists', url };

    const host = {
      id:         crypto.randomBytes(4).toString('hex'),
      url:        url.replace(/\/$/, ''),
      name:       name.replace(/\/$/, ''),
      healthy:    null, // null = unknown, true = healthy, false = dead
      lastProbed: null,
      latency:    null,
      probeCount: 0,
      failCount:  0,
      addedAt:    Date.now(),
    };
    this._hosts.push(host);
    this._persist();
    this._emit(HOOKS.ADDED, { url, name });
    this._bus('added', { url, name });
    return { ok: true, id: host.id, url };
  }

  removeHost(urlOrId) {
    const idx = this._hosts.findIndex(h => h.url === urlOrId || h.id === urlOrId);
    if (idx === -1) return { ok: false, error: 'Host not found' };
    const removed = this._hosts.splice(idx, 1)[0];
    if (this._current >= this._hosts.length) this._current = 0;
    this._persist();
    this._emit(HOOKS.REMOVED, { url: removed.url });
    this._bus('removed', { url: removed.url });
    return { ok: true, url: removed.url };
  }

  listHosts() {
    return this._hosts.map(h => ({ ...h }));
  }

  setHosts(urls) {
    this._hosts  = [];
    this._current = 0;
    const results = urls.map(u => this.addHost(u));
    return { ok: true, added: results.filter(r => r.ok).length, total: urls.length };
  }

  // ─── CURRENT HOST ───────────────────────────────────────────────────────────
  get current() {
    if (!this._hosts.length) return null;
    return { ...this._hosts[this._current] };
  }

  get currentURL() {
    return this.current?.url || null;
  }

  // ─── PROBE ──────────────────────────────────────────────────────────────────
  /**
   * Probe a host's /health endpoint.
   * Returns { ok, latency, data } or { ok: false, error }.
   */
  async probeHost(host) {
    const url     = (host.url || host) + this._probeEndpoint;
    const t0      = Date.now();
    const timeout = this._probeTimeoutMs;

    return new Promise(resolve => {
      const ctrl = setTimeout(() => resolve({ ok: false, error: 'timeout' }), timeout);
      const module = url.startsWith('https') ? https : http;
      try {
        const req = module.get(url, { timeout }, res => {
          clearTimeout(ctrl);
          const latency = Date.now() - t0;
          if (res.statusCode === 200) {
            let buf = '';
            res.on('data', d => { buf += d; });
            res.on('end', () => {
              const data = safeJSON(buf, {});
              resolve({ ok: true, latency, data, statusCode: 200 });
            });
          } else {
            resolve({ ok: false, error: `HTTP ${res.statusCode}`, latency });
          }
        });
        req.on('error', e => { clearTimeout(ctrl); resolve({ ok: false, error: e.message }); });
        req.on('timeout', () => { req.destroy(); clearTimeout(ctrl); resolve({ ok: false, error: 'timeout' }); });
      } catch (e) { clearTimeout(ctrl); resolve({ ok: false, error: e.message }); }
    });
  }

  /**
   * Probe all hosts and update their health status.
   */
  async probeAll() {
    const results = [];
    for (const host of this._hosts) {
      const r = await this.probeHost(host);
      host.lastProbed = Date.now();
      host.probeCount++;
      if (r.ok) {
        host.healthy = true;
        host.latency  = r.latency;
        this._stats.probeOks++;
        this._emit(HOOKS.PROBE_OK, { url: host.url, latency: r.latency });
        this._bus('probe_ok', { url: host.url, latency: r.latency });
      } else {
        host.healthy = false;
        host.failCount++;
        this._stats.probeFails++;
        this._emit(HOOKS.PROBE_FAIL, { url: host.url, error: r.error });
        this._bus('probe_fail', { url: host.url, error: r.error }, 'WARN');
      }
      results.push({ url: host.url, ...r });
    }
    this._persist();
    return { ok: true, results, healthy: this._hosts.filter(h=>h.healthy).length };
  }

  // ─── ROTATION ────────────────────────────────────────────────────────────────
  /**
   * Rotate to next healthy host.
   * Probes candidates before switching.
   * @returns {{ ok, from, to, latency }}
   */
  async rotate(opts = {}) {
    if (!this._hosts.length) return { ok: false, error: 'No hosts configured' };

    const from = this.currentURL;
    const len  = this._hosts.length;

    // Find next healthy host
    for (let i = 1; i <= len; i++) {
      const nextIdx  = (this._current + i) % len;
      const candidate = this._hosts[nextIdx];
      const probe    = opts.skipProbe ? { ok: true, latency: null } : await this.probeHost(candidate);

      candidate.lastProbed = Date.now();
      candidate.probeCount++;

      if (probe.ok) {
        candidate.healthy = true;
        candidate.latency  = probe.latency;
        this._current     = nextIdx;
        this._stats.rotations++;

        const entry = { ts: Date.now(), from, to: candidate.url, latency: probe.latency, reason: opts.reason || 'rotate' };
        this._log.unshift(entry);
        if (this._log.length > this._maxLog) this._log.pop();
        this._persist();
        this._emit(HOOKS.ROTATED, entry);
        this._bus('rotated', entry);
        return { ok: true, ...entry };
      } else {
        candidate.healthy = false;
        candidate.failCount++;
      }
    }

    return { ok: false, error: 'No healthy hosts available', from };
  }

  /**
   * Bounce — rotate to next host regardless of current health.
   * Intentional rotation for traffic analysis resistance.
   */
  async bounce(opts = {}) {
    if (this._hosts.length < 2) return { ok: false, error: 'Need at least 2 hosts to bounce' };

    const from    = this.currentURL;
    const nextIdx = (this._current + 1) % this._hosts.length;
    this._current = nextIdx;
    this._stats.bounces++;

    const to    = this.currentURL;
    const entry = { ts: Date.now(), from, to, reason: opts.reason || 'bounce' };
    this._log.unshift(entry);
    if (this._log.length > this._maxLog) this._log.pop();
    this._persist();
    this._emit(HOOKS.BOUNCED, entry);
    this._bus('bounced', entry);
    return { ok: true, ...entry };
  }

  /**
   * Rotate to fastest healthy host (by latency).
   */
  async rotateToFastest() {
    await this.probeAll();
    const healthy = this._hosts
      .map((h, i) => ({ ...h, idx: i }))
      .filter(h => h.healthy && h.latency !== null)
      .sort((a, b) => a.latency - b.latency);

    if (!healthy.length) return { ok: false, error: 'No healthy hosts with latency data' };

    const fastest = healthy[0];
    const from    = this.currentURL;
    this._current = fastest.idx;
    this._stats.rotations++;

    const entry = { ts: Date.now(), from, to: fastest.url, latency: fastest.latency, reason: 'fastest' };
    this._log.unshift(entry);
    if (this._log.length > this._maxLog) this._log.pop();
    this._persist();
    this._emit(HOOKS.ROTATED, entry);
    return { ok: true, ...entry };
  }

  // ─── SCHEDULED ───────────────────────────────────────────────────────────────
  startRotationSchedule(intervalMs) {
    if (this._rotateTimer) clearInterval(this._rotateTimer);
    this._rotateIntervalMs = intervalMs;
    this._rotateTimer = setInterval(() => this.rotate({ reason: 'scheduled' }), intervalMs);
    if (this._rotateTimer.unref) this._rotateTimer.unref();
    this._bus('schedule.rotate_start', { intervalMs });
    return true;
  }

  startBounceSchedule(intervalMs) {
    if (this._bounceTimer) clearInterval(this._bounceTimer);
    this._bounceIntervalMs = intervalMs;
    this._bounceTimer = setInterval(() => this.bounce({ reason: 'scheduled' }), intervalMs);
    if (this._bounceTimer.unref) this._bounceTimer.unref();
    this._bus('schedule.bounce_start', { intervalMs });
    return true;
  }

  stopSchedules() {
    if (this._rotateTimer) { clearInterval(this._rotateTimer); this._rotateTimer = null; }
    if (this._bounceTimer) { clearInterval(this._bounceTimer); this._bounceTimer = null; }
    this._bus('schedule.stopped', {});
  }

  // ─── STATS ───────────────────────────────────────────────────────────────────
  stats() {
    return {
      ...this._stats,
      hosts:        this._hosts.length,
      healthy:      this._hosts.filter(h=>h.healthy===true).length,
      unhealthy:    this._hosts.filter(h=>h.healthy===false).length,
      unknown:      this._hosts.filter(h=>h.healthy===null).length,
      currentURL:   this.currentURL,
      currentIndex: this._current,
      rotating:     !!this._rotateTimer,
      bouncing:     !!this._bounceTimer,
      recentLog:    this._log.slice(0, 10),
    };
  }

  // ─── PERSISTENCE ─────────────────────────────────────────────────────────────
  _persist() {
    if (!this._persistPath) return false;
    try {
      atomicWrite(this._persistPath, JSON.stringify({
        version:  VERSION, id: this.id, uuid: MODULE_UUID, savedAt: Date.now(),
        hosts:    this._hosts, current: this._current,
        stats:    this._stats, log: this._log.slice(0, 50),
      }, null, 2));
      return true;
    } catch { return false; }
  }

  persist(savePath) { if (savePath) this._persistPath = savePath; return this._persist(); }

  _load() {
    if (!this._persistPath || !fs.existsSync(this._persistPath)) return;
    try {
      const data = safeJSON(fs.readFileSync(this._persistPath, 'utf8'), {});
      if (Array.isArray(data.hosts)) this._hosts = data.hosts;
      if (typeof data.current === 'number') this._current = Math.min(data.current, Math.max(0, this._hosts.length - 1));
      if (data.stats)  Object.assign(this._stats, data.stats);
      if (data.log)    this._log = data.log;
    } catch {}
  }

  toJSON() {
    return { version: VERSION, id: this.id, uuid: MODULE_UUID, name: this.name, stats: this.stats(), hosts: this.listHosts() };
  }

  // ─── BRIDGE ROUTES /hosts/* ──────────────────────────────────────────────────
  async bridgeRoute(parts, method, body, req) {
    if (!parts[0] || parts[0] !== 'hosts') return null;
    const sub = parts[1];

    if (!sub || sub === 'health') return { ok: true, ...this.stats(), version: VERSION };
    if (sub === 'list'    && method === 'GET')  return { ok: true, hosts: this.listHosts(), current: this.currentURL };
    if (sub === 'current' && method === 'GET')  return { ok: true, host: this.current };
    if (sub === 'stats'   && method === 'GET')  return { ok: true, ...this.stats() };
    if (sub === 'log'     && method === 'GET')  return { ok: true, log: this._log };

    if (sub === 'add' && method === 'POST') {
      if (!body?.url) return { ok: false, error: 'body.url required' };
      return this.addHost(body);
    }
    if (sub === 'remove' && method === 'POST') {
      if (!body?.url && !body?.id) return { ok: false, error: 'body.url or body.id required' };
      return this.removeHost(body.url || body.id);
    }
    if (sub === 'set' && method === 'POST') {
      if (!Array.isArray(body?.hosts)) return { ok: false, error: 'body.hosts[] required' };
      return this.setHosts(body.hosts);
    }

    if (sub === 'probe'    && method === 'POST') return await this.probeAll();
    if (sub === 'rotate'   && method === 'POST') return await this.rotate(body || {});
    if (sub === 'bounce'   && method === 'POST') return await this.bounce(body || {});
    if (sub === 'fastest'  && method === 'POST') return await this.rotateToFastest();

    if (sub === 'schedule' && method === 'POST') {
      const action = parts[2];
      if (action === 'rotate') { if (!body?.intervalMs) return { ok: false, error: 'body.intervalMs required' }; this.startRotationSchedule(body.intervalMs); return { ok: true, intervalMs: body.intervalMs }; }
      if (action === 'bounce') { if (!body?.intervalMs) return { ok: false, error: 'body.intervalMs required' }; this.startBounceSchedule(body.intervalMs); return { ok: true, intervalMs: body.intervalMs }; }
      if (action === 'stop')   { this.stopSchedules(); return { ok: true }; }
      return { ok: false, error: `Unknown schedule action: ${action}` };
    }

    return null;
  }
}

HostRotation.HOOKS      = HOOKS;
HostRotation.VERSION    = VERSION;
HostRotation.MODULE_UUID = MODULE_UUID;
module.exports = HostRotation;
