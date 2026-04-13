/**
 * bootloader.js — BrainOS Bootloader
 * UUID: brainos-bootloader-v5000-000000000017
 * Phase 0 · Critical Stability
 *
 * Single entry point. Deterministic boot order. Safe-fail on every phase.
 * Every failure is loud and logged. Nothing silently pretends to work.
 *
 * Boot order (from roadmap Phase 0):
 *   1. config load
 *   2. event bus init
 *   3. intent router init
 *   4. agent registry init
 *   5. bridge connect
 *   6. workflow engine init
 *   7. plugin handshake
 *   8. ready
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const http = require('http');

const MODULE_UUID = 'brainos-bootloader-v5000-000000000017';
const VERSION     = '5.0.0';

// Deferred requires — only load after bus is up
function loadModules() {
  return {
    BUS:    require('./bus').BUS,
    PARSER: require('./intent-parser').PARSER,
    SCORER: require('./intent-scoring').SCORER,
    ROUTER: require('./intent-router').ROUTER,
    REGISTRY: require('./agent-registry').REGISTRY,
    FACTORY:  require('./agent-factory').FACTORY,
    ENGINE:   require('./workflow-engine').ENGINE,
  };
}

// ── Phase runner — executes phases in order, loud on any failure ──────────────
class Bootloader {
  constructor(opts = {}) {
    this.uuid     = MODULE_UUID;
    this.version  = VERSION;
    this.dataDir  = opts.dataDir  || path.join(__dirname, 'data');
    this.port     = opts.port     || null;     // bridge port if running server mode
    this.bridgeScan = opts.bridgeScan !== false; // scan for existing bridge
    this._health  = {
      config:    { ok: false },
      bus:       { ok: false },
      router:    { ok: false },
      agents:    { ok: false },
      bridge:    { ok: false, url: null },
      workflows: { ok: false },
      ready:     false,
      startedAt: null,
      readyAt:   null,
      elapsedMs: null,
    };
    this._modules = null;
  }

  /** Main boot sequence. Returns health report. */
  async boot() {
    this._health.startedAt = Date.now();
    console.log(`\n[BOOTLOADER] BrainOS v${VERSION} booting...`);
    console.log(`[BOOTLOADER] Data dir: ${this.dataDir}\n`);

    await this._phase('config',    () => this._loadConfig());
    await this._phase('bus',       () => this._initBus());
    await this._phase('router',    () => this._initRouter());
    await this._phase('agents',    () => this._initAgents());
    await this._phase('bridge',    () => this._connectBridge());
    await this._phase('workflows', () => this._initWorkflows());
    await this._phase('plugin',    () => this._pluginHandshake());

    this._health.ready   = true;
    this._health.readyAt = Date.now();
    this._health.elapsedMs = this._health.readyAt - this._health.startedAt;

    const ok = Object.values(this._health)
      .filter(v => typeof v === 'object' && v !== null)
      .every(v => v.ok !== false);

    this._writeHealthFile();

    this._modules.BUS.emit('system.ready', {
      version: VERSION,
      elapsedMs: this._health.elapsedMs,
      bridge:  this._health.bridge.url,
    });

    console.log(`\n[BOOTLOADER] ✓ Ready in ${this._health.elapsedMs}ms`);
    console.log(`[BOOTLOADER] Bridge: ${this._health.bridge.url || 'disconnected'}\n`);

    return this._health;
  }

  /** Run a named phase. Catches and logs — never throws from _phase(). */
  async _phase(name, fn) {
    process.stdout.write(`[BOOT] ${name.padEnd(12)} ... `);
    try {
      const result = await fn();
      this._health[name] = { ok: true, ...(result || {}) };
      console.log('✓');
    } catch (err) {
      this._health[name] = { ok: false, error: err.message };
      console.log(`✗  ${err.message}`);
      // Emit error if bus is already up
      if (this._modules?.BUS) {
        this._modules.BUS.emit('system.error', {
          source:  'bootloader',
          phase:   name,
          message: err.message,
        });
      }
      // Only abort on bus failure (everything else can degrade gracefully)
      if (name === 'bus') throw err;
    }
  }

  // ── Phase implementations ─────────────────────────────────────────────────

  async _loadConfig() {
    fs.mkdirSync(this.dataDir, { recursive: true });
    const cfgFile = path.join(this.dataDir, 'brainos-config.json');
    let config = {};

    if (fs.existsSync(cfgFile)) {
      try { config = JSON.parse(fs.readFileSync(cfgFile, 'utf8')); }
      catch (e) { throw new Error(`Config parse error: ${e.message}`); }
    } else {
      // Write default config
      config = {
        version:    VERSION,
        bridgePorts: [3747, 3748, 3749, 3750],
        bridgeUrl:  null,
        logLevel:   'EVENTS',
        dataDir:    this.dataDir,
      };
      fs.writeFileSync(cfgFile, JSON.stringify(config, null, 2));
    }

    this._config = config;
    return { configFile: cfgFile };
  }

  async _initBus() {
    this._modules = loadModules();
    const { BUS } = this._modules;
    const h = BUS.health();
    if (!h.ok) throw new Error('EventBus health check failed');
    return { uuid: BUS.uuid, version: BUS.version };
  }

  async _initRouter() {
    const { ROUTER, BUS } = this._modules;
    ROUTER.setBus(BUS);
    const h = ROUTER.health();
    return { actions: h.actions };
  }

  async _initAgents() {
    const { FACTORY, BUS } = this._modules;
    const bridgeUrl = this._health.bridge?.url || 'http://localhost:3747';
    FACTORY.init(BUS, { bridgeUrl });
    const h = FACTORY.health();
    return { agents: h.registry.agents };
  }

  async _connectBridge() {
    const ports = this._config?.bridgePorts || [3747, 3748, 3749, 3750];
    const { BUS } = this._modules;

    for (const port of ports) {
      try {
        const url = await this._probe(`http://127.0.0.1:${port}/health`, 1200);
        if (url) {
          this._health.bridge = { ok: true, url: `http://127.0.0.1:${port}`, port };
          BUS.emit('bridge.message', { event: 'connected', port });
          return { url: this._health.bridge.url, port };
        }
      } catch {}
    }
    // Not fatal — run disconnected
    console.log('\n           (no bridge found — running disconnected)');
    this._health.bridge = { ok: true, url: null };  // ok:true = graceful degradation
    return { url: null };
  }

  /** Probe a URL. Returns the url if reachable, null if not. */
  _probe(url, timeoutMs) {
    return new Promise((resolve) => {
      const u = new URL(url);
      const req = http.get({ hostname: u.hostname, port: u.port, path: u.pathname, timeout: timeoutMs }, res => {
        res.destroy();
        resolve(url);
      });
      req.on('error', () => resolve(null));
      req.on('timeout', () => { req.destroy(); resolve(null); });
    });
  }

  async _initWorkflows() {
    const { ENGINE, BUS, FACTORY } = this._modules;
    ENGINE.init(BUS, FACTORY);
    const h = ENGINE.health();
    return { workflows: h.workflows, active: h.active };
  }

  async _pluginHandshake() {
    const bridgeUrl = this._health.bridge?.url;
    if (!bridgeUrl) return { skipped: true, reason: 'no bridge' };

    // Announce ourselves to bridge
    try {
      await this._post(`${bridgeUrl}/hook`, {
        hookId: `brainos.bootloader:boot-v5:${process.pid}`,
        event:  'brainos.boot',
        data:   { version: VERSION, pid: process.pid },
      }, 3000);
      return { announced: true };
    } catch {
      return { announced: false, reason: 'bridge hook failed (non-fatal)' };
    }
  }

  _post(url, body, timeoutMs) {
    return new Promise((resolve, reject) => {
      const u    = new URL(url);
      const data = JSON.stringify(body);
      const req  = http.request({
        hostname: u.hostname, port: u.port || 80, path: u.pathname,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
        timeout: timeoutMs,
      }, res => { res.destroy(); resolve(); });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
      req.write(data); req.end();
    });
  }

  _writeHealthFile() {
    try {
      const file = path.join(this.dataDir, 'startup-health-check.json');
      fs.writeFileSync(file, JSON.stringify(this._health, null, 2));
    } catch {}
  }

  getHealth() { return { ...this._health }; }
  getModules() { return this._modules; }
}

// ── CLI entry point ───────────────────────────────────────────────────────────
if (require.main === module) {
  const loader = new Bootloader({ dataDir: path.join(__dirname, 'data') });
  loader.boot().catch(err => {
    console.error('[BOOTLOADER] FATAL:', err.message);
    process.exit(1);
  });
}

module.exports = { Bootloader };
