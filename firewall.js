/**
 * firewall.js — BrainOS Firewall Engine
 * UUID: brainos-firewall-v5000-0000-000000000003
 * Hook: brainos.firewall:firewall-v5:f0003
 *
 * Rule-based firewall: IP/CIDR, port, protocol, intent.
 * Windows Defender + Linux UFW integration hooks.
 * JSON filter import with variables, sigmas, deltas, invariants.
 * All blocked/malicious requests logged loudly. Nothing pretends.
 */

'use strict';

const fs     = require('fs');
const path   = require('path');
const { execSync } = require('child_process');
const os     = require('os');

const MODULE_UUID    = 'brainos-firewall-v5000-0000-000000000003';
const MODULE_VERSION = '5.0.0';

function uid() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = Math.random() * 16 | 0;
    return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
  });
}

// ── CIDR matching ─────────────────────────────────────────────────────────────
function ipToInt(ip) {
  return ip.split('.').reduce((acc, octet) => (acc << 8) | parseInt(octet, 10), 0) >>> 0;
}

function cidrMatch(ip, cidr) {
  if (!cidr.includes('/')) return ip === cidr;
  const [network, bits] = cidr.split('/');
  const mask = bits === '0' ? 0 : (~0 << (32 - parseInt(bits))) >>> 0;
  return (ipToInt(ip) & mask) === (ipToInt(network) & mask);
}

// ── Variable interpolation for JSON filter engine ────────────────────────────
function interpolateVars(value, vars) {
  if (typeof value !== 'string') return value;
  return value.replace(/\$\{([^}]+)\}/g, (_, key) => vars[key] !== undefined ? vars[key] : `\${${key}}`);
}

// ── Rule evaluation ───────────────────────────────────────────────────────────
function evalCondition(cond, ctx) {
  const { ip, port, protocol, intent, method, path: reqPath, userAgent } = ctx;
  switch (cond.field) {
    case 'ip':      return cond.op === 'cidr'    ? cidrMatch(ip || '', cond.value)
                         : cond.op === 'eq'      ? ip === cond.value
                         : cond.op === 'in'      ? (cond.value || []).includes(ip)
                         : false;
    case 'port':    return cond.op === 'eq'      ? port === cond.value
                         : cond.op === 'in'      ? (cond.value || []).includes(port)
                         : cond.op === 'range'   ? (port >= cond.value[0] && port <= cond.value[1])
                         : false;
    case 'protocol':return protocol === cond.value;
    case 'intent':  return intent === cond.value;
    case 'path':    return cond.op === 'prefix'  ? (reqPath || '').startsWith(cond.value)
                         : cond.op === 'regex'   ? new RegExp(cond.value).test(reqPath || '')
                         : reqPath === cond.value;
    case 'ua':      return new RegExp(cond.value, 'i').test(userAgent || '');
    case 'sigma':   // sigma: value is a threshold, field is a metric name
                    return (ctx.metrics?.[cond.metric] || 0) > cond.value;
    case 'delta':   return Math.abs((ctx.metrics?.[cond.metric] || 0) - cond.baseline) > cond.value;
    case 'invariant': return ctx.invariants?.[cond.key] !== cond.expected;
    default:        return false;
  }
}

function matchRule(rule, ctx, vars = {}) {
  const conditions = rule.conditions || (rule.condition ? [rule.condition] : []);
  if (!conditions.length) return true;
  const logic = rule.logic || 'AND';
  const results = conditions.map(c => {
    const resolved = Object.fromEntries(
      Object.entries(c).map(([k, v]) => [k, interpolateVars(v, vars)])
    );
    return evalCondition(resolved, ctx);
  });
  return logic === 'OR' ? results.some(Boolean) : results.every(Boolean);
}

