// Sun position and twilight (NOAA solar calculator equations). No network needed.
// 14 CFR 1.1 "Night": the time between the end of evening civil twilight and the beginning of morning
// civil twilight. Civil twilight = sun center 6° below the horizon.
(function (root) {
  const rad = Math.PI / 180;

  function julianCentury(ms) { return (ms / 86400000 + 2440587.5 - 2451545) / 36525; }

  // Solar elevation in degrees (no refraction correction; fine for the -6° twilight test).
  function elevation(ms, lat, lon) {
    const T = julianCentury(ms);
    const L0 = (280.46646 + T * (36000.76983 + T * 0.0003032)) % 360;
    const M = 357.52911 + T * (35999.05029 - 0.0001537 * T);
    const e = 0.016708634 - T * (0.000042037 + 0.0000001267 * T);
    const C = Math.sin(M * rad) * (1.914602 - T * (0.004817 + 0.000014 * T)) + Math.sin(2 * M * rad) * (0.019993 - 0.000101 * T) + Math.sin(3 * M * rad) * 0.000289;
    const trueLong = L0 + C;
    const omega = 125.04 - 1934.136 * T;
    const lambda = trueLong - 0.00569 - 0.00478 * Math.sin(omega * rad);
    const eps0 = 23 + (26 + (21.448 - T * (46.815 + T * (0.00059 - T * 0.001813))) / 60) / 60;
    const eps = eps0 + 0.00256 * Math.cos(omega * rad);
    const decl = Math.asin(Math.sin(eps * rad) * Math.sin(lambda * rad)) / rad;
    const y = Math.tan((eps / 2) * rad) ** 2;
    const eqTime = 4 / rad * (y * Math.sin(2 * L0 * rad) - 2 * e * Math.sin(M * rad) + 4 * e * y * Math.sin(M * rad) * Math.cos(2 * L0 * rad)
      - 0.5 * y * y * Math.sin(4 * L0 * rad) - 1.25 * e * e * Math.sin(2 * M * rad)); // minutes
    const d = new Date(ms);
    const minutesUTC = d.getUTCHours() * 60 + d.getUTCMinutes() + d.getUTCSeconds() / 60;
    let tst = (minutesUTC + eqTime + 4 * lon) % 1440; // true solar time
    if (tst < 0) tst += 1440;
    let ha = tst / 4 - 180;
    const zen = Math.acos(Math.sin(lat * rad) * Math.sin(decl * rad) + Math.cos(lat * rad) * Math.cos(decl * rad) * Math.cos(ha * rad)) / rad;
    return 90 - zen;
  }

  const isNight = (ms, lat, lon) => elevation(ms, lat, lon) < -6;

  // Find when elevation crosses `deg` between t0 and t1 (bisection), assuming one crossing.
  function cross(t0, t1, lat, lon, deg) {
    let a = t0, b = t1, fa = elevation(a, lat, lon) - deg;
    for (let i = 0; i < 40; i++) {
      const m = (a + b) / 2, fm = elevation(m, lat, lon) - deg;
      if ((fa < 0) === (fm < 0)) { a = m; fa = fm; } else b = m;
    }
    return Math.round((a + b) / 2);
  }

  // All crossings of `deg` within [from, to], scanning in 10-minute steps.
  function crossings(from, to, lat, lon, deg) {
    const out = [];
    const step = 10 * 60e3;
    let prev = elevation(from, lat, lon) - deg;
    for (let t = from + step; t <= to; t += step) {
      const cur = elevation(t, lat, lon) - deg;
      if ((prev < 0) !== (cur < 0)) out.push({ at: cross(t - step, t, lat, lon, deg), rising: cur > prev });
      prev = cur;
    }
    return out;
  }

  // Events in a window: sunrise/sunset (-0.833° includes refraction + sun radius) and civil twilight (-6°).
  function events(from, to, lat, lon) {
    const ev = [];
    for (const c of crossings(from, to, lat, lon, -0.833)) ev.push({ at: c.at, type: c.rising ? 'sunrise' : 'sunset' });
    for (const c of crossings(from, to, lat, lon, -6)) ev.push({ at: c.at, type: c.rising ? 'dawn' : 'dusk' });
    return ev.sort((a, b) => a.at - b.at);
  }

  const api = { elevation, isNight, events };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Sun = api;
})(typeof window !== 'undefined' ? window : globalThis);
