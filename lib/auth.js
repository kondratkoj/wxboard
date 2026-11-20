// Sign-in sessions, form protection and rate limits.
//
// Sessions are signed cookies: { user id, session version, expiry } + an HMAC with a server secret kept in
// <dataDir>/session.key. Nothing is stored per session on the server. Changing a password, disabling a user or
// changing their role bumps the user's session version, which signs out every existing session for them.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('./config');
const users = require('./users');

const COOKIE = 'wxb_session';

// ---------- server secret ----------
let secret = null;
function getSecret() {
  if (secret) return secret;
  if (process.env.WX_SESSION_SECRET) return (secret = Buffer.from(process.env.WX_SESSION_SECRET));
  const file = path.join(config.dataDir, 'session.key');
  try { secret = Buffer.from(fs.readFileSync(file, 'utf8').trim(), 'hex'); }
  catch (e) {
    if (e.code !== 'ENOENT') throw e;
    fs.mkdirSync(config.dataDir, { recursive: true });
    secret = crypto.randomBytes(32);
    fs.writeFileSync(file, secret.toString('hex'), { mode: 0o600, flag: 'wx' });
  }
  if (secret.length < 32) throw new Error(`${file} is too short; delete it to make a new one (this signs everyone out).`);
  return secret;
}

const hmac = (s) => crypto.createHmac('sha256', getSecret()).update(s).digest('base64url');
function safeEqual(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

// ---------- requests ----------
function parseCookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

// The visitor's address. Behind Cloudflare Tunnel every connection comes from the tunnel, so the real address
// is read from the header Cloudflare adds, but only when trustProxy is on.
function clientIp(req) {
  if (config.trustProxy) {
    const cf = req.headers['cf-connecting-ip'];
    if (cf) return String(cf).trim();
    const xff = req.headers['x-forwarded-for'];
    if (xff) return String(xff).split(',')[0].trim();
  }
  return req.socket.remoteAddress || '?';
}

function isHttps(req) {
  if (req.socket.encrypted) return true;
  if (!config.trustProxy) return false;
  return String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https'
    || /"scheme":"https"/.test(String(req.headers['cf-visitor'] || ''));
}

// Form posts must come from this site's own pages (blocks cross-site request forgery).
function sameOrigin(req) {
  const src = req.headers.origin || req.headers.referer;
  if (!src || src === 'null') return false;
  let host;
  try { host = new URL(src).host.toLowerCase(); } catch { return false; }
  const own = String(req.headers.host || '').toLowerCase();
  if (host === own) return true;
  if (config.publicUrl && host === new URL(config.publicUrl).host.toLowerCase()) return true;
  return false;
}

// ---------- sessions ----------
function sessionCookieValue(user) {
  const exp = Date.now() + config.auth.sessionDays * 86400e3;
  const body = Buffer.from(JSON.stringify({ u: user.id, v: user.sessionVersion || 1, e: exp })).toString('base64url');
  return `${body}.${hmac(body)}`;
}

function readSession(req) {
  const raw = parseCookies(req)[COOKIE];
  if (!raw) return null;
  const [body, sig] = raw.split('.');
  if (!body || !sig || !safeEqual(sig, hmac(body))) return null;
  let s;
  try { s = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')); } catch { return null; }
  if (!s || typeof s.e !== 'number' || s.e < Date.now()) return null;
  const user = users.byId(s.u);
  if (!user || user.status !== 'active' || (user.sessionVersion || 1) !== s.v) return null;
  return { user, raw };
}

function cookieAttrs(req, maxAgeSec) {
  return `Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}${isHttps(req) ? '; Secure' : ''}`;
}

// Returns the new session (same shape as readSession) so a page rendered right away can use its form token.
function startSession(req, res, user) {
  const raw = sessionCookieValue(user);
  res.setHeader('Set-Cookie', `${COOKIE}=${raw}; ${cookieAttrs(req, config.auth.sessionDays * 86400)}`);
  return { user, raw };
}

function endSession(req, res) {
  res.setHeader('Set-Cookie', `${COOKIE}=; ${cookieAttrs(req, 0)}`);
}

// A per-session token put in every signed-in form, checked on submit (on top of the same-origin check).
const csrfToken = (session) => hmac(`csrf:${session.raw}`).slice(0, 32);
const csrfOk = (session, token) => Boolean(session && token && safeEqual(token, csrfToken(session)));

// ---------- rate limits ----------
// Counts events per key in a sliding window. hit() records one and says whether the key is now over the limit.
function limiter({ max, windowMs }) {
  const hits = new Map();
  const recent = (key, now) => (hits.get(key) || []).filter((t) => now - t < windowMs);
  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [k, list] of hits) if (!list.some((t) => now - t < windowMs)) hits.delete(k);
  }, Math.max(windowMs, 60e3));
  sweep.unref();
  return {
    blocked(key) { return recent(key, Date.now()).length >= max; },
    hit(key) {
      const now = Date.now();
      const list = recent(key, now);
      list.push(now);
      hits.set(key, list);
      return list.length > max;
    },
    clear(key) { hits.delete(key); },
    retryAfterSec(key) {
      const list = recent(key, Date.now());
      return list.length < max ? 0 : Math.ceil((list[0] + windowMs - Date.now()) / 1000);
    },
  };
}

module.exports = {
  COOKIE, clientIp, isHttps, sameOrigin, readSession, startSession, endSession, csrfToken, csrfOk, limiter, parseCookies,
};