// ── Firewall Engine ───────────────────────────────────────────────────────────
class FirewallEngine {
  constructor(opts = {}) {
    this.uuid        = MODULE_UUID;
    this.version     = MODULE_VERSION;
    this.dataDir     = opts.dataDir || './data';
    this.rulesFile   = path.join(this.dataDir, 'fw-rules.json');
    this.logFile     = path.join(this.dataDir, 'fw-blocked.jsonl');
    this.auditFile   = path.join(this.dataDir, 'fw-audit.jsonl');
    this.platform    = os.platform(); // 'win32' | 'linux' | 'darwin'
    this._bus        = null;
    this._vars       = {};
    this._stats      = { checked: 0, blocked: 0, allowed: 0, errors: 0 };
    this._rules      = [];
    this._loadRules();
  }

  setBus(bus) {
    this._bus = bus;
    bus.on('net.fw.add_rule',     ev => this.addRule(ev.data));
    bus.on('net.fw.remove_rule',  ev => this.removeRule(ev.data.id));
    bus.on('net.fw.import_json',  ev => this.importJSON(ev.data.json));
    bus.on('net.fw.set_vars',     ev => { this._vars = { ...this._vars, ...ev.data }; });
  }

  _emit(type, data) {
    if (this._bus) this._bus.emit(type, data, { source: 'firewall' });
  }

  _fail(ctx, msg) {
    console.error(`[FIREWALL ERROR] ${ctx}: ${msg}`);
    this._stats.errors++;
    this._emit('system.error', { source: 'firewall', context: ctx, message: msg });
    this._appendLog(this.auditFile, { ts: Date.now(), type: 'ERROR', ctx, msg });
  }

