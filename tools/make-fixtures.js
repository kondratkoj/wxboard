// Builds the offline demo data in /fixtures.
// KRUE/KHRO/KLIT METARs, the KLIT TAF header and the PIREP are real reports captured
// 2026-11-19 ~13Z from aviationweather.gov. Everything else is MADE UP to exercise the UI.
const fs = require('fs');
const path = require('path');
const BASE = 1795092780; // 2026-11-19 12:53Z
const out = path.join(__dirname, '..', 'fixtures');
const w = (name, data) => fs.writeFileSync(path.join(out, name + '.json'), JSON.stringify({ __base: BASE, data }, null, 1));
const H = 3600;

const stations = [
  { icaoId: 'KRUE', lat: 35.2573, lon: -93.095, site: 'Russellville Rgnl' },
  { icaoId: 'KHRO', lat: 36.2673, lon: -93.1566, site: 'Harrison/Boone Cnty' },
  { icaoId: 'KLIT', lat: 34.7273, lon: -92.2358, site: 'Little Rock/Clinton Natl' },
  { icaoId: 'KFSM', lat: 35.3366, lon: -94.3674, site: 'Fort Smith Rgnl (DEMO)' },
  { icaoId: 'KBPK', lat: 36.3689, lon: -92.4705, site: 'Mountain Home (DEMO)' },
  { icaoId: 'KXNA', lat: 36.2819, lon: -94.3068, site: 'NW Arkansas Natl (DEMO)' },
  { icaoId: 'KCVK', lat: 35.0, lon: -93.0, site: 'Fake Field (DEMO)' },
  { icaoId: 'KMEM', lat: 35.04, lon: -89.98, site: 'Memphis (DEMO coords)' },
  { icaoId: 'KSGF', lat: 37.24, lon: -93.39, site: 'Springfield (DEMO coords)' },
  { icaoId: 'KTUL', lat: 36.2, lon: -95.89, site: 'Tulsa (DEMO coords)' },
];
w('awc-stationinfo', stations);

