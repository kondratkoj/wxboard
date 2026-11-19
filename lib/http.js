// Fetch with timeout, User-Agent, in-memory TTL cache, and an offline demo mode.
const fs = require('fs');
const path = require('path');
const config = require('./config');

const cache = new Map(); // key -> { at, ttl, value } or { pending }

function fixtureFor(url) {
  // Demo mode: map a URL to a JSON file in /fixtures by a simple rule.
  const u = new URL(url);
  let name;
  if (u.hostname === 'aviationweather.gov') name = 'awc-' + u.pathname.split('/').pop();
  else if (u.hostname === 'api.open-meteo.com') name = 'openmeteo';
  else if (u.hostname === 'mesonet.agron.iastate.edu') name = 'iem-lav';
  else if (u.hostname === 'api.weather.gov') name = u.pathname.startsWith('/points') ? 'nws-points' : u.pathname.endsWith('/hourly') ? 'nws-hourly' : 'nws-forecast';
  else if (u.hostname === 'tfr.faa.gov') name = u.pathname.includes('geoserver') ? 'tfr-wfs' : 'tfr-list';
  else if (u.pathname.includes('/auth/token')) name = 'nms-token';
  else if (u.pathname.includes('/notams')) name = 'nms-notams';
  else throw new Error('No demo fixture for ' + url);
  const file = path.join(__dirname, '..', 'fixtures', name + '.json');
  let data = JSON.parse(fs.readFileSync(file, 'utf8'));
  // Demo fixtures were captured at a fixed time; slide their timestamps up to "now".
  if (data && data.__base) data = shiftTimes(data.data, Math.floor(Date.now() / 1000) - data.__base);
  // Fixtures can hold per-location variants keyed by an "ids"/"location" value.
  if (data && data.__text !== undefined) return data.__text;
  if (data && data.__byParam) {
    const key = u.searchParams.get(data.__byParam) || '';
    const v = data.variants[key] ?? data.variants.default ?? [];
    return v && v.__text !== undefined ? v.__text : v;
  }
  return data;
}

const EPOCH_KEYS = new Set(['obsTime', 'validTimeFrom', 'validTimeTo', 'timeFrom', 'timeTo', 'timeBec']);
const ISO_KEYS = new Set(['effectiveStart', 'effectiveEnd', 'issueTime', 'validTime', 'reportTime', 'runtime_utc', 'ftime_utc', 'startTime']);
function shiftTimes(v, delta) {
  if (Array.isArray(v)) return v.map((x) => shiftTimes(x, delta));
  if (v && typeof v === 'object') {
    const o = {};
    for (const [k, x] of Object.entries(v)) {
      if (EPOCH_KEYS.has(k) && typeof x === 'number') o[k] = x + delta;
      else if (k === 'time' && Array.isArray(x) && x.every((n) => typeof n === 'number')) o[k] = x.map((n) => n + delta);
      else if (ISO_KEYS.has(k) && typeof x === 'string' && Number.isFinite(Date.parse(x))) o[k] = new Date(Date.parse(x) + delta * 1000).toISOString();
      else o[k] = shiftTimes(x, delta);
    }
    return o;
  }
  return v;
}

async function rawFetch(url, opts = {}) {
  if (config.demo) {
    await new Promise((r) => setTimeout(r, 60));
    return fixtureFor(url);
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs || 15000);
  try {
    const res = await fetch(url, {
      method: opts.method || 'GET',
      body: opts.body,
      signal: ctrl.signal,
      headers: { 'User-Agent': config.userAgent, Accept: opts.text ? 'text/plain, */*' : 'application/json, application/geo+json', ...(opts.headers || {}) },
    });
    if (res.status === 204) return [];
    const text = await res.text();
    if (!res.ok) throw new Error(`${res.status} from ${new URL(url).hostname}: ${text.slice(0, 200)}`);
    if (opts.text) return text;
    if (!text.trim()) return [];
    try { return JSON.parse(text); } catch { throw new Error(`Non-JSON reply from ${new URL(url).hostname}`); }
  } finally {
    clearTimeout(timer);
  }
}

// Cached GET. Concurrent callers for the same key share one request.
async function getJson(url, ttlSec, opts = {}) {
  const key = opts.cacheKey || url;
  const hit = cache.get(key);
  const now = Date.now();
  if (hit && hit.value !== undefined && now - hit.at < hit.ttl * 1000) return hit.value;
  if (hit && hit.pending) return hit.pending;
  const pending = rawFetch(url, opts)
    .then((value) => { cache.set(key, { at: Date.now(), ttl: ttlSec, value }); return value; })
    .catch((err) => {
      // Serve stale data if we have it, rather than blanking the board.
      if (hit && hit.value !== undefined) { cache.set(key, hit); return hit.value; }
      cache.delete(key);
      throw err;
    });
  cache.set(key, { ...(hit || {}), pending });
  return pending;
}

function cacheStats() {
  return { entries: cache.size };
}

module.exports = { getJson, rawFetch, cacheStats };
