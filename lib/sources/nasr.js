// FAA NASR "Class Airspace" (CLS_ARSP) data: the published hours of part-time Class B/C/D/E surface areas
// (the Chart Supplement's "AIRSPACE: CLASS D svc … other times CLASS E" line), keyed by FAA airport ID.
//
// Source: the 28-day NASR subscription, nfdc.faa.gov/webContent/28DaySub/extra/<DD_Mon_YYYY>_CLS_ARSP_CSV.zip
// (under 1 MB). Downloaded once per cycle, kept in data/nasr/, reloaded from disk after a restart. If the current
// cycle can't be downloaded the newest saved cycle is used and reported as old. Columns (CLS_ARSP_CSV_DATA_STRUCTURE):
// EFF_DATE, SITE_NO, SITE_TYPE_CODE, STATE_CODE, ARPT_ID, CITY, COUNTRY_CODE, CLASS_B_AIRSPACE, CLASS_C_AIRSPACE,
// CLASS_D_AIRSPACE, CLASS_E_AIRSPACE, AIRSPACE_HRS, REMARK.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const config = require('../config');

const DIR = path.join(config.dataDir, 'nasr');
const KNOWN_CYCLE = Date.UTC(2026, 9, 29); // 2026-10-29, a NASR effective date (checked against the file's EFF_DATE)
const CYCLE_MS = 28 * 86400e3;
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

let state = { cycle: null, current: false, byId: new Map(), loadedAt: null, error: null };

// Effective date (UTC midnight) of the cycle in force at `ms`. Cycles start 0901Z; a few hours early doesn't matter here.
function cycleAt(ms) {
  const k = Math.floor((ms - KNOWN_CYCLE) / CYCLE_MS);
  return KNOWN_CYCLE + k * CYCLE_MS;
}
const isoDay = (ms) => new Date(ms).toISOString().slice(0, 10);
const fileName = (c) => { const d = new Date(c); return `${String(d.getUTCDate()).padStart(2, '0')}_${MON[d.getUTCMonth()]}_${d.getUTCFullYear()}_CLS_ARSP_CSV.zip`; };

// Minimal zip reader (stored or deflated entries), enough for this one small file.
function unzip(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('not a zip file');
  const n = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out = {};
  for (let k = 0; k < n; k++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('bad zip directory');
    const method = buf.readUInt16LE(p + 10), csize = buf.readUInt32LE(p + 20);
    const nlen = buf.readUInt16LE(p + 28), elen = buf.readUInt16LE(p + 30), clen = buf.readUInt16LE(p + 32), off = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nlen);
    const start = off + 30 + buf.readUInt16LE(off + 26) + buf.readUInt16LE(off + 28);
    const data = buf.subarray(start, start + csize);
    if (method === 0) out[name] = data; else if (method === 8) out[name] = zlib.inflateRawSync(data);
    p += 46 + nlen + elen + clen;
  }
  return out;
}

function parseCsvLine(line) {
  const out = []; let cur = '', q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) { if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') q = false; else cur += ch; }
    else if (ch === '"') q = true; else if (ch === ',') { out.push(cur); cur = ''; } else cur += ch;
  }
  out.push(cur);
  return out;
}
function index(csv) {
  const lines = String(csv).split(/\r?\n/).filter(Boolean);
  const head = parseCsvLine(lines[0]);
  const col = (n) => head.indexOf(n);
  const iId = col('ARPT_ID'), iH = col('AIRSPACE_HRS'), iR = col('REMARK'), iE = col('EFF_DATE');
  if (iId < 0 || iH < 0) throw new Error('CLS_ARSP.csv: expected columns missing (format changed?)');
  const byId = new Map();
  let eff = null;
  for (const l of lines.slice(1)) {
    const r = parseCsvLine(l);
    if (!r[iId]) continue;
    eff = eff || r[iE] || null;
    byId.set(r[iId].trim().toUpperCase(), { hours: (r[iH] || '').replace(/\s+/g, ' ').trim() || null, remark: (iR >= 0 && r[iR]) || null });
  }
  return { byId, eff };
}

function load(cycle, csv, current) {
  const { byId, eff } = index(csv);
  state = { cycle: isoDay(cycle), eff, current, byId, loadedAt: new Date().toISOString(), error: null };
}

async function download(cycle) {
  const url = `https://nfdc.faa.gov/webContent/28DaySub/extra/${fileName(cycle)}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 60000);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': config.userAgent } });
    if (!res.ok) throw new Error(`${res.status} for ${fileName(cycle)}`);
    const files = unzip(Buffer.from(await res.arrayBuffer()));
    const csv = files['CLS_ARSP.csv'];
    if (!csv) throw new Error('CLS_ARSP.csv not in the zip');
    return csv.toString('utf8');
  } finally { clearTimeout(timer); }
}

const savedPath = (cycle) => path.join(DIR, `CLS_ARSP_${isoDay(cycle)}.csv`);
function newestSaved() {
  try {
    const f = fs.readdirSync(DIR).filter((n) => /^CLS_ARSP_\d{4}-\d{2}-\d{2}\.csv$/.test(n)).sort().pop();
    return f ? { cycle: Date.parse(f.slice(9, 19)), file: path.join(DIR, f) } : null;
  } catch { return null; }
}

// Make sure the current cycle is loaded: from disk, else download, else the newest saved cycle (marked old).
async function refresh(now = Date.now()) {
  if (config.demo) {
    load(cycleAt(now), fs.readFileSync(path.join(__dirname, '..', '..', 'fixtures', 'nasr-cls-arsp.csv'), 'utf8'), true);
    return state;
  }
  const cycle = cycleAt(now);
  if (state.cycle === isoDay(cycle) && state.current) return state;
  try { load(cycle, fs.readFileSync(savedPath(cycle), 'utf8'), true); return state; } catch {}
  try {
    const csv = await download(cycle);
    fs.mkdirSync(DIR, { recursive: true });
    fs.writeFileSync(savedPath(cycle), csv);
    load(cycle, csv, true);
    console.log(`  Airspace hours: NASR cycle ${isoDay(cycle)} loaded (${state.byId.size} airports).`);
  } catch (e) {
    const old = newestSaved();
    if (old && !state.cycle) { try { load(old.cycle, fs.readFileSync(old.file, 'utf8'), false); } catch {} }
    if (state.cycle && state.cycle !== isoDay(cycle)) state.current = false;
    state.error = e.message;
    console.error(`  Airspace hours: couldn't download NASR cycle ${isoDay(cycle)} (${e.message})${state.cycle ? `; using ${state.cycle}` : ''}.`);
  }
  return state;
}

let timer = null;
function start() {
  if (timer) return;
  refresh().catch(() => {});
  timer = setInterval(() => refresh().catch(() => {}), 6 * 3600e3); timer.unref();
}

const hoursFor = (ident) => (ident ? state.byId.get(String(ident).toUpperCase()) || null : null);
const status = () => ({ cycle: state.cycle, current: state.current, airports: state.byId.size, error: state.error });

module.exports = { start, refresh, hoursFor, status, cycleAt, fileName, unzip, index, _load: load };
