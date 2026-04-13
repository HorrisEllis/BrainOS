/**
 * routing-engine.js — BrainOS Agent Routing Engine v5.0
 * UUID: brainos-routing-v5000-0000-000000000004
 *
 * SISO-native. If/then/when/fail chains. Timer/pulse/CLI/heartbeat triggers.
 * Framework injection. Conversation capture. Clocky/Make/n8n/Zapier wiring.
 * Feedback loops. Bridge + API support. Fails loudly — nothing pretends.
 */
'use strict';

const fs    = require('fs');
const path  = require('path');
const http  = require('http');
const https = require('https');

const MODULE_UUID    = 'brainos-routing-v5000-0000-000000000004';
const MODULE_VERSION = '5.0.0';

function uid() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = Math.random() * 16 | 0;
    return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
  });
}

function interpolate(tpl, ctx) {
  if (typeof tpl !== 'string') return tpl;
  return tpl.replace(/\{\{([^}]+)\}\}/g, (_, k) => {
    const v = k.split('.').reduce((o, key) => o?.[key], ctx);
    return v !== undefined ? v : `{{${k}}}`;
  });
}

function matchCron(cron) {
  const parts = cron.split(' ');
  if (parts.length !== 5) return false;
  const now = new Date();
  const [min, hour, dom, month, dow] = parts;
  const ok = (f, v) => f === '*' || parseInt(f) === v;
  return ok(min, now.getMinutes()) && ok(hour, now.getHours()) &&
         ok(dom, now.getDate()) && ok(month, now.getMonth() + 1) && ok(dow, now.getDay());
}

// ── Condition evaluators (SISO Gate pattern) ──────────────────────────────────
const CONDITIONS = {
  manual:       () => false,
  always:       () => true,
  timer:        (cfg, ctx) => {
    const now = Date.now();
    if (cfg.cron) return matchCron(cfg.cron);
    if (cfg.after) return now >= cfg.after;
    if (cfg.interval && ctx._lastRun) return now - ctx._lastRun >= cfg.interval;
    return false;
  },
  datetime:     (cfg) => {
    const n = new Date();
    if (cfg.hour !== undefined    && n.getHours()   !== cfg.hour)    return false;
    if (cfg.minute !== undefined  && n.getMinutes() !== cfg.minute)  return false;
    if (cfg.weekday !== undefined && n.getDay()     !== cfg.weekday) return false;
    return true;
  },
  heartbeat:    (cfg, ctx) => cfg.offline ? !ctx.nodeOnline : !!ctx.nodeOnline,
  health_score: (cfg, ctx) => (ctx.healthScore || 0) >= (cfg.min ?? 0),
  data:         (cfg, ctx) => !!ctx.lastData,
  notification: (cfg, ctx) => ctx.notification?.type === cfg.type,
  intent:       (cfg, ctx) => ctx.intent === cfg.value,
  pulse:        (cfg, ctx) => (ctx.pulseCount || 0) % (cfg.every || 1) === 0,
  cli:          (cfg, ctx) => ctx.cliCommand === cfg.command,
};

// ── HTTP post helper ──────────────────────────────────────────────────────────
function httpPost(url, body, headers = {}, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(url); } catch (e) { return reject(new Error(`Invalid URL: ${url}`)); }
    const data = JSON.stringify(body);
    const opts = {
      hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), ...headers },
      timeout: timeoutMs,
    };
    const req = (u.protocol === 'https:' ? https : http).request(opts, res => {
      let b = '';
      res.on('data', d => b += d);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(b) }); }
        catch { resolve({ status: res.statusCode, body: b }); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Request timeout')); });
    req.write(data);
    req.end();
  });
}

// ── Step executor ─────────────────────────────────────────────────────────────
class StepExecutor {
  constructor(engine) { this._e = engine; }

