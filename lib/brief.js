// Builds one "brief" for an area: stations, TAFs, hazards, PIREPs, TFRs, NOTAMs, area forecast.
// Every section loads independently, so one failing feed never blanks the rest.
const awc = require('./sources/awc');
const nws = require('./sources/nws');
const tfr = require('./sources/tfr');
const nms = require('./sources/nms');
const notamStore = require('./notamStore');
const windsAloft = require('./sources/windsaloft');
const lamp = require('./sources/lamp');
const geo = require('./geo');
const fc = require('./flightcat');
const { trackStale } = require('./http');

const MAX_STATIONS = 40;
const VALID_ID = /^[A-Z0-9]{3,4}$/;

function parseIds(input) {
  return [...new Set(
    String(input || '')
      .toUpperCase()
      .split(/[\s,;]+/)
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => (/^[A-Z]{3}$/.test(s) ? 'K' + s : s)) // DFW -> KDFW (CONUS 3-letter IDs)
  )].slice(0, 12);
}

async function section(fn) {
  const t0 = Date.now();
  try {
    return { ok: true, data: await fn(), ms: Date.now() - t0 };
  } catch (e) {
    return { ok: false, error: e.message || String(e), ms: Date.now() - t0 };
  }
}

const num = (v) => (v === null || v === undefined || v === '' ? null : Number(v));

function shapeMetar(m, dist) {
  const ceil = fc.ceilingFt(m.clouds, num(m.vertVis));
  const vis = fc.parseVis(m.visib);
  return {
    id: m.icaoId,
    name: m.name || null,
    lat: m.lat, lon: m.lon, elev: m.elev,
    distNm: dist,
    obsTime: m.obsTime ? m.obsTime * 1000 : null,
    raw: m.rawOb,
    type: m.metarType,
    temp: m.temp, dewp: m.dewp,
    wdir: m.wdir, wspd: m.wspd, wgst: m.wgst ?? null,
    visib: m.visib, visSM: vis,
    altim: m.altim, // hPa in AWC JSON
    wx: m.wxString || null,
    clouds: m.clouds || [],
    ceilingFt: ceil,
    fltCat: m.fltCat || fc.category(ceil, vis),
  };
}

function shapeTaf(t) {
  return {
    id: t.icaoId,
    issued: t.issueTime || null,
    validFrom: t.validTimeFrom ? t.validTimeFrom * 1000 : null,
    validTo: t.validTimeTo ? t.validTimeTo * 1000 : null,
    raw: t.rawTAF,
    lat: t.lat, lon: t.lon,
    periods: fc.tafPeriods(t).map((p) => ({ ...p, from: p.from * 1000, to: p.to * 1000, becomingBy: p.becomingBy ? p.becomingBy * 1000 : null })),
  };
}

async function resolveStations(ids) {
  // Coordinates for the requested IDs. stationinfo first, METAR as fallback.
  const found = new Map();
  let netErr = null;
  const info = await awc.stationInfo(ids).catch((e) => { netErr = e; return []; });
  for (const s of info) {
    const id = s.icaoId || s.id || s.stationId;
    if (id && Number.isFinite(Number(s.lat)) && Number.isFinite(Number(s.lon))) {
      found.set(id, { id, lat: Number(s.lat), lon: Number(s.lon), name: s.site || s.name || null });
    }
  }
  const missing = ids.filter((i) => !found.has(i));
  if (missing.length) {
    const ms = await awc.metarsByIds(missing).catch((e) => { netErr = netErr || e; return []; });
    for (const m of ms) if (!found.has(m.icaoId)) found.set(m.icaoId, { id: m.icaoId, lat: m.lat, lon: m.lon, name: m.name });
  }
  if (!found.size && netErr) {
    throw Object.assign(new Error(`Can't reach aviationweather.gov (${netErr.message}). Check the internet connection.`), { status: 502 });
  }
  return ids.map((i) => found.get(i)).filter(Boolean);
}

