const test = require('node:test');
const assert = require('node:assert/strict');
const fc = require('../lib/flightcat');

test('parseVis handles whole, fractional, mixed and P/M forms', () => {
  assert.equal(fc.parseVis('10+'), 10);
  assert.equal(fc.parseVis('P6SM'), 6);
  assert.equal(fc.parseVis('1/2'), 0.5);
  assert.equal(fc.parseVis('M1/4'), 0.25);
  assert.equal(fc.parseVis('1 1/2'), 1.5);
  assert.equal(fc.parseVis(3), 3);
  assert.equal(fc.parseVis(''), null);
});

test('ceilingFt uses the lowest BKN/OVC layer or vertical visibility', () => {
  assert.equal(fc.ceilingFt([{ cover: 'FEW', base: 800 }, { cover: 'BKN', base: 2500 }, { cover: 'OVC', base: 4000 }]), 2500);
  assert.equal(fc.ceilingFt([{ cover: 'SCT', base: 800 }]), null);
  assert.equal(fc.ceilingFt([], 2), 200);
  assert.equal(fc.ceilingFt([{ cover: 'OVC', base: 900 }], 300), 300);
});

test('category thresholds', () => {
  assert.equal(fc.category(400, 10), 'LIFR');
  assert.equal(fc.category(5000, 0.5), 'LIFR');
  assert.equal(fc.category(900, 10), 'IFR');
  assert.equal(fc.category(5000, 2), 'IFR');
  assert.equal(fc.category(3000, 10), 'MVFR');
  assert.equal(fc.category(null, 5), 'MVFR');
  assert.equal(fc.category(3100, 6), 'VFR');
  assert.equal(fc.category(null, null), null);
});

test('worst picks the most restrictive category', () => {
  assert.equal(fc.worst(['VFR', 'IFR', 'MVFR', null]), 'IFR');
  assert.equal(fc.worst([]), null);
});

test('tafPeriods carries BECMG fields over and flags TEMPO as conditional', () => {
  const periods = fc.tafPeriods({ fcsts: [
    { timeFrom: 0, timeTo: 10, visib: '6+', clouds: [{ cover: 'OVC', base: 2000 }] },
    { fcstChange: 'BECMG', timeFrom: 10, timeTo: 20, clouds: [{ cover: 'OVC', base: 800 }] },
    { fcstChange: 'TEMPO', timeFrom: 12, timeTo: 14, visib: '1/2' },
  ] });
  assert.equal(periods[0].fltCat, 'MVFR');
  assert.equal(periods[1].visSM, 6); // carried over from the previous period
  assert.equal(periods[1].fltCat, 'IFR');
  assert.equal(periods[2].conditional, true);
  assert.equal(periods[2].fltCat, 'LIFR');
});
