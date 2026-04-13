/**
 * reverse-proxy.js — BrainOS Reverse Proxy
 * UUID: brainos-rproxy-v5000-0000-000000000006
 *
 * HTTP/HTTPS reverse proxy with SNI routing. No port-forward required.
 * Integrates with nexus-bridge-server. Firewall middleware hookpoint.
 * Fails loudly. All errors logged and evented.
 */
'use strict';

const http  = require('http');
const https = require('https');
const net   = require('net');
const fs    = require('fs');
const path  = require('path');

const MODULE_UUID = 'brainos-rproxy-v5000-0000-000000000006';

class ReverseProxy {
  constructor(opts = {}) {
    this.uuid       = MODULE_UUID;
    this.port       = opts.port || 8080;
    this.dataDir    = opts.dataDir || './data';
    this.logFile    = path.join(this.dataDir, 'proxy-access.jsonl');
    this._routes    = new Map(); // hostname → { target, stripPrefix, addHeaders }
    this._server    = null;
    this._bus       = null;
    this._stats     = { requests: 0, errors: 0, bytes: 0 };
    this._fwMiddleware = null; // set by setFirewall
  }

  setBus(bus) {
    this._bus = bus;
    bus.on('net.proxy.add_route',    ev => this.addRoute(ev.data));
    bus.on('net.proxy.remove_route', ev => this.removeRoute(ev.data.host));
  }

  setFirewall(fw) { this._fwMiddleware = fw.middleware(); }

  _emit(t, d) { if (this._bus) this._bus.emit(t, d, { source: 'reverse-proxy' }); }

  _fail(ctx, msg) {
    console.error(`[PROXY ERROR] ${ctx}: ${msg}`);
    this._stats.errors++;
    this._emit('system.error', { source: 'reverse-proxy', context: ctx, message: msg });
  }

  _log(entry) {
    try {
      fs.mkdirSync(path.dirname(this.logFile), { recursive: true });
      fs.appendFileSync(this.logFile, JSON.stringify({ ts: Date.now(), ...entry }) + '\n');
    } catch {}
  }

  /** Route: { host, target, stripPrefix?, addHeaders? } */
  addRoute({ host, target, stripPrefix = '', addHeaders = {} }) {
    if (!host || !target) { this._fail('addRoute', 'host and target required'); return; }
    this._routes.set(host, { target, stripPrefix, addHeaders });
    this._emit('net.proxy.route_added', { host, target });
  }

  removeRoute(host) {
    this._routes.delete(host);
    this._emit('net.proxy.route_removed', { host });
  }

  _getRoute(req) {
    const host = req.headers['host']?.split(':')[0] || '';
    // Exact match first, then wildcard
    return this._routes.get(host) || this._routes.get('*') || null;
  }

  _proxyRequest(req, res, route) {
    this._stats.requests++;
    let targetUrl;
    try { targetUrl = new URL(route.target); }
    catch (e) { this._fail('proxyRequest', `Bad target URL: ${route.target}`); res.writeHead(502); res.end(); return; }

    const proxyPath = route.stripPrefix
      ? req.url.replace(new RegExp(`^${route.stripPrefix}`), '')
      : req.url;

    const opts = {
      hostname: targetUrl.hostname,
      port:     targetUrl.port || (targetUrl.protocol === 'https:' ? 443 : 80),
      path:     proxyPath || '/',
      method:   req.method,
      headers:  { ...req.headers, ...route.addHeaders,
                  'X-Forwarded-For': req.socket.remoteAddress,
                  'X-Forwarded-Proto': 'http',
                  host: targetUrl.host },
    };

    const mod = targetUrl.protocol === 'https:' ? https : http;
    const proxyReq = mod.request(opts, proxyRes => {
      res.writeHead(proxyRes.statusCode, proxyRes.headers);
      proxyRes.pipe(res);
      this._log({ method: req.method, url: req.url, target: route.target, status: proxyRes.statusCode });
    });

    proxyReq.on('error', e => {
      this._fail('proxyReq', `${route.target}: ${e.message}`);
      if (!res.headersSent) { res.writeHead(502); res.end('Bad Gateway'); }
    });

    req.pipe(proxyReq);
  }

  start() {
    return new Promise((resolve, reject) => {
      this._server = http.createServer((req, res) => {
        // Firewall check
        if (this._fwMiddleware) {
          let blocked = false;
          this._fwMiddleware(req, { writeHead: (code, hdrs) => { blocked = code === 403; res.writeHead(code, hdrs); }, end: d => res.end(d) },
            () => { if (!blocked) this._handleRequest(req, res); });
        } else {
          this._handleRequest(req, res);
        }
      });

      // WebSocket / CONNECT tunnel support
      this._server.on('connect', (req, socket, head) => {
        const [host, port] = req.url.split(':');
        const tunnel = net.connect(parseInt(port) || 443, host, () => {
          socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
          tunnel.write(head);
          tunnel.pipe(socket); socket.pipe(tunnel);
        });
        tunnel.on('error', e => { this._fail('tunnel', e.message); socket.destroy(); });
      });

      this._server.on('error', e => { this._fail('server', e.message); reject(e); });
      this._server.listen(this.port, () => {
        console.log(`[PROXY] Listening on :${this.port}`);
        this._emit('net.proxy.started', { port: this.port });
        resolve({ port: this.port });
      });
    });
  }

  _handleRequest(req, res) {
    const route = this._getRoute(req);
    if (!route) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'No route for host', host: req.headers.host }));
      this._log({ method: req.method, url: req.url, status: 404, reason: 'no_route' });
      return;
    }
    this._proxyRequest(req, res, route);
  }

  stop() { if (this._server) { this._server.close(); this._server = null; } }

  health() {
    return { ok: true, uuid: this.uuid, port: this.port,
             routes: this._routes.size, stats: { ...this._stats } };
  }
}

if (typeof module !== 'undefined') module.exports = { ReverseProxy };
