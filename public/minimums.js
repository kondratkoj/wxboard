// Weather minimums + risk bands. Pure functions, shared by the page and tests.
//
// Table: 14 CFR 135.609(a) HAA Class G VFR ceiling/flight-visibility minimums (ceiling ft, visibility SM).
// Non-local (cross-country) rows are the default; users with designated local flying areas can switch.
// Terrain defaults to 'auto': each airport's row (mountainous or not) comes from 14 CFR Part 95 Subpart B (public/terrain.js).
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
    terrain: 'auto',     // 'auto' (per airport, from 14 CFR Part 95 Subpart B) | 'non' | 'mtn'
    area: 'xc',          // 'xc' (non-local) | 'local'
    nightMode: 'nvg',    // 'nvg' (aided) | 'unaided'
    rules: '135',        // '135' (135.609(a) HAA table) | '91' (91.155 basic VFR by surface airspace)
    aircraft: 'heli',    // Part 91 only: 'heli' | 'plane'
    bands: { amberCeil: 700, amberVis: 3, critCeil: 200, critVis: 2 },
  };

  // terrain: 'mtn' | 'non' for this airport. Left out, a fixed setting is used ('auto' without a place counts as non-mountainous).
  const terrainOf = (s, terrain) => (terrain === 'mtn' || terrain === 'non' ? terrain : s.terrain === 'mtn' ? 'mtn' : 'non');
  const rowKey = (s, terrain) => `${terrainOf(s, terrain)}-${s.area === 'local' ? 'local' : 'xc'}`;
  const colKey = (phase, s) => (phase === 'day' ? 'day' : s.nightMode === 'unaided' ? 'night' : 'nvg');

  // phase: 'day' | 'night'
  function limitsFor(phase, s, terrain) {
    const t = terrainOf(s, terrain);
    const [ceil, vis] = HAA_135_609[rowKey(s, t)][colKey(phase, s)];
    const label = `${phase === 'day' ? 'Day' : s.nightMode === 'unaided' ? 'Night unaided' : 'Night NVG'}, ${t === 'mtn' ? 'mountainous' : 'non-mountainous'} ${s.area === 'local' ? 'local' : 'cross-country'}`;
    return { ceil, vis, label, terrain: t, row: rowKey(s, t), col: colKey(phase, s), rule: '135', ref: '135.609(a)' };
  }

  // 14 CFR 91.155 basic VFR minimums at an airport, by the airspace at the surface (eCFR text, 2026-11-01).
  //  - Inside a Class B/C/D/E surface area: 91.155(c) no VFR beneath a ceiling under 1,000 ft, and 91.155(d) no takeoff,
  //    landing or pattern entry unless ground visibility is at least 3 SM. Special VFR (91.157) is the way below that.
  //  - Class G, 1,200 ft AGL or less (91.155(a) table): helicopter day 1/2 SM, night 1 SM, clear of clouds;
  //    other aircraft day 1 SM clear of clouds, night 3 SM with 500 below / 1,000 above / 2,000 horizontal.
  //    No ceiling minimum: ceil is 0 and noCeil is set, so the ceiling colors only show how close the clouds are.
  // airspace: { cls, partTime, name } from the server, or null when the lookup failed (surface-area numbers are used).
  function limits91(phase, airspace, s) {
    const night = phase === 'night';
    const when = night ? 'Night' : 'Day';
    const heli = s.aircraft !== 'plane';
    const cls = airspace && airspace.cls;
    if (!cls || cls !== 'G') {
      const where = !cls ? 'surface airspace unknown, surface-area minimums used' : `Class ${cls} surface area${airspace.partTime ? ' (part-time)' : ''}`;
      return { ceil: 1000, vis: 3, label: `${when}, ${where}`, rule: '91', cls: cls || null, ref: '91.155(c),(d)', row: 'sfc', col: night ? 'night' : 'day' };
    }
    const vis = heli ? (night ? 1 : 0.5) : (night ? 3 : 1);
    return { ceil: 0, vis, noCeil: true, label: `${when}, Class G ${heli ? 'helicopter' : 'airplane'}`, rule: '91', cls: 'G', ref: '91.155(a)', row: heli ? 'g-heli' : 'g-plane', col: night ? 'night' : 'day' };
  }

  // Absolute thresholds for a limit and the bands, for showing "Green at 1,500 ft / 5 SM and up".
  function thresholds(lim, bands) {
    return {
      ceil: { red: lim.ceil, crit: lim.ceil + bands.critCeil, amber: lim.ceil + bands.amberCeil },
      vis: { red: lim.vis, crit: lim.vis + bands.critVis, amber: lim.vis + bands.amberVis },
    };
  }
  // Settings that can't do what the pilot probably means (e.g. Amber Critical wider than Amber, so Amber never shows).
  function bandProblems(b) {
    const out = [];
    if (b.critCeil >= b.amberCeil && b.amberCeil > 0) out.push('Ceiling: the Amber Critical margin is as wide as Amber or wider, so ceiling Amber will never show.');
    if (b.critVis >= b.amberVis && b.amberVis > 0) out.push('Visibility: the Amber Critical margin is as wide as Amber or wider, so visibility Amber will never show.');
    return out;
  }

  const LEVELS = ['green', 'amber', 'critical', 'red'];
  const LABEL = { green: 'Green', amber: 'Amber', critical: 'Amber Crit', red: 'Red' };

  // ceilFt: null = no ceiling. visSM: null = unknown (judged on ceiling only).
  function assess(ceilFt, visSM, lim, bands) {
    const c = ceilFt == null ? Infinity : ceilFt;
    const reasons = [];
    let lvl = 0;
    const bump = (n, why) => { if (n > lvl) lvl = n; reasons.push(why); };
    if (lim.noCeil) {
      // No ceiling minimum (Class G under Part 91): only how close the clouds are, never Red.
      if (c < bands.critCeil) bump(2, `ceiling ${c} ft, under ${bands.critCeil} ft (no ceiling minimum here)`);
      else if (c < bands.amberCeil) bump(1, `ceiling ${c} ft, under ${bands.amberCeil} ft (no ceiling minimum here)`);
    }
    else if (c < lim.ceil) bump(3, `ceiling ${c} ft below ${lim.ceil}`);
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

  const api = { HAA_135_609, DEFAULTS, limitsFor, limits91, thresholds, bandProblems, assess, worst, LEVELS, LABEL };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Minimums = api;
})(typeof window !== 'undefined' ? window : globalThis);
