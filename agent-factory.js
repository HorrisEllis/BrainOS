/**
 * agent-factory.js — BrainOS Agent Factory
 * UUID: brainos-agent-factory-v5000-000000000015
 * Phase 3 · Agent Abstraction Layer
 *
 * Takes an ExecutionPlan from IntentRouter → selects agent → runs it → returns result.
 * The single execution gateway. Every AI/automation/system call goes through here.
 *
 * Flow:
 *   execute(plan, context)
 *     → registry.get(plan.agentType)
 *     → agent.run(plan, context)   (handles timeout + retry via BaseAgent)
 *     → emit workflow.step.complete
 *     → return result
 */

'use strict';

const { REGISTRY } = require('./agent-registry');
const { ROUTER }   = require('./intent-router');

const MODULE_UUID    = 'brainos-agent-factory-v5000-000000000015';
const MODULE_VERSION = '5.0.0';

class AgentFactory {
  constructor(opts = {}) {
    this.uuid    = MODULE_UUID;
    this.version = MODULE_VERSION;
    this._bus    = null;
    this._registry = REGISTRY;
    this._router   = ROUTER;
    this._stats  = { executed: 0, failed: 0 };
  }

  init(bus, opts = {}) {
    this._bus = bus;
    this._registry.init(bus, opts);
    this._router.setBus(bus);
    this._router.setRegistry(this._registry);

    bus.on('intent.dispatch', ev => {
      const { input, meta, context } = ev.data || {};
      this.dispatch(input, meta, context).catch(e =>
        this._fail('dispatch.event', e.message)
      );
    });
  }

  _emit(type, data) {
    if (this._bus) this._bus.emit(type, data, { source: 'agent-factory' });
  }

  _fail(ctx, msg, extra = {}) {
    this._stats.failed++;
    console.error(`[AGENT-FACTORY] ${ctx}: ${msg}`);
    this._emit('system.error', { source: 'agent-factory', context: ctx, message: msg });
    this._emit('system.toast', { msg: `Factory: ${msg}`, type: 'r' });
  }

  /**
   * Full dispatch pipeline:
   *   raw input → parse → route → execute
   *
   * dispatch(input: string|Intent, meta?, context?) → result
   */
  async dispatch(input, meta = {}, context = {}) {
    // 1. Route to execution plan
    let plan;
    try {
      plan = this._router.route(input, meta);
    } catch (e) {
      this._fail('route', e.message);
      throw e;
    }

    // 2. Execute plan
    return this.execute(plan, context);
  }

  /**
   * Execute a pre-built plan.
   * execute(plan: ExecutionPlan, context?) → result
   */
  async execute(plan, context = {}) {
    const { agentType, intentId, traceId } = plan;

    this._stats.executed++;
    this._emit('workflow.step.start', { traceId, intentId, agentType, step: plan.steps?.[0]?.id });

    let agent;
    try {
      agent = this._registry.get(agentType);
    } catch (e) {
      // Registry fails loudly — rethrow with context
      this._fail('getAgent', e.message, { traceId, intentId });
      throw e;
    }

    let result;
    try {
      result = await agent.run(plan, context);
    } catch (e) {
      this._fail('execute', e.message, { traceId, intentId, agentType });
      this._emit('workflow.step.failed', { traceId, intentId, agentType, error: e.message });
      throw e;
    }

    this._emit('workflow.step.complete', {
      traceId,
      intentId,
      agentType,
      step:    plan.steps?.[0]?.id,
      hasResult: !!result,
    });

    return result;
  }

  health() {
    return {
      ok:       true,
      uuid:     this.uuid,
      version:  this.version,
      stats:    { ...this._stats },
      registry: this._registry.health(),
      router:   this._router.health(),
    };
  }
}

const FACTORY = new AgentFactory();

module.exports = { AgentFactory, FACTORY };
