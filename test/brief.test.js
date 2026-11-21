const test = require('node:test');
const assert = require('node:assert/strict');

process.env.DEMO = '1'; // offline fixtures
const { buildBrief, parseIds } = require('../lib/brief');

test('parseIds: uppercases, dedupes, adds K to 3-letter IDs, caps at 12', () => {
  assert.deepEqual(parseIds('dfw, kaus;KDFW  1F7'), ['KDFW', 'KAUS', '1F7']);
  assert.equal(parseIds(Array.from({ length: 20 }, (_, i) => `K${String(i).padStart(3, 'A')}`).join(' ')).length, 12);
});

test('invalid IDs are rejected or reported, never echoed as an error', async () => {
  await assert.rejects(buildBrief({ ids: '<svg/onload=x>', radius: 30 }), (e) => e.status === 400 && !/svg/i.test(e.message));
  const b = await buildBrief({ ids: 'KLIT <B>X', radius: 30 });
  assert.deepEqual(b.area.ids, ['KLIT']);
  assert.deepEqual(b.area.unknown, ['<B>X']);
});

test('demo brief builds every section', async () => {
  const b = await buildBrief({ ids: 'KLIT KXNA', radius: 50 });
  for (const k of ['metars', 'tafs', 'pireps', 'sigmets', 'cwas', 'gairmets', 'tfrs', 'notams', 'forecast', 'winds', 'trend', 'lamp']) {
    assert.equal(b[k].ok, true, `${k}: ${b[k].error}`);
  }
  assert.equal(b.forecast.data.length, 2);
});

test('the current METAR is the newest one any request returned', async () => {
  const awc = require('../lib/sources/awc');
  const real = { byIds: awc.metarsByIds, hist: awc.metarHistory };
  const b0 = await buildBrief({ ids: 'KLIT', radius: 30 });
  const cur = b0.metars.data.find((m) => m.id === 'KLIT');
  const base = (await real.byIds(['KLIT'])).find((m) => m.icaoId === 'KLIT');
  const newer = { ...base, obsTime: cur.obsTime / 1000 + 3600, rawOb: 'METAR KLIT NEWER' }; // AWC times are seconds
  awc.metarHistory = async () => [...(await real.hist(['KLIT'], 6)), newer];
  try {
    const b = await buildBrief({ ids: 'KLIT', radius: 30 });
    const klit = b.metars.data.find((m) => m.id === 'KLIT');
    assert.equal(klit.obsTime, cur.obsTime + 3600e3);
    assert.equal(klit.raw, 'METAR KLIT NEWER');
    assert.deepEqual(b.stale, []);
  } finally { awc.metarHistory = real.hist; }
});
