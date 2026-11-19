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
