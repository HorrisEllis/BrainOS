/**
 * intent-parser.js — BrainOS Intent Parser
 * UUID: brainos-intent-parser-v5000-000000000007
 * Phase 2 · Intent Router · Core Brain
 *
 * Converts raw inputs → normalized Intent objects.
 * Intent = { id, action, target, signals, constraints, score, source, ts }
 *
 * Axioms:
 *   - Intent must always be normalized before routing
 *   - Every parse emits a trace event on the bus
 *   - Failures are loud — never silent
 */

'use strict';

const crypto = require('crypto');

const MODULE_UUID    = 'brainos-intent-parser-v5000-000000000007';
const MODULE_VERSION = '5.0.0';

// ── Intent schema ─────────────────────────────────────────────────────────────
//
//  action      : string  — what to do   (e.g. 'summarize', 'execute', 'monitor')
//  target      : string  — what to do it to (url, node id, file path, topic)
//  signals     : object  — free-form key/value hints from the input
//  constraints : object  — limits: timeout, maxTokens, provider, risk level
//  priority    : object  — urgency / risk / complexity / entropy scores (0–10)
//  source      : string  — who created this intent
//  raw         : string  — original input preserved verbatim

// ── Known action verbs → canonical actions ────────────────────────────────────
const ACTION_ALIASES = {
  // analysis
  analyse: 'analysis', analyze: 'analysis', review: 'analysis', assess: 'analysis',
  evaluate: 'analysis', inspect: 'analysis', audit: 'analysis', examine: 'analysis',
  // summarize
  summarise: 'summarize', summarize: 'summarize', tldr: 'summarize', condense: 'summarize',
  brief: 'summarize', recap: 'summarize',
  // code
  code: 'code', implement: 'code', build: 'code', write: 'code', develop: 'code',
  program: 'code', script: 'code', fix: 'code', debug: 'code', refactor: 'code',
  // research
  research: 'research', find: 'research', search: 'research', look: 'research',
  investigate: 'research', explore: 'research', discover: 'research',
  // creative
  create: 'creative', generate: 'creative', design: 'creative', draft: 'creative',
  compose: 'creative', write: 'creative', imagine: 'creative',
  // reasoning
  reason: 'reasoning', explain: 'reasoning', why: 'reasoning', how: 'reasoning',
  solve: 'reasoning', plan: 'reasoning', think: 'reasoning', decide: 'reasoning',
  // execute
  run: 'execute', execute: 'execute', trigger: 'execute', start: 'execute',
  launch: 'execute', deploy: 'execute', send: 'execute',
  // monitor
  monitor: 'monitor', watch: 'monitor', track: 'monitor', observe: 'monitor',
  alert: 'monitor', notify: 'monitor',
  // fast
  quick: 'fast', fast: 'fast', instant: 'fast', asap: 'fast',
};

// Risk keywords that raise priority scores
const HIGH_RISK_SIGNALS  = ['delete', 'drop', 'remove', 'destroy', 'kill', 'shutdown', 'format', 'wipe'];
const HIGH_URGENCY       = ['urgent', 'asap', 'immediately', 'now', 'critical', 'emergency', 'p0', 'p1'];
const HIGH_COMPLEXITY    = ['recursive', 'distributed', 'parallel', 'federated', 'orchestrate', 'pipeline', 'multi'];

// ── Scoring ───────────────────────────────────────────────────────────────────

function scoreIntent(tokens, action, signals) {
  const joined = tokens.join(' ').toLowerCase();

  const urgency    = HIGH_URGENCY.some(w    => joined.includes(w)) ? 8
                   : joined.includes('soon') || joined.includes('today') ? 5 : 2;

  const risk       = HIGH_RISK_SIGNALS.some(w => joined.includes(w)) ? 9
                   : action === 'execute' || action === 'deploy' ? 6 : 2;

  const complexity = HIGH_COMPLEXITY.some(w   => joined.includes(w)) ? 8
                   : tokens.length > 20 ? 6
                   : tokens.length > 8  ? 4 : 2;

  // Entropy: how ambiguous is the intent (fewer clear signals = higher entropy)
  const signalCount = Object.keys(signals).length;
  const entropy    = signalCount >= 4 ? 2
                   : signalCount >= 2 ? 4
                   : signalCount === 1 ? 6 : 8;

  return { urgency, risk, complexity, entropy };
}

// ── Signal extraction ─────────────────────────────────────────────────────────

function extractSignals(tokens, raw) {
  const signals = {};

  // URL detection
  const url = raw.match(/https?:\/\/[^\s]+/);
  if (url) signals.url = url[0];

  // File path
  const fp = raw.match(/(?:^|\s)([\w./\\-]+\.\w{2,6})(?:\s|$)/);
  if (fp) signals.filePath = fp[1];

  // Provider hint
  const providers = ['claude', 'openai', 'gemini', 'ollama', 'deepseek', 'gpt', 'anthropic'];
  const prov = providers.find(p => raw.toLowerCase().includes(p));
  if (prov) signals.preferredProvider = prov === 'gpt' ? 'openai' : prov === 'anthropic' ? 'claude' : prov;

  // Node/port reference
  const portM = raw.match(/:(\d{4,5})\b/);
  if (portM) signals.port = parseInt(portM[1]);

  // Model hint
  const modelM = raw.match(/\b([\w-]+:\d+b|gpt-[\w.-]+|claude-[\w.-]+|gemini-[\w.-]+)\b/i);
  if (modelM) signals.model = modelM[1];

  // Topic extraction: take significant nouns (longer tokens, not stopwords)
  const STOPWORDS = new Set(['the','a','an','is','are','was','were','be','been','being',
    'have','has','had','do','does','did','will','would','could','should','may','might',
    'must','can','to','of','in','for','on','with','at','by','from','up','about','into',
    'through','during','before','after','and','but','or','if','then','that','this',
    'it','its','i','you','we','they','me','him','her','us','them','my','your','our']);
  const topics = tokens.filter(t => t.length > 4 && !STOPWORDS.has(t.toLowerCase()));
  if (topics.length) signals.topics = topics.slice(0, 5);

  return signals;
}

