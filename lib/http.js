// Fetch with timeout, User-Agent, in-memory TTL cache, and an offline demo mode.
const fs = require('fs');
const path = require('path');
const { AsyncLocalStorage } = require('async_hooks');
const config = require('./config');

// When a source can't be refreshed we serve its last good copy. That must never be silent: anything that runs
// inside trackStale() gets a list of every old copy it was given, so the brief can say so on the page.
const staleScope = new AsyncLocalStorage();
function trackStale(fn) {
  const notes = [];
  return staleScope.run(notes, async () => ({ value: await fn(), stale: notes }));
}
const sourceName = (url) => { try { const u = new URL(url); return `${u.hostname} ${u.pathname.split('/').filter(Boolean).pop() || ''}`.trim(); } catch { return 'a source'; } };
function noteStale(url, entry) {
  const notes = staleScope.getStore();
  if (!notes) return;
  const source = sourceName(url);
  if (!notes.some((n) => n.source === source && n.since === entry.at)) notes.push({ source, since: entry.at, error: entry.lastError || 'refresh failed' });
}

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

// Some sources refuse too many requests at once (Open-Meteo answers 429 "Too many concurrent requests").
// Requests to these hosts wait their turn, server-wide. Cached answers never wait.
const HOST_CONCURRENCY = { 'api.open-meteo.com': 2 };
const hostSlots = new Map(); // host -> { active, queue: [resolve] }
async function withHostSlot(host, fn) {
  const max = HOST_CONCURRENCY[host];
  if (!max) return fn();
  const h = hostSlots.get(host) || { active: 0, queue: [] };
  hostSlots.set(host, h);
  if (h.active >= max) await new Promise((resolve) => h.queue.push(resolve));
  h.active++;
  try { return await fn(); } finally {
    h.active--;
    const next = h.queue.shift();
    if (next) next();
  }
}

async function rawFetch(url, opts = {}) {
  let host = '';
  try { host = new URL(url).hostname; } catch {}
  return withHostSlot(host, () => rawFetchNow(url, opts));
}

async function rawFetchNow(url, opts = {}) {
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

const FAIL_RETRY_MS = 60e3;        // after a failed fetch, don't ask that source again for up to 1 min
const STALE_KEEP_MS = 3 * 3600e3;  // keep expired data this long to serve if the source goes down
const MAX_ENTRIES = 1000;

// Cached GET. Concurrent callers for the same key share one request.
// On failure: serve the last good copy if there is one, otherwise rethrow; either way, wait a little before
// retrying that source so a dead feed isn't hit on every request.
async function getJson(url, ttlSec, opts = {}) {
  const key = opts.cacheKey || url;
  const hit = cache.get(key);
  const now = Date.now();
  if (hit) {
    if (hit.pending) {
      // Sharing someone else's request: if it ends up serving an old copy, note that for this caller too.
      return hit.pending.then((v) => { const e = cache.get(key); if (e && e.failing && e.value === v) noteStale(url, e); return v; });
    }
    if (hit.value !== undefined && now - hit.at < hit.ttl * 1000) return hit.value;
    if (hit.value !== undefined && now < (hit.retryAt || 0)) { noteStale(url, hit); return hit.value; } // failing source: old copy
    if (hit.error && now < hit.retryAt) throw hit.error;
  }
  const prev = hit && hit.value !== undefined ? { at: hit.at, ttl: hit.ttl, value: hit.value } : null;
  const wasFailing = Boolean(hit && (hit.failing || hit.error));
  const pending = rawFetch(url, opts)
    .then((value) => {
      cache.set(key, { at: Date.now(), ttl: ttlSec, value });
      if (wasFailing) console.log(`  Source OK again: ${sourceName(url)}`);
      return value;
    })
    .catch((err) => {
      const retryAt = Date.now() + Math.min(FAIL_RETRY_MS, ttlSec * 1000);
      // Log when a source starts failing, not on every retry.
      if (!wasFailing) console.error(`  Source problem: ${sourceName(url)}: ${err.message}${prev ? ` (serving the copy from ${new Date(prev.at).toISOString().slice(11, 16)}Z)` : ''}`);
      if (prev) {
        const entry = { ...prev, retryAt, failing: true, lastError: err.message };
        cache.set(key, entry);
        noteStale(url, entry);
        return prev.value;
      }
      cache.set(key, { error: err, retryAt });
      throw err;
    });
  cache.set(key, { ...(prev || {}), pending });
  return pending;
}

// Drop data too old to be worth serving, expired error markers, and (if still too big) the oldest entries.
function sweep(now = Date.now()) {
  for (const [k, e] of cache) {
    if (e.pending) continue;
    if (e.error ? now >= e.retryAt : now - e.at > e.ttl * 1000 + STALE_KEEP_MS) cache.delete(k);
  }
  if (cache.size > MAX_ENTRIES) {
    const old = [...cache].filter(([, e]) => !e.pending).sort((a, b) => (a[1].at || 0) - (b[1].at || 0));
    for (const [k] of old.slice(0, cache.size - MAX_ENTRIES)) cache.delete(k);
  }
}
setInterval(sweep, 10 * 60e3).unref();

function cacheStats() {
  return { entries: cache.size };
}

module.exports = { getJson, rawFetch, cacheStats, sweep, trackStale, HOST_CONCURRENCY, _cache: cache };
