const test = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('zlib');

delete process.env.DEMO;
process.env.NMS_CLIENT_ID = 'id';
process.env.NMS_CLIENT_SECRET = 'secret';
process.env.NMS_ENV = 'prod';
const nms = require('../lib/sources/nms');

const feature = (id) => ({ type: 'Feature', geometry: null, properties: { coreNOTAMData: { notam: { id: `NMS_ID_${id}`, number: id, location: 'DFW', classification: 'DOM', effectiveStart: '2026-11-01T00:00:00Z', effectiveEnd: 'PERM' } } } });

function reply(body, headers = {}) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
  return {
    status: 200, ok: true,
    headers: { get: (h) => headers[h.toLowerCase()] ?? null },
    body: (async function* () { yield buf; })(),
  };
}

let contentLink = '/nmsapi/v1/content/abc';
let file = Buffer.from(JSON.stringify({ type: 'FeatureCollection', features: [feature('1/001')] }));
let fileHeaders = {};
const seen = [];
global.fetch = async (url, opts) => {
  seen.push({ url, auth: opts.headers.Authorization });
  if (url.includes('/auth/token')) return reply({ access_token: 'tok', expires_in: 1800 });
  if (url.includes('classification=')) return reply({ data: { url: contentLink } });
  return reply(file, fileHeaders);
};

test.beforeEach(() => { seen.length = 0; contentLink = '/nmsapi/v1/content/abc'; fileHeaders = {}; file = Buffer.from(JSON.stringify({ type: 'FeatureCollection', features: [feature('1/001')] })); });

test('downloads and normalises a bulk file from the NMS host', async () => {
  const recs = await nms.fullClassification('DOMESTIC');
  assert.equal(recs.length, 1);
  assert.equal(recs[0].id, '1/001');
  assert.equal(recs[0].end, 'PERM');
  assert.ok(seen.at(-1).url.startsWith('https://api-nms.aim.faa.gov/'));
});

test('reads gzip bulk files', async () => {
  file = zlib.gzipSync(file);
  assert.equal((await nms.fullClassification('DOMESTIC')).length, 1);
});

test('never sends the token to another host', async () => {
  contentLink = 'https://evil.example/steal';
  await assert.rejects(nms.fullClassification('DOMESTIC'), /another host/);
  assert.ok(!seen.some((s) => s.url.startsWith('https://evil.example')));
});

test('refuses oversized downloads by Content-Length', async () => {
  fileHeaders = { 'content-length': String(600 * 1024 * 1024) };
  await assert.rejects(nms.fullClassification('DOMESTIC'), /too large/);
});

test('featuresFrom accepts the documented layouts', async () => {
  const f = feature('2/002');
  for (const body of [[f], { data: { geojson: [f] } }, { features: [f] }, f]) {
    assert.equal((await nms.featuresFrom(Buffer.from(JSON.stringify(body)))).length, 1);
  }
  const ndjson = Buffer.from(`${JSON.stringify(f)}\n${JSON.stringify(f)}\n`);
  assert.equal((await nms.featuresFrom(ndjson)).length, 2);
});