const real = [
  { icaoId: 'KHRO', obsTime: BASE, temp: 5, dewp: 4.4, wdir: 150, wspd: 3, visib: 6, altim: 1028.2, wxString: 'BR', metarType: 'METAR',
    rawOb: 'METAR KHRO 191253Z AUTO 15003KT 6SM BR FEW038 05/04 A3036 RMK AO2 SLP282 T00500044 $', lat: 36.2673, lon: -93.1566, elev: 417,
    name: 'Harrison/Boone Cnty, AR, US', clouds: [{ cover: 'FEW', base: 3800 }], fltCat: 'VFR' },
  { icaoId: 'KLIT', obsTime: BASE, temp: 8.3, dewp: 3.9, wdir: 0, wspd: 0, visib: '10+', altim: 1028.2, metarType: 'METAR',
    rawOb: 'METAR KLIT 191253Z 00000KT 10SM FEW100 FEW250 08/04 A3036 RMK AO2 SLP285 T00830039', lat: 34.7273, lon: -92.2358, elev: 77,
    name: 'Little Rock/Clinton Natl, AR, US', clouds: [{ cover: 'FEW', base: 10000 }, { cover: 'FEW', base: 25000 }], fltCat: 'VFR' },
  { icaoId: 'KRUE', obsTime: BASE, temp: 8.3, dewp: 7.2, wdir: 0, wspd: 0, visib: '10+', altim: 1027.5, metarType: 'METAR',
    rawOb: 'METAR KRUE 191253Z AUTO 00000KT 10SM BKN047 08/07 A3034 RMK AO2 SLP272 T00830072', lat: 35.2573, lon: -93.095, elev: 119,
    name: 'Russellville Rgnl, AR, US', clouds: [{ cover: 'BKN', base: 4700 }], fltCat: 'VFR' },
];
const fake = [
  { icaoId: 'KFSM', obsTime: BASE - 120, temp: 7, dewp: 7, wdir: 180, wspd: 6, visib: 2, altim: 1027.0, wxString: '-RA BR', metarType: 'METAR',
    rawOb: 'METAR KFSM 191251Z 18006KT 2SM -RA BR OVC008 07/07 A3033 RMK DEMO DATA', lat: 35.3366, lon: -94.3674, elev: 140,
    name: 'Fort Smith (DEMO)', clouds: [{ cover: 'OVC', base: 800 }] },
  { icaoId: 'KBPK', obsTime: BASE - 60, temp: 4, dewp: 3, wdir: 'VRB', wspd: 3, visib: 4, altim: 1028.5, wxString: 'BR', metarType: 'METAR',
    rawOb: 'METAR KBPK 191252Z VRB03KT 4SM BR BKN022 04/03 A3037 RMK DEMO DATA', lat: 36.3689, lon: -92.4705, elev: 282,
    name: 'Mountain Home (DEMO)', clouds: [{ cover: 'BKN', base: 2200 }] },
  { icaoId: 'KXNA', obsTime: BASE - 5400, temp: 6, dewp: 6, wdir: 200, wspd: 12, wgst: 22, visib: 0.25, altim: 1026.0, wxString: 'FG', metarType: 'SPECI',
    rawOb: 'SPECI KXNA 191123Z 20012G22KT 1/4SM FG VV002 06/06 A3030 RMK DEMO DATA (STALE)', lat: 36.2819, lon: -94.3068, elev: 395,
    name: 'NW Arkansas (DEMO)', clouds: [], vertVis: 200 },
];
// Current METARs, plus a 6-hour history variant for the "hours" parameter (METAR trend). History is MADE UP.
const hist = [];
const obs = (id, hrsAgo, raw, extra) => {
  const base = real.find((r) => r.icaoId === id);
  hist.push({ ...base, ...extra, obsTime: BASE - hrsAgo * 3600, rawOb: raw + ' (DEMO HISTORY)' });
};
[[5, 'SCT080', [{ cover: 'SCT', base: 8000 }]], [4, 'BKN070', [{ cover: 'BKN', base: 7000 }]], [3, 'BKN060', [{ cover: 'BKN', base: 6000 }]],
 [2, 'BKN055', [{ cover: 'BKN', base: 5500 }]], [1, 'BKN050', [{ cover: 'BKN', base: 5000 }]]].forEach(([h, cl, clouds]) =>
  obs('KRUE', h, `METAR KRUE ${String(12 - h).padStart(2, '0')}53Z AUTO 00000KT 10SM ${cl} 08/06 A3034`, { clouds, visib: '10+', wdir: 0, wspd: 0, fltCat: 'VFR' }));
[[5, '1/2SM FG VV002', 0.5, [], 200, 'FG'], [4, '1SM BR OVC004', 1, [{ cover: 'OVC', base: 400 }], null, 'BR'], [3, '2SM BR OVC006', 2, [{ cover: 'OVC', base: 600 }], null, 'BR'],
 [2, '3SM BR BKN009', 3, [{ cover: 'BKN', base: 900 }], null, 'BR'], [1, '5SM BR BKN015', 5, [{ cover: 'BKN', base: 1500 }], null, 'BR']].forEach(([h, wx, vis, clouds, vv, ws]) =>
  obs('KHRO', h, `METAR KHRO ${String(12 - h).padStart(2, '0')}53Z AUTO 00000KT ${wx} 04/04 A3036`, { clouds, visib: vis, vertVis: vv, wxString: ws, wdir: 0, wspd: 0, fltCat: null }));
[5, 4, 3, 2, 1].forEach((h) => obs('KLIT', h, `METAR KLIT ${String(12 - h).padStart(2, '0')}53Z 00000KT 10SM FEW100 07/04 A3036`, { wdir: 0, wspd: 0 }));
hist.push(...real);
fs.writeFileSync(path.join(out, 'awc-metar.json'), JSON.stringify({ __base: BASE, data: { __byParam: 'hours', variants: { '6': hist, default: [...real, ...fake] } } }, null, 1));