  _appendLog(file, entry) {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.appendFileSync(file, JSON.stringify(entry) + '\n');
    } catch (e) { console.error(`[FW LOG ERROR] ${file}: ${e.message}`); }
  }

  _loadRules() {
    try {
      if (fs.existsSync(this.rulesFile)) {
        const d = JSON.parse(fs.readFileSync(this.rulesFile, 'utf8'));
        this._rules = d.rules || [];
        this._vars  = d.vars  || {};
      }
    } catch (e) { this._fail('loadRules', e.message); }
  }

  _saveRules() {
    try {
      fs.mkdirSync(this.dataDir, { recursive: true });
      const tmp = this.rulesFile + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify({ rules: this._rules, vars: this._vars }, null, 2));
      fs.renameSync(tmp, this.rulesFile);
    } catch (e) { this._fail('saveRules', e.message); }
  }

  /**
   * Add a rule. Returns rule id.
   * Rule shape: { id?, name, action:'allow'|'block'|'log', priority:0-100,
   *   logic:'AND'|'OR', conditions: [...], enabled:true, tags:[] }
   */
  addRule(rule) {
    if (!rule.action || !['allow','block','log'].includes(rule.action)) {
      this._fail('addRule', `Invalid action: ${rule.action}`);
      return null;
    }
    const r = { id: rule.id || uid(), name: rule.name || 'Unnamed Rule', action: rule.action,
                 priority: rule.priority ?? 50, logic: rule.logic || 'AND',
                 conditions: rule.conditions || [], enabled: rule.enabled !== false,
                 tags: rule.tags || [], created: Date.now() };
    this._rules.push(r);
    this._rules.sort((a, b) => b.priority - a.priority);
    this._saveRules();
    this._emit('net.fw.rule_added', { id: r.id, name: r.name });
    return r.id;
  }

  removeRule(id) {
    const before = this._rules.length;
    this._rules = this._rules.filter(r => r.id !== id);
    if (this._rules.length < before) {
      this._saveRules();
      this._emit('net.fw.rule_removed', { id });
      return true;
    }
    this._fail('removeRule', `Rule not found: ${id}`);
    return false;
  }

  /**
   * Import rules from JSON engine (supports variables, sigmas, deltas, invariants).
   * JSON format: { vars:{}, rules:[] }
   */
  importJSON(json) {
    try {
      const data = typeof json === 'string' ? JSON.parse(json) : json;
      if (data.vars) this._vars = { ...this._vars, ...data.vars };
      let imported = 0;
      for (const rule of (data.rules || [])) {
        this.addRule(rule);
        imported++;
      }
      this._emit('net.fw.json_imported', { count: imported });
      return { ok: true, imported };
    } catch (e) {
      this._fail('importJSON', e.message);
      return { ok: false, error: e.message };
    }
  }

  /**
   * Check a request against all rules.
   * ctx: { ip, port, protocol, intent, path, method, userAgent, metrics, invariants }
   * Returns: { action, ruleId, ruleName, reason }
   */
  check(ctx) {
    this._stats.checked++;
    for (const rule of this._rules) {
      if (!rule.enabled) continue;
      try {
        if (matchRule(rule, ctx, this._vars)) {
          const result = { action: rule.action, ruleId: rule.id, ruleName: rule.name };
          const entry  = { ts: Date.now(), ...ctx, ...result };
          if (rule.action === 'block') {
            this._stats.blocked++;
            this._appendLog(this.logFile, { ...entry, type: 'BLOCKED' });
            this._emit('net.fw.block', { ctx, rule: { id: rule.id, name: rule.name } });
            console.warn(`[FIREWALL BLOCKED] ${ctx.ip}:${ctx.port} → ${rule.name}`);
          } else if (rule.action === 'log') {
            this._appendLog(this.auditFile, { ...entry, type: 'LOGGED' });
            this._emit('net.fw.logged', { ctx, rule: { id: rule.id, name: rule.name } });
          } else {
            this._stats.allowed++;
          }
          return result;
        }
      } catch (e) {
        this._fail('check.rule', `Rule ${rule.id} error: ${e.message}`);
      }
    }
    // Default: allow
    this._stats.allowed++;
    return { action: 'allow', ruleId: null, ruleName: 'default' };
  }

  /** Middleware factory for HTTP servers */
  middleware() {
    const self = this;
    return function firewallMiddleware(req, res, next) {
      const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim()
                 || req.socket?.remoteAddress || '0.0.0.0';
      const port     = req.socket?.remotePort || 0;
      const protocol = req.socket?.encrypted ? 'https' : 'http';
      const ctx = { ip, port, protocol, method: req.method,
                    path: req.url, userAgent: req.headers['user-agent'] };
      const result = self.check(ctx);
      if (result.action === 'block') {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Forbidden', rule: result.ruleName }));
        return;
      }
      if (next) next();
    };
  }

  /**
   * Sync a block rule to the OS firewall (UFW / Windows Defender).
   * Fails loudly if not supported.
   */
  syncToOS(ip, action = 'block') {
    try {
      if (this.platform === 'linux') {
        const ufw = action === 'block'
          ? `ufw deny from ${ip} to any`
          : `ufw allow from ${ip} to any`;
        execSync(ufw, { timeout: 5000 });
        this._emit('net.fw.os_sync', { platform: 'linux', ip, action });
      } else if (this.platform === 'win32') {
        const dir = action === 'block' ? 'block' : 'allow';
        const cmd = `netsh advfirewall firewall add rule name="BrainOS-${ip}" dir=in action=${dir} remoteip=${ip}`;
        execSync(cmd, { timeout: 5000 });
        this._emit('net.fw.os_sync', { platform: 'win32', ip, action });
      } else {
        this._fail('syncToOS', `Unsupported platform: ${this.platform}`);
      }
    } catch (e) {
      this._fail('syncToOS', e.message);
    }
  }

  health() {
    return {
      ok: true,
      uuid: this.uuid,
      version: this.version,
      platform: this.platform,
      rules: this._rules.length,
      enabledRules: this._rules.filter(r => r.enabled).length,
      stats: { ...this._stats },
      vars: Object.keys(this._vars),
    };
  }

  listRules() { return [...this._rules]; }
}

if (typeof module !== 'undefined') module.exports = { FirewallEngine };
