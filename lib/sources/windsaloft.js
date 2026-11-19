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

async function pointForecast(lat, lon) {
  try {
    return shape(await getJson(buildUrl(lat, lon, true), 1800));
  } catch (e) {
    // If the model name is ever rejected, fall back to Open-Meteo's default model choice.
    if (/model|400/i.test(e.message)) return shape(await getJson(buildUrl(lat, lon, false), 1800));
    throw e;
  }
}

module.exports = { pointForecast, LEVELS_HPA, buildUrl };
