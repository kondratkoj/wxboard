// Local copy of US NOTAMs, kept in sync with the FAA NMS-API inside its production limits:
//   - Full load: DOMESTIC + FDC + MILITARY, at most once per 24 h (FAA counts the three pulls as one load).
//   - Deltas: one lastUpdatedDate pull every 3 minutes (+10 s margin), 60 s overlap, back off on HTTP 429.
//   - Saved to data/notams.json so restarting the server does NOT trigger another full load.
// Searches read only this local copy, so they cost zero API calls.
const fs = require('fs');
const path = require('path');
const config = require('./config');
const nms = require('./sources/nms');
const geo = require('./geo');

const CLASSES = ['DOMESTIC', 'FDC', 'MILITARY'];
const FULL_EVERY_MS = 24 * 3600e3;
const DELTA_EVERY_MS = Number(process.env.WX_TEST_DELTA_MS) || 3 * 60e3 + 10e3; // env override is for automated tests only
const DELTA_OVERLAP_MS = 60e3;
const FAILED_FULL_RETRY_MS = 60 * 60e3; // a failed classification is retried after 1 h, not immediately
const DATA_DIR = path.join(__dirname, '..', 'data');

const state = {
  notams: new Map(),     // id -> record (+ bbox)
  fullAt: {},            // classification -> ms of last successful full pull
  fullTriedAt: {},       // classification -> ms of last attempt (success or not)
  deltaAt: null,         // ms: the "since" point the next delta should start from
  lastDeltaRun: null,
  lastPullAt: null,      // ms of the last request that pulled NOTAM data (any kind)
  status: 'idle',        // idle | loading | ready | error
  lastError: null,
  busy: false,
};

// ---------- geometry helpers ----------
function bboxOf(g) {
  if (!g) return null;
  const e = geo.explode(g);
  const pts = [...e.points, ...e.lines.flat(), ...e.rings.flat()];
  if (!pts.length) return null;
  let a = Infinity, b = Infinity, c = -Infinity, d = -Infinity;
  for (const p of pts) { a = Math.min(a, p.lat); b = Math.min(b, p.lon); c = Math.max(c, p.lat); d = Math.max(d, p.lon); }
  return [a, b, c, d]; // minLat, minLon, maxLat, maxLon
}
const withBbox = (r) => ({ ...r, bbox: bboxOf(r.geometry) });

// ---------- persistence ----------
// Two files so the big one isn't rewritten every 3 minutes:
//   notams-<env>.json  all records + the delta point they are consistent with (saved after full loads, then every 30 min)
//   sync-<env>.json    small: timestamps used to respect the FAA spacing rules (saved every update)
const RECORDS_FILE = () => path.join(DATA_DIR, `notams-${config.nms.env}.json`);
const META_FILE = () => path.join(DATA_DIR, `sync-${config.nms.env}.json`);
const RECORDS_SAVE_EVERY_MS = 30 * 60e3;
let recordsSavedAt = 0;

function writeAtomic(file, obj) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(file + '.tmp', JSON.stringify(obj));
  fs.renameSync(file + '.tmp', file);
}

function save(force = false) {
  try {
    writeAtomic(META_FILE(), { fullTriedAt: state.fullTriedAt, lastPullAt: state.lastPullAt, lastDeltaRun: state.lastDeltaRun });
    if (force || now() - recordsSavedAt >= RECORDS_SAVE_EVERY_MS) {
      writeAtomic(RECORDS_FILE(), {
        version: 1, env: config.nms.env, fullAt: state.fullAt, deltaAt: state.deltaAt,
        notams: [...state.notams.values()].map(({ bbox, ...r }) => r),
      });
      recordsSavedAt = now();
    }
  } catch (e) {
    console.error('  NOTAMs: could not save local copy:', e.message);
  }
}

function load() {
  try {
    const m = JSON.parse(fs.readFileSync(META_FILE(), 'utf8'));
    state.fullTriedAt = m.fullTriedAt || {};
    state.lastPullAt = m.lastPullAt || null;
    state.lastDeltaRun = m.lastDeltaRun || null;
  } catch { /* none yet */ }
  try {
    const j = JSON.parse(fs.readFileSync(RECORDS_FILE(), 'utf8'));
    state.fullAt = j.fullAt || {};
    state.deltaAt = j.deltaAt || null; // catch-up deltas start from when these records were saved
    state.notams = new Map((j.notams || []).map((r) => [r.id, withBbox(r)]));
    recordsSavedAt = now();
    console.log(`  NOTAMs:  loaded ${state.notams.size.toLocaleString()} from disk`);
  } catch { /* no saved copy yet */ }
}

