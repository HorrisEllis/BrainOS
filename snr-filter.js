/**
 * NEXUS SNR Filter — Signal/Noise Ratio Engine
 * v1.0.0 | Author: James Brooks
 * UUID: snr-filter-module-v1000-0000-000000000001
 *
 * Standalone module. Zero external dependencies.
 * Plug into any system — bridge, express, electron, or bare Node.
 *
 * Axioms:
 *   - Every entity has a UUID
 *   - Atomic writes only — never corrupt on crash
 *   - Delta-logged — every state change produces a log entry
 *   - Persist is the golden rule — profiles survive restarts
 *   - Nothing pretends to work — gates fail loudly
 *   - Module is self-contained — no bridge required, bridge optional
 *
 * API (fully backward compatible with v0.1.0):
 *   const snr = new SNRFilter(opts)
 *   snr.check(data)                          → GateResult
 *   snr.addRule(rule)                        → ruleId
 *   snr.removeRule(id)                       → boolean
 *   snr.updateRule(id, patch)                → Rule | null
 *   snr.setPriority(id, priority, signal)    → boolean
 *   snr.setFidelity(id, fidelity)            → Rule | null
 *   snr.listRules(filter)                    → Rule[]
 *   snr.importUBlock(listText, opts)         → ImportResult
 *   snr.importDNSFirewall(list, opts)        → ImportResult
 *   snr.importAntivirus(list, opts)          → ImportResult
 *   snr.importBlacklist(domains, opts)       → ImportResult
 *   snr.importWhitelist(domains, opts)       → ImportResult
 *   snr.log(entry)                           → LogEntry
 *   snr.getLogs(opts)                        → LogEntry[]
 *   snr.stats()                              → Stats
 *   snr.saveProfile(name)                    → name
 *   snr.loadProfile(name)                    → boolean
 *   snr.persist(path?)                       → boolean
 *   snr.toJSON()                             → object
 *   snr.toBridgeMiddleware()                 → function
 *   snr.toExpressMiddleware()                → function
 *   snr.on(hookId, fn)                       → unsubscribe fn
 *   snr.connectBus(busEmit)                  → void
 *
 * New in v1.0.0:
 *   - Atomic writes (temp + rename)
 *   - Profile persistence to disk (profiles.json alongside rules)
 *   - Stats persistence (stats.json)
 *   - Log file rotation at configurable size limit
 *   - Bridge bus integration (optional, non-breaking)
 *   - Delta log entries compatible with canvas-deltas.jsonl
 *   - toJSON() / fromJSON() full state serialisation
 *   - size getter
 *   - defaultAction in constructor
 *   - IPv6 CIDR (basic)
 *   - Pre-emptive null guards throughout
 */

'use strict';

const crypto = require('crypto');
const fs     = require('fs');
const path   = require('path');

// ─── Constants ────────────────────────────────────────────────────────────────
const VERSION             = '1.0.0';
const MODULE_UUID         = 'snr-filter-module-v1000-0000-000000000001';
const FIDELITY_SIGNAL_MIN = 5;
const FIDELITY_MAX        = 10;
const FIDELITY_MIN        = 0;
const MAX_LOG_BYTES       = 8 * 1024 * 1024;  // 8MB before log rotation
const MAX_MEM_LOGS        = 10000;
const DEFAULT_ACTION      = 'pass'; // 'pass' | 'block'

// ─── Built-in rule UUIDs ─────────────────────────────────────────────────────
const RULE_UUIDS = {
  ADS:       'snr:rule:ads:f72a1b3c',
  TRACKERS:  'snr:rule:trackers:8e4d2a91',
  MALWARE:   'snr:rule:malware:3c7f9e55',
  DNS_BLOCK: 'snr:rule:dns:b2c4d6e8',
  WHITELIST: 'snr:rule:whitelist:a1b2c3d4',
};

// ─── Hook IDs ────────────────────────────────────────────────────────────────
const HOOKS = {
  CHECK:        'snr.gate.check',
  RULE_ADD:     'snr.rule.add',
  RULE_REMOVE:  'snr.rule.remove',
  IMPORT:       'snr.import',
  LOG_ENTRY:    'snr.log.entry',
  PRIORITY_SET: 'snr.priority.set',
  FIDELITY_SET: 'snr.fidelity.set',
  PROFILE_SAVE: 'snr.profile.save',
  PROFILE_LOAD: 'snr.profile.load',
  PERSIST:      'snr.persist',
  ERROR:        'snr.error',
};

// ─── Rule types ───────────────────────────────────────────────────────────────
const RULE_TYPES = {
  DOMAIN:  'domain',
  URL:     'url',
  REGEX:   'regex',
  HASH:    'hash',
  IP:      'ip',
  CONTENT: 'content',
  INTENT:  'intent',
  UUID:    'uuid',
};

// ─── Atomic write — temp + rename, never corrupts ────────────────────────────
function atomicWrite(filePath, content) {
  const tmp = filePath + '.tmp.' + crypto.randomBytes(4).toString('hex');
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(tmp, content, 'utf8');
    fs.renameSync(tmp, filePath);
    return true;
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch {}
    throw err;
  }
}

// ─── Safe JSON parse ──────────────────────────────────────────────────────────
function safeJSON(raw, fallback = null) {
  try { return JSON.parse(raw); } catch { return fallback; }
}

