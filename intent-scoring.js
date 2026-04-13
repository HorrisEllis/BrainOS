/**
 * intent-scoring.js — BrainOS Intent Scoring Engine
 * UUID: brainos-intent-scoring-v5000-000000000008
 * Phase 2 · Intent Router
 *
 * Computes weighted priority scores for intents.
 * Scores determine routing order, agent selection, and queue priority.
 *
 * Score dimensions (each 0–10):
 *   urgency    — how time-sensitive
 *   risk       — how destructive if wrong
 *   complexity — how hard to execute
 *   entropy    — how ambiguous the intent
 *
 * Composite score = weighted sum → routing priority
 */

'use strict';

const MODULE_UUID    = 'brainos-intent-scoring-v5000-000000000008';
const MODULE_VERSION = '5.0.0';

// ── Default weights (sum to 1.0) ──────────────────────────────────────────────
const DEFAULT_WEIGHTS = {
  urgency:    0.35,
  risk:       0.25,
  complexity: 0.25,
  entropy:    0.15,   // inverse — high entropy = lower score
};

// ── Action baseline scores ────────────────────────────────────────────────────
// Each action has a baseline risk + complexity to start from
const ACTION_BASELINES = {
  execute:   { risk: 6, complexity: 5 },
  deploy:    { risk: 7, complexity: 6 },
  code:      { risk: 3, complexity: 6 },
  analysis:  { risk: 2, complexity: 5 },
  research:  { risk: 1, complexity: 4 },
  summarize: { risk: 1, complexity: 2 },
  creative:  { risk: 1, complexity: 3 },
  reasoning: { risk: 2, complexity: 6 },
  monitor:   { risk: 2, complexity: 3 },
  fast:      { risk: 1, complexity: 1 },
  default:   { risk: 2, complexity: 3 },
};

// ── Provider capability matrix ─────────────────────────────────────────────────
// How well each provider handles each action (0–10)
const PROVIDER_CAPABILITY = {
  claude:     { analysis: 9, reasoning: 10, code: 8, creative: 9, research: 9, summarize: 8, execute: 4, fast: 5, default: 8 },
  openai:     { analysis: 8, reasoning: 8,  code: 9, creative: 8, research: 8, summarize: 8, execute: 5, fast: 6, default: 8 },
  gemini:     { analysis: 7, reasoning: 7,  code: 8, creative: 7, research: 8, summarize: 7, execute: 4, fast: 7, default: 7 },
  deepseek:   { analysis: 8, reasoning: 9,  code: 9, creative: 6, research: 7, summarize: 7, execute: 5, fast: 6, default: 7 },
  ollama:     { analysis: 5, reasoning: 6,  code: 7, creative: 5, research: 5, summarize: 6, execute: 7, fast: 9, default: 6 },
  lmstudio:   { analysis: 5, reasoning: 6,  code: 7, creative: 5, research: 5, summarize: 6, execute: 7, fast: 9, default: 6 },
  koboldcpp:  { analysis: 4, reasoning: 5,  code: 5, creative: 7, research: 4, summarize: 5, execute: 6, fast: 8, default: 5 },
  venice:     { analysis: 4, reasoning: 5,  code: 4, creative: 9, research: 4, summarize: 5, execute: 4, fast: 5, default: 5 },
  mancer:     { analysis: 4, reasoning: 5,  code: 4, creative: 9, research: 4, summarize: 5, execute: 4, fast: 5, default: 5 },
  perplexity: { analysis: 7, reasoning: 6,  code: 5, creative: 5, research: 10,summarize: 8, execute: 3, fast: 6, default: 6 },
};

// ── Scorer ────────────────────────────────────────────────────────────────────

class IntentScorer {
  constructor(opts = {}) {
    this.uuid    = MODULE_UUID;
    this.version = MODULE_VERSION;
    this.weights = { ...DEFAULT_WEIGHTS, ...(opts.weights || {}) };
    this._bus    = null;
    this._history = [];   // { intentId, action, composite, selectedProvider, success, ts }
    this._providerStats = {};  // provider → { hits, misses, avgLatency }
  }

  setBus(bus) {
    this._bus = bus;
    // Learn from execution outcomes
    bus.on('agent.executed', ev => this._recordSuccess(ev.data));
    bus.on('agent.failed',   ev => this._recordFailure(ev.data));
  }

  _emit(type, data) {
    if (this._bus) this._bus.emit(type, data, { source: 'intent-scoring' });
  }

