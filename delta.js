/**
 * NEXUS Delta Logger v2.1
 *
 * Fixes applied:
 *   [23] sq() escapes newlines, tabs, null bytes, unicode — JAA parser safe
 *   [24] jsonAppend uses O(1) line counter file — no full read for rotation
 *   [25] configure() only resets affected DB connections
 *   [26] notionRequest has 10s timeout
 *   [27] discordPost retries on 429 with Retry-After header
 */

'use strict';

const fs      = require('fs');
const path    = require('path');
const https   = require('https');
const { URL } = require('url');

// ─── Config ───────────────────────────────────────────────────────────────────

let CONFIG = {
  jaa: {
    enabled:     false,
    dir:         path.join(__dirname, 'jaa-db'),
    requirePath: null,
  },
  sqlite: {
    enabled: true,
    dbPath:  path.join(__dirname, 'data', 'nexus.db'),
  },
  obsidian: {
    enabled:     false,
    vaultPath:   null,
    folder:      'NEXUS/Deltas',
    ideaFolder:  'NEXUS/Ideas',
    dailyNotes:  true,
    dailyFolder: 'NEXUS/Daily',
  },
  notion: {
    enabled:       false,
    apiKey:        null,
    deltaDatabase: null,
    ideaDatabase:  null,
    version:       '2022-06-28',
    timeoutMs:     10_000,        // Fix #26
  },
  discord: {
    enabled:      false,
    deltaWebhook: null,
    ideaWebhook:  null,
    errorWebhook: null,
    onlyFailures: false,
    maxRetries:   3,              // Fix #27
  },
  json: {
    enabled:  true,
    logPath:  path.join(__dirname, 'data', 'delta-log.jsonl'),
    maxLines: 10_000,
  },
};

// ─── Custom Project Hook Registry ────────────────────────────────────────────

const PROJECT_HOOKS = new Map();

function registerHook(name, fn) {
  if (typeof fn !== 'function') throw new Error(`Hook "${name}" must be a function`);
  if (!PROJECT_HOOKS.has(name)) PROJECT_HOOKS.set(name, []);
  PROJECT_HOOKS.get(name).push(fn);
}

function unregisterHook(name) { PROJECT_HOOKS.delete(name); }

async function fireHooks(event) {
  const jobs = [];
  for (const [name, fns] of PROJECT_HOOKS)
    for (const fn of fns)
      jobs.push(fn(event).catch(e => console.warn(`[Delta] Hook "${name}":`, e.message)));
  await Promise.allSettled(jobs);
}

// ─── SQL Helpers (Fix #23) ────────────────────────────────────────────────────
// Full escaping: single quotes, newlines, carriage returns, tabs, null bytes.
// JAA's parser is robust but feeding raw AI output with these chars breaks things.

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/\\/g,  '\\\\')   // backslash first
    .replace(/'/g,   "''")     // SQL single-quote escape
    .replace(/\r/g,  '\\r')    // carriage return
    .replace(/\n/g,  '\\n')    // newline
    .replace(/\t/g,  '\\t')    // tab
    .replace(/\0/g,  '')       // strip null bytes entirely
    .replace(/[\x01-\x1f\x7f]/g, ''); // strip other control chars
}

function sq(v) {
  if (v == null) return 'NULL';
  return `'${esc(v)}'`;
}

function sqJson(v) {
  return sq(JSON.stringify(v));
}

// ─── JAA Adapter ─────────────────────────────────────────────────────────────

let _jaa = null;

