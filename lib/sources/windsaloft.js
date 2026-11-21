// Winds and temperatures aloft from the NOAA GFS model, via Open-Meteo (free, no key, non-commercial use,
// data CC BY 4.0, limits: <10,000 calls/day, <5,000/hour, <600/minute).
//
// This replaces NOAA's FB wind/temp tables, which were discontinued 2026-11-03 with the NAM model
// retirement (NWS Service Change Notice 26-47).
//
// For each point we request, for every pressure level: wind speed (kt), wind direction (deg true),
// temperature (°C) and geopotential height (m MSL). The front end interpolates between levels to
// whatever altitudes you want to see.
const { getJson } = require('../http');

const LEVELS_HPA = [1000, 975, 950, 925, 900, 850, 800, 750, 700, 650, 600, 550, 500, 450, 400, 350, 300, 250, 200, 150];
const VARS = ['wind_speed', 'wind_direction', 'temperature', 'geopotential_height'];
const HOURLY = LEVELS_HPA.flatMap((p) => VARS.map((v) => `${v}_${p}hPa`)).join(',');
const M_TO_FT = 3.28084;

function buildUrl(lat, lon, withModel) {
  const q = new URLSearchParams({
    latitude: lat.toFixed(3),
    longitude: lon.toFixed(3),
    hourly: HOURLY,
    wind_speed_unit: 'kn',
    forecast_days: '2',
    timeformat: 'unixtime',
  });
  if (withModel) q.set('models', 'ncep_gfs_seamless');
  return `https://api.open-meteo.com/v1/forecast?${q}`;
}

// Returns { elevFt, times: [ms...], profiles: [[{h, s, d, t}...] per time] } with levels sorted by height.
function shape(data) {
  const H = data && data.hourly;
  if (!H || !Array.isArray(H.time)) throw new Error(data && data.reason ? `Open-Meteo: ${data.reason}` : 'Open-Meteo reply missing hourly data');
  const times = H.time.map((t) => t * 1000);
  const profiles = times.map((_, i) => {
    const lv = [];
    for (const p of LEVELS_HPA) {
      const s = H[`wind_speed_${p}hPa`]?.[i];
      const d = H[`wind_direction_${p}hPa`]?.[i];
      const t = H[`temperature_${p}hPa`]?.[i];
      const z = H[`geopotential_height_${p}hPa`]?.[i];
      if ([s, d, z].some((x) => x === null || x === undefined || !Number.isFinite(Number(x)))) continue;
      lv.push({ p, h: Math.round(z * M_TO_FT), s: Number(s), d: Number(d), t: t == null ? null : Number(t) });
    }
    return lv.sort((a, b) => a.h - b.h);
  });
  const usable = profiles.filter((p) => p.length >= 3).length;
  if (!usable) throw new Error('Open-Meteo returned no upper-level winds for this point');
  return {
    elevFt: Number.isFinite(data.elevation) ? Math.round(data.elevation * M_TO_FT) : null,
    model: 'GFS',
    times,
    profiles,
  };
}

// ---------- refresh only when a new model run is out ----------
// GFS 0.25° (pressure levels) and RRFS update every 6 hours. Open-Meteo publishes when each run becomes
// available (metadata calls don't count toward its limits), so winds are kept until a newer run is out, plus
// the 10 minutes Open-Meteo advises for all its servers to have it. If the metadata can't be read, winds fall
// back to refreshing hourly.
const META_URLS = ['ncep_gfs025', 'ncep_rrfs_north_america', 'ncep_rrfs_conus']
  .map((m) => `https://api.open-meteo.com/data/${m}/static/meta.json`);
const SETTLE_S = 600;          // wait after a run becomes available
const META_TTL_S = 300;        // check for a new run at most every 5 minutes
const WINDS_TTL_S = 7 * 3600;  // with a known run: keep up to 7 h (runs are 6 h apart)
const FALLBACK_TTL_S = 3600;   // without run info: refresh hourly
let version = null;            // availability time (s) of the newest run in use
let gfsRun = null;             // GFS initialisation time (s) of that run, for display

async function currentRun() {
  const metas = await Promise.all(META_URLS.map((u) => getJson(u, META_TTL_S).catch(() => null)));
  const ok = metas.filter((m) => m && Number.isFinite(m.last_run_availability_time));
  if (!ok.length) return null;
  const now = Date.now() / 1000;
  const latest = Math.max(...ok.map((m) => m.last_run_availability_time));
  // Switch to a new run only once it has had time to reach every Open-Meteo server.
  if (version === null || (latest > version && now - latest >= SETTLE_S)) {
    version = latest;
    const gfs = metas[0];
    gfsRun = gfs && Number.isFinite(gfs.last_run_initialisation_time) ? gfs.last_run_initialisation_time : gfsRun;
  }
  return version;
}

async function pointForecast(lat, lon) {
  const v = await currentRun().catch(() => null);
  const ttl = v ? WINDS_TTL_S : FALLBACK_TTL_S;
  const get = (withModel) => {
    const url = buildUrl(lat, lon, withModel);
    return getJson(url, ttl, { cacheKey: v ? `${url}#run=${v}` : url });
  };
  try {
    return shape(await get(true));
  } catch (e) {
    // If the model name is ever rejected, fall back to Open-Meteo's default model choice.
    if (/model|400/i.test(e.message)) return shape(await get(false));
    throw e;
  }
}

// The GFS run the winds come from (ms), or null if unknown.
const runInfo = () => (gfsRun ? gfsRun * 1000 : null);
const _resetRun = () => { version = null; gfsRun = null; };

module.exports = { pointForecast, runInfo, LEVELS_HPA, buildUrl, META_URLS, _resetRun };
