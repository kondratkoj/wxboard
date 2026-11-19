// Settings come from config.json (copy config.example.json) and can be overridden by environment variables.
const fs = require('fs');
const path = require('path');

let file = {};
const cfgPath = path.join(__dirname, '..', 'config.json');
if (fs.existsSync(cfgPath)) {
  try { file = JSON.parse(fs.readFileSync(cfgPath, 'utf8')); }
  catch (e) { console.error('config.json is not valid JSON:', e.message); process.exit(1); }
}

const env = process.env;
const pick = (envName, key, dflt) => env[envName] ?? file[key] ?? dflt;

const contact = pick('WX_CONTACT', 'contact', '');

module.exports = {
  port: Number(pick('PORT', 'port', 8080)),
  host: pick('HOST', 'host', '127.0.0.1'),
  demo: ['1', 'true', 'yes'].includes(String(pick('DEMO', 'demo', '')).toLowerCase()),
  // aviationweather.gov and api.weather.gov both ask for a descriptive User-Agent with contact info.
  userAgent: `wxboard/1.0 (personal preflight weather board${contact ? '; ' + contact : ''})`,
  defaultRadiusNm: Number(pick('DEFAULT_RADIUS', 'defaultRadiusNm', 30)),
  nms: {
    // "prod", "staging" (pre-prod) or "fit". Credentials only work in the environment they were issued for.
    env: String(pick('NMS_ENV', 'nmsEnv', 'prod')).toLowerCase(),
    host: pick('NMS_API_HOST', 'nmsApiHost', ''), // optional override; normally leave blank
    clientId: pick('NMS_CLIENT_ID', 'nmsClientId', ''),
    clientSecret: pick('NMS_CLIENT_SECRET', 'nmsClientSecret', ''),
  },
};