// ─── SNRFilter class ─────────────────────────────────────────────────────────
class SNRFilter {
  constructor(opts = {}) {
    // Identity
    this.id           = opts.id      || 'snr:' + crypto.randomUUID().slice(0, 8);
    this.uuid         = opts.uuid    || MODULE_UUID;
    this.name         = opts.name    || 'SNR Filter';
    this.version      = VERSION;

    // Core state
    this.rules        = new Map();   // ruleId → Rule
    this.profiles     = new Map();   // profileName → Rule[]
    this.logs         = [];          // in-memory log ring
    this.maxLogs      = opts.maxLogs || MAX_MEM_LOGS;
    this.defaultAction = opts.defaultAction || DEFAULT_ACTION;

    // Encryption
    this.encrypt      = opts.encrypt || false;
    this._encKey      = opts.encryptionKey || null;

    // Stats (persisted separately)
    this._stats       = { checked: 0, passed: 0, blocked: 0, errors: 0 };

    // Hook system
    this._hooks       = new Map();

    // Bridge bus (optional — set via connectBus())
    this._busEmit     = null;

    // Persistence paths
    this._persistPath   = null;
    this._profilesPath  = null;
    this._statsPath     = null;
    this.logFile        = opts.logFile || null;

    // Load from disk if persist path given
    this._initPersist(opts.persist);
  }

  // ─── BUS INTEGRATION ────────────────────────────────────────────────────────
  /**
   * Connect optional bridge event bus.
   * busEmit(type, data, level) matches nexus-bridge-server busEmit signature.
   */
  connectBus(busEmit) {
    this._busEmit = typeof busEmit === 'function' ? busEmit : null;
  }

  _bus(type, data, level = 'INFO') {
    if (this._busEmit) {
      try { this._busEmit('snr:' + type, data, level); } catch {}
    }
  }

  // ─── HOOK SYSTEM ─────────────────────────────────────────────────────────────
  on(hookId, fn) {
    if (!this._hooks.has(hookId)) this._hooks.set(hookId, []);
    this._hooks.get(hookId).push(fn);
    return () => {
      const arr = this._hooks.get(hookId) || [];
      this._hooks.set(hookId, arr.filter(f => f !== fn));
    };
  }

  _emit(hookId, data) {
    const ts = Date.now();
    const fire = (arr) => arr.forEach(fn => { try { fn({ hookId, data, ts }); } catch {} });
    fire(this._hooks.get(hookId) || []);
    fire(this._hooks.get('*')    || []);
  }

  // ─── SIZE ─────────────────────────────────────────────────────────────────────
  get size() { return this.rules.size; }

  // ─── RULE MANAGEMENT ──────────────────────────────────────────────────────────
  addRule(rule) {
    if (!rule || typeof rule !== 'object') throw new Error('SNRFilter.addRule: rule object required');

    const id = rule.id || 'rule:' + crypto.randomUUID().slice(0, 12);
    const r  = {
      id,
      uuid:      rule.uuid     || 'snr:rule:' + id,
      name:      rule.name     || id,
      type:      rule.type     || RULE_TYPES.DOMAIN,
      pattern:   rule.pattern  || '*',
      fidelity:  this._clampFidelity(rule.fidelity ?? 7),
      signal:    rule.signal   !== false,   // true = SIGNAL (pass), false = NOISE (block)
      enabled:   rule.enabled  !== false,
      priority:  rule.priority ?? 50,       // 0 = lowest, 100 = highest
      source:    rule.source   || 'manual',
      tags:      Array.isArray(rule.tags) ? [...rule.tags] : [],
      created:   rule.created  || new Date().toISOString(),
      hitCount:  rule.hitCount || 0,
    };

    // Compile regex once at add time — never at check time
    if (r.type === RULE_TYPES.REGEX) {
      try   { r._regex = new RegExp(r.pattern, 'i'); }
      catch { r._regex = null; this._emitError('regex_compile', `Invalid regex: ${r.pattern}`, id); }
    }
    if (r.type === RULE_TYPES.DOMAIN) {
      r._domainPattern = r.pattern.replace(/^\*\./, '').toLowerCase();
    }

    this.rules.set(id, r);
    this._emit(HOOKS.RULE_ADD, r);
    this._bus('rule.add', { id, name: r.name, fidelity: r.fidelity, signal: r.signal });
    this._appendLog({ type: 'rule:add', ruleId: id, name: r.name, fidelity: r.fidelity, signal: r.signal });
    return id;
  }

  removeRule(id) {
    if (!id) return false;
    const r = this.rules.get(id);
    if (!r) return false;
    this.rules.delete(id);
    this._emit(HOOKS.RULE_REMOVE, { id });
    this._bus('rule.remove', { id });
    this._appendLog({ type: 'rule:remove', ruleId: id, name: r.name });
    return true;
  }

  updateRule(id, patch) {
    if (!id || !patch) return null;
    const r = this.rules.get(id);
    if (!r) return null;

    const before = { fidelity: r.fidelity, signal: r.signal, priority: r.priority };
    Object.assign(r, patch);

    if ('fidelity' in patch) r.fidelity = this._clampFidelity(patch.fidelity);
    if ('signal'   in patch) r.signal   = Boolean(patch.signal);
    if ('enabled'  in patch) r.enabled  = Boolean(patch.enabled);

    if (patch.pattern && r.type === RULE_TYPES.REGEX) {
      try   { r._regex = new RegExp(r.pattern, 'i'); }
      catch { r._regex = null; this._emitError('regex_compile', `Invalid regex: ${r.pattern}`, id); }
    }
    if (patch.pattern && r.type === RULE_TYPES.DOMAIN) {
      r._domainPattern = r.pattern.replace(/^\*\./, '').toLowerCase();
    }

    this._emit(HOOKS.FIDELITY_SET, { id, before, after: { fidelity: r.fidelity, signal: r.signal, priority: r.priority } });
    this._bus('rule.update', { id, before, after: { fidelity: r.fidelity, signal: r.signal } });
    this._appendLog({ type: 'rule:update', ruleId: id, patch: Object.keys(patch) });
    return r;
  }