w('awc-taf', [
  { icaoId: 'KLIT', issueTime: '2026-11-19T11:20:00.000Z', validTimeFrom: BASE - 53 * 60 - 1 * H, validTimeTo: BASE - 53 * 60 + 23 * H, name: 'Little Rock/Clinton Natl',
    rawTAF: 'TAF KLIT 191120Z 1912/2012 VRB03KT P6SM SCT050 SCT250 FM191800 16008KT P6SM BKN040 TEMPO 1921/1924 4SM -RA BKN015 FM200300 18010G18KT 3SM -RA BR OVC008 (DEMO PERIODS)',
    lat: 34.7273, lon: -92.2358, fcsts: [
      { timeFrom: BASE - 53 * 60 - H, timeTo: BASE - 53 * 60 + 5 * H, fcstChange: null, wdir: 'VRB', wspd: 3, visib: '6+', clouds: [{ cover: 'SCT', base: 5000 }, { cover: 'SCT', base: 25000 }] },
      { timeFrom: BASE - 53 * 60 + 5 * H, timeTo: BASE - 53 * 60 + 14 * H, fcstChange: 'FM', wdir: 160, wspd: 8, visib: '6+', clouds: [{ cover: 'BKN', base: 4000 }] },
      { timeFrom: BASE - 53 * 60 + 8 * H, timeTo: BASE - 53 * 60 + 11 * H, fcstChange: 'TEMPO', visib: 4, wxString: '-RA', clouds: [{ cover: 'BKN', base: 1500 }] },
      { timeFrom: BASE - 53 * 60 + 14 * H, timeTo: BASE - 53 * 60 + 23 * H, fcstChange: 'FM', wdir: 180, wspd: 10, wgst: 18, visib: 3, wxString: '-RA BR', clouds: [{ cover: 'OVC', base: 800 }] },
    ] },
  { icaoId: 'KFSM', issueTime: '2026-11-19T11:40:00.000Z', validTimeFrom: BASE - 53 * 60 - H, validTimeTo: BASE - 53 * 60 + 23 * H, name: 'Fort Smith (DEMO)',
    rawTAF: 'TAF KFSM 191140Z 1912/2012 18006KT 2SM -RA BR OVC008 BECMG 1916/1918 5SM BKN025 PROB30 1922/2002 1SM TSRA OVC005CB (DEMO DATA)',
    lat: 35.3366, lon: -94.3674, fcsts: [
      { timeFrom: BASE - 53 * 60 - H, timeTo: BASE - 53 * 60 + 3 * H, fcstChange: null, wdir: 180, wspd: 6, visib: 2, wxString: '-RA BR', clouds: [{ cover: 'OVC', base: 800 }] },
      { timeFrom: BASE - 53 * 60 + 3 * H, timeTo: BASE - 53 * 60 + 23 * H, timeBec: BASE - 53 * 60 + 5 * H, fcstChange: 'BECMG', visib: 5, clouds: [{ cover: 'BKN', base: 2500 }] },
      { timeFrom: BASE - 53 * 60 + 9 * H, timeTo: BASE - 53 * 60 + 13 * H, fcstChange: 'PROB', probability: 30, visib: 1, wxString: 'TSRA', clouds: [{ cover: 'OVC', base: 500, type: 'CB' }] },
    ] },
]);

w('awc-pirep', [
  { receiptTime: '2026-11-19T13:08:00Z', obsTime: BASE + 840, icaoId: 'LIT', acType: 'B738', lat: 34.4225, lon: -91.9212, fltLvl: 360,
    tbInt1: 'NEG', rawOb: 'LIT UA /OV LIT135020/TM 1307/FL360/TP B738/TB NEG 360-380/RM ZME', pirepType: 'PIREP' },
  { receiptTime: '2026-11-19T12:40:00Z', obsTime: BASE - 900, icaoId: 'FSM', acType: 'C172', lat: 35.4, lon: -94.0, fltLvl: 40,
    icgInt1: 'LGT', icgType1: 'RIME', icgBas1: 40, icgTop1: 50, rawOb: 'FSM UA /OV FSM090015/TM 1238/FL040/TP C172/IC LGT RIME 040-050 (DEMO DATA)', pirepType: 'PIREP' },
  { receiptTime: '2026-11-19T12:30:00Z', obsTime: BASE - 1500, icaoId: 'RUE', acType: 'B407', lat: 35.5, lon: -93.4, fltLvl: 25,
    tbInt1: 'SEV', tbType1: 'CHOP', tbBas1: 15, tbTop1: 30, rawOb: 'RUE UUA /OV RUE300020/TM 1228/FL025/TP B407/TB SEV CHOP 015-030 (DEMO DATA)', pirepType: 'Urgent PIREP' },
]);

