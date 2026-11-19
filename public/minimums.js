// Weather minimums + risk bands. Pure functions, shared by the page and tests.
//
// Table: 14 CFR 135.609(a) HAA Class G VFR ceiling/flight-visibility minimums (ceiling ft, visibility SM).
// Non-local (cross-country) rows are the default; users with designated local flying areas can switch.
//
// Default risk bands (user-editable, to match an operator's own flight-release criteria):
//   Green:          ceiling 700+ ft above the limit and visibility 3+ SM above the limit
//   Amber:          within 700 ft of the ceiling limit and/or within 3 SM of the visibility limit
//   Amber Critical: within 200 ft and/or within 2 SM
//   Red:            below the limit
// None of this is a flight release; the PIC and the operator make that call.
(function (root) {
  const HAA_135_609 = {
    //                       day            night (unaided)   night with NVIS/HTAWS
    'non-local':  { day: [800, 2], night: [1000, 3], nvg: [800, 3] },
    'non-xc':     { day: [800, 3], night: [1000, 5], nvg: [1000, 3] },
    'mtn-local':  { day: [800, 3], night: [1500, 3], nvg: [1000, 3] },
    'mtn-xc':     { day: [1000, 3], night: [1500, 5], nvg: [1000, 5] },
  };

  const DEFAULTS = {
    enabled: true,
    table: '135.609',
    terrain: 'non',      // 'non' | 'mtn'   (14 CFR Part 95 designated mountainous areas)
    area: 'xc',          // 'xc' (non-local) | 'local'
    nightMode: 'nvg',    // 'nvg' (aided) | 'unaided'
    bands: { amberCeil: 700, amberVis: 3, critCeil: 200, critVis: 2 },
  };

  function rowKey(s) { return `${s.terrain === 'mtn' ? 'mtn' : 'non'}-${s.area === 'local' ? 'local' : 'xc'}`; }

  // phase: 'day' | 'night'
  function limitsFor(phase, s) {
    const row = HAA_135_609[rowKey(s)];
    const col = phase === 'day' ? 'day' : s.nightMode === 'unaided' ? 'night' : 'nvg';
    const [ceil, vis] = row[col];
    const label = `${phase === 'day' ? 'Day' : s.nightMode === 'unaided' ? 'Night unaided' : 'Night NVG'}, ${s.terrain === 'mtn' ? 'mountainous' : 'non-mountainous'} ${s.area === 'local' ? 'local' : 'cross-country'}`;
    return { ceil, vis, label };
  }

  const LEVELS = ['green', 'amber', 'critical', 'red'];
  const LABEL = { green: 'Green', amber: 'Amber', critical: 'Amber Crit', red: 'Red' };

  // ceilFt: null = no ceiling. visSM: null = unknown (judged on ceiling only).
  function assess(ceilFt, visSM, lim, bands) {
    const c = ceilFt == null ? Infinity : ceilFt;
    const reasons = [];
    let lvl = 0;
    const bump = (n, why) => { if (n > lvl) lvl = n; reasons.push(why); };
    if (c < lim.ceil) bump(3, `ceiling ${c} ft below ${lim.ceil}`);
    else if (c < lim.ceil + bands.critCeil) bump(2, `ceiling within ${bands.critCeil} ft of ${lim.ceil}`);
    else if (c < lim.ceil + bands.amberCeil) bump(1, `ceiling within ${bands.amberCeil} ft of ${lim.ceil}`);
    if (visSM != null) {
      if (visSM < lim.vis) bump(3, `visibility ${visSM} SM below ${lim.vis}`);
      else if (visSM < lim.vis + bands.critVis) bump(2, `visibility within ${bands.critVis} SM of ${lim.vis}`);
      else if (visSM < lim.vis + bands.amberVis) bump(1, `visibility within ${bands.amberVis} SM of ${lim.vis}`);
    }
    return { level: LEVELS[lvl], label: LABEL[LEVELS[lvl]], reasons, partial: visSM == null };
  }

  const worst = (levels) => levels.reduce((w, l) => (LEVELS.indexOf(l) > LEVELS.indexOf(w) ? l : w), 'green');

  // Rough check only: could this point be inside a 14 CFR 95 designated mountainous area?
  // Eastern area's westernmost point is 86°45'W and southernmost 32°30'N; the western area's
  // eastern edge is around 102°W–108°W. Alaska, Hawaii and Puerto Rico are also designated.
  function maybeMountainous(lat, lon) {
    if (lon <= -102) return true;
    if (lon >= -86.75 && lat >= 32.5) return true;
    if (lat > 51 || lon < -140 || (lat < 23 && lon < -150) || (lat < 19 && lon > -68)) return true;
    return false;
  }

  const api = { HAA_135_609, DEFAULTS, limitsFor, assess, worst, LEVELS, LABEL, maybeMountainous };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Minimums = api;
})(typeof window !== 'undefined' ? window : globalThis);
