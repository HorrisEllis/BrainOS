/**
 * NEXUS Playwright Adapters v2
 * Sends messages to AI providers via persistent Chromium sessions.
 *
 * Fixes applied:
 *   [6]  getContext wraps require('playwright') in try/catch — graceful error
 *   [7]  contextPool has max-size and evicts stale contexts on account removal
 *   [8]  humanType uses evaluate() to clear contenteditable — page.fill() doesn't work on divs
 *   [9]  waitForFunction uses pollingInterval: 500ms — reduces CPU hammering
 *   [10] Multi-turn messages use conversation injection via new chat pages
 */

'use strict';

const { profilePath, markActive, getProviderConfig } = require('./account-manager');

// ─── Chromium Pool (Fix #6, #7) ───────────────────────────────────────────────

const MAX_POOL_SIZE = 20;
const contextPool   = new Map(); // key: "provider/accountId" → { ctx, createdAt, lastUsed }

function getChromium() {
  let chromium;
  try {
    ({ chromium } = require('playwright'));
  } catch {
    throw new Error(
      'Playwright not installed.\n' +
      'Run: npm install playwright && npx playwright install chromium\n' +
      'Then restart the bridge server.'
    );
  }
  return chromium;
}

async function getContext(provider, accountId) {
  const key   = `${provider}/${accountId}`;
  const pPath = profilePath(provider, accountId);
  const entry = contextPool.get(key);

  if (entry) {
    entry.lastUsed = Date.now();
    return entry.ctx;
  }

  // Evict LRU if at capacity (Fix #7)
  if (contextPool.size >= MAX_POOL_SIZE) {
    let oldest = null, oldestKey = null;
    for (const [k, v] of contextPool) {
      if (!oldest || v.lastUsed < oldest.lastUsed) { oldest = v; oldestKey = k; }
    }
    if (oldestKey) {
      try { await oldest.ctx.close(); } catch { /* ignore */ }
      contextPool.delete(oldestKey);
      console.log(`[Adapters] Evicted context: ${oldestKey}`);
    }
  }

  const chromium = getChromium();
  const ctx = await chromium.launchPersistentContext(pPath, {
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-blink-features=AutomationControlled',
      '--disable-infobars',
      '--disable-dev-shm-usage',  // prevents crashes in low-memory environments
      '--disable-gpu',
    ],
    ignoreDefaultArgs: ['--enable-automation'],
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  });

  // Inject stealth on every new page
  ctx.on('page', async page => {
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
      window.chrome = { runtime: {} };
    }).catch(() => {});
  });

  contextPool.set(key, { ctx, createdAt: Date.now(), lastUsed: Date.now() });
  return ctx;
}

async function closeContext(provider, accountId) {
  const key   = `${provider}/${accountId}`;
  const entry = contextPool.get(key);
  if (entry) {
    try { await entry.ctx.close(); } catch { /* ignore */ }
    contextPool.delete(key);
  }
}

async function closeAllContexts() {
  for (const [key, entry] of contextPool) {
    try { await entry.ctx.close(); } catch { /* ignore */ }
    contextPool.delete(key);
  }
}

// ─── Human Typing (Fix #8) ───────────────────────────────────────────────────
// page.fill() does NOT work on contenteditable divs (Claude, Gemini).
// Must use evaluate() to clear + keyboard.type() to fill.

async function humanType(page, selector, text, opts = {}) {
  const { minDelay = 15, maxDelay = 45 } = opts;

  await page.waitForSelector(selector, { timeout: 10_000 });
  await page.click(selector);
  await page.waitForTimeout(100 + Math.random() * 100);

  // Clear existing content — works for both input/textarea AND contenteditable
  await page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return;
    if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
      el.value = '';
      el.dispatchEvent(new Event('input', { bubbles: true }));
    } else {
      // contenteditable
      el.innerHTML = '';
      el.textContent = '';
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }
  }, selector);

  await page.waitForTimeout(50);

  // Type with human-like delays
  for (const char of text) {
    await page.keyboard.type(char, { delay: minDelay + Math.random() * (maxDelay - minDelay) });
  }
}