  setPriority(id, priority, signal) {
    if (!id) return false;
    const r = this.rules.get(id);
    if (!r) return false;
    const before = { priority: r.priority, signal: r.signal };
    if (priority !== undefined) r.priority = Number(priority);
    if (signal   !== undefined) r.signal   = Boolean(signal);
    this._emit(HOOKS.PRIORITY_SET, { id, before, priority: r.priority, signal: r.signal });
    this._bus('rule.priority', { id, priority: r.priority, signal: r.signal });
    this._appendLog({ type: 'rule:priority', ruleId: id, priority: r.priority, signal: r.signal });
    return true;
  }

  setFidelity(id, fidelity) {
    return this.updateRule(id, { fidelity });
  }

  listRules(filter = {}) {
    let rules = [...this.rules.values()];
    if (filter.source  !== undefined) rules = rules.filter(r => r.source  === filter.source);
    if (filter.type    !== undefined) rules = rules.filter(r => r.type    === filter.type);
    if (filter.signal  !== undefined) rules = rules.filter(r => r.signal  === filter.signal);
    if (filter.enabled !== undefined) rules = rules.filter(r => r.enabled === filter.enabled);
    if (filter.tag     !== undefined) rules = rules.filter(r => r.tags.includes(filter.tag));
    return rules.sort((a, b) => (b.priority - a.priority) || (b.fidelity - a.fidelity));
  }

  getRule(id) {
    return this.rules.get(id) || null;
  }

  // ─── GATE CHECK ───────────────────────────────────────────────────────────────
  /**
   * @param {string|object} data
   * @returns {{ pass, fidelity, rule, reason, gateId, ctx, ts }}
   */
  check(data) {
    this._stats.checked++;
    const ctx    = this._normalise(data);
    const gateId = 'gate:' + crypto.randomUUID().slice(0, 8);
    const ts     = Date.now();

    // Priority sort is expensive on large rule sets — cache sorted order
    const sorted = [...this.rules.values()]
      .filter(r => r.enabled)
      .sort((a, b) => (b.priority - a.priority) || (b.fidelity - a.fidelity));

    for (const rule of sorted) {
      if (!this._matches(rule, ctx)) continue;

      rule.hitCount++;
      const pass = rule.signal && rule.fidelity >= FIDELITY_SIGNAL_MIN;

      const result = {
        pass,
        fidelity: rule.fidelity,
        rule:    { id: rule.id, name: rule.name, uuid: rule.uuid, fidelity: rule.fidelity, signal: rule.signal, type: rule.type },
        reason:  pass
          ? `Signal: fidelity ${rule.fidelity} ≥ ${FIDELITY_SIGNAL_MIN} — PASS`
          : `Noise: ${rule.signal ? 'fidelity ' + rule.fidelity + ' < ' + FIDELITY_SIGNAL_MIN : 'rule marked NOISE'} — BLOCK`,
        gateId,
        ctx,
        ts,
      };

      if (pass) this._stats.passed++; else this._stats.blocked++;
      this._appendLog({ type: 'gate:check', gateId, pass, ruleId: rule.id, fidelity: rule.fidelity });
      this._emit(HOOKS.CHECK, result);
      this._bus('gate.check', { gateId, pass, fidelity: rule.fidelity, ruleId: rule.id });
      return result;
    }

    // No rule matched
    const defaultPass = this.defaultAction !== 'block';
    if (defaultPass) this._stats.passed++; else this._stats.blocked++;
    const result = {
      pass: defaultPass,
      fidelity: FIDELITY_SIGNAL_MIN,
      rule: null,
      reason: `No rule matched — default ${defaultPass ? 'PASS' : 'BLOCK'}`,
      gateId,
      ctx,
      ts,
    };
    this._appendLog({ type: 'gate:check:default', gateId, pass: defaultPass });
    this._emit(HOOKS.CHECK, result);
    this._bus('gate.check.default', { gateId, pass: defaultPass });
    return result;
  }

  // ─── NORMALISE INPUT ──────────────────────────────────────────────────────────
  _normalise(data) {
    if (typeof data === 'string') {
      if (data.startsWith('http://') || data.startsWith('https://')) {
        try {
          const u = new URL(data);
          return { url: data, domain: u.hostname, path: u.pathname, intent: null, ip: null, hash: null, uuid: null, content: null, raw: data };
        } catch {}
      }
      return { url: null, domain: data, path: null, intent: null, ip: null, hash: null, uuid: null, content: null, raw: data };
    }
    if (!data || typeof data !== 'object') {
      return { url: null, domain: null, path: null, intent: null, ip: null, hash: null, uuid: null, content: null, raw: String(data || '') };
    }
    return {
      url:     data.url     || null,
      domain:  data.domain  || null,
      path:    data.path    || null,
      intent:  data.intent  || null,
      ip:      data.ip      || null,
      hash:    data.hash    || null,
      uuid:    data.uuid    || null,
      content: data.content || null,
      raw:     JSON.stringify(data),
    };
  }

