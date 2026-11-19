const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

delete process.env.DEMO;
process.env.NMS_CLIENT_ID = 'id';
process.env.NMS_CLIENT_SECRET = 'secret';
process.env.NMS_ENV = 'unittest';
process.env.WX_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'wxboard-test-'));
test.after(() => fs.rmSync(process.env.WX_DATA_DIR, { recursive: true, force: true }));

const nms = require('../lib/sources/nms');
const store = require('../lib/notamStore');

const iso = (msFromNow) => new Date(Date.now() + msFromNow).toISOString();
const rec = (id, o = {}) => ({ id, number: id, location: 'DFW', classification: 'DOM', start: iso(-3600e3), end: iso(3600e3), estimated: false, geometry: null, ...o });

test.beforeEach(() => store._state.notams.clear());

test('isGone: cancelled, expired, EST and PERM', () => {
  assert.equal(store._isGone(rec('a')), false);
  assert.equal(store._isGone(rec('b', { end: iso(-1000) })), true);
  assert.equal(store._isGone(rec('c', { end: iso(-1000), estimated: true })), false);
  assert.equal(store._isGone(rec('d', { end: 'PERM' })), false);
  assert.equal(store._isGone(rec('e', { canceled: iso(-1000) })), true);
});

test('apply adds, replaces and removes', () => {
  assert.deepEqual(store._apply([rec('1'), rec('2')]), { added: 2, removed: 0 });
  assert.deepEqual(store._apply([rec('1', { canceled: iso(-1) }), rec('2', { text: 'new' })]), { added: 0, removed: 1 });
  assert.equal(store._state.notams.size, 1);
});

test('classOf maps NMS codes', () => {
  assert.equal(store._classOf({ classification: 'DOM' }), 'DOMESTIC');
  assert.equal(store._classOf({ classification: 'FDC' }), 'FDC');
  assert.equal(store._classOf({ classification: 'LMIL' }), 'LOCAL_MILITARY');
  assert.equal(store._classOf({ classification: 'MIL' }), 'MILITARY');
});

test('query finds airport and area NOTAMs, skips gone ones, hides internals', () => {
  const near = { type: 'Point', coordinates: [-97.0, 32.9] };
  const far = { type: 'Point', coordinates: [-80.0, 32.9] };
  store._apply([rec('apt'), rec('area', { location: 'ZFW', geometry: near }), rec('far', { location: 'ZJX', geometry: far })]);
  // Expires after it was stored: query must skip it even before the sync loop prunes it.
  store._state.notams.set('old', { ...store._state.notams.get('apt'), id: 'old', number: 'old', _endMs: Date.now() - 1 });
  const shape = { points: [{ lat: 32.8968, lon: -97.038 }], route: false };
  const out = store.query({ anchorIds: ['KDFW'], shape, radiusNm: 30, bbox: { minLat: 32, maxLat: 34, minLon: -98, maxLon: -96 } });
  assert.deepEqual(out.map((r) => `${r.id}:${r.scope}`).sort(), ['apt:airport', 'area:area']);
  for (const r of out) for (const k of ['geometry', 'bbox', '_endMs', '_cancelMs']) assert.ok(!(k in r), k);
});

test('a failed classification does not stop delta updates', async () => {
  const calls = [];
  nms.fullClassification = async (cls) => { calls.push(`full:${cls}`); if (cls === 'FDC') throw new Error('boom'); return [rec(`${cls}-1`)]; };
  nms.delta = async () => { calls.push('delta'); return []; };
  const queue = [];
  const realSetTimeout = global.setTimeout;
  global.setTimeout = (fn) => { queue.push(fn); return { unref() {} }; };
  const realError = console.error, realLog = console.log;
  console.error = console.log = () => {};
  try {
    store.start();
    for (let i = 0; i < 3; i++) await queue.shift()();
  } finally {
    global.setTimeout = realSetTimeout;
    console.error = realError; console.log = realLog;
  }
  assert.deepEqual(calls, ['full:DOMESTIC', 'full:FDC', 'full:MILITARY', 'delta', 'delta']);
  assert.equal(store.status().status, 'ready');
  assert.ok(fs.existsSync(path.join(process.env.WX_DATA_DIR, 'notams-unittest.json')));
});
