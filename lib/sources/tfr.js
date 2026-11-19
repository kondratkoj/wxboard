// FAA TFR data from tfr.faa.gov (public, no key):
//   - TFR list (JSON):   https://tfr.faa.gov/tfrapi/exportTfrList
//   - TFR shapes (WFS):  tfr.faa.gov/geoserver ... outputFormat=application/json
// Shapes are joined to the list by NOTAM number (e.g. "6/0284").
const { getJson } = require('../http');

const LIST_URL = 'https://tfr.faa.gov/tfrapi/exportTfrList';
const WFS_URL =
  'https://tfr.faa.gov/geoserver/TFR/ows?service=WFS&version=1.1.0&request=GetFeature&typeName=TFR:V_TFR_LOC&maxFeatures=300&outputFormat=application/json';

async function allTfrs() {
  const [list, wfs] = await Promise.all([
    getJson(LIST_URL, 600).catch(() => []),
    getJson(WFS_URL, 600),
  ]);
  const meta = new Map();
  for (const t of Array.isArray(list) ? list : []) if (t && t.notam_id) meta.set(t.notam_id, t);

  const byNotam = new Map();
  for (const f of (wfs && wfs.features) || []) {
    const props = f.properties || {};
    const key = String(props.NOTAM_KEY || '');
    const number = key.split('-')[0];
    if (!number) continue;
    if (!byNotam.has(number)) {
      const m = meta.get(number) || {};
      byNotam.set(number, {
        number,
        facility: m.facility || props.CNS_LOCATION_ID || null,
        state: m.state || props.STATE || null,
        type: m.type || props.LEGAL || null,
        description: m.description || props.TITLE || null,
        created: m.creation_date || null,
        geometries: [],
      });
    }
    if (f.geometry) byNotam.get(number).geometries.push(f.geometry);
  }
  return [...byNotam.values()].map((t) => ({
    ...t,
    geometry: t.geometries.length === 1
      ? t.geometries[0]
      : { type: 'GeometryCollection', geometries: t.geometries },
    geometries: undefined,
  }));
}

module.exports = { allTfrs, LIST_PAGE: 'https://tfr.faa.gov/tfr3/?page=list' };