// ── Constraint extraction ─────────────────────────────────────────────────────

function extractConstraints(raw) {
  const c = {};

  // Timeout hints
  const timeM = raw.match(/(?:within|in|under|max)\s+(\d+)\s*(s|sec|second|m|min|minute|h|hour)/i);
  if (timeM) {
    const n = parseInt(timeM[1]);
    const u = timeM[2].toLowerCase()[0];
    c.timeoutMs = u === 's' ? n * 1000 : u === 'm' ? n * 60000 : n * 3600000;
  }

  // Token limits
  const tokM = raw.match(/(?:max|limit|under)\s+(\d+)\s*(?:token|tok|word)/i);
  if (tokM) c.maxTokens = parseInt(tokM[1]);

  // Risk level
  if (/\b(?:safe|careful|cautious|conservative)\b/i.test(raw)) c.riskLevel = 'low';
  if (/\b(?:aggressive|fast|yolo|unsafe)\b/i.test(raw)) c.riskLevel = 'high';

  return c;
}

// ── Main parser ───────────────────────────────────────────────────────────────

class IntentParser {
  constructor(opts = {}) {
    this.uuid    = MODULE_UUID;
    this.version = MODULE_VERSION;
    this._bus    = null;
    this._stats  = { parsed: 0, failed: 0 };
  }

  setBus(bus) {
    this._bus = bus;
  }

  _emit(type, data) {
    if (this._bus) this._bus.emit(type, data, { source: 'intent-parser' });
  }

  _fail(ctx, msg) {
    this._stats.failed++;
    console.error(`[INTENT-PARSER] ${ctx}: ${msg}`);
    this._emit('system.error', { source: 'intent-parser', context: ctx, message: msg });
  }

  /**
   * Parse raw input (string or object) into a normalized Intent.
   *
   * parse(raw: string, meta?: { source, workflowId, agentHint }) → Intent
   */
  parse(raw, meta = {}) {
    if (!raw) {
      this._fail('parse', 'Empty input — cannot create intent');
      throw new Error('IntentParser: input must not be empty');
    }

    // Accept string or pre-shaped object
    if (typeof raw === 'object' && raw.action) {
      return this._normalize(raw, meta);
    }

    const text   = String(raw).trim();
    const tokens = text.toLowerCase().split(/\s+/).filter(Boolean);

    // ── Action detection ──────────────────────────────────────────────────────
    let action = 'default';
    for (const token of tokens) {
      const canonical = ACTION_ALIASES[token];
      if (canonical) { action = canonical; break; }
    }

    // ── Target extraction ─────────────────────────────────────────────────────
    // Target = first meaningful noun phrase after action verb, or URL, or full text
    let target = text;
    const urlM = text.match(/https?:\/\/[^\s]+/);
    if (urlM) {
      target = urlM[0];
    } else {
      // Strip action verb from front if present
      const firstToken  = tokens[0];
      const isActionVerb = ACTION_ALIASES[firstToken] !== undefined;
      target = isActionVerb ? tokens.slice(1).join(' ') || text : text;
    }

    const signals     = extractSignals(tokens, text);
    const constraints = extractConstraints(text);
    const priority    = scoreIntent(tokens, action, signals);

    const intent = {
      id:          crypto.randomBytes(8).toString('hex'),
      action,
      target:      target.slice(0, 500),  // cap length
      signals,
      constraints,
      priority,
      source:      meta.source      || 'user',
      workflowId:  meta.workflowId  || null,
      agentHint:   meta.agentHint   || signals.preferredProvider || null,
      raw:         text.slice(0, 2000),
      ts:          Date.now(),
      version:     this.version,
    };

    this._stats.parsed++;
    this._emit('intent.created', { intentId: intent.id, action, source: intent.source });
    return intent;
  }

  /** Normalize a pre-shaped object into a full Intent */
  _normalize(obj, meta) {
    const intent = {
      id:          obj.id          || crypto.randomBytes(8).toString('hex'),
      action:      ACTION_ALIASES[obj.action] || obj.action || 'default',
      target:      obj.target      || '',
      signals:     obj.signals     || {},
      constraints: obj.constraints || {},
      priority:    obj.priority    || { urgency: 2, risk: 2, complexity: 2, entropy: 6 },
      source:      obj.source      || meta.source || 'normalized',
      workflowId:  obj.workflowId  || meta.workflowId || null,
      agentHint:   obj.agentHint   || null,
      raw:         obj.raw         || JSON.stringify(obj),
      ts:          obj.ts          || Date.now(),
      version:     this.version,
    };
    this._stats.parsed++;
    this._emit('intent.created', { intentId: intent.id, action: intent.action, source: intent.source });
    return intent;
  }

  /** Validate an intent has the required fields */
  validate(intent) {
    const errs = [];
    if (!intent.id)     errs.push('missing id');
    if (!intent.action) errs.push('missing action');
    if (!intent.ts)     errs.push('missing ts');
    if (errs.length) {
      this._fail('validate', errs.join(', '));
      return { ok: false, errors: errs };
    }
    return { ok: true };
  }

  health() {
    return { ok: true, uuid: this.uuid, version: this.version, stats: { ...this._stats } };
  }
}

// ── Exports ───────────────────────────────────────────────────────────────────
const PARSER = new IntentParser();

module.exports = { IntentParser, PARSER, ACTION_ALIASES };
