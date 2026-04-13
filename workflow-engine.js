/**
 * workflow-engine.js — BrainOS Workflow Engine
 * UUID: brainos-workflow-engine-v5000-000000000016
 * Phase 4 · Workflow Engine
 *
 * Multi-step execution graphs. Each step is routed through AgentFactory.
 * Supports: sequential chains, conditional branching, retry/fallback/abort,
 * agent switching per step, parallel branches, feedback loops.
 *
 * Workflow schema:
 *   id, name, status, trigger, steps[], onFail, createdAt, runCount
 *
 * Step schema:
 *   id, type, label, enabled, config{}, onFail, condition, next
 *
 * Axioms: every step emits trace events. Failures are loud and logged.
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const crypto = require('crypto');

const MODULE_UUID    = 'brainos-workflow-engine-v5000-000000000016';
const MODULE_VERSION = '5.0.0';

function uid8() { return crypto.randomBytes(4).toString('hex'); }

// ── Step executor — runs one step via AgentFactory ────────────────────────────
async function runStep(step, ctx, factory, bus) {
  const cfg = step.config || {};

  // Emit trace
  bus?.emit('workflow.step.start', { stepId: step.id, type: step.type, runId: ctx.runId });

  let output;

  switch (step.type) {
    case 'agent':
    case 'ai': {
      // Route through IntentRouter → AgentFactory
      const prompt = interpolate(cfg.agentInput || cfg.prompt || '{{input}}', ctx);
      const meta   = { source: 'workflow', workflowId: ctx.workflowId, agentHint: cfg.agentProvider };
      const plan   = factory._router.route(prompt, meta);
      // Override provider if step specifies one
      if (cfg.agentProvider && cfg.agentProvider !== 'auto') plan.provider = cfg.agentProvider;
      if (cfg.agentType)     plan.intent.action = cfg.agentType;
      output = await factory.execute(plan, ctx);
      if (output?.text) output = output.text;
      break;
    }

    case 'condition': {
      const passed = evalCondition(cfg, ctx);
      bus?.emit('workflow.condition.evaluated', { stepId: step.id, passed, runId: ctx.runId });
      return { __branch: true, passed, input: ctx.input };
    }

    case 'transform': {
      switch (cfg.fn || 'passthrough') {
        case 'uppercase':      output = String(ctx.input).toUpperCase(); break;
        case 'lowercase':      output = String(ctx.input).toLowerCase(); break;
        case 'trim':           output = String(ctx.input).trim(); break;
        case 'json_parse':     output = JSON.parse(ctx.input); break;
        case 'json_stringify': output = JSON.stringify(ctx.input, null, 2); break;
        case 'extract_field':  output = (typeof ctx.input === 'object' ? ctx.input : {})[cfg.field]; break;
        case 'template':       output = interpolate(cfg.template || '{{input}}', ctx); break;
        default:               output = ctx.input;
      }
      break;
    }

    case 'http':
    case 'api':
    case 'webhook':
    case 'make':
    case 'n8n':
    case 'zapier':
    case 'clocky': {
      const url    = interpolate(cfg.url || cfg.httpUrl || cfg.webhookUrl || '', ctx);
      if (!url) throw new Error(`${step.type}: no URL configured`);
      const method = (cfg.method || cfg.httpMethod || 'POST').toUpperCase();
      const bodyT  = cfg.body || cfg.httpBody || JSON.stringify({ input: ctx.input });
      const body   = typeof bodyT === 'string' ? interpolate(bodyT, ctx) : bodyT;
      const hdrs   = { 'Content-Type': 'application/json', ...(cfg.headers || {}) };

      const ac  = new AbortController();
      const tid = setTimeout(() => ac.abort(), cfg.timeout || 15000);
      try {
        const r = await fetch(url, {
          method,
          headers: hdrs,
          body: method !== 'GET' ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined,
          signal: ac.signal,
        });
        const text = await r.text();
        clearTimeout(tid);
        if (!r.ok) throw new Error(`HTTP ${r.status}: ${text.slice(0, 200)}`);
        try { output = JSON.parse(text); } catch { output = text; }
        if (step.type !== 'http' && step.type !== 'api' && !cfg.waitForResponse) output = ctx.input;
      } finally { clearTimeout(tid); }
      break;
    }

    case 'delay': {
      const ms = cfg.delayMs
        || ((cfg.delayAmt || 1) * ({ ms: 1, seconds: 1000, minutes: 60000, hours: 3600000 }[cfg.delayUnit] || 1));
      await new Promise(r => setTimeout(r, ms));
      output = ctx.input;
      break;
    }

    case 'notification': {
      const msg = interpolate(cfg.notifMsg || '{{input}}', ctx);
      bus?.emit('system.toast', {
        msg,
        type: { info: 'b', warn: 'o', error: 'r', success: 'g' }[cfg.notifLevel] || 'b',
      });
      bus?.emit('system.audit', { type: 'workflow.notification', msg, runId: ctx.runId });
      output = ctx.input;
      break;
    }

    case 'log': {
      bus?.emit('system.audit', { type: 'workflow.log', input: ctx.input, runId: ctx.runId, stepId: step.id });
      output = ctx.input;
      break;
    }

    case 'framework_inject': {
      Object.assign(ctx.injected, cfg.framework || {});
      output = ctx.input;
      break;
    }

    case 'branch': {
      // Parallel or sequential multi-agent fan-out
      const agents = (cfg.branchAgents || 'default').split(',').map(s => s.trim());
      const branchInput = interpolate(cfg.branchInput || '{{input}}', ctx);
      if (cfg.branchMode === 'parallel') {
        const results = await Promise.allSettled(agents.map(agent =>
          factory.dispatch(branchInput, { source: 'workflow-branch', agentHint: agent }, ctx)
            .then(r => r?.text || r)
        ));
        const ok = results.filter(r => r.status === 'fulfilled').map(r => r.value);
        if (!ok.length) throw new Error('All parallel branches failed');
        switch (cfg.branchMerge || 'all_concat') {
          case 'first_wins': output = ok[0]; break;
          case 'longest':    output = ok.reduce((a, b) => String(a).length >= String(b).length ? a : b); break;
          default:           output = ok.join('\n\n---\n\n');
        }
      } else {
        let o = branchInput;
        for (const agent of agents) {
          const r = await factory.dispatch(o, { source: 'workflow-seq', agentHint: agent }, ctx);
          o = r?.text || r || o;
        }
        output = o;
      }
      break;
    }

    case 'trigger':
    case 'schedule':
      // Metadata-only steps — just pass through
      output = ctx.input;
      break;

    default:
      throw new Error(`Unknown step type: ${step.type}`);
  }

  bus?.emit('workflow.step.complete', { stepId: step.id, type: step.type, runId: ctx.runId });
  return output;
}

function interpolate(tpl, ctx) {
  if (typeof tpl !== 'string') return tpl;
  return tpl
    .replace(/\{\{input\}\}/gi, ctx.input ?? '')
    .replace(/\{\{prev\}\}/gi, ctx.input ?? '')
    .replace(/\{\{runId\}\}/gi, ctx.runId ?? '')
    .replace(/\{\{ts\}\}/gi, Date.now())
    .replace(/\{\{wf\}\}/gi, ctx.workflowName ?? '')
    .replace(/\{\{([^}]+)\}\}/g, (_, k) => {
      const v = k.split('.').reduce((o, key) => o?.[key], ctx);
      return v !== undefined ? v : `{{${k}}}`;
    });
}

function evalCondition(cfg, ctx) {
  try {
    const lhs = cfg.condVar === 'custom_var'
      ? ctx.vars?.[cfg.customVar]
      : cfg.condVar?.split('.').reduce((o, k) => o?.[k], ctx) ?? ctx.input;
    const rhs = cfg.condValue;
    switch (cfg.condOp || '==') {
      case '==':  case '===':  return String(lhs) === String(rhs);
      case '!=':  case '!==':  return String(lhs) !== String(rhs);
      case '>':                return Number(lhs) > Number(rhs);
      case '<':                return Number(lhs) < Number(rhs);
      case '>=':               return Number(lhs) >= Number(rhs);
      case '<=':               return Number(lhs) <= Number(rhs);
      case 'contains':         return String(lhs).includes(String(rhs));
      case '!contains':        return !String(lhs).includes(String(rhs));
      default:                 return Boolean(lhs);
    }
  } catch { return false; }
}

// ── Workflow Engine ───────────────────────────────────────────────────────────

class WorkflowEngine {
  constructor(opts = {}) {
    this.uuid      = MODULE_UUID;
    this.version   = MODULE_VERSION;
    this.dataDir   = opts.dataDir || './data';
    this._wfFile   = path.join(this.dataDir, 'workflow-store.json');
    this._runFile  = path.join(this.dataDir, 'workflow-runlog.jsonl');
    this._wf       = [];          // loaded workflows
    this._running  = new Map();   // runId → { wf, status, startedAt }
    this._bus      = null;
    this._factory  = null;
    this._stats    = { runs: 0, success: 0, failed: 0 };
    this._load();
  }

  init(bus, factory) {
    this._bus     = bus;
    this._factory = factory;

    bus.on('workflow.run',    ev => this.run(ev.data.workflowId, ev.data));
    bus.on('workflow.queue',  ev => this.run(ev.data.workflowId, { ...ev.data, deferred: true }));
    bus.on('workflow.import', ev => this.import(ev.data));
    bus.on('intent.dispatch', ev => {
      // Auto-route intent.dispatch events through workflow if a workflowId is specified
      if (ev.data?.workflowId) this.run(ev.data.workflowId, ev.data);
    });
  }

  _emit(t, d) { if (this._bus) this._bus.emit(t, d, { source: 'workflow-engine' }); }

  _fail(ctx, msg, extra = {}) {
    console.error(`[WORKFLOW] ${ctx}: ${msg}`);
    this._stats.failed++;
    this._emit('system.error',  { source: 'workflow-engine', context: ctx, message: msg, ...extra });
    this._emit('system.toast',  { msg: `Workflow: ${msg}`, type: 'r' });
    this._appendRun({ ts: Date.now(), type: 'ERROR', ctx, msg, ...extra });
  }

  _load() {
    try {
      if (fs.existsSync(this._wfFile)) {
        const d = JSON.parse(fs.readFileSync(this._wfFile, 'utf8'));
        this._wf = d.workflows || [];
      }
    } catch (e) { console.warn('[WORKFLOW] Could not load workflow-store.json:', e.message); }
  }

  _save() {
    try {
      fs.mkdirSync(this.dataDir, { recursive: true });
      fs.writeFileSync(this._wfFile + '.tmp', JSON.stringify({ workflows: this._wf, version: this.version }, null, 2));
      fs.renameSync(this._wfFile + '.tmp', this._wfFile);
    } catch (e) { this._fail('save', e.message); }
  }

  _appendRun(entry) {
    try {
      fs.mkdirSync(this.dataDir, { recursive: true });
      fs.appendFileSync(this._runFile, JSON.stringify(entry) + '\n');
    } catch {}
  }

  // ── CRUD ──────────────────────────────────────────────────────────────────

  add(wf) {
    const w = {
      id:        uid8(),
      name:      'Unnamed',
      status:    'draft',
      trigger:   { type: 'manual' },
      steps:     [],
      onFail:    'abort',
      runCount:  0,
      created:   Date.now(),
      ...wf,
    };
    this._wf.push(w);
    this._save();
    this._emit('workflow.added', { id: w.id, name: w.name });
    return w;
  }

  update(id, patch) {
    const wf = this._wf.find(w => w.id === id);
    if (!wf) { this._fail('update', `Not found: ${id}`); return null; }
    Object.assign(wf, patch);
    this._save();
    return wf;
  }

  remove(id) {
    this._wf = this._wf.filter(w => w.id !== id);
    this._save();
    this._emit('workflow.removed', { id });
  }

  get(id) { return this._wf.find(w => w.id === id) || null; }
  list()  { return [...this._wf]; }

  import(data) {
    try {
      const d = typeof data === 'string' ? JSON.parse(data) : data;
      let n = 0;
      for (const wf of (d.workflows || [d])) { this.add(wf); n++; }
      this._emit('system.toast', { msg: `Imported ${n} workflow(s)`, type: 'g' });
      return { ok: true, imported: n };
    } catch (e) { this._fail('import', e.message); return { ok: false, error: e.message }; }
  }

  export() { return { workflows: this._wf, version: this.version, exported: Date.now() }; }

  // ── EXECUTION ─────────────────────────────────────────────────────────────

  /**
   * Run a workflow by ID.
   * run(workflowId, opts?) → runId
   */
  async run(workflowId, opts = {}) {
    const wf = this.get(workflowId);
    if (!wf) { this._fail('run', `Workflow not found: ${workflowId}`); return null; }
    if (wf.status !== 'active' && !opts.force) {
      this._fail('run', `Workflow "${wf.name}" is not active (status: ${wf.status}). Set force:true to override.`);
      return null;
    }

    const runId = uid8();
    const ctx   = {
      runId,
      workflowId,
      workflowName: wf.name,
      input:        opts.input || '',
      previousOutput: opts.input || '',
      bridgeUrl:    opts.bridgeUrl || 'http://localhost:3747',
      injected:     {},
      vars:         {},
      startedAt:    Date.now(),
    };

    this._running.set(runId, { wf, status: 'running', startedAt: ctx.startedAt });
    this._stats.runs++;
    this._appendRun({ ts: Date.now(), type: 'RUN_START', runId, workflowId, name: wf.name });
    this._emit('workflow.started', { runId, workflowId, name: wf.name, input: ctx.input });
    this._emit('system.toast', { msg: `▶ ${wf.name}`, type: 'b' });

    // Execute async — don't block caller
    this._execute(wf, ctx).then(result => {
      wf.lastRun  = Date.now();
      wf.runCount = (wf.runCount || 0) + 1;
      this._save();
      this._running.delete(runId);
      this._stats.success++;
      this._appendRun({ ts: Date.now(), type: 'RUN_DONE', runId, workflowId });
      this._emit('workflow.complete', { runId, workflowId, name: wf.name, result });
      this._emit('system.toast', { msg: `✓ ${wf.name}`, type: 'g' });
    }).catch(err => {
      this._running.delete(runId);
      this._fail('execute', `${wf.name}: ${err.message}`, { runId, workflowId });
      this._appendRun({ ts: Date.now(), type: 'RUN_ERROR', runId, workflowId, error: err.message });
      this._emit('workflow.failed', { runId, workflowId, name: wf.name, error: err.message });
    });

    return runId;
  }

  async _execute(wf, ctx) {
    const steps = (wf.steps || []).filter(s => s.enabled !== false);
    let i = 0;

    while (i < steps.length) {
      const step = steps[i];

      this._appendRun({ ts: Date.now(), type: 'STEP_START', runId: ctx.runId, stepId: step.id, stepType: step.type });

      let output;
      try {
        output = await runStep(step, ctx, this._factory, this._bus);
      } catch (err) {
        this._appendRun({ ts: Date.now(), type: 'STEP_ERROR', runId: ctx.runId, stepId: step.id, error: err.message });
        this._emit('system.toast', { msg: `Step "${step.label || step.type}" failed: ${err.message}`, type: 'r' });

        const onFail = step.config?.onFail || wf.onFail || 'abort';
        if (onFail === 'skip')  { i++; continue; }
        if (onFail === 'abort') throw err;
        if (onFail === 'retry') {
          try { output = await runStep(step, ctx, this._factory, this._bus); }
          catch (e2) { throw e2; }
        }
      }

      // Handle conditional branching
      if (output && typeof output === 'object' && output.__branch) {
        const passed = output.passed;
        const target = passed
          ? (step.config?.condOnTrue  || 'next')
          : (step.config?.condOnFalse || 'next');

        if (target === 'end')  break;
        if (target === 'skip') { i++; continue; }
        if (target !== 'next') {
          const ti = steps.findIndex(s => s.id === target);
          if (ti >= 0) { i = ti; continue; }
        }
        i++;
        continue;
      }

      this._appendRun({ ts: Date.now(), type: 'STEP_DONE', runId: ctx.runId, stepId: step.id });

      // Pass output as next step's input (the chain)
      if (output !== undefined && output !== null) {
        ctx.input          = typeof output === 'string' ? output : JSON.stringify(output);
        ctx.previousOutput = ctx.input;
      }

      i++;
    }

    return ctx.input;
  }

  health() {
    return {
      ok:       true,
      uuid:     this.uuid,
      version:  this.version,
      workflows: this._wf.length,
      active:   this._wf.filter(w => w.status === 'active').length,
      running:  this._running.size,
      stats:    { ...this._stats },
    };
  }
}

const ENGINE = new WorkflowEngine();

module.exports = { WorkflowEngine, ENGINE, runStep, evalCondition, interpolate };
