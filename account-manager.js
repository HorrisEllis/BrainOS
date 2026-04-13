/**
 * NEXUS Account Manager v2
 * Multi-account per AI provider with persistent profile storage.
 *
 * Fixes applied:
 *   [1] In-memory state cache — loadState() no longer hits disk on every call
 *   [2] Write mutex — concurrent saveState() calls serialized, no corruption
 *   [3] Custom providers persisted to disk — LOGIN_URLS/SELECTORS survive restart
 *   [4] Auto-heal cooldown — isAvailable() writes active status back to disk when cooldown expires
 *   [5] connectAccount try/finally — Playwright context always closed, no leaks
 */

'use strict';

const fs   = require('fs');
const path = require('path');

const ACCOUNTS_FILE = path.join(__dirname, 'data', 'accounts.json');
const PROFILES_DIR  = path.join(__dirname, 'profiles');

// ─── In-Memory State Cache (Fix #1) ──────────────────────────────────────────

let _stateCache = null;

function invalidateCache() { _stateCache = null; }

// ─── Write Mutex (Fix #2) ────────────────────────────────────────────────────

let _writeLock = Promise.resolve();

function withLock(fn) {
  _writeLock = _writeLock.then(() => fn()).catch(() => fn());
  return _writeLock;
}

// ─── Defaults ─────────────────────────────────────────────────────────────────

const BUILTIN_PROVIDERS = {
  claude:      { loginUrl: 'https://claude.ai/login',                    successSelector: '[data-testid="chat-input"], div[contenteditable="true"]' },
  chatgpt:     { loginUrl: 'https://chat.openai.com/auth/login',         successSelector: 'textarea#prompt-textarea, textarea[data-id="root"]'      },
  gemini:      { loginUrl: 'https://gemini.google.com/',                 successSelector: 'rich-textarea [contenteditable="true"], div.ql-editor'   },
  perplexity:  { loginUrl: 'https://www.perplexity.ai/',                 successSelector: 'textarea[placeholder]'                                   },
  mistral:     { loginUrl: 'https://chat.mistral.ai/chat',               successSelector: 'textarea, [contenteditable="true"]'                      },
  copilot:     { loginUrl: 'https://copilot.microsoft.com/',             successSelector: 'textarea, cib-text-input'                                },
  poe:         { loginUrl: 'https://poe.com/',                           successSelector: 'textarea.GrowingTextArea_textArea__ZWQbP'                },
  grok:        { loginUrl: 'https://grok.com/',                          successSelector: 'textarea, [data-testid="tweetTextarea_0"]'                },
  cohere:      { loginUrl: 'https://coral.cohere.com/',                  successSelector: 'textarea[placeholder]'                                   },
};

const DEFAULT_STATE = {
  providers:      Object.fromEntries(Object.keys(BUILTIN_PROVIDERS).map(k => [k, { accounts: {} }])),
  customProviders: {},  // Fix #3: persisted custom provider configs
};

// ─── Storage ──────────────────────────────────────────────────────────────────

function loadState() {
  if (_stateCache) return _stateCache;
  try {
    fs.mkdirSync(path.dirname(ACCOUNTS_FILE), { recursive: true });
    if (!fs.existsSync(ACCOUNTS_FILE)) {
      _stateCache = JSON.parse(JSON.stringify(DEFAULT_STATE));
      return _stateCache;
    }
    _stateCache = JSON.parse(fs.readFileSync(ACCOUNTS_FILE, 'utf8'));
    // Ensure shape
    if (!_stateCache.providers)       _stateCache.providers       = {};
    if (!_stateCache.customProviders) _stateCache.customProviders = {};
    return _stateCache;
  } catch {
    _stateCache = JSON.parse(JSON.stringify(DEFAULT_STATE));
    return _stateCache;
  }
}

function saveState(state) {
  return withLock(() => {
    fs.mkdirSync(path.dirname(ACCOUNTS_FILE), { recursive: true });
    // Write to temp file then rename — atomic on all platforms
    const tmp = ACCOUNTS_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
    fs.renameSync(tmp, ACCOUNTS_FILE);
    _stateCache = state;
  });
}

// ─── Provider Config (builtin + custom) ──────────────────────────────────────

function getProviderConfig(provider) {
  const builtin = BUILTIN_PROVIDERS[provider];
  if (builtin) return builtin;
  const state = loadState();
  return state.customProviders?.[provider] || null;
}

// ─── Account CRUD ─────────────────────────────────────────────────────────────

function listAccounts(provider) {
  const state = loadState();
  const p = state.providers[provider];
  if (!p) return [];
  return Object.entries(p.accounts).map(([id, data]) => ({ id, ...data }));
}

function listAllAccounts() {
  const state = loadState();
  const all = [];
  for (const [provider, p] of Object.entries(state.providers)) {
    for (const [id, data] of Object.entries(p.accounts || {})) {
      all.push({ provider, id, ...data });
    }
  }
  return all;
}

function getAccount(provider, accountId) {
  const state = loadState();
  return state.providers[provider]?.accounts?.[accountId] || null;
}

function upsertAccount(provider, accountId, data) {
  const state = loadState();
  if (!state.providers[provider]) state.providers[provider] = { accounts: {} };
  if (!state.providers[provider].accounts) state.providers[provider].accounts = {};
  state.providers[provider].accounts[accountId] = {
    ...state.providers[provider].accounts[accountId],
    ...data,
    updatedAt: Date.now(),
  };
  return saveState(state);
}