  async run(step, input, ctx) {
    const cfg = step.config || {};
    switch (step.type) {

      case 'agent':
      case 'ai': {
        const baseUrl = ctx.bridgeUrl || 'http://localhost:3747';
        const body = {
          provider: cfg.agentProvider || cfg.provider || 'auto',
          intent:   cfg.agentType    || cfg.intent   || 'default',
          model:    cfg.agentModel   || cfg.model,
          messages: [{ role: 'user', content: interpolate(cfg.agentInput || cfg.prompt || '{{input}}', { input, ...ctx }) }],
          system:   cfg.agentSystem  || cfg.system,
          max_tokens: cfg.maxTokens || 2048,
        };
        const r = await httpPost(`${baseUrl}/v1/messages`, body, {}, cfg.agentTimeout || 60000);
        if (r.status >= 400) throw new Error(`AI step HTTP ${r.status}`);
        return r.body?.content?.[0]?.text || r.body?.choices?.[0]?.message?.content || JSON.stringify(r.body);
      }

      case 'transform': {
        switch (cfg.fn || 'passthrough') {
          case 'uppercase':       return String(input).toUpperCase();
          case 'lowercase':       return String(input).toLowerCase();
          case 'trim':            return String(input).trim();
          case 'json_parse':      return JSON.parse(input);
          case 'json_stringify':  return JSON.stringify(input, null, 2);
          case 'extract_field':   return (typeof input === 'object' ? input : {})[cfg.field];
          case 'template':        return interpolate(cfg.template || '{{input}}', { input, ...ctx });
          default:                return input;
        }
      }

      case 'http':
      case 'api': {
        const url = interpolate(cfg.httpUrl || cfg.url || '', { input, ...ctx });
        if (!url) throw new Error('HTTP step: no URL');
        const method  = (cfg.httpMethod || cfg.method || 'POST').toUpperCase();
        const bodyStr = interpolate(cfg.httpBody || cfg.body || JSON.stringify({ input }), { input, ...ctx });
        let bodyObj;
        try { bodyObj = JSON.parse(bodyStr); } catch { bodyObj = bodyStr; }
        const extraHdrs = cfg.httpHeaders ? (typeof cfg.httpHeaders === 'string' ? JSON.parse(cfg.httpHeaders) : cfg.httpHeaders) : {};
        const r = await httpPost(url, bodyObj, extraHdrs, cfg.timeout || 15000);
        if (cfg.httpExpect && String(r.status) !== String(cfg.httpExpect)) {
          throw new Error(`HTTP step: expected ${cfg.httpExpect}, got ${r.status}`);
        }
        return r.body;
      }

      case 'webhook':
      case 'make':
      case 'n8n':
      case 'zapier':
      case 'clocky': {
        const url = cfg.url || cfg.webhookUrl;
        if (!url) throw new Error(`${step.type}: no webhook URL configured`);
        const r = await httpPost(url, { input, runId: ctx.runId, workflowId: ctx.workflowId, ts: Date.now() }, cfg.headers || {});
        return cfg.waitForResponse ? r.body : input;
      }

      case 'command': {
        const bridgeUrl = ctx.bridgeUrl || 'http://localhost:3747';
        const endpoint  = interpolate(cfg.cmdEndpoint || '/', { input, ...ctx });
        const method    = cfg.cmdMethod || 'POST';
        let bodyObj = {};
        if (cfg.cmdBody) { try { bodyObj = JSON.parse(interpolate(cfg.cmdBody, { input, ...ctx })); } catch { bodyObj = { raw: cfg.cmdBody }; } }
        const r = await httpPost(`${bridgeUrl}${endpoint}`, bodyObj, {});
        if (cfg.cmdExpect && !String(r.status).startsWith(cfg.cmdExpect.replace('xx', ''))) {
          throw new Error(`Command: expected ${cfg.cmdExpect}, got ${r.status}`);
        }
        return r.body;
      }

      case 'bridge': {
        const bridgeUrl = ctx.bridgeUrl || 'http://localhost:3747';
        const r = await httpPost(`${bridgeUrl}${cfg.endpoint || '/v1/messages'}`, { input, ...(cfg.body || {}) });
        return r.body;
      }

      case 'schedule': {
        // Schedule step just marks metadata — actual scheduling is engine-level
        return input;
      }

      case 'condition': {
        const evaluator = CONDITIONS[cfg.conditionType || 'always'];
        const passed = evaluator ? evaluator(cfg, { ...ctx, input }) : true;
        return { passed, input };
      }

      case 'delay': {
        const ms = cfg.delayMs || ((cfg.delayAmt || 1) * { ms: 1, seconds: 1000, minutes: 60000, hours: 3600000 }[cfg.delayUnit || 'ms']);
        await new Promise(r => setTimeout(r, ms));
        return input;
      }

      case 'notification': {
        const msg = interpolate(cfg.notifMsg || '{{input}}', { input, ...ctx });
        this._e._emit('system.toast', { msg, type: { info: 'b', warn: 'o', error: 'r', success: 'g' }[cfg.notifLevel] || 'b' });
        this._e._emit('system.audit', { type: 'notification', msg, runId: ctx.runId });
        return input;
      }

      case 'log': {
        this._e._logConversation(ctx.runId, { type: 'step_log', input });
        return input;
      }

      case 'framework_inject': {
        Object.assign(ctx.injected, cfg.framework || {});
        return input;
      }

      case 'branch': {
        // Parallel/sequential branch execution
        const agents = (cfg.branchAgents || 'default').split(',').map(s => s.trim());
        const branchInput = interpolate(cfg.branchInput || '{{input}}', { input, ...ctx });
        if (cfg.branchMode === 'parallel') {
          const results = await Promise.allSettled(agents.map(agent =>
            this.run({ type: 'agent', config: { agentType: agent, agentInput: branchInput } }, branchInput, ctx)
          ));
          const fulfilled = results.filter(r => r.status === 'fulfilled').map(r => r.value);
          if (!fulfilled.length) throw new Error('All parallel branches failed');
          switch (cfg.branchMerge || 'all_concat') {
            case 'first_wins':  return fulfilled[0];
            case 'longest':     return fulfilled.reduce((a, b) => String(a).length >= String(b).length ? a : b);
            case 'shortest':    return fulfilled.reduce((a, b) => String(a).length <= String(b).length ? a : b);
            default:            return fulfilled.join('\n\n---\n\n');
          }
        }
        // Sequential
        let out = branchInput;
        for (const agent of agents) {
          out = await this.run({ type: 'agent', config: { agentType: agent, agentInput: out } }, out, ctx);
        }
        return out;
      }

      case 'trigger': return input; // trigger step is metadata only

      default:
        throw new Error(`Unknown step type: ${step.type}`);
    }
  }
}