function getJaa() {
  if (!CONFIG.jaa.enabled) return null;
  if (_jaa) return _jaa;

  let JaaClass;
  const paths = [
    'jaa',
    CONFIG.jaa.requirePath,
    '../jaa/src/jaa',
    path.join(__dirname, '../jaa/src/jaa'),
  ].filter(Boolean);

  for (const p of paths) {
    try { JaaClass = require(p); break; } catch { /* try next */ }
  }

  if (!JaaClass) {
    console.warn('[Delta] JAA not found — falling back to SQLite\n  To enable: npm install siso-ai/jaa');
    return null;
  }

  const opts = CONFIG.jaa.dir ? { dir: CONFIG.jaa.dir } : {};
  _jaa = new JaaClass(opts);

  try {
    _jaa.query(`
      CREATE TABLE IF NOT EXISTS deltas (
        id INTEGER, ts INTEGER NOT NULL, provider TEXT NOT NULL, account_id TEXT NOT NULL,
        success INTEGER NOT NULL, latency_ms INTEGER DEFAULT 0,
        error TEXT, error_type TEXT, input_json TEXT, output_json TEXT,
        idea_id TEXT, tags TEXT, synthesis TEXT,
        attempt_number INTEGER DEFAULT 1, chain_length INTEGER DEFAULT 1
      )`);
    _jaa.query(`
      CREATE TABLE IF NOT EXISTS ideas (
        id TEXT NOT NULL, ts INTEGER NOT NULL, title TEXT, body TEXT,
        provider TEXT, account_id TEXT, tags TEXT, linked_chat TEXT, delta_ids TEXT
      )`);
    for (const idx of [
      'CREATE INDEX IF NOT EXISTS idx_d_ts  ON deltas(ts)',
      'CREATE INDEX IF NOT EXISTS idx_d_p   ON deltas(provider)',
      'CREATE INDEX IF NOT EXISTS idx_d_ok  ON deltas(success)',
      'CREATE INDEX IF NOT EXISTS idx_i_ts  ON ideas(ts)',
    ]) _jaa.query(idx);
  } catch(e) { console.warn('[Delta] JAA schema error:', e.message); }

  console.log(`[Delta] JAA ready — ${CONFIG.jaa.dir || 'in-memory'}`);
  return _jaa;
}

function jaaQuery(sql) {
  const j = getJaa();
  if (!j) return null;
  try { return j.query(sql)?.rows || []; }
  catch(e) { console.warn('[Delta] JAA query error:', e.message); return null; }
}

function jaaInsert(d, ts) {
  const j = getJaa();
  if (!j) return null;
  try {
    return j.query(
      `INSERT INTO deltas (ts,provider,account_id,success,latency_ms,error,error_type,
       input_json,output_json,idea_id,tags,synthesis,attempt_number,chain_length)
       VALUES (${ts},${sq(d.provider)},${sq(d.accountId)},${d.success?1:0},${d.latency||0},
       ${sq(d.error)},${sq(d.errorType)},${sqJson(d.input||[])},${sqJson(d.output||null)},
       ${sq(d.ideaId)},${sqJson(d.tags||[])},${sq(d.synthesis)},
       ${d.attemptNumber||1},${d.fallbackChainLength||1}) RETURNING id`
    )?.rows?.[0]?.id ?? null;
  } catch(e) { console.warn('[Delta] JAA insert:', e.message); return null; }
}

function jaaInsertIdea(d, ts, id) {
  const j = getJaa();
  if (!j) return;
  try {
    j.query(
      `INSERT INTO ideas (id,ts,title,body,provider,account_id,tags,linked_chat,delta_ids)
       VALUES (${sq(id)},${ts},${sq(d.title)},${sq(d.body)},${sq(d.provider)},${sq(d.accountId)},
       ${sqJson(d.tags||[])},${sq(d.linkedChat)},${sqJson(d.deltaIds||[])})
       ON CONFLICT DO UPDATE SET title=${sq(d.title)},body=${sq(d.body)},
       tags=${sqJson(d.tags||[])},linked_chat=${sq(d.linkedChat)},delta_ids=${sqJson(d.deltaIds||[])}`
    );
  } catch(e) { console.warn('[Delta] JAA idea:', e.message); }
}

// ─── SQLite Adapter ───────────────────────────────────────────────────────────