const box = (lon1, lat1, lon2, lat2) => ({ type: 'Polygon', coordinates: [[[lon1, lat1], [lon2, lat1], [lon2, lat2], [lon1, lat2], [lon1, lat1]]] });
w('awc-airsigmet', { type: 'FeatureCollection', features: [
  { type: 'Feature', geometry: box(-94.8, 34.6, -93.6, 35.6), properties: { icaoId: 'KKCI', airSigmetType: 'SIGMET', alphaChar: 'C', hazard: 'CONVECTIVE', seriesId: '22C',
    validTimeFrom: BASE - 600, validTimeTo: BASE + 2 * H, severity: null, altitudeHi1: 38000, rawAirSigmet: 'CONVECTIVE SIGMET 22C VALID UNTIL 1455Z AR OK FROM 30W FSM-... AREA TS MOV FROM 24025KT. TOPS TO FL380. (DEMO DATA)' } },
  { type: 'Feature', geometry: box(-80, 40, -78, 42), properties: { icaoId: 'KKCI', airSigmetType: 'AIRMET', hazard: 'TURB', validTimeFrom: BASE, validTimeTo: BASE + 6 * H, rawAirSigmet: 'FAR AWAY - should be filtered out' } },
] });
w('awc-gairmet', { type: 'FeatureCollection', features: [
  { type: 'Feature', geometry: box(-95, 35, -92.5, 36.6), properties: { product: 'SIERRA', hazard: 'IFR', tag: '1S', forecast: '0', validTime: '2026-11-19T15:00:00Z', dueTo: 'CIG BLW 010/VIS BLW 3SM PCPN/BR (DEMO DATA)' } },
  { type: 'Feature', geometry: box(-95, 35, -92.5, 36.6), properties: { product: 'SIERRA', hazard: 'IFR', tag: '1S', forecast: '3', validTime: '2026-11-19T18:00:00Z', dueTo: 'CIG BLW 010/VIS BLW 3SM PCPN/BR (DEMO DATA)' } },
  { type: 'Feature', geometry: { type: 'LineString', coordinates: [[-96, 35.2], [-90, 35.8]] }, properties: { product: 'ZULU', hazard: 'FZLVL', forecast: '0', validTime: '2026-11-19T15:00:00Z' } },
] });
w('awc-cwa', { type: 'FeatureCollection', features: [] });

// TFR shapes: one near Russellville, one far away.
const circle = (lat, lon, nm) => { const ring = []; for (let i = 0; i <= 24; i++) { const a = (i / 24) * 2 * Math.PI; ring.push([lon + (nm / 60) * Math.cos(a) / Math.cos(lat * Math.PI / 180), lat + (nm / 60) * Math.sin(a)]); } return { type: 'Polygon', coordinates: [ring] }; };
w('tfr-wfs', { type: 'FeatureCollection', features: [
  { type: 'Feature', geometry: circle(35.31, -93.23, 3), properties: { NOTAM_KEY: '6/9999-1-FDC-F', CNS_LOCATION_ID: 'ZME' } },
  { type: 'Feature', geometry: circle(28.4, -80.6, 30), properties: { NOTAM_KEY: '6/0284-1-FDC-F', CNS_LOCATION_ID: 'ZMA' } },
] });
w('tfr-list', [
  { notam_id: '6/9999', type: 'HAZARDS', facility: 'ZME', state: 'AR', description: '5NM W RUSSELLVILLE, AR, (DEMO DATA) Nuclear plant area', creation_date: '11/19/2026' },
  { notam_id: '6/0284', type: 'SPACE OPERATIONS', facility: 'ZMA', state: 'FL', description: 'Cape Canaveral, FL (DEMO DATA)', creation_date: '11/18/2026' },
]);