function removeAccount(provider, accountId) {
  const state = loadState();
  if (state.providers[provider]?.accounts?.[accountId]) {
    delete state.providers[provider].accounts[accountId];
    saveState(state);
    const pPath = path.join(PROFILES_DIR, `${provider}-${accountId}`);
    if (fs.existsSync(pPath)) fs.rmSync(pPath, { recursive: true, force: true });
  }
}

// ─── Status Helpers ───────────────────────────────────────────────────────────

function markAccountStatus(provider, accountId, status, extra = {}) {
  return upsertAccount(provider, accountId, { status, ...extra });
}

function disableAccountTemporarily(provider, accountId, ms = 60_000) {
  return upsertAccount(provider, accountId, {
    status:        'rate_limited',
    cooldownUntil: Date.now() + ms,
  });
}

function markExpired(provider, accountId) {
  return upsertAccount(provider, accountId, { status: 'expired' });
}

function markActive(provider, accountId) {
  return upsertAccount(provider, accountId, { status: 'active', lastUsed: Date.now() });
}

/**
 * Check if account is usable. Auto-heals expired cooldowns back to disk. (Fix #4)
 */
function isAvailable(account) {
  if (!account) return false;
  if (account.status === 'expired' || account.status === 'blocked') return false;
  if (account.status === 'rate_limited') {
    if (account.cooldownUntil && Date.now() > account.cooldownUntil) {
      // Heal: write active status back so /accounts endpoint shows correct state
      if (account._provider && account._accountId) {
        upsertAccount(account._provider, account._accountId, {
          status: 'active', cooldownUntil: null,
        }).catch(() => {});
      }
      return true;
    }
    return false;
  }
  return true;
}

/**
 * Get account with provider/accountId attached for auto-heal (Fix #4)
 */
function getAccountHealable(provider, accountId) {
  const acc = getAccount(provider, accountId);
  if (!acc) return null;
  return { ...acc, _provider: provider, _accountId: accountId };
}

// ─── Profile Path ─────────────────────────────────────────────────────────────

function profilePath(provider, accountId) {
  return path.join(PROFILES_DIR, `${provider}-${accountId}`);
}

// ─── Playwright Login Flow (Fix #5) ──────────────────────────────────────────

/**
 * Opens a Playwright browser window, waits for user login, captures cookies.
 * Context is always closed regardless of success/failure.
 */
async function connectAccount(provider, accountId, opts = {}) {
  let chromium;
  try {
    ({ chromium } = require('playwright'));
  } catch {
    throw new Error(
      'Playwright not installed.\n' +
      'Run: npm install playwright && npx playwright install chromium'
    );
  }

  const cfg      = getProviderConfig(provider);
  const pPath    = profilePath(provider, accountId);
  const loginUrl = opts.customUrl      || cfg?.loginUrl          || 'about:blank';
  const selector = opts.customSelector || cfg?.successSelector   || 'body';

  fs.mkdirSync(pPath, { recursive: true });

  // Mark as connecting
  await upsertAccount(provider, accountId, { status: 'connecting', profilePath: pPath });

  let context = null;
  try {
    context = await chromium.launchPersistentContext(pPath, {
      headless: false,
      viewport: { width: 1280, height: 800 },
      args: [
        '--no-sandbox',
        '--disable-blink-features=AutomationControlled',
        '--disable-infobars',
      ],
      ignoreDefaultArgs: ['--enable-automation'],
    });

    const page = await context.newPage();

    // Remove automation signals
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    });

    await page.goto(loginUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });

    console.log(`[AccountManager] 🔐 Waiting for login: ${provider}/${accountId}`);
    console.log(`[AccountManager]    URL: ${loginUrl}`);

    // Wait indefinitely for user to log in
    await page.waitForSelector(selector, { timeout: 0 });

    const cookies = await context.cookies();

    await upsertAccount(provider, accountId, {
      status:          'active',
      profilePath:     pPath,
      loginUrl,
      successSelector: selector,
      cookieCount:     cookies.length,
      lastLogin:       Date.now(),
    });

    console.log(`[AccountManager] ✅ Captured ${cookies.length} cookies for ${provider}/${accountId}`);
    return { ok: true, provider, accountId, cookieCount: cookies.length };

  } catch (err) {
    await upsertAccount(provider, accountId, { status: 'error', lastError: err.message });
    throw err;
  } finally {
    // Always close — Fix #5
    if (context) {
      try { await context.close(); } catch { /* ignore close errors */ }
    }
  }
}

/**
 * Add/update a custom provider with persistent config. (Fix #3)
 */
async function addCustomProvider(providerId, loginUrl, successSelector, label = '') {
  const state = loadState();
  if (!state.providers[providerId])       state.providers[providerId]       = { accounts: {} };
  if (!state.customProviders)             state.customProviders             = {};
  state.customProviders[providerId] = { loginUrl, successSelector, label };
  await saveState(state);
  console.log(`[AccountManager] Custom provider registered: ${providerId}`);
}

function removeCustomProvider(providerId) {
  const state = loadState();
  delete state.customProviders[providerId];
  delete state.providers[providerId];
  return saveState(state);
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
  // CRUD
  listAccounts,
  listAllAccounts,
  getAccount,
  getAccountHealable,
  upsertAccount,
  removeAccount,
  // Status
  markAccountStatus,
  disableAccountTemporarily,
  markExpired,
  markActive,
  isAvailable,
  // Providers
  profilePath,
  getProviderConfig,
  addCustomProvider,
  removeCustomProvider,
  BUILTIN_PROVIDERS,
  // Login
  connectAccount,
  // Internal
  loadState,
  invalidateCache,
};
