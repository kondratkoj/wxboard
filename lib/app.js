// The HTTP request handler: board API, static files and (when auth is enabled) accounts.
const fs = require('fs');
const crypto = require('crypto');
const os = require('os');
const net = require('net');
const path = require('path');
const http = require('http');
const config = require('./config');
const { buildBrief } = require('./brief');
const nms = require('./sources/nms');
const notamStore = require('./notamStore');
const { cacheStats } = require('./http');
const users = require('./users');
const auth = require('./auth');
const pages = require('./pages');

const PUBLIC = path.join(__dirname, '..', 'public');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json', '.png': 'image/png', '.ico': 'image/x-icon' };

// Scripts only from this server; map tiles from OpenStreetMap; the Map panel can embed the Aviation Weather Center GFA;
// style attributes are used by the page and Leaflet.
const SECURITY_HEADERS = {
  'Content-Security-Policy': [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: https://tile.openstreetmap.org",
    "frame-src https://aviationweather.gov",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; '),
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'same-origin',
  'X-Frame-Options': 'DENY',
};

function send(res, status, body, type = 'application/json', extra = {}) {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', ...SECURITY_HEADERS, ...extra });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}
const html = (res, body, status = 200) => send(res, status, body, 'text/html; charset=utf-8');
const redirect = (res, to) => send(res, 303, '', 'text/plain', { Location: to });

// Host header check, against DNS rebinding: a web page on another site can't talk to this server by
// pointing its own domain name at it. IP addresses, localhost, this machine's own name, "allowedHosts"
// and the publicUrl's host are allowed.
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

// Rate limits
const briefLimit = auth.limiter({ max: 30, windowMs: 60e3 });             // per user (or address when auth is off)
const loginFailIp = auth.limiter({ max: 20, windowMs: 15 * 60e3 });       // failed sign-ins per address
const loginFailUser = auth.limiter({ max: 8, windowMs: 15 * 60e3 });      // failed sign-ins per username
const signupIp = auth.limiter({ max: 10, windowMs: 60 * 60e3 });          // sign-up attempts per address
const areasLimit = auth.limiter({ max: 60, windowMs: 60e3 });             // saved-area changes per user

// Read a small urlencoded form body.
function readForm(req, maxBytes = 16 * 1024) {
  return new Promise((resolve, reject) => {
    if (!/^application\/x-www-form-urlencoded/i.test(req.headers['content-type'] || '')) {
      return reject(Object.assign(new Error('Expected a form submission'), { status: 415 }));
    }
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > maxBytes) { reject(Object.assign(new Error('Form too large'), { status: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      const p = new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
      resolve(Object.fromEntries(p));
    });
    req.on('error', reject);
  });
}

function readJson(req, maxBytes = 32 * 1024) {
  return new Promise((resolve, reject) => {
    if (!/^application\/json/i.test(req.headers['content-type'] || '')) {
      return reject(Object.assign(new Error('Expected JSON'), { status: 415 }));
    }
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > maxBytes) { reject(Object.assign(new Error('Too much data'), { status: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null')); }
      catch { reject(Object.assign(new Error('That data was not valid JSON.'), { status: 400 })); }
    });
    req.on('error', reject);
  });
}

// Only same-site relative paths, so ?next= can't send people to another site.
const safeNext = (n) => (typeof n === 'string' && /^\/(?!\/)[^\\\s]*$/.test(n) ? n : '/');

const notamsAllowed = (user) => !config.auth.enabled || config.auth.notams === 'all' || (config.auth.notams === 'admin' && user && user.role === 'admin');

function serveStatic(res, pathname) {
  let rel;
  try { rel = decodeURIComponent(pathname === '/' ? '/index.html' : pathname); } catch { return send(res, 400, 'Bad request', 'text/plain'); }
  const file = path.normalize(path.join(PUBLIC, rel));
  if (!file.startsWith(PUBLIC + path.sep) || rel.includes('\0')) return send(res, 403, 'Forbidden', 'text/plain');
  fs.readFile(file, (err, data) => {
    if (err) return send(res, 404, 'Not found', 'text/plain');
    send(res, 200, data, TYPES[path.extname(file)] || 'application/octet-stream');
  });
}

// ---------- one-time messages for the admin page (Post/Redirect/Get) ----------
// Kept in memory for 10 minutes, readable once, and only by the admin who caused them.
const flashes = new Map(); // token -> { userId, msg, at }
function putFlash(userId, msg) {
  const now = Date.now();
  for (const [k, v] of flashes) if (now - v.at > 10 * 60e3) flashes.delete(k);
  if (flashes.size > 500) flashes.delete(flashes.keys().next().value);
  const token = crypto.randomBytes(9).toString('base64url');
  flashes.set(token, { userId, msg, at: now });
  return token;
}
function takeFlash(token, userId) {
  const f = token && flashes.get(token);
  if (!f || f.userId !== userId || Date.now() - f.at > 10 * 60e3) return null;
  flashes.delete(token);
  return f.msg;
}

// ---------- account routes (auth enabled only) ----------
async function handleAuthRoute(req, res, url, session) {
  const p = url.pathname;
  const ip = auth.clientIp(req);
  const user = session && session.user;
  const csrf = session ? auth.csrfToken(session) : '';

  if (req.method === 'GET') {
    if (p === '/login') return user ? redirect(res, '/') : html(res, pages.login({ next: safeNext(url.searchParams.get('next')) }));
    if (p === '/signup') return user ? redirect(res, '/') : html(res, pages.signup());
    if (p === '/account') return user ? html(res, pages.account({ user, csrf })) : redirect(res, '/login?next=/account');
    if (p === '/admin') {
      if (!user) return redirect(res, '/login?next=/admin');
      if (user.role !== 'admin') return html(res, pages.layout('Admin', '<section class="card-box"><h1>Admins only</h1></section>', { user, csrf }), 403);
      const msg = takeFlash(url.searchParams.get('m'), user.id);
      return html(res, pages.admin({ user, csrf, list: users.list(), invites: users.listInvites(), msg }));
    }
    return false;
  }

  if (req.method !== 'POST') return false;
  if (!['/login', '/signup', '/logout', '/account/password', '/account/delete', '/admin/action'].includes(p)) return false;
  // Every form post must come from this site's own pages.
  if (!auth.sameOrigin(req)) return send(res, 403, 'Form posts must come from this site.', 'text/plain');
  const f = await readForm(req);

  if (p === '/login') {
    const username = String(f.username || '').trim().toLowerCase().slice(0, 64);
    const next = safeNext(f.next);
    const tooMany = loginFailIp.blocked(ip) || loginFailUser.blocked(username);
    if (tooMany) {
      const wait = Math.ceil(Math.max(loginFailIp.retryAfterSec(ip), loginFailUser.retryAfterSec(username)) / 60);
      return html(res, pages.login({ next, username, msg: { type: 'error', text: `Too many failed sign-ins. Try again in about ${wait} minutes.` } }), 429);
    }
    const u = await users.verifyLogin(username, String(f.password || ''));
    if (!u) {
      loginFailIp.hit(ip); loginFailUser.hit(username);
      return html(res, pages.login({ next, username, msg: { type: 'error', text: 'Wrong username or password.' } }), 401);
    }
    if (u.status === 'pending') return html(res, pages.login({ next, username, msg: { type: 'error', text: "Your account hasn't been approved yet." } }), 403);
    if (u.status !== 'active') return html(res, pages.login({ next, username, msg: { type: 'error', text: 'This account is disabled.' } }), 403);
    loginFailUser.clear(username);
    users.recordLogin(u.id);
    auth.startSession(req, res, u);
    return redirect(res, next);
  }

  if (p === '/signup') {
    const mode = config.auth.signup;
    const values = { username: f.username, invite: f.invite, note: f.note };
    const fail = (text, status = 400) => html(res, pages.signup({ values, msg: { type: 'error', text } }), status);
    if (mode === 'closed') return html(res, pages.signup(), 403);
    if (signupIp.hit(ip)) return fail('Too many sign-ups from your network. Try again later.', 429);
    if (f.accept !== '1') return fail('Please accept the terms of use.');
    if (String(f.password || '') !== String(f.password2 || '')) return fail("The passwords don't match.");
    if (mode === 'invite' && !users.inviteValid(f.invite)) return fail("That invite code isn't valid or was already used.");
    if (mode === 'approval' && users.pendingCount() >= config.auth.maxPending) return fail('Too many requests are waiting for review. Please try again later.', 503);
    let created;
    try {
      created = await users.create({ username: f.username, password: f.password, note: mode === 'approval' ? f.note : '', status: mode === 'approval' ? 'pending' : 'active', acceptedTerms: true });
    } catch (e) {
      if (e.status && e.status < 500) return fail(e.message, e.status);
      throw e;
    }
    if (mode === 'invite' && !users.useInvite(f.invite, created.username)) {
      users.remove(created.id); // the code was used by someone else in the meantime
      return fail("That invite code isn't valid or was already used.");
    }
    console.log(`  Accounts: ${created.status === 'pending' ? 'sign-up request from' : 'new account'} "${created.username}"`);
    return html(res, pages.signupDone(created.status === 'pending'));
  }

  // Everything below needs a signed-in user and a valid form token.
  if (!user) return redirect(res, '/login');
  if (!auth.csrfOk(session, f.csrf)) return send(res, 403, 'This form expired. Go back, reload the page and try again.', 'text/plain');

  if (p === '/logout') { auth.endSession(req, res); return redirect(res, '/login'); }

  if (p === '/account/password') {
    const msg = (type, text, status = 200) => html(res, pages.account({ user, csrf, msg: { type, text } }), status);
    if (!(await users.checkPassword(String(f.current || ''), user.hash))) return msg('error', 'Your current password is wrong.', 400);
    if (String(f.password || '') !== String(f.password2 || '')) return msg('error', "The new passwords don't match.", 400);
    try { await users.setPassword(user.id, f.password); }
    catch (e) { if (e.status === 400) return msg('error', e.message, 400); throw e; }
    const fresh = auth.startSession(req, res, users.byId(user.id)); // keep this browser signed in
    return html(res, pages.account({ user: fresh.user, csrf: auth.csrfToken(fresh), msg: { type: 'ok', text: 'Password changed. Other sessions were signed out.' } }));
  }

  if (p === '/account/delete') {
    if (!(await users.checkPassword(String(f.current || ''), user.hash))) return html(res, pages.account({ user, csrf, msg: { type: 'error', text: 'Wrong password; account not deleted.' } }), 400);
    try { users.remove(user.id); }
    catch (e) { return html(res, pages.account({ user, csrf, msg: { type: 'error', text: e.message } }), 400); }
    auth.endSession(req, res);
    return html(res, pages.layout('Account deleted', '<section class="card-box"><h1>Account deleted</h1><p>Your account is gone.</p></section>'));
  }

  if (p === '/admin/action') {
    if (user.role !== 'admin') return send(res, 403, 'Admins only', 'text/plain');
    const id = String(f.id || '');
    // Post/Redirect/Get: after an action, send the browser back to /admin with a one-time message, so
    // reloading the page doesn't post the form again (e.g. make a second invite code).
    const back = (type, text) => redirect(res, `/admin?m=${putFlash(user.id, { type, text })}`);
    const target = users.byId(id);
    const name = target ? `"${target.username}"` : 'User';
    if (id === user.id && !['new-invite', 'revoke-invite'].includes(f.action)) return back('error', "You can't change your own account here. Use the Account page.");
    try {
      switch (f.action) {
        case 'approve': users.update(id, { status: 'active' }); return back('ok', `${name} approved. They can sign in now.`);
        case 'enable': users.update(id, { status: 'active' }); return back('ok', `${name} enabled.`);
        case 'disable': users.update(id, { status: 'disabled' }); return back('ok', `${name} disabled and signed out.`);
        case 'promote': users.update(id, { role: 'admin' }); return back('ok', `${name} is now an admin.`);
        case 'demote': users.update(id, { role: 'user' }); return back('ok', `${name} is no longer an admin.`);
        case 'delete': users.remove(id); return back('ok', `${name} deleted.`);
        case 'new-invite': { const inv = users.createInvite(user.username); return back('ok', `New invite code: ${inv.code}`); }
        case 'revoke-invite': users.revokeInvite(id); return back('ok', 'Invite code revoked.');
        default: return back('error', 'Unknown action.');
      }
    } catch (e) {
      if (e.status && e.status < 500) return back('error', e.message);
      throw e;
    }
  }
  return false;
}

// ---------- main handler ----------
async function handle(req, res) {
  if (!hostAllowed(req.headers.host)) return send(res, 421, 'Unrecognised Host header. Add it to "allowedHosts" in config.json.', 'text/plain');
  let url;
  try { url = new URL(req.url, 'http://local'); } catch { return send(res, 400, 'Bad request', 'text/plain'); }
  const p = url.pathname;

  if (p === '/healthz') return send(res, 200, 'ok', 'text/plain');
  if (p === '/favicon.ico') { res.writeHead(204); return res.end(); }

  const session = config.auth.enabled ? auth.readSession(req) : null;
  const user = session && session.user;

  if (config.auth.enabled) {
    if (p === '/terms') return html(res, pages.terms());
    const handled = await handleAuthRoute(req, res, url, session);
    if (handled !== false) return;
  }
  // Saved areas of operation, kept with the signed-in account (with sign-ins off, the page keeps them in the browser).
  if (p === '/api/areas' && config.auth.enabled) {
    if (!user) return send(res, 401, { error: 'Please sign in.', signIn: '/login' });
    if (req.method === 'GET') return send(res, 200, { areas: users.getAreas(user.id) });
    if (req.method !== 'PUT') return send(res, 405, { error: 'Method not allowed' }, 'application/json', { Allow: 'GET, PUT' });
    if (!auth.sameOrigin(req)) return send(res, 403, { error: 'Changes must come from this site.' });
    if (!auth.csrfOk(session, req.headers['x-csrf-token'])) return send(res, 403, { error: 'This page has expired. Reload it and try again.' });
    if (areasLimit.hit(`u:${user.id}`)) return send(res, 429, { error: 'Too many changes in the last minute. Try again shortly.' });
    const body = await readJson(req);
    return send(res, 200, { areas: users.setAreas(user.id, body && body.areas) });
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed', 'text/plain', { Allow: 'GET, HEAD' });

  if (p.startsWith('/api/')) {
    if (config.auth.enabled && !user) return send(res, 401, { error: 'Please sign in.', signIn: '/login' });
    if (p === '/api/brief') {
      const key = user ? `u:${user.id}` : `ip:${auth.clientIp(req)}`;
      if (briefLimit.hit(key)) return send(res, 429, { error: 'Too many briefs in the last minute. Try again shortly.' });
      const brief = await buildBrief({
        ids: url.searchParams.get('ids'),
        radius: url.searchParams.get('radius') || config.defaultRadiusNm,
        route: url.searchParams.get('route') === '1',
        showNotams: notamsAllowed(user),
      });
      return send(res, 200, brief);
    }
    if (p === '/api/status') {
      return send(res, 200, {
        demo: config.demo, notamsConfigured: nms.configured(), nmsEnv: config.nms.env, notamSync: notamStore.status(),
        defaultRadiusNm: config.defaultRadiusNm, cache: cacheStats(),
        auth: config.auth.enabled,
        user: user ? { username: user.username, role: user.role, csrf: auth.csrfToken(session), pending: user.role === 'admin' ? users.pendingCount() : 0 } : null,
      });
    }
    return send(res, 404, { error: 'Not found' });
  }

  // The board itself needs a sign-in; its scripts, styles and images don't hold anything private.
  if (config.auth.enabled && !user && (p === '/' || p === '/index.html')) {
    return redirect(res, `/login${url.search ? `?next=${encodeURIComponent('/' + url.search)}` : ''}`);
  }
  return serveStatic(res, p);
}

function createServer() {
  return http.createServer((req, res) => {
    handle(req, res).catch((e) => {
      if (!e.status || e.status >= 500) console.error(e);
      if (res.headersSent) { res.destroy(); return; }
      // Errors we raised on purpose carry a status and a message meant for the user; anything else stays generic.
      send(res, e.status || 500, { error: e.status ? e.message : 'Server error' });
    });
  });
}

module.exports = { createServer, hostAllowed, safeNext };