// ── Routing Engine ────────────────────────────────────────────────────────────
class RoutingEngine {
  constructor(opts = {}) {
    this.uuid          = MODULE_UUID;
    this.version       = MODULE_VERSION;
    this.dataDir       = opts.dataDir || './data';
    this._wfFile       = path.join(this.dataDir, 'routing-workflows.json');
    this._convFile     = path.join(this.dataDir, 'conversation-log.jsonl');
    this._runFile      = path.join(this.dataDir, 'routing-runlog.jsonl');
    this._workflows    = [];
    this._queue        = [];
    this._running      = new Map();
    this._convLogs     = new Map();
    this._stats        = { runs: 0, success: 0, failed: 0, queued: 0 };
    this._bus          = null;
    this._tick         = null;
    this._executor     = new StepExecutor(this);
    this._load();
  }

  setBus(bus) {
    this._bus = bus;
    bus.on('automation.queue',   ev => this.queueWorkflow(ev.data.workflowId, ev.data));
    bus.on('routing.trigger',    ev => this._handleTrigger(ev.data));
    bus.on('routing.import',     ev => this.importWorkflows(ev.data));
  }

  _emit(t, d) { if (this._bus) this._bus.emit(t, d, { source: 'routing' }); }

  _fail(ctx, msg) {
    console.error(`[ROUTING] ${ctx}: ${msg}`);
    this._stats.failed = (this._stats.failed || 0) + 1;
    this._appendLog(this._runFile, { ts: Date.now(), type: 'ERROR', ctx, msg });
    this._emit('system.error',  { source: 'routing', context: ctx, message: msg });
    this._emit('system.toast',  { msg: `Routing: ${msg}`, type: 'r' });
  }

