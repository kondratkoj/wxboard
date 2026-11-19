// NOTAM helpers: category, priority and a plain-English one-liner.
// Pure functions (no DOM), shared by the page and by tests: window.NotamDecode / module.exports.
// The decoded line is a reading aid only. The raw NOTAM text is always one click away and is authoritative.
(function (root) {
  const KEYWORDS = ['RWY', 'TWY', 'APRON', 'AD', 'OBST', 'NAV', 'COM', 'SVC', 'AIRSPACE', 'ODP', 'SID', 'STAR',
    'CHART', 'DATA', 'DVA', 'IAP', 'VFP', 'ROUTE', 'SPECIAL', 'SECURITY'];

  // Display order. "collapsed" groups start folded.
  const CATEGORIES = [
    { id: 'airspace', label: 'Airspace & TFRs' },
    { id: 'airport', label: 'Airport' },
    { id: 'surface', label: 'Runways & Taxiways' },
    { id: 'approach', label: 'Approaches & Navaids' },
    { id: 'services', label: 'Services & Comms' },
    { id: 'other', label: 'Other' },
    { id: 'obstacle', label: 'Obstacles & Tower Lights', collapsed: true },
  ];

  // Strip the "!DFW 11/012 DFW" header and the trailing "2511191400-2511222000EST" validity group.
  function body(text) {
    let t = String(text || '').replace(/\s+/g, ' ').trim();
    t = t.replace(/^!\S+\s+\S+\/\S+\s+\S+\s+/, '');     // !DFW 11/012 DFW
    t = t.replace(/\s+\d{10}-(\d{10}|PERM)(EST)?\s*$/i, ''); // validity at the end
    return t.trim();
  }

  function isTfr(n) {
    const t = String(n.text || '').toUpperCase();
    return /FLIGHT RESTRICTION|\bTFR\b|91\.1(37|38|39|41|43|45)|99\.7\b/.test(t);
  }

  function keyword(n) {
    const toks = body(n.text).toUpperCase().split(' ').slice(0, 4);
    return toks.find((x) => KEYWORDS.includes(x)) || null;
  }

  function category(n) {
    if (isTfr(n)) return 'airspace';
    const k = keyword(n);
    const t = body(n.text).toUpperCase();
    if (k === 'OBST' || /^(OBST|TOWER|TWR LGT|ANTENNA|CRANE)\b/.test(t)) return 'obstacle';
    if (['AIRSPACE', 'SPECIAL', 'SECURITY'].includes(k)) return 'airspace';
    if (['RWY', 'TWY', 'APRON'].includes(k)) return 'surface';
    if (['IAP', 'NAV', 'ODP', 'SID', 'STAR', 'DVA', 'VFP', 'CHART', 'DATA', 'ROUTE'].includes(k)) return 'approach';
    if (['SVC', 'COM'].includes(k)) return 'services';
    if (k === 'AD') return 'airport';
    return 'other';
  }

  const OUT = /\b(U\/S|OTS|UNSERVICEABLE|UNAVBL|NOT AVBL|INOP)\b/;
  const LIGHTS = /\b(REIL|PAPI|VASI|ALS|MALSR|MALSF|ALSF[12]?|SSALR|ODALS|HIRL|MIRL|LIRL|RCLS|TDZL|RWY.*\bLGT|EDGE LGT|PCL)\b/;
  // red = could stop the flight, amber = changes how you fly it, normal = everything else.
  function priority(n) {
    const t = body(n.text).toUpperCase();
    const k = keyword(n);
    if (isTfr(n)) return 'red';
    if (k === 'AD' && /\b(AP|AD)\b.*\bCLSD\b/.test(t) && !/\b(TWY|APRON|RAMP|PAEW)\b/.test(t)) return 'red';
    if (k === 'RWY' && /\bCLSD\b/.test(t) && !/\b(TWY|LGT)\b/.test(t)) return 'red';
    if (/\bHELIPORT\b.*\bCLSD\b|\bHELIPAD\b.*\bCLSD\b|\bFATO\b.*\bCLSD\b/.test(t)) return 'red';
    if (/\bNA\b/.test(t) && (k === 'IAP' || /\b(RNAV|GPS|ILS|LOC|LPV|LNAV|VNAV|VOR|NDB|APCH|ODP|SID|STAR)\b/.test(t))) return 'amber';
    if (/\b(ILS|LOC|GS|GP|VOR|VORTAC|DME|NDB|TACAN|GPS|WAAS|LPV)\b/.test(t) && OUT.test(t)) return 'amber';
    if (LIGHTS.test(t) && OUT.test(t)) return 'amber';
    if (/\bFUEL\b/.test(t) && /\b(NOT AVBL|UNAVBL|U\/S|OTS|LTD)\b/.test(t)) return 'amber';
    if (/\b(TWR|ATIS|AWOS|ASOS|CTAF|UNICOM)\b/.test(t) && (OUT.test(t) || /\bCLSD\b/.test(t))) return 'amber';
    if (/\bBCN\b/.test(t) && OUT.test(t)) return 'amber';
    if (/\bFICON\b|\bBA (POOR|NIL)\b/.test(t)) return 'amber';
    return 'normal';
  }

  // Common FAA contractions. Anything not listed is left as written.
  const WORDS = {
    CLSD: 'closed', 'U/S': 'out of service', OTS: 'out of service', UNSERVICEABLE: 'out of service', INOP: 'inoperative',
    UNAVBL: 'unavailable', AVBL: 'available', LTD: 'limited', NA: 'not authorized',
    RWY: 'runway', TWY: 'taxiway', APN: 'apron', APRON: 'apron', AD: 'airport', AP: '', ARPT: 'airport',
    LGT: 'lights', LGTD: 'lighted', TOWER: 'tower', LGTS: 'lights', BCN: 'beacon', OBST: 'obstacle', TWR: 'tower',
    WIP: 'work in progress', CONST: 'construction', MAINT: 'maintenance', EQPT: 'equipment',
    DLY: 'daily', EXC: 'except', BTN: 'between', ABV: 'above', BLW: 'below', AFT: 'after', BFR: 'before',
    ACT: 'active', CTC: 'contact', FREQ: 'frequency', SVC: 'service', ACFT: 'aircraft', ADJ: 'adjacent',
    APCH: 'approach', AMDT: 'amendment', PROC: 'procedure', MNM: 'minimums', CHG: 'change',
    TEMPO: 'temporarily', PERM: 'permanent', PPR: 'prior permission required', CONT: 'continuous',
    TFC: 'traffic', RTE: 'route', DEP: 'departure', ARR: 'arrival', ALT: 'altitude', HGT: 'height',
    PCL: 'pilot-controlled lighting', HIRL: 'high-intensity runway lights', MIRL: 'medium-intensity runway lights',
    LIRL: 'low-intensity runway lights', REIL: 'runway end identifier lights', RCLS: 'centerline lights',
    TDZL: 'touchdown zone lights', LOC: 'localizer', GS: 'glideslope', GP: 'glidepath',
    AUTH: 'authorized', REQ: 'required', RQRD: 'required', MON: 'monitored', UNMNT: 'unmonitored',
    ASPH: 'asphalt', CONC: 'concrete', THR: 'threshold', DSPLCD: 'displaced', SFC: 'surface',
    N: 'north', S: 'south', E: 'east', W: 'west', NE: 'northeast', NW: 'northwest', SE: 'southeast', SW: 'southwest',
    FT: 'ft', NM: 'nm', AGL: 'AGL', MSL: 'MSL', UNL: 'unlimited',
    FLT: 'flight', RESTRICTIONS: 'restrictions', SKED: 'scheduled', DLA: 'delay',
  };

  // Leading keywords the category heading already says; RWY/TWY/AD stay because they carry meaning.
  const DROP_LEAD = new Set(['NAV', 'IAP', 'SVC', 'COM', 'OBST', 'AIRSPACE', 'SPECIAL', 'SECURITY', 'ODP', 'SID', 'STAR', 'DVA', 'VFP', 'CHART', 'DATA', 'ROUTE']);
  // Ordinary words that read better in lowercase. Identifiers (DFW, 100LL, 22L) are left as written.
  const LOWER = new Set(('FUEL NOT BIRD BIRDS RAMP HELIPORT HELIPAD AREA AREAS RADIUS WITHIN AN AS DEFINED TEMPORARY FLIGHT ' +
    'PURSUANT TO SECTION AND THE OF FOR ON IN AT BY OR WITH WILDLIFE DEER WORK CRANE CRANES GRASS MOWING VEHICLE VEHICLES ' +
    'MARKING MARKINGS PAINT SNOW ICE SAND RUBBER DEBRIS PARACHUTE JUMPING JUMP ACTIVITY LASER BALLOON DRONE OPERATIONS ' +
    'HOLD SHORT LINE LINES SIGN SIGNS EDGE CENTERLINE PARALLEL ENTIRE PORTION EAST WEST NORTH SOUTH ONLY FIRST LAST ' +
    'TIMES DATES HOURS UNTIL FROM IS ARE BE WILL HAS HAVE NO ALL OTHER ADVISE CAUTION ACTIVITY').split(' '));
  const CFR = { '91.137': 'disaster/hazard area', '91.138': 'national disaster area (Hawaii)', '91.139': 'emergency air traffic rules',
    '91.141': 'VIP movement', '91.143': 'space operations', '91.145': 'aerial demonstration / major sporting event', '99.7': 'special security instructions' };
  function tfrLine(n) {
    const t = String(n.text || '').replace(/\s+/g, ' ').toUpperCase();
    const place = (/AIRSPACE\s+(.+?)\.\./.exec(t) || [])[1];
    const rad = (/(\d+(?:\.\d+)?)\s*NM RADIUS/.exec(t) || [])[1];
    const top = (/SFC\s*(?:-|UP TO AND INCLUDING|TO)\s*(\d{3,5})\s*FT/.exec(t) || [])[1];
    const cfr = (/(91\.1(?:37|38|39|41|43|45)|99\.7)\b/.exec(t) || [])[1];
    const titled = (x) => x.toLowerCase().replace(/\b([a-z])/g, (m) => m.toUpperCase()).replace(/\b(Ar|Mo|Ok|Tx|La|Ms|Tn|Ks|Fl|Al|Ga)\b/g, (m) => m.toUpperCase());
    return ['Temporary flight restriction', place && titled(place), rad && `${rad} nm radius`, top && `surface to ${Number(top).toLocaleString()} ft`, cfr && CFR[cfr]]
      .filter(Boolean).join(' · ');
  }

  function plain(n) {
    if (isTfr(n)) return tfrLine(n);
    let words = body(n.text).split(' ').filter(Boolean);
    if (words.length > 1 && DROP_LEAD.has(words[0].toUpperCase())) words = words.slice(1);
    if (!words.length) return '';
    const joined = words.join(' ').replace(/\bNOT AVBL\b/g, 'NOT_AVBL').replace(/\bBIRD ACT\b/g, 'BIRD ACTIVITY').replace(/\bWILDLIFE ACT\b/g, 'WILDLIFE ACTIVITY');
    const out = joined.split(' ').map((w) => {
      if (w === 'NOT_AVBL') return 'not available';
      const m = /^([A-Z/]+)([.,;:]?)$/.exec(w);
      if (m && Object.prototype.hasOwnProperty.call(WORDS, m[1])) return WORDS[m[1]] + m[2];
      if (m && LOWER.has(m[1])) return m[1].toLowerCase() + m[2];
      return w;
    }).filter((w) => w !== '').join(' ').replace(/\s+/g, ' ').trim();
    const s = out.charAt(0).toUpperCase() + out.slice(1);
    return s.length > 160 ? s.slice(0, 157).replace(/\s+\S*$/, '') + '…' : s;
  }

  const api = { CATEGORIES, body, keyword, category, priority, plain, isTfr };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.NotamDecode = api;
})(typeof window !== 'undefined' ? window : globalThis);
