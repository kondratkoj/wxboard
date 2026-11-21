const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const as = require('../lib/sources/airspace');
const MN = require('../public/minimums');

// Fixture: real FAA Class_Airspace outlines (2026-11-21) for the demo airports.
const fx = require(path.join(__dirname, '..', 'fixtures', 'faa-airspace.json'));
const areas = fx.features.map((f) => ({ type: f.attributes.LOCAL_TYPE, cls: f.attributes.CLASS, name: f.attributes.NAME,
  partTime: f.attributes.WKHR_CODE !== 'H24', rings: f.geometry.rings }));

test('surface airspace at the demo airports', () => {
  const at = (lat, lon) => as.classifyPoint(lat, lon, areas);
  assert.equal(at(35.0424, -89.9767).cls, 'B');                 // KMEM
  assert.equal(at(34.7273, -92.2358).cls, 'C');                 // KLIT
  assert.equal(at(36.2819, -94.3068).partTime, true);           // KXNA, Class C by NOTAM
  assert.equal(at(35.3366, -94.3674).cls, 'D');                 // KFSM: D wins over the E2 under it
  assert.equal(at(36.2673, -93.1566).type, 'CLASS_E2');         // KHRO
  assert.equal(at(35.2573, -93.095).cls, 'G');                  // KRUE
});

test('Part 91 limits: surface areas, Class G by aircraft and day/night', () => {
  const heli = { ...MN.DEFAULTS, rules: '91', aircraft: 'heli' }, plane = { ...heli, aircraft: 'plane' };
  assert.deepEqual([MN.limits91('day', { cls: 'D' }, heli).ceil, MN.limits91('day', { cls: 'D' }, heli).vis], [1000, 3]);
  assert.equal(MN.limits91('day', null, heli).ceil, 1000); // lookup failed: surface-area numbers
  assert.equal(MN.limits91('day', { cls: 'G' }, heli).vis, 0.5);
  assert.equal(MN.limits91('night', { cls: 'G' }, heli).vis, 1);
  assert.equal(MN.limits91('day', { cls: 'G' }, plane).vis, 1);
  assert.equal(MN.limits91('night', { cls: 'G' }, plane).vis, 3);
  // No ceiling minimum in Class G: a low ceiling is never Red.
  const g = MN.limits91('day', { cls: 'G' }, heli);
  assert.equal(MN.assess(100, 5, g, MN.DEFAULTS.bands).level, 'critical');
  assert.equal(MN.assess(100, 0.25, g, MN.DEFAULTS.bands).level, 'red');
  assert.equal(MN.assess(900, 5, MN.limits91('day', { cls: 'C' }, heli), MN.DEFAULTS.bands).level, 'red');
});

const AH = require('../public/airspace-hours');
const nasr = require('../lib/sources/nasr');

test('airspace hours: Fort Smith Class D 0530-2300 local, other times E (matches Chart Supplement 1130-0500Z‡)', () => {
  const p = AH.parse('CLASS D SVC 0530-2300; OTHER TIMES CLASS E');
  const at = (iso) => AH.classAt(p, Date.parse(iso), 'America/Chicago').cls;
  assert.equal(at('2026-11-21T11:29Z'), 'E'); assert.equal(at('2026-11-21T11:31Z'), 'D');   // CST
  assert.equal(at('2026-11-22T04:59Z'), 'D'); assert.equal(at('2026-11-22T05:01Z'), 'E');
  assert.equal(at('2026-07-04T10:29Z'), 'E'); assert.equal(at('2026-07-04T10:31Z'), 'D');   // CDT
  const z = AH.parse('CLASS D SVC 1130-0500Z++; OTHER TIMES CLASS E');                        // same hours, UTC with ‡
  for (const iso of ['2026-11-21T11:29Z', '2026-11-21T11:31Z', '2026-07-04T10:29Z', '2026-07-04T10:31Z', '2026-07-05T03:59Z', '2026-07-05T04:01Z'])
    assert.equal(AH.classAt(z, Date.parse(iso), 'America/Chicago').cls, at(iso), iso);
});

