// wxboard front end. Talks only to the local server at /api/*.
(() => {
  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const REFRESH_MS = 5 * 60 * 1000;
  const STORE_KEY = 'wxboard.savedAreas';
  const DEFAULT_SAVED = []; // no built-in quick picks; each user saves their own

  let current = null;     // { ids, radius, route }
  let lastBrief = null;
  let refreshTimer = null;
  let map = null, mapLayers = null, mapBounds = null;
  let windsHr = 0;
  let windsMax = (() => { try { return Number(localStorage.getItem('wxboard.windsMax')) || 12000; } catch { return 12000; } })();
  let notamScope = 'airport', notamFilter = '';
  let notamWindow = (() => { try { const v = localStorage.getItem('wxboard.notamWindow'); return v === 'now' || v === 'all' ? v : Number(v) || 6; } catch { return 6; } })();
  let status = { demo: false, notamsConfigured: false };

  // ---------- storage (best effort) ----------
  function loadSaved() {
    try { const v = JSON.parse(localStorage.getItem(STORE_KEY)); return Array.isArray(v) ? v : DEFAULT_SAVED; }
    catch { return DEFAULT_SAVED; }
  }
  function storeSaved(list) { try { localStorage.setItem(STORE_KEY, JSON.stringify(list)); } catch {} }

  // ---------- formatting ----------
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  function zt(ms) { if (!ms) return '—'; const d = new Date(ms); return `${pad(d.getUTCDate())}/${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}Z`; }
  function lt(ms) { if (!ms) return ''; return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false }); }
  function ltDay(ms) { if (!ms) return ''; return new Date(ms).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false }); }
  function ago(ms) {
    if (!ms) return '';
    const m = Math.round((Date.now() - ms) / 60000);
    if (m < 1) return 'just now';
    if (m < 60) return `${m}m ago`;
    const h = Math.floor(m / 60); return `${h}h ${m % 60}m ago`;
  }
  function until(ms) {
    const m = Math.round((ms - Date.now()) / 60000);
    if (m <= 0) return 'now';
    if (m < 60) return `in ${m}m`;
    const h = Math.floor(m / 60);
    if (h < 48) return `in ${h}h ${m % 60}m`;
    return `in ${Math.round(h / 24)}d`;
  }
  function wind(wdir, wspd, wgst) {
    if (wspd === null || wspd === undefined) return '—';
    if (Number(wspd) === 0 && (wdir === 0 || wdir === '0' || wdir === null)) return 'Calm';
    const d = wdir === 'VRB' ? 'VRB' : pad(wdir ?? 0, 3) + '°';
    return `${d}@${wspd}${wgst ? 'G' + wgst : ''}kt`;
  }
  function vis(v) { if (v === null || v === undefined || v === '') return '—'; return `${v} SM`; }
  function clouds(list, vv) {
    const parts = (list || []).map((c) => c.cover === 'CLR' || c.cover === 'SKC' || c.cover === 'NCD' || c.cover === 'CAVOK'
      ? c.cover : `${c.cover}${c.base != null ? pad(Math.round(c.base / 100), 3) : ''}${c.type || ''}`);
    if (vv != null) parts.unshift(`VV${pad(vv < 100 ? vv : Math.round(vv / 100), 3)}`);
    return parts.join(' ') || '—';
  }
  function ceil(ft) { return ft == null ? 'None' : `${ft.toLocaleString()} ft`; }
  const inHg = (hpa) => (hpa ? (hpa * 0.0295300).toFixed(2) : '—');
  const cat = (c) => `<span class="cat ${c || 'NA'}">${c || 'N/A'}</span>`;

  // ---------- clock ----------
  setInterval(() => { const d = new Date(); $('#zulu').textContent = `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}Z`; }, 1000);

  // ---------- saved areas ----------
  function renderSaved() {
    const list = loadSaved();
    $('#saved').innerHTML = list.map((a, i) =>
      `<span class="chip" data-i="${i}" title="${esc(a.ids)} · ${a.radius} nm${a.route ? ' · route' : ''}">${esc(a.label)}<button class="x" data-del="${i}" title="Remove">×</button></span>`).join('');
  }
  $('#saved').addEventListener('click', (e) => {
    const del = e.target.closest('[data-del]');
    const list = loadSaved();
    if (del) { list.splice(Number(del.dataset.del), 1); storeSaved(list); renderSaved(); e.stopPropagation(); return; }
    const chip = e.target.closest('.chip');
    if (chip) { const a = list[Number(chip.dataset.i)]; setForm(a); run(a); }
  });
  $('#saveArea').addEventListener('click', () => {
    const a = readForm();
    if (!a.ids) return;
    const label = prompt('Name for this area', `${a.ids} ${a.radius}nm${a.route ? ' route' : ''}`);
    if (!label) return;
    const list = loadSaved(); list.push({ ...a, label }); storeSaved(list); renderSaved();
  });

  // ---------- form ----------
  function readForm() {
    return { ids: $('#ids').value.trim().toUpperCase(), radius: Number($('#radius').value) || 30, route: $('#route').checked };
  }
  function setForm(a) { $('#ids').value = a.ids; $('#radius').value = a.radius; $('#route').checked = !!a.route; }
  $('#areaForm').addEventListener('submit', (e) => { e.preventDefault(); const a = readForm(); if (a.ids) run(a); });

  // ---------- big centered loading indicator ----------
  let loaderTimer = null;
  function showLoader(area) {
    let el = document.getElementById('loader');
    if (!el) {
      el = document.createElement('div');
      el.id = 'loader';
      el.innerHTML = '<div class="loader-box"><div class="loader-ring"></div><div class="loader-title">Building brief</div><div class="loader-sub"></div></div>';
      document.body.appendChild(el);
    }
    el.querySelector('.loader-sub').textContent = `${area.ids} · ${area.radius} nm${area.route ? ' route' : ''}`;
    // Only show it if loading takes more than a moment, so fast loads don't flash.
    clearTimeout(loaderTimer);
    loaderTimer = setTimeout(() => el.classList.add('on'), 150);
  }
  function hideLoader() {
    clearTimeout(loaderTimer);
    const el = document.getElementById('loader');
    if (el) el.classList.remove('on');
  }

  // ---------- data ----------
  let runSeq = 0;
  let runCtrl = null;
  async function run(area, quiet = false) {
    // Only the newest request may render; an older refresh still in flight is cancelled.
    const seq = ++runSeq;
    if (runCtrl) runCtrl.abort();
    const ctrl = runCtrl = new AbortController();
    current = area;
    const qs = new URLSearchParams({ ids: area.ids, radius: area.radius, route: area.route ? '1' : '0' });
    history.replaceState(null, '', '?' + qs);
    if (!quiet) { $('#updated').innerHTML = '<span class="spin"></span> loading'; showLoader(area); }
    else $('#updated').innerHTML = '<span class="spin"></span> refreshing';
    try {
      const res = await fetch('/api/brief?' + qs, { signal: ctrl.signal });
      const body = await res.json();
      if (seq !== runSeq) return; // a newer brief was requested meanwhile
      if (!res.ok) throw new Error(body.error || res.statusText);
      lastBrief = body;
      decorateNotams(body);
      render(body);
      $('#updated').textContent = `Updated ${lt(Date.parse(body.generatedAt))} local`;
    } catch (e) {
      if (seq !== runSeq) return; // superseded (including our own abort)
      showBanner(`Couldn't load: ${esc(e.message)}`, true);
      $('#updated').textContent = 'load failed';
    } finally {
      if (seq === runSeq) { hideLoader(); runCtrl = null; }
    }
    if (seq !== runSeq) return;
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => { if (!document.hidden) run(current, true); }, REFRESH_MS);
  }
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && current && lastBrief && Date.now() - Date.parse(lastBrief.generatedAt) > REFRESH_MS) run(current, true);
  });

  function showBanner(msg, isErr) {
    const b = $('#banner');
    b.className = 'banner' + (isErr ? ' err' : '');
    b.innerHTML = msg; b.hidden = false;
  }
  function baseBanner() {
    if (status.demo) showBanner('<b>DEMO MODE:</b> sample data for testing the layout. None of this is real weather. Start without <code>--demo</code> for live data.');
    else if (status.notamsConfigured && status.nmsEnv && status.nmsEnv !== 'prod')
      showBanner(`<b>NOTAMs are from the FAA ${esc(status.nmsEnv.toUpperCase())} (test) system.</b> They are test data, not real or current NOTAMs. Do not use them for flight. Check <a href="https://notams.aim.faa.gov/notamSearch/" target="_blank" rel="noopener">FAA NOTAM Search</a> until production access is set up.`, true);
    else $('#banner').hidden = true;
  }

  // ---------- layout (collapse + drag to reorder, saved per browser) ----------
  const LAYOUT_KEY = 'wxboard.layout.v1';
  const DEFAULT_LAYOUT = {
    cols: [['outlook', 'map', 'trend', 'airports', 'winds', 'stations'], ['notams', 'advisories', 'pireps', 'tfrs', 'forecast']],
    collapsed: [],
  };
  function loadLayout() {
    try {
      const v = JSON.parse(localStorage.getItem(LAYOUT_KEY));
      if (v && Array.isArray(v.cols) && v.cols.length === 2) return { cols: v.cols, collapsed: v.collapsed || [] };
    } catch {}
    return JSON.parse(JSON.stringify(DEFAULT_LAYOUT));
  }
  function saveLayout() { try { localStorage.setItem(LAYOUT_KEY, JSON.stringify(layout)); } catch {} }
  let layout = loadLayout();
  const isCollapsed = (id) => layout.collapsed.includes(id);

  // ---------- minimums (14 CFR 135.609 table + risk bands) ----------
  const MN = window.Minimums, SUN = window.Sun;
  const MINS_KEY = 'wxboard.mins.v1';
  let mins = (() => {
    try { const v = JSON.parse(localStorage.getItem(MINS_KEY)); if (v) return { ...MN.DEFAULTS, ...v, bands: { ...MN.DEFAULTS.bands, ...(v.bands || {}) } }; } catch {}
    return JSON.parse(JSON.stringify(MN.DEFAULTS));
  })();
  const saveMins = () => { try { localStorage.setItem(MINS_KEY, JSON.stringify(mins)); } catch {} };
  const phaseAt = (ms, lat, lon) => (lat == null || !SUN ? 'day' : SUN.isNight(ms, lat, lon) ? 'night' : 'day');
  // Risk for a ceiling/visibility at a time and place. Returns null when minimums are turned off.
  function riskAt(ceilFt, visSM, ms, lat, lon) {
    if (!mins.enabled || !MN) return null;
    const phase = phaseAt(ms, lat, lon);
    const lim = MN.limitsFor(phase, mins);
    return { ...MN.assess(ceilFt, visSM, lim, mins.bands), phase, lim };
  }
  // A TAF period can span day and night: judge it against every phase it touches and keep the worst.
  function riskForPeriod(ceilFt, visSM, from, to, lat, lon) {
    if (!mins.enabled || !MN) return null;
    const phases = new Set([from, (from + to) / 2, to - 60e3].map((t) => phaseAt(t, lat, lon)));
    const rs = [...phases].map((ph) => ({ ...MN.assess(ceilFt, visSM, MN.limitsFor(ph, mins), mins.bands), phase: ph, lim: MN.limitsFor(ph, mins) }));
    return rs.reduce((w, r) => (MN.LEVELS.indexOf(r.level) > MN.LEVELS.indexOf(w.level) ? r : w), rs[0]);
  }
  function riskBadge(r) {
    if (!r) return '';
    const tip = `${r.lim.label}: ${r.lim.ceil} ft / ${r.lim.vis} SM${r.reasons.length ? ' — ' + r.reasons.join('; ') : ''}${r.partial ? ' (visibility unknown)' : ''}`;
    return `<span class="risk risk-${r.level}" ${popAttr(tip)}>${r.label}${r.partial ? '*' : ''}</span>`;
  }
  // Next sun events (sunrise/sunset/civil twilight) in the next 24 h, local time.
  function sunLine(lat, lon) {
    if (!SUN || lat == null) return '';
    const t = Date.now();
    const ev = SUN.events(t, t + 24 * 3600e3, lat, lon).slice(0, 2);
    const names = { sunrise: 'sunrise', sunset: 'sunset', dawn: 'night ends', dusk: 'night begins' };
    return ev.map((e) => `${names[e.type]} ${lt(e.at)}`).join(' · ');
  }

  function openMinsDialog() {
    let d = document.getElementById('minsDlg');
    if (!d) { d = document.createElement('div'); d.id = 'minsDlg'; document.body.appendChild(d); }
    const r = (name, val, label) => `<label class="chk"><input type="radio" name="${name}" value="${val}" ${mins[name] === val ? 'checked' : ''}> ${label}</label>`;
    const n = (k, label, step) => `<label class="fld"><span>${label}</span><input type="number" step="${step}" min="0" data-band="${k}" value="${mins.bands[k]}"></label>`;
    const T = MN.HAA_135_609;
    const row = (k, title) => `<tr><td>${title}</td>${['day', 'night', 'nvg'].map((c) => `<td class="mono">${T[k][c][0].toLocaleString()}-${T[k][c][1]}</td>`).join('')}</tr>`;
    d.innerHTML = `<div class="dlg"><h3>Weather minimums</h3>
      <label class="chk"><input type="checkbox" id="mEnabled" ${mins.enabled ? 'checked' : ''}> Check conditions against minimums</label>
      <div class="dlg-grid">
        <div><div class="lbl">Terrain (14 CFR 95)</div>${r('terrain', 'non', 'Non-mountainous')}${r('terrain', 'mtn', 'Mountainous')}</div>
        <div><div class="lbl">Flying area</div>${r('area', 'xc', 'Cross-country (non-local)')}${r('area', 'local', 'Local flying area')}</div>
        <div><div class="lbl">At night</div>${r('nightMode', 'nvg', 'NVG (aided)')}${r('nightMode', 'unaided', 'Unaided')}</div>
      </div>
      <div class="lbl">Risk bands (margin above the limit)</div>
      <div class="dlg-grid">${n('amberCeil', 'Amber if ceiling within (ft)', 50)}${n('amberVis', 'Amber if visibility within (SM)', 0.5)}${n('critCeil', 'Amber Critical if ceiling within (ft)', 50)}${n('critVis', 'Amber Critical if visibility within (SM)', 0.5)}</div>
      <details><summary class="small">14 CFR 135.609(a) table (ceiling ft – visibility SM)</summary>
        <table class="small"><thead><tr><th></th><th>Day</th><th>Night</th><th>Night NVIS/HTAWS</th></tr></thead><tbody>
        ${row('non-local', 'Non-mountainous local')}${row('non-xc', 'Non-mountainous non-local')}${row('mtn-local', 'Mountainous local')}${row('mtn-xc', 'Mountainous non-local')}</tbody></table></details>
      <p class="muted small">Night = end of evening civil twilight to start of morning civil twilight (14 CFR 1.1), worked out per airport. Defaults: non-local rows, NVG at night, Amber within 700 ft / 3 SM and Amber Critical within 200 ft / 2 SM of a limit. Set these to match your operator's procedures. A reading aid, not a flight release.</p>
      <div style="display:flex;gap:8px;justify-content:flex-end"><button class="btn" id="mReset">Reset to defaults</button><button class="btn primary" id="mClose">Done</button></div></div>`;
    d.classList.add('on');
    const apply = () => { saveMins(); if (lastBrief) render(lastBrief); };
    d.querySelector('#mEnabled').onchange = (e) => { mins.enabled = e.target.checked; apply(); };
    d.querySelectorAll('input[type=radio]').forEach((i) => (i.onchange = () => { mins[i.name] = i.value; apply(); }));
    d.querySelectorAll('input[data-band]').forEach((i) => (i.onchange = () => { const v = Number(i.value); if (Number.isFinite(v) && v >= 0) { mins.bands[i.dataset.band] = v; apply(); } }));
    d.querySelector('#mReset').onclick = () => { mins = JSON.parse(JSON.stringify(MN.DEFAULTS)); apply(); openMinsDialog(); };
    d.querySelector('#mClose').onclick = () => d.classList.remove('on');
    d.onclick = (e) => { if (e.target === d) d.classList.remove('on'); };
  }
  $('#minsBtn').addEventListener('click', openMinsDialog);

  // ---------- METAR trend ----------
  function trendArrow(a, b, unit, higherIsBetter = true) {
    if (a == null && b == null) return '';
    const A = a == null ? Infinity : a, B = b == null ? Infinity : b;
    if (A === B) return '→';
    return (B > A) === higherIsBetter ? '<span class="up">▲</span>' : '<span class="down">▼</span>';
  }
  function renderTrend(b) {
    if (!b.trend) return panel('trend', 'METAR trend (6 hr)', null, '<div class="none">Restart the server to load METAR history</div>');
    if (!b.trend.ok) return panel('trend', 'METAR trend (6 hr)', null, failed(b.trend));
    const rows = b.area.anchors.map((a) => {
      const list = b.trend.data[a.id] || [];
      if (!list.length) return `<div class="tr-row"><div class="tr-id mono"><b>${esc(a.id)}</b></div><div class="muted small">No observations in the last 6 hours</div></div>`;
      const first = list[0], last = list[list.length - 1];
      const cs = (c) => (c == null ? 'none' : c.toLocaleString());
      const summary = `Ceiling ${cs(first.ceilingFt)} → ${cs(last.ceilingFt)} ${trendArrow(first.ceilingFt, last.ceilingFt)} · Vis ${first.visSM ?? '?'} → ${last.visSM ?? '?'} SM ${trendArrow(first.visSM, last.visSM)} · Wind ${wind(last.wdir, last.wspd, last.wgst)}`;
      const tiles = list.map((m) => {
        const r = riskAt(m.ceilingFt, m.visSM, m.obsTime, a.lat, a.lon);
        const cls = r ? `risk-bg-${r.level}` : `cat-bg-${m.fltCat || 'NA'}`;
        return `<div class="tr-tile ${cls}" title="${esc(m.raw)}">
          <div class="mono small">${lt(m.obsTime)}</div>
          <div class="mono">${m.ceilingFt == null ? '—' : Math.round(m.ceilingFt / 100).toString().padStart(3, '0')}</div>
          <div class="mono small">${m.visSM ?? '?'}SM${m.wx ? ' ' + esc(m.wx) : ''}</div>
        </div>`;
      }).join('');
      return `<div class="tr-row"><div class="tr-id"><b class="mono">${esc(a.id)}</b><div class="muted small">${summary}</div></div><div class="tr-tiles">${tiles}</div></div>`;
    }).join('');
    const legend = mins.enabled ? 'Colored by your minimums (Green / Amber / Amber Crit / Red).' : 'Colored by flight category.';
    return panel('trend', 'METAR trend (6 hr)', null, `<div class="muted small" style="padding:8px 14px 0">${legend} Each tile: local time, ceiling (hundreds of ft), visibility. Hover for the raw METAR.</div>${rows}`);
  }

  // Small "i" button with a popover. Hover shows it on desktop; tap/click pins it (touch screens).
  // The popover is one shared element on <body>, so tables, scroll areas and sticky columns can't clip or cover it.
  function infoTip(html) {
    return `<span class="info" tabindex="0" role="button" aria-label="More info" data-info="${encodeURIComponent(html)}">i</span>`;
  }
  const infoPop = document.createElement('div');
  infoPop.id = 'infoPop'; infoPop.setAttribute('role', 'tooltip');
  document.body.appendChild(infoPop);
  let infoPinned = null, infoHideTimer = null;
  function showInfo(i) {
    clearTimeout(infoHideTimer);
    infoPop.innerHTML = decodeURIComponent(i.dataset.info || '');
    infoPop.classList.add('on');
    const r = i.getBoundingClientRect();
    const w = Math.min(340, innerWidth * 0.8);
    let left = r.right + 8; if (left + w > innerWidth - 8) left = Math.max(8, r.left - w - 8);
    infoPop.style.left = left + 'px';
    infoPop.style.top = Math.max(8, Math.min(r.top - 8, innerHeight - infoPop.offsetHeight - 8)) + 'px';
  }
  const hideInfo = () => { if (!infoPinned) infoHideTimer = setTimeout(() => infoPop.classList.remove('on'), 150); };
  const POP_SEL = '.info, [data-info]';
  document.addEventListener('mouseover', (e) => { const i = e.target.closest(POP_SEL); if (i) showInfo(i); else if (e.target.closest('#infoPop')) clearTimeout(infoHideTimer); });
  document.addEventListener('mouseout', (e) => { if (e.target.closest(POP_SEL) || e.target.closest('#infoPop')) hideInfo(); });
  document.addEventListener('focusin', (e) => { const i = e.target.closest(POP_SEL); if (i) showInfo(i); });
  document.addEventListener('focusout', (e) => { if (e.target.closest(POP_SEL)) hideInfo(); });
  document.addEventListener('click', (e) => {
    const i = e.target.closest(POP_SEL);
    if (i) { infoPinned = infoPinned === i ? null : i; if (infoPinned) showInfo(i); else infoPop.classList.remove('on'); e.stopPropagation(); return; }
    if (!e.target.closest('#infoPop')) { infoPinned = null; infoPop.classList.remove('on'); }
  });
  addEventListener('scroll', () => { if (infoPinned) showInfo(infoPinned); else infoPop.classList.remove('on'); }, { passive: true });
  const LAMP_INFO = `<b>LAMP: Localized Aviation MOS Program</b><br>
    NOAA computer guidance that combines the latest observations (METARs, radar, lightning) with model output and statistically
    forecasts ceiling, visibility, wind and precipitation for individual airports, every hour.
    <br><br>It covers many smaller airports that have <b>no TAF</b>, which is why it's shown here.
    <br><br><b>How to read it:</b> values are category <i>ranges</i>. Top number = ceiling in hundreds of ft
    (e.g. <span class="mono">5-9</span> = 500–900 ft, <span class="mono">unl</span> = above 12,000 or none); bottom = visibility in SM
    (<span class="mono">3-5</span>, <span class="mono">6+</span> = more than 6). Both ends are checked against your minimums;
    a <b>striped</b> cell means the range straddles a limit.
    <br><br><b>Limits:</b> automated statistical guidance, not a forecaster-written TAF. Where a TAF exists, the TAF is the official forecast.
    <br><br><a href="https://vlab.noaa.gov/web/mdl/lamp" target="_blank" rel="noopener">NOAA LAMP page ↗</a>
    · <a href="https://vlab.noaa.gov/web/mdl/lamp-card-2.7.0" target="_blank" rel="noopener">Category definitions ↗</a>`;

  // ---------- Shift outlook: hour-by-hour timeline ----------
  const OUT_KEY = 'wxboard.outlook.v1';
  let outlook = (() => { try { return { start: 'now', hours: 12, alt: 3000, ...(JSON.parse(localStorage.getItem(OUT_KEY)) || {}) }; } catch { return { start: 'now', hours: 12, alt: 3000 }; } })();
  const saveOutlook = () => { try { localStorage.setItem(OUT_KEY, JSON.stringify(outlook)); } catch {} };
  const HR = 3600e3;
  const LAMP_CIG = { 1: '<2', 2: '2-4', 3: '5-9', 4: '10-19', 5: '20-30', 6: '31-65', 7: '66+', 8: 'unl' };
  const LAMP_VIS = { 1: '<½', 2: '½', 3: '1', 4: '2', 5: '3-5', 6: '6', 7: '6+' };
  const LVL = (l) => (MN ? MN.LEVELS.indexOf(l) : 0);

  function outlookStart() {
    const now = Date.now();
    if (outlook.start === 'now') { const d = new Date(now); d.setMinutes(0, 0, 0); return d.getTime(); }
    const d = new Date(now); d.setHours(Number(outlook.start), 0, 0, 0);
    let t = d.getTime();
    if (t > now + 12 * HR) t -= 24 * HR;             // e.g. 19:00 start seen at 06:00 → last night's shift
    if (t + outlook.hours * HR <= now) t += 24 * HR;   // shift already over → next one
    return t;
  }
  const overlaps = (a, b, t) => a < t + HR && (b == null || b > t);
  const hhL = (ms) => pad(new Date(ms).getHours()) + pad(new Date(ms).getMinutes());

  function tafAt(t, ms) {
    let prevailing = null; const cond = [];
    for (const p of t.periods) {
      if (!(p.from <= ms && p.to > ms)) continue;
      if (p.conditional) cond.push(p); else prevailing = p;
    }
    return { prevailing, cond };
  }
  function renderOutlook(b) {
    const start = outlookStart();
    const N = outlook.hours;
    const cols = Array.from({ length: N }, (_, i) => start + i * HR);
    const now = Date.now();
    const anchors = b.area.anchors;
    const tafBy = new Map((b.tafs.ok ? b.tafs.data : []).map((t) => [t.id, t]));
    const lampBy = b.lamp && b.lamp.ok ? b.lamp.data : {};
    const windBy = new Map(b.winds && b.winds.ok ? b.winds.data.points.map((p) => [p.id, p]) : []);
    const fcBy = new Map(b.forecast.ok ? b.forecast.data.map((f) => [f.id, f]) : []);
    const summary = [];
    const bodies = [{ cls: 'obody-top', rows: [] }];
    const rows = { push: (r) => bodies[bodies.length - 1].rows.push(r) };
    const colHead = (c) => `<th class="oh ${c <= now && now < c + HR ? 'onow' : ''}">${hhL(c).slice(0, 2)}<div class="muted">${pad(new Date(c).getUTCHours())}Z</div></th>`;
    const past = (c) => (c + HR <= now ? ' opast' : '');
    const row = (label, cells, cls = '') => rows.push(`<tr class="${cls}"><th class="olab">${label}</th>${cells.join('')}</tr>`);
    const group = (label, cls = 'obody-apt', foldKey = '') => {
      bodies.push({ cls, rows: [] });
      rows.push(`<tr class="ogrp"${foldKey ? ` data-ofold="${esc(foldKey)}"` : ''}><th colspan="${N + 1}">${label}</th></tr>`);
      return bodies[bodies.length - 1];
    };
    const aptFolded = (id) => Boolean(outlook.foldApts && outlook.foldApts[id]);

    // Day / night (first airport)
    const a0 = anchors[0];
    if (a0 && SUN) {
      row('Day / night', cols.map((c) => {
        const ph = phaseAt(c + HR / 2, a0.lat, a0.lon);
        const ev = SUN.events(c, c + HR, a0.lat, a0.lon).filter((e) => e.type === 'dusk' || e.type === 'dawn');
        return `<td class="ocell ${ph === 'night' ? 'onight' : 'oday'}${past(c)}" title="${ev.length ? (ev[0].type === 'dusk' ? 'Night begins ' : 'Night ends ') + lt(ev[0].at) : ph}">${ev.length ? (ev[0].type === 'dusk' ? '◐' : '◑') : ''}</td>`;
      }));
    }

    for (const a of anchors) {
      const mNow = b.metars.ok ? b.metars.data.find((x) => x.id === a.id) : null;
      const rNowA = mNow ? riskAt(mNow.ceilingFt, mNow.visSM, now, a.lat, a.lon) : null;
      const folded = aptFolded(a.id);
      const aptHead = (extra) => `<span class="ofold-btn">${folded ? '▸' : '▾'}</span> <span class="ogrp-id">${esc(a.id)}</span> ${mNow ? cat(mNow.fltCat) : ''} ${riskBadge(rNowA)} <span class="muted small">${esc(a.name || '')}${mNow ? ` · now: ${ceil(mNow.ceilingFt)}, ${vis(mNow.visib)}` : ''}</span>${extra}`;
      const aptBody = group(aptHead(''), `obody-apt${folded ? ' ofolded' : ''}`, a.id);
      let worst = null; // {level, from, to, src}
      const note = (level, c, src) => {
        if (!level) return;
        if (!worst || LVL(level) > LVL(worst.level)) worst = { level, from: c, to: c + HR, src };
        else if (level === worst.level && worst.to === c) worst.to = c + HR;
      };
      // The hour containing "now" is also judged against the latest METAR, so a busted forecast can't show green.
      if (mNow) {
        const cNow = cols.find((c) => c <= now && now < c + HR);
        if (cNow != null) { const r = riskAt(mNow.ceilingFt, mNow.visSM, now, a.lat, a.lon); note(r && r.level, cNow, 'current METAR'); }
      }
      const t = tafBy.get(a.id);
      if (t) {
        row('TAF', cols.map((c) => {
          const { prevailing: p, cond } = tafAt(t, c + HR / 2);
          if (!p) return `<td class="ocell${past(c)}"></td>`;
          const r = riskAt(p.ceilingFt, p.visSM, c + HR / 2, a.lat, a.lon);
          note(r && r.level, c, 'TAF');
          const worstCond = cond.map((q) => riskAt(q.ceilingFt, q.visSM, c + HR / 2, a.lat, a.lon)).filter(Boolean)
            .reduce((w, q) => (!w || LVL(q.level) > LVL(w.level) ? q : w), null);
          const cls = r ? `risk-bg-${r.level}` : `cat-bg-${p.fltCat || 'NA'}`;
          const tip = `${clouds(p.clouds, p.vertVis)} · ${vis(p.visib)}${p.wxString ? ' ' + p.wxString : ''}${r ? ` · ${r.label} (${r.lim.label})` : ''}${cond.length ? ` · plus ${cond.map((q) => (q.change === 'PROB' ? 'PROB' + (q.probability || '') : q.change) + ' ' + vis(q.visib) + ' ' + clouds(q.clouds, q.vertVis)).join('; ')}` : ''}`;
          return `<td class="ocell ${cls}${past(c)}" title="${esc(tip)}">${p.ceilingFt == null ? '' : Math.round(p.ceilingFt / 100)}${worstCond && (!r || LVL(worstCond.level) > LVL(r.level)) ? `<span class="otempo risk-bg-${worstCond.level}" title="TEMPO/PROB worse">T</span>` : ''}</td>`;
        }));
      }
      const L = lampBy[a.id];
      if (L && L.rows.length) {
        row(`LAMP ${infoTip(LAMP_INFO)}`, cols.map((c) => {
          const r0 = L.rows.find((x) => Math.abs(x.t - (c + HR)) < 31 * 60e3) || L.rows.find((x) => Math.abs(x.t - c) < 31 * 60e3);
          if (!r0) return `<td class="ocell${past(c)}"></td>`;
          const ms = c + HR / 2;
          const lo = riskAt(r0.ceilLow, r0.visLow, ms, a.lat, a.lon);           // worst end of the ranges
          const hi = riskAt(r0.ceilHigh, r0.visHigh ?? 10, ms, a.lat, a.lon);  // best end
          note(lo && lo.level, c, 'LAMP');
          const split = lo && hi && lo.level !== hi.level;
          const cls = lo ? `risk-bg-${lo.level}` : '';
          const tip = `Ceiling ${r0.ceilText} ft · Vis ${r0.visText} SM${r0.obv && r0.obv !== 'N' ? ' ' + r0.obv : ''}${r0.p01 != null ? ` · precip ${Math.round(r0.p01)}%` : r0.pop != null ? ` · precip ${r0.pop}%` : ''}${r0.ltg ? ` · lightning ${Math.round(r0.ltg)}%` : ''}${r0.conv ? ` · convection ${Math.round(r0.conv)}%` : ''}${lo ? ` · ${split ? `between ${hi.label} and ${lo.label}` : lo.label} (${lo.lim.label})` : ''}`;
          return `<td class="ocell ${cls}${split ? ' osplit split-' + hi.level : ''}${past(c)}" title="${esc(tip)}"><div>${LAMP_CIG[r0.cigCat] || '?'}</div><div class="muted">${LAMP_VIS[r0.visCat] || '?'}</div></td>`;
        }));
      }
      const W = windBy.get(a.id);
      if (W && !W.error) {
        row(`Wind ${outlook.alt.toLocaleString()} ft`, cols.map((c) => {
          const i = nearestIdx(W.times, c + HR / 2);
          if (Math.abs(W.times[i] - (c + HR / 2)) > 2 * HR) return `<td class="ocell${past(c)}"></td>`;
          const w = (W.elevFt ?? 0) + 500 > outlook.alt ? null : interpAt(W.profiles[i], outlook.alt);
          if (!w) return `<td class="ocell muted${past(c)}">—</td>`;
          return `<td class="ocell mono ${w.spd >= 50 ? 'w-red' : w.spd >= 30 ? 'w-amber' : ''}${past(c)}" title="${pad(w.dir, 3)}° / ${w.spd} kt${w.temp != null ? ' · ' + w.temp + '°C' : ''}">${pad(Math.round(w.dir / 10), 2)}<div>${w.spd}</div></td>`;
        }));
      }
      // Precip chance: NWS hourly forecast first; if NWS has none for this airport, LAMP's 1-h precip probability.
      const F = fcBy.get(a.id);
      const lampRow = (c) => (L && L.rows.length ? L.rows.find((x) => Math.abs(x.t - (c + HR)) < 31 * 60e3) : null);
      const popCell = (c, pop, tip) => `<td class="ocell${pop >= 50 ? ' o-pop-hi' : pop >= 30 ? ' o-pop-mid' : ''}${past(c)}" title="${esc(tip)}">${pop}</td>`;
      if (F && F.hourly && F.hourly.length) {
        row(`Precip % <span class="muted small">NWS</span>`, cols.map((c) => {
          const h = F.hourly.find((x) => Math.abs(x.t - c) < 31 * 60e3);
          if (!h || h.pop == null) return `<td class="ocell${past(c)}"></td>`;
          return popCell(c, h.pop, `NWS hourly: ${h.short} · ${h.temp}°${h.unit} · ${h.wind}`);
        }));
      } else if (L && L.rows.some((x) => x.p01 != null)) {
        const why = !F ? 'NWS forecast not loaded for this airport' : F.error ? `NWS: ${F.error}` : F.hourlyError ? `NWS hourly: ${F.hourlyError}` : 'NWS hourly forecast unavailable';
        row(`Precip % <span class="muted small" title="${esc(why)}; showing LAMP">LAMP</span>`, cols.map((c) => {
          const r0 = lampRow(c);
          if (!r0 || r0.p01 == null) return `<td class="ocell${past(c)}"></td>`;
          return popCell(c, Math.round(r0.p01), `LAMP: ${Math.round(r0.p01)}% chance of measurable precip in the hour${r0.ltg != null ? ` · lightning ${Math.round(r0.ltg)}%` : ''} (${why})`);
        }));
      } else {
        const why = !F ? 'NWS forecast not loaded' : F.error || F.hourlyError || 'no hourly data';
        row(`Precip % <span class="muted small">n/a</span>`, cols.map((c, i) => `<td class="ocell muted${past(c)}" title="${esc(why)}">${i === 0 ? '—' : ''}</td>`));
      }
      if (!t && !(L && L.rows.length)) row('<span class="muted">No TAF or LAMP</span>', cols.map((c) => `<td class="ocell${past(c)}"></td>`));
      // A minimized airport still shows its worst conditions for the shift in its header.
      if (folded) {
        const w = worst && worst.level !== 'green'
          ? ` <span class="risk risk-${worst.level}">${MN.LABEL[worst.level]} ${hhL(worst.from)}–${hhL(worst.to)}L</span>`
          : worst ? ' <span class="risk risk-green">Green all shift</span>' : '';
        aptBody.rows[0] = `<tr class="ogrp" data-ofold="${esc(a.id)}"><th colspan="${N + 1}">${aptHead(`${w} <span class="muted small">(minimized)</span>`)}</th></tr>`;
      }
      if (worst && worst.level !== 'green') summary.push(`<span class="alert ${worst.level === 'red' || worst.level === 'critical' ? 'red' : 'hot'}"><b>${esc(a.id)}</b> ${MN.LABEL[worst.level]} ${hhL(worst.from)}–${hhL(worst.to)}L <span class="muted">(${worst.src})</span></span>`);
      else if (worst) summary.push(`<span class="alert"><b>${esc(a.id)}</b> Green all ${N} hr</span>`);
    }

    // Area-wide items as bars
    const bars = [];
    if (b.sigmets.ok) b.sigmets.data.filter((x) => hazShown(x.hazard)).forEach((x) => bars.push({ label: `${x.kind} ${x.hazard}`, from: x.from, to: x.to, cls: /CONV/.test(x.hazard) ? 'obar-red' : 'obar-amber', tip: x.raw }));
    if (b.cwas.ok) b.cwas.data.filter((x) => hazShown(x.hazard || x.raw)).forEach((x) => bars.push({ label: `CWA ${x.hazard || ''}`, from: x.from, to: x.to, cls: 'obar-amber', tip: x.raw }));
    if (b.gairmets.ok) b.gairmets.data.filter((g) => hazShown(g.hazard)).forEach((g) => {
      const vts = (g.validTimes || []).map((v) => Date.parse(v)).filter(Number.isFinite);
      const spans = vts.length ? vts.map((v) => [v - 1.5 * HR, v + 1.5 * HR]) : g.forecastHours.map((h) => [now + (h - 1.5) * HR, now + (h + 1.5) * HR]);
      bars.push({ label: `G-AIRMET ${g.hazard}`, spans, cls: 'obar-gair', tip: g.dueTo || '' });
    });
    if (b.notams.ok && b.notams.data.configured) {
      b.notams.data.items.filter((n) => n.pri && n.pri !== 'normal' && (n.scope === 'airport' || n.cat === 'airspace')).forEach((n) => {
        const s0 = Date.parse(n.start) || now - 24 * HR;
        const e0 = !n.end || n.end === 'PERM' || n.pastEstimatedEnd ? null : Date.parse(n.end);
        if (!(s0 < cols[N - 1] + HR && (e0 == null || e0 > cols[0]))) return;
        bars.push({ label: `${n.airport}: ${n.summary}`, from: s0, to: e0, cls: n.pri === 'red' ? 'obar-red' : 'obar-amber', tip: n.text, notam: n });
      });
    }
    if (b.tfrs.ok) b.tfrs.data.forEach((x) => {
      if (b.notams.ok && b.notams.data.configured && b.notams.data.items.some((n) => n.cat === 'airspace' && String(n.number) === String(x.number))) return;
      bars.push({ label: `TFR ${x.number} ${x.type || ''}`, from: null, to: null, cls: 'obar-red', tip: `${x.description || ''} (times not in TFR feed; check NOTAM)`, unknownTimes: true });
    });
    if (bars.length) {
      group(`<span class="ofold-btn">${outlook.foldArea ? '▸' : '▾'}</span> <span class="ogrp-id">Area</span> <span class="muted small">${bars.length} advisories, TFRs and red/amber NOTAMs${outlook.foldArea ? ' (minimized)' : ''}</span>`, `obody-area${outlook.foldArea ? ' ofolded' : ''}`, '__area');
      for (const bar of bars) {
        const spans = bar.spans || [[bar.from ?? -Infinity, bar.to]];
        let labelled = false;
        const n = bar.notam;
        const when = (ms) => `${ltDay(ms)}L (${zt(ms)})`;
        const span = bar.spans
          ? 'Forecast snapshots shown on the timeline'
          : bar.unknownTimes ? 'Times not in the TFR feed; check the NOTAM'
          : `${bar.from && bar.from > 0 ? 'From ' + when(bar.from) : 'In effect now'}${bar.to ? ' until ' + when(bar.to) : n && (!n.end || n.end === 'PERM') ? ', permanent' : ''}${n && n.estimated ? ' (estimated)' : ''}`;
        const pop = `<b>${esc(bar.label)}</b><br><span class="muted">${esc(span)}</span>${n && n.schedule ? `<br>Schedule: ${esc(n.schedule)}` : ''}${n && n.number ? `<br><span class="mono">${esc(n.number)}</span>` : ''}${bar.tip && bar.tip !== bar.label ? `<pre class="raw" style="margin-top:6px;max-height:220px;overflow:auto">${esc(bar.tip)}</pre>` : ''}`;
        row(`<span class="obar-lab" tabindex="0" data-info="${encodeURIComponent(pop)}">${esc(bar.label)}</span>`, cols.map((c) => {
          const on = bar.unknownTimes ? true : spans.some(([f, tt]) => overlaps(f, tt, c));
          if (!on) return `<td class="ocell${past(c)}"></td>`;
          const lab = !labelled; labelled = true;
          return `<td class="ocell ${bar.cls}${bar.unknownTimes ? ' ounknown' : ''}${past(c)}" title="${esc(bar.tip || bar.label)}">${lab && bar.from && bar.from > cols[0] ? '▸' : ''}</td>`;
        }));
        const first = bar.spans ? null : bar.from;
        if (bar.notam && first && first >= cols[0]) summary.push(`<span class="alert ${bar.cls === 'obar-red' ? 'red' : 'hot'}">${esc(bar.label.slice(0, 60))} from ${hhL(first)}L</span>`);
        if (!bar.notam && /SIGMET|CWA/.test(bar.label) && bar.to) summary.push(`<span class="alert ${bar.cls === 'obar-red' ? 'red' : 'hot'}">${esc(bar.label)} until ${hhL(bar.to)}L</span>`);
        if (bar.spans) summary.push(`<span class="alert hot">${esc(bar.label)}</span>`);
      }
    }

    const startOpts = [['now', 'Now'], ...Array.from({ length: 24 }, (_, h) => [String(h), `${pad(h)}00 local`])]
      .map(([v, l]) => `<option value="${v}" ${String(outlook.start) === v ? 'selected' : ''}>${l}</option>`).join('');
    const altOpts = [1000, 2000, 3000, 4000, 5000, 6000, 9000, 12000].map((v) => `<option value="${v}" ${outlook.alt === v ? 'selected' : ''}>${v.toLocaleString()} ft</option>`).join('');
    const tools = `<div class="tools">
      <label class="chk small">Shift starts <select id="oStart" class="sel">${startOpts}</select></label>
      <label class="chk small">Length <select id="oHours" class="sel">${[6, 12, 18, 24].map((h) => `<option value="${h}" ${outlook.hours === h ? 'selected' : ''}>${h} hr</option>`).join('')}</select></label>
      <label class="chk small">Winds at <select id="oAlt" class="sel">${altOpts}</select></label>
      <span class="muted small">${hhL(cols[0])}–${hhL(cols[0] + N * HR)} local</span>
      <button class="btn sm" id="oFoldAll">Minimize all</button><button class="btn sm" id="oOpenAll">Expand all</button></div>`;
    const sum = `<details class="osum" ${outlook.foldSummary ? '' : 'open'}><summary><span class="lbl">Summary</span> <span class="muted small">${summary.length} item${summary.length === 1 ? '' : 's'}</span></summary>
      <div class="alerts" style="padding:6px 14px 0">${summary.join('') || '<span class="alert">Nothing notable in this window</span>'}</div></details>`;
    const legend = `<div class="muted small" style="padding:6px 14px 10px">Colors: ${mins.enabled ? 'your minimums (Green / Amber / Amber Crit / Red)' : 'flight category'}. TAF cells show ceiling in hundreds of ft; <span class="otempo risk-bg-amber">T</span> = a TEMPO/PROB group is worse. LAMP cells show ceiling (hundreds of ft) and visibility (SM) <i>ranges</i>; a striped cell straddles a limit. LAMP is NOAA statistical guidance, not a TAF (${infoTip(LAMP_INFO)} for more). Hover any cell for details.</div>`;
    const table = `<div class="scroll"><table class="otable"><thead><tr><th class="olab">Local</th>${cols.map(colHead).join('')}</tr></thead>${bodies.filter((x) => x.rows.length).map((x) => `<tbody class="${x.cls}">${x.rows.join('')}</tbody>`).join('')}</table></div>`;
    return panel('outlook', 'Shift outlook', null, tools + sum + table + legend);
  }
  function bindOutlookTools() {
    const on = (id, fn) => { const el = $(id); if (el) el.addEventListener('change', () => { fn(el.value); saveOutlook(); render(lastBrief); }); };
    on('#oStart', (v) => (outlook.start = v === 'now' ? 'now' : Number(v)));
    on('#oHours', (v) => (outlook.hours = Number(v)));
    on('#oAlt', (v) => (outlook.alt = Number(v)));
    const sumEl = document.querySelector('.panel[data-id=outlook] details.osum');
    if (sumEl) sumEl.addEventListener('toggle', () => { outlook.foldSummary = !sumEl.open; saveOutlook(); });
    document.querySelectorAll('.panel[data-id=outlook] tr.ogrp[data-ofold]').forEach((tr) => tr.addEventListener('click', () => {
      const k = tr.dataset.ofold;
      if (k === '__area') outlook.foldArea = !outlook.foldArea;
      else { outlook.foldApts = outlook.foldApts || {}; outlook.foldApts[k] = !outlook.foldApts[k]; }
      saveOutlook(); render(lastBrief);
    }));
    const setAll = (v) => { outlook.foldApts = {}; lastBrief.area.anchors.forEach((a) => (outlook.foldApts[a.id] = v)); outlook.foldArea = v; saveOutlook(); render(lastBrief); };
    const fa = $('#oFoldAll'), oa = $('#oOpenAll');
    if (fa) fa.addEventListener('click', () => setAll(true));
    if (oa) oa.addEventListener('click', () => setAll(false));
  }

  // Popup attribute for plain text (uses the shared instant popover instead of the slow native tooltip).
  const popAttr = (text) => `data-info="${encodeURIComponent(esc(text))}" tabindex="0"`;

  // ---------- card helpers: recent trend + shift worst-case ----------
  // Ceiling/visibility change over roughly the last 3 hours of METARs (oldest obs at least 2.5 h back if available).
  function cardTrend(b, id) {
    const list = (b.trend && b.trend.ok && b.trend.data[id]) || [];
    if (list.length < 2) return null;
    const last = list[list.length - 1];
    const old = list.find((m) => last.obsTime - m.obsTime <= 3.5 * 3600e3 && last.obsTime - m.obsTime >= 2.5 * 3600e3) || list[0];
    if (old === last) return null;
    const hrs = Math.round((last.obsTime - old.obsTime) / 3600e3);
    const arrow = (a, c, unit, fmt) => {
      const A = a == null ? Infinity : a, C = c == null ? Infinity : c;
      const tip = `${fmt(a)} → ${fmt(c)} over ${hrs} h`;
      if (A === C || (Number.isFinite(A) && Number.isFinite(C) && Math.abs(C - A) < (unit === 'ft' ? 200 : 0.5)))
        return `<span class="trend flat" ${popAttr('Steady: ' + tip)}>→</span>`;
      return C > A ? `<span class="trend up" ${popAttr('Improving: ' + tip)}>▲</span>` : `<span class="trend down" ${popAttr('Worsening: ' + tip)}>▼</span>`;
    };
    const fc = (v) => (v == null ? 'no ceiling' : `${v.toLocaleString()} ft`);
    const fv = (v) => (v == null ? '?' : `${v} SM`);
    return { ceil: arrow(old.ceilingFt, last.ceilingFt, 'ft', fc), vis: arrow(old.visSM, last.visSM, 'sm', fv) };
  }

  // Worst minimums level (or flight category if minimums are off) during the outlook's shift window,
  // from the TAF (prevailing periods) and LAMP (worst end of each category range). Same logic as the outlook.
  const CAT_RANK = { VFR: 0, MVFR: 1, IFR: 2, LIFR: 3 };
  const catOf = (c, v) => { const C = c == null ? Infinity : c, V = v == null ? Infinity : v;
    return C < 500 || V < 1 ? 'LIFR' : C < 1000 || V < 3 ? 'IFR' : C <= 3000 || V <= 5 ? 'MVFR' : 'VFR'; };
  function shiftWorst(b, a) {
    const start = outlookStart(), N = outlook.hours, H = 3600e3;
    const t = b.tafs.ok ? b.tafs.data.find((x) => x.id === a.id) : null;
    const L = b.lamp && b.lamp.ok ? b.lamp.data[a.id] : null;
    let worst = null; // { key, rank, label, cls, from, to, src }
    const consider = (rank, key, label, cls, c, src) => {
      if (!worst || rank > worst.rank) worst = { rank, key, label, cls, from: c, to: c + H, src };
      else if (rank === worst.rank && worst.to === c) worst.to = c + H;
    };
    for (let i = 0; i < N; i++) {
      const c = start + i * H, mid = c + H / 2;
      const levels = [];
      if (t) {
        const p = t.periods.find((q) => !q.conditional && q.from <= mid && q.to > mid);
        if (p) levels.push({ ceil: p.ceilingFt, vis: p.visSM, src: 'TAF' });
      }
      if (L) {
        const r0 = L.rows.find((x) => Math.abs(x.t - (c + H)) < 31 * 60e3);
        if (r0) levels.push({ ceil: r0.ceilLow, vis: r0.visLow, src: 'LAMP' });
      }
      if (c <= Date.now() && Date.now() < c + H && b.metars.ok) {
        const m = b.metars.data.find((x) => x.id === a.id);
        if (m) levels.push({ ceil: m.ceilingFt, vis: m.visSM, src: 'current METAR' });
      }
      for (const lv of levels) {
        if (mins.enabled) {
          const r = riskAt(lv.ceil, lv.vis, mid, a.lat, a.lon);
          if (r) consider(MN.LEVELS.indexOf(r.level), r.level, MN.LABEL[r.level], `risk risk-${r.level}`, c, lv.src);
        } else {
          const k = catOf(lv.ceil, lv.vis);
          consider(CAT_RANK[k], k, k, `cat ${k}`, c, lv.src);
        }
      }
    }
    return worst;
  }
  function shiftBadge(b, a) {
    const w = shiftWorst(b, a);
    if (!w) return '<span class="muted small">No TAF or LAMP</span>';
    const best = w.rank === 0;
    const txt = best ? `${w.label} all shift` : `${w.label} ${hhL(w.from)}–${hhL(w.to)}L`;
    return `<span class="${w.cls}" ${popAttr(`Worst forecast for the shift window, from ${w.src}. See the Shift outlook for hour-by-hour detail.`)}>${esc(txt)}</span>`;
  }

  // ---------- render ----------
  // id: stable key used for layout; title shown in the header.
  function panel(id, title, count, inner, right = '') {
    return `<section class="panel${isCollapsed(id) ? ' collapsed' : ''}" data-id="${id}">
      <h3><span class="grip" title="Drag to move">⠿</span><span class="ttl">${esc(title)}</span>${count != null ? ` <span class="count">${count}</span>` : ''}${right ? `<span class="right">${right}</span>` : ''}<button class="fold" title="Minimize / expand" aria-label="Minimize or expand">${isCollapsed(id) ? '▸' : '▾'}</button></h3>
      <div class="pbody">${inner}</div></section>`;
  }
  const failed = (s) => `<div class="err">Couldn't load: ${esc(s.error)}</div>`;

  function render(b) {
    baseBanner();
    const metarById = new Map((b.metars.ok ? b.metars.data : []).map((m) => [m.id, m]));
    const tafById = new Map((b.tafs.ok ? b.tafs.data : []).map((t) => [t.id, t]));
    const anchorIds = b.area.anchors.map((a) => a.id);
    let notice = '';
    if (b.area.unknown.length) notice = `<div class="banner err">Not found: ${esc(b.area.unknown.join(', '))}</div>`;

    const panels = {
      map: panel('map', 'Map', null, '<div id="map"></div>', `<span class="muted small">${b.area.route ? 'Route corridor' : 'Radius'} ${b.area.radiusNm} nm</span>`),
      airports: renderAirports(b, anchorIds, metarById, tafById),
      stations: renderStations(b, anchorIds),
      notams: renderNotams(b),
      advisories: renderHazards(b),
      pireps: renderPireps(b),
      tfrs: renderTfrs(b),
      forecast: renderForecast(b),
      winds: renderWinds(b),
      trend: renderTrend(b),
      outlook: renderOutlook(b),
    };
    // Keep saved order, drop unknown ids, append any new panels to the right column.
    const placed = new Set();
    const cols = layout.cols.map((c) => c.filter((id) => panels[id] && !placed.has(id) && placed.add(id)));
    Object.keys(panels).forEach((id) => { if (!placed.has(id)) cols[1].push(id); });
    layout.cols = cols;

    $('#app').innerHTML = [
      notice,
      `<div class="layout-tools">
        <button class="btn sm" id="collapseAll">Minimize all</button>
        <button class="btn sm" id="expandAll">Expand all</button>
        <button class="btn sm" id="resetLayout" title="Put every panel back in its original place">Reset layout</button>
        <span class="muted small">Drag ⠿ to move panels · ▾ to minimize</span>
      </div>`,
      panel('summary', 'Conditions', null, renderCards(b, anchorIds, metarById, tafById) + renderAlerts(b)),
      `<div class="grid2">${cols.map((c, i) => `<div class="col" data-col="${i}">${c.map((id) => panels[id]).join('')}</div>`).join('')}</div>`,
    ].join('');
    bindNotamTools();
    bindWindsTools();
    bindHazardTools();
    bindAirportFolds();
    bindOutlookTools();
    bindLayoutTools();
    drawMap(b);
  }

  function refreshMap() {
    if (!map) return;
    setTimeout(() => { map.invalidateSize(); if (mapBounds) map.fitBounds(mapBounds, { padding: [10, 10] }); }, 60);
  }

  function setCollapsed(sec, on) {
    const id = sec.dataset.id;
    sec.classList.toggle('collapsed', on);
    sec.querySelector('.fold').textContent = on ? '▸' : '▾';
    layout.collapsed = layout.collapsed.filter((x) => x !== id);
    if (on) layout.collapsed.push(id);
    if (id === 'map' && !on) refreshMap();
  }

  function bindLayoutTools() {
    $('#app').querySelectorAll('.panel .fold').forEach((btn) => btn.addEventListener('click', (e) => {
      const sec = e.currentTarget.closest('.panel');
      setCollapsed(sec, !sec.classList.contains('collapsed'));
      saveLayout();
    }));
    // Clicking the header title also toggles, for a bigger target.
    $('#app').querySelectorAll('.panel > h3 .ttl').forEach((t) => t.addEventListener('click', (e) => {
      const sec = e.currentTarget.closest('.panel');
      setCollapsed(sec, !sec.classList.contains('collapsed'));
      saveLayout();
    }));
    $('#collapseAll').onclick = () => { document.querySelectorAll('#app .panel').forEach((s) => setCollapsed(s, true)); saveLayout(); };
    $('#expandAll').onclick = () => { document.querySelectorAll('#app .panel').forEach((s) => setCollapsed(s, false)); saveLayout(); };
    $('#resetLayout').onclick = () => { layout = JSON.parse(JSON.stringify(DEFAULT_LAYOUT)); saveLayout(); render(lastBrief); };
    document.querySelectorAll('#app .col .panel > h3 .grip').forEach((g) => g.addEventListener('pointerdown', startDrag));
  }

  // Pointer-based drag (works with mouse, trackpad and touch).
  function startDrag(e) {
    if (e.button !== undefined && e.button !== 0) return;
    e.preventDefault();
    const sec = e.currentTarget.closest('.panel');
    const rect = sec.getBoundingClientRect();
    const ph = document.createElement('div');
    ph.className = 'placeholder';
    ph.style.height = rect.height + 'px';
    sec.parentNode.insertBefore(ph, sec);
    const offX = e.clientX - rect.left, offY = e.clientY - rect.top;
    Object.assign(sec.style, { position: 'fixed', left: rect.left + 'px', top: rect.top + 'px', width: rect.width + 'px', zIndex: 2000, pointerEvents: 'none' });
    sec.classList.add('dragging');
    document.body.classList.add('is-dragging');

    const move = (ev) => {
      sec.style.left = ev.clientX - offX + 'px';
      sec.style.top = ev.clientY - offY + 'px';
      // Auto-scroll near the window edges.
      if (ev.clientY < 60) window.scrollBy(0, -12); else if (ev.clientY > innerHeight - 60) window.scrollBy(0, 12);
      const col = [...document.querySelectorAll('#app .col')].find((c) => {
        const r = c.getBoundingClientRect(); return ev.clientX >= r.left && ev.clientX <= r.right;
      });
      if (!col) return;
      const others = [...col.querySelectorAll(':scope > .panel')].filter((p) => p !== sec);
      const before = others.find((p) => { const r = p.getBoundingClientRect(); return ev.clientY < r.top + r.height / 2; });
      if (before) col.insertBefore(ph, before); else col.appendChild(ph);
    };
    const up = () => {
      document.removeEventListener('pointermove', move);
      document.removeEventListener('pointerup', up);
      document.removeEventListener('pointercancel', up);
      ph.parentNode.insertBefore(sec, ph);
      ph.remove();
      sec.removeAttribute('style');
      sec.classList.remove('dragging');
      document.body.classList.remove('is-dragging');
      layout.cols = [...document.querySelectorAll('#app .col')].map((c) => [...c.querySelectorAll(':scope > .panel')].map((p) => p.dataset.id));
      saveLayout();
      if (sec.dataset.id === 'map') refreshMap();
    };
    document.addEventListener('pointermove', move);
    document.addEventListener('pointerup', up);
    document.addEventListener('pointercancel', up);
  }

  function renderCards(b, anchorIds, metarById, tafById) {
    return `<div class="cards">${anchorIds.map((id) => {
      const m = metarById.get(id);
      const t = tafById.get(id);
      const a = b.area.anchors.find((x) => x.id === id) || {};
      if (!m) {
        return `<div class="card edge-NA"><div class="hd"><span class="id">${esc(id)}</span><span class="nm">${esc(a.name || '')}</span>${cat(null)}</div>
          <div class="muted" style="margin-top:8px">No current METAR${t ? '' : ' or TAF'}.</div></div>`;
      }
      const stale = m.obsTime && Date.now() - m.obsTime > 75 * 60000;
      const lat = a.lat ?? m.lat, lon = a.lon ?? m.lon;
      const rNow = riskAt(m.ceilingFt, m.visSM, Date.now(), lat, lon);
      const tr = cardTrend(b, id);
      let rTaf = null;
      if (t && mins.enabled) {
        const soon = Date.now() + 6 * 3600e3;
        const ps = t.periods.filter((p) => !p.conditional && p.to > Date.now() && p.from < soon);
        const rs = ps.map((p) => riskForPeriod(p.ceilingFt, p.visSM, Math.max(p.from, Date.now()), Math.min(p.to, soon), lat, lon)).filter(Boolean);
        if (rs.length) rTaf = rs.reduce((w, r) => (MN.LEVELS.indexOf(r.level) > MN.LEVELS.indexOf(w.level) ? r : w));
      }
      return `<div class="card edge-${m.fltCat || 'NA'}">
        <div class="hd"><span class="id">${esc(id)}</span><span class="nm">${esc(m.name || a.name || '')}</span>${cat(m.fltCat)}</div>
        <div class="kv">
          <b>Ceiling</b><span>${ceil(m.ceilingFt)} ${tr ? tr.ceil : ''}</span>
          <b>Vis</b><span>${vis(m.visib)}${m.wx ? ' ' + esc(m.wx) : ''} ${tr ? tr.vis : ''}</span>
          <b>Wind</b><span>${wind(m.wdir, m.wspd, m.wgst)}</span>
          <b>Temp/Dew</b><span>${m.temp ?? '—'}/${m.dewp ?? '—'}°C · ${inHg(m.altim)}</span>
          <b>Observed</b><span class="${stale ? 'stale' : ''}">${zt(m.obsTime)} · ${ago(m.obsTime)}${stale ? ' · OLD' : ''}</span>
          <b>Shift <span class="muted">${hhL(outlookStart())}–${hhL(outlookStart() + outlook.hours * 3600e3)}</span></b><span>${shiftBadge(b, { ...a, lat, lon, id })}</span>
          <b>TAF next 6h</b><span>${t ? `${cat(t.worstNext6)}${t.worstNext6Tempo && t.worstNext6Tempo !== t.worstNext6 ? ` <span class="muted small">TEMPO/PROB</span> ${cat(t.worstNext6Tempo)}` : ''}${rTaf ? ' ' + riskBadge(rTaf) : ''}` : '<span class="muted">No TAF</span>'}</span>
          ${rNow ? `<b>Minimums</b><span>${riskBadge(rNow)} <span class="muted small">${esc(rNow.lim.label.split(',')[0])} ${rNow.lim.ceil}-${rNow.lim.vis}</span>${mins.terrain === 'non' && MN.maybeMountainous(lat, lon) ? ' <span class="tag warn" title="This airport may be inside a 14 CFR Part 95 designated mountainous area. Check, and switch Terrain to Mountainous in Minimums if so.">MTN?</span>' : ''}</span>` : ''}
          <b>Sun</b><span class="small">${sunLine(lat, lon)}</span>
        </div></div>`;
    }).join('')}</div>`;
  }

  // Alert chips. Each one links (data-jump) to the panel/item that explains it.
  function renderAlerts(b) {
    const items = [];
    const chip = (cls, html, jump, tip) => `<a href="#" class="alert ${cls} jump" data-jump="${esc(jump)}" title="${esc(tip || 'Show details')}">${html}</a>`;
    if (b.sigmets.ok) {
      const conv = b.sigmets.data.filter((s) => s.hazard === 'CONVECTIVE' || s.hazard === 'CONV').length;
      if (b.sigmets.data.length) items.push(chip(conv ? 'red' : 'hot', `${b.sigmets.data.length} SIGMET/AIRMET${conv ? ` · ${conv} convective` : ''}`, 'panel:advisories'));
    }
    if (mins.enabled && b.metars.ok) {
      b.area.anchors.forEach((a) => {
        const m = b.metars.data.find((x) => x.id === a.id);
        const r = m && riskAt(m.ceilingFt, m.visSM, Date.now(), a.lat, a.lon);
        if (r && (r.level === 'red' || r.level === 'critical')) items.push(chip('red', `Minimums: ${esc(a.id)} ${r.label}`, `apt:${a.id}`, `${a.id}'s METAR and TAF`));
      });
    }
    if (b.cwas.ok && b.cwas.data.length) items.push(chip('hot', `${b.cwas.data.length} Center Weather Advisory`, 'panel:advisories'));
    if (b.gairmets.ok && b.gairmets.data.length) items.push(chip('hot', `G-AIRMET: ${b.gairmets.data.map((g) => esc(g.hazard)).join(', ')}`, 'panel:advisories'));
    if (b.pireps.ok) {
      const u = b.pireps.data.filter((p) => p.urgent).length;
      if (u) items.push(chip('red', `${u} urgent PIREP`, 'panel:pireps'));
    }
    if (b.tfrs.ok && b.tfrs.data.length) items.push(chip('red', `${b.tfrs.data.length} TFR in area`, 'panel:tfrs'));
    if (b.notams.ok && b.notams.data.configured) {
      const mine = b.notams.data.items.filter((n) => n.scope === 'airport');
      const crit = mine.filter((n) => n.pri === 'red' && n.status === 'active').length;
      if (crit) items.push(chip('red', `${crit} critical NOTAM${crit === 1 ? '' : 's'} at your airports`, 'notams:critical'));
      const up = mine.filter((n) => n.status === 'upcoming').length;
      items.push(chip('', `${mine.length - up} active NOTAMs · ${up} upcoming at your airports`, 'panel:notams'));
    }
    const failedNames = ['metars', 'tafs', 'pireps', 'sigmets', 'cwas', 'gairmets', 'tfrs', 'notams', 'forecast', 'winds', 'trend', 'lamp'].filter((k) => b[k] && !b[k].ok);
    if (failedNames.length) items.push(`<span class="alert red">Failed to load: ${failedNames.join(', ')}</span>`);
    if (!items.length) items.push('<span class="alert">No advisories, TFRs or urgent PIREPs in this area</span>');
    return `<div class="alerts">${items.join('')}</div>`;
  }

  // Jump to the panel/item behind an alert chip: expand whatever is folded, scroll, and flash it.
  function jumpTo(target) {
    const [kind, arg] = target.split(':');
    const openPanel = (id) => {
      const sec = document.querySelector(`#app .panel[data-id="${id}"]`);
      if (sec && sec.classList.contains('collapsed')) { setCollapsed(sec, false); saveLayout(); }
      return sec;
    };
    let el = null;
    if (kind === 'panel') el = openPanel(arg);
    if (kind === 'apt') {
      const sec = openPanel('airports');
      const d = sec && sec.querySelector(`details.afold-apt[data-afold="${CSS.escape(arg)}"]`);
      if (d) {
        d.open = true; aptFold[arg] = true;
        const m = d.querySelector(`details[data-afold="${CSS.escape(arg)}|metar"]`); if (m) { m.open = true; aptFold[`${arg}|metar`] = true; }
        saveAptFold();
      }
      el = d || sec;
    }
    if (kind === 'notams') {
      // Show your airports' NOTAMs with the critical ones visible: switch to "Your airports" and "All", open those groups.
      let rerender = false;
      if (notamScope !== 'airport') { notamScope = 'airport'; rerender = true; }
      if (notamWindow !== 'all' && notamWindow !== 'now') { notamWindow = 'now'; rerender = true; }
      if (rerender) render(lastBrief);
      const sec = openPanel('notams');
      let first = null;
      sec.querySelectorAll('details.napt').forEach((d) => {
        const crit = d.querySelector('.nitem.pri-red');
        if (crit) {
          d.open = true; catOpen.set(d.dataset.key, true);
          const c = crit.closest('details.ncat'); if (c) { c.open = true; catOpen.set(c.dataset.key, true); }
          first = first || crit;
        }
      });
      el = first || sec;
    }
    if (!el) return;
    el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    el.classList.remove('flash'); void el.offsetWidth; el.classList.add('flash');
    if (kind === 'panel' && arg === 'map') refreshMap();
  }
  document.addEventListener('click', (e) => {
    const j = e.target.closest('a.jump[data-jump]');
    if (!j) return;
    e.preventDefault();
    jumpTo(j.dataset.jump);
  });


  function tafTable(t) {
    const now = Date.now();
    const rows = t.periods.map((p) => {
      const type = p.change === 'PROB' ? `PROB${p.probability ?? ''}` : p.change || 'Initial';
      const cls = [p.conditional ? 'cond' : '', p.to < now ? 'past' : '', !p.conditional && p.from <= now && p.to > now ? 'now' : ''].join(' ');
      const ws = p.wshear ? ` WS${pad(Math.round(p.wshear.hgt / 100), 3)}/${pad(p.wshear.dir, 3)}${p.wshear.spd}KT` : '';
      return `<tr class="${cls}">
        <td class="mono">${zt(p.from).slice(3)}–${zt(p.to).slice(3)}<div class="muted small">${ltDay(p.from)}</div></td>
        <td class="mono">${esc(type)}${p.becomingBy ? `<div class="muted small">by ${zt(p.becomingBy).slice(3)}</div>` : ''}</td>
        <td>${cat(p.fltCat)}${mins.enabled ? ' ' + riskBadge(riskForPeriod(p.ceilingFt, p.visSM, p.from, p.to, t.lat, t.lon)) : ''}</td>
        <td class="mono">${p.wspd != null ? wind(p.wdir, p.wspd, p.wgst) : '—'}${esc(ws)}</td>
        <td class="mono">${vis(p.visib)}</td>
        <td class="mono">${esc(p.wxString || '')}</td>
        <td class="mono">${esc(clouds(p.clouds, p.vertVis))}</td>
      </tr>`;
    }).join('');
    return `<div class="scroll"><table><thead><tr><th>Time (Z)</th><th>Type</th><th>Cat</th><th>Wind</th><th>Vis</th><th>Wx</th><th>Clouds</th></tr></thead><tbody>${rows}</tbody></table></div>`;
  }

  // Fold state for the Airports panel, remembered per browser. Keys: "KDFW" (whole airport), "KDFW|metar",
  // "KDFW|tafraw", "KDFW|taftable". Defaults keep it short: raw TAF folded, decoded TAF table open.
  const APT_FOLD_KEY = 'wxboard.aptFold.v1';
  const aptFold = (() => { try { return JSON.parse(localStorage.getItem(APT_FOLD_KEY)) || {}; } catch { return {}; } })();
  const APT_FOLD_DEFAULTS = { '': true, metar: true, tafraw: false, taftable: true };
  const isOpen = (key, part = '') => (key in aptFold ? aptFold[key] : APT_FOLD_DEFAULTS[part]);
  const saveAptFold = () => { try { localStorage.setItem(APT_FOLD_KEY, JSON.stringify(aptFold)); } catch {} };

  function renderAirports(b, anchorIds, metarById, tafById) {
    const fold = (key, part, summary, inner) =>
      `<details class="afold" data-afold="${esc(key)}" ${isOpen(key, part) ? 'open' : ''}><summary>${summary}</summary>${inner}</details>`;
    const blocks = anchorIds.map((id) => {
      const m = metarById.get(id);
      const t = tafById.get(id);
      const a = b.area.anchors.find((x) => x.id === id) || {};
      const rNow = m ? riskAt(m.ceilingFt, m.visSM, Date.now(), a.lat ?? m.lat, a.lon ?? m.lon) : null;
      const head = `<span class="mono apt-id">${esc(id)}</span> ${m ? cat(m.fltCat) : ''} ${riskBadge(rNow)}
        <span class="muted small">${esc(m?.name || a.name || '')}</span>
        <span class="muted small apt-hint">${m ? `METAR ${ago(m.obsTime)}` : 'no METAR'} · ${t ? `TAF ${t.periods.length} periods` : 'no TAF'}</span>`;
      const metar = fold(`${id}|metar`, 'metar', `<span class="lbl">METAR</span> <span class="muted small">${m ? ago(m.obsTime) : ''}</span>`,
        m ? `<pre class="raw">${esc(m.raw)}</pre>` : '<div class="muted small">No METAR</div>');
      const taf = t
        ? fold(`${id}|tafraw`, 'tafraw', `<span class="lbl">TAF (raw)</span> <span class="muted small">valid ${zt(t.validFrom)}–${zt(t.validTo)}</span>`, `<pre class="raw">${esc(t.raw)}</pre>`) +
          fold(`${id}|taftable`, 'taftable', `<span class="lbl">TAF by period</span>`, `<div style="margin-top:6px">${tafTable(t)}</div>`)
        : '<div class="muted small" style="margin:6px 0 0 18px">No TAF for this airport</div>';
      return `<details class="apt afold-apt" data-afold="${esc(id)}" ${isOpen(id) ? 'open' : ''}><summary class="apt-sum">${head}</summary>
        <div class="apt-body">${metar}${taf}</div></details>`;
    }).join('');
    if (!b.metars.ok && !b.tafs.ok) return panel('airports', 'Airports', null, failed(b.metars));
    const tools = `<div class="tools"><button class="btn sm" data-aptall="0">Minimize airports</button><button class="btn sm" data-aptall="1">Expand airports</button>
      <button class="btn sm" data-aptraw="1" title="Show or hide every raw TAF">Toggle raw TAFs</button></div>`;
    return panel('airports', 'Airports', anchorIds.length, tools + blocks);
  }
  function bindAirportFolds() {
    document.querySelectorAll('.panel[data-id=airports] details[data-afold]').forEach((d) =>
      d.addEventListener('toggle', () => { aptFold[d.dataset.afold] = d.open; saveAptFold(); }));
    document.querySelectorAll('[data-aptall]').forEach((btn) => btn.addEventListener('click', () => {
      const open = btn.dataset.aptall === '1';
      document.querySelectorAll('.panel[data-id=airports] details.afold-apt').forEach((d) => { d.open = open; aptFold[d.dataset.afold] = open; });
      saveAptFold();
    }));
    document.querySelectorAll('[data-aptraw]').forEach((btn) => btn.addEventListener('click', () => {
      const raws = [...document.querySelectorAll('.panel[data-id=airports] details[data-afold$="|tafraw"]')];
      const open = !raws.some((d) => d.open);
      raws.forEach((d) => { d.open = open; aptFold[d.dataset.afold] = open; });
      saveAptFold();
    }));
  }

  function renderStations(b, anchorIds) {
    if (!b.metars.ok) return panel('stations', 'Stations in area', null, failed(b.metars));
    const list = b.metars.data;
    if (!list.length) return panel('stations', 'Stations in area', 0, '<div class="none">No reporting stations</div>');
    const rows = list.map((m) => `<tr>
      <td class="mono"><b>${esc(m.id)}</b>${anchorIds.includes(m.id) ? '' : `<div class="muted small">${m.distNm} nm</div>`}</td>
      <td>${cat(m.fltCat)}${mins.enabled ? ' ' + riskBadge(riskAt(m.ceilingFt, m.visSM, Date.now(), m.lat, m.lon)) : ''}</td>
      <td class="mono">${ceil(m.ceilingFt).replace(' ft', '')}</td>
      <td class="mono">${vis(m.visib).replace(' SM', '')}${m.wx ? ' ' + esc(m.wx) : ''}</td>
      <td class="mono">${wind(m.wdir, m.wspd, m.wgst)}</td>
      <td class="mono small ${m.obsTime && Date.now() - m.obsTime > 75 * 60000 ? 'stale' : 'muted'}">${ago(m.obsTime)}</td>
    </tr>`).join('');
    return panel('stations', 'Stations in area', list.length,
      `<div class="scroll"><table><thead><tr><th>ID</th><th>Cat</th><th>Ceil</th><th>Vis</th><th>Wind</th><th>Age</th></tr></thead><tbody>${rows}</tbody></table></div>`);
  }

  // ----- NOTAMs -----
  const ND = window.NotamDecode;
  const PRI_RANK = { red: 0, amber: 1, normal: 2 };
  const NOTAM_WINDOWS = [['now', 'Now'], [3, 'Next 3 hr'], [6, 'Next 6 hr'], [12, 'Next 12 hr'], [24, 'Next 24 hr'], ['all', 'All']];
  const catOpen = new Map(); // "KDFW|surface" -> bool, remembers your expand/collapse choices this session

  // "NEW" = first seen since you started viewing that airport, within the last 12 hours. Stored per browser.
  const SEEN_KEY = 'wxboard.notamSeen.v1';
  function markNew(items) {
    let seen = {};
    try { seen = JSON.parse(localStorage.getItem(SEEN_KEY)) || {}; } catch {}
    const t = Date.now();
    for (const x of items) {
      const loc = x.airport || '?';
      const rec = seen[loc] || (seen[loc] = { first: t, ids: {} });
      if (!rec.ids[x.id]) rec.ids[x.id] = t;
      x.isNew = rec.ids[x.id] > rec.first + 60e3 && t - rec.ids[x.id] < 12 * 3600e3;
    }
    for (const rec of Object.values(seen)) for (const [id, ts] of Object.entries(rec.ids)) if (t - ts > 30 * 864e5) delete rec.ids[id];
    try { localStorage.setItem(SEEN_KEY, JSON.stringify(seen)); } catch {}
  }

  function decorateNotams(b) {
    if (!b.notams.ok || !b.notams.data.configured) return;
    for (const x of b.notams.data.items) {
      x.cat = ND.category(x);
      x.pri = ND.priority(x);
      x.summary = ND.plain(x) || x.text;
    }
    markNew(b.notams.data.items);
  }

  function inWindow(x) {
    if (notamWindow === 'all') return true;
    const t = Date.now();
    const hrs = notamWindow === 'now' ? 0 : Number(notamWindow);
    const s = Date.parse(x.start) || 0;
    const e = !x.end || x.end === 'PERM' || x.pastEstimatedEnd ? Infinity : Date.parse(x.end);
    return s <= t + hrs * 3600e3 && e >= t;
  }
  function notamPool(b) {
    return b.notams.data.items.filter((x) => notamScope === 'area' || x.scope === 'airport');
  }
  function notamVisible(b) {
    let items = notamPool(b).filter(inWindow);
    if (notamFilter) { const q = notamFilter.toUpperCase(); items = items.filter((x) => `${x.airport} ${x.number} ${x.text} ${x.summary}`.toUpperCase().includes(q)); }
    return items;
  }
  function whenText(x) {
    const s = Date.parse(x.start), e = Date.parse(x.end), t = Date.now();
    if (Number.isFinite(s) && s > t) return `<span class="tag warn">STARTS ${until(s)}</span> <span class="mono small">${zt(s)}</span>`;
    if (x.pastEstimatedEnd) return '<span class="tag warn" title="Estimated end time has passed but it has not been cancelled">PAST EST END</span>';
    if (!x.end || x.end === 'PERM') return '<span class="mono small muted">PERM</span>';
    return `<span class="mono small muted">until ${zt(e)}${x.estimated ? ' EST' : ''} · ${until(e).replace('in ', '')} left</span>`;
  }
  function notamItem(x) {
    return `<div class="nitem pri-${x.pri}">
      <div class="nline"><span class="nsum">${x.isNew ? '<span class="tag blue">NEW</span> ' : ''}${esc(x.summary)}</span><span class="nwhen">${whenText(x)}</span></div>
      <div class="nmeta muted small"><span class="mono">${esc(x.number || '')}</span>${x.classification ? ` · ${esc(x.classification)}` : ''}${x.schedule ? ` · ${esc(x.schedule)}` : ''}${x.limits ? ` · ${esc(x.limits)}` : ''}
        <details class="raw-toggle"><summary>raw</summary><pre class="raw">${esc(x.text)}</pre></details></div>
    </div>`;
  }
  function notamListHtml(b) {
    const items = notamVisible(b);
    if (!items.length) return `<div class="none">No NOTAMs ${notamWindow === 'all' ? '' : 'in effect for this time window'}${notamFilter ? ' matching the filter' : ''}.</div>`;
    const anchorIds = b.area.anchors.map((a) => a.id);
    const byApt = new Map();
    for (const x of items) { if (!byApt.has(x.airport)) byApt.set(x.airport, []); byApt.get(x.airport).push(x); }
    const apts = [...byApt.keys()].sort((p, q) => {
      const i = anchorIds.indexOf(p), j = anchorIds.indexOf(q);
      return (i === -1 ? 99 : i) - (j === -1 ? 99 : j) || p.localeCompare(q);
    });
    return apts.map((apt) => {
      const list = byApt.get(apt);
      const red = list.filter((x) => x.pri === 'red').length, amber = list.filter((x) => x.pri === 'amber').length;
      const nNew = list.filter((x) => x.isNew).length;
      const cats = ND.CATEGORIES.map((c) => {
        const inCat = list.filter((x) => x.cat === c.id).sort((p, q) => PRI_RANK[p.pri] - PRI_RANK[q.pri] || (Date.parse(p.start) || 0) - (Date.parse(q.start) || 0));
        if (!inCat.length) return '';
        const key = `${apt}|${c.id}`;
        const hot = inCat.some((x) => x.pri !== 'normal');
        const open = catOpen.has(key) ? catOpen.get(key) : !(c.collapsed && !hot);
        const cr = inCat.filter((x) => x.pri === 'red').length, ca = inCat.filter((x) => x.pri === 'amber').length;
        return `<details class="ncat" data-key="${esc(key)}" ${open ? 'open' : ''}><summary><span class="ncat-name">${esc(c.label)}</span> <span class="count">${inCat.length}</span>${cr ? `<span class="dot red" title="${cr} critical"></span>` : ''}${ca ? `<span class="dot amber" title="${ca} caution"></span>` : ''}</summary>
          ${inCat.map(notamItem).join('')}</details>`;
      }).join('');
      const aptKey = `${apt}|*`;
      const aptOpen = catOpen.has(aptKey) ? catOpen.get(aptKey) : true;
      return `<details class="napt ncat" data-key="${esc(aptKey)}" ${aptOpen ? 'open' : ''}><summary class="napt-hd"><span class="tag ${anchorIds.includes(apt) ? 'blue' : ''}">${esc(apt)}</span>
        <span class="muted small">${list.length} NOTAM${list.length === 1 ? '' : 's'}</span>
        ${red ? `<span class="tag red">${red} critical</span>` : ''}${amber ? `<span class="tag warn">${amber} caution</span>` : ''}${nNew ? `<span class="tag blue">${nNew} new</span>` : ''}</summary>${cats}</details>`;
    }).join('');
  }
  function syncLine(st) {
    if (!st) return '';
    if (!st.count && (st.status === 'loading' || st.status === 'idle'))
      return `<div class="banner" style="margin:10px 14px">Downloading the full NOTAM set from the FAA. This first download can take a few minutes; the panel fills in on the next refresh.</div>`;
    if (!st.count && st.status === 'error')
      return `<div class="err">NOTAM download failed: ${esc(st.lastError || 'unknown error')}. It will retry automatically.</div>`;
    const age = st.lastUpdate ? ago(st.lastUpdate) : 'never';
    return `<div class="muted small" style="padding:6px 14px">Local copy: ${st.count.toLocaleString()} US NOTAMs · updated ${age}${st.lastError ? ` · <span class="stale">last sync problem: ${esc(st.lastError)}</span>` : ''}</div>`;
  }
  function renderNotams(b) {
    const n = b.notams;
    if (!n.ok) return panel('notams', 'NOTAMs', null, failed(n) + `<div class="none">Check <a href="${b.links.notamSearch}" target="_blank" rel="noopener">FAA NOTAM Search</a> directly.</div>`);
    if (!n.data.configured) {
      return panel('notams', 'NOTAMs', null, `<div class="body">
        <p style="margin-top:0">NOTAMs aren't set up yet. Add your NMS-API client ID and secret (the KEY and SECRET from the FAA onboarding spreadsheet) to <code>config.json</code> and restart.</p>
        <p>Until then, use <a href="${b.links.notamSearch}" target="_blank" rel="noopener">FAA NOTAM Search</a> for ${esc(b.area.anchors.map((a) => a.id).join(', '))}.</p></div>`);
    }
    const pool = notamPool(b);
    const nAirport = n.data.items.filter((x) => x.scope === 'airport').length;
    const tools = `<div class="tools">
      <div class="tabs"><button class="tab ${notamScope === 'airport' ? 'on' : ''}" data-scope="airport">Your airports (${nAirport})</button>
      <button class="tab ${notamScope === 'area' ? 'on' : ''}" data-scope="area" title="Every NOTAM with a location inside the ${n.data.areaRadiusNm} nm area">Whole area (${n.data.items.length})</button></div>
      <label class="chk small">In effect <select id="notamWin" class="sel">${NOTAM_WINDOWS.map(([v, l]) => `<option value="${v}" ${String(v) === String(notamWindow) ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
      <input type="search" id="notamQ" placeholder="Filter text…" value="${esc(notamFilter)}">
      <button class="btn sm" id="notamFoldAll" title="Minimize every airport">Minimize airports</button>
      <button class="btn sm" id="notamOpenAll" title="Expand every airport">Expand airports</button>
    </div>${syncLine(n.data.sync)}`;
    const testTag = status.nmsEnv && status.nmsEnv !== 'prod' ? `<span class="tag red">${esc(status.nmsEnv.toUpperCase())} TEST DATA, NOT REAL</span>` : '';
    return panel('notams', 'NOTAMs', notamVisible(b).length, tools + `<div id="notamList">${notamListHtml(b)}</div>`, testTag);
  }
  function bindNotamCats() {
    document.querySelectorAll('#notamList details.ncat').forEach((d) => d.addEventListener('toggle', () => catOpen.set(d.dataset.key, d.open)));
  }
  function refreshNotamList() { $('#notamList').innerHTML = notamListHtml(lastBrief); bindNotamCats(); }
  function bindNotamTools() {
    document.querySelectorAll('.tab[data-scope]').forEach((t) => t.addEventListener('click', () => { notamScope = t.dataset.scope; render(lastBrief); }));
    const w = $('#notamWin');
    if (w) w.addEventListener('change', () => {
      notamWindow = w.value === 'now' || w.value === 'all' ? w.value : Number(w.value);
      try { localStorage.setItem('wxboard.notamWindow', String(notamWindow)); } catch {}
      render(lastBrief);
    });
    const q = $('#notamQ');
    if (q) q.addEventListener('input', () => { notamFilter = q.value; refreshNotamList(); });
    const setAll = (open) => document.querySelectorAll('#notamList details.napt').forEach((d) => { d.open = open; catOpen.set(d.dataset.key, open); });
    const fa = $('#notamFoldAll'), oa = $('#notamOpenAll');
    if (fa) fa.addEventListener('click', () => setAll(false));
    if (oa) oa.addEventListener('click', () => setAll(true));
    bindNotamCats();
  }

  // ----- Winds aloft (model profile, interpolated to the altitudes you pick) -----
  const CUTOFFS = [3000, 6000, 9000, 12000, 18000, 24000, 30000, 34000, 39000];
  const HIGH_LEVELS = [3000, 6000, 9000, 12000, 18000, 24000, 30000, 34000, 39000];
  const WIND_HOURS = [0, 3, 6, 12, 24];
  function windAltitudes() {
    // Low cutoffs get every 1,000 ft (useful for helicopters); higher ones use the familiar FB levels.
    if (windsMax <= 12000) { const out = []; for (let a = 1000; a <= windsMax; a += 1000) out.push(a); return out; }
    return HIGH_LEVELS.filter((l) => l <= windsMax);
  }
  const toUV = (s, d) => { const r = (d * Math.PI) / 180; return [-s * Math.sin(r), -s * Math.cos(r)]; };
  function interpAt(levels, alt) {
    if (!levels || levels.length < 2 || alt < levels[0].h || alt > levels[levels.length - 1].h) return null;
    let i = 0; while (i < levels.length - 2 && levels[i + 1].h < alt) i++;
    const A = levels[i], B = levels[i + 1];
    const f = B.h === A.h ? 0 : (alt - A.h) / (B.h - A.h);
    const [ua, va] = toUV(A.s, A.d), [ub, vb] = toUV(B.s, B.d);
    const u = ua + (ub - ua) * f, v = va + (vb - va) * f;
    const spd = Math.hypot(u, v);
    let dir = (Math.atan2(-u, -v) * 180) / Math.PI; dir = (dir + 360) % 360;
    const t = A.t == null || B.t == null ? null : A.t + (B.t - A.t) * f;
    return { spd: Math.round(spd), dir: Math.round(dir / 10) * 10 || 360, temp: t == null ? null : Math.round(t) };
  }
  function windCell(w) {
    if (!w) return '<td class="mono muted">—</td>';
    const t = w.temp === null ? '' : `<div class="muted small">${w.temp > 0 ? '+' : ''}${w.temp}°C</div>`;
    if (w.spd < 5) return `<td class="mono wcell">LGT VRB${t}</td>`;
    const cls = w.spd >= 50 ? 'w-red' : w.spd >= 30 ? 'w-amber' : '';
    return `<td class="mono wcell ${cls}">${pad(w.dir, 3)}°/${w.spd}kt${t}</td>`;
  }
  function nearestIdx(times, target) {
    let best = 0;
    times.forEach((t, i) => { if (Math.abs(t - target) < Math.abs(times[best] - target)) best = i; });
    return best;
  }
  function windsBody(b) {
    const W = b.winds.data;
    const target = Date.now() + windsHr * 3600e3;
    const alts = windAltitudes();
    let validAt = null;
    const rows = W.points.map((pt) => {
      if (pt.error) return `<tr><td class="mono"><b>${esc(pt.id)}</b></td><td colspan="${alts.length}" class="err" style="padding:6px 8px">${esc(pt.error)}</td></tr>`;
      const i = nearestIdx(pt.times, target);
      validAt = validAt || pt.times[i];
      const prof = pt.profiles[i];
      const floor = (pt.elevFt ?? 0) + 500; // nothing reported within 500 ft of the ground
      return `<tr><td class="mono"><b>${esc(pt.id)}</b><div class="muted small">elev ${pt.elevFt != null ? pt.elevFt.toLocaleString() : '?'} ft</div></td>
        ${alts.map((alt) => windCell(alt < floor ? null : interpAt(prof, alt))).join('')}</tr>`;
    }).join('');
    return `<div class="muted small" style="padding:8px 14px 0">Forecast for ${zt(validAt)} (${ltDay(validAt)} local). Altitudes MSL, direction true. — = within 500 ft of the ground. Model winds (${esc(W.source)}), not an official NWS winds aloft forecast.</div>
      <div class="scroll"><table><thead><tr><th>Airport</th>${alts.map((l) => `<th>${l.toLocaleString()}</th>`).join('')}</tr></thead><tbody>${rows}</tbody></table></div>`;
  }
  function renderWinds(b) {
    if (!b.winds) return panel('winds', 'Winds aloft', null, '<div class="none">Restart the server to load winds aloft</div>');
    if (!b.winds.ok) return panel('winds', 'Winds aloft', null, failed(b.winds));
    const tabs = WIND_HOURS.map((h) => `<button class="tab ${h === windsHr ? 'on' : ''}" data-whr="${h}">${h === 0 ? 'Now' : '+' + h + ' hr'}</button>`).join('');
    const opts = CUTOFFS.map((l) => `<option value="${l}" ${l === windsMax ? 'selected' : ''}>${l.toLocaleString()} ft</option>`).join('');
    const tools = `<div class="tools"><div class="tabs">${tabs}</div>
      <label class="chk small">Up to <select id="windsMax" class="sel">${opts}</select></label></div>`;
    return panel('winds', 'Winds aloft', null, tools + `<div id="windsBody">${windsBody(b)}</div>`);
  }
  function bindWindsTools() {
    document.querySelectorAll('[data-whr]').forEach((t) => t.addEventListener('click', () => {
      windsHr = Number(t.dataset.whr);
      document.querySelectorAll('[data-whr]').forEach((x) => x.classList.toggle('on', x === t));
      $('#windsBody').innerHTML = windsBody(lastBrief);
    }));
    const sel = $('#windsMax');
    if (sel) sel.addEventListener('change', () => {
      windsMax = Number(sel.value);
      try { localStorage.setItem('wxboard.windsMax', String(windsMax)); } catch {}
      $('#windsBody').innerHTML = windsBody(lastBrief);
    });
  }

  // ----- Hazards (with hazard-type filter that also applies to the map) -----
  const HAZ_GROUPS = [
    ['conv', 'Convective'], ['turb', 'Turbulence'], ['ice', 'Icing'], ['fzlvl', 'Freezing level'], ['ifr', 'IFR'],
    ['mtn', 'Mountain obscuration'], ['llws', 'Low-level wind shear'], ['wind', 'Surface wind'], ['ash', 'Volcanic ash'], ['other', 'Other'],
  ];
  function hazGroup(h) {
    const t = String(h || '').toUpperCase();
    if (/CONV|TS\b|THUNDER/.test(t)) return 'conv';
    if (/LLWS|WIND SHEAR|WS\b/.test(t)) return 'llws';
    if (/FZLVL|FRZ.?LVL|FREEZING LEVEL/.test(t)) return 'fzlvl';
    if (/TURB/.test(t)) return 'turb';
    if (/ICE|ICING|FZRA/.test(t)) return 'ice';
    if (/MT.?OBSC|MTN|OBSC/.test(t)) return 'mtn';
    if (/IFR|CIG|VIS/.test(t)) return 'ifr';
    if (/SFC.?WND|WIND|WND/.test(t)) return 'wind';
    if (/ASH|VA\b/.test(t)) return 'ash';
    return 'other';
  }
  let hiddenHaz = (() => { try { return new Set(JSON.parse(localStorage.getItem('wxboard.hiddenHazards')) || []); } catch { return new Set(); } })();
  const hazShown = (h) => !hiddenHaz.has(hazGroup(h));

  function renderHazards(b) {
    const all = [];
    if (b.sigmets.ok) b.sigmets.data.forEach((x) => all.push({ type: 'sig', g: hazGroup(x.hazard), x }));
    if (b.cwas.ok) b.cwas.data.forEach((x) => all.push({ type: 'cwa', g: hazGroup(x.hazard || x.raw), x }));
    if (b.gairmets.ok) b.gairmets.data.forEach((x) => all.push({ type: 'gair', g: hazGroup(x.hazard), x }));
    const counts = {};
    all.forEach((a) => { counts[a.g] = (counts[a.g] || 0) + 1; });
    const chips = HAZ_GROUPS.filter(([id]) => counts[id]).map(([id, label]) =>
      `<button class="hchip ${hiddenHaz.has(id) ? 'off' : 'on'}" data-haz="${id}" title="${hiddenHaz.has(id) ? 'Show' : 'Hide'} ${esc(label)}">${esc(label)} <span class="count">${counts[id]}</span></button>`).join('');
    const shown = all.filter((a) => !hiddenHaz.has(a.g));
    const nHidden = all.length - shown.length;
    const parts = shown.map(({ type, x }) => {
      if (type === 'sig') {
        const alt = x.base != null || x.top != null ? `${x.base ?? 'SFC'}–${x.top ?? '?'} ft` : '';
        return `<div class="item"><div class="meta"><span class="tag ${/CONV/.test(x.hazard) ? 'red' : 'warn'}">${esc(x.kind)} ${esc(x.series || '')}</span>
          <b>${esc(x.hazard || '')}</b>${x.severity ? `<span class="muted">${esc(x.severity)}</span>` : ''}<span class="mono small">${zt(x.from)}–${zt(x.to)}</span>${alt ? `<span class="muted small">${alt}</span>` : ''}</div>
          <pre class="raw">${esc(x.raw)}</pre></div>`;
      }
      if (type === 'cwa') {
        return `<div class="item"><div class="meta"><span class="tag warn">CWA ${esc(x.center || '')} ${esc(x.seq || '')}</span><b>${esc(x.hazard || '')}</b><span class="mono small">${zt(x.from)}–${zt(x.to)}</span></div>
          ${x.raw ? `<pre class="raw">${esc(x.raw)}</pre>` : ''}</div>`;
      }
      return `<div class="item"><div class="meta"><span class="tag warn">G-AIRMET ${esc(x.product || '')}</span><b>${esc(x.hazard)}</b>
        <span class="muted small">forecast hrs: ${x.forecastHours.map((h) => '+' + h).join(' ') || '—'}</span></div>
        ${x.dueTo ? `<div class="small">${esc(x.dueTo)}</div>` : ''}</div>`;
    });
    const errs = ['sigmets', 'cwas', 'gairmets'].filter((k) => !b[k].ok).map((k) => `<div class="err">${k}: ${esc(b[k].error)}</div>`).join('');
    const tools = chips ? `<div class="tools"><span class="muted small">Show:</span>${chips}${nHidden ? `<span class="muted small">${nHidden} hidden from list and map</span>` : ''}</div>` : '';
    const body = parts.join('') || (all.length ? '<div class="none">All advisories here are hidden by your filter.</div>' : '<div class="none">None affecting this area</div>');
    return panel('advisories', 'Advisories (SIGMET · CWA · G-AIRMET)', all.length === shown.length ? all.length : `${shown.length}/${all.length}`, errs + tools + body);
  }
  function bindHazardTools() {
    document.querySelectorAll('.hchip[data-haz]').forEach((c) => c.addEventListener('click', () => {
      const id = c.dataset.haz;
      if (hiddenHaz.has(id)) hiddenHaz.delete(id); else hiddenHaz.add(id);
      try { localStorage.setItem('wxboard.hiddenHazards', JSON.stringify([...hiddenHaz])); } catch {}
      render(lastBrief);
    }));
  }

  function renderPireps(b) {
    if (!b.pireps.ok) return panel('pireps', 'PIREPs (last 3h)', null, failed(b.pireps));
    const list = b.pireps.data;
    if (!list.length) return panel('pireps', 'PIREPs (last 3h)', 0, '<div class="none">No PIREPs in area</div>');
    return panel('pireps', 'PIREPs (last 3h)', list.length, list.map((p) => `<div class="item"><div class="meta">
      ${p.urgent ? '<span class="tag red">UUA</span>' : '<span class="tag">UA</span>'}
      <span class="mono small">${zt(p.obsTime)} · ${ago(p.obsTime)}</span>${p.fltLvl != null ? `<span class="mono small">FL${pad(p.fltLvl, 3)}</span>` : ''}
      ${p.acType ? `<span class="mono small">${esc(p.acType)}</span>` : ''}<span class="muted small">${p.distNm} nm</span>
      ${p.turb ? `<span class="tag warn">TB ${esc(p.turb)}</span>` : ''}${p.ice ? `<span class="tag blue">IC ${esc(p.ice)}</span>` : ''}</div>
      <pre class="raw">${esc(p.raw)}</pre></div>`).join(''));
  }

  function renderTfrs(b) {
    const link = `<a href="${b.links.tfrList}" target="_blank" rel="noopener">FAA TFR list</a>`;
    if (!b.tfrs.ok) return panel('tfrs', 'TFRs', null, failed(b.tfrs), link);
    const list = b.tfrs.data;
    if (!list.length) return panel('tfrs', 'TFRs', 0, '<div class="none">No TFRs within the area</div>', link);
    return panel('tfrs', 'TFRs', list.length, list.map((t) => `<div class="item"><div class="meta">
      <span class="tag red">${esc(t.number)}</span><b>${esc(t.type || '')}</b><span class="muted small">${t.distNm === 0 ? 'overlaps area' : t.distNm + ' nm'}</span>
      ${t.facility ? `<span class="mono small">${esc(t.facility)}</span>` : ''}</div>
      <div>${esc(t.description || '')}</div></div>`).join(''), link);
  }

  function renderForecast(b) {
    if (!b.forecast.ok) return panel('forecast', 'Area forecast (NWS)', null, failed(b.forecast));
    const blocks = b.forecast.data.map((f) => f.error
      ? `<div class="item"><b>${esc(f.id)}</b> <span class="muted">${esc(f.error)}</span></div>`
      : `<div class="item"><div class="meta"><b class="mono">${esc(f.id)}</b><span class="muted small">${esc(f.place || '')}</span></div>
        <div class="fcst">${f.periods.map((p) => `<div class="p" title="${esc(p.detail)}"><div class="n">${esc(p.name)}</div>
          <div class="t">${p.temperature ?? '—'}°${esc(p.unit || '')}</div><div class="small">${esc(p.short)}</div>
          <div class="muted small">${esc(p.wind)}${p.precipChance != null ? ` · ${p.precipChance}% precip` : ''}</div></div>`).join('')}</div></div>`).join('');
    return panel('forecast', 'Area forecast (NWS)', null, blocks);
  }

  // ----- Map -----
  const CAT_COLORS = { VFR: '#3fbf5f', MVFR: '#4f8dff', IFR: '#ff4d4d', LIFR: '#e05cff' };
  function drawMap(b) {
    const el = document.getElementById('map');
    if (!el || typeof L === 'undefined') { if (el) el.innerHTML = '<div class="none">Map library unavailable </div>'; return; }
    // Keep one Leaflet map for the page's life: re-rendering replaces #map, so move the existing map's
    // container into its place instead of rebuilding the map (and losing tiles, zoom and pan).
    let reused = false;
    if (map) {
      const box = map.getContainer();
      if (box !== el) { el.replaceWith(box); }
      mapLayers.clearLayers();
      map.invalidateSize();
      reused = true;
    } else {
      map = L.map(el, { zoomControl: true, attributionControl: true });
      L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 12, attribution: '&copy; OpenStreetMap contributors' }).addTo(map);
      mapLayers = L.layerGroup().addTo(map);
    }

    const pts = b.area.anchors.map((a) => [a.lat, a.lon]);
    const nm2m = 1852;
    if (b.area.route && pts.length > 1) {
      L.polyline(pts, { color: '#5fb3ff', weight: 2, dashArray: '6 6' }).addTo(mapLayers);
      // corridor approximation: circles at each point + the line
      pts.forEach((p) => L.circle(p, { radius: b.area.radiusNm * nm2m, color: '#5fb3ff', weight: 1, fill: false, dashArray: '2 6' }).addTo(mapLayers));
    } else {
      pts.forEach((p) => L.circle(p, { radius: b.area.radiusNm * nm2m, color: '#5fb3ff', weight: 1, fillOpacity: 0.04 }).addTo(mapLayers));
    }

    const hz = (geom, color, label) => {
      if (!geom) return;
      try {
        L.geoJSON(geom, { style: { color, weight: 1.5, fillOpacity: 0.12 } }).bindTooltip(esc(label)).addTo(mapLayers);
      } catch {}
    };
    if (b.sigmets.ok) b.sigmets.data.filter((s) => hazShown(s.hazard)).forEach((s) => hz(s.geometry, /CONV/.test(s.hazard) ? '#ff4d4d' : '#ffb547', `${s.kind} ${s.hazard}`));
    if (b.cwas.ok) b.cwas.data.filter((c) => hazShown(c.hazard || c.raw)).forEach((c) => hz(c.geometry, '#ffb547', `CWA ${c.hazard || ''}`));
    if (b.gairmets.ok) b.gairmets.data.filter((g) => hazShown(g.hazard)).forEach((g) => hz(g.geometry, '#c9a227', `G-AIRMET ${g.hazard}`));
    if (b.tfrs.ok) b.tfrs.data.forEach((t) => hz(t.geometry, '#ff3b8b', `TFR ${t.number} ${t.type || ''}`));

    if (b.metars.ok) b.metars.data.forEach((m) => {
      if (m.lat == null) return;
      L.circleMarker([m.lat, m.lon], { radius: 6, color: '#000', weight: 1, fillColor: CAT_COLORS[m.fltCat] || '#888', fillOpacity: 1 })
        .bindTooltip(esc(m.id), { permanent: true, direction: 'right', className: 'map-label', offset: [6, 0] })
        .bindPopup(`<b>${esc(m.id)}</b> ${esc(m.fltCat || '')}<br><span style="font-family:monospace">${esc(m.raw)}</span>`)
        .addTo(mapLayers);
    });
    if (b.pireps.ok) b.pireps.data.forEach((p) => {
      if (p.lat == null) return;
      L.circleMarker([p.lat, p.lon], { radius: 4, color: p.urgent ? '#ff4d4d' : '#ffffff', weight: 2, fill: false })
        .bindPopup(`<span style="font-family:monospace">${esc(p.raw)}</span>`).addTo(mapLayers);
    });

    const bb = b.area.bbox;
    const newBounds = [[bb.minLat, bb.minLon], [bb.maxLat, bb.maxLon]];
    // Re-fit only when the area changed, so a background refresh keeps your zoom and pan.
    if (!reused || JSON.stringify(newBounds) !== JSON.stringify(mapBounds)) map.fitBounds(newBounds, { padding: [10, 10] });
    mapBounds = newBounds;
  }

  // ---------- start ----------
  async function init() {
    renderSaved();
    try { status = await (await fetch('/api/status')).json(); } catch {}
    baseBanner();
    if (status.defaultRadiusNm) $('#radius').value = status.defaultRadiusNm;
    const p = new URLSearchParams(location.search);
    if (p.get('ids')) {
      const a = { ids: p.get('ids'), radius: Number(p.get('radius')) || status.defaultRadiusNm || 30, route: p.get('route') === '1' };
      setForm(a); run(a);
    } else {
      $('#ids').focus();
    }
  }
  init();
})();
