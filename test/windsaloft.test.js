// Winds aloft are fetched again only when Open-Meteo reports a newer model run (plus its 10-minute settle time).
const test = require('node:test');
const assert = require('node:assert/strict');

delete process.env.DEMO;
const http = require('../lib/http');
const winds = require('../lib/sources/windsaloft');

const now = () => Math.floor(Date.now() / 1000);
let avail = now() - 3600; // the current run became available an hour ago
let forecastCalls = 0;
const profile = () => {
  const hourly = { time: [now()] };
  for (const p of winds.LEVELS_HPA) {
    hourly[`wind_speed_${p}hPa`] = [20]; hourly[`wind_direction_${p}hPa`] = [270];
    hourly[`temperature_${p}hPa`] = [0]; hourly[`geopotential_height_${p}hPa`] = [(1000 - p) * 10];
  }
  return { elevation: 100, hourly };
};
global.fetch = async (url) => {
  const body = /meta\.json/.test(url)
    ? { last_run_availability_time: avail, last_run_initialisation_time: avail - 4 * 3600 }
    : (forecastCalls++, profile());
  return { status: 200, ok: true, text: async () => JSON.stringify(body) };
};
const expireMeta = () => { for (const [k, e] of http._cache) if (/meta\.json/.test(k)) e.at -= 301e3; };

test('winds are kept until a new run is out, then fetched once', async () => {
  http._cache.clear(); winds._resetRun();
  await winds.pointForecast(35.26, -93.1);
  await winds.pointForecast(35.26, -93.1);
  assert.equal(forecastCalls, 1, 'same run: cached');
  assert.equal(winds.runInfo(), (avail - 4 * 3600) * 1000);

  // A new run appears but has only been out 2 minutes: keep the old one.
  avail = now() - 120; expireMeta();
  await winds.pointForecast(35.26, -93.1);
  assert.equal(forecastCalls, 1, 'new run not settled yet');

  // 10+ minutes later: fetch the new run once.
  avail = now() - 700; expireMeta();
  await winds.pointForecast(35.26, -93.1);
  await winds.pointForecast(35.26, -93.1);
  assert.equal(forecastCalls, 2, 'new run: one fetch');
});

test('without run info, winds fall back to an hourly refresh', async () => {
  http._cache.clear(); winds._resetRun(); forecastCalls = 0;
  const real = global.fetch;
  global.fetch = async (url) => (/meta\.json/.test(url) ? { status: 503, ok: false, text: async () => 'down' } : real(url));
  const oldErr = console.error; console.error = () => {};
  try {
    await winds.pointForecast(30.4, -84.35);
    const entry = [...http._cache.entries()].find(([k]) => /forecast/.test(k));
    assert.equal(entry[1].ttl, 3600);
    assert.equal(forecastCalls, 1);
  } finally { global.fetch = real; console.error = oldErr; }
});
