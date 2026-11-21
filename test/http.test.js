const test = require('node:test');
const assert = require('node:assert/strict');

delete process.env.DEMO;
const http = require('../lib/http');

let calls = 0;
let reply = () => ({ status: 200, ok: true, body: '{"n":1}' });
global.fetch = async () => {
  calls++;
  const r = reply();
  if (r.throws) throw new Error(r.throws);
  return { status: r.status, ok: r.ok, text: async () => r.body };
};

test.beforeEach(() => { calls = 0; http._cache.clear(); reply = () => ({ status: 200, ok: true, body: '{"n":1}' }); });

test('caches within the TTL and shares concurrent requests', async () => {
  const [a, b] = await Promise.all([http.getJson('https://x.test/a', 60), http.getJson('https://x.test/a', 60)]);
  assert.deepEqual(a, { n: 1 });
  assert.equal(b, a);
  await http.getJson('https://x.test/a', 60);
  assert.equal(calls, 1);
});

test('serves stale data on failure and backs off before retrying', async () => {
  await http.getJson('https://x.test/b', 60);
  http._cache.get('https://x.test/b').at -= 61e3; // expire it
  reply = () => ({ throws: 'network down' });
  assert.deepEqual(await http.getJson('https://x.test/b', 60), { n: 1 });
  assert.deepEqual(await http.getJson('https://x.test/b', 60), { n: 1 });
  assert.equal(calls, 2, 'second call must not hit the failing source again');
});

test('an old copy is never silent: trackStale lists it, and logs say so once', async () => {
  await http.getJson('https://x.test/m/metar', 60);
  const goodAt = http._cache.get('https://x.test/m/metar').at -= 61e3;
  reply = () => ({ throws: 'network down' });
  const errs = []; const oldErr = console.error; console.error = (m) => errs.push(m);
  try {
    const one = await http.trackStale(() => http.getJson('https://x.test/m/metar', 60));
    assert.deepEqual(one.value, { n: 1 });
    assert.equal(one.stale.length, 1);
    assert.equal(one.stale[0].source, 'x.test metar');
    assert.equal(one.stale[0].since, goodAt);
    assert.match(one.stale[0].error, /network down/);
    // still within the retry wait: served from cache without asking again, and still flagged
    const two = await http.trackStale(() => http.getJson('https://x.test/m/metar', 60));
    assert.equal(two.stale.length, 1);
    assert.equal(calls, 2);
    // a fresh copy is not flagged
    reply = () => ({ status: 200, ok: true, body: '{"n":3}' });
    const fresh = await http.trackStale(() => http.getJson('https://x.test/other', 60));
    assert.deepEqual(fresh.stale, []);
  } finally { console.error = oldErr; }
  assert.equal(errs.filter((m) => /Source problem: x\.test metar/.test(m)).length, 1, 'logged once');
});

test('a request shared with a failing one is flagged for every caller', async () => {
  await http.getJson('https://x.test/s', 60);
  http._cache.get('https://x.test/s').at -= 61e3;
  reply = () => ({ throws: 'down' });
  const oldErr = console.error; console.error = () => {};
  try {
    const [a, b] = await Promise.all([
      http.trackStale(() => http.getJson('https://x.test/s', 60)),
      http.trackStale(() => http.getJson('https://x.test/s', 60)),
    ]);
    assert.equal(a.stale.length, 1);
    assert.equal(b.stale.length, 1);
  } finally { console.error = oldErr; }
});

test('a failure with no stale copy is remembered briefly', async () => {
  reply = () => ({ status: 503, ok: false, body: 'down' });
  await assert.rejects(http.getJson('https://x.test/c', 60), /503/);
  await assert.rejects(http.getJson('https://x.test/c', 60), /503/);
  assert.equal(calls, 1);
  http._cache.get('https://x.test/c').retryAt = Date.now() - 1;
  reply = () => ({ status: 200, ok: true, body: '{"n":2}' });
  assert.deepEqual(await http.getJson('https://x.test/c', 60), { n: 2 });
});

test('requests to a limited host wait their turn (Open-Meteo: 2 at a time)', async () => {
  let inFlight = 0, peak = 0;
  const realFetch = global.fetch;
  global.fetch = async (url) => {
    inFlight++; peak = Math.max(peak, inFlight);
    await new Promise((r) => setTimeout(r, 20));
    inFlight--;
    return { status: 200, ok: true, text: async () => '{"n":1}' };
  };
  try {
    const urls = Array.from({ length: 6 }, (_, i) => `https://api.open-meteo.com/v1/forecast?p=${i}`);
    const out = await Promise.all(urls.map((u) => http.getJson(u, 60)));
    assert.equal(out.length, 6);
    assert.equal(peak, http.HOST_CONCURRENCY['api.open-meteo.com']);
    peak = 0;
    await Promise.all(Array.from({ length: 6 }, (_, i) => http.getJson(`https://other.test/x?p=${i}`, 60)));
    assert.equal(peak, 6, 'other hosts are not limited');
  } finally { global.fetch = realFetch; }
});

test('sweep drops old data and expired errors', async () => {
  await http.getJson('https://x.test/d', 60);
  await http.getJson('https://x.test/e', 60);
  http._cache.get('https://x.test/d').at -= 4 * 3600e3;
  http._cache.set('https://x.test/f', { error: new Error('x'), retryAt: Date.now() - 1 });
  http.sweep();
  assert.deepEqual([...http._cache.keys()], ['https://x.test/e']);
});
