// Regulation watch: is every regulation wxboard's minimums are built on still the version they were checked against?
//
// For each cited section, once a day, eCFR (the official, continuously updated online CFR) is asked for:
//   1. the date of the section's latest amendment (versioner API "versions"); later than `basedOn` → "amended",
//      and a section whose latest version is marked removed → "removed";
//   2. the current text (versioner API "full"); every phrase in `phrases` must still be there → otherwise "text changed".
// Any of those turns on a red chip in the page's alert strip and a line in the server log. A check that can't reach
// eCFR leaves the last answer in place; after 7 days without a successful check the page says so.
//
// When a regulation really changes: read it, update the code that uses it, then update `basedOn` / `phrases` here.
const { rawFetch } = require('./http');

const ECFR = 'https://www.ecfr.gov/api/versioner/v1';
const DAY = 24 * 3600e3;

// basedOn = eCFR's latest_amendment_date for the section when wxboard's code was checked against its text (2026-11-21).
const CITED = [
  { part: '1', section: '1.1', basedOn: null, // § 1.1 is amended often for other definitions, so only the text is watched
    uses: 'Night: end of evening to start of morning civil twilight (day/night columns)',
    phrases: ['Night means the time between the end of evening civil twilight and the beginning of morning civil twilight'] },
  { part: '91', section: '91.155', basedOn: '2016-12-30',
    uses: 'Part 91: Class G visibility; 1,000 ft ceiling and 3 SM in Class B/C/D/E surface areas',
    phrases: ['when the ceiling is less than 1,000 feet', 'ground visibility at that airport is at least 3 statute miles', 'Class G'] },
  { part: '91', section: '91.157', basedOn: '2022-12-09',
    uses: 'Special VFR notes',
    phrases: ['Except for helicopters, when flight visibility is at least 1 statute mile'] },
  { part: '135', section: '135.609', basedOn: '2017-01-01',
    uses: 'Part 135 HAA ceiling/visibility table (the table itself is an image in the CFR; checked by eye 2026-11-21)',
    phrases: ['when conducting VFR helicopter air ambulance operations in Class G airspace', 'er21fe14.021'] },
  { part: '95', section: '95.11', basedOn: '2016-12-30', uses: 'Designated mountainous areas (general)', phrases: ['are designated mountainous areas'] },
  { part: '95', section: '95.13', basedOn: '2016-12-30', uses: 'Eastern US Mountainous Area boundary', phrases: ['latitude 47°10′ N., longitude 67°55′ W.', 'latitude 32°30′ N., longitude 86°25′ W.'] },
  { part: '95', section: '95.15', basedOn: '2016-12-30', uses: 'Western US Mountainous Area boundary', phrases: ['latitude 49°00′ N., longitude 108°00′ W.', 'latitude 29°48′ N., longitude 102°00′ W.'] },
  { part: '95', section: '95.17', basedOn: '2016-12-30', uses: 'Alaska Mountainous Area and its exceptions', phrases: ['The State of Alaska', 'Fairbanks'] },
  { part: '95', section: '95.19', basedOn: '2016-12-30', uses: 'Hawaii Mountainous Area', phrases: ['Kauai, Oahu, Molokai, Lanai, Kehoolawe, Maui, and Hawaii'] },
  { part: '95', section: '95.21', basedOn: '2016-12-30', uses: 'Puerto Rico Mountainous Area', phrases: ['latitude 18°22′ N., longitude 66°58′ W.'] },
];
const VERIFIED = '2026-11-21';

let state = { checkedAt: null, lastOkAt: null, error: null, items: CITED.map((c) => ({ section: c.section, status: 'unchecked' })) };
const norm = (t) => String(t).replace(/<img[^>]*src="[^"]*\/([^"/.]+\.[0-9]+)\.gif"[^>]*>/gi, ' $1 ').replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ');

async function checkOne(c) {
  const q = `part=${encodeURIComponent(c.part)}&section=${encodeURIComponent(c.section)}`;
  const v = await rawFetch(`${ECFR}/versions/title-14.json?${q}`, { timeoutMs: 20000 });
  const meta = (v && v.meta) || {};
  const versions = (v && v.content_versions) || [];
  const latest = meta.latest_amendment_date || null;
  if (!versions.length && !latest) return { status: 'removed', latest, note: 'eCFR has no versions for this section' };
  const last = versions[versions.length - 1];
  if (last && last.removed) return { status: 'removed', latest };
  const amended = Boolean(c.basedOn && latest && latest > c.basedOn);
  const date = meta.latest_issue_date || latest;
  const text = norm(await rawFetch(`${ECFR}/full/${date}/title-14.xml?${q}`, { text: true, timeoutMs: 30000 }));
  const missing = c.phrases.filter((p) => !text.includes(p));
  if (amended) return { status: 'amended', latest, missing };
  if (missing.length) return { status: 'text-changed', latest, missing };
  return { status: 'current', latest };
}

async function checkAll() {
  const items = [];
  let anyOk = false, firstErr = null;
  for (const c of CITED) { // one at a time: ten small requests a day
    try {
      const r = await checkOne(c);
      anyOk = true;
      items.push({ section: c.section, basedOn: c.basedOn, uses: c.uses, ...r });
    } catch (e) {
      firstErr = firstErr || e.message;
      const prev = state.items.find((x) => x.section === c.section);
      items.push({ ...(prev && prev.status !== 'unchecked' ? prev : { section: c.section, basedOn: c.basedOn, uses: c.uses, status: 'unknown' }), error: e.message });
    }
  }
  const before = new Map(state.items.map((x) => [x.section, x.status]));
  state = { checkedAt: new Date().toISOString(), lastOkAt: anyOk ? new Date().toISOString() : state.lastOkAt, error: firstErr, items };
  for (const it of items) {
    if (['amended', 'removed', 'text-changed'].includes(it.status) && before.get(it.section) !== it.status) {
      console.error(`  REGULATION CHANGED: 14 CFR ${it.section} is ${it.status}${it.latest ? ` (latest amendment ${it.latest})` : ''}${it.missing && it.missing.length ? `; text no longer contains: "${it.missing.join('", "')}"` : ''}. wxboard's minimums were checked against the version of ${VERIFIED}. Update the code, then lib/regs.js.`);
    }
  }
  if (firstErr && !anyOk) console.error(`  Regulation check: couldn't reach eCFR (${firstErr}). Keeping the last answer.`);
  return state;
}

// What the page gets (no network): per-section status, plus whether checks have been failing for a week.
function status() {
  const bad = state.items.filter((x) => ['amended', 'removed', 'text-changed'].includes(x.status));
  const lastOk = state.lastOkAt ? Date.parse(state.lastOkAt) : null;
  return {
    verified: VERIFIED, checkedAt: state.checkedAt, lastOkAt: state.lastOkAt,
    overdue: state.checkedAt != null && (lastOk == null || Date.now() - lastOk > 7 * DAY),
    changed: bad.map((x) => ({ section: x.section, status: x.status, latest: x.latest || null, uses: x.uses, missing: x.missing || [] })),
    items: state.items.map((x) => ({ section: x.section, status: x.status, latest: x.latest || null, basedOn: x.basedOn ?? null, uses: x.uses })),
  };
}

let timer = null;
function start() {
  if (timer) return;
  setTimeout(() => checkAll().catch(() => {}), 20e3).unref();       // shortly after start
  timer = setInterval(() => checkAll().catch(() => {}), DAY); timer.unref();
}

module.exports = { CITED, VERIFIED, checkAll, checkOne, status, start, _setState: (s) => { state = s; } };
