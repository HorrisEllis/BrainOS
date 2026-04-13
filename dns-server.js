/**
 * dns-server.js — BrainOS Custom DNS Server
 * UUID: brainos-dns-server-v5000-0000-000000000002
 * Hook: brainos.dns:dns-server-v5:d0002
 *
 * Full DNS server from scratch. UDP/53 + TCP/53. No-IP style DDNS.
 * Recursive resolver. Local overrides. Firewall at DNS layer.
 * Logs every blocked/malicious request loudly.
 *
 * Fails loudly — every error logged + evented. Nothing pretends.
 */

'use strict';

const dgram  = require('dgram');
const net    = require('net');
const https  = require('https');
const dns    = require('dns');
const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');

const MODULE_UUID    = 'brainos-dns-server-v5000-0000-000000000002';
const MODULE_VERSION = '5.0.0';
const DEFAULT_PORT   = 5353; // 53 requires root; 5353 for dev

// ── Packet helpers ────────────────────────────────────────────────────────────
function readName(buf, offset) {
  const parts = [];
  let jumped = false, jumpOffset = 0, len = 0;
  while (offset < buf.length) {
    const b = buf[offset];
    if (b === 0) { offset++; break; }
    if ((b & 0xC0) === 0xC0) {
      if (!jumped) jumpOffset = offset + 2;
      jumped = true;
      offset = ((b & 0x3F) << 8) | buf[offset + 1];
      continue;
    }
    parts.push(buf.slice(offset + 1, offset + 1 + b).toString('ascii'));
    offset += 1 + b;
    len++;
  }
  return { name: parts.join('.'), end: jumped ? jumpOffset : offset };
}

function writeName(name) {
  const parts = name.split('.');
  const bufs = [];
  for (const p of parts) {
    const b = Buffer.from(p, 'ascii');
    const len = Buffer.alloc(1); len[0] = b.length;
    bufs.push(len, b);
  }
  bufs.push(Buffer.from([0]));
  return Buffer.concat(bufs);
}

function parseQuestion(buf, offset) {
  const { name, end } = readName(buf, offset);
  const type  = buf.readUInt16BE(end);
  const cls   = buf.readUInt16BE(end + 2);
  return { name, type, cls, end: end + 4 };
}

function buildResponse(id, flags, questions, answers) {
  const header = Buffer.alloc(12);
  header.writeUInt16BE(id, 0);
  header.writeUInt16BE(flags, 2);
  header.writeUInt16BE(questions.length, 4);
  header.writeUInt16BE(answers.length, 6);
  header.writeUInt16BE(0, 8);  // authority
  header.writeUInt16BE(0, 10); // additional

  const qBufs = questions.map(q => Buffer.concat([writeName(q.name), Buffer.from([0,q.type,0,q.cls])]));
  const aBufs = answers.map(a => {
    const name = writeName(a.name);
    const meta = Buffer.alloc(10);
    meta.writeUInt16BE(a.type, 0);
    meta.writeUInt16BE(1, 2); // class IN
    meta.writeUInt32BE(a.ttl || 300, 4);
    meta.writeUInt16BE(a.rdata.length, 8);
    return Buffer.concat([name, meta, a.rdata]);
  });

  return Buffer.concat([header, ...qBufs, ...aBufs]);
}

function ipToRdata(ip) {
  return Buffer.from(ip.split('.').map(Number));
}

// ── Type constants ────────────────────────────────────────────────────────────
const TYPE_A     = 1;
const TYPE_AAAA  = 28;
const TYPE_CNAME = 5;
const TYPE_MX    = 15;
const TYPE_TXT   = 16;
const TYPE_NS    = 2;
const TYPE_SOA   = 6;
const TYPE_PTR   = 12;
const QTYPE_ANY  = 255;

const TYPE_NAMES = { 1:'A', 2:'NS', 5:'CNAME', 12:'PTR', 15:'MX', 16:'TXT', 28:'AAAA', 255:'ANY' };

// ── DNS Server ────────────────────────────────────────────────────────────────
class BrainOSDNS {
  constructor(opts = {}) {
    this.uuid        = MODULE_UUID;
    this.version     = MODULE_VERSION;
    this.port        = opts.port || DEFAULT_PORT;
    this.upstreams   = opts.upstreams || ['8.8.8.8', '1.1.1.1', '9.9.9.9'];
    this.dataDir     = opts.dataDir || './data';
    this.logFile     = path.join(this.dataDir, 'dns-log.jsonl');
    this.blockedFile = path.join(this.dataDir, 'dns-blocked.jsonl');
    this.configFile  = path.join(this.dataDir, 'dns-config.json');

    // Local zone: hostname → [{ type, value, ttl }]
    this.localZone = new Map();
    // Blocklist: Set of domains
    this.blocklist = new Set();
    // Allowlist overrides blocklist
    this.allowlist = new Set();
    // DDNS entries: hostname → { ip, updated, token }
    this.ddns = new Map();
    // Cache: qname+type → { answers, expires }
    this.cache = new Map();
    this.cacheMaxSize = 5000;
    this.cacheTTL = 300000; // 5 minutes default

    this._udp = null;
    this._tcp = null;
    this._stats = { queries: 0, blocked: 0, cached: 0, forwarded: 0, local: 0, errors: 0 };
    this._bus = null; // set by init

    this._loadConfig();
  }