w('nws-points', { properties: { forecast: 'https://api.weather.gov/gridpoints/LZK/1,1/forecast', forecastHourly: 'https://api.weather.gov/gridpoints/LZK/1,1/forecast/hourly', gridId: 'LZK', relativeLocation: { properties: { city: 'Russellville', state: 'AR' } } } });
w('nws-forecast', { properties: { updated: '2026-11-19T12:00:00Z', periods: [
  { name: 'Today', temperature: 61, temperatureUnit: 'F', windDirection: 'S', windSpeed: '5 to 10 mph', shortForecast: 'Mostly Cloudy (DEMO)', detailedForecast: 'Demo data.', probabilityOfPrecipitation: { value: 10 } },
  { name: 'Tonight', temperature: 49, temperatureUnit: 'F', windDirection: 'S', windSpeed: '5 mph', shortForecast: 'Chance Light Rain (DEMO)', detailedForecast: 'Demo data.', probabilityOfPrecipitation: { value: 40 } },
  { name: 'Friday', temperature: 58, temperatureUnit: 'F', windDirection: 'SW', windSpeed: '10 mph', shortForecast: 'Rain Likely (DEMO)', detailedForecast: 'Demo data.', probabilityOfPrecipitation: { value: 70 } },
  { name: 'Friday Night', temperature: 40, temperatureUnit: 'F', windDirection: 'NW', windSpeed: '10 mph', shortForecast: 'Clearing (DEMO)', detailedForecast: 'Demo data.', probabilityOfPrecipitation: { value: 20 } },
] } });

const iso = (s) => new Date(s * 1000).toISOString();
// Shape follows the FAA NMS-API spec (v1.0.18) GeoJSON example.
let nid = 1795000000000000;
const notam = (num, loc, cls, text, start, end, extra = {}) => ({ type: 'Feature', properties: { coreNOTAMData: {
  notam: { id: 'NMS_ID_' + (nid++), number: num, location: loc, icaoLocation: 'K' + loc, classification: cls, effectiveStart: iso(start), effectiveEnd: end ? iso(end) : null, estimated: extra.est ? 'true' : 'false', text: text.replace(/^!\S+ \S+ \S+ /, ''), ...extra.n },
  notamTranslation: [{ type: 'LOCAL_FORMAT', simpleText: text }] } },
  geometry: { type: 'GeometryCollection', geometries: [{ type: 'Point', coordinates: [-93.1, 35.26] }] } });
w('nms-token', { access_token: 'demo', expires_in: 1800 });
fs.writeFileSync(path.join(out, 'nms-notams.json'), JSON.stringify({ __base: BASE, data: { __byParam: 'location', variants: {
  KRUE: { status: 'Success', data: { geojson: [
    notam('11/012', 'RUE', 'DOM', '!RUE 11/012 RUE RWY 07/25 CLSD 1400-2000 DLY (DEMO DATA)', BASE + 2 * H, BASE + 3 * 24 * H),
    notam('10/044', 'RUE', 'DOM', '!RUE 10/044 RUE OBST TOWER LGT (ASR 1234567) 351500N0930500W (5NM W RUE) 1049FT (300FT AGL) U/S (DEMO DATA)', BASE - 10 * 24 * H, BASE + 5 * 24 * H),
    notam('11/009', 'RUE', 'DOM', '!RUE 11/009 RUE NAV RNAV (GPS) RWY 07 LPV DA NA (DEMO DATA)', BASE - 2 * 24 * H, null),
    notam('11/014', 'RUE', 'DOM', '!RUE 11/014 RUE RWY 07 REIL U/S (DEMO DATA)', BASE - 3 * H, BASE + 30 * H),
    notam('11/015', 'RUE', 'DOM', '!RUE 11/015 RUE SVC FUEL 100LL NOT AVBL (DEMO DATA)', BASE - 1 * H, BASE + 20 * H),
    notam('11/016', 'RUE', 'DOM', '!RUE 11/016 RUE TWY B CLSD (DEMO DATA)', BASE - 6 * H, BASE + 4 * H, { est: true }),
    notam('11/017', 'RUE', 'DOM', '!RUE 11/017 RUE AD AP BCN U/S (DEMO DATA)', BASE + 1 * H, BASE + 10 * H),
    notam('11/018', 'RUE', 'DOM', '!RUE 11/018 RUE OBST CRANE (ASR UNKNOWN) 351600N0930400W (1NM N RUE) 520FT (180FT AGL) FLAGGED AND LGTD (DEMO DATA)', BASE - 2 * H, BASE + 48 * H),
  ] } },
  KLIT: { status: 'Success', data: { geojson: [
    notam('11/150', 'LIT', 'DOM', '!LIT 11/150 LIT TWY C CLSD (DEMO DATA)', BASE - 3 * H, BASE + 9 * H),
    notam('11/161', 'LIT', 'DOM', '!LIT 11/161 LIT AD AP BIRD ACT (DEMO DATA)', BASE + 20 * H, BASE + 30 * H),
  ] } },
  KHRO: { status: 'Success', data: { geojson: [] } },
  HRO: { status: 'Success', data: { geojson: [] } },
  RUE: { status: 'Success', data: { geojson: [] } },
  LIT: { status: 'Success', data: { geojson: [] } },
  // Radius (area) searches carry no location parameter, so they get this variant.
  default: { status: 'Success', data: { geojson: [
    notam('11/020', 'DDH', 'DOM', '!DDH 11/020 DDH RWY 18/36 CLSD (DEMO DATA)', BASE - 5 * H, BASE + 40 * H, { est: true }),
    notam('6/1234', 'ZME', 'FDC', '!FDC 6/1234 ZME AR..AIRSPACE RUSSELLVILLE, AR..TEMPORARY FLIGHT RESTRICTIONS WI AN AREA DEFINED AS 3NM RADIUS OF 351840N0931400W SFC-2000FT. PURSUANT TO 14 CFR SECTION 91.137(A)(1) (DEMO DATA)', BASE + 2 * H, BASE + 12 * H, { n: { lowerLimit: 'SFC', upperLimit: '2000FT' } }),
    notam('10/044', 'RUE', 'DOM', '!RUE 10/044 RUE OBST TOWER LGT (ASR 1234567) 351500N0930500W (5NM W RUE) 1049FT (300FT AGL) U/S (DEMO DATA)', BASE - 10 * 24 * H, BASE + 5 * 24 * H),
  ] } },
} } }, null, 1));

// Winds aloft: plain-text FB product, one variant per forecast hour. MADE UP values.
const fb = (based, valid, use, rows) => ({ __text: [
  '000', 'FBUS31 KWNO 191358', 'FD1US1', `DATA BASED ON ${based}`, `VALID ${valid}   FOR USE ${use}. TEMPS NEG ABV 24000`, '',
  'FT  3000    6000    9000   12000   18000   24000  30000  34000  39000', ...rows, ''].join('\n') });
const day = new Date(BASE * 1000).toISOString().slice(8, 10);
fs.writeFileSync(path.join(out, 'awc-windtemp.json'), JSON.stringify({ __byParam: 'fcst', variants: {
  '06': fb(`${day}1200Z`, `${day}1800Z`, '1400-2100Z', [
    'FSM 1815 2025+09 2228+04 2335-01 2448-13 2459-25 256541 257048 258057',
    'LIT 9900 1912+11 2120+06 2228+01 2340-11 2452-23 256039 256546 731060',
    'MEM 1810 1918+12 2122+07 2230+02 2342-10 2455-22 256238 256845 732058',
    'SGF      2018+08 2224+03 2332-02 2444-14 2456-26 256342 257049 259558',
    'TUL 1914 2022+09 2226+04 2334-01 2446-13 2458-25 256441 257148 258557',
    'DEN              2720-02 2830-08 2945-18 2955-30 296045 297052 298560',
  ]),
  '12': fb(`${day}1200Z`, `20${'0000'}Z`.replace('200000', String(Number(day) + 1).padStart(2, '0') + '0000'), '2100-0600Z', [
    'FSM 2020 2230+08 2335+03 2442-02 2555-14 2568-26 257542 258049 259058',
    'LIT 1918 2125+10 2230+05 2338+00 2450-12 2462-24 257040 257547 751561',
    'MEM 1915 2022+11 2128+06 2236+01 2448-11 2460-23 256839 257446 751060',
    'SGF      2124+07 2330+02 2438-03 2550-15 2562-27 257043 257850 760559',
    'TUL 2018 2228+08 2333+03 2440-02 2552-14 2565-26 257242 257949 259958',
  ]),
  '24': fb(`${day}1200Z`, `${String(Number(day) + 1).padStart(2, '0')}1200Z`, '0600-1800Z', [
    'FSM 3010 3115+06 3120+01 3125-04 3035-16 2945-28 285044 285551 286059',
    'LIT 2910 3012+08 3018+03 3022-02 3032-14 2942-26 284842 285349 285758',
    'MEM 2810 2912+09 3015+04 3020-01 3030-13 2940-25 284641 285148 285557',
    'SGF      3118+04 3122-01 3128-06 3038-18 2948-30 285246 285853 286361',
    'TUL 3012 3116+05 3122+00 3126-05 3036-17 2946-29 285045 285652 286160',
  ]),
} }, null, 1));

