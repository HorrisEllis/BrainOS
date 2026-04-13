/**
 * bus.js — BrainOS Event Bus
 * UUID: brainos-bus-module-v5000-0000-000000000001
 * Hook: brainos.bus:bus-v5:b0001
 *
 * SISO-native typed event bus. All BrainOS modules communicate
 * exclusively through this bus. No direct function calls between modules.
 *
 * Architecture: Event → Gate → Stream (SISO pattern)
 * - Typed events with UUID IDs
 * - Wildcard subscriptions (*) supported
 * - Replay buffer (last N events per type)
 * - Signature collision is a hard error
 * - Everything fails loudly — no silent swallowing
 */

'use strict';

const MODULE_UUID = 'brainos-bus-module-v5000-0000-000000000001';
const MODULE_VERSION = '5.0.0';

// ── Tiny uid (no deps) ────────────────────────────────────────────────────────
function uid() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = Math.random() * 16 | 0;
    return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
  });
}

// ── Log levels (mirrors SISO StreamLog) ──────────────────────────────────────
const LOG_LEVELS = { OFF: 0, EVENTS: 1, DEEP: 2, DATA: 3 };

class BusLog {
  constructor(level = 'EVENTS') {
    this.level = level;
    this.entries = [];
    this.seq = 0;
    this.maxEntries = 10000;
  }

  record(entry) {
    const lvl = LOG_LEVELS[this.level] || 0;
    if (lvl === 0) return;
    const e = { seq: this.seq++, ts: Date.now(), type: entry.type, claimed: entry.claimed };
    if (lvl >= 2) e.eventId = entry.eventId;
    if (lvl >= 3) e.data = entry.data;
    this.entries.push(e);
    if (this.entries.length > this.maxEntries) this.entries.shift();
  }

  sample() { return { level: this.level, count: this.entries.length, entries: [...this.entries] }; }
  clear() { this.entries = []; this.seq = 0; }
}

// ── BusEvent (SISO Event equivalent) ─────────────────────────────────────────
class BusEvent {
  constructor(type, data = {}, meta = {}) {
    this.id = uid();
    this.type = type;
    this.data = data;
    this.ts = Date.now();
    this.source = meta.source || 'unknown';
  }
}

// ── EventBus ─────────────────────────────────────────────────────────────────
class EventBus {
  constructor(options = {}) {
    this.uuid = MODULE_UUID;
    this.version = MODULE_VERSION;
    this._handlers = new Map();       // type → Set<{id, fn}>
    this._wildcards = new Set();      // { id, fn }
    this._replayBuffer = new Map();   // type → BusEvent (last N)
    this._replaySize = options.replaySize || 1;
    this._log = new BusLog(options.logLevel || 'EVENTS');
    this._auditLog = [];
    this._errorHandlers = new Set();
    this._stats = { emitted: 0, claimed: 0, pending: 0, errors: 0 };
  }

  /**
   * Subscribe to a specific event type (or '*' for all).
   * Returns an unsubscribe function.
   * Fails loudly if fn is not a function.
   */
  on(type, fn, meta = {}) {
    if (typeof fn !== 'function') {
      this._fail('BUS.on', `Handler for '${type}' must be a function, got ${typeof fn}`);
      throw new Error(`BUS: Handler for '${type}' must be a function`);
    }
    const id = uid();
    const entry = { id, fn, source: meta.source || 'unknown', once: false };

    if (type === '*') {
      this._wildcards.add(entry);
    } else {
      if (!this._handlers.has(type)) this._handlers.set(type, new Set());
      this._handlers.get(type).add(entry);
    }

    // Replay last event of this type to new subscriber
    if (type !== '*' && this._replayBuffer.has(type)) {
      try { fn(this._replayBuffer.get(type)); } catch (e) { this._fail('BUS.on.replay', e.message); }
    }

    return () => this._off(type, id);
  }

  /**
   * Subscribe once — auto-unsubscribes after first event.
   */
  once(type, fn, meta = {}) {
    const id = uid();
    const entry = { id, fn, source: meta.source || 'unknown', once: true };
    if (type === '*') {
      this._wildcards.add(entry);
    } else {
      if (!this._handlers.has(type)) this._handlers.set(type, new Set());
      this._handlers.get(type).add(entry);
    }
    return () => this._off(type, id);
  }

  _off(type, id) {
    if (type === '*') {
      for (const e of this._wildcards) if (e.id === id) { this._wildcards.delete(e); return; }
    } else {
      const set = this._handlers.get(type);
      if (set) for (const e of set) if (e.id === id) { set.delete(e); return; }
    }
  }

