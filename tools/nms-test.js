// Checks your NMS-API credentials WITHOUT pulling NOTAM data (login + ping only),
// so it doesn't use up the FAA's one-data-pull-per-3-minutes allowance.
//   node tools/nms-test.js
const config = require('../lib/config');
const nms = require('../lib/sources/nms');

(async () => {
  if (!config.nms.clientId || !config.nms.clientSecret) {
    console.log('No nmsClientId / nmsClientSecret in config.json yet.');
    process.exit(1);
  }
  console.log(`Environment: ${config.nms.env}  (${nms.host()})`);
  try {
    const r = await nms.ping();
    console.log('Login OK.' + (r && r.pingError ? ` (Ping: ${r.pingError})` : ' Ping OK.'));
    if (config.nms.env !== 'prod') console.log('Note: this is an FAA test environment. Its NOTAMs are not real/current.');
    console.log('Start the site with: node server.js  (the first NOTAM download can take a few minutes)');
  } catch (e) {
    console.log('FAILED:', e.message);
    process.exit(1);
  }
})();