let _sqlite = null;

function getSQLite() {
  if (!CONFIG.sqlite.enabled) return null;
  if (_sqlite) return _sqlite;
  let Db;
  try { Db = require('better-sqlite3'); }
  catch { console.warn('[Delta] better-sqlite3 not available'); return null; }
  fs.mkdirSync(path.dirname(CONFIG.sqlite.dbPath), { recursive: true });
  _sqlite = new Db(CONFIG.sqlite.dbPath);
  _sqlite.exec(`
    CREATE TABLE IF NOT EXISTS deltas (
      id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL,
      provider TEXT NOT NULL, account_id TEXT NOT NULL, success INTEGER NOT NULL,
      latency_ms INTEGER DEFAULT 0, error TEXT, error_type TEXT,
      input_json TEXT, output_json TEXT, idea_id TEXT, tags TEXT, synthesis TEXT,
      attempt_number INTEGER DEFAULT 1, chain_length INTEGER DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS ideas (
      id TEXT PRIMARY KEY, ts INTEGER NOT NULL, title TEXT, body TEXT,
      provider TEXT, account_id TEXT, tags TEXT, linked_chat TEXT, delta_ids TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_d_ts  ON deltas(ts);
    CREATE INDEX IF NOT EXISTS idx_d_p   ON deltas(provider);
    CREATE INDEX IF NOT EXISTS idx_d_ok  ON deltas(success);
    CREATE INDEX IF NOT EXISTS idx_i_ts  ON ideas(ts);
  `);
  return _sqlite;
}

function sqliteInsert(d, ts) {
  const db = getSQLite();
  if (!db) return null;
  try {
    return db.prepare(`
      INSERT INTO deltas (ts,provider,account_id,success,latency_ms,error,error_type,
        input_json,output_json,idea_id,tags,synthesis,attempt_number,chain_length)
      VALUES (@ts,@provider,@account_id,@success,@latency_ms,@error,@error_type,
        @input_json,@output_json,@idea_id,@tags,@synthesis,@attempt_number,@chain_length)
    `).run({
      ts, provider:d.provider, account_id:d.accountId,
      success:d.success?1:0, latency_ms:d.latency||0,
      error:d.error||null, error_type:d.errorType||null,
      input_json:JSON.stringify(d.input||[]),
      output_json:JSON.stringify(d.output||null),
      idea_id:d.ideaId||null, tags:JSON.stringify(d.tags||[]),
      synthesis:d.synthesis||null,
      attempt_number:d.attemptNumber||1, chain_length:d.fallbackChainLength||1,
    }).lastInsertRowid;
  } catch(e) { console.warn('[Delta] SQLite insert:', e.message); return null; }
}

function sqliteInsertIdea(d, ts, ideaId) {
  const db = getSQLite();
  if (!db) return;
  try {
    db.prepare(`
      INSERT OR REPLACE INTO ideas (id,ts,title,body,provider,account_id,tags,linked_chat,delta_ids)
      VALUES (@id,@ts,@title,@body,@provider,@account_id,@tags,@linked_chat,@delta_ids)
    `).run({
      id:ideaId, ts, title:d.title||'', body:d.body||'',
      provider:d.provider||'', account_id:d.accountId||'',
      tags:JSON.stringify(d.tags||[]),
      linked_chat:d.linkedChat||null,
      delta_ids:JSON.stringify(d.deltaIds||[]),
    });
  } catch(e) { console.warn('[Delta] SQLite idea:', e.message); }
}

// ─── JSON Flat File (Fix #24) ─────────────────────────────────────────────────
// O(1) rotation via a separate .count file — never reads the full log.

