// End-to-end tests of sign-up, sign-in, sessions and the admin page against a real server on a random port.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.DEMO = '1';
process.env.WX_AUTH = '1';
process.env.WX_SIGNUP = 'approval';
process.env.WX_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'wxboard-auth-'));
delete process.env.WX_TRUST_PROXY;

const config = require('../lib/config');
const users = require('../lib/users');
const { createServer, safeNext } = require('../lib/app');

let base;
const server = createServer();
test.before(() => new Promise((r) => server.listen(0, '127.0.0.1', () => { base = `http://127.0.0.1:${server.address().port}`; r(); })));
test.after(() => { server.close(); fs.rmSync(process.env.WX_DATA_DIR, { recursive: true, force: true }); });

// Minimal browser: keeps one cookie, sends Origin on posts.
function browser() {
  let cookie = '';
  const req = async (p, { method = 'GET', form, headers = {} } = {}) => {
    const h = { ...headers };
    if (cookie) h.Cookie = cookie;
    let body;
    if (form) {
      body = new URLSearchParams(form).toString();
      h['Content-Type'] = 'application/x-www-form-urlencoded';
      if (!('Origin' in h)) h.Origin = base;
    }
    const res = await fetch(base + p, { method: form ? 'POST' : method, headers: h, body, redirect: 'manual' });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0].endsWith('=') ? '' : set.split(';')[0];
    const text = await res.text();
    return { status: res.status, location: res.headers.get('location'), text, json: () => JSON.parse(text) };
  };
  return { req, get cookie() { return cookie; }, set cookie(c) { cookie = c; } };
}
const csrfFrom = (html) => (html.match(/name="csrf" value="([^"]+)"/) || [])[1];
async function login(b, username, password) {
  return b.req('/login', { form: { username, password, next: '/' } });
}

test('signed-out visitors are sent to sign in', async () => {
  const b = browser();
  const r = await b.req('/?ids=KLIT');
  assert.equal(r.status, 303);
  assert.equal(r.location, '/login?next=%2F%3Fids%3DKLIT');
  assert.equal((await b.req('/api/brief?ids=KLIT')).status, 401);
  assert.equal((await b.req('/login')).status, 200);
  assert.equal((await b.req('/styles.css')).status, 200);
});

test('foreign Host headers and cross-site form posts are refused', async () => {
  // fetch() won't send a custom Host header, so use http.get.
  const status = await new Promise((resolve, reject) => require('http')
    .get({ host: '127.0.0.1', port: server.address().port, path: '/login', headers: { Host: 'evil.example' } }, (r) => { r.resume(); resolve(r.statusCode); })
    .on('error', reject));
  assert.equal(status, 421);
  const b = browser();
  const x = await b.req('/login', { form: { username: 'a', password: 'b' }, headers: { Origin: 'https://evil.example' } });
  assert.equal(x.status, 403);
});

test('safeNext only allows paths on this site', () => {
  assert.equal(safeNext('/?ids=KLIT'), '/?ids=KLIT');
  assert.equal(safeNext('//evil.example'), '/');
  assert.equal(safeNext('https://evil.example'), '/');
  assert.equal(safeNext('/\\evil.example'), '/');
});

test('approval flow: request, wait, admin approves, sign in, brief', async () => {
  await users.create({ username: 'boss', password: 'Sup3r-secret-admin', role: 'admin' });
  const visitor = browser();
  const bad = await visitor.req('/signup', { form: { username: 'pilot1', password: 'Approach-mins-one', password2: 'nope', accept: '1' } });
  assert.match(bad.text, /match/);
  const noTerms = await visitor.req('/signup', { form: { username: 'pilot1', password: 'Approach-mins-one', password2: 'Approach-mins-one' } });
  assert.match(noTerms.text, /accept the terms/);
  const ok = await visitor.req('/signup', { form: { username: 'Pilot1', password: 'Approach-mins-one', password2: 'Approach-mins-one', accept: '1', note: '<b>CFI</b>' } });
  assert.match(ok.text, /Request sent/);
  assert.match((await login(visitor, 'pilot1', 'Approach-mins-one')).text, /approved yet/);

  const admin = browser();
  assert.equal((await login(admin, 'boss', 'Sup3r-secret-admin')).status, 303);
  const st = (await admin.req('/api/status')).json();
  assert.equal(st.user.role, 'admin');
  assert.equal(st.user.pending, 1);
  const page = await admin.req('/admin');
  assert.match(page.text, /&lt;b&gt;CFI&lt;\/b&gt;/); // the note is escaped
  const id = users.byName('pilot1').id;
  assert.equal((await admin.req('/admin/action', { form: { action: 'approve', id } })).status, 403, 'needs the form token');
  const appr = await admin.req('/admin/action', { form: { action: 'approve', id, csrf: csrfFrom(page.text) } });
  assert.match(appr.text, /approved/);

  assert.equal((await login(visitor, 'pilot1', 'Approach-mins-one')).status, 303);
  const brief = (await visitor.req('/api/brief?ids=KLIT')).json();
  assert.equal(brief.area.ids[0], 'KLIT');
  assert.equal(brief.notams.data.configured, true);
  assert.equal((await visitor.req('/admin')).status, 403);
});

