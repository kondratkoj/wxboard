const test = require('node:test');
const assert = require('node:assert/strict');

// Fake FAA service: each test decides what it answers.
const http = require('../lib/http');
let reply = null, calls = 0;
http.rawFetch = async () => { calls++; return typeof reply === 'function' ? reply() : reply; };
const as = require('../lib/sources/airspace');
const ok = (type, cls, ident) => ({ features: [{ attributes: { LOCAL_TYPE: type, CLASS: cls, IDENT: ident, NAME: `${ident} ${type}`, WKHR_CODE: 'NOTAM' } }] });

test('a point inside a Class D surface area; the answer is cached', async () => {
  as._reset(); calls = 0; reply = ok('CLASS_D', 'D', 'FSM');
  const a = await as.surfaceAt(35.3366, -94.3674);
  assert.equal(a.cls, 'D'); assert.equal(a.ident, 'FSM'); assert.equal(a.partTime, true);
  await as.surfaceAt(35.3366, -94.3674);
  assert.equal(calls, 1);
});

test('no surface area means Class G', async () => {
  as._reset(); reply = { features: [] };
  assert.equal((await as.surfaceAt(35.2573, -93.095)).cls, 'G');
});

test('"Too many requests" is never cached, and the service is left alone for a while', async () => {
  as._reset(); calls = 0; reply = { error: { code: 400, message: 'Unable to perform query. Too many requests.' } };
  await assert.rejects(as.surfaceAt(42.2, -83.3), /Too many requests/);
  await assert.rejects(as.surfaceAt(42.3, -83.4), /slow down/); // backing off: not asked again
  assert.equal(calls, 1);
});

test('an old answer is used while the service is failing', async () => {
  as._reset(); reply = ok('CLASS_B', 'B', 'DTW');
  await as.surfaceAt(42.2124, -83.3534);
  const k = '42.212,-83.353'; as._cache.get(k).at -= 25 * 3600e3; // expired, but less than 7 days old
  reply = () => { throw new Error('network down'); };
  assert.equal((await as.surfaceAt(42.2124, -83.3534)).cls, 'B');
});

test('many points: duplicates asked once, failures reported per point', async () => {
  as._reset(); calls = 0;
  reply = () => (calls === 2 ? { error: { message: 'boom' } } : { features: [] });
  const r = await as.surfaceForPoints([{ lat: 35, lon: -93 }, { lat: 35, lon: -93 }, { lat: 36, lon: -94 }]);
  assert.equal(r.asked, 2); assert.equal(r.failed, 1);
});