test('airspace hours: weekdays, seasons, continuous, and what stays unparsed', () => {
  const wk = AH.parse('CLASS D SVC 0700-2100 MON-FRI, 0800-2000 SAT-SUN; OTHER TIMES CLASS E');
  assert.equal(AH.classAt(wk, Date.parse('2026-11-21T13:30Z'), 'America/Chicago').cls, 'E'); // Sat 0730 CST
  assert.equal(AH.classAt(wk, Date.parse('2026-11-20T13:30Z'), 'America/Chicago').cls, 'D'); // Fri 0730 CST
  const ssn = AH.parse('CLASS D SVC 0600-2100 1 APR-30 SEP, 0700-1900 1 OCT-31 MAR; OTHER TIMES CLASS G'); // FLG
  assert.equal(AH.classAt(ssn, Date.parse('2026-07-15T03:30Z'), 'America/Phoenix').cls, 'D'); // 20:30 MST in July
  assert.equal(AH.classAt(ssn, Date.parse('2026-01-15T03:30Z'), 'America/Phoenix').cls, 'G'); // 20:30 MST in January
  assert.equal(AH.parse('CLASS E SVC CONTINUOUS').kind, 'continuous');
  const hol = AH.parse('CLASS D SVC 1400-0400Z++ MON-FRI, 1600-0000Z++ SAT-SUN, CLSD FED HOL; OTHER TIMES CLASS E');
  assert.equal(hol.kind, 'schedule'); assert.equal(hol.holidays, true);
  for (const t of ['CLASS D SVC BY NOTAM; OTHER TIMES CLASS G', 'CLASS D SVC DURING TWR HRS; OTHER TIMES CLASS E',
    'CLASS D SVC 0900-0200++ MON; OTHER TIMES CLASS G', 'CLASS D SVC 0600-2200; OTHER TIMES BY NOTAM; OTHER TIMES CLASS G'])
    assert.equal(AH.parse(t).kind, 'unparsed', t);
  // Unparsed or no time zone: in effect is unknown, and the part-time class is kept (the more restrictive).
  assert.deepEqual([AH.classAt(AH.parse('CLASS D SVC BY NOTAM; OTHER TIMES CLASS G'), Date.now(), 'America/Chicago').cls, AH.classAt(AH.parse('CLASS D SVC 0530-2300; OTHER TIMES CLASS E'), Date.now(), null).inEffect], ['D', null]);
});

test('NASR: cycle dates, file names and the CSV index', () => {
  assert.equal(new Date(nasr.cycleAt(Date.parse('2026-11-21T12:00Z'))).toISOString().slice(0, 10), '2026-10-29');
  assert.equal(new Date(nasr.cycleAt(Date.parse('2026-11-26T12:00Z'))).toISOString().slice(0, 10), '2026-11-26');
  assert.equal(nasr.fileName(Date.UTC(2026, 9, 29)), '29_Oct_2026_CLS_ARSP_CSV.zip');
  const { byId } = nasr.index(require('fs').readFileSync(path.join(__dirname, '..', 'fixtures', 'nasr-cls-arsp.csv'), 'utf8'));
  assert.equal(byId.get('FSM').hours, 'CLASS D SVC 0530-2300; OTHER TIMES CLASS E');
  assert.equal(byId.get('LIT').hours, null);
});

test('NASR: the minimal zip reader reads a deflated entry', () => {
  const zlib = require('zlib');
  const data = Buffer.from('"ARPT_ID","AIRSPACE_HRS"\n"FSM","CLASS D SVC 0530-2300; OTHER TIMES CLASS E"\n');
  const comp = zlib.deflateRawSync(data), name = Buffer.from('CLS_ARSP.csv');
  const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(8, 8); local.writeUInt32LE(comp.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(name.length, 26);
  const cen = Buffer.alloc(46); cen.writeUInt32LE(0x02014b50, 0); cen.writeUInt16LE(8, 10); cen.writeUInt32LE(comp.length, 20); cen.writeUInt32LE(data.length, 24); cen.writeUInt16LE(name.length, 28); cen.writeUInt32LE(0, 42);
  const body = Buffer.concat([local, name, comp]);
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10); end.writeUInt32LE(46 + name.length, 12); end.writeUInt32LE(body.length, 16);
  const files = nasr.unzip(Buffer.concat([body, cen, name, end]));
  assert.equal(files['CLS_ARSP.csv'].toString(), data.toString());
});