test('NOTAMs can be limited to admins', async () => {
  config.auth.notams = 'admin';
  try {
    const u = browser();
    await login(u, 'pilot1', 'Approach-mins-one');
    assert.equal((await u.req('/api/brief?ids=KLIT')).json().notams.data.restricted, true);
    const a = browser();
    await login(a, 'boss', 'Sup3r-secret-admin');
    assert.equal((await a.req('/api/brief?ids=KLIT')).json().notams.data.configured, true);
  } finally { config.auth.notams = 'all'; }
});

test('changing the password signs out other sessions', async () => {
  const one = browser(), two = browser();
  await login(one, 'pilot1', 'Approach-mins-one');
  await login(two, 'pilot1', 'Approach-mins-one');
  const page = await one.req('/account');
  const r = await one.req('/account/password', { form: { csrf: csrfFrom(page.text), current: 'Approach-mins-one', password: 'Approach-mins-two', password2: 'Approach-mins-two' } });
  assert.match(r.text, /Password changed/);
  assert.equal((await one.req('/api/status')).json().user.username, 'pilot1');
  assert.equal((await two.req('/api/brief?ids=KLIT')).status, 401);
});

test('disabling a user ends their session; the last admin stays', async () => {
  const u = browser();
  await login(u, 'pilot1', 'Approach-mins-two');
  users.update(users.byName('pilot1').id, { status: 'disabled' });
  assert.equal((await u.req('/api/status')).status, 401);
  assert.match((await login(u, 'pilot1', 'Approach-mins-two')).text, /disabled/);
  assert.throws(() => users.update(users.byName('boss').id, { role: 'user' }), /last admin/);
});

test('repeated wrong passwords are slowed down', async () => {
  const b = browser();
  for (let i = 0; i < 8; i++) assert.equal((await login(b, 'boss', 'wrong-password')).status, 401);
  const r = await login(b, 'boss', 'Sup3r-secret-admin');
  assert.equal(r.status, 429, 'blocked even with the right password until the window passes');
});

test('invite mode needs a valid, unused code', async () => {
  config.auth.signup = 'invite';
  try {
    const code = users.createInvite('boss').code;
    const b = browser();
    const form = (username, invite) => ({ username, password: 'Glide-slope-check', password2: 'Glide-slope-check', accept: '1', invite });
    assert.match((await b.req('/signup', { form: form('invitee', 'WRONGCODE1') })).text, /invite code/);
    assert.match((await b.req('/signup', { form: form('invitee', code.toLowerCase()) })).text, /Account created/);
    assert.match((await b.req('/signup', { form: form('invitee2', code) })).text, /already used/);
    assert.equal((await login(b, 'invitee', 'Glide-slope-check')).status, 303);
  } finally { config.auth.signup = 'approval'; }
});

test('sign-out clears the session', async () => {
  const b = browser();
  await login(b, 'invitee', 'Glide-slope-check');
  const page = await b.req('/account');
  const r = await b.req('/logout', { form: { csrf: csrfFrom(page.text) } });
  assert.equal(r.location, '/login');
  assert.equal(b.cookie, '');
  assert.equal((await b.req('/api/status')).status, 401);
});

test('passwords are stored hashed', () => {
  const raw = fs.readFileSync(path.join(process.env.WX_DATA_DIR, 'users.json'), 'utf8');
  assert.ok(!raw.includes('Sup3r-secret-admin'));
  assert.match(raw, /"hash": "scrypt\$/);
});