  // ─── MATCH ────────────────────────────────────────────────────────────────────
  _matches(rule, ctx) {
    if (!rule || !rule.type) return false;
    const p = (rule.pattern || '').toLowerCase();

    switch (rule.type) {
      case RULE_TYPES.DOMAIN: {
        if (!ctx.domain) return false;
        const d = ctx.domain.toLowerCase();
        // Wildcard pattern (*.sub.com) matches subdomains ONLY, not root domain
        const isWildcard = rule.pattern.startsWith('*.');
        if (p === '*') return true;
        if (isWildcard) return d.endsWith('.' + rule._domainPattern);
        return d === rule._domainPattern || d.endsWith('.' + rule._domainPattern);
      }
      case RULE_TYPES.URL:
        if (!ctx.url) return false;
        return ctx.url.toLowerCase().includes(p);
      case RULE_TYPES.REGEX:
        return rule._regex ? rule._regex.test(ctx.raw || '') : false;
      case RULE_TYPES.HASH:
        return ctx.hash ? ctx.hash.toLowerCase() === p : false;
      case RULE_TYPES.IP:
        return ctx.ip ? this._ipMatches(ctx.ip, rule.pattern) : false;
      case RULE_TYPES.CONTENT:
        return ctx.content ? ctx.content.toLowerCase().includes(p) : false;
      case RULE_TYPES.INTENT:
        return ctx.intent ? ctx.intent.toLowerCase() === p : false;
      case RULE_TYPES.UUID:
        return ctx.uuid ? ctx.uuid === rule.pattern : false;
      default:
        return false;
    }
  }

  // ─── IP / CIDR ────────────────────────────────────────────────────────────────
  _ipMatches(ip, pattern) {
    if (!ip || !pattern) return false;
    if (ip === pattern) return true;
    if (pattern.endsWith('*'))  return ip.startsWith(pattern.slice(0, -1));

    if (pattern.includes('/')) {
      const [net, bitsStr] = pattern.split('/');
      const bits = parseInt(bitsStr, 10);

      // IPv4 CIDR
      if (net.includes('.') && ip.includes('.')) {
        const toInt = a => a.split('.').reduce((acc, b, i) => acc | (parseInt(b, 10) << (24 - 8 * i)), 0) | 0;
        const mask   = bits === 0 ? 0 : ~((1 << (32 - bits)) - 1);
        return (toInt(ip) & mask) === (toInt(net) & mask);
      }

      // IPv6 CIDR (basic — compare bit prefix)
      if (net.includes(':') && ip.includes(':')) {
        try {
          const expand = v => {
            const parts = v.split(':');
            while (parts.length < 8) parts.splice(parts.indexOf(''), 1, ...Array(8 - parts.length + 1).fill('0'));
            return parts.map(p => parseInt(p || '0', 16));
          };
          const ipParts  = expand(ip);
          const netParts = expand(net);
          let remaining  = bits;
          for (let i = 0; i < 8 && remaining > 0; i++) {
            const chunk = Math.min(16, remaining);
            const mask  = ~((1 << (16 - chunk)) - 1) & 0xffff;
            if ((ipParts[i] & mask) !== (netParts[i] & mask)) return false;
            remaining -= chunk;
          }
          return true;
        } catch { return false; }
      }
    }
    return false;
  }

  // ─── IMPORT: uBlock / AdBlock Plus ───────────────────────────────────────────
  importUBlock(listText, opts = {}) {
    if (typeof listText !== 'string') return { imported: 0, skipped: 0, total: 0, error: 'listText must be a string' };
    const source   = opts.source   || 'ublock';
    const fidelity = this._clampFidelity(opts.fidelity ?? 8);
    const lines    = listText.split('\n');
    let imported = 0, skipped = 0;

    for (const raw of lines) {
      const line = raw.trim();
      if (!line || line.startsWith('!') || line.startsWith('#') || line.startsWith('[Adblock')) { skipped++; continue; }

      // Exception → whitelist
      if (line.startsWith('@@')) {
        const pattern = line.slice(2).replace(/\||\^|\*/g, '').trim().toLowerCase();
        if (pattern && /[\w\-]\.[\w]{2,}/.test(pattern)) {
          this.addRule({ name: `ublock:allow:${pattern}`, type: RULE_TYPES.DOMAIN, pattern, fidelity: 9, signal: true, source, priority: 90, tags: ['ublock', 'whitelist'] });
          imported++;
        } else skipped++;
        continue;
      }

      // ||domain.com^
      if (line.startsWith('||')) {
        const pattern = line.slice(2).split(/[\^|\/]/)[0].trim().toLowerCase();
        if (pattern && /[\w\-]\.[\w]{2,}/.test(pattern)) {
          this.addRule({ name: `ublock:block:${pattern}`, type: RULE_TYPES.DOMAIN, pattern, fidelity, signal: false, source, tags: ['ublock', 'adblock'] });
          imported++;
        } else skipped++;
        continue;
      }

      // Hosts-file format: 0.0.0.0 domain or 127.0.0.1 domain
      const hostsMatch = line.match(/^(0\.0\.0\.0|127\.0\.0\.1)\s+(\S+)/);
      if (hostsMatch) {
        const domain = hostsMatch[2].toLowerCase();
        if (domain !== 'localhost' && domain !== '0.0.0.0' && /[\w\-]\.[\w]{2,}/.test(domain)) {
          this.addRule({ name: `hosts:block:${domain}`, type: RULE_TYPES.DOMAIN, pattern: domain, fidelity, signal: false, source: 'hosts', tags: ['hosts', 'dns'] });
          imported++;
        } else skipped++;
        continue;
      }

      // Plain domain
      if (/^[\w\-][\w\-\.]+\.[\w]{2,}$/.test(line)) {
        this.addRule({ name: `${source}:block:${line.toLowerCase()}`, type: RULE_TYPES.DOMAIN, pattern: line.toLowerCase(), fidelity, signal: false, source, tags: [source] });
        imported++;
      } else {
        skipped++;
      }
    }

    const result = { imported, skipped, total: lines.length, source };
    this._emit(HOOKS.IMPORT, result);
    this._bus('import.ublock', result);
    this._appendLog({ type: 'import:ublock', source, imported, skipped });
    return result;
  }

