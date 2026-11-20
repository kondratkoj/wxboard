// wxboard — preflight weather board.
// Run:  node server.js        then open http://localhost:8080
// Demo: node server.js --demo (offline sample data, for testing the layout)
if (process.argv.includes('--demo')) process.env.DEMO = '1';

const [major] = process.versions.node.split('.').map(Number);
if (major < 18) {
  console.error(`wxboard needs Node.js 18 or newer (you have ${process.versions.node}).`);
  process.exit(1);
}

const config = require('./lib/config');
const nms = require('./lib/sources/nms');
const notamStore = require('./lib/notamStore');
const users = require('./lib/users');
const { createServer } = require('./lib/app');

if (config.auth.enabled && config.trustProxy && !config.publicUrl) {
  console.warn('  Note: set "publicUrl" in config.json (e.g. "https://wx.example.com"). Without it, sign-in forms sent through the tunnel may be refused.');
}
if (config.auth.enabled && !config.trustProxy && config.host !== '127.0.0.1' && config.host !== 'localhost') {
  console.warn('  Note: sign-ins are on but "trustProxy" is off. If this runs behind Cloudflare Tunnel or another proxy, turn it on so sign-in limits apply per visitor.');
}

createServer().listen(config.port, config.host, () => {
  notamStore.start();
  console.log(`\n  wxboard running at http://localhost:${config.port}`);
  console.log(`  Mode:    ${config.demo ? 'DEMO (sample data, not live). Try http://localhost:' + config.port + '/?ids=KLIT%20KXNA' : 'LIVE'}`);
  console.log(`  NOTAMs:  ${nms.configured() ? `enabled (${config.nms.env}${config.nms.env !== 'prod' ? ' - FAA TEST DATA, NOT REAL NOTAMS' : ''})` : 'not set up (add NMS credentials to config.json)'}`);
  if (config.auth.enabled) {
    console.log(`  Sign-in: on (sign-ups: ${config.auth.signup}, NOTAMs for: ${config.auth.notams})`);
    if (!users.adminCount()) console.log('  No admin account yet. Create one with:  node tools/admin.js create-admin <username>');
  } else {
    console.log('  Sign-in: off (anyone who can reach this server can use it)');
  }
  console.log('');
});
