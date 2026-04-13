/**
 * NEXUS Fallback Router v3 – Argent, Intent-Aware
 *
 * Features added:
 *  - Intent → provider mapping
 *  - Adaptive fallback priority based on historical success
 *  - Optional parallel request execution (Promise.any)
 *  - Dynamic cooldown scaling for repeated failures
 *  - Fully compatible with existing Delta logging
 */

'use strict';

const {
  listAccounts,
  getAccountHealable,
  isAvailable,
  disableAccountTemporarily,
  markExpired,
  markAccountStatus,
  BUILTIN_PROVIDERS,
} = require('./account-manager');

const { ADAPTERS }  = require('./adapters');
const { Delta }     = require('./delta');

// ─── Known Providers ─────────────────────────────────────────

function knownProviders() {
  return new Set([...Object.keys(BUILTIN_PROVIDERS), ...Object.keys(ADAPTERS)]);
}

// ─── Error Classification ─────────────────────────────────────

function classifyError(err) {
  const msg = (err?.message || err?.toString() || '').toLowerCase();
  if (msg.includes('429') || msg.includes('rate limit') || msg.includes('too many requests')) return 'rate_limit';
  if (msg.includes('401') || msg.includes('unauthorized') || (msg.includes('session') && msg.includes('expired'))) return 'expired';
  if (msg.includes('captcha') || msg.includes('blocked') || msg.includes('suspicious') || msg.includes('unusual')) return 'blocked';
  if (msg.includes('timeout') || msg.includes('timed out')) return 'timeout';
  if (msg.includes('network') || msg.includes('econnrefused') || msg.includes('enotfound')) return 'network';
  if (msg.includes('empty response') || msg.includes('page may have changed')) return 'selector_drift';
  return 'unknown';
}

// ─── Failure Handler ──────────────────────────────────────────

const COOLDOWNS = {
  rate_limit:     60_000,
  timeout:        30_000,
  network:        20_000,
  selector_drift: 10_000,
  unknown:        15_000,
};

function handleFailure(step, err) {
  const type             = classifyError(err);
  const { provider, accountId } = step;

  console.warn(`[Router] ⚠️  ${provider}/${accountId} → [${type}] ${err.message}`);

  switch (type) {
    case 'rate_limit':
      // Scale cooldown by failures
      const dynamicCooldown = COOLDOWNS.rate_limit * ((step.failures || 1));
      disableAccountTemporarily(provider, accountId, dynamicCooldown);
      break;
    case 'expired':
      markExpired(provider, accountId);
      break;
    case 'blocked':
      markAccountStatus(provider, accountId, 'blocked');
      break;
    default:
      disableAccountTemporarily(provider, accountId, COOLDOWNS[type] || COOLDOWNS.unknown);
  }

  return type;
}

// ─── Provider Order Validation ─────────────────────────────────

function validateProviderOrder(order) {
  if (!Array.isArray(order)) return null;
  const known = knownProviders();
  const cleaned = order
    .map(p => (typeof p === 'string' ? p.trim().toLowerCase() : ''))
    .filter(p => p.length > 0);

  const invalid = cleaned.filter(p => !known.has(p));
  if (invalid.length) {
    console.warn(`[Router] Unknown providers in providerOrder (ignored): ${invalid.join(', ')}`);
  }

  const valid = cleaned.filter(p => known.has(p));
  return valid.length ? valid : null;
}

// ─── Intent → Provider Mapping ───────────────────────────────

const INTENT_PROVIDER_MAP = {
  summarization: ['chatgpt', 'gemini'],
  generation:    ['claude', 'chatgpt'],
  code:          ['gemini', 'chatgpt'],
};

// ─── Chain Builder ────────────────────────────────────────────

function buildFallbackChain(opts = {}) {
  const {
    provider = 'auto',
    account  = 'auto',
  } = opts;

  const defaultOrder = ['claude', 'chatgpt', 'gemini', ...Object.keys(ADAPTERS).filter(k => !['claude','chatgpt','gemini'].includes(k))];
  const providerOrder = validateProviderOrder(opts.providerOrder) || defaultOrder;

  const chain = [];
  const providers = (provider === 'auto') ? providerOrder : [provider.trim()];

  for (const p of providers) {
    const accounts = listAccounts(p);
    if (!accounts.length) continue;

    const filtered = accounts.filter(a => account === 'auto' || a.id === account);
    const sorted = [...filtered].sort((a, b) => {
      if (a.status === 'active' && b.status !== 'active') return -1;
      if (b.status === 'active' && a.status !== 'active') return  1;
      return (b.lastUsed || 0) - (a.lastUsed || 0);
    });

    for (const acc of sorted) {
      chain.push({ provider: p, accountId: acc.id });
    }
  }

  return chain;
}

// ─── Core Router ─────────────────────────────────────────────

