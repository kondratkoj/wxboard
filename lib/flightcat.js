// Flight category + TAF period helpers.
// Categories (NWS/AWC convention):
//   LIFR: ceiling < 500 ft  or vis < 1 SM
//   IFR : ceiling < 1000 ft or vis < 3 SM
//   MVFR: ceiling 1000-3000 ft or vis 3-5 SM
//   VFR : ceiling > 3000 ft and vis > 5 SM

const CEILING_COVERS = new Set(['BKN', 'OVC', 'OVX']);

function parseVis(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return v;
  const s = String(v).trim().replace(/SM$/i, '').replace(/^P/, '');
  const mixed = s.match(/^(\d+)\s+(\d+)\/(\d+)/);
  if (mixed) return Number(mixed[1]) + Number(mixed[2]) / Number(mixed[3]);
  const frac = s.match(/^M?(\d+)\/(\d+)/);
  if (frac) return Number(frac[1]) / Number(frac[2]);
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : null;
}

function ceilingFt(clouds, vertVis) {
  let ceil = null;
  for (const c of clouds || []) {
    if (c && CEILING_COVERS.has(c.cover) && Number.isFinite(c.base)) {
      ceil = ceil === null ? c.base : Math.min(ceil, c.base);
    }
  }
  if (Number.isFinite(vertVis) && vertVis !== null) {
    // Vertical visibility is an indefinite ceiling. Values < 100 are assumed to be hundreds of feet.
    const vv = vertVis < 100 ? vertVis * 100 : vertVis;
    ceil = ceil === null ? vv : Math.min(ceil, vv);
  }
  return ceil;
}

function category(ceil, vis) {
  if (ceil === null && vis === null) return null;
  const c = ceil === null ? Infinity : ceil;
  const v = vis === null ? Infinity : vis;
  if (c < 500 || v < 1) return 'LIFR';
  if (c < 1000 || v < 3) return 'IFR';
  if (c <= 3000 || v <= 5) return 'MVFR';
  return 'VFR';
}

// Turn the AWC TAF fcsts array into display periods with a category each.
// FM / initial / BECMG are "prevailing"; TEMPO / PROB are conditional.
// BECMG groups can list only what changes, so missing fields carry over.
function tafPeriods(taf) {
  const out = [];
  let prev = null;
  for (const f of taf.fcsts || []) {
    const change = f.fcstChange || null;
    const conditional = change === 'TEMPO' || change === 'PROB';
    let p = {
      change,
      probability: f.probability ?? null,
      from: f.timeFrom,
      to: f.timeTo,
      becomingBy: f.timeBec ?? null,
      wdir: f.wdir, wspd: f.wspd, wgst: f.wgst,
      wshear: f.wshearHgt != null ? { hgt: f.wshearHgt, dir: f.wshearDir, spd: f.wshearSpd } : null,
      visib: f.visib, wxString: f.wxString, vertVis: f.vertVis,
      clouds: f.clouds || [], icgTurb: f.icgTurb || [],
      conditional,
    };
    if (change === 'BECMG' && prev) {
      for (const k of ['wdir', 'wspd', 'visib', 'wxString', 'vertVis']) {
        if (p[k] === null || p[k] === undefined) p[k] = prev[k];
      }
      if (!p.clouds.length && p.vertVis == null) p.clouds = prev.clouds;
    }
    const ceil = ceilingFt(p.clouds, p.vertVis);
    const vis = parseVis(p.visib);
    p.ceilingFt = ceil;
    p.visSM = vis;
    // Conditional groups often omit vis or clouds; only grade what they state.
    p.fltCat = category(ceil, vis);
    if (!conditional) prev = p;
    out.push(p);
  }
  return out;
}

const RANK = { VFR: 0, MVFR: 1, IFR: 2, LIFR: 3 };
function worst(cats) {
  let w = null;
  for (const c of cats) if (c && (w === null || RANK[c] > RANK[w])) w = c;
  return w;
}

module.exports = { parseVis, ceilingFt, category, tafPeriods, worst };
