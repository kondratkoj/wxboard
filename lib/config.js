// Settings come from config.json (copy config.example.json) and can be overridden by environment variables.
// WX_CONFIG points at a different config file (the Docker setup uses /config/config.json).
const fs = require('fs');
const path = require('path');

let file = {};
const cfgPath = process.env.WX_CONFIG || path.join(__dirname, '..', 'config.json');
if (fs.existsSync(cfgPath)) {
  try { file = JSON.parse(fs.readFileSync(cfgPath, 'utf8')); }
  catch (e) { console.error(`${cfgPath} is not valid JSON:`, e.message); process.exit(1); }
}

const env = process.env;
const pick = (envName, key, dflt) => env[envName] ?? file[key] ?? dflt;
const fileAuth = file.auth || {};
const pickAuth = (envName, key, dflt) => env[envName] ?? fileAuth[key] ?? dflt;
const bool = (v) => ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase());
const oneOf = (name, v, allowed, dflt) => {
  const s = String(v ?? dflt).toLowerCase();
  if (allowed.includes(s)) return s;
  console.error(`config: "${name}" must be one of ${allowed.join(', ')} (got "${v}"). Using "${dflt}".`);
  return dflt;
};

const contact = pick('WX_CONTACT', 'contact', '');
const publicUrl = String(pick('WX_PUBLIC_URL', 'publicUrl', '')).replace(/\/+$/, '');

module.exports = {
  port: Number(pick('PORT', 'port', 8080)),
  host: pick('HOST', 'host', '127.0.0.1'),
  demo: bool(pick('DEMO', 'demo', '')),
  // Where accounts, the NOTAM copy and the session key are kept.
  dataDir: env.WX_DATA_DIR || file.dataDir || path.join(__dirname, '..', 'data'),
  // aviationweather.gov and api.weather.gov both ask for a descriptive User-Agent with contact info.
  userAgent: `wxboard/1.0 (preflight weather board${contact ? '; ' + contact : ''})`,
  defaultRadiusNm: Number(pick('DEFAULT_RADIUS', 'defaultRadiusNm', 30)),
  // The site's public address, e.g. "https://wx.example.com". Used to accept form posts from it.
  publicUrl,
  // Extra host names the page may be opened by (IP addresses, localhost and this computer's name always work).
  // The publicUrl's host is added automatically.
  allowedHosts: [
    ...[].concat(env.WX_ALLOWED_HOSTS ? env.WX_ALLOWED_HOSTS.split(',') : file.allowedHosts || []),
    ...(publicUrl ? [new URL(publicUrl).hostname] : []),
  ].map((h) => String(h).trim().toLowerCase()).filter(Boolean),
  // True when a reverse proxy / tunnel (e.g. Cloudflare Tunnel) sits in front and tells us the visitor's real
  // address. Only turn on when the server can't be reached except through that proxy.
  trustProxy: bool(pick('WX_TRUST_PROXY', 'trustProxy', false)),
  auth: {
    // Off: no logins, anyone who can reach the server can use it (the original personal setup).
    enabled: bool(pickAuth('WX_AUTH', 'enabled', false)),
    // Who can create an account: "approval" (request, an admin approves), "open", "invite" (needs a code
    // from an admin) or "closed" (admins add accounts with tools/admin.js).
    signup: oneOf('auth.signup', pickAuth('WX_SIGNUP', 'signup', 'approval'), ['approval', 'open', 'invite', 'closed'], 'approval'),
    // Who sees NOTAMs: "all" signed-in users, "admin" only, or "none".
    notams: oneOf('auth.notams', pickAuth('WX_NOTAMS', 'notams', 'all'), ['all', 'admin', 'none'], 'all'),
    sessionDays: Number(pickAuth('WX_SESSION_DAYS', 'sessionDays', 30)),
    maxPending: Number(pickAuth('WX_MAX_PENDING', 'maxPending', 100)),
  },
  nms: {
    // "prod", "staging" (pre-prod) or "fit". Credentials only work in the environment they were issued for.
    env: String(pick('NMS_ENV', 'nmsEnv', 'prod')).toLowerCase(),
    host: pick('NMS_API_HOST', 'nmsApiHost', ''), // optional override; normally leave blank
    clientId: pick('NMS_CLIENT_ID', 'nmsClientId', ''),
    clientSecret: pick('NMS_CLIENT_SECRET', 'nmsClientSecret', ''),
  },
};