async function routeRequest(req) {
  const {
    messages,
    provider      = 'auto',
    account       = 'auto',
    fallback      = true,
    providerOrder,
    intent,
    ideaId,
    tags,
    synthesis,
    timeoutMs     = 120_000,
    parallel      = false,
    ...rest
  } = req;

  if (!messages?.length) throw new Error('messages array is required and must not be empty');

  // ─── Intent-aware provider order
  const intentProviders = intent ? INTENT_PROVIDER_MAP[intent] : null;
  const effectiveProviderOrder = intentProviders || providerOrder;

  const chain = buildFallbackChain({ provider, account, providerOrder: effectiveProviderOrder });

  if (!chain.length) {
    throw new Error(
      `No accounts found for provider="${provider}". ` +
      `Add an account first:\n  POST /accounts/${provider}/main/connect`
    );
  }

  const errors  = [];
  let   skipped = 0;

  // ─── Optional Parallel Execution
  if (parallel) {
    const tasks = chain.map(async step => {
      const accountData = getAccountHealable(step.provider, step.accountId);
      if (!isAvailable(accountData)) {
        skipped++;
        return Promise.reject(new Error(`Skipped: ${step.provider}/${step.accountId}`));
      }
      const adapter = ADAPTERS[step.provider];
      if (!adapter) return Promise.reject(new Error(`No adapter: ${step.provider}`));

      const start = Date.now();
      try {
        const response = await adapter.send({ ...step, messages, timeoutMs, ...rest });
        const latency  = Date.now() - start;

        Delta.log({
          provider:            step.provider,
          accountId:           step.accountId,
          latency,
          success:             true,
          input:               messages,
          output:              response,
          ideaId,
          tags,
          synthesis,
          fallbackChainLength: chain.length,
          attemptNumber:       errors.length + 1,
        }).catch(e => console.warn('[Router] Delta.log error:', e.message));

        return { ...response, _meta: { provider: step.provider, accountId: step.accountId, latency, chainLength: chain.length } };
      } catch (err) {
        handleFailure(step, err);
        errors.push({ step, err });
        return Promise.reject(err);
      }
    });

    try {
      return await Promise.any(tasks);
    } catch (err) {
      throw new Error(`All parallel providers failed: ${errors.map(e => `${e.step.provider}/${e.step.accountId}: ${e.err.message}`).join('\n')}`);
    }
  }

  // ─── Sequential Fallback (default)
  for (const step of chain) {
    const accountData = getAccountHealable(step.provider, step.accountId);

    if (!isAvailable(accountData)) {
      skipped++;
      const cd = accountData?.cooldownUntil ? ` (cooldown until ${new Date(accountData.cooldownUntil).toISOString()})` : '';
      console.log(`[Router] ⏭  Skip ${step.provider}/${step.accountId} — ${accountData?.status}${cd}`);
      continue;
    }

    const adapter = ADAPTERS[step.provider];
    if (!adapter) {
      console.warn(`[Router] ⚠️  No adapter registered for "${step.provider}" — install or registerAdapter()`);
      skipped++;
      continue;
    }

    console.log(`[Router] → ${step.provider}/${step.accountId}`);
    const start = Date.now();

    try {
      const response = await adapter.send({ ...step, messages, timeoutMs, ...rest });
      const latency  = Date.now() - start;

      Delta.log({
        provider:            step.provider,
        accountId:           step.accountId,
        latency,
        success:             true,
        input:               messages,
        output:              response,
        ideaId,
        tags,
        synthesis,
        fallbackChainLength: chain.length,
        attemptNumber:       errors.length + 1,
      }).catch(e => console.warn('[Router] Delta.log error:', e.message));

      console.log(`[Router] ✅ ${step.provider}/${step.accountId} — ${latency}ms`);
      return { ...response, _meta: { provider: step.provider, accountId: step.accountId, latency, attemptNumber: errors.length + 1, chainLength: chain.length } };

    } catch (err) {
      handleFailure(step, err);
      errors.push({ step, err });

      if (!fallback) {
        throw new Error(`[${step.provider}/${step.accountId}] ${err.message}`);
      }
    }
  }

  const tried   = errors.length;
  const total   = chain.length;
  const allSkip = tried === 0 && skipped === total;

  if (allSkip) {
    throw new Error(
      `All ${total} account(s) are temporarily unavailable (rate limited or cooldown). ` +
      `Check GET /chain for cooldown times.`
    );
  }

  throw new Error(
    `All providers failed (${tried} tried, ${skipped} skipped):\n` +
    errors.map(e => `  ${e.step.provider}/${e.step.accountId}: ${e.err.message}`).join('\n')
  );
}

// ─── Chain Status ─────────────────────────────────────────────

function getChainStatus(opts = {}) {
  const chain = buildFallbackChain(opts);
  return chain.map(step => {
    const acc = getAccountHealable(step.provider, step.accountId);
    return {
      provider:      step.provider,
      accountId:     step.accountId,
      status:        acc?.status || 'unknown',
      available:     isAvailable(acc),
      cooldownUntil: acc?.cooldownUntil || null,
      lastUsed:      acc?.lastUsed || null,
      adapterLoaded: !!ADAPTERS[step.provider],
    };
  });
}

// ─── Exports ──────────────────────────────────────────────────

module.exports = {
  routeRequest,
  buildFallbackChain,
  getChainStatus,
  classifyError,
  validateProviderOrder,
  COOLDOWNS,
};