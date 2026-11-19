// Quick live check of the winds aloft feed.
//   node tools/winds-test.js 32.897 -97.038     (latitude longitude; defaults to DFW)
const w = require('../lib/sources/windsaloft');
(async () => {
  const lat = Number(process.argv[2] || 32.897), lon = Number(process.argv[3] || -97.038);
  try {
    const f = await w.pointForecast(lat, lon);
    const i = f.times.reduce((b, t, k) => (Math.abs(t - Date.now()) < Math.abs(f.times[b] - Date.now()) ? k : b), 0);
    console.log(`OK. Ground elevation ${f.elevFt} ft. ${f.times.length} hourly forecasts. Profile for ${new Date(f.times[i]).toISOString()}:`);
    for (const l of f.profiles[i].filter((l) => l.h < 40000)) {
      console.log(`  ${String(l.p).padStart(4)} hPa  ${String(l.h).padStart(6)} ft  ${String(Math.round(l.d)).padStart(3, '0')}°/${Math.round(l.s)}kt  ${l.t}°C`);
    }
  } catch (e) {
    console.log('FAILED:', e.message);
    process.exit(1);
  }
})();
