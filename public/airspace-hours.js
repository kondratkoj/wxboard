// Part-time surface airspace: read the FAA's hours text and work out which class is in effect at a moment.
// Pure functions, shared by the page and tests.
//
// The text is NASR CLS_ARSP AIRSPACE_HRS, e.g. "CLASS D SVC 0530-2300; OTHER TIMES CLASS E" (the Chart Supplement's
// "AIRSPACE: CLASS D svc 1130–0500Z‡; other times CLASS E" for the same airport).
//   - Times without Z are local time at the airport (FSM: 0530-2300 local = 1130-0500Z‡ in the Chart Supplement).
//   - Times with Z are UTC; "Z++" (‡ in the Chart Supplement) means one hour earlier during daylight saving time.
//   - Holidays ("EXC HOL", "CLSD FED HOL") can't be checked here and are reported, not applied.
// Anything that doesn't fit these patterns is "unparsed": the caller treats the area as in effect and says so.
(function (root) {
  const DAYS = { SUN: 0, MON: 1, TUE: 2, WED: 3, THU: 4, FRI: 5, SAT: 6 };
  const MONTHS = { JAN: 1, FEB: 2, MAR: 3, APR: 4, MAY: 5, JUN: 6, JUL: 7, AUG: 8, SEP: 9, SEPT: 9, OCT: 10, NOV: 11, DEC: 12 };
  const DAY_RE = '(?:SUN|MON|TUE|WED|THU|THUR|FRI|SAT)';
  const MON_RE = '(?:JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEPT|SEP|OCT|NOV|DEC)';
  const HOL_SRC = '[,;]?\\s*(?:EXC|CLSD)\\s+(?:ALL\\s+)?(?:FED\\s+|GOV\\s+)?HOLS?\\b';

  function daySet(spec) {
    if (!spec) return null; // every day
    const s = spec.trim().replace(/THUR\b/g, 'THU');
    if (/^(?:WKENDS?|SAT (?:&|AND) SUN)$/.test(s)) return [6, 0];
    const m = s.match(/^(SUN|MON|TUE|WED|THU|FRI|SAT)(?: ?- ?(SUN|MON|TUE|WED|THU|FRI|SAT))?$/);
    if (!m) return undefined; // not understood
    const a = DAYS[m[1]], b = m[2] ? DAYS[m[2]] : a;
    const out = [];
    for (let d = a; ; d = (d + 1) % 7) { out.push(d); if (d === b) break; }
    return out;
  }
  const hhmm = (s) => Number(s.slice(0, 2)) * 60 + Number(s.slice(2));
  const LAST = [0, 31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  // "1 APR-30 SEP", "OCT-MAR", "MAY 15-AUG 15", "15 MAY- 31 OCT" → { from: month*100+day, to: month*100+day }
  function season(m) {
    const fm = MONTHS[m[2]], tm = MONTHS[m[5]];
    const fd = Number(m[1] || m[3] || 1), td = Number(m[4] || m[6] || LAST[tm]);
    return { from: fm * 100 + fd, to: tm * 100 + td };
  }
  const SEASON_SRC = `\\(?(?:(\\d{1,2}) )?(${MON_RE})(?: (\\d{1,2}))? ?- ?(?:(\\d{1,2}) )?(${MON_RE})(?: (\\d{1,2}))?\\)?`;

  // One "time window" piece: hours, optional days, optional season, in any order.
  function segment(part) {
    let rest = ` ${part} `;
    const t = rest.match(/ (\d{4})Z?-(\d{4})(?:(Z)(\+\+)?)? /); // "++" only counts after a Z
    if (!t) return null;
    rest = rest.replace(t[0], ' ');
    let ssn = null;
    const sm = rest.match(new RegExp(` ${SEASON_SRC} `));
    if (sm) { ssn = season(sm); rest = rest.replace(sm[0], ' '); }
    rest = rest.replace(/\bDAILY\b/, ' ').replace(/\s+/g, ' ').trim();
    const days = daySet(rest || null);
    if (days === undefined) return null;
    const to = t[2] === '2400' ? 1440 : hhmm(t[2]) % 1440;
    return { from: hhmm(t[1]), to, utc: Boolean(t[3]), dst: Boolean(t[4]), days, season: ssn };
  }

  // → { kind: 'continuous'|'schedule'|'unparsed', cls, other, segments, holidays, text }
  function parse(text) {
    const raw = String(text || '').trim();
    let t = raw.toUpperCase().replace(/\s+/g, ' ').replace(/[.\s]+$/, '')
      .replace(/\b(?:OTR|OT) TIMES?\b/g, 'OTHER TIMES').replace(/\bOTHER TIME\b/g, 'OTHER TIMES').replace(/\bOT CLASS\b/g, 'OTHER TIMES CLASS');
    const base = { text: raw, cls: null, other: null, segments: [], holidays: false };
    if (!t) return { ...base, kind: 'unparsed' };
    let m = t.match(/^CLASS ([BCDE]) (?:SVC )?(?:CONTINUOUS|24|24 HRS|H24)$/);
    if (m) return { ...base, kind: 'continuous', cls: m[1] };
    m = t.match(/^CLASS ([BCDE]) (?:SVC )?(.*?)[;,.]? ?OTHER TIMES CLASS ([BCDEG])$/);
    if (!m) { const c = t.match(/^CLASS ([BCDE])/); return { ...base, kind: 'unparsed', cls: c ? c[1] : null }; }
    const cls = m[1], other = m[3];
    let body = m[2];
    const holidays = new RegExp(HOL_SRC).test(body);
    body = body.replace(new RegExp(HOL_SRC, 'g'), '').trim().replace(/[;,]$/, '');
    if (/^(?:CONTINUOUS|24|24 HRS|H24)$/.test(body)) return { ...base, kind: 'continuous', cls, other, holidays };
    // "0700-2200 MON-FRI 0700-1900 SAT-SUN": add the missing separator before a second time range.
    body = body.replace(new RegExp(`(\\d{4}Z?(?:\\+\\+)? ${DAY_RE}(?: ?- ?${DAY_RE})?) (\\d{4}Z?-\\d{4})`, 'g'), '$1, $2');
    // "MON-FRI 0800-2300, SAT-SUN 0900-1800": days written first are fine (segment() takes any order).
    const segments = [];
    for (const part of body.split(/\s*[;,]\s*/)) {
      const seg = segment(part);
      if (!seg) return { ...base, kind: 'unparsed', cls, other, holidays };
      segments.push(seg);
    }
    return { ...base, kind: 'schedule', cls, other, segments, holidays };
  }

  // Wall-clock parts of `ms` in an IANA time zone.
  const fmts = new Map();
  function parts(ms, tz) {
    let f = fmts.get(tz);
    if (!f) { f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour12: false, weekday: 'short', hour: '2-digit', minute: '2-digit', year: 'numeric', month: '2-digit', day: '2-digit' }); fmts.set(tz, f); }
    const o = {}; for (const p of f.formatToParts(new Date(ms))) o[p.type] = p.value;
    const wd = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[o.weekday];
    return { wd, min: (Number(o.hour) % 24) * 60 + Number(o.minute), y: Number(o.year), mo: Number(o.month), d: Number(o.day) };
  }
  // UTC offset in minutes at `ms` (e.g. -360 for CST).
  function offsetMin(ms, tz) {
    const p = parts(ms, tz);
    const asUtc = Date.UTC(p.y, p.mo - 1, p.d, Math.floor(p.min / 60), p.min % 60);
    return Math.round((asUtc - Math.floor(ms / 60000) * 60000) / 60000);
  }
  function isDst(ms, tz) {
    const y = new Date(ms).getUTCFullYear();
    const jan = offsetMin(Date.UTC(y, 0, 15), tz), jul = offsetMin(Date.UTC(y, 6, 15), tz);
    return jan !== jul && offsetMin(ms, tz) === Math.max(jan, jul);
  }

  // Is the window open at `ms`? `days` belong to the day the window starts (an overnight window runs into the next day).
  function segOpen(seg, ms, tz) {
    let wd, min;
    if (seg.utc) {
      const d = new Date(ms + (seg.dst && tz && isDst(ms, tz) ? 60 * 60000 : 0)); // ‡: hours are one hour earlier in DST
      wd = d.getUTCDay(); min = d.getUTCHours() * 60 + d.getUTCMinutes();
    } else {
      const p = parts(ms, tz); wd = p.wd; min = p.min;
    }
    if (seg.season) {
      const p = tz ? parts(ms, tz) : (() => { const d = new Date(ms); return { mo: d.getUTCMonth() + 1, d: d.getUTCDate() }; })();
      const md = p.mo * 100 + p.d, { from, to } = seg.season;
      if (!(from <= to ? md >= from && md <= to : md >= from || md <= to)) return false;
    }
    const on = (day) => !seg.days || seg.days.includes(day);
    if (seg.from === seg.to) return on(wd);
    if (seg.from < seg.to) return on(wd) && min >= seg.from && min < seg.to;
    return (on(wd) && min >= seg.from) || (on((wd + 6) % 7) && min < seg.to);
  }

  // → { cls, inEffect: true|false|null, why }  cls = the class at the surface at `ms` (the part-time class when unknown).
  function classAt(p, ms, tz) {
    if (!p || p.kind === 'unparsed') return { cls: p && p.cls, inEffect: null, why: 'hours not understood' };
    if (p.kind === 'continuous') return { cls: p.cls, inEffect: true, why: 'continuous' };
    const needsTz = p.segments.some((s) => !s.utc || s.dst || s.season);
    if (needsTz && !tz) return { cls: p.cls, inEffect: null, why: 'airport time zone unknown' };
    const open = p.segments.some((s) => segOpen(s, ms, tz));
    return { cls: open ? p.cls : p.other, inEffect: open, why: open ? 'within published hours' : 'outside published hours' };
  }

  // "0530–2300 local", "1130–0500Z‡ MON-FRI" — for hovers.
  function describe(p) {
    if (!p) return '';
    if (p.kind === 'continuous') return `Class ${p.cls} continuous`;
    if (p.kind === 'unparsed') return p.text;
    const t = (m) => String(Math.floor(m / 60) % 24).padStart(2, '0') + String(m % 60).padStart(2, '0');
    const dn = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];
    const mn = ['', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const md = (v) => `${Math.floor(v % 100)} ${mn[Math.floor(v / 100)]}`;
    const seg = p.segments.map((s) => `${t(s.from)}–${s.to === 1440 ? '2400' : t(s.to)}${s.utc ? 'Z' : ' local'}${s.dst ? '‡' : ''}${s.days ? ' ' + (s.days.length === 1 ? dn[s.days[0]] : `${dn[s.days[0]]}–${dn[s.days[s.days.length - 1]]}`) : ''}${s.season ? ` (${md(s.season.from)}–${md(s.season.to)})` : ''}`);
    return `Class ${p.cls} ${seg.join(', ')}; other times Class ${p.other}${p.holidays ? ' (holiday closures not checked)' : ''}`;
  }

  const api = { parse, classAt, describe, isDst, offsetMin };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.AirspaceHours = api;
})(typeof window !== 'undefined' ? window : globalThis);