// ─── Multi-Turn Conversation Injection (Fix #10) ──────────────────────────────
// AI web UIs are single-turn chat windows. For multi-turn history,
// we inject prior context as a formatted preamble in the user message.
// This is the most reliable cross-provider approach.

function formatMessages(messages, provider = 'unknown') {
  if (!messages || !messages.length) return '';
  if (messages.length === 1) return messages[0].content || '';

  // Collapse system message as a context header
  const systemMsg = messages.find(m => m.role === 'system');
  const convo     = messages.filter(m => m.role !== 'system');

  const lines = [];

  if (systemMsg) {
    lines.push(`[System Context]\n${systemMsg.content}\n`);
  }

  if (convo.length > 1) {
    lines.push('[Conversation History]');
    for (const m of convo.slice(0, -1)) {
      const role = m.role === 'user' ? 'Human' : 'Assistant';
      lines.push(`${role}: ${m.content}`);
    }
    lines.push('');
    lines.push('[Current Message]');
  }

  const last = convo[convo.length - 1];
  lines.push(last.content || '');

  return lines.join('\n');
}

// ─── Response Timeout Wrapper ─────────────────────────────────────────────────

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`Timeout after ${ms}ms: ${label}`)), ms)
    ),
  ]);
}

// ─── Claude Adapter ───────────────────────────────────────────────────────────

const ClaudeAdapter = {
  provider: 'claude',

  async send({ accountId, messages, timeoutMs = 120_000 }) {
    const context = await getContext('claude', accountId);
    const page    = await context.newPage();

    try {
      await withTimeout(
        page.goto('https://claude.ai/new', { waitUntil: 'domcontentloaded', timeout: 30_000 }),
        35_000, 'Claude page load'
      );

      const inputSel = [
        '[data-testid="chat-input"]',
        'div[contenteditable="true"][placeholder]',
        'div.ProseMirror',
        'div[contenteditable="true"]',
      ].join(', ');

      await page.waitForSelector(inputSel, { timeout: 15_000 });

      const prompt = formatMessages(messages, 'claude');
      await humanType(page, inputSel, prompt);
      await page.waitForTimeout(200 + Math.random() * 300);

      // Try send button first, fall back to Enter
      const sendBtn = await page.$('[data-testid="send-button"], button[aria-label="Send Message"], button[type="submit"]');
      if (sendBtn) {
        const disabled = await sendBtn.getAttribute('disabled');
        if (!disabled) await sendBtn.click();
        else await page.keyboard.press('Enter');
      } else {
        await page.keyboard.press('Enter');
      }

      const response = await withTimeout(
        waitForClaudeResponse(page),
        timeoutMs, 'Claude response'
      );

      await markActive('claude', accountId);
      return response;

    } finally {
      await page.close().catch(() => {});
    }
  }
};

async function waitForClaudeResponse(page) {
  // Wait for generation to start (Fix #9 — 500ms polling)
  await page.waitForFunction(
    () => !!document.querySelector('[data-testid="stop-button"]'),
    { timeout: 15_000, polling: 500 }
  ).catch(() => { /* might generate without showing stop button briefly */ });

  // Wait for generation to finish
  await page.waitForFunction(
    () => !document.querySelector('[data-testid="stop-button"]'),
    { timeout: 120_000, polling: 500 }
  );

  // Collect response text from multiple possible selectors
  const text = await page.evaluate(() => {
    const selectors = [
      '[data-testid="assistant-message"] .prose',
      '[data-testid="assistant-message"]',
      '.font-claude-message',
      '[data-is-streaming="false"] .prose',
    ];
    for (const sel of selectors) {
      const nodes = document.querySelectorAll(sel);
      if (nodes.length) return nodes[nodes.length - 1].innerText || '';
    }
    return '';
  });

  if (!text) throw new Error('Claude: empty response — page may have changed structure');
  return { content: [{ type: 'text', text: text.trim() }] };
}

