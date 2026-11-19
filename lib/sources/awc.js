// NOAA Aviation Weather Center Data API — https://aviationweather.gov/data/api/
// Rules from AWC: 100 requests/min, max 400 entries per reply, no browser (CORS) access,
// undocumented query parameters cause an error, send a custom User-Agent.
// Only parameters listed on https://aviationweather.gov/data/api/help are used here.
const { getJson } = require('../http');

const BASE = 'https://aviationweather.gov/api/data';
const qs = (o) => new URLSearchParams(Object.entries(o).filter(([, v]) => v !== undefined && v !== '')).toString();
const bboxStr = (b) => `${b.minLat},${b.minLon},${b.maxLat},${b.maxLon}`;
const asArray = (x) => (Array.isArray(x) ? x : []);
const asFeatures = (x) => (x && Array.isArray(x.features) ? x.features : []);

module.exports = {
  stationInfo: async (ids) =>
    asArray(await getJson(`${BASE}/stationinfo?${qs({ ids: ids.join(','), format: 'json' })}`, 24 * 3600)),

  metarsByIds: async (ids) =>
    asArray(await getJson(`${BASE}/metar?${qs({ ids: ids.join(','), format: 'json' })}`, 120)),

  metarsByBbox: async (bbox) =>
    asArray(await getJson(`${BASE}/metar?${qs({ bbox: bboxStr(bbox), format: 'json' })}`, 120)),

  // Observation history: every METAR/SPECI in the last `hours` hours (documented "hours" parameter).
  metarHistory: async (ids, hours = 6) =>
    asArray(await getJson(`${BASE}/metar?${qs({ ids: ids.join(','), format: 'json', hours })}`, 120)),

  tafsByIds: async (ids) =>
    asArray(await getJson(`${BASE}/taf?${qs({ ids: ids.join(','), format: 'json' })}`, 300)),

  tafsByBbox: async (bbox) =>
    asArray(await getJson(`${BASE}/taf?${qs({ bbox: bboxStr(bbox), format: 'json' })}`, 300)),

  pirepsByBbox: async (bbox, ageHrs = 3) =>
    asArray(await getJson(`${BASE}/pirep?${qs({ bbox: bboxStr(bbox), age: ageHrs, format: 'json' })}`, 180)),

  // CONUS-wide products: fetched once and shared by every area you look at.
  sigmets: async () => asFeatures(await getJson(`${BASE}/airsigmet?format=geojson`, 300)),
  gairmets: async () => asFeatures(await getJson(`${BASE}/gairmet?format=geojson`, 600)),
  cwas: async () => asFeatures(await getJson(`${BASE}/cwa?format=geojson`, 300)),
};
