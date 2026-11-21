const test = require('node:test');
const assert = require('node:assert/strict');

// Fake eCFR: each test sets what the "current" regulation looks like.
const http = require('../lib/http');
let world = {};
http.rawFetch = async (url) => {
  const sec = new URL(url).searchParams.get('section');
  const w = world[sec] || {};
  if (w.fail) throw new Error('network down');
  if (url.includes('/versions/')) return { meta: { latest_amendment_date: w.latest, latest_issue_date: w.latest }, content_versions: [{ removed: Boolean(w.removed) }] };
  return w.text;
};
const regs = require('../lib/regs');

function currentWorld() {
  world = {};
  for (const c of regs.CITED) world[c.section] = { latest: c.basedOn || '2026-07-24', text: c.phrases.map((p) => (p === 'er21fe14.021' ? '<img src="/graphics/er21fe14.021.gif"></img>' : p)).join(' ') };
}

test('all current: nothing flagged', async () => {
  currentWorld();
  await regs.checkAll();
  const s = regs.status();
  assert.equal(s.changed.length, 0);
  assert.ok(s.items.every((i) => i.status === 'current'));
  assert.equal(s.overdue, false);
});

test('a later amendment, changed text and a removed section are all flagged', async () => {
  currentWorld();
  world['91.155'].latest = '2027-03-01';
  world['95.13'].text = 'something else entirely';
  world['91.157'].removed = true;
  world['135.609'].text = 'when conducting VFR helicopter air ambulance operations in Class G airspace <img src="/graphics/er27ja03.001.gif"></img>';
  await regs.checkAll();
  const by = Object.fromEntries(regs.status().changed.map((c) => [c.section, c]));
  assert.equal(by['91.155'].status, 'amended');
  assert.equal(by['91.155'].latest, '2027-03-01');
  assert.equal(by['95.13'].status, 'text-changed');
  assert.equal(by['91.157'].status, 'removed');
  assert.equal(by['135.609'].status, 'text-changed'); // the table image was replaced
});

test('§ 1.1 amendments alone are not a change (only its night definition is watched)', async () => {
  currentWorld();
  world['1.1'].latest = '2030-01-01';
  await regs.checkAll();
  assert.equal(regs.status().changed.length, 0);
});

test('eCFR unreachable: the last answer stays, nothing is marked current that was changed', async () => {
  currentWorld();
  world['91.155'].latest = '2027-03-01';
  await regs.checkAll();
  for (const k of Object.keys(world)) world[k].fail = true;
  await regs.checkAll();
  const s = regs.status();
  assert.equal(s.changed.length, 1);
  assert.equal(s.changed[0].section, '91.155');
  assert.ok(s.lastOkAt);
});