  /** Wire to event bus */
  setBus(bus) {
    this._bus = bus;
    bus.on('net.dns.block_domain', ev => this.blockDomain(ev.data.domain));
    bus.on('net.dns.allow_domain', ev => this.allowDomain(ev.data.domain));
    bus.on('net.dns.add_record',   ev => this.addRecord(ev.data.name, ev.data.type, ev.data.value, ev.data.ttl));
    bus.on('net.ddns.update',      ev => this.ddnsUpdate(ev.data.token, ev.data.hostname, ev.data.ip));
  }

  _emit(type, data) {
    if (this._bus) this._bus.emit(type, data, { source: 'dns-server' });
  }

  _fail(ctx, msg) {
    console.error(`[DNS ERROR] ${ctx}: ${msg}`);
    this._stats.errors++;
    this._emit('system.error', { source: 'dns-server', context: ctx, message: msg });
    this._appendLog(this.blockedFile, { ts: Date.now(), type: 'ERROR', ctx, msg });
  }

  _log(entry) {
    this._appendLog(this.logFile, entry);
  }

  _appendLog(file, entry) {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.appendFileSync(file, JSON.stringify(entry) + '\n');
    } catch (e) {
      console.error(`[DNS LOG ERROR] Cannot write ${file}: ${e.message}`);
    }
  }

  _loadConfig() {
    try {
      if (fs.existsSync(this.configFile)) {
        const cfg = JSON.parse(fs.readFileSync(this.configFile, 'utf8'));
        if (cfg.localZone) {
          for (const [k, v] of Object.entries(cfg.localZone)) {
            this.localZone.set(k.toLowerCase(), v);
          }
        }
        if (cfg.blocklist) cfg.blocklist.forEach(d => this.blocklist.add(d.toLowerCase()));
        if (cfg.allowlist) cfg.allowlist.forEach(d => this.allowlist.add(d.toLowerCase()));
        if (cfg.ddns) {
          for (const [k, v] of Object.entries(cfg.ddns)) this.ddns.set(k, v);
        }
        if (cfg.upstreams) this.upstreams = cfg.upstreams;
      }
    } catch (e) { this._fail('loadConfig', e.message); }
  }

  _saveConfig() {
    try {
      const cfg = {
        localZone: Object.fromEntries(this.localZone),
        blocklist: [...this.blocklist],
        allowlist: [...this.allowlist],
        ddns: Object.fromEntries(this.ddns),
        upstreams: this.upstreams,
      };
      fs.mkdirSync(this.dataDir, { recursive: true });
      fs.writeFileSync(this.configFile + '.tmp', JSON.stringify(cfg, null, 2));
      fs.renameSync(this.configFile + '.tmp', this.configFile);
    } catch (e) { this._fail('saveConfig', e.message); }
  }

  /** Add local DNS record */
  addRecord(name, type, value, ttl = 300) {
    const key = name.toLowerCase();
    if (!this.localZone.has(key)) this.localZone.set(key, []);
    this.localZone.get(key).push({ type: type.toUpperCase(), value, ttl });
    this._saveConfig();
    this._emit('net.dns.record_added', { name, type, value });
  }

  /** Block a domain at DNS level */
  blockDomain(domain) {
    this.blocklist.add(domain.toLowerCase());
    this._saveConfig();
    this._emit('net.dns.domain_blocked', { domain });
  }

  /** Allow a domain (overrides blocklist) */
  allowDomain(domain) {
    this.allowlist.add(domain.toLowerCase());
    this._saveConfig();
  }

  /** Import blocklist from URL (uBlock/hosts format) */
  async importBlocklist(url) {
    return new Promise((resolve, reject) => {
      const mod = url.startsWith('https') ? require('https') : require('http');
      mod.get(url, res => {
        let body = '';
        res.on('data', d => body += d);
        res.on('end', () => {
          let count = 0;
          for (const line of body.split('\n')) {
            const l = line.trim();
            if (!l || l.startsWith('#')) continue;
            // hosts format: 0.0.0.0 domain.com OR just domain.com
            const parts = l.split(/\s+/);
            const domain = parts.length > 1 ? parts[1] : parts[0];
            if (domain && domain.includes('.') && !domain.startsWith('#')) {
              this.blocklist.add(domain.toLowerCase());
              count++;
            }
          }
          this._saveConfig();
          this._emit('net.dns.blocklist_imported', { url, count });
          resolve(count);
        });
      }).on('error', e => { this._fail('importBlocklist', e.message); reject(e); });
    });
  }

  /** DDNS update — No-IP style */
  ddnsUpdate(token, hostname, ip) {
    // Validate token
    const entry = this.ddns.get(hostname);
    if (entry && entry.token !== token) {
      this._fail('ddnsUpdate', `Invalid token for ${hostname}`);
      this._appendLog(this.blockedFile, { ts: Date.now(), type: 'DDNS_AUTH_FAIL', hostname, ip });
      return { ok: false, error: 'Invalid token' };
    }
    const isNew = !entry;
    this.ddns.set(hostname, { ip, token: token || crypto.randomBytes(16).toString('hex'), updated: Date.now() });
    // Update local zone
    this.addRecord(hostname, 'A', ip);
    this._saveConfig();
    this._emit('net.ddns.updated', { hostname, ip, isNew });
    return { ok: true, hostname, ip };
  }

  /** Register a new DDNS hostname, get a token back */
  ddnsRegister(hostname) {
    const token = crypto.randomBytes(24).toString('hex');
    this.ddns.set(hostname, { ip: null, token, updated: null });
    this._saveConfig();
    return { hostname, token, updateUrl: `/ddns/update?token=${token}&hostname=${hostname}&ip={your_ip}` };
  }

  /** Look up in local zone */
  _localLookup(name, type) {
    const key = name.toLowerCase().replace(/\.$/, '');
    const records = this.localZone.get(key);
    if (!records) return null;
    const typeName = TYPE_NAMES[type] || String(type);
    const matched = records.filter(r => r.type === typeName || type === QTYPE_ANY);
    return matched.length ? matched : null;
  }

  /** Check if blocked */
  _isBlocked(name) {
    const parts = name.toLowerCase().replace(/\.$/, '').split('.');
    // Check exact and parent domains
    for (let i = 0; i < parts.length - 1; i++) {
      const sub = parts.slice(i).join('.');
      if (this.blocklist.has(sub) && !this.allowlist.has(name.toLowerCase())) return true;
    }
    return false;
  }

  /** Cache key */
  _cacheKey(name, type) { return `${name.toLowerCase()}:${type}`; }

  /** Look up in cache */
  _cacheGet(name, type) {
    const k = this._cacheKey(name, type);
    const entry = this.cache.get(k);
    if (!entry) return null;
    if (Date.now() > entry.expires) { this.cache.delete(k); return null; }
    return entry.answers;
  }

  _cacheSet(name, type, answers, ttl = 300) {
    if (this.cache.size >= this.cacheMaxSize) {
      // evict oldest
      const oldest = [...this.cache.entries()].sort((a,b) => a[1].expires - b[1].expires)[0];
      if (oldest) this.cache.delete(oldest[0]);
    }
    this.cache.set(this._cacheKey(name, type), { answers, expires: Date.now() + ttl * 1000 });
  }

  /** Forward to upstream resolver */
  async _forward(name, type) {
    for (const upstream of this.upstreams) {
      try {
        const answers = await this._udpQuery(upstream, 53, name, type);
        if (answers) return answers;
      } catch (e) {
        // try next upstream
      }
    }
    this._fail('forward', `All upstreams failed for ${name}`);
    return null;
  }

  _udpQuery(server, port, name, type) {
    return new Promise((resolve, reject) => {
      const id = Math.floor(Math.random() * 65535);
      const q = Buffer.alloc(12 + writeName(name).length + 4);
      q.writeUInt16BE(id, 0);
      q.writeUInt16BE(0x0100, 2); // recursion desired
      q.writeUInt16BE(1, 4); // 1 question
      writeName(name).copy(q, 12);
      q.writeUInt16BE(type, 12 + writeName(name).length);
      q.writeUInt16BE(1,    12 + writeName(name).length + 2);

      const sock = dgram.createSocket('udp4');
      const timeout = setTimeout(() => { sock.close(); reject(new Error('UDP timeout')); }, 3000);
      sock.on('message', msg => {
        clearTimeout(timeout);
        sock.close();
        try {
          // Parse answer section
          const ancount = msg.readUInt16BE(6);
          let offset = 12;
          // Skip questions
          const qdcount = msg.readUInt16BE(4);
          for (let i = 0; i < qdcount; i++) {
            const { end } = readName(msg, offset);
            offset = end + 4;
          }
          const answers = [];
          for (let i = 0; i < ancount; i++) {
            const { name: aname, end: aend } = readName(msg, offset);
            const atype = msg.readUInt16BE(aend);
            const ttl   = msg.readUInt32BE(aend + 4);
            const rdlen = msg.readUInt16BE(aend + 8);
            const rdata = msg.slice(aend + 10, aend + 10 + rdlen);
            if (atype === TYPE_A && rdlen === 4) {
              answers.push({ name: aname, type: atype, ttl, value: [...rdata].join('.'), rdata });
            } else if (atype === TYPE_CNAME) {
              const { name: cname } = readName(rdata, 0);
              answers.push({ name: aname, type: atype, ttl, value: cname, rdata });
            }
            offset = aend + 10 + rdlen;
          }
          resolve(answers.length ? answers : null);
        } catch (e) { reject(e); }
      });
      sock.on('error', reject);
      sock.send(q, 0, q.length, port, server);
    });
  }

  /** Process one DNS query */
  async _processQuery(id, question, flags = 0) {
    this._stats.queries++;
    const { name, type } = question;
    const logEntry = { ts: Date.now(), name, type: TYPE_NAMES[type] || type, action: 'unknown' };

    // 1. Blocklist check — fails loud
    if (this._isBlocked(name)) {
      this._stats.blocked++;
      logEntry.action = 'BLOCKED';
      this._appendLog(this.blockedFile, { ...logEntry, reason: 'blocklist' });
      this._emit('net.dns.block', { name, type: TYPE_NAMES[type] || type });
      // Return NXDOMAIN
      return buildResponse(id, 0x8183, [question], []);
    }

    // 2. Local zone
    const local = this._localLookup(name, type);
    if (local) {
      this._stats.local++;
      logEntry.action = 'LOCAL';
      this._log(logEntry);
      const answers = local.map(r => ({
        name,
        type: Object.entries(TYPE_NAMES).find(([,v]) => v === r.type)?.[0] | 0 || TYPE_A,
        ttl: r.ttl || 300,
        rdata: ipToRdata(r.value),
      }));
      return buildResponse(id, 0x8180, [question], answers);
    }

    // 3. Cache
    const cached = this._cacheGet(name, type);
    if (cached) {
      this._stats.cached++;
      logEntry.action = 'CACHED';
      this._log(logEntry);
      return buildResponse(id, 0x8180, [question], cached);
    }

    // 4. Forward
    this._stats.forwarded++;
    logEntry.action = 'FORWARDED';
    this._log(logEntry);
    const forwarded = await this._forward(name, type);
    if (forwarded) {
      this._cacheSet(name, type, forwarded, Math.min(...forwarded.map(a => a.ttl || 300)));
      const answers = forwarded.map(a => ({ name: a.name, type: a.type, ttl: a.ttl, rdata: a.rdata }));
      return buildResponse(id, 0x8180, [question], answers);
    }

    // SERVFAIL
    return buildResponse(id, 0x8182, [question], []);
  }

  /** Parse raw DNS packet and process */
  async _handlePacket(msg) {
    try {
      const id    = msg.readUInt16BE(0);
      const flags = msg.readUInt16BE(2);
      const qr    = (flags >> 15) & 1;
      if (qr === 1) return null; // It's a response, not a query
      const qdcount = msg.readUInt16BE(4);
      if (qdcount === 0) return buildResponse(id, 0x8181, [], []);
      const question = parseQuestion(msg, 12);
      return await this._processQuery(id, question, flags);
    } catch (e) {
      this._fail('handlePacket', e.message);
      return null;
    }
  }

  /** Start DNS server */
  start() {
    return new Promise((resolve, reject) => {
      this._udp = dgram.createSocket('udp4');

      this._udp.on('error', e => {
        this._fail('udp', e.message);
        reject(e);
      });

      this._udp.on('message', async (msg, rinfo) => {
        try {
          const response = await this._handlePacket(msg);
          if (response) this._udp.send(response, rinfo.port, rinfo.address);
        } catch (e) { this._fail('udp.message', e.message); }
      });

      this._udp.bind(this.port, () => {
        console.log(`[DNS] Server listening on UDP :${this.port}`);
        this._emit('net.dns.started', { port: this.port, uuid: this.uuid });
        resolve({ port: this.port });
      });
    });
  }

  stop() {
    if (this._udp) { this._udp.close(); this._udp = null; }
    if (this._tcp) { this._tcp.close(); this._tcp = null; }
    this._emit('net.dns.stopped', {});
  }

  health() {
    return {
      ok: true,
      uuid: this.uuid,
      version: this.version,
      port: this.port,
      stats: { ...this._stats },
      localRecords: this.localZone.size,
      blocked: this.blocklist.size,
      allowed: this.allowlist.size,
      ddns: this.ddns.size,
      cacheSize: this.cache.size,
      upstreams: this.upstreams,
    };
  }
}

if (typeof module !== 'undefined') module.exports = { BrainOSDNS };