function jsonAppend(record) {
  if (!CONFIG.json.enabled) return;
  try {
    const logPath   = CONFIG.json.logPath;
    const cntPath   = logPath + '.count';
    fs.mkdirSync(path.dirname(logPath), { recursive: true });

    // Read current line count (O(1))
    let count = 0;
    try { count = parseInt(fs.readFileSync(cntPath, 'utf8') || '0'); } catch { count = 0; }

    if (count >= CONFIG.json.maxLines) {
      // Rotate: rename current log, reset counter
      fs.renameSync(logPath, logPath.replace('.jsonl', `-${Date.now()}.jsonl`));
      count = 0;
    }

    fs.appendFileSync(logPath, JSON.stringify(record) + '\n');
    fs.writeFileSync(cntPath, String(count + 1));  // O(1) write
  } catch(e) { console.warn('[Delta] JSON log error:', e.message); }
}

// ─── Obsidian Target ──────────────────────────────────────────────────────────

function slug(s='') { return s.replace(/[^a-z0-9\-_]/gi,'-').replace(/-+/g,'-').slice(0,80); }

function obsidianWriteDelta(id, d, ts) {
  if (!CONFIG.obsidian.enabled || !CONFIG.obsidian.vaultPath) return;
  const date  = new Date(ts).toISOString().slice(0,10);
  const time  = new Date(ts).toISOString().slice(11,19);
  const dir   = path.join(CONFIG.obsidian.vaultPath, CONFIG.obsidian.folder);
  const fname = `${date}-${slug(d.provider)}-${id}.md`;
  fs.mkdirSync(dir, { recursive: true });

  const inputText  = Array.isArray(d.input) ? d.input.map(m=>`**${m.role}:** ${m.content}`).join('\n\n') : String(d.input||'');
  const outputText = d.output?.content?.[0]?.text || d.error || '_no output_';

  fs.writeFileSync(path.join(dir, fname), [
    `---`,
    `id: ${id}`,
    `date: ${date}`,
    `provider: ${d.provider}`,
    `account: ${d.accountId}`,
    `success: ${d.success}`,
    `latency_ms: ${d.latency||0}`,
    `tags: [${(d.tags||[]).map(t=>`"${t}"`).join(', ')}]`,
    `---`, ``,
    `# Delta — ${id}`,``,
    `| | |`,`|---|---|`,
    `| Date | ${date} ${time} |`,
    `| Provider | \`${d.provider}/${d.accountId}\` |`,
    `| Status | ${d.success ? '✅ Success' : '❌ Failed'} |`,
    `| Latency | ${d.latency||0}ms |`,
    `| Attempt | ${d.attemptNumber||1} / ${d.fallbackChainLength||1} |`,
    d.ideaId ? `| Idea | [[${d.ideaId}]] |` : '',
    ``, `## Input`, ``, inputText,
    ``, `## Output`, ``, outputText,
    d.synthesis ? `\n## Synthesis\n\n${d.synthesis}` : '',
    d.error     ? `\n## Error\n\n\`\`\`\n${d.error}\n\`\`\`` : '',
    ``, `---`, `*NEXUS Delta Logger*`,
  ].filter(s => s !== null).join('\n'), 'utf8');

  if (CONFIG.obsidian.dailyNotes) {
    const ddir = path.join(CONFIG.obsidian.vaultPath, CONFIG.obsidian.dailyFolder);
    fs.mkdirSync(ddir, { recursive: true });
    fs.appendFileSync(
      path.join(ddir, `${date}.md`),
      `\n- [[${fname.replace('.md','')}]] — \`${d.provider}/${d.accountId}\` ${d.success?'✅':'❌'} ${d.latency||0}ms\n`
    );
  }
}