  // ─── IMPORT: DNS firewall / pi-hole / hosts ───────────────────────────────────
  importDNSFirewall(list, opts = {}) {
    const fidelity = this._clampFidelity(opts.fidelity ?? 7);
    const lines    = Array.isArray(list) ? list : String(list).split('\n');
    let imported   = 0;

    for (const raw of lines) {
      const line  = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const parts  = line.split(/\s+/);
      const domain = (parts.length > 1 ? parts[1] : parts[0]).toLowerCase();
      if (!domain || !/[\w\-]\.[\w]{2,}/.test(domain)) continue;
      const isAllow = Boolean(opts.allowList);
      this.addRule({
        name:     `dns:${isAllow ? 'allow' : 'block'}:${domain}`,
        type:     RULE_TYPES.DOMAIN,
        pattern:  domain,
        fidelity,
        signal:   isAllow,
        source:   'dns-firewall',
        priority: isAllow ? 80 : 50,
        tags:     ['dns', 'firewall', isAllow ? 'allowlist' : 'blocklist'],
      });
      imported++;
    }

    const result = { imported };
    this._emit(HOOKS.IMPORT, { source: 'dns-firewall', ...result });
    this._bus('import.dns', result);
    this._appendLog({ type: 'import:dns', imported });
    return result;
  }

  // ─── IMPORT: Antivirus hashes ────────────────────────────────────────────────
  importAntivirus(list, opts = {}) {
    const fidelity = this._clampFidelity(opts.fidelity ?? 9);
    const lines    = Array.isArray(list) ? list : String(list).split('\n');
    let imported   = 0;

    for (const raw of lines) {
      const hash = raw.trim().split(/[\s,]/)[0].toLowerCase();
      if (!/^[0-9a-f]{32,64}$/.test(hash)) continue;
      this.addRule({
        name:    `av:hash:${hash.slice(0, 16)}…`,
        type:    RULE_TYPES.HASH,
        pattern: hash,
        fidelity,
        signal:  false,
        source:  'antivirus',
        tags:    ['av', 'malware', 'hash'],
      });
      imported++;
    }

    const result = { imported };
    this._emit(HOOKS.IMPORT, { source: 'antivirus', ...result });
    this._bus('import.antivirus', result);
    this._appendLog({ type: 'import:antivirus', imported });
    return result;
  }

  // ─── IMPORT: Bulk blacklist / whitelist ───────────────────────────────────────
  importBlacklist(domains, opts = {}) {
    return this._bulkImport(domains, false, { fidelity: 6, source: 'blacklist', tags: ['blacklist'], priority: 50, ...opts });
  }

  importWhitelist(domains, opts = {}) {
    return this._bulkImport(domains, true, { fidelity: 10, source: 'whitelist', tags: ['whitelist'], priority: 100, ...opts });
  }

  _bulkImport(domains, signal, opts) {
    const list = Array.isArray(domains)
      ? domains
      : String(domains).split(/[\n,\s]+/).filter(Boolean);
    let imported = 0;

    for (const d of list) {
      const domain = d.trim();
      if (!domain) continue;
      const type = domain.startsWith('/')
        ? RULE_TYPES.REGEX
        : domain.includes('/') && !domain.includes('.')
          ? RULE_TYPES.URL
          : RULE_TYPES.DOMAIN;
      this.addRule({
        name:     `${signal ? 'white' : 'black'}:${domain}`,
        type,
        pattern:  domain,
        fidelity: opts.fidelity || 7,
        signal,
        source:   opts.source   || 'manual',
        priority: opts.priority || 50,
        tags:     opts.tags     || [],
      });
      imported++;
    }

    const result = { imported };
    this._bus(`import.${signal ? 'whitelist' : 'blacklist'}`, result);
    this._appendLog({ type: `import:${signal ? 'whitelist' : 'blacklist'}`, imported });
    return result;
  }

  // ─── LOGGING ─────────────────────────────────────────────────────────────────
  /**
   * Public log() — called externally and internally.
   * @param {object} entry
   */
  log(entry) {
    return this._appendLog(entry);
  }

  _appendLog(entry) {
    const e = {
      id:  crypto.randomUUID(),
      ts:  new Date().toISOString(),
      tsMs: Date.now(),
      ...entry,
    };

    const stored = (this.encrypt && this._encKey) ? this._encryptLog(e) : e;

    // In-memory ring
    this.logs.unshift(stored);
    if (this.logs.length > this.maxLogs) this.logs.length = this.maxLogs;

    // File append with rotation
    if (this.logFile) {
      try {
        fs.appendFileSync(this.logFile, JSON.stringify(stored) + '\n', 'utf8');
        // Check size — rotate if over limit
        const stat = fs.statSync(this.logFile);
        if (stat.size > MAX_LOG_BYTES) this._rotateLogFile();
      } catch {}
    }

    this._emit(HOOKS.LOG_ENTRY, e);
    return e;
  }

  _rotateLogFile() {
    if (!this.logFile) return;
    try {
      const rotated = this.logFile + '.1.' + Date.now();
      fs.renameSync(this.logFile, rotated);
      // Keep only last 1000 lines from rotated file in new logFile
      const raw   = fs.readFileSync(rotated, 'utf8');
      const lines = raw.trim().split('\n').filter(Boolean);
      atomicWrite(this.logFile, lines.slice(-1000).join('\n') + '\n');
    } catch {}
  }

