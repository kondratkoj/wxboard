// FAA NOTAM Management Service API (NMS-API) client.
// Built to the FAA OpenAPI spec (NMS-API 1.0.18, revised 2026-02-12) and the onboarding FAQ.
//
// FAA production usage rules (onboarding email + FAQ, Nov 2026):
//   - At most ONE delta pull every 3 minutes (lastUpdatedDate), with ~1 minute overlap recommended.
//     Exceeding it returns HTTP 429.
//   - At most ONE full load every 24 hours. Pulling each classification once (DOMESTIC, FDC,
//     MILITARY; LOCAL_MILITARY is empty) counts as one full load.
// So wxboard never queries NMS per search. lib/notamStore.js keeps a local copy and these
// functions are only called by its scheduler.
//
//   Auth:   POST {host}/v1/auth/token  (Basic id:secret, grant_type=client_credentials) -> token, 30 min
//   Delta:  GET  {host}/nmsapi/v1/notams?lastUpdatedDate=ISO  (header nmsResponseFormat: GEOJSON)
//   Full:   GET  {host}/nmsapi/v1/notams?classification=X&allowRedirect=false
//             -> { data: { url: "/nmsapi/v1/content/{token}" } }  (expires in 5 min)
//           GET  {host}{url}  (Bearer token) -> file of all NOTAMs in that classification
const zlib = require('zlib');
const { promisify } = require('util');
const gunzip = promisify(zlib.gunzip);
const config = require('../config');

const HOSTS = {
  prod: 'https://api-nms.aim.faa.gov',
  staging: 'https://api-staging.cgifederal-aim.com',
  fit: 'https://api-fit.cgifederal-aim.com',
};
const host = () => (config.nms.host || HOSTS[config.nms.env] || HOSTS.prod).replace(/\/+$/, '');

let token = null; // { value, exp }

// Size caps. V8 strings top out around 512 MB, so a bigger file couldn't be parsed anyway.
const MAX_JSON_BYTES = 50 * 1024 * 1024;       // ordinary API replies
const MAX_FILE_BYTES = 500 * 1024 * 1024;      // a bulk classification file, compressed or not

// Read a response body, giving up (and cancelling the download) once it passes maxBytes.
async function readLimited(res, maxBytes, label) {
  const len = Number(res.headers.get('content-length'));
  if (len > maxBytes) throw new NmsError(`${label} is too large (${Math.round(len / 1048576)} MB)`);
  if (!res.body) return Buffer.alloc(0);
  const chunks = [];
  let total = 0;
  for await (const chunk of res.body) {
    total += chunk.length;
    if (total > maxBytes) {
      res.body.cancel?.().catch(() => {});
      throw new NmsError(`${label} is larger than ${Math.round(maxBytes / 1048576)} MB; download stopped`);
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c)));
}

function configured() {
  return Boolean(config.demo || (config.nms.clientId && config.nms.clientSecret));
}

class NmsError extends Error {
  constructor(msg, status) { super(msg); this.status = status; }
}

async function request(url, { method = 'GET', headers = {}, body, binary = false, timeoutMs = 120000 } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { method, headers: { 'User-Agent': config.userAgent, ...headers }, body, signal: ctrl.signal, redirect: 'manual' });
    if (res.status === 429) throw new NmsError('NMS rate limit reached (HTTP 429)', 429);
    if (res.status >= 300 && res.status < 400) {
      // Should not happen with allowRedirect=false, but handle a redirect to a content path.
      const loc = res.headers.get('location');
      return { redirect: loc };
    }
    const buf = await readLimited(res, binary ? MAX_FILE_BYTES : MAX_JSON_BYTES, `Reply from ${new URL(url).hostname}`);
    if (!res.ok) throw new NmsError(`${res.status} from ${new URL(url).hostname}: ${buf.toString('utf8').slice(0, 200)}`, res.status);
    if (binary) return buf;
    const text = buf.toString('utf8');
    try { return JSON.parse(text); } catch { throw new NmsError(`Non-JSON reply from ${new URL(url).hostname}`, res.status); }
  } finally {
    clearTimeout(timer);
  }
}

async function getToken() {
  if (token && Date.now() < token.exp) return token.value;
  const basic = Buffer.from(`${config.nms.clientId}:${config.nms.clientSecret}`).toString('base64');
  let data;
  try {
    data = await request(`${host()}/v1/auth/token`, {
      method: 'POST',
      headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'grant_type=client_credentials',
      timeoutMs: 20000,
    });
  } catch (e) {
    throw new NmsError(`NMS login failed (${e.message}). Check the client ID/secret and that "nmsEnv" matches the environment your credentials were issued for.`, e.status);
  }
  if (!data || !data.access_token) throw new NmsError('NMS login failed: no access_token returned');
  const ttl = Number(data.expires_in) > 0 ? Number(data.expires_in) : 1799;
  token = { value: data.access_token, exp: Date.now() + (ttl - 60) * 1000 };
  return token.value;
}

