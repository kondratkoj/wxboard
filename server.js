// wxboard — personal preflight weather board.
// Run:  node server.js        then open http://localhost:8080
// Demo: node server.js --demo (offline sample data, for testing the layout)
if (process.argv.includes('--demo')) process.env.DEMO = '1';

const http = require('http');
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const config = require('./lib/config');
const { buildBrief } = require('./lib/brief');
const nms = require('./lib/sources/nms');
const notamStore = require('./lib/notamStore');
const { cacheStats } = require('./lib/http');

const [major] = process.versions.node.split('.').map(Number);
if (major < 18) {
  console.error(`wxboard needs Node.js 18 or newer (you have ${process.versions.node}).`);
  process.exit(1);
}

const PUBLIC = path.join(__dirname, 'public');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json', '.png': 'image/png', '.ico': 'image/x-icon' };

// Scripts only from this server; map tiles from OpenStreetMap; style attributes are used by the page and Leaflet.
const SECURITY_HEADERS = {
  'Content-Security-Policy': [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: https://tile.openstreetmap.org",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; '),
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
};

function send(res, status, body, type = 'application/json') {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', ...SECURITY_HEADERS });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

// Host header check, against DNS rebinding: a web page on another site can't talk to this server by
// pointing its own domain name at 127.0.0.1. IP addresses, localhost and this machine's own name are allowed,
// plus anything listed in config "allowedHosts".
const OWN_NAMES = new Set([os.hostname().toLowerCase(), `${os.hostname().toLowerCase().replace(/\.local$/, '')}.local`]);
function hostAllowed(hostHeader) {
  if (!hostHeader) return false;
  let name;
  try { name = new URL(`http://${hostHeader}`).hostname.toLowerCase(); } catch { return false; }
  name = name.replace(/^\[|\]$/g, '');
  if (net.isIP(name)) return true;
  if (name === 'localhost' || name.endsWith('.localhost')) return true;
  return OWN_NAMES.has(name) || config.allowedHosts.includes(name);
}

// Per-client limit on /api/brief, so one client (or a runaway tab) can't use up the upstream rate limits.
const BRIEF_LIMIT = 30; // per minute per client address
const briefHits = new Map(); // ip -> [timestamps]
function rateLimited(ip) {
  const now = Date.now();
  const recent = (briefHits.get(ip) || []).filter((t) => now - t < 60e3);
  if (recent.length >= BRIEF_LIMIT) { briefHits.set(ip, recent); return true; }
  recent.push(now);
  briefHits.set(ip, recent);
  return false;
}
setInterval(() => {
  const now = Date.now();
  for (const [ip, list] of briefHits) if (!list.some((t) => now - t < 60e3)) briefHits.delete(ip);
}, 5 * 60e3).unref();

const server = http.createServer(async (req, res) => {
  if (!hostAllowed(req.headers.host)) return send(res, 421, 'Unrecognised Host header. Add it to "allowedHosts" in config.json.', 'text/plain');
  let url;
  try { url = new URL(req.url, 'http://local'); } catch { return send(res, 400, 'Bad request', 'text/plain'); }
  try {
    if (url.pathname === '/api/brief') {
      if (rateLimited(req.socket.remoteAddress)) return send(res, 429, { error: 'Too many briefs in the last minute. Try again shortly.' });
      const brief = await buildBrief({
        ids: url.searchParams.get('ids'),
        radius: url.searchParams.get('radius') || config.defaultRadiusNm,
        route: url.searchParams.get('route') === '1',
      });
      return send(res, 200, brief);
    }
    if (url.pathname === '/api/status') {
      return send(res, 200, { demo: config.demo, notamsConfigured: nms.configured(), nmsEnv: config.nms.env, notamSync: notamStore.status(), defaultRadiusNm: config.defaultRadiusNm, cache: cacheStats() });
    }
    if (url.pathname === '/favicon.ico') { res.writeHead(204); return res.end(); }
    // Static files, only from inside public/
    let rel;
    try { rel = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname); } catch { return send(res, 400, 'Bad request', 'text/plain'); }
    const file = path.normalize(path.join(PUBLIC, rel));
    if (!file.startsWith(PUBLIC + path.sep) || rel.includes('\0')) return send(res, 403, 'Forbidden', 'text/plain');
    fs.readFile(file, (err, data) => {
      if (err) return send(res, 404, 'Not found', 'text/plain');
      send(res, 200, data, TYPES[path.extname(file)] || 'application/octet-stream');
    });
  } catch (e) {
    if (!e.status || e.status >= 500) console.error(e);
    send(res, e.status || 500, { error: e.message || 'Server error' });
  }
});

server.listen(config.port, config.host, () => {
  notamStore.start();
  console.log(`\n  wxboard running at http://localhost:${config.port}`);
  console.log(`  Mode:    ${config.demo ? 'DEMO (sample data, not live). Try http://localhost:' + config.port + '/?ids=KLIT%20KXNA' : 'LIVE'}`);
  console.log(`  NOTAMs:  ${nms.configured() ? `enabled (${config.nms.env}${config.nms.env !== 'prod' ? ' - FAA TEST DATA, NOT REAL NOTAMS' : ''})` : 'not set up (add NMS credentials to config.json)'}\n`);
});