  /**
   * Score an intent. Mutates intent.priority with computed values.
   * Returns the composite priority score (0–10).
   */
  score(intent) {
    const baseline = ACTION_BASELINES[intent.action] || ACTION_BASELINES.default;

    // Apply baseline adjustments
    const p = {
      urgency:    intent.priority?.urgency    ?? 2,
      risk:       Math.max(intent.priority?.risk        ?? 2, baseline.risk),
      complexity: Math.max(intent.priority?.complexity  ?? 2, baseline.complexity),
      entropy:    intent.priority?.entropy    ?? 6,
    };

    // Constraint modifiers
    if (intent.constraints?.timeoutMs < 5000)  p.urgency    = Math.min(10, p.urgency + 3);
    if (intent.constraints?.riskLevel === 'low') p.risk      = Math.max(0, p.risk    - 2);
    if (intent.constraints?.riskLevel === 'high') p.risk     = Math.min(10, p.risk   + 2);

    // Signal modifiers
    if (intent.signals?.preferredProvider) p.entropy = Math.max(0, p.entropy - 2);
    if (intent.signals?.topics?.length > 3) p.complexity = Math.min(10, p.complexity + 1);

    // Composite: urgency and risk drive priority, entropy is inverse (more entropy = lower score)
    const composite = (
      p.urgency    * this.weights.urgency    +
      p.risk       * this.weights.risk       +
      p.complexity * this.weights.complexity +
      (10 - p.entropy) * this.weights.entropy
    );

    intent.priority = p;
    intent.score    = Math.round(composite * 10) / 10;

    this._emit('intent.scored', {
      intentId:  intent.id,
      action:    intent.action,
      score:     intent.score,
      priority:  p,
    });

    return intent.score;
  }

  /**
   * Rank a list of providers for a given intent.
   * Returns sorted array: [{ provider, score, reason }]
   */
  rankProviders(intent, candidateProviders) {
    const action = intent.action || 'default';
    const agentHint = intent.agentHint;

    const ranked = candidateProviders.map(provider => {
      const caps = PROVIDER_CAPABILITY[provider] || {};
      const capScore = caps[action] ?? caps.default ?? 5;

      // Historical success bonus
      const hist = this._providerStats[provider] || {};
      const successRate = hist.hits && (hist.hits + hist.misses)
        ? hist.hits / (hist.hits + hist.misses) : 0.7;  // default 70%

      // Latency penalty (penalize slow providers for fast intents)
      const avgLatency = hist.avgLatency || 3000;
      const latencyScore = action === 'fast'
        ? Math.max(0, 10 - avgLatency / 1000)
        : Math.max(0, 10 - avgLatency / 5000);

      // Hint bonus: if user specified this provider
      const hintBonus = agentHint === provider ? 3 : 0;

      const total = (capScore * 0.5) + (successRate * 10 * 0.3) + (latencyScore * 0.1) + hintBonus;

      return {
        provider,
        score:      Math.round(total * 10) / 10,
        capScore,
        successRate: Math.round(successRate * 100),
        latencyMs:  Math.round(avgLatency),
        reason:     `cap:${capScore} hist:${Math.round(successRate*100)}% lat:${Math.round(avgLatency)}ms${hintBonus ? ' +hint' : ''}`,
      };
    });

    return ranked.sort((a, b) => b.score - a.score);
  }

  /** Record a successful execution to improve future routing */
  _recordSuccess({ intentId, provider, latencyMs }) {
    if (!provider) return;
    const s = this._providerStats[provider] || { hits: 0, misses: 0, avgLatency: 3000 };
    s.hits++;
    s.avgLatency = s.avgLatency ? (s.avgLatency * 0.8 + (latencyMs || 3000) * 0.2) : latencyMs;
    this._providerStats[provider] = s;
    this._history.push({ intentId, provider, success: true, latencyMs, ts: Date.now() });
    if (this._history.length > 500) this._history.shift();
  }

  _recordFailure({ intentId, provider }) {
    if (!provider) return;
    const s = this._providerStats[provider] || { hits: 0, misses: 0, avgLatency: 3000 };
    s.misses++;
    this._providerStats[provider] = s;
    this._history.push({ intentId, provider, success: false, ts: Date.now() });
    if (this._history.length > 500) this._history.shift();
  }

  /** Tune weights based on recent history */
  adapt() {
    // If recent failures are risk-related, increase risk weight
    const recent = this._history.slice(-50);
    const failRate = recent.filter(h => !h.success).length / Math.max(recent.length, 1);
    if (failRate > 0.3) {
      this.weights.risk    = Math.min(0.5, this.weights.risk + 0.02);
      this.weights.urgency = Math.max(0.2, this.weights.urgency - 0.01);
      this._emit('intent.scoring.adapted', { failRate, weights: this.weights });
    }
  }

  getProviderStats() { return { ...this._providerStats }; }

  health() {
    return {
      ok: true,
      uuid: this.uuid,
      version: this.version,
      weights: this.weights,
      historySize: this._history.length,
      providerStats: this._providerStats,
    };
  }
}

// ── Routing table (static + learned) ─────────────────────────────────────────

const ROUTING_TABLE = {
  // action → ordered provider list (fallback chain)
  analysis:  ['claude', 'openai', 'gemini', 'deepseek', 'ollama'],
  reasoning: ['deepseek', 'claude', 'openai', 'ollama'],
  code:      ['deepseek', 'openai', 'gemini', 'ollama', 'claude'],
  research:  ['perplexity', 'claude', 'openai', 'gemini'],
  summarize: ['claude', 'openai', 'gemini', 'ollama'],
  creative:  ['claude', 'openai', 'venice', 'mancer'],
  execute:   ['ollama', 'lmstudio', 'koboldcpp'],
  fast:      ['ollama', 'lmstudio', 'koboldcpp', 'openai'],
  monitor:   ['ollama', 'openai', 'claude'],
  default:   ['ollama', 'claude', 'openai', 'gemini'],
};

const SCORER = new IntentScorer();

module.exports = { IntentScorer, SCORER, ROUTING_TABLE, PROVIDER_CAPABILITY, DEFAULT_WEIGHTS };