const first = (...vals) => vals.find((v) => v !== undefined && v !== null && v !== '');
function parseTime(v) {
  if (!v) return null;
  if (/^PERM/i.test(v)) return 'PERM';
  const t = Date.parse(v);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

// Round coordinates to save memory/disk (4 decimals ≈ 11 m).
function slimGeometry(g) {
  if (!g) return null;
  const r = (c) => (Array.isArray(c[0]) ? c.map(r) : [Math.round(c[0] * 1e4) / 1e4, Math.round(c[1] * 1e4) / 1e4]);
  if (g.type === 'GeometryCollection') {
    const geoms = (g.geometries || []).map(slimGeometry).filter(Boolean);
    return geoms.length ? { type: 'GeometryCollection', geometries: geoms } : null;
  }
  if (!g.coordinates) return null;
  try { return { type: g.type, coordinates: r(g.coordinates) }; } catch { return null; }
}

// GeoJSON Feature -> compact record.
function normalise(feature) {
  const core = (feature && feature.properties && feature.properties.coreNOTAMData) || {};
  const n = core.notam || {};
  const tr = core.notamTranslation || [];
  const local = tr.find((t) => t.type === 'LOCAL_FORMAT');
  const icao = tr.find((t) => t.type === 'ICAO');
  const id = String(first(n.id, '')).replace(/^NMS_ID_/, '') || `${n.location}-${n.number}`;
  return {
    id,
    number: n.number || null,
    location: n.location || null,
    icaoLocation: n.icaoLocation || null,
    classification: n.classification || null,
    start: parseTime(n.effectiveStart),
    end: parseTime(n.effectiveEnd),
    canceled: parseTime(n.cancelationDate),
    estimated: String(n.estimated) === 'true',
    schedule: n.schedule || null,
    limits: n.lowerLimit || n.upperLimit ? `${n.lowerLimit || '?'}–${n.upperLimit || '?'}` : null,
    text: first(local && (local.simpleText || local.formattedText), icao && icao.formattedText, n.text, '(no text)'),
    updated: parseTime(n.lastUpdated),
    geometry: slimGeometry(feature.geometry),
  };
}

// Accept the shapes a bulk file might take: NMS envelope, FeatureCollection, array, or one Feature per line.
// Decompression runs on the thread pool, so the server keeps answering while a big file unpacks.
async function featuresFrom(buf) {
  if (buf.length > 2 && buf[0] === 0x1f && buf[1] === 0x8b) {
    try { buf = await gunzip(buf, { maxOutputLength: MAX_FILE_BYTES }); }
    catch (e) { throw new NmsError(e.code === 'ERR_BUFFER_TOO_LARGE' ? `Bulk NOTAM file unpacks to more than ${MAX_FILE_BYTES / 1048576} MB` : `Bulk NOTAM file could not be unpacked: ${e.message}`); }
  }
  const text = buf.toString('utf8').trim();
  try {
    const j = JSON.parse(text);
    if (Array.isArray(j)) return j;
    if (j.data && Array.isArray(j.data.geojson)) return j.data.geojson;
    if (Array.isArray(j.features)) return j.features;
    if (Array.isArray(j.geojson)) return j.geojson;
    if (j.type === 'Feature') return [j];
  } catch {
    const lines = text.split(/\r?\n/).filter((l) => l.trim().startsWith('{'));
    if (lines.length) return lines.map((l) => JSON.parse(l));
  }
  throw new NmsError('Bulk NOTAM file was not in a recognised GeoJSON format');
}

async function authHeaders(extra = {}) {
  return { Authorization: `Bearer ${await getToken()}`, Accept: 'application/json', ...extra };
}

// Changes since `sinceIso` (creates, updates, cancels, replaces). Max window 24 h.
async function delta(sinceIso) {
  const url = `${host()}/nmsapi/v1/notams?lastUpdatedDate=${encodeURIComponent(sinceIso)}`;
  const data = await request(url, { headers: await authHeaders({ nmsResponseFormat: 'GEOJSON' }) });
  if (data && data.status && data.status !== 'Success') throw new NmsError(`NMS: ${JSON.stringify(data.errors || data.message || data.status).slice(0, 200)}`);
  return ((data && data.data && data.data.geojson) || []).map(normalise);
}

// Every active NOTAM in one classification (DOMESTIC, FDC, MILITARY, LOCAL_MILITARY, INTERNATIONAL).
async function fullClassification(cls) {
  const url = `${host()}/nmsapi/v1/notams?classification=${encodeURIComponent(cls)}&allowRedirect=false`;
  const resp = await request(url, { headers: await authHeaders({ nmsResponseFormat: 'GEOJSON' }) });
  const rel = resp.redirect || (resp.data && resp.data.url) || resp.url;
  if (!rel) {
    // Some deployments may return the data directly.
    if (resp.data && Array.isArray(resp.data.geojson)) return resp.data.geojson.map(normalise);
    throw new NmsError(`No content link returned for ${cls}`);
  }
  const contentUrl = /^https?:/i.test(rel) ? rel : `${host()}${rel.startsWith('/') ? '' : '/'}${rel}`;
  // Only ever send the Bearer token back to the NMS host itself.
  if (new URL(contentUrl).origin !== new URL(host()).origin) {
    throw new NmsError(`Refusing ${cls} content link on another host (${new URL(contentUrl).host})`);
  }
  const buf = await request(contentUrl, { headers: await authHeaders(), binary: true, timeoutMs: 600000 });
  return (await featuresFrom(buf)).map(normalise);
}

// Cheap connectivity check for tools/nms-test.js (login + ping, no NOTAM data pulled).
async function ping() {
  await getToken();
  return request(`${host()}/nmsapi/v1/ping`, { headers: await authHeaders() }).catch((e) => ({ pingError: e.message }));
}

module.exports = { configured, delta, fullClassification, ping, normalise, featuresFrom, HOSTS, NmsError, host };
