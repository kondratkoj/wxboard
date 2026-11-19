// NOAA GFS LAMP (Localized Aviation MOS Program) station guidance, via the Iowa Environmental Mesonet API.
// Hourly forecasts (38 h) of ceiling and visibility CATEGORIES, wind and precip for many airports that
// have no TAF.
//   GET https://mesonet.agron.iastate.edu/api/1/mos.json?station=KDFW&station=KAUS&model=LAV  (max 6 stations)
// Category definitions (NWS MDL LAMP card v2.7.0):
//   CIG 1:<200  2:200-400  3:500-900  4:1000-1900  5:2000-3000  6:3100-6500  7:6600-12000  8:>12000/unlimited (ft)
//   VIS 1:<1/2  2:1/2-<1  3:1-<2  4:2-<3  5:3-5  6:6  7:>6 (statute miles)
// LAMP is statistical guidance, not a TAF. Each category is a range, so wxboard keeps both ends.
const { getJson } = require('../http');

const CIG = { 1: [0, 199], 2: [200, 400], 3: [500, 900], 4: [1000, 1900], 5: [2000, 3000], 6: [3100, 6500], 7: [6600, 12000], 8: [null, null] };
const VIS = { 1: [0, 0.49], 2: [0.5, 0.99], 3: [1, 1.99], 4: [2, 2.99], 5: [3, 5], 6: [6, 6], 7: [7, null] };
const CIG_TEXT = { 1: '<200', 2: '200–400', 3: '500–900', 4: '1,000–1,900', 5: '2,000–3,000', 6: '3,100–6,500', 7: '6,600–12,000', 8: '>12,000' };
const VIS_TEXT = { 1: '<½', 2: '½–<1', 3: '1–<2', 4: '2–<3', 5: '3–5', 6: '6', 7: '>6' };

const utc = (s) => (s ? Date.parse(/Z$/.test(s) ? s : s + 'Z') : null);
const num = (v) => (v === null || v === undefined || v === '' ? null : Number(v));

function row(r) {
  const cig = num(r.cig), vis = num(r.vis);
  let wdr = num(r.wdr);
  if (wdr !== null && wdr <= 36) wdr *= 10; // tolerate tens-of-degrees encoding
  return {
    t: utc(r.ftime_utc || r.ftime),
    cigCat: cig, visCat: vis,
    // null ceiling bound = unlimited; null visibility upper bound = more than 6 SM
    ceilLow: cig ? CIG[cig][0] : null, ceilHigh: cig ? CIG[cig][1] : null,
    visLow: vis ? VIS[vis][0] : null, visHigh: vis ? VIS[vis][1] : null,
    ceilText: cig ? CIG_TEXT[cig] : '?', visText: vis ? VIS_TEXT[vis] : '?',
    condCig: num(r.ccg), condVis: num(r.cvs),
    obv: (r.obv || '').trim() || null,
    cld: (r.cld || '').trim() || null,
    wdr, wsp: num(r.wsp), gst: num(r.gst),
    pop: num(r.ppo),   // PPO: probability of precipitation (not necessarily measurable) ON the hour, %
    p01: num(r.p01),   // P01: probability of measurable precip in the 1 h ending at this time, %
    ltg: num(r.lp1),   // LP1: probability of lightning in the 1 h ending at this time, %
    conv: num(r.cp1),  // CP1: probability of convection in the 1 h ending at this time, %
  };
}

async function forStations(ids) {
  const out = {};
  const icao = ids.filter((id) => /^[A-Z0-9]{4}$/.test(id));
  for (let i = 0; i < icao.length; i += 6) {
    const chunk = icao.slice(i, i + 6);
    const q = chunk.map((s) => `station=${encodeURIComponent(s)}`).join('&');
    let data;
    try {
      data = await getJson(`https://mesonet.agron.iastate.edu/api/1/mos.json?${q}&model=LAV`, 900);
    } catch (e) {
      if (/404/.test(e.message)) continue; // no LAMP for these stations
      throw e;
    }
    // Keep only each station's latest model run.
    const latest = {};
    for (const r of (data && data.data) || []) {
      const rt = utc(r.runtime_utc || r.runtime);
      if (!latest[r.station] || rt > latest[r.station]) latest[r.station] = rt;
    }
    for (const r of (data && data.data) || []) {
      const id = r.station;
      const rt = utc(r.runtime_utc || r.runtime);
      if (rt !== latest[id]) continue;
      if (!out[id]) out[id] = { runtime: rt, rows: [] };
      out[id].rows.push(row(r));
    }
  }
  for (const v of Object.values(out)) v.rows.sort((a, b) => a.t - b.t);
  return out;
}

module.exports = { forStations, CIG, VIS };
