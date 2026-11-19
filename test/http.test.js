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

test('a failure with no stale copy is remembered briefly', async () => {
  reply = () => ({ status: 503, ok: false, body: 'down' });
  await assert.rejects(http.getJson('https://x.test/c', 60), /503/);
  await assert.rejects(http.getJson('https://x.test/c', 60), /503/);
  assert.equal(calls, 1);
  http._cache.get('https://x.test/c').retryAt = Date.now() - 1;
  reply = () => ({ status: 200, ok: true, body: '{"n":2}' });
  assert.deepEqual(await http.getJson('https://x.test/c', 60), { n: 2 });
});

test('sweep drops old data and expired errors', async () => {
  await http.getJson('https://x.test/d', 60);
  await http.getJson('https://x.test/e', 60);
  http._cache.get('https://x.test/d').at -= 4 * 3600e3;
  http._cache.set('https://x.test/f', { error: new Error('x'), retryAt: Date.now() - 1 });
  http.sweep();
  assert.deepEqual([...http._cache.keys()], ['https://x.test/e']);
});
