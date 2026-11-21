const test = require('node:test');
const assert = require('node:assert/strict');
const T = require('../public/terrain');
const REG = require('./part95-reg.json').paragraphs;

test('every regulation point matches the eCFR text of 14 CFR Part 95 Subpart B', () => {
  const mine = T.regParagraphs();
  assert.equal(mine.length, REG.length);
  mine.forEach((para, i) => {
    assert.equal(para.length, REG[i].length, `paragraph ${i}: point count`);
    para.forEach(([lat, lon], j) => {
      assert.ok(Math.abs(lat - REG[i][j][0]) < 1e-3 && Math.abs(lon - REG[i][j][1]) < 1e-3, `paragraph ${i} point ${j}: ${lat},${lon} vs ${REG[i][j]}`);
    });
  });
});

// Airport positions are rounded public reference points; expected answers follow from the regulation's boundaries.
const cases = [
  ['KRUE Russellville AR', 35.26, -93.09, false],
  ['KHRO Harrison AR', 36.26, -93.15, false],
  ['KAVL Asheville NC', 35.44, -82.54, true],
  ['KTRI Tri-Cities TN', 36.48, -82.41, true],
  ['KCRW Charleston WV', 38.37, -81.59, true],
  ['KATL Atlanta GA', 33.64, -84.43, false],
  ['KBOS Boston MA', 42.36, -71.01, false],
  ['KALB Albany NY (95.13(b) exception)', 42.75, -73.80, false],
  ['KDEN Denver CO', 39.86, -104.67, true],
  ['KAMA Amarillo TX', 35.22, -101.71, false],
  ['KELP El Paso TX', 31.81, -106.38, true],
  ['KPHX Phoenix AZ', 33.43, -112.01, true],
  ['KLAX Los Angeles CA', 33.94, -118.41, true],
  ['KFAT Fresno CA (Central Valley exception)', 36.78, -119.72, false],
  ['KSMF Sacramento CA (Central Valley exception)', 38.70, -121.59, false],
  ['KSEA Seattle WA (Puget Sound exception)', 47.45, -122.31, false],
  ['KPDX Portland OR', 45.59, -122.60, true],
  ['PANC Anchorage AK (exception)', 61.17, -149.99, false],
  ['PAFA Fairbanks AK (exception)', 64.82, -147.86, false],
  ['PAJN Juneau AK', 58.35, -134.58, true],
  ['PHNL Honolulu HI', 21.32, -157.92, true],
  ['TJSJ San Juan PR (north of the area)', 18.44, -66.00, false],
  ['CYUL Montreal QC', 45.47, -73.74, false],
  ['MMMX Mexico City', 19.44, -99.07, false],
];
for (const [name, lat, lon, mtn] of cases) {
  test(`terrain: ${name}`, () => assert.equal(T.classify(lat, lon).mtn, mtn));
}

test('no position gives mtn null; edge distance is reported', () => {
  assert.equal(T.classify(null, null).mtn, null);
  const c = T.classify(35.44, -82.54);
  assert.ok(c.edgeNm > 0 && c.edgeNm < 200);
  assert.match(T.describe(c), /Eastern US Mountainous Area/);
});

const MN = require('../public/minimums');
test('minimums: per-airport terrain picks the 135.609 row; fixed settings still work', () => {
  const s = { ...MN.DEFAULTS };
  assert.equal(s.terrain, 'auto');
  assert.deepEqual([MN.limitsFor('day', s, 'mtn').ceil, MN.limitsFor('day', s, 'mtn').vis], [1000, 3]);
  assert.deepEqual([MN.limitsFor('day', s, 'non').ceil, MN.limitsFor('day', s, 'non').vis], [800, 3]);
  assert.equal(MN.limitsFor('night', s, 'mtn').ceil, 1000); // NVG column, mountainous non-local
  assert.equal(MN.limitsFor('day', { ...s, terrain: 'mtn' }).ceil, 1000);
  assert.equal(MN.limitsFor('day', s).ceil, 800); // auto with no place: non-mountainous
});
test('minimums: thresholds and band problems', () => {
  const th = MN.thresholds({ ceil: 800, vis: 2 }, MN.DEFAULTS.bands);
  assert.deepEqual(th.ceil, { red: 800, crit: 1000, amber: 1500 });
  assert.deepEqual(th.vis, { red: 2, crit: 4, amber: 5 });
  assert.equal(MN.bandProblems(MN.DEFAULTS.bands).length, 0);
  assert.equal(MN.bandProblems({ amberCeil: 200, critCeil: 300, amberVis: 3, critVis: 2 }).length, 1);
});