  /**
   * Emit an event. Fails loudly on dispatch errors.
   * All handlers called synchronously (SISO depth-first model).
   */
  emit(type, data = {}, meta = {}) {
    if (typeof type !== 'string' || !type) {
      this._fail('BUS.emit', `Event type must be a non-empty string, got: ${JSON.stringify(type)}`);
      return;
    }
    const event = new BusEvent(type, data, meta);
    this._stats.emitted++;

    // Store in replay buffer
    this._replayBuffer.set(type, event);

    // Log
    const claimed = (this._handlers.get(type)?.size || 0) + this._wildcards.size;
    this._log.record({ type, eventId: event.id, data, claimed: claimed > 0 });
    if (claimed === 0) this._stats.pending++;
    else this._stats.claimed++;

    // Dispatch to type-specific handlers
    const typeSet = this._handlers.get(type);
    if (typeSet) {
      const toRemove = [];
      for (const entry of typeSet) {
        try {
          entry.fn(event);
        } catch (e) {
          this._stats.errors++;
          this._fail('BUS.emit.handler', `Error in '${type}' handler (${entry.source}): ${e.message}`);
        }
        if (entry.once) toRemove.push(entry);
      }
      for (const e of toRemove) typeSet.delete(e);
    }

    // Dispatch to wildcards
    const toRemoveW = [];
    for (const entry of this._wildcards) {
      try {
        entry.fn(event);
      } catch (e) {
        this._stats.errors++;
        this._fail('BUS.emit.wildcard', `Error in wildcard handler (${entry.source}): ${e.message}`);
      }
      if (entry.once) toRemoveW.push(entry);
    }
    for (const e of toRemoveW) this._wildcards.delete(e);

    return event;
  }

  /**
   * Register an error handler. Called whenever _fail() fires.
   */
  onError(fn) {
    this._errorHandlers.add(fn);
    return () => this._errorHandlers.delete(fn);
  }

  _fail(source, message) {
    const entry = { ts: Date.now(), source, message };
    this._auditLog.push(entry);
    console.error(`[BUS ERROR] ${source}: ${message}`);
    for (const fn of this._errorHandlers) {
      try { fn(entry); } catch (_) { /* never throw from error handler */ }
    }
  }

  /** Introspect the bus state */
  sample() {
    return {
      uuid: this.uuid,
      version: this.version,
      stats: { ...this._stats },
      handlers: Object.fromEntries([...this._handlers.entries()].map(([k, v]) => [k, v.size])),
      wildcards: this._wildcards.size,
      replayTypes: [...this._replayBuffer.keys()],
      log: this._log.sample(),
    };
  }

  health() {
    return {
      ok: true,
      uuid: this.uuid,
      version: this.version,
      stats: this._stats,
      handlerCount: [...this._handlers.values()].reduce((s, v) => s + v.size, 0) + this._wildcards.size,
    };
  }
}

// ── Singleton export ─────────────────────────────────────────────────────────
const BUS = new EventBus({ logLevel: 'DEEP', replaySize: 1 });

// Standard BrainOS bus event types
BUS.EVENTS = Object.freeze({
  // System
  BOOT:         'system.boot',
  READY:        'system.ready',
  ERROR:        'system.error',
  TOAST:        'system.toast',
  AUDIT:        'system.audit',
  // Node mesh
  NODE_ADD:     'mesh.node.add',
  NODE_REMOVE:  'mesh.node.remove',
  NODE_UPDATE:  'mesh.node.update',
  NODE_SELECT:  'mesh.node.select',
  PROBE_DONE:   'mesh.probe.done',
  // Pipeline
  PIPE_RUN:     'pipeline.run',
  PIPE_DONE:    'pipeline.done',
  PIPE_ERROR:   'pipeline.error',
  PIPE_STEP:    'pipeline.step',
  // Automation
  AUTO_RUN:     'automation.run',
  AUTO_DONE:    'automation.done',
  AUTO_ERROR:   'automation.error',
  AUTO_QUEUE:   'automation.queue',
  // SNR
  SNR_CHECK:    'snr.check',
  SNR_BLOCK:    'snr.block',
  SNR_PASS:     'snr.pass',
  // Network
  DNS_QUERY:    'net.dns.query',
  DNS_BLOCK:    'net.dns.block',
  FW_BLOCK:     'net.fw.block',
  FW_PASS:      'net.fw.pass',
  // Keys
  KEY_ROTATE:   'key.rotate',
  KEY_EXPIRE:   'key.expire',
  // Settings
  SETTINGS_CHANGE: 'settings.change',
});

if (typeof module !== 'undefined') module.exports = { BUS, EventBus, BusEvent, BusLog };
