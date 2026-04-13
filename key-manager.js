/**
 * NEXUS Key Manager — v1.0.0
 * UUID: key-manager-module-v1000-0000-000000000001
 *
 * Standalone module. Manages logical key lifecycle:
 *   - Tracks rotation ages for: session, e2e, gate, TURN
 *   - Scheduled auto-rotation (configurable interval per key type)
 *   - Anomaly-triggered rotation (delta threshold)
 *   - Persists key state to canvas-keys.json (Phase 1)
 *   - Optionally uses crypto-engine.js for real key material
 *   - Bridge routes /keys/*
 *   - Bus integration (optional)
 *   - Hook system
 *
 * Two modes:
 *   LOGICAL — tracks rotation timestamps + metadata only
 *             key material generated externally or not needed
 *   MATERIAL — uses crypto-engine.js to generate real AES/ECDH keys
 *              wraps/stores them encrypted in key store
 *
 * Axioms:
 *   - Key material never logged, never emitted to bus
 *   - Rotation is atomic (write new state before invalidating old)
 *   - Persistence on every rotation
 *   - Gates fail loudly — rotation failure is an error event
 */

'use strict';

const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');

const VERSION     = '1.0.0';
const MODULE_UUID = 'key-manager-module-v1000-0000-000000000001';

// ─── Default rotation intervals (ms) ─────────────────────────────────────────
const DEFAULTS = {
  session:  60 * 60 * 1000,       // 1 hour
  e2e:      15 * 60 * 1000,       // 15 minutes
  gate:     24 * 60 * 60 * 1000,  // 24 hours (on-demand usually)
  turn:     24 * 60 * 60 * 1000,  // 24 hours (TURN credential TTL)
};

// Hook IDs
const HOOKS = {
  ROTATED:      'key.rotated',
  ROTATION_FAIL:'key.rotation_fail',
  SCHEDULED:    'key.schedule_tick',
  MATERIAL_GEN: 'key.material_gen',
  PERSIST:      'key.persist',
  ERROR:        'key.error',
};

// ─── Atomic write ─────────────────────────────────────────────────────────────
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

// ─── KeyManager ───────────────────────────────────────────────────────────────
class KeyManager {
  constructor(opts = {}) {
    this.id          = opts.id   || 'keys:' + crypto.randomBytes(4).toString('hex');
    this.uuid        = MODULE_UUID;
    this.version     = VERSION;
    this.name        = opts.name || 'Key Manager';

    // Persistence
    this._persistPath = opts.persist || null;

    // Optional crypto engine for material mode
    this._engine = opts.cryptoEngine || null;

    // Bus
    this._busEmit = null;

    // Hooks
    this._hooks = new Map();

    // Key state — each entry:
    // { id, type, rotatedAt, intervalMs, stale, material? }
    this._keys = new Map();

    // Rotation timers
    this._timers = new Map();

    // Stats
    this._stats = { rotations: 0, failures: 0, generated: 0 };

    // Load persisted state
    this._load();

    // Ensure all default key types exist
    this._ensureDefaults(opts.intervals || {});
  }

  // ─── BUS ────────────────────────────────────────────────────────────────────
  connectBus(busEmit) {
    this._busEmit = typeof busEmit === 'function' ? busEmit : null;
  }

  _bus(type, data, level = 'INFO') {
    if (this._busEmit) try { this._busEmit('keys:' + type, data, level); } catch {}
  }

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

  // ─── ENSURE DEFAULTS ────────────────────────────────────────────────────────
  _ensureDefaults(customIntervals = {}) {
    const types = ['session', 'e2e', 'gate', 'turn'];
    const now   = Date.now();
    types.forEach(type => {
      if (!this._keys.has(type)) {
        this._keys.set(type, {
          id:         type,
          type,
          rotatedAt:  now,
          intervalMs: customIntervals[type] || DEFAULTS[type],
          stale:      false,
          material:   null, // populated in material mode
        });
      } else if (customIntervals[type]) {
        this._keys.get(type).intervalMs = customIntervals[type];
      }
    });
  }

  // ─── KEY STATE ──────────────────────────────────────────────────────────────
  /**
   * Get key state (never returns raw key material).
   */
  getKey(type) {
    const k = this._keys.get(type);
    if (!k) return null;
    const { material, ...safe } = k; // strip material from public view
    return {
      ...safe,
      ageMs:   Date.now() - k.rotatedAt,
      ageMin:  Math.round((Date.now() - k.rotatedAt) / 60000),
      isStale: this._isStale(k),
    };
  }

  listKeys() {
    return [...this._keys.keys()].map(t => this.getKey(t));
  }

  _isStale(k) {
    return (Date.now() - k.rotatedAt) > k.intervalMs;
  }