function obsidianWriteIdea(ideaId, d, ts) {
  if (!CONFIG.obsidian.enabled || !CONFIG.obsidian.vaultPath) return;
  const date  = new Date(ts).toISOString().slice(0,10);
  const dir   = path.join(CONFIG.obsidian.vaultPath, CONFIG.obsidian.ideaFolder);
  const fname = `${date}-${slug(d.title||ideaId)}.md`;
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, fname), [
    `---`,
    `id: ${ideaId}`,
    `date: ${date}`,
    `provider: ${d.provider||''}`,
    `linked_chat: ${d.linkedChat||''}`,
    `tags: [${(d.tags||[]).map(t=>`"${t}"`).join(', ')}]`,
    `---`, ``,
    `# ${d.title || 'Untitled Idea'}`, ``,
    d.body || '',
    ``, `## Linked Deltas`, ``,
    (d.deltaIds||[]).length ? d.deltaIds.map(x=>`- [[${x}]]`).join('\n') : '_none_',
    ``, `---`, `*NEXUS Idea Tracker*`,
  ].join('\n'), 'utf8');
}

// ─── Notion Target (Fix #26) ─────────────────────────────────────────────────

function notionPost(endpoint, body) {
  const cfg  = CONFIG.notion;
  const data = JSON.stringify(body);
  const u    = new URL(`https://api.notion.com/v1/${endpoint}`);

  return new Promise((resolve, reject) => {
    // Fix #26: timeout
    const timer = setTimeout(() => {
      req.destroy();
      reject(new Error(`Notion API timeout after ${cfg.timeoutMs}ms`));
    }, cfg.timeoutMs);

    const req = https.request({
      hostname: u.hostname, path: u.pathname,
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${cfg.apiKey}`,
        'Notion-Version': cfg.version,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
      },
    }, res => {
      clearTimeout(timer);
      let out = '';
      res.on('data', c => out += c);
      res.on('end', () => { try { resolve(JSON.parse(out||'{}')); } catch { resolve(out); } });
    });

    req.on('error', e => { clearTimeout(timer); reject(e); });
    req.write(data);
    req.end();
  });
}

async function notionLogDelta(id, d, ts) {
  const cfg = CONFIG.notion;
  if (!cfg.enabled || !cfg.apiKey || !cfg.deltaDatabase) return;
  try {
    await notionPost('pages', {
      parent: { database_id: cfg.deltaDatabase },
      properties: {
        'ID':       { title:      [{ text: { content: id } }] },
        'Provider': { select:     { name: d.provider } },
        'Account':  { rich_text:  [{ text: { content: d.accountId||'' } }] },
        'Success':  { checkbox:   !!d.success },
        'Latency':  { number:     d.latency||0 },
        'Error':    { rich_text:  [{ text: { content: (d.error||'').slice(0,2000) } }] },
        'Tags':     { multi_select: (d.tags||[]).map(t=>({ name: t })) },
        'Date':     { date:       { start: new Date(ts).toISOString() } },
        'Idea ID':  { rich_text:  [{ text: { content: d.ideaId||'' } }] },
      },
    });
  } catch(e) { console.warn('[Delta] Notion delta:', e.message); }
}

async function notionLogIdea(ideaId, d, ts) {
  const cfg = CONFIG.notion;
  if (!cfg.enabled || !cfg.apiKey || !cfg.ideaDatabase) return;
  try {
    await notionPost('pages', {
      parent: { database_id: cfg.ideaDatabase },
      properties: {
        'ID':       { title:      [{ text: { content: ideaId } }] },
        'Title':    { rich_text:  [{ text: { content: (d.title||'').slice(0,2000) } }] },
        'Provider': { select:     { name: d.provider||'unknown' } },
        'Tags':     { multi_select: (d.tags||[]).map(t=>({ name: t })) },
        'Chat':     { url: d.linkedChat || null },
        'Date':     { date: { start: new Date(ts).toISOString() } },
      },
    });
  } catch(e) { console.warn('[Delta] Notion idea:', e.message); }
}

// ─── Discord Target (Fix #27) ─────────────────────────────────────────────────

function discordPost(webhookUrl, body, retryCount = 0) {
  const cfg  = CONFIG.discord;
  const data = JSON.stringify(body);
  const u    = new URL(webhookUrl);

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: u.hostname, path: u.pathname + u.search,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
    }, res => {
      res.resume();

      // Fix #27: retry on 429 with Retry-After
      if (res.statusCode === 429 && retryCount < (cfg.maxRetries || 3)) {
        const retryAfter = parseFloat(res.headers['retry-after'] || '1') * 1000;
        console.warn(`[Delta] Discord 429 — retry in ${retryAfter}ms (attempt ${retryCount + 1})`);
        setTimeout(() => {
          discordPost(webhookUrl, body, retryCount + 1).then(resolve).catch(reject);
        }, retryAfter);
        return;
      }

      resolve(res.statusCode);
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

async function discordLogDelta(id, d) {
  const cfg = CONFIG.discord;
  if (!cfg.enabled) return;
  if (cfg.onlyFailures && d.success) return;
  const wh = (!d.success && cfg.errorWebhook) ? cfg.errorWebhook : cfg.deltaWebhook;
  if (!wh) return;

  const inputSnip  = (Array.isArray(d.input) ? d.input.at(-1)?.content||'' : '').slice(0,200);
  const outputSnip = (d.output?.content?.[0]?.text || d.error || '').slice(0,300);

  try {
    await discordPost(wh, { embeds: [{
      title: `${d.success?'✅':'❌'} ${d.provider}/${d.accountId}`,
      color: d.success ? 0x22c55e : 0xef4444,
      description: d.error ? `\`${d.error.slice(0,300)}\`` : undefined,
      fields: [
        { name:'ID',      value:`\`${id}\``,                                        inline:true },
        { name:'Latency', value:`${d.latency||0}ms`,                                inline:true },
        { name:'Attempt', value:`${d.attemptNumber||1}/${d.fallbackChainLength||1}`,inline:true },
        inputSnip  ? { name:'Input',  value:inputSnip,  inline:false } : null,
        outputSnip ? { name:'Output', value:outputSnip, inline:false } : null,
        (d.tags||[]).length ? { name:'Tags', value:d.tags.join(', '), inline:true } : null,
      ].filter(Boolean),
      timestamp: new Date().toISOString(),
      footer: { text: 'NEXUS Delta Logger' },
    }]});
  } catch(e) { console.warn('[Delta] Discord delta:', e.message); }
}