// Open-Meteo GFS pressure-level winds. MADE UP but physically plausible profile.
{
  const lv = { 1000: 110, 975: 330, 950: 540, 925: 760, 900: 990, 850: 1460, 800: 1950, 750: 2470, 700: 3010, 650: 3590, 600: 4210,
    550: 4860, 500: 5570, 450: 6330, 400: 7180, 350: 8110, 300: 9160, 250: 10360, 200: 11780, 150: 13600 };
  const t0 = Math.floor(BASE / 3600) * 3600 - 12 * 3600;
  const hourly = { time: [] };
  for (let i = 0; i < 48; i++) hourly.time.push(t0 + i * 3600);
  for (const [p, z] of Object.entries(lv)) {
    const km = z / 1000;
    hourly[`geopotential_height_${p}hPa`] = hourly.time.map((_, i) => Math.round(z + 15 * Math.sin(i / 6)));
    hourly[`wind_speed_${p}hPa`] = hourly.time.map((_, i) => Math.round((6 + km * 7 + 4 * Math.sin(i / 5)) * 10) / 10);
    hourly[`wind_direction_${p}hPa`] = hourly.time.map((_, i) => Math.round((170 + km * 8 + i * 1.5) % 360));
    hourly[`temperature_${p}hPa`] = hourly.time.map((_, i) => Math.round((15 - 6.5 * km + 2 * Math.sin(i / 8)) * 10) / 10);
  }
  w('openmeteo', { latitude: 35.25, longitude: -93.1, elevation: 110, hourly });
}

// LAMP (via IEM) and NWS hourly. MADE UP: KRUE lowers to IFR in the evening, KHRO stays VFR.
{
  const h0 = Math.floor(BASE / 3600) * 3600;
  const isoZ = (s) => new Date(s * 1000).toISOString();
  const lav = [];
  const plan = {
    KRUE: (i) => (i < 4 ? [6, 7, 'N', 'SC'] : i < 7 ? [5, 7, 'N', 'BK'] : i < 9 ? [4, 5, 'BR', 'OV'] : i < 13 ? [3, 4, 'BR', 'OV'] : i < 16 ? [4, 5, 'BR', 'OV'] : [6, 7, 'N', 'BK']),
    KHRO: (i) => (i < 10 ? [8, 7, 'N', 'CL'] : i < 14 ? [6, 6, 'N', 'SC'] : [5, 5, 'BR', 'BK']),
    KLIT: (i) => [7, 7, 'N', 'FW'],
  };
  for (const [st, f] of Object.entries(plan)) {
    for (let i = 1; i <= 38; i++) {
      const [cig, vis, obv, cld] = f(i);
      lav.push({ model: 'LAV', station: st, runtime_utc: isoZ(h0), ftime_utc: isoZ(h0 + i * 3600), cig, vis, ccg: Math.max(1, cig - 1), cvs: Math.max(1, vis - 1),
        obv: obv + ' ', cld, wdr: 180, wsp: 6 + (i % 5), gst: i > 6 && i < 10 ? 18 : null, ppo: i > 8 && i < 14 ? 40 : 5, p01: i > 8 && i < 14 ? 35 : 3, lp1: i > 9 && i < 12 ? 12 : 0, cp1: i > 9 && i < 12 ? 15 : 0 });
    }
  }
  w('iem-lav', { schema: {}, data: lav });
  const hourly = [];
  for (let i = 0; i < 36; i++) hourly.push({ startTime: isoZ(h0 + i * 3600), temperature: 60 - Math.round(i / 2), temperatureUnit: 'F',
    windDirection: 'S', windSpeed: `${6 + (i % 4)} mph`, shortForecast: i > 8 && i < 14 ? 'Chance Light Rain (DEMO)' : 'Mostly Cloudy (DEMO)',
    probabilityOfPrecipitation: { value: i > 8 && i < 14 ? 40 : 10 } });
  w('nws-hourly', { properties: { periods: hourly } });
}

console.log('fixtures written to', out);