  // ─── ROTATE ─────────────────────────────────────────────────────────────────
  /**
   * Rotate a key type.
   * In logical mode: updates rotatedAt timestamp.
   * In material mode: generates new key material via crypto engine.
   *
   * @param {string} type — 'session' | 'e2e' | 'gate' | 'turn'
   * @param {object} opts — { reason, force, turnSecret }
   * @returns {{ ok, type, rotatedAt, ageMs, material? }}
   */
  rotate(type, opts = {}) {
    let k = this._keys.get(type);
    if (!k) {
      // Create new key type on the fly
      k = { id: type, type, rotatedAt: 0, intervalMs: DEFAULTS[type] || 60*60*1000, stale: false, material: null };
      this._keys.set(type, k);
    }

    const prevRotatedAt = k.rotatedAt;
    const now           = Date.now();
    let newMaterial     = null;

    try {
      // Material mode — generate real key
      if (this._engine) {
        if (type === 'turn') {
          const turnSecret = opts.turnSecret || (k.material?.secret) || this._genSecret();
          const cred = this._engine.generateTURNCredential(turnSecret, 86400);
          if (!cred.ok) throw new Error(cred.error);
          newMaterial = {
            type:     'turn-credential',
            username: cred.username,
            password: cred.password,
            expiry:   cred.expiry,
            secret:   turnSecret, // store for next rotation
          };
        } else if (type === 'e2e' || type === 'gate') {
          const keyResult = this._engine.generateKey();
          if (!keyResult.ok) throw new Error(keyResult.error);
          // Encrypt material at rest using a local wrapping key
          const wrappingKey = this._getOrCreateWrappingKey();
          const wrapped     = this._engine.encrypt(wrappingKey, keyResult.hex);
          if (!wrapped.ok) throw new Error(wrapped.error);
          newMaterial = { type: 'aes-256', wrapped, algorithm: 'AES-256-GCM' };
          this._stats.generated++;
          this._emit(HOOKS.MATERIAL_GEN, { keyType: type });
        } else if (type === 'session') {
          const kp = this._engine.generateECDH();
          if (!kp.ok) throw new Error(kp.error);
          // Store public key only — private key stays ephemeral in this context
          // For actual P2P use, derive session key via deriveSessionKey()
          newMaterial = {
            type:      'ecdh-p256',
            publicKey: kp.publicKey,
            // privateKey intentionally omitted from persistent store
            curve:     'prime256v1',
          };
          this._stats.generated++;
          this._emit(HOOKS.MATERIAL_GEN, { keyType: type });
        }
      }

      // Update key state atomically — write new before invalidating old
      k.rotatedAt = now;
      k.stale     = false;
      if (newMaterial) k.material = newMaterial;

      this._persist();
      this._stats.rotations++;

      const result = {
        type,
        rotatedAt:   now,
        prevRotatedAt,
        ageMs:       now - prevRotatedAt,
        reason:      opts.reason || 'manual',
        hasMaterial: !!newMaterial,
      };

      this._emit(HOOKS.ROTATED, result);
      this._bus('rotated', { type, reason: opts.reason || 'manual' });
      return { ok: true, ...result };

    } catch (e) {
      this._stats.failures++;
      this._emit(HOOKS.ROTATION_FAIL, { type, error: e.message });
      this._bus('rotation_fail', { type, error: e.message }, 'ERROR');
      return { ok: false, error: e.message, type };
    }
  }

  /**
   * Rotate all key types.
   */
  rotateAll(opts = {}) {
    const results = {};
    for (const type of this._keys.keys()) {
      results[type] = this.rotate(type, { ...opts, reason: opts.reason || 'rotate_all' });
    }
    return { ok: Object.values(results).every(r => r.ok), results };
  }

  /**
   * Rotate all stale keys (past their interval).
   */
  rotateStale() {
    const rotated = [];
    for (const [type, k] of this._keys.entries()) {
      if (this._isStale(k)) {
        const r = this.rotate(type, { reason: 'stale' });
        rotated.push({ type, ok: r.ok });
      }
    }
    return { ok: true, rotated };
  }

  // ─── SCHEDULED ROTATION ──────────────────────────────────────────────────────
  /**
   * Start automatic rotation for a key type.
   * @param {string} type
   * @param {number?} intervalMs — overrides stored interval
   */
  startSchedule(type, intervalMs = null) {
    this.stopSchedule(type);
    const k = this._keys.get(type);
    if (!k) return false;
    const ms = intervalMs || k.intervalMs;
    if (intervalMs) k.intervalMs = ms;

    const timer = setInterval(() => {
      this._emit(HOOKS.SCHEDULED, { type, intervalMs: ms });
      this.rotate(type, { reason: 'scheduled' });
    }, ms);

    // Don't block Node exit
    if (timer.unref) timer.unref();
    this._timers.set(type, timer);
    this._bus('schedule.start', { type, intervalMs: ms });
    return true;
  }