async function discordLogIdea(ideaId, d) {
  const cfg = CONFIG.discord;
  if (!cfg.enabled) return;
  const wh = cfg.ideaWebhook || cfg.deltaWebhook;
  if (!wh) return;
  try {
    await discordPost(wh, { embeds: [{
      title: `💡 ${d.title||ideaId}`,
      color: 0x6366f1,
      fields: [
        { name:'ID',       value:`\`${ideaId}\``,          inline:true },
        { name:'Provider', value:d.provider||'unknown',    inline:true },
        d.linkedChat ? { name:'Chat', value:d.linkedChat,  inline:false } : null,
        d.body       ? { name:'Body', value:d.body.slice(0,500), inline:false } : null,
        (d.tags||[]).length ? { name:'Tags', value:d.tags.join(', '), inline:true } : null,
      ].filter(Boolean),
      timestamp: new Date().toISOString(),
      footer: { text: 'NEXUS Idea Tracker' },
    }]});
  } catch(e) { console.warn('[Delta] Discord idea:', e.message); }
}

// ─── Core Delta API ───────────────────────────────────────────────────────────

function makeId(prefix='d') {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2,6)}`;
}

const Delta = {

  configure(cfg) {
    const prev = CONFIG;
    CONFIG = deepMerge(CONFIG, cfg);

    // Fix #25: only reset connections that were actually affected
    if (cfg.jaa    && JSON.stringify(cfg.jaa)    !== JSON.stringify(prev.jaa))    { _jaa    = null; }
    if (cfg.sqlite && JSON.stringify(cfg.sqlite) !== JSON.stringify(prev.sqlite)) { _sqlite = null; }

    const enabled = Object.keys(cfg).filter(k => cfg[k]?.enabled).join(', ');
    if (enabled) console.log('[Delta] Targets enabled:', enabled);
  },

  async log(data) {
    const ts = Date.now();
    const id = makeId('d');
    const ev = { id, ts, type: 'delta', ...data };

    await Promise.allSettled([
      Promise.resolve().then(() => jaaInsert(data, ts)),
      Promise.resolve().then(() => sqliteInsert(data, ts)),
      Promise.resolve().then(() => obsidianWriteDelta(id, data, ts)),
      notionLogDelta(id, data, ts),
      discordLogDelta(id, data),
      Promise.resolve().then(() => jsonAppend(ev)),
      fireHooks(ev),
    ]);

    return id;
  },

  async logIdea(data) {
    const ts     = Date.now();
    const ideaId = data.id || makeId('idea');
    const ev     = { id: ideaId, ts, type: 'idea', ...data };

    await Promise.allSettled([
      Promise.resolve().then(() => jaaInsertIdea(data, ts, ideaId)),
      Promise.resolve().then(() => sqliteInsertIdea(data, ts, ideaId)),
      Promise.resolve().then(() => obsidianWriteIdea(ideaId, data, ts)),
      notionLogIdea(ideaId, data, ts),
      discordLogIdea(ideaId, data),
      Promise.resolve().then(() => jsonAppend(ev)),
      fireHooks(ev),
    ]);

    return ideaId;
  },

  recent(limit = 20) {
    const r = jaaQuery(`SELECT * FROM deltas ORDER BY ts DESC LIMIT ${limit}`);
    if (r !== null) return r;
    const db = getSQLite();
    return db ? db.prepare('SELECT * FROM deltas ORDER BY ts DESC LIMIT ?').all(limit) : [];
  },

  stats() {
    const sql = `SELECT provider, account_id,
      COUNT(*) AS total, SUM(success) AS successes,
      ROUND(AVG(latency_ms),0) AS avg_latency_ms, MAX(ts) AS last_used
      FROM deltas GROUP BY provider, account_id ORDER BY successes DESC`;
    const r = jaaQuery(sql);
    if (r !== null) return r;
    const db = getSQLite();
    return db ? db.prepare(sql).all() : [];
  },

  failures(limit = 50) {
    const sql = `SELECT provider,account_id,error_type,COUNT(*) AS count
      FROM deltas WHERE success=0
      GROUP BY provider,account_id,error_type ORDER BY count DESC LIMIT ${limit}`;
    const r = jaaQuery(sql);
    if (r !== null) return r;
    const db = getSQLite();
    return db ? db.prepare(sql.replace(`LIMIT ${limit}`,'LIMIT ?')).all(limit) : [];
  },

  ideas(limit = 50) {
    const r = jaaQuery(`SELECT * FROM ideas ORDER BY ts DESC LIMIT ${limit}`);
    if (r !== null) return r;
    const db = getSQLite();
    return db ? db.prepare('SELECT * FROM ideas ORDER BY ts DESC LIMIT ?').all(limit) : [];
  },

  query(sql) {
    const r = jaaQuery(sql);
    if (r !== null) return r;
    const db = getSQLite();
    if (!db) throw new Error('No SQL backend. Enable jaa or sqlite in Delta.configure().');
    return db.prepare(sql).all();
  },

  on:  registerHook,
  off: unregisterHook,
};

// ─── Utilities ────────────────────────────────────────────────────────────────

function deepMerge(t, s) {
  const o = { ...t };
  for (const k of Object.keys(s||{})) {
    o[k] = (s[k] && typeof s[k]==='object' && !Array.isArray(s[k]))
      ? deepMerge(t[k]||{}, s[k])
      : s[k];
  }
  return o;
}

module.exports = { Delta, registerHook, unregisterHook };