  _appendLog(file, e) {
    try { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.appendFileSync(file, JSON.stringify(e) + '\n'); }
    catch (err) { console.error(`[ROUTING LOG] ${file}: ${err.message}`); }
  }

  _logConversation(runId, entry) {
    if (!this._convLogs.has(runId)) this._convLogs.set(runId, []);
    this._convLogs.get(runId).push({ ts: Date.now(), ...entry });
    this._appendLog(this._convFile, { runId, ts: Date.now(), ...entry });
  }

  _load() {
    try {
      if (fs.existsSync(this._wfFile)) {
        const d = JSON.parse(fs.readFileSync(this._wfFile, 'utf8'));
        this._workflows = d.workflows || [];
      }
    } catch (e) { this._fail('load', e.message); }
  }

  _save() {
    try {
      fs.mkdirSync(this.dataDir, { recursive: true });
      const tmp = this._wfFile + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify({ workflows: this._workflows }, null, 2));
      fs.renameSync(tmp, this._wfFile);
    } catch (e) { this._fail('save', e.message); }
  }

  addWorkflow(wf) {
    const w = { id: uid(), name: 'Unnamed', status: 'draft', steps: [],
                trigger: { type: 'manual' }, runCount: 0, created: Date.now(), ...wf };
    this._workflows.push(w);
    this._save();
    this._emit('automation.workflow_added', { id: w.id, name: w.name });
    return w;
  }

  updateWorkflow(id, patch) {
    const wf = this._workflows.find(w => w.id === id);
    if (!wf) { this._fail('update', `Not found: ${id}`); return null; }
    Object.assign(wf, patch);
    this._save();
    return wf;
  }

  removeWorkflow(id) {
    this._workflows = this._workflows.filter(w => w.id !== id);
    this._save();
    this._emit('automation.workflow_removed', { id });
  }

  queueWorkflow(workflowId, opts = {}) {
    const wf = this._workflows.find(w => w.id === workflowId);
    if (!wf) { this._fail('queue', `WF not found: ${workflowId}`); return null; }
    const runId = uid().slice(0, 8);
    this._queue.push({ runId, workflowId, priority: opts.priority || 0,
                       queuedAt: Date.now(), input: opts.input || '', reason: opts.reason || 'manual' });
    this._queue.sort((a, b) => b.priority - a.priority);
    this._stats.queued++;
    this._emit('automation.queue', { runId, workflowId, name: wf.name });
    if (opts.immediate !== false) this._processQueue();
    return runId;
  }

  _processQueue() {
    const maxC = 3;
    while (this._queue.length && this._running.size < maxC) {
      this._runWorkflow(this._queue.shift());
    }
  }

  startTick(ms = 5000) {
    if (this._tick) clearInterval(this._tick);
    this._tick = setInterval(() => {
      for (const wf of this._workflows) {
        if (wf.status !== 'active') continue;
        const ev = CONDITIONS[wf.trigger?.type];
        if (ev && ev(wf.trigger || {}, { _lastRun: wf.lastRun || 0 })) {
          this.queueWorkflow(wf.id, { reason: `auto:${wf.trigger.type}` });
        }
      }
      this._processQueue();
    }, ms);
  }

  stopTick() { if (this._tick) { clearInterval(this._tick); this._tick = null; } }

  async _runWorkflow({ runId, workflowId, input, reason }) {
    const wf = this._workflows.find(w => w.id === workflowId);
    if (!wf) return;

    this._running.set(runId, { workflowId, startedAt: Date.now() });
    this._stats.runs++;
    this._emit('automation.run',  { runId, workflowId, name: wf.name, reason });
    this._emit('system.toast',    { msg: `▶ Running: ${wf.name}`, type: 'b' });
    this._logConversation(runId,  { type: 'run_start', name: wf.name, input, reason });

    const ctx = {
      runId, workflowId, workflowName: wf.name, reason,
      bridgeUrl: 'http://localhost:3747',
      injected: {},
      startedAt: Date.now(),
    };

    let cur = input;
    const steps = wf.steps || [];
    let i = 0;

    try {
      while (i < steps.length) {
        const step = steps[i];
        if (!step.enabled) { i++; continue; }

        this._logConversation(runId, { type: 'step_start', stepId: step.id, stepType: step.type, input: cur });
        let out;
        try {
          out = await this._executor.run(step, cur, ctx);
        } catch (e) {
          this._fail('step', `${step.label || step.type} failed: ${e.message}`);
          this._logConversation(runId, { type: 'step_error', stepId: step.id, error: e.message });
          if (step.config?.onFail === 'skip') { i++; continue; }
          if (step.config?.onFail === 'end')  break;
          throw e;
        }

        // Branch handling
        if (step.type === 'condition' && out && typeof out === 'object' && 'passed' in out) {
          if (!out.passed) {
            const target = step.config?.condOnFalse;
            if (target === 'end')  break;
            if (target === 'skip') { i++; continue; }
            const ti = steps.findIndex(s => s.id === target);
            if (ti >= 0) { i = ti; continue; }
          }
          out = out.input;
        }

        this._logConversation(runId, { type: 'step_done', stepId: step.id });
        cur = out;
        i++;
      }

      wf.lastRun  = Date.now();
      wf.runCount = (wf.runCount || 0) + 1;
      this._save();
      this._stats.success++;
      this._running.delete(runId);
      this._logConversation(runId, { type: 'run_done', output: typeof cur === 'string' ? cur.slice(0, 500) : cur });
      this._emit('automation.done',  { runId, workflowId, name: wf.name });
      this._emit('system.toast',     { msg: `✓ ${wf.name}`, type: 'g' });

    } catch (err) {
      this._running.delete(runId);
      this._fail('workflow', `${wf.name}: ${err.message}`);
      this._logConversation(runId, { type: 'run_error', error: err.message });
      this._emit('automation.error', { runId, workflowId, name: wf.name, error: err.message });
    }
  }

  _handleTrigger(data) {
    for (const wf of this._workflows) {
      if (wf.status !== 'active') continue;
      const t = wf.trigger || {};
      if (t.type === data.type || t.event === data.event) {
        this.queueWorkflow(wf.id, { reason: `trigger:${data.type}`, input: data.input || '' });
      }
    }
  }

  importWorkflows(data) {
    try {
      const d = typeof data === 'string' ? JSON.parse(data) : data;
      let n = 0;
      for (const wf of (d.workflows || [])) { this.addWorkflow(wf); n++; }
      this._emit('system.toast', { msg: `Imported ${n} workflows`, type: 'g' });
      return { ok: true, imported: n };
    } catch (e) { this._fail('import', e.message); return { ok: false, error: e.message }; }
  }

  exportWorkflows() {
    return { workflows: this._workflows, exported: Date.now(), version: this.version };
  }

  health() {
    return { ok: true, uuid: this.uuid, version: this.version,
             workflows: this._workflows.length,
             active: this._workflows.filter(w => w.status === 'active').length,
             running: this._running.size, queued: this._queue.length,
             stats: { ...this._stats } };
  }

  listWorkflows() { return [...this._workflows]; }
  getConversationLog(runId) { return this._convLogs.get(runId) || []; }
}

if (typeof module !== 'undefined') module.exports = { RoutingEngine, StepExecutor, CONDITIONS };