// Points along a route no more than `spacingNm` apart (capped), always including the ends.
function samplePolyline(pts, spacingNm, max) {
  const out = [pts[0]];
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1];
    const n = Math.max(1, Math.ceil(geo.distNm(a, b) / spacingNm));
    for (let k = 1; k <= n; k++) out.push({ lat: a.lat + ((b.lat - a.lat) * k) / n, lon: a.lon + ((b.lon - a.lon) * k) / n });
  }
  if (out.length <= max) return out;
  const step = (out.length - 1) / (max - 1);
  return Array.from({ length: max }, (_, i) => out[Math.round(i * step)]);
}

function notamStatus(n, now) {
  const s = n.start && n.start !== 'PERM' ? Date.parse(n.start) : null;
  const e = n.end && n.end !== 'PERM' ? Date.parse(n.end) : null;
  if (e && e < now) return 'expired';
  if (s && s > now) return 'upcoming';
  return 'active';
}

// Every brief records any source that could only give an old copy (see http.trackStale); the page shows them.
async function buildBrief(args) {
  const { value, stale } = await trackStale(() => buildBriefInner(args));
  value.stale = stale.map((n) => ({ source: n.source, since: new Date(n.since).toISOString(), error: String(n.error).slice(0, 160) }));
  return value;
}

