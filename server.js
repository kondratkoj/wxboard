// wxboard — personal preflight weather board.
// Run:  node server.js        then open http://localhost:8080
// Demo: node server.js --demo (offline sample data, for testing the layout)
if (process.argv.includes('--demo')) process.env.DEMO = '1';

const http = require('http');
const fs = require('fs');
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

function send(res, status, body, type = 'application/json') {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://local');
  try {
    if (url.pathname === '/api/brief') {
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
    // Static files
    let file = path.normalize(path.join(PUBLIC, url.pathname === '/' ? 'index.html' : url.pathname));
    if (!file.startsWith(PUBLIC)) return send(res, 403, 'Forbidden', 'text/plain');
    fs.readFile(file, (err, data) => {
      if (err) return send(res, 404, 'Not found', 'text/plain');
      send(res, 200, data, TYPES[path.extname(file)] || 'application/octet-stream');
    });
  } catch (e) {
    console.error(e);
    send(res, e.status || 500, { error: e.message || 'Server error' });
  }
});

server.listen(config.port, config.host, () => {
  notamStore.start();
  console.log(`\n  wxboard running at http://localhost:${config.port}`);
  console.log(`  Mode:    ${config.demo ? 'DEMO (sample data, not live)' : 'LIVE'}`);
  console.log(`  NOTAMs:  ${nms.configured() ? `enabled (${config.nms.env}${config.nms.env !== 'prod' ? ' - FAA TEST DATA, NOT REAL NOTAMS' : ''})` : 'not set up (add NMS credentials to config.json)'}\n`);
});