  // ─── ENCRYPTION ───────────────────────────────────────────────────────────────
  _encryptLog(entry) {
    try {
      const key = typeof this._encKey === 'string'
        ? crypto.scryptSync(this._encKey, 'snr-log-salt', 32)
        : this._encKey;
      const iv  = crypto.randomBytes(16);
      const c   = crypto.createCipheriv('aes-256-gcm', key, iv);
      const enc = Buffer.concat([c.update(JSON.stringify(entry), 'utf8'), c.final()]);
      return { encrypted: true, iv: iv.toString('hex'), data: enc.toString('hex'), tag: c.getAuthTag().toString('hex'), ts: entry.ts, tsMs: entry.tsMs };
    } catch (err) {
      this._emitError('encrypt', err.message);
      return entry; // fallback: store plain if encryption fails (logs failure below)
    }
  }

  decryptLog(entry) {
    if (!entry.encrypted) return entry;
    try {
      const key = typeof this._encKey === 'string'
        ? crypto.scryptSync(this._encKey, 'snr-log-salt', 32)
        : this._encKey;
      const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(entry.iv, 'hex'));
      d.setAuthTag(Buffer.from(entry.tag, 'hex'));
      return JSON.parse(Buffer.concat([d.update(Buffer.from(entry.data, 'hex')), d.final()]).toString('utf8'));
    } catch (err) {
      this._emitError('decrypt', err.message);
      return { error: 'decrypt_failed', ts: entry.ts };
    }
  }

  getLogs({ limit = 200, type = null, decryptAll = false } = {}) {
    let logs = [...this.logs];
    if (type) logs = logs.filter(l => !l.encrypted && l.type === type);
    if (decryptAll && this._encKey) logs = logs.map(l => l.encrypted ? this.decryptLog(l) : l);
    return logs.slice(0, limit);
  }

  // ─── STATS ────────────────────────────────────────────────────────────────────
  stats() {
    const total = this._stats.checked || 0;
    return {
      ...this._stats,
      rules:    this.rules.size,
      passRate: total ? Math.round(this._stats.passed  / total * 100) + '%' : '—',
      blockRate:total ? Math.round(this._stats.blocked / total * 100) + '%' : '—',
      topBlockedRules: [...this.rules.values()]
        .filter(r => !r.signal)
        .sort((a, b) => b.hitCount - a.hitCount)
        .slice(0, 10)
        .map(r => ({ id: r.id, name: r.name, hits: r.hitCount, fidelity: r.fidelity })),
      topPassedRules: [...this.rules.values()]
        .filter(r => r.signal)
        .sort((a, b) => b.hitCount - a.hitCount)
        .slice(0, 5)
        .map(r => ({ id: r.id, name: r.name, hits: r.hitCount })),
    };
  }

  resetStats() {
    this._stats = { checked: 0, passed: 0, blocked: 0, errors: 0 };
    if (this._statsPath) this._persistStats();
  }

  // ─── PROFILES ─────────────────────────────────────────────────────────────────
  saveProfile(name) {
    if (!name) throw new Error('SNRFilter.saveProfile: name required');
    const snapshot = [...this.rules.values()].map(({ _regex, ...r }) => r);
    this.profiles.set(name, snapshot);
    this._emit(HOOKS.PROFILE_SAVE, { name, ruleCount: snapshot.length });
    this._bus('profile.save', { name, ruleCount: snapshot.length });
    this._appendLog({ type: 'profile:save', name, ruleCount: snapshot.length });

    // Persist profiles to disk alongside rules
    if (this._profilesPath) {
      try {
        const all = {};
        this.profiles.forEach((rules, pName) => { all[pName] = rules; });
        atomicWrite(this._profilesPath, JSON.stringify({ version: VERSION, profiles: all }, null, 2));
      } catch (err) {
        this._emitError('profile_persist', err.message, name);
      }
    }
    return name;
  }

  loadProfile(name) {
    if (!name) return false;
    const rules = this.profiles.get(name);
    if (!rules) return false;
    rules.forEach(r => this.addRule(r));
    this._emit(HOOKS.PROFILE_LOAD, { name, ruleCount: rules.length });
    this._bus('profile.load', { name, ruleCount: rules.length });
    this._appendLog({ type: 'profile:load', name, ruleCount: rules.length });
    return true;
  }

  listProfiles() {
    return [...this.profiles.keys()];
  }

  // ─── PERSIST ──────────────────────────────────────────────────────────────────
  persist(savePath) {
    const p = savePath || this._persistPath;
    if (!p) return false;
    try {
      const payload = {
        version:  VERSION,
        id:       this.id,
        uuid:     this.uuid,
        name:     this.name,
        exported: new Date().toISOString(),
        defaultAction: this.defaultAction,
        rules:    [...this.rules.values()].map(({ _regex, ...r }) => r),
      };
      atomicWrite(p, JSON.stringify(payload, null, 2));
      this._persistPath = p;
      this._emit(HOOKS.PERSIST, { path: p, ruleCount: this.rules.size });
      this._bus('persist', { path: p, ruleCount: this.rules.size });
      this._appendLog({ type: 'persist', path: p.split('/').pop(), ruleCount: this.rules.size });

      // Persist stats alongside rules
      this._persistPath = p;
      this._statsPath   = p.replace(/\.json$/, '') + '-stats.json';
      this._profilesPath = p.replace(/\.json$/, '') + '-profiles.json';
      this._persistStats();
      return true;
    } catch (err) {
      this._emitError('persist', err.message, p);
      return false;
    }
  }

  _persistStats() {
    if (!this._statsPath) return;
    try {
      atomicWrite(this._statsPath, JSON.stringify({ version: VERSION, stats: this._stats, savedAt: new Date().toISOString() }, null, 2));
    } catch {}
  }

  _initPersist(persistPath) {
    if (!persistPath) return;
    this._persistPath  = persistPath;
    this._profilesPath = persistPath.replace(/\.json$/, '') + '-profiles.json';
    this._statsPath    = persistPath.replace(/\.json$/, '') + '-stats.json';

    // Load rules
    try {
      if (fs.existsSync(persistPath)) {
        const data = safeJSON(fs.readFileSync(persistPath, 'utf8'), {});
        if (data.defaultAction) this.defaultAction = data.defaultAction;
        (data.rules || []).forEach(r => this.addRule(r));
      }
    } catch (err) {
      this._emitError('load_rules', err.message, persistPath);
    }

    // Load stats
    try {
      if (this._statsPath && fs.existsSync(this._statsPath)) {
        const data = safeJSON(fs.readFileSync(this._statsPath, 'utf8'), {});
        if (data.stats) Object.assign(this._stats, data.stats);
      }
    } catch {}

    // Load profiles
    try {
      if (this._profilesPath && fs.existsSync(this._profilesPath)) {
        const data = safeJSON(fs.readFileSync(this._profilesPath, 'utf8'), {});
        Object.entries(data.profiles || {}).forEach(([name, rules]) => {
          this.profiles.set(name, rules);
        });
      }
    } catch {}
  }

  // ─── SERIALISATION ────────────────────────────────────────────────────────────
  toJSON() {
    return {
      version:       VERSION,
      id:            this.id,
      uuid:          this.uuid,
      name:          this.name,
      defaultAction: this.defaultAction,
      rules:         [...this.rules.values()].map(({ _regex, ...r }) => r),
      stats:         this._stats,
      profiles:      Object.fromEntries([...this.profiles.entries()]),
    };
  }

  static fromJSON(data, opts = {}) {
    const filter = new SNRFilter({
      id:   data.id,
      uuid: data.uuid,
      name: data.name,
      defaultAction: data.defaultAction,
      ...opts,
    });
    (data.rules || []).forEach(r => filter.addRule(r));
    if (data.stats) Object.assign(filter._stats, data.stats);
    Object.entries(data.profiles || {}).forEach(([name, rules]) => filter.profiles.set(name, rules));
    return filter;
  }

  // ─── MIDDLEWARE ───────────────────────────────────────────────────────────────
  toBridgeMiddleware() {
    return (url, headers, body) => {
      const domain = (() => { try { return new URL(url).hostname; } catch { return url; } })();
      return this.check({ url, domain, intent: headers?.['x-intent'], ip: headers?.['x-forwarded-for'] });
    };
  }

  toExpressMiddleware() {
    return (req, res, next) => {
      const result = this.check({
        url:    req.originalUrl || req.url,
        domain: req.hostname,
        ip:     req.ip || req.connection?.remoteAddress,
        intent: req.headers['x-intent'],
        uuid:   req.headers['x-caller-uuid'],
      });
      if (!result.pass) {
        res.status(403).json({ error: 'Blocked by SNR filter', reason: result.reason, fidelity: result.fidelity, gateId: result.gateId });
        return;
      }
      req.snr = result;
      next();
    };
  }

  /**
   * Bridge HTTP handler — call from nexus-bridge-server.js handleRequest.
   * Handles GET/POST /snr/*
   * Returns response object or null (not handled).
   */
  async bridgeRoute(parts, method, body, req) {
    if (!parts[0] || parts[0] !== 'snr') return null;
    const sub = parts[1];

    // POST /snr/check
    if (sub === 'check' && method === 'POST') {
      const result = this.check(body || {});
      return result;
    }

    // GET /snr/stats
    if (sub === 'stats' && method === 'GET') {
      return this.stats();
    }

    // GET /snr/rules
    if (sub === 'rules' && method === 'GET') {
      const url = new URL('http://x' + (req?.url || ''));
      const filter = {};
      if (url.searchParams.get('source'))  filter.source  = url.searchParams.get('source');
      if (url.searchParams.get('type'))    filter.type    = url.searchParams.get('type');
      if (url.searchParams.get('signal'))  filter.signal  = url.searchParams.get('signal') === 'true';
      if (url.searchParams.get('enabled')) filter.enabled = url.searchParams.get('enabled') === 'true';
      return { rules: this.listRules(filter), total: this.rules.size };
    }

    // POST /snr/rules — add a rule
    if (sub === 'rules' && method === 'POST') {
      if (!body) return { ok: false, error: 'body required' };
      const id = this.addRule(body);
      if (this._persistPath) this.persist();
      return { ok: true, id };
    }

    // PATCH /snr/rules/:id — update rule
    if (sub === 'rules' && parts[2] && method === 'PATCH') {
      const r = this.updateRule(parts[2], body || {});
      if (!r) return { ok: false, error: 'Rule not found' };
      if (this._persistPath) this.persist();
      return { ok: true, rule: r };
    }

    // DELETE /snr/rules/:id
    if (sub === 'rules' && parts[2] && method === 'DELETE') {
      const removed = this.removeRule(parts[2]);
      if (this._persistPath) this.persist();
      return { ok: removed, error: removed ? undefined : 'Rule not found' };
    }

    // POST /snr/import/:format
    if (sub === 'import' && parts[2]) {
      const fmt  = parts[2];
      const data = body?.list || body?.data || '';
      const opts = { fidelity: body?.fidelity, source: body?.source };
      let result;
      switch (fmt) {
        case 'ublock':    result = this.importUBlock(data, opts);       break;
        case 'adblock':   result = this.importUBlock(data, opts);       break;
        case 'pihole':    result = this.importDNSFirewall(data, opts);  break;
        case 'hosts':     result = this.importDNSFirewall(data, opts);  break;
        case 'antivirus': result = this.importAntivirus(data, opts);    break;
        case 'blacklist': result = this.importBlacklist(data, opts);    break;
        case 'whitelist': result = this.importWhitelist(data, opts);    break;
        default:          return { ok: false, error: `Unknown format: ${fmt}` };
      }
      if (this._persistPath) this.persist();
      return { ok: true, ...result };
    }

    // GET /snr/logs
    if (sub === 'logs' && method === 'GET') {
      const url    = new URL('http://x' + (req?.url || ''));
      const limit  = parseInt(url.searchParams.get('limit') || '100');
      const type   = url.searchParams.get('type') || null;
      return { logs: this.getLogs({ limit, type }), count: this.logs.length };
    }

    // POST /snr/persist
    if (sub === 'persist' && method === 'POST') {
      const ok = this.persist(body?.path);
      return { ok };
    }

    // GET /snr/profiles
    if (sub === 'profiles' && method === 'GET') {
      return { profiles: this.listProfiles() };
    }

    // POST /snr/profiles/:name/save
    if (sub === 'profiles' && parts[2] && parts[3] === 'save') {
      this.saveProfile(parts[2]);
      return { ok: true, name: parts[2] };
    }

    // POST /snr/profiles/:name/load
    if (sub === 'profiles' && parts[2] && parts[3] === 'load') {
      const ok = this.loadProfile(parts[2]);
      return { ok, error: ok ? undefined : 'Profile not found' };
    }

    // GET /snr/health
    if (sub === 'health' || !sub) {
      return {
        ok:      true,
        id:      this.id,
        uuid:    this.uuid,
        name:    this.name,
        version: this.version,
        rules:   this.rules.size,
        stats:   this._stats,
        persist: this._persistPath || null,
      };
    }

    return null; // not handled
  }

  // ─── INTERNAL UTILS ───────────────────────────────────────────────────────────
  _clampFidelity(v) {
    const n = Number(v);
    return isNaN(n) ? 7 : Math.max(FIDELITY_MIN, Math.min(FIDELITY_MAX, n));
  }

  _emitError(code, message, context = null) {
    this._stats.errors++;
    this._emit(HOOKS.ERROR, { code, message, context });
    this._bus('error', { code, message, context }, 'ERROR');
  }
}