// ─── ChatGPT Adapter ──────────────────────────────────────────────────────────

const ChatGPTAdapter = {
  provider: 'chatgpt',

  async send({ accountId, messages, timeoutMs = 120_000 }) {
    const context = await getContext('chatgpt', accountId);
    const page    = await context.newPage();

    try {
      await withTimeout(
        page.goto('https://chat.openai.com/', { waitUntil: 'domcontentloaded', timeout: 30_000 }),
        35_000, 'ChatGPT page load'
      );

      const inputSel = [
        'textarea#prompt-textarea',
        'textarea[data-id="root"]',
        'div#prompt-textarea[contenteditable]',
        'textarea',
      ].join(', ');

      await page.waitForSelector(inputSel, { timeout: 15_000 });

      const prompt = formatMessages(messages, 'chatgpt');
      await humanType(page, inputSel, prompt);
      await page.waitForTimeout(200 + Math.random() * 300);

      const sendBtn = await page.$('button[data-testid="send-button"], button[aria-label="Send prompt"]');
      if (sendBtn) await sendBtn.click();
      else await page.keyboard.press('Enter');

      const response = await withTimeout(
        waitForChatGPTResponse(page),
        timeoutMs, 'ChatGPT response'
      );

      await markActive('chatgpt', accountId);
      return response;

    } finally {
      await page.close().catch(() => {});
    }
  }
};

async function waitForChatGPTResponse(page) {
  // Wait for streaming to start
  await page.waitForFunction(
    () => !!document.querySelector('[data-testid="stop-button"], button[aria-label="Stop generating"]'),
    { timeout: 10_000, polling: 500 }
  ).catch(() => {});

  // Wait for streaming to stop
  await page.waitForFunction(
    () => !document.querySelector('[data-testid="stop-button"], button[aria-label="Stop generating"]'),
    { timeout: 120_000, polling: 500 }
  );

  const text = await page.evaluate(() => {
    const selectors = [
      'article[data-testid^="conversation-turn"]:last-child .markdown',
      'article[data-testid^="conversation-turn"]:last-child',
      '[data-message-author-role="assistant"]:last-child',
    ];
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el?.innerText) return el.innerText;
    }
    // Fallback: all assistant messages
    const all = document.querySelectorAll('[data-message-author-role="assistant"]');
    if (all.length) return all[all.length - 1].innerText || '';
    return '';
  });

  if (!text) throw new Error('ChatGPT: empty response — page may have changed structure');
  return { content: [{ type: 'text', text: text.trim() }] };
}

// ─── Gemini Adapter ───────────────────────────────────────────────────────────

const GeminiAdapter = {
  provider: 'gemini',

  async send({ accountId, messages, timeoutMs = 120_000 }) {
    const context = await getContext('gemini', accountId);
    const page    = await context.newPage();

    try {
      await withTimeout(
        page.goto('https://gemini.google.com/app', { waitUntil: 'domcontentloaded', timeout: 30_000 }),
        35_000, 'Gemini page load'
      );

      const inputSel = [
        'rich-textarea [contenteditable="true"]',
        '.ql-editor',
        'div[contenteditable="true"][aria-label]',
        'textarea',
      ].join(', ');

      await page.waitForSelector(inputSel, { timeout: 15_000 });

      const prompt = formatMessages(messages, 'gemini');
      await humanType(page, inputSel, prompt);
      await page.waitForTimeout(300 + Math.random() * 200);

      // Gemini uses Enter to submit, Shift+Enter for newlines
      const sendBtn = await page.$('button[aria-label="Send message"], button.send-button, mat-icon[aria-label="Send message"]');
      if (sendBtn) await sendBtn.click();
      else await page.keyboard.press('Enter');

      const response = await withTimeout(
        waitForGeminiResponse(page),
        timeoutMs, 'Gemini response'
      );

      await markActive('gemini', accountId);
      return response;

    } finally {
      await page.close().catch(() => {});
    }
  }
};