async function buildBriefInner({ ids: idInput, radius, route, showNotams = true }) {
  const parsed = parseIds(idInput);
  // Airport IDs are 3-4 letters/digits. Anything else is reported as not found, never sent upstream.
  const ids = parsed.filter((s) => VALID_ID.test(s));
  const invalid = parsed.filter((s) => !VALID_ID.test(s));
  if (!ids.length) {
    const msg = invalid.length ? 'Airport IDs are 3 or 4 letters/digits, e.g. KDFW' : 'Enter at least one airport ID';
    throw Object.assign(new Error(msg), { status: 400 });
  }
  const radiusNm = Math.max(5, Math.min(300, Number(radius) || 30));
  const isRoute = Boolean(route) && ids.length > 1;

  const anchors = await resolveStations(ids);
  const unknown = [...ids.filter((i) => !anchors.find((a) => a.id === i)), ...invalid];
  if (!anchors.length) throw Object.assign(new Error(`Couldn't find ${ids.join(', ')}`), { status: 404 });

  const shape = { points: anchors.map((a) => ({ lat: a.lat, lon: a.lon })), route: isRoute };
  const bbox = geo.shapeBbox(shape, radiusNm);
  const center = geo.shapeCenter(shape);
  const near = (geom) => geo.shapeDistToGeometry(shape, geom) <= radiusNm;
  const anchorIds = anchors.map((a) => a.id);

  const historyP = awc.metarHistory(anchorIds, 6); // shared by the METAR and trend sections
  historyP.catch(() => {}); // each section handles a failure itself
  const [metars, tafs, pireps, sigmets, cwas, gairmets, tfrs, notams, forecast, winds, trend, lampData] = await Promise.all([
    section(async () => {
      const [byBox, byId, hist] = await Promise.all([awc.metarsByBbox(bbox).catch(() => []), awc.metarsByIds(anchorIds), historyP.catch(() => [])]);
      // Newest report per station across all three requests, so the card can never show an older METAR than
      // the trend (each request is cached on its own and one may be fresher than another).
      const all = new Map();
      for (const m of [...byId, ...hist, ...byBox]) {
        if (!m || !m.icaoId) continue;
        const have = all.get(m.icaoId);
        if (!have || (Number(m.obsTime) || 0) > (Number(have.obsTime) || 0)) all.set(m.icaoId, m);
      }
      const list = [...all.values()]
        .map((m) => shapeMetar(m, Math.round(geo.shapeDistToPoint(shape, m))))
        .filter((m) => anchorIds.includes(m.id) || m.distNm <= radiusNm);
      list.sort((a, b) => {
        const ai = anchorIds.indexOf(a.id), bi = anchorIds.indexOf(b.id);
        if (ai !== -1 || bi !== -1) return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
        return a.distNm - b.distNm;
      });
      return list.slice(0, MAX_STATIONS);
    }),
    section(async () => {
      const [byBox, byId] = await Promise.all([awc.tafsByBbox(bbox).catch(() => []), awc.tafsByIds(anchorIds)]);
      const all = new Map();
      for (const t of [...byId, ...byBox]) if (t && t.icaoId && !all.has(t.icaoId)) all.set(t.icaoId, t);
      return [...all.values()]
        .filter((t) => anchorIds.includes(t.icaoId) || geo.shapeDistToPoint(shape, t) <= radiusNm)
        .map(shapeTaf);
    }),
    section(async () => {
      const list = await awc.pirepsByBbox(bbox, 3);
      return list
        .map((p) => ({ ...p, distNm: Math.round(geo.shapeDistToPoint(shape, p)) }))
        .filter((p) => p.distNm <= radiusNm)
        .sort((a, b) => (b.obsTime || 0) - (a.obsTime || 0))
        .map((p) => ({
          raw: p.rawOb, obsTime: p.obsTime ? p.obsTime * 1000 : null, lat: p.lat, lon: p.lon, distNm: p.distNm,
          acType: p.acType, fltLvl: p.fltLvl, urgent: p.pirepType === 'Urgent PIREP' || /\bUUA\b/.test(p.rawOb || ''),
          turb: p.tbInt1 ? [p.tbInt1, p.tbType1, p.tbBas1 != null ? `${p.tbBas1}-${p.tbTop1 ?? ''}` : ''].filter(Boolean).join(' ') : null,
          ice: p.icgInt1 ? [p.icgInt1, p.icgType1, p.icgBas1 != null ? `${p.icgBas1}-${p.icgTop1 ?? ''}` : ''].filter(Boolean).join(' ') : null,
        }));
    }),
    section(async () => (await awc.sigmets()).filter((f) => near(f.geometry)).map((f) => ({
      kind: (f.properties.airSigmetType || 'SIGMET').toUpperCase(),
      hazard: f.properties.hazard, severity: f.properties.severity,
      series: [f.properties.seriesId, f.properties.alphaChar].filter(Boolean).join(' ') || null,
      from: f.properties.validTimeFrom ? f.properties.validTimeFrom * 1000 : null,
      to: f.properties.validTimeTo ? f.properties.validTimeTo * 1000 : null,
      top: f.properties.altitudeHi1 ?? f.properties.altitudeHi2 ?? null,
      base: f.properties.altitudeLow1 ?? f.properties.altitudeLow2 ?? null,
      raw: f.properties.rawAirSigmet, geometry: f.geometry,
    }))),
    section(async () => (await awc.cwas()).filter((f) => near(f.geometry)).map((f) => {
      const p = f.properties || {};
      return {
        center: p.cwsu || p.icaoId || null, hazard: p.hazard || null, seq: p.seriesId || p.seq || null,
        from: p.validTimeFrom ? p.validTimeFrom * 1000 : null, to: p.validTimeTo ? p.validTimeTo * 1000 : null,
        raw: p.cwaText || p.rawCWA || p.rawText || p.text || null, geometry: f.geometry,
      };
    })),
    section(async () => {
      const feats = (await awc.gairmets()).filter((f) => near(f.geometry));
      // One row per hazard, listing which forecast hours touch the area.
      const by = new Map();
      for (const f of feats) {
        const p = f.properties || {};
        const k = p.hazard || '?';
        if (!by.has(k)) by.set(k, { hazard: k, product: p.product || null, dueTo: new Set(), hours: new Set(), validTimes: new Set(), geometries: [] });
        const g = by.get(k);
        if (p.dueTo) g.dueTo.add(p.dueTo);
        if (p.forecast !== undefined && p.forecast !== null) g.hours.add(Number(p.forecast));
        if (p.validTime) g.validTimes.add(p.validTime);
        if (g.geometries.length < 12) g.geometries.push(f.geometry);
      }
      return [...by.values()].map((g) => ({
        hazard: g.hazard, product: g.product, dueTo: [...g.dueTo].join('; ') || null,
        forecastHours: [...g.hours].sort((a, b) => a - b),
        validTimes: [...g.validTimes].sort(),
        geometry: { type: 'GeometryCollection', geometries: g.geometries },
      }));
    }),
    section(async () => (await tfr.allTfrs())
      .map((t) => ({ ...t, distNm: Math.round(geo.shapeDistToGeometry(shape, t.geometry)) }))
      .filter((t) => t.distNm <= radiusNm)
      .sort((a, b) => a.distNm - b.distNm)),
    section(async () => {
      if (!showNotams) return { configured: false, restricted: true };
      if (!nms.configured()) return { configured: false };
      const st = notamStore.status();
      const t = Date.now();
      const items = notamStore.query({ anchorIds, shape, radiusNm, bbox }).map((n) => {
        const status = notamStatus(n, t);
        const pastEst = n.estimated && n.end && n.end !== 'PERM' && Date.parse(n.end) < t;
        return { ...n, status: status === 'expired' && pastEst ? 'active' : status, pastEstimatedEnd: Boolean(pastEst) };
      }).filter((n) => n.status !== 'expired');
      return { configured: true, sync: st, areaRadiusNm: radiusNm, items };
    }),
    section(() => Promise.all(anchors.slice(0, 6).map((a) => nws.forecastFor(a.lat, a.lon)
      .then((f) => ({ id: a.id, ...f }))
      .catch((e) => ({ id: a.id, error: e.message }))))),
    section(async () => {
      // Model winds aloft over each airport you entered (max 6). One failing point doesn't hide the others.
      const pts = anchors.slice(0, 6);
      const results = await Promise.all(pts.map((a) => windsAloft.pointForecast(a.lat, a.lon)
        .then((f) => ({ id: a.id, ...f }))
        .catch((e) => ({ id: a.id, error: e.message }))));
      if (results.every((r) => r.error)) throw new Error(results[0].error);
      return { source: 'NOAA GFS via Open-Meteo', points: results };
    }),
    section(async () => {
      // Last 6 hours of observations for each airport you entered, oldest first.
      const list = await historyP;
      const by = {};
      for (const id of anchorIds) by[id] = [];
      for (const m of list) if (by[m.icaoId]) by[m.icaoId].push(shapeMetar(m, 0));
      for (const id of anchorIds) by[id].sort((a, b) => (a.obsTime || 0) - (b.obsTime || 0));
      return by;
    }),
    section(() => lamp.forStations(anchorIds)),
  ]);

  // Worst category in the next 6 hours, per anchor airport, from TAF prevailing periods.
  if (tafs.ok) {
    const soon = Date.now() + 6 * 3600 * 1000;
    for (const t of tafs.data) {
      const rel = t.periods.filter((p) => p.to > Date.now() && p.from < soon);
      t.worstNext6 = fc.worst(rel.filter((p) => !p.conditional).map((p) => p.fltCat));
      t.worstNext6Tempo = fc.worst(rel.filter((p) => p.conditional).map((p) => p.fltCat));
    }
  }

  return {
    generatedAt: new Date().toISOString(),
    area: { ids, anchors, unknown, radiusNm, route: isRoute, bbox, center },
    metars, tafs, pireps, sigmets, cwas, gairmets, tfrs, notams, forecast, winds, trend, lamp: lampData,
    links: { tfrList: tfr.LIST_PAGE, notamSearch: 'https://notams.aim.faa.gov/notamSearch/' },
  };
}

module.exports = { buildBrief, parseIds };