// ---------- applying data ----------
const now = () => Date.now();
const isGone = (r, t = now()) =>
  (r.canceled && Date.parse(r.canceled) <= t) ||
  // Expired NOTAMs aren't sent in deltas, so drop them by end time. Estimated (EST) ends are kept
  // until cancelled or replaced, shown as "past estimated end", because they may be extended.
  (!r.estimated && r.end && r.end !== 'PERM' && Date.parse(r.end) < t);

function apply(records) {
  let added = 0, removed = 0;
  for (const r of records) {
    if (!r || !r.id) continue;
    if (isGone(r)) { if (state.notams.delete(r.id)) removed++; continue; }
    if (!state.notams.has(r.id)) added++;
    state.notams.set(r.id, withBbox(r));
  }
  return { added, removed };
}

function prune() {
  const t = now();
  for (const [id, r] of state.notams) if (isGone(r, t)) state.notams.delete(id);
}

// ---------- sync ----------
// A classification can be pulled when its full set is old (or missing) AND the retry spacing has passed.
function fullPullable(cls, t = now()) {
  const due = !state.fullAt[cls] || t - state.fullAt[cls] >= FULL_EVERY_MS;
  const retryOk = !state.fullTriedAt[cls] || t - state.fullTriedAt[cls] >= (state.fullAt[cls] ? FULL_EVERY_MS : FAILED_FULL_RETRY_MS);
  return due && retryOk;
}

async function fullLoad() {
  const t = now();
  for (const cls of CLASSES) {
    if (!fullPullable(cls, t)) continue;
    state.fullTriedAt[cls] = state.lastPullAt = now();
    state.status = state.notams.size ? state.status : 'loading';
    try {
      console.log(`  NOTAMs:  downloading full ${cls} set…`);
      const recs = await nms.fullClassification(cls);
      // Replace this classification's records with the fresh set.
      for (const [id, r] of state.notams) if (classOf(r) === cls) state.notams.delete(id);
      apply(recs);
      state.fullAt[cls] = now();
      console.log(`  NOTAMs:  ${cls} done (${recs.length.toLocaleString()} received)`);
    } catch (e) {
      state.lastError = `Full ${cls} download: ${e.message}`;
      console.error('  NOTAMs:', state.lastError);
    }
    save(true);
  }
  // Start deltas from the oldest full pull so nothing between pulls is missed.
  // Deltas continue from the oldest fresh full pull, so nothing between pulls is missed.
  const fresh = Object.values(state.fullAt).filter((x) => now() - x < FULL_EVERY_MS);
  if (fresh.length) state.deltaAt = Math.max(state.deltaAt || 0, Math.min(...fresh));
}

// NMS classification codes in records are abbreviated (e.g. "DOM"); map them back.
function classOf(r) {
  const c = String(r.classification || '').toUpperCase();
  if (c.startsWith('DOM')) return 'DOMESTIC';
  if (c.startsWith('FDC')) return 'FDC';
  if (c === 'LMIL' || c.startsWith('LOCAL')) return 'LOCAL_MILITARY';
  if (c.startsWith('MIL')) return 'MILITARY';
  if (c.startsWith('INT')) return 'INTERNATIONAL';
  return c;
}

async function deltaPull() {
  const t = now();
  // The API only allows lastUpdatedDate within the last 24 h.
  let since = Math.max((state.deltaAt || t) - DELTA_OVERLAP_MS, t - 24 * 3600e3 + 5 * 60e3);
  const startedAt = t;
  state.lastPullAt = t;
  const recs = await nms.delta(new Date(since).toISOString().replace(/\.\d{3}Z$/, 'Z'));
  const { added, removed } = apply(recs);
  state.deltaAt = startedAt;
  state.lastDeltaRun = startedAt;
  if (recs.length) console.log(`  NOTAMs:  update: ${recs.length} changed (${added} new, ${removed} removed)`);
}

