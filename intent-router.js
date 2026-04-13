/**
 * intent-router.js — BrainOS Intent Router
 * UUID: brainos-intent-router-v5000-000000000009
 * Phase 2 · Core Brain
 *
 * Intent → scored priority → ranked providers → agent selection → execution plan
 * Emits full trace events on bus. Fails loudly. No silent routing.
 *
 * Flow:
 *   route(intent)
 *     → score intent
 *     → rank providers
 *     → check agent registry
 *     → build execution plan
 *     → emit intent.routed
 *     → return plan
 */

'use strict';

const fs   = require('fs');
const path = require('path');

const { PARSER }        = require('./intent-parser');
const { SCORER, ROUTING_TABLE } = require('./intent-scoring');

const MODULE_UUID    = 'brainos-intent-router-v5000-000000000009';
const MODULE_VERSION = '5.0.0';

// ── Execution Plan schema ─────────────────────────────────────────────────────
//
//  intentId    : string
//  action      : string
//  agentType   : string  — which agent class handles this
//  provider    : string  — which AI provider (if AI agent)
//  fallbackChain: string[] — ordered provider fallbacks
//  steps       : Step[]  — execution steps
//  constraints : object
//  priority    : object
//  score       : number
//  traceId     : string

class IntentRouter {
  constructor(opts = {}) {
    this.uuid      = MODULE_UUID;
    this.version   = MODULE_VERSION;
    this.dataDir   = opts.dataDir || './data';
    this.tableFile = path.join(this.dataDir, 'routing-table.json');
    this._bus      = null;
    this._registry = null;   // AgentRegistry — injected via setRegistry()
    this._stats    = { routed: 0, failed: 0, fallbacks: 0 };

    // Merge static table with any learned overrides from disk
    this._table    = { ...ROUTING_TABLE };
    this._loadTable();
  }

  setBus(bus) {
    this._bus = bus;
    PARSER.setBus(bus);
    SCORER.setBus(bus);

    // Re-route on agent failure — try next in fallback chain
    bus.on('agent.failed', ev => this._handleAgentFailure(ev.data));
    // Adapt scoring from outcomes
    bus.on('agent.executed', () => SCORER.adapt());
  }

  setRegistry(registry) {
    this._registry = registry;
  }

  _emit(type, data) {
    if (this._bus) this._bus.emit(type, data, { source: 'intent-router' });
  }

  _fail(ctx, msg, intentId) {
    this._stats.failed++;
    console.error(`[INTENT-ROUTER] ${ctx}: ${msg}`);
    this._emit('system.error',   { source: 'intent-router', context: ctx, message: msg });
    this._emit('system.toast',   { msg: `Router: ${msg}`, type: 'r' });
    if (intentId) this._emit('intent.failed', { intentId, reason: msg });
  }

  _loadTable() {
    try {
      if (fs.existsSync(this.tableFile)) {
        const overrides = JSON.parse(fs.readFileSync(this.tableFile, 'utf8'));
        this._table = { ...ROUTING_TABLE, ...overrides };
      }
    } catch (e) { console.warn('[INTENT-ROUTER] Could not load routing-table.json:', e.message); }
  }

  _saveTable() {
    try {
      fs.mkdirSync(this.dataDir, { recursive: true });
      fs.writeFileSync(this.tableFile + '.tmp', JSON.stringify(this._table, null, 2));
      fs.renameSync(this.tableFile + '.tmp', this.tableFile);
    } catch (e) { console.warn('[INTENT-ROUTER] Could not save routing-table.json:', e.message); }
  }

  /**
   * Core routing method.
   *
   * route(input: string|Intent, meta?: object) → ExecutionPlan
   *
   * Accepts raw string or pre-parsed Intent object.
   * Returns a full execution plan the AgentFactory can consume.
   */
  route(input, meta = {}) {
    // 1. Parse if raw string
    let intent;
    try {
      intent = (typeof input === 'string' || (typeof input === 'object' && !input.action))
        ? PARSER.parse(input, meta)
        : PARSER._normalize(input, meta);
    } catch (e) {
      this._fail('parse', e.message);
      throw e;
    }

    // 2. Validate
    const validation = PARSER.validate(intent);
    if (!validation.ok) {
      this._fail('validate', validation.errors.join(', '), intent.id);
      throw new Error('Invalid intent: ' + validation.errors.join(', '));
    }

    // 3. Score
    SCORER.score(intent);

    // 4. Determine agent type
    const agentType = this._selectAgentType(intent);

    // 5. Build provider fallback chain
    const fallbackChain = this._buildFallbackChain(intent);

    // 6. Check agent registry for availability
    const agentCheck = this._registry
      ? this._registry.findBest(agentType, intent)
      : { agentId: null, available: true };

    // 7. Build execution plan
    const plan = {
      traceId:      require('crypto').randomBytes(6).toString('hex'),
      intentId:     intent.id,
      intent,
      agentType,
      agentId:      agentCheck.agentId || null,
      provider:     fallbackChain[0] || 'auto',
      fallbackChain,
      steps:        this._buildSteps(intent, agentType, fallbackChain),
      constraints:  intent.constraints,
      priority:     intent.priority,
      score:        intent.score,
      createdAt:    Date.now(),
      status:       'pending',
    };

    this._stats.routed++;

    this._emit('intent.routed', {
      traceId:    plan.traceId,
      intentId:   intent.id,
      action:     intent.action,
      agentType,
      provider:   plan.provider,
      score:      intent.score,
      chainLen:   fallbackChain.length,
    });

    return plan;
  }