  stopSchedule(type) {
    const timer = this._timers.get(type);
    if (timer) { clearInterval(timer); this._timers.delete(type); }
  }

  /**
   * Start all schedules based on stored intervals.
   */
  startAllSchedules() {
    for (const type of this._keys.keys()) this.startSchedule(type);
    this._bus('schedule.all_started', { types: [...this._keys.keys()] });
  }

  stopAllSchedules() {
    for (const type of this._timers.keys()) this.stopSchedule(type);
    this._bus('schedule.all_stopped', {});
  }

  /**
   * Update rotation interval for a key type.
   */
  setInterval(type, intervalMs) {
    const k = this._keys.get(type);
    if (!k) return false;
    k.intervalMs = intervalMs;
    // Restart timer if running
    if (this._timers.has(type)) this.startSchedule(type, intervalMs);
    this._persist();
    return true;
  }

  // ─── ECDH SESSION KEY DERIVATION ─────────────────────────────────────────────
  /**
   * Full ECDH → HKDF → AES session key derivation.
   * Uses crypto engine if available.
   * @returns {{ ok, localPublicKey, sessionKeyFn }}
   * sessionKeyFn(peerPublicKey) → { ok, sessionKey }
   */
  initiateKeyExchange(context = 'nexus-bridge-session') {
    if (!this._engine)
      return { ok: false, error: 'crypto-engine required for key exchange — pass cryptoEngine in constructor opts' };

    const kp = this._engine.generateECDH();
    if (!kp.ok) return kp;

    return {
      ok: true,
      localPublicKey: kp.publicKey,
      context,
      completeExchange: (peerPublicKey) => {
        return this._engine.deriveSessionKey(kp.privateKey, peerPublicKey, context);
      },
    };
  }

  // ─── TURN CREDENTIALS ────────────────────────────────────────────────────────
  /**
   * Get current TURN credential (generates if engine available, else returns stored).
   */
  getTURNCredential(turnSecret = null) {
    const k = this._keys.get('turn');
    if (k?.material?.type === 'turn-credential' && !this._isStale(k)) {
      return { ok: true, ...k.material };
    }
    // Generate or rotate
    return this.rotate('turn', { turnSecret });
  }

  // ─── MATERIAL ACCESS (controlled) ────────────────────────────────────────────
  /**
   * Get decrypted key material for a key type.
   * Only available in material mode with crypto engine.
   * Returns the raw AES key for use in encryption operations.
   * Not logged. Not emitted.
   */
  getMaterial(type) {
    if (!this._engine)
      return { ok: false, error: 'crypto-engine required for material access' };

    const k = this._keys.get(type);
    if (!k?.material) return { ok: false, error: `No material for key type: ${type}` };

    if (k.material.type === 'aes-256') {
      const wrappingKey = this._getOrCreateWrappingKey();
      const unwrapped   = this._engine.unwrapKey(wrappingKey, k.material.wrapped);
      if (!unwrapped.ok) return unwrapped;
      return { ok: true, key: unwrapped.key, hex: unwrapped.hex, type: 'aes-256' };
    }

    if (k.material.type === 'turn-credential') {
      return { ok: true, ...k.material };
    }

    if (k.material.type === 'ecdh-p256') {
      return { ok: true, publicKey: k.material.publicKey, type: 'ecdh-p256' };
    }

    return { ok: false, error: `Unknown material type: ${k.material.type}` };
  }

  // ─── WRAPPING KEY ────────────────────────────────────────────────────────────
  _getOrCreateWrappingKey() {
    // Derive wrapping key from a stable secret — process-lifetime secret
    // In production this would be from a hardware key, HSM, or vault master key
    if (!this._wrappingKey) {
      const secret = process.env.NEXUS_WRAPPING_SECRET || this.id;
      this._wrappingKey = crypto.scryptSync(secret, 'key-manager-wrapping-salt-v1', 32, { N: 1024, r: 1, p: 1 });
    }
    return this._wrappingKey;
  }

  _genSecret() {
    return crypto.randomBytes(32).toString('hex');
  }

  // ─── STATS ───────────────────────────────────────────────────────────────────
  stats() {
    const now = Date.now();
    return {
      ...this._stats,
      keys: [...this._keys.values()].map(k => ({
        type:       k.type,
        ageMs:      now - k.rotatedAt,
        ageMin:     Math.round((now - k.rotatedAt) / 60000),
        intervalMs: k.intervalMs,
        intervalMin:Math.round(k.intervalMs / 60000),
        stale:      this._isStale(k),
        scheduled:  this._timers.has(k.type),
        hasMaterial:!!k.material,
      })),
      scheduleCount: this._timers.size,
    };
  }

