// Surface airspace class at each airport, for the Part 91 minimums (14 CFR 91.155).
//
// Source: the FAA's Class_Airspace feature service (Aeronautical Information Services, published on ArcGIS Online,
// updated with the 56-day chart cycle). One small query per airport position: "which Class B/C/D/E areas with a
// surface floor contain this point?" (no outlines are downloaded). No surface area found = Class G at the surface.
//
// Why per point: a brief can span half the country (e.g. KDTW + KASE), and one query for every surface area in that
// box is thousands of outlines; the service answers that with "Too many requests".
//
// Caching: answers are kept 24 h per position (airspace changes every 56 days) and an old answer is used for up to
// 7 days if the service is failing. Error replies (the service sends them with HTTP 200) are never cached. After a
// "Too many requests" the service isn't asked again for 2 minutes. At most 3 requests run at a time (lib/http.js).
//
// Limits of this data: it says whether an area is full-time (WKHR_CODE "H24") but not its hours; those come from
// NASR (lib/sources/nasr.js), joined by IDENT.
const { rawFetch } = require('../http');

const BASE = 'https://services6.arcgis.com/ssFJjBXIUyZDrSYZ/arcgis/rest/services/Class_Airspace/FeatureServer/0/query';
const TTL_MS = 24 * 3600e3, KEEP_MS = 7 * 24 * 3600e3, BACKOFF_MS = 2 * 60e3;
const SOURCE = 'FAA Class_Airspace (AIS, ArcGIS Online)';

// Most restrictive first. E2 = Class E surface area; E4 / E3 = extensions to a D / E surface area.
const RANK = ['CLASS_B', 'CLASS_C', 'CLASS_D', 'CLASS_E2', 'CLASS_E4', 'CLASS_E3'];

const cache = new Map(); // "lat,lon" (3 dp) -> { at, value }
let backoffUntil = 0;

function pointUrl(lat, lon) {
  const p = new URLSearchParams({
    where: "LOWER_VAL = 0 AND LOWER_CODE = 'SFC' AND CLASS IN ('B','C','D','E')",
    geometry: `${lon},${lat}`, geometryType: 'esriGeometryPoint', inSR: '4326', spatialRel: 'esriSpatialRelIntersects',
    outFields: 'IDENT,NAME,ICAO_ID,CLASS,LOCAL_TYPE,WKHR_CODE,WKHR_RMK', returnGeometry: 'false', f: 'json',
  });
  return `${BASE}?${p}`;
}

const toArea = (a) => ({
  type: a.LOCAL_TYPE, cls: a.CLASS, name: a.NAME || null, icao: a.ICAO_ID || null,
  // FAA airport ID of the airport the area belongs to (joins to the NASR hours). K-prefixed ICAO as a fallback.
  ident: a.IDENT || (/^K[A-Z0-9]{3}$/.test(a.ICAO_ID || '') ? a.ICAO_ID.slice(1) : null),
  partTime: a.WKHR_CODE !== 'H24', hours: a.WKHR_CODE || null, hoursNote: a.WKHR_RMK || null,
});

// Even–odd test over all rings (holes included). Rings are [lon, lat]. Used when outlines are present (demo fixture).
function inRings(lat, lon, rings) {
  let inside = false;
  for (const r of rings) {
    for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
      const [xi, yi] = r[i], [xj, yj] = r[j];
      if ((yi > lat) !== (yj > lat) && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
    }
  }
  return inside;
}

// The most restrictive of the areas containing the point → { cls, type, name, ident, partTime, hours, hoursNote }
function pick(areas) {
  const hits = areas.filter((a) => RANK.includes(a.type));
  if (!hits.length) return { cls: 'G', type: 'CLASS_G', name: null, ident: null, partTime: false, hours: null, hoursNote: null };
  hits.sort((a, b) => RANK.indexOf(a.type) - RANK.indexOf(b.type));
  const { type, cls, name, ident, partTime, hours, hoursNote } = hits[0];
  return { cls, type, name, ident, partTime, hours, hoursNote };
}

// Kept for tests and the demo fixture: classify against areas that carry outlines.
function classifyPoint(lat, lon, areas) {
  return pick(areas.filter((a) => !a.rings || inRings(lat, lon, a.rings)));
}

async function surfaceAt(lat, lon) {
  const key = `${Number(lat).toFixed(3)},${Number(lon).toFixed(3)}`;
  const hit = cache.get(key), now = Date.now();
  if (hit && now - hit.at < TTL_MS) return hit.value;
  if (now < backoffUntil) {
    if (hit && now - hit.at < KEEP_MS) return hit.value;
    throw new Error('FAA airspace service asked us to slow down; trying again shortly');
  }
  try {
    const j = await rawFetch(pointUrl(lat, lon), { timeoutMs: 15000 });
    if (!j || j.error || !Array.isArray(j.features)) {
      const msg = (j && j.error && (j.error.message || j.error.details)) || 'unexpected reply';
      if (/too many/i.test(String(msg))) backoffUntil = Date.now() + BACKOFF_MS;
      throw new Error(`FAA airspace service: ${msg}`);
    }
    const areas = j.features.map((f) => ({ ...toArea(f.attributes || {}), rings: f.geometry && f.geometry.rings }));
    const value = classifyPoint(Number(lat), Number(lon), areas);
    cache.set(key, { at: Date.now(), value });
    if (cache.size > 5000) cache.delete(cache.keys().next().value);
    return value;
  } catch (e) {
    if (hit && now - hit.at < KEEP_MS) return hit.value; // an old answer beats none: airspace rarely changes
    throw e;
  }
}

// Many points at once (duplicates asked once). → { results: Map(key → value|null), failed, error }
async function surfaceForPoints(points) {
  const uniq = new Map();
  for (const p of points) if (p && p.lat != null && p.lon != null) uniq.set(`${Number(p.lat).toFixed(3)},${Number(p.lon).toFixed(3)}`, p);
  const results = new Map();
  let failed = 0, error = null;
  await Promise.all([...uniq].map(async ([k, p]) => {
    try { results.set(k, await surfaceAt(p.lat, p.lon)); } catch (e) { failed++; error = error || e.message; results.set(k, null); }
  }));
  return { results, failed, error, asked: uniq.size };
}

module.exports = { surfaceAt, surfaceForPoints, classifyPoint, inRings, pick, SOURCE, _cache: cache, _reset: () => { cache.clear(); backoffUntil = 0; } };