async function waitForGeminiResponse(page) {
  // Wait for response container to appear
  await page.waitForFunction(
    () => !!document.querySelector('model-response, .model-response-text'),
    { timeout: 15_000, polling: 500 }
  ).catch(() => {});

  // Wait for loading spinner to disappear
  await page.waitForFunction(
    () => {
      const loading = document.querySelector(
        '.loading-indicator, [data-is-loading="true"], .progress-container, .thinking-indicator'
      );
      return !loading;
    },
    { timeout: 120_000, polling: 500 }
  );

  const text = await page.evaluate(() => {
    const selectors = [
      'model-response:last-child .response-content',
      'model-response:last-child',
      '.model-response-text:last-child',
      '.response-container:last-child',
    ];
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el?.innerText) return el.innerText;
    }
    const all = document.querySelectorAll('model-response');
    if (all.length) return all[all.length - 1].innerText || '';
    return '';
  });

  if (!text) throw new Error('Gemini: empty response — page may have changed structure');
  return { content: [{ type: 'text', text: text.trim() }] };
}

// ─── Generic Web Adapter (for custom providers) ───────────────────────────────
// A configurable adapter that works for any chat UI following a
// type-in-box, press-enter, wait-for-response pattern.

function createGenericAdapter(provider, {
  inputSelector,
  sendSelector,       // optional — falls back to Enter
  responseSelector,
  loadingSelector,    // presence = loading, absence = done
  useEnter = true,
}) {
  return {
    provider,
    async send({ accountId, messages, timeoutMs = 120_000 }) {
      const cfg     = getProviderConfig(provider);
      const context = await getContext(provider, accountId);
      const page    = await context.newPage();

      try {
        await page.goto(cfg.loginUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
        await page.waitForSelector(inputSelector, { timeout: 15_000 });

        const prompt = formatMessages(messages, provider);
        await humanType(page, inputSelector, prompt);
        await page.waitForTimeout(200 + Math.random() * 300);

        if (sendSelector) {
          const btn = await page.$(sendSelector);
          if (btn) await btn.click();
          else if (useEnter) await page.keyboard.press('Enter');
        } else if (useEnter) {
          await page.keyboard.press('Enter');
        }

        // Wait for loading to appear then disappear
        if (loadingSelector) {
          await page.waitForSelector(loadingSelector, { timeout: 10_000 }).catch(() => {});
          await page.waitForFunction(
            (sel) => !document.querySelector(sel),
            loadingSelector,
            { timeout: timeoutMs, polling: 500 }
          );
        } else {
          await page.waitForTimeout(3000); // dumb fallback
        }

        const text = await page.evaluate((sel) => {
          const nodes = document.querySelectorAll(sel);
          if (!nodes.length) return '';
          return nodes[nodes.length - 1].innerText || '';
        }, responseSelector);

        await markActive(provider, accountId);
        return { content: [{ type: 'text', text: (text || '').trim() }] };

      } finally {
        await page.close().catch(() => {});
      }
    }
  };
}

// ─── Adapter Registry ─────────────────────────────────────────────────────────

const ADAPTERS = {
  claude:  ClaudeAdapter,
  chatgpt: ChatGPTAdapter,
  gemini:  GeminiAdapter,
};

function registerAdapter(providerId, adapter) {
  if (!adapter?.send) throw new Error(`Adapter for "${providerId}" must have a send(opts) method`);
  ADAPTERS[providerId] = adapter;
  console.log(`[Adapters] Registered adapter: ${providerId}`);
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
  ADAPTERS,
  registerAdapter,
  createGenericAdapter,
  getContext,
  closeContext,
  closeAllContexts,
  humanType,
  formatMessages,
  withTimeout,
};