  // ─── PERSISTENCE ─────────────────────────────────────────────────────────────
  _persist() {
    if (!this._persistPath) return false;
    try {
      const payload = {
        version:  VERSION,
        id:       this.id,
        uuid:     MODULE_UUID,
        savedAt:  Date.now(),
        keys:     [...this._keys.values()].map(k => ({
          ...k,
          // Strip in-memory only fields, keep material (wrapped)
          _stale: undefined,
        })),
        stats: this._stats,
      };
      atomicWrite(this._persistPath, JSON.stringify(payload, null, 2));
      this._emit(HOOKS.PERSIST, { path: this._persistPath });
      return true;
    } catch (e) {
      this._emit(HOOKS.ERROR, { code: 'persist', error: e.message });
      this._bus('persist_fail', { error: e.message }, 'ERROR');
      return false;
    }
  }

  persist(savePath) {
    if (savePath) this._persistPath = savePath;
    return this._persist();
  }

  _load() {
    if (!this._persistPath) return;
    try {
      if (!fs.existsSync(this._persistPath)) return;
      const data = safeJSON(fs.readFileSync(this._persistPath, 'utf8'), {});
      (data.keys || []).forEach(k => {
        if (k.type) this._keys.set(k.type, { ...k });
      });
      if (data.stats) Object.assign(this._stats, data.stats);
    } catch {}
  }

  toJSON() {
    return {
      version: VERSION,
      id:      this.id,
      uuid:    MODULE_UUID,
      name:    this.name,
      keys:    this.listKeys(),
      stats:   this.stats(),
    };
  }

  // ─── BRIDGE ROUTES /keys/* ────────────────────────────────────────────────────
  async bridgeRoute(parts, method, body, req) {
    if (!parts[0] || parts[0] !== 'keys') return null;
    const sub = parts[1];

    // GET /keys/health
    if (!sub || sub === 'health') {
      return { ok: true, ...this.stats(), version: VERSION, uuid: MODULE_UUID, materialMode: !!this._engine };
    }

    // GET /keys/list
    if (sub === 'list' && method === 'GET') {
      return { ok: true, keys: this.listKeys() };
    }

    // POST /keys/rotate/:type
    if (sub === 'rotate' && parts[2] && method === 'POST') {
      const result = this.rotate(parts[2], body || {});
      return result;
    }

    // POST /keys/rotate-all
    if (sub === 'rotate-all' && method === 'POST') {
      return this.rotateAll(body || {});
    }

    // POST /keys/rotate-stale
    if (sub === 'rotate-stale' && method === 'POST') {
      return this.rotateStale();
    }

    // POST /keys/schedule/:type/start
    if (sub === 'schedule' && parts[2] && parts[3] === 'start') {
      const intervalMs = body?.intervalMs || null;
      const ok         = this.startSchedule(parts[2], intervalMs);
      return { ok, type: parts[2], intervalMs };
    }

    // POST /keys/schedule/:type/stop
    if (sub === 'schedule' && parts[2] && parts[3] === 'stop') {
      this.stopSchedule(parts[2]);
      return { ok: true, type: parts[2] };
    }

    // POST /keys/schedule/all/start
    if (sub === 'schedule' && parts[2] === 'all' && parts[3] === 'start') {
      this.startAllSchedules();
      return { ok: true };
    }

    // POST /keys/interval/:type
    if (sub === 'interval' && parts[2] && method === 'POST') {
      if (!body?.intervalMs) return { ok: false, error: 'body.intervalMs required' };
      const ok = this.setInterval(parts[2], body.intervalMs);
      return { ok, type: parts[2], intervalMs: body.intervalMs };
    }

    // POST /keys/exchange — initiate ECDH key exchange
    if (sub === 'exchange' && method === 'POST') {
      const exch = this.initiateKeyExchange(body?.context);
      if (!exch.ok) return exch;
      return { ok: true, localPublicKey: exch.localPublicKey, context: exch.context };
    }

    // POST /keys/turn — get/generate TURN credential
    if (sub === 'turn' && method === 'POST') {
      return this.getTURNCredential(body?.turnSecret);
    }

    // GET /keys/stats
    if (sub === 'stats' && method === 'GET') {
      return { ok: true, ...this.stats() };
    }

    return null;
  }
}

// ─── Static exports ────────────────────────────────────────────────────────────
KeyManager.HOOKS      = HOOKS;
KeyManager.DEFAULTS   = DEFAULTS;
KeyManager.VERSION    = VERSION;
KeyManager.MODULE_UUID = MODULE_UUID;

module.exports = KeyManager;