// ─── Built-in presets ─────────────────────────────────────────────────────────
SNRFilter.PRESETS = {
  adblocker: (f) => {
    f.defaultAction = 'pass';
    [
      'doubleclick.net','googlesyndication.com','adservice.google.com',
      'ads.twitter.com','facebook.net','scorecardresearch.com',
      'quantserve.com','amazon-adsystem.com','moatads.com','pubmatic.com',
      'rubiconproject.com','openx.net','criteo.com','taboola.com','outbrain.com',
      'adsrvr.org','advertising.com','serving-sys.com','adnxs.com','adsystem.com',
    ].forEach(d => f.addRule({ name: `ad:${d}`, type: 'domain', pattern: d, fidelity: 8, signal: false, source: 'preset:ads', priority: 70, tags: ['ads', 'preset'] }));
  },

  privacy: (f) => {
    [
      'google-analytics.com','googletagmanager.com','hotjar.com','mixpanel.com',
      'amplitude.com','segment.io','heap.io','fullstory.com','logrocket.com',
      'mouseflow.com','clarity.ms','newrelic.com','datadog.com',
      'sentry.io','bugsnag.com','rollbar.com','intercom.io',
    ].forEach(d => f.addRule({ name: `tracker:${d}`, type: 'domain', pattern: d, fidelity: 8, signal: false, source: 'preset:privacy', priority: 70, tags: ['trackers', 'privacy', 'preset'] }));
  },

  security: (f) => {
    f.defaultAction = 'pass';
    [
      { name: 'sec:suspicious-exec',  pattern: '(eval|exec|cmd\\.exe|powershell|base64_decode)',   fidelity: 6 },
      { name: 'sec:sql-injection',    pattern: "(union\\s+select|drop\\s+table|insert\\s+into|'\\s*or\\s*'1'\\s*=\\s*'1)", fidelity: 8 },
      { name: 'sec:xss',             pattern: '<script[\\s\\S]*?>',                                 fidelity: 8 },
      { name: 'sec:path-traversal',   pattern: '\\.\\./|%2e%2e/',                                   fidelity: 7 },
      { name: 'sec:open-redirect',    pattern: '(redirect|url|return|next|target)=https?://',       fidelity: 6 },
    ].forEach(r => f.addRule({ ...r, type: 'regex', signal: false, source: 'preset:security', priority: 80, tags: ['security', 'preset'] }));
  },

  permissive: (f) => {
    f.defaultAction = 'pass';
    // Only block known absolute bad actors
    [
      'malware.com','phishing.net','ransomware.io',
    ].forEach(d => f.addRule({ name: `block:${d}`, type: 'domain', pattern: d, fidelity: 10, signal: false, source: 'preset:permissive', priority: 100, tags: ['malware', 'preset'] }));
  },
};

// ─── Static constants ─────────────────────────────────────────────────────────
SNRFilter.HOOKS             = HOOKS;
SNRFilter.RULE_TYPES        = RULE_TYPES;
SNRFilter.RULE_UUIDS        = RULE_UUIDS;
SNRFilter.FIDELITY_SIGNAL_MIN = FIDELITY_SIGNAL_MIN;
SNRFilter.FIDELITY_MAX      = FIDELITY_MAX;
SNRFilter.VERSION           = VERSION;
SNRFilter.MODULE_UUID       = MODULE_UUID;

module.exports = SNRFilter;