async function tick() {
  if (state.busy) return;
  state.busy = true;
  let wait = DELTA_EVERY_MS;
  try {
    // If the saved copy is too old for a delta to catch up, a full load is needed.
    const stale = !state.deltaAt || now() - state.deltaAt > 23 * 3600e3;
    // A classification that failed and is waiting out its retry spacing must not block deltas for the rest.
    if (stale || CLASSES.some((c) => fullPullable(c))) {
      await fullLoad();
      if (!state.notams.size) throw new Error(state.lastError || 'no NOTAMs downloaded yet');
    } else {
      await deltaPull();
    }
    prune();
    state.status = 'ready';
    state.lastError = null;
    save();
  } catch (e) {
    state.lastError = e.message;
    state.status = state.notams.size ? 'ready' : 'error';
    if (e.status === 429) wait = DELTA_EVERY_MS * 2;
    console.error('  NOTAMs: sync problem:', e.message);
    save();
  } finally {
    state.busy = false;
    setTimeout(tick, wait).unref?.();
  }
}

function start() {
  if (config.demo) return startDemo();
  if (!nms.configured()) return;
  load();
  if (state.notams.size) state.status = 'ready';
  // After a quick restart, wait out the FAA's 3-minute spacing from the last pull before pulling again.
  const sinceLast = state.lastPullAt ? now() - state.lastPullAt : Infinity;
  setTimeout(tick, Math.max(0, Math.min(DELTA_EVERY_MS - sinceLast, DELTA_EVERY_MS))).unref?.();
}

// Demo mode: seed from fixtures, no network.
function startDemo() {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'nms-notams.json'), 'utf8'));
    const delta = Math.floor(Date.now() / 1000) - j.__base;
    const shift = (s) => (s && !/^PERM/.test(s) && Number.isFinite(Date.parse(s)) ? new Date(Date.parse(s) + delta * 1000).toISOString() : s);
    for (const v of Object.values(j.data.variants)) {
      for (const f of (v.data && v.data.geojson) || []) {
        const n = f.properties.coreNOTAMData.notam;
        n.effectiveStart = shift(n.effectiveStart); n.effectiveEnd = shift(n.effectiveEnd);
        apply([nms.normalise(f)]);
      }
    }
    state.status = 'ready';
    state.deltaAt = state.lastDeltaRun = now();
  } catch (e) {
    state.status = 'error'; state.lastError = 'demo data: ' + e.message;
  }
}

// ---------- queries ----------
function matchesAirport(r, id) {
  const loc = String(r.location || '').toUpperCase();
  const icao = String(r.icaoLocation || '').toUpperCase();
  return icao === id || loc === id || (id.length === 4 && id[0] === 'K' && loc === id.slice(1));
}

function query({ anchorIds, shape, radiusNm, bbox }) {
  prune();
  const out = [];
  const seen = new Set();
  for (const r of state.notams.values()) {
    const key = r.number ? `${r.location || r.icaoLocation}-${r.number}` : r.id;
    if (seen.has(key)) continue;
    const apt = anchorIds.find((id) => matchesAirport(r, id));
    if (apt) { seen.add(key); out.push({ ...r, scope: 'airport', airport: apt }); continue; }
    if (!r.bbox || !r.geometry) continue;
    const [a, b, c, d] = r.bbox;
    if (c < bbox.minLat || a > bbox.maxLat || d < bbox.minLon || b > bbox.maxLon) continue;
    if (geo.shapeDistToGeometry(shape, r.geometry) <= radiusNm) {
      seen.add(key);
      out.push({ ...r, scope: 'area', airport: r.icaoLocation || r.location || '?' });
    }
  }
  return out.map(({ geometry, bbox: _b, ...r }) => r);
}

function status() {
  return {
    configured: nms.configured(),
    env: config.nms.env,
    status: state.status,
    count: state.notams.size,
    lastUpdate: state.lastDeltaRun || Math.max(0, ...Object.values(state.fullAt)) || null,
    fullAt: state.fullAt,
    lastError: state.lastError,
  };
}

module.exports = { start, query, status, _state: state, _apply: apply, _isGone: isGone, _classOf: classOf };