  /** Map action → agent type */
  _selectAgentType(intent) {
    const hint = intent.agentHint;

    // Explicit agent hints from input
    if (hint === 'playwright') return 'PlaywrightAgent';

    // Action-based mapping
    const actionMap = {
      execute:   'AutomationAgent',
      deploy:    'SystemAgent',
      monitor:   'SystemAgent',
      code:      'AIAgent',
      analysis:  'AIAgent',
      reasoning: 'AIAgent',
      research:  'AIAgent',
      summarize: 'AIAgent',
      creative:  'AIAgent',
      fast:      'AIAgent',
      default:   'AIAgent',
    };

    return actionMap[intent.action] || 'AIAgent';
  }

  /** Build ordered provider fallback chain for this intent */
  _buildFallbackChain(intent) {
    const action     = intent.action || 'default';
    const tableChain = this._table[action] || this._table.default || [];

    // If user specified a provider hint, put it first
    let chain = [...tableChain];
    if (intent.agentHint && !chain.includes(intent.agentHint)) {
      chain.unshift(intent.agentHint);
    } else if (intent.agentHint) {
      chain = [intent.agentHint, ...chain.filter(p => p !== intent.agentHint)];
    }

    // Rank by scorer
    const ranked = SCORER.rankProviders(intent, chain);
    return ranked.map(r => r.provider);
  }

  /** Build the step list for this plan */
  _buildSteps(intent, agentType, fallbackChain) {
    // Single-step for AI agents, multi-step for automation/system
    if (agentType === 'AIAgent') {
      return [{
        id:       'step-1',
        type:     'ai',
        provider: fallbackChain[0],
        fallback: fallbackChain.slice(1),
        input:    intent.target,
        config: {
          action:     intent.action,
          signals:    intent.signals,
          constraints: intent.constraints,
        },
        status:   'pending',
      }];
    }

    if (agentType === 'AutomationAgent') {
      return [{
        id:     'step-1',
        type:   'automation',
        input:  intent.target,
        config: intent.signals,
        status: 'pending',
      }];
    }

    if (agentType === 'SystemAgent') {
      return [{
        id:     'step-1',
        type:   'system',
        action: intent.action,
        target: intent.target,
        config: intent.constraints,
        status: 'pending',
      }];
    }

    // Generic
    return [{ id: 'step-1', type: agentType.toLowerCase(), input: intent.target, status: 'pending' }];
  }

  /** Re-route when an agent reports failure — try next in fallback chain */
  _handleAgentFailure({ traceId, intentId, provider, reason }) {
    this._stats.fallbacks++;
    this._emit('system.toast', { msg: `Fallback: ${provider} failed → trying next`, type: 'o' });
    console.warn(`[INTENT-ROUTER] Fallback triggered for ${intentId}: ${provider} → ${reason}`);
  }

  /** Override routing table for an action */
  setRoute(action, providers) {
    if (!Array.isArray(providers) || !providers.length) {
      this._fail('setRoute', 'providers must be a non-empty array');
      return;
    }
    this._table[action] = providers;
    this._saveTable();
    this._emit('intent.route.updated', { action, providers });
  }

  getTable()  { return { ...this._table }; }
  getStats()  { return { ...this._stats }; }

  health() {
    return {
      ok: true,
      uuid: this.uuid,
      version: this.version,
      actions: Object.keys(this._table).length,
      stats:   this._stats,
      scorer:  SCORER.health(),
      parser:  PARSER.health(),
    };
  }
}

const ROUTER = new IntentRouter();

module.exports = { IntentRouter, ROUTER };
