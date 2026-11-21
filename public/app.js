// wxboard front end. Talks only to the local server at /api/*.
(() => {
  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const REFRESH_MS = 5 * 60 * 1000;
  const STORE_KEY = 'wxboard.savedAreas';
  const DEFAULT_SAVED = []; // no built-in quick picks; each user saves their own
  const LAST_KEY = 'wxboard.lastArea';

  let current = null;     // { ids, radius, route }
  let lastBrief = null;
  let refreshTimer = null;
  let map = null, mapLayers = null, mapBounds = null, mapNeedsFit = false;
  let windsHr = 0;
  let windsMax = (() => { try { return Number(localStorage.getItem('wxboard.windsMax')) || 12000; } catch { return 12000; } })();
  let notamScope = 'airport', notamFilter = '';
  let notamWindow = (() => { try { const v = localStorage.getItem('wxboard.notamWindow'); return v === 'now' || v === 'all' ? v : Number(v) || 6; } catch { return 6; } })();
  let status = { demo: false, notamsConfigured: false };

  // ---------- storage (best effort) ----------
  // Saved areas in this browser: used when sign-ins are off, and imported once into the account when they're on.
  function loadLocalAreas() {
    try { const v = JSON.parse(localStorage.getItem(STORE_KEY)); return Array.isArray(v) ? v.filter((a) => a && a.ids) : DEFAULT_SAVED; }
    catch { return DEFAULT_SAVED; }
  }
  function storeLocalAreas(list) { try { localStorage.setItem(STORE_KEY, JSON.stringify(list)); } catch {} }

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

  // ---------- saved areas of operation ----------
  // Signed in: kept with the account on the server, so they follow the pilot to any browser or device.
  // Sign-ins off (a personal install): kept in this browser.
  let areas = [];
  const IMPORTED_KEY = 'wxboard.savedAreas.imported';
  const areasOnServer = () => Boolean(status.auth && status.user);
  const areaTip = (a) => `${a.ids} · ${a.radius} nm${a.route ? ' · route' : ''}${a.default ? ' · opens by default' : ''}`;

  async function putAreas(list) {
    const r = await fetch('/api/areas', { method: 'PUT', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': status.user.csrf }, body: JSON.stringify({ areas: list }) });
    const j = await r.json().catch(() => ({}));
    if (r.status === 401) { location.href = '/login'; throw new Error('Signed out'); }
    if (!r.ok) throw new Error(j.error || r.statusText);
    return j.areas;
  }
  async function loadAreas() {
    if (!areasOnServer()) { areas = loadLocalAreas(); return; }
    try {
      const r = await fetch('/api/areas');
      if (!r.ok) throw new Error(((await r.json().catch(() => ({}))).error) || r.statusText);
      areas = (await r.json()).areas || [];
      // One time per browser: move areas saved here before they were kept with the account.
      let imported = '1';
      try { imported = localStorage.getItem(IMPORTED_KEY); } catch {}
      const local = loadLocalAreas();
      if (local.length && !imported) {
        const extra = local.filter((l) => !areas.some((a) => a.label === l.label && a.ids === String(l.ids).toUpperCase()))
          .map((l) => ({ label: l.label || l.ids, ids: l.ids, radius: l.radius, route: Boolean(l.route) }));
        if (extra.length) areas = await putAreas([...areas, ...extra].slice(0, 50));
        try { localStorage.setItem(IMPORTED_KEY, '1'); } catch {}
      }
    } catch (e) {
      showBanner(`Couldn't load your saved areas: ${esc(e.message)}`, true);
    }
  }
  // Returns '' on success, or the reason it failed.
  async function saveAreas(list) {
    if (!areasOnServer()) { storeLocalAreas(list); areas = list; renderSaved(); return ''; }
    try { areas = await putAreas(list); renderSaved(); return ''; }
    catch (e) { return e.message || 'Save failed'; }
  }

  function renderSaved() {
    const el = $('#saved');
    if (!areas.length) { el.innerHTML = ''; return; }
    el.innerHTML = areas.map((a, i) =>
      `<span class="chip${a.default ? ' chip-default' : ''}" data-i="${i}" ${popAttr(areaTip(a))}>${a.default ? '<span class="star" aria-label="Default">★</span>' : ''}${esc(a.label)}<button class="x" data-del="${i}" aria-label="Remove ${esc(a.label)}">×</button></span>`).join('')
      + '<button type="button" class="btn sm" id="areasEdit">Edit areas</button>';
  }
  $('#saved').addEventListener('click', async (e) => {
    if (e.target.closest('#areasEdit')) { openAreasDialog(); return; }
    const del = e.target.closest('[data-del]');
    if (del) {
      e.stopPropagation();
      const list = areas.filter((_, i) => i !== Number(del.dataset.del));
      const err = await saveAreas(list);
      if (err) showBanner(`Couldn't remove the area: ${esc(err)}`, true);
      return;
    }
    const chip = e.target.closest('.chip');
    if (chip) { const a = areas[Number(chip.dataset.i)]; if (a) { setForm(a); run(a); } }
  });
  $('#saveArea').addEventListener('click', async () => {
    const a = readForm();
    if (!a.ids) return;
    const label = prompt('Name for this area', `${a.ids} ${a.radius}nm${a.route ? ' route' : ''}`);
    if (!label) return;
    const err = await saveAreas([...areas, { ...a, label }]);
    if (err) showBanner(`Couldn't save the area: ${esc(err)}`, true);
  });

  // Editor: rename, change airports/radius/route, reorder, remove, pick the default. Changes are saved together.
  function openAreasDialog(draft) {
    let d = document.getElementById('areasDlg');
    if (!d) { d = document.createElement('div'); d.id = 'areasDlg'; document.body.appendChild(d); }
    draft = draft || areas.map((a) => ({ ...a }));
    const rows = draft.map((a, i) => `<div class="ar-row" data-i="${i}">
        <label class="fld ar-name"><span>Name</span><input data-f="label" maxlength="40" value="${esc(a.label)}"></label>
        <label class="fld ar-ids"><span>Airports</span><input data-f="ids" spellcheck="false" value="${esc(a.ids)}"></label>
        <label class="fld ar-rad"><span>Radius nm</span><input data-f="radius" type="number" min="5" max="300" step="5" value="${esc(a.radius)}"></label>
        <label class="chk small"><input data-f="route" type="checkbox" ${a.route ? 'checked' : ''}> Route</label>
        <label class="chk small" ${popAttr('Briefed automatically when you open wxboard without airports in the address.')}><input type="radio" name="arDefault" data-f="default" ${a.default ? 'checked' : ''}> Default</label>
        <span class="ar-btns"><button class="btn sm" data-armove="-1" ${i === 0 ? 'disabled' : ''} aria-label="Move up">↑</button><button class="btn sm" data-armove="1" ${i === draft.length - 1 ? 'disabled' : ''} aria-label="Move down">↓</button><button class="btn sm" data-ardel>Remove</button></span>
      </div>`).join('');
    const where = areasOnServer() ? 'Saved with your account, so they show up on any device you sign in on.' : 'Saved in this browser.';
    d.innerHTML = `<div class="dlg ar-dlg"><h3>Areas of operation</h3>
      <div class="ar-list">${rows || '<div class="muted small">No saved areas yet. Add the airports you have entered above, or a blank one.</div>'}</div>
      <div style="display:flex;gap:8px;flex-wrap:wrap"><button class="btn sm" id="arAddCur">Add current airports</button><button class="btn sm" id="arAddBlank">Add blank</button>
        <button class="btn sm" id="arNoDefault" ${draft.some((a) => a.default) ? '' : 'disabled'}>No default</button></div>
      <div class="lk-err" id="arErr"></div>
      <p class="muted small">${where} Airports are 3–4 letter IDs separated by spaces, up to 12 per area. <b>Route</b> checks a corridor between them in order. The <b>Default</b> area is briefed when you open wxboard.</p>
      <div style="display:flex;gap:8px;justify-content:flex-end"><button class="btn" id="arCancel">Cancel</button><button class="btn primary" id="arSave">Save changes</button></div></div>`;
    d.classList.add('on');
    const rowOf = (el) => Number(el.closest('.ar-row').dataset.i);
    d.querySelectorAll('.ar-row input').forEach((inp) => inp.addEventListener(inp.type === 'checkbox' || inp.type === 'radio' ? 'change' : 'input', () => {
      const a = draft[rowOf(inp)], f = inp.dataset.f;
      if (f === 'route') a.route = inp.checked;
      else if (f === 'default') draft.forEach((x, j) => { x.default = j === rowOf(inp); });
      else if (f === 'radius') a.radius = Number(inp.value);
      else a[f] = f === 'ids' ? inp.value.toUpperCase() : inp.value;
    }));
    d.querySelectorAll('[data-armove]').forEach((b) => (b.onclick = () => {
      const i = rowOf(b), j = i + Number(b.dataset.armove);
      if (j < 0 || j >= draft.length) return;
      [draft[i], draft[j]] = [draft[j], draft[i]]; openAreasDialog(draft);
    }));
    d.querySelectorAll('[data-ardel]').forEach((b) => (b.onclick = () => { draft.splice(rowOf(b), 1); openAreasDialog(draft); }));
    d.querySelector('#arAddCur').onclick = () => {
      const f = readForm();
      draft.push({ label: f.ids ? f.ids.split(/\s+/).slice(0, 3).join(' ') : 'New area', ids: f.ids, radius: f.radius, route: f.route });
      openAreasDialog(draft);
    };
    d.querySelector('#arAddBlank').onclick = () => { draft.push({ label: '', ids: '', radius: status.defaultRadiusNm || 30, route: false }); openAreasDialog(draft); };
    d.querySelector('#arNoDefault').onclick = () => { draft.forEach((x) => { x.default = false; }); openAreasDialog(draft); };
    d.querySelector('#arCancel').onclick = () => d.classList.remove('on');
    d.onclick = (e) => { if (e.target === d) d.classList.remove('on'); };
    d.querySelector('#arSave').onclick = async () => {
      const btn = d.querySelector('#arSave');
      btn.disabled = true;
      const list = draft.map((a) => ({ label: String(a.label || '').trim(), ids: String(a.ids || '').trim().toUpperCase(), radius: Number(a.radius) || 30, route: Boolean(a.route), default: Boolean(a.default) }));
      const blank = list.findIndex((a) => !a.label || !a.ids);
      const err = blank >= 0 ? `Area ${blank + 1} needs a name and at least one airport.` : await saveAreas(list);
      btn.disabled = false;
      if (err) { d.querySelector('#arErr').textContent = err; return; }
      d.classList.remove('on');
    };
  }

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
    // Remembered per browser, so opening wxboard again brings back the last brief.
    try { localStorage.setItem(LAST_KEY, JSON.stringify({ ids: area.ids, radius: area.radius, route: Boolean(area.route) })); } catch {}
    const qs = new URLSearchParams({ ids: area.ids, radius: area.radius, route: area.route ? '1' : '0' });
    history.replaceState(null, '', '?' + qs);
    if (!quiet) { $('#updated').innerHTML = '<span class="spin"></span> loading'; showLoader(area); }
    else $('#updated').innerHTML = '<span class="spin"></span> refreshing';
    try {
      const res = await fetch('/api/brief?' + qs, { signal: ctrl.signal });
      if (res.status === 401) { location.href = '/login?next=' + encodeURIComponent(location.pathname + location.search); return; }
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
  const MN = window.Minimums, SUN = window.Sun, TR = window.Terrain;
  const MINS_KEY = 'wxboard.mins.v1';
  let mins = (() => {
    try {
      const v = JSON.parse(localStorage.getItem(MINS_KEY));
      if (v) {
        const m = { ...MN.DEFAULTS, ...v, bands: { ...MN.DEFAULTS.bands, ...(v.bands || {}) } };
        // Terrain used to be a single fixed choice (default Non-mountainous). Switch everyone to automatic once;
        // a fixed choice made after that is kept.
        if (!v.terrainAuto) m.terrain = 'auto';
        return m;
      }
    } catch {}
    return JSON.parse(JSON.stringify(MN.DEFAULTS));
  })();
  const saveMins = () => { mins.terrainAuto = 1; try { localStorage.setItem(MINS_KEY, JSON.stringify(mins)); } catch {} };
  const phaseAt = (ms, lat, lon) => (lat == null || !SUN ? 'day' : SUN.isNight(ms, lat, lon) ? 'night' : 'day');
  // 14 CFR Part 95 answer for a place (cached; positions repeat a lot).
  const terrCache = new Map();
  function partNinetyFive(lat, lon) {
    if (!TR || lat == null || lon == null) return null;
    const k = `${(+lat).toFixed(3)},${(+lon).toFixed(3)}`;
    if (!terrCache.has(k)) terrCache.set(k, TR.classify(lat, lon));
    return terrCache.get(k);
  }
  // Which 135.609 row to use at a place: automatic from Part 95, or the fixed choice in Minimums.
  function terrainFor(lat, lon) {
    const info = partNinetyFive(lat, lon);
    if (mins.terrain === 'mtn' || mins.terrain === 'non') return { terrain: mins.terrain, fixed: true, info };
    return { terrain: info && info.mtn ? 'mtn' : 'non', fixed: false, info };
  }
  function terrainNote(tf) {
    if (!tf) return '';
    if (!tf.fixed) return `Terrain (automatic): ${TR ? TR.describe(tf.info) : 'unknown'}`;
    const set = `Terrain is set to always use ${tf.terrain === 'mtn' ? 'Mountainous' : 'Non-mountainous'} in Minimums.`;
    return tf.info && tf.info.mtn != null && tf.info.mtn !== (tf.terrain === 'mtn') ? `${set} 14 CFR Part 95 says otherwise here: ${TR.describe(tf.info)}` : set;
  }
  // Part 91: surface airspace class at a place, from the brief (the server tags every airport, station and TAF site).
  const posKey = (lat, lon) => `${(+lat).toFixed(3)},${(+lon).toFixed(3)}`;
  let asIndex = { brief: null, map: new Map() };
  function airspaceAt(lat, lon, ms) {
    if (lat == null || lon == null || !lastBrief) return null;
    if (asIndex.brief !== lastBrief) {
      const map = new Map(), b = lastBrief;
      const add = (x) => { if (x && x.lat != null && x.airspace !== undefined) map.set(posKey(x.lat, x.lon), x.airspace); };
      ((b.area && b.area.anchors) || []).forEach(add);
      if (b.metars && b.metars.ok) b.metars.data.forEach(add);
      if (b.tafs && b.tafs.ok) b.tafs.data.forEach(add);
      asIndex = { brief: b, map };
    }
    const a = asIndex.map.get(posKey(lat, lon)) ?? null;
    return ms == null ? a : effectiveAirspace(a, ms);
  }
  // Part-time surface areas: which class is in effect at `ms`, from the FAA's published hours (public/airspace-hours.js).
  const AH = window.AirspaceHours, parsedSched = new Map();
  function effectiveAirspace(a, ms) {
    if (!a || !a.sched || !AH) return a;
    if (!parsedSched.has(a.sched)) parsedSched.set(a.sched, AH.parse(a.sched));
    const p = parsedSched.get(a.sched), r = AH.classAt(p, ms, a.tz);
    return { ...a, cls: r.cls || a.cls, partTime: r.inEffect == null ? a.partTime : false, inEffect: r.inEffect, why: r.why, parsed: p, base: a };
  }
  // When does the class next change (within 36 h)? → { at, cls } or null
  function nextAirspaceChange(a, from) {
    if (!a || !a.sched || !AH) return null;
    const now = effectiveAirspace(a, from);
    if (now.inEffect == null) return null;
    for (let t = Math.ceil(from / 300e3) * 300e3; t < from + 36 * 3600e3; t += 300e3) {
      const e = effectiveAirspace(a, t);
      if (e.cls !== now.cls) return { at: t, cls: e.cls };
    }
    return null;
  }
  const AS_NAME = { B: 'Class B', C: 'Class C', D: 'Class D', E: 'Class E', G: 'Class G' };
  function airspaceNote(a) {
    if (a && a.sched) {
      const p = a.parsed || (AH ? AH.parse(a.sched) : null);
      const now = a.inEffect == null
        ? `wxboard can't tell from these hours whether it is in effect, so the ${AS_NAME[a.cls] || a.cls} minimums are used (the more restrictive).`
        : a.inEffect ? `In effect at this time: ${AS_NAME[a.cls]}.` : `Not in effect at this time, so the surface is ${AS_NAME[a.cls]}.`;
      const nt = a.notams && a.notams.length ? ` ${a.notams.length} NOTAM${a.notams.length > 1 ? 's' : ''} at ${a.ident} mention the tower or airspace and can change these hours: "${a.notams[0].text.slice(0, 160)}${a.notams[0].text.length > 160 ? '…' : ''}"` : '';
      return `${a.name || 'Surface area'} (${a.ident}). Published hours (FAA NASR): ${p && p.kind !== 'unparsed' ? AH.describe(p) : a.sched}${a.tz ? ` (${a.tz})` : ''}. ${now}${nt}`;
    }
    if (!a) return 'Surface airspace unknown (the FAA airspace lookup failed or this place wasn\'t in it), so the surface-area minimums (1,000 ft / 3 SM) are used.';
    if (a.cls === 'G') return 'Class G at the surface (no Class B/C/D/E surface area here, per FAA airspace data).';
    return `${a.name || AS_NAME[a.cls] + ' surface area'}${a.partTime ? '. Part-time: the FAA data says its hours are set by NOTAM or a schedule, and wxboard can\'t tell whether it is in effect now, so the surface-area minimums are used. When it is not in effect the surface airspace may be Class E or G.' : '.'}`;
  }
  // The limits that apply at a place and phase, for the chosen rule set.
  function limitsAt(phase, lat, lon, ms = Date.now()) {
    if (mins.rules === '91') { const a = airspaceAt(lat, lon, ms); return { lim: MN.limits91(phase, a, mins), place: { kind: 'airspace', airspace: a } }; }
    const terr = terrainFor(lat, lon);
    return { lim: MN.limitsFor(phase, mins, terr.terrain), place: { kind: 'terrain', terr } };
  }
  const placeNote = (p) => (!p ? '' : p.kind === 'airspace' ? airspaceNote(p.airspace) : terrainNote(p.terr));
  // Risk for a ceiling/visibility at a time and place. Returns null when minimums are turned off.
  function riskAt(ceilFt, visSM, ms, lat, lon) {
    if (!mins.enabled || !MN) return null;
    const phase = phaseAt(ms, lat, lon), { lim, place } = limitsAt(phase, lat, lon, ms);
    return { ...MN.assess(ceilFt, visSM, lim, mins.bands), phase, lim, place };
  }
  // A TAF period can span day and night: judge it against every phase it touches and keep the worst.
  function riskForPeriod(ceilFt, visSM, from, to, lat, lon) {
    if (!mins.enabled || !MN) return null;
    // Judge at the start, middle and end (and hourly in between for long periods): day/night and part-time airspace can change.
    const times = [from, (from + to) / 2, to - 60e3];
    for (let t = from + 3600e3; t < to - 60e3; t += 3600e3) times.push(t);
    const seen = new Set(), rs = [];
    for (const t of times) {
      const ph = phaseAt(t, lat, lon), { lim, place } = limitsAt(ph, lat, lon, t);
      const k = `${ph}|${lim.ceil}|${lim.vis}|${lim.label}`;
      if (seen.has(k)) continue; seen.add(k);
      rs.push({ ...MN.assess(ceilFt, visSM, lim, mins.bands), phase: ph, lim, place });
    }
    return rs.reduce((w, r) => (MN.LEVELS.indexOf(r.level) > MN.LEVELS.indexOf(w.level) ? r : w), rs[0]);
  }
  // ---------- regulation citations, with the server's daily eCFR check ----------
  const BAD_REG = ['amended', 'removed', 'text-changed'];
  const regItem = (sec) => { const r = lastBrief && lastBrief.regs; return r && r.items ? r.items.find((i) => i.section === sec) : null; };
  function regState(sec) {
    const it = regItem(sec), r = lastBrief && lastBrief.regs;
    if (!it || it.status === 'unchecked' || it.status === 'unknown') return { bad: false, text: 'not yet checked against eCFR on this server' };
    if (BAD_REG.includes(it.status)) {
      const what = it.status === 'amended' ? `amended ${it.latest}` : it.status === 'removed' ? 'removed or reserved' : 'reworded';
      return { bad: true, text: `CHANGED: eCFR shows this section ${what}, after wxboard was checked against it (${r.verified}). Check the current regulation before relying on these colors.` };
    }
    return { bad: false, text: `checked current on eCFR ${r.checkedAt ? zt(Date.parse(r.checkedAt)).replace(/Z$/, 'Z') : ''}`.trim() };
  }
  // [[section, cite-text, what]] → one hover paragraph, e.g. "Rules: 14 CFR 91.155(c), (d) (surface area) — checked current…"
  function citeText(list) {
    const parts = list.map(([sec, cite, what]) => { const st = regState(sec); return `14 CFR ${cite}${what ? ` (${what})` : ''}${st.bad ? ` ⚠ ${st.text}` : ''}`; });
    const ok = list.every(([sec]) => !regState(sec).bad);
    const tail = ok && list.length ? ` — ${regState(list[0][0]).text}.` : '';
    return `Rules: ${parts.join('; ')}${tail}`;
  }
  function limCites(r) {
    const out = [];
    if (r.lim.rule === '91') {
      out.push(['91.155', r.lim.ref, r.lim.cls === 'G' ? 'Class G table' : 'surface area: 1,000 ft ceiling, 3 SM']);
      if (r.level === 'red' && r.lim.cls !== 'G') out.push(['91.157', '91.157', 'Special VFR']);
    } else {
      out.push(['135.609', '135.609(a)', 'HAA table']);
      const t = r.place && r.place.terr;
      if (t && !t.fixed && t.info && t.info.section) out.push([t.info.section, t.info.section, `${t.info.area} mountainous area`]);
      else if (t && !t.fixed) out.push(['95.11', '95 Subpart B', 'not in a mountainous area']);
    }
    if (r.phase === 'night') out.push(['1.1', '1.1', 'night']);
    return citeText(out);
  }
  const limText = (lim) => `${lim.noCeil ? 'no ceiling minimum' : lim.ceil.toLocaleString() + ' ft'} / ${lim.vis} SM`;
  function svfrNote(lim) {
    if (lim.rule !== '91' || lim.cls === 'G') return '';
    return mins.aircraft === 'plane'
      ? ' Below basic VFR in a surface area: Special VFR (91.157) needs an ATC clearance, clear of clouds and 1 SM; at night only with an instrument rating and an IFR-equipped aircraft.'
      : ' Below basic VFR in a surface area: Special VFR (91.157) needs an ATC clearance; a helicopter needs only to stay clear of clouds (no visibility minimum), day or night.';
  }
  function riskBadge(r) {
    if (!r) return '';
    const tip = `${r.lim.label}: ${limText(r.lim)}${r.reasons.length ? ' — ' + r.reasons.join('; ') : ''}${r.partial ? ' (visibility unknown)' : ''}.${r.level === 'red' ? svfrNote(r.lim) : ''} ${placeNote(r.place)}`;
    const cites = limCites(r), bad = cites.includes('⚠');
    const html = `${esc(tip)}<br><br><span class="${bad ? 'reg-bad' : 'reg-ok'}">${esc(cites)}</span>`;
    return `<span class="risk risk-${r.level}${bad ? ' reg-flag' : ''}" data-info="${encodeURIComponent(html)}" tabindex="0">${r.label}${r.partial ? '*' : ''}${bad ? ' ⚠' : ''}</span>`;
  }
  // Small tag on an airport card: MTN when the mountainous row is used, a warning near a Part 95 line or when a fixed
  // terrain setting disagrees with Part 95.
  function terrainTag(lat, lon) {
    if (!mins.enabled) return '';
    if (mins.rules === '91') {
      const now = Date.now(), a = airspaceAt(lat, lon, now);
      if (!a) return ` <span class="tag warn" ${popAttr(airspaceNote(a))}>Airspace?</span>`;
      const nx = nextAirspaceChange(a.base || a, now);
      const notam = a.notams && a.notams.length ? ` <span class="tag warn" ${popAttr(airspaceNote(a))}>NOTAM</span>` : '';
      return ` <span class="tag ${a.partTime ? 'warn' : a.cls === 'G' ? '' : 'blue'}" ${popAttr(airspaceNote(a))}>${a.cls}${a.partTime ? ' PT' : ''}</span>${nx ? ` <span class="muted small" style="white-space:nowrap" ${popAttr(`Changes to ${AS_NAME[nx.cls]} at ${hhL(nx.at)} your local time (${zt(nx.at)}), from the published hours.`)}>→${nx.cls} ${hhL(nx.at)}</span>` : ''}${notam}`;
    }
    const tf = terrainFor(lat, lon), i = tf.info;
    const near = i && i.edgeNm != null && i.edgeNm < 10;
    if (tf.fixed && i && i.mtn != null && i.mtn !== (tf.terrain === 'mtn'))
      return ` <span class="tag warn" ${popAttr(terrainNote(tf))}>${tf.terrain === 'mtn' ? 'MTN' : 'NON-MTN'} (set)</span>`;
    if (tf.terrain === 'mtn') return ` <span class="tag ${near ? 'warn' : 'blue'}" ${popAttr(terrainNote(tf))}>MTN${near ? ' · edge' : ''}</span>`;
    if (near) return ` <span class="tag warn" ${popAttr(terrainNote(tf))}>MTN edge</span>`;
    return '';
  }
  // Next sun events (sunrise/sunset/civil twilight) in the next 24 h, local time.
  function sunLine(lat, lon) {
    if (!SUN || lat == null) return '';
    const t = Date.now();
    const ev = SUN.events(t, t + 24 * 3600e3, lat, lon).slice(0, 2);
    const names = { sunrise: 'sunrise', sunset: 'sunset', dawn: 'night ends', dusk: 'night begins' };
    return ev.map((e) => `${names[e.type]} ${lt(e.at)}`).join(' · ');
  }

  // Route mode: does the straight line between airports pass through a designated mountainous area? (checked every ~5 nm)
  function routeTerrain(anchors) {
    const legs = [];
    for (let i = 1; i < anchors.length; i++) {
      const a = anchors[i - 1], b = anchors[i];
      if (a.lat == null || b.lat == null) continue;
      const nm = Math.hypot((b.lat - a.lat) * 60, (b.lon - a.lon) * 60 * Math.cos((a.lat * Math.PI) / 180));
      const n = Math.max(2, Math.ceil(nm / 5));
      let mtn = 0;
      for (let k = 0; k <= n; k++) { const c = partNinetyFive(a.lat + ((b.lat - a.lat) * k) / n, a.lon + ((b.lon - a.lon) * k) / n); if (c && c.mtn) mtn++; }
      legs.push({ from: a.id, to: b.id, mtn, of: n + 1 });
    }
    return legs;
  }

  // ---------- Minimums dialog ----------
  // Sections fold; which are open (and the Now / Day / Night view) is remembered per browser.
  const MINS_UI_KEY = 'wxboard.minsDlg.v1';
  let minsUi = (() => { try { return { brief: true, setup: true, bands: true, table: false, show: 'now', ...JSON.parse(localStorage.getItem(MINS_UI_KEY) || '{}') }; } catch { return { brief: true, setup: true, bands: true, table: false, show: 'now' }; } })();
  const saveMinsUi = () => { try { localStorage.setItem(MINS_UI_KEY, JSON.stringify(minsUi)); } catch {} };
  const fmtFt = (n) => `${Number(n).toLocaleString()} ft`;
  const fmtSm = (n) => `${+Number(n).toFixed(2)} SM`;

  function openMinsDialog() {
    let d = document.getElementById('minsDlg');
    if (!d) { d = document.createElement('div'); d.id = 'minsDlg'; document.body.appendChild(d); }
    const keepScroll = d.querySelector('.dlg') ? d.querySelector('.dlg').scrollTop : 0;
    const B = mins.bands, p91 = mins.rules === '91';
    const seg = (name, opts, val = mins[name]) => `<div class="seg" role="group">${opts.map(([v, label, tip]) =>
      `<button type="button" class="seg-b${val === v ? ' on' : ''}" data-seg="${name}" data-val="${v}" aria-pressed="${val === v}" ${tip ? popAttr(tip) : ''}>${label}</button>`).join('')}</div>`;
    const sec = (id, title, sum, body) => `<details class="mins-sec" data-sec="${id}" ${minsUi[id] ? 'open' : ''}>
      <summary><span class="ms-t">${title}</span><span class="ms-sum">${sum}</span></summary><div class="ms-body">${body}</div></details>`;
    const ceilTxt = (lim, v) => (lim.noCeil && v === lim.ceil ? 'none' : fmtFt(v));
    const anchors = (lastBrief && lastBrief.area && lastBrief.area.anchors) || [];

    // --- Color bands, drawn as a ladder for one example limit ---
    const ex0 = anchors[0];
    const exLim = ex0 ? limitsAt(phaseAt(Date.now(), ex0.lat, ex0.lon), ex0.lat, ex0.lon, Date.now()).lim
      : p91 ? MN.limits91('day', null, mins) : MN.limitsFor('day', mins, mins.terrain === 'mtn' ? 'mtn' : 'non');
    const th = MN.thresholds(exLim, B);
    const ladder = (kind, t, fmt, critKey, amberKey, unit, step, noLimit) => {
      const segs = [
        ['red', 'Red', `below ${fmt(t.red)}`, !noLimit],
        ['critical', 'Amber Crit', noLimit ? `below ${fmt(t.crit)}` : `${fmt(t.red)} to ${fmt(t.crit)}`, B[critKey] > 0],
        ['amber', 'Amber', `${fmt(Math.max(t.crit, t.red))} to ${fmt(t.amber)}`, B[amberKey] > B[critKey]],
        ['green', 'Green', `${fmt(Math.max(t.amber, t.crit))} and up`, true],
      ].filter((x) => x[3]);
      return `<div class="ladder">
        <div class="lad-hd"><b>${kind}</b> <span class="muted small">${noLimit ? 'no ceiling minimum in this example' : `example limit ${fmt(t.red)}`}</span></div>
        <div class="lad-bar">${segs.map(([c, l, range]) => `<span class="lad-seg risk-${c}"><b>${l}</b><small>${range}</small></span>`).join('')}</div>
        <div class="lad-in">
          <label>Amber Critical when within <input type="number" min="0" step="${step}" data-band="${critKey}" value="${B[critKey]}"> ${unit} of the limit</label>
          <label>Amber when within <input type="number" min="0" step="${step}" data-band="${amberKey}" value="${B[amberKey]}"> ${unit} of the limit</label>
        </div></div>`;
    };
    const probs = MN.bandProblems(B);
    const bandsBody = `<p class="muted small" style="margin:0">Each margin is added on top of the limit for that airport and time. The worse of ceiling and visibility sets the color. Example: ${esc(exLim.label)}${ex0 ? ` at ${esc(ex0.id)} now` : ''}.${p91 ? ' In Class G there is no ceiling minimum, so a low ceiling there turns Amber or Amber Critical but never Red.' : ''}</p>
      <div class="ladders">${ladder('Ceiling', th.ceil, fmtFt, 'critCeil', 'amberCeil', 'ft', 50, exLim.noCeil)}${ladder('Visibility', th.vis, fmtSm, 'critVis', 'amberVis', 'SM', 0.5, false)}</div>
      ${probs.length ? `<div class="mins-warn small">${probs.map(esc).join('<br>')}</div>` : ''}`;
    const bandsSum = `Amber ${B.amberCeil} ft / ${B.amberVis} SM · Crit ${B.critCeil} ft / ${B.critVis} SM`;

    // --- Which minimums: the rule set, then its own choices ---
    const rulesSeg = `<div class="ms-field"><div class="lbl">Minimums ${infoTip('<b>Part 135 HAA</b>: the 14 CFR 135.609(a) table (day / night / night NVIS-HTAWS; mountainous or not; local or cross-country).<br><br><b>Part 91 VFR</b>: the basic VFR minimums of 14 CFR 91.155 for the airspace at each airport\'s surface: 1,000 ft and 3 SM inside a Class B, C, D or E surface area, and the Class G visibility for your aircraft elsewhere. The surface airspace comes from the FAA\'s airspace data.')}</div>
        ${seg('rules', [['135', 'Part 135 HAA (135.609)'], ['91', 'Part 91 VFR (91.155)']])}</div>`;
    let setupBody, setupSum;
    if (p91) {
      setupBody = rulesSeg + `
        <div class="ms-field"><div class="lbl">Aircraft ${infoTip('91.155 has different Class G minimums for helicopters, and 91.157 (Special VFR) treats helicopters differently.')}</div>
          ${seg('aircraft', [['heli', 'Helicopter'], ['plane', 'Airplane']])}</div>
        <p class="muted small" style="margin:0">Each airport is checked against the airspace at its surface: inside a Class B, C, D or E surface area you need a 1,000 ft ceiling and 3 SM (91.155(c), (d)); in Class G below 1,200 ft AGL, ${mins.aircraft === 'plane' ? '1 SM clear of clouds by day and 3 SM at night' : '½ SM by day and 1 SM at night, clear of clouds'}. Part-time surface areas (a part-time tower, an E2 by NOTAM) are treated as in effect and flagged.</p>`;
      setupSum = `Part 91 VFR · ${mins.aircraft === 'plane' ? 'Airplane' : 'Helicopter'}`;
    } else {
      setupBody = rulesSeg + `
        <div class="ms-field"><div class="lbl">Terrain ${infoTip('<b>Automatic</b> uses each airport\'s position and the designated mountainous areas in 14 CFR Part 95 Subpart B (Eastern US, Western US, Alaska, Hawaii, Puerto Rico, minus their exception areas). Airports within 10 nm of a boundary are flagged, because nearby terrain may be the other kind. The border and coastline legs of those areas are approximated.<br><br>Pick a fixed choice only if your operator tells you to.')}</div>
          ${seg('terrain', [['auto', 'Automatic (14 CFR 95)'], ['non', 'Always non-mountainous'], ['mtn', 'Always mountainous']])}</div>
        <div class="ms-field"><div class="lbl">Flying area ${infoTip('135.609(a) has separate rows for flights inside a <b>local flying area</b> (as your operator defines it) and for cross-country (non-local) flights.')}</div>
          ${seg('area', [['xc', 'Cross-country (non-local)'], ['local', 'Local flying area']])}</div>
        <div class="ms-field"><div class="lbl">At night ${infoTip('NVG uses the 135.609(a) column for night with NVIS or HTAWS. Night is from the end of evening civil twilight to the start of morning civil twilight (14 CFR 1.1), worked out per airport.')}</div>
          ${seg('nightMode', [['nvg', 'NVG (aided)'], ['unaided', 'Unaided']])}</div>`;
      const terrainName = { auto: 'Terrain automatic', non: 'Always non-mountainous', mtn: 'Always mountainous' }[mins.terrain] || 'Terrain automatic';
      setupSum = `Part 135 HAA · ${terrainName} · ${mins.area === 'local' ? 'Local' : 'Cross-country'} · Night ${mins.nightMode === 'unaided' ? 'unaided' : 'NVG'}`;
    }

    // --- This brief: each airport's terrain or airspace, current limits and where the colors change ---
    let briefBody, briefSum;
    if (!anchors.length) {
      briefBody = '<p class="muted small">Brief an area to see the limits for each airport here.</p>';
      briefSum = 'no brief yet';
    } else {
      const now = Date.now();
      const rows = anchors.map((a) => {
        const ph = minsUi.show === 'day' || minsUi.show === 'night' ? minsUi.show : phaseAt(now, a.lat, a.lon);
        const { lim, place } = limitsAt(ph, a.lat, a.lon, now), t = MN.thresholds(lim, B);
        let pcell;
        if (place.kind === 'airspace') {
          const as = place.airspace;
          pcell = `<span class="tag ${!as || as.partTime ? 'warn' : as.cls === 'G' ? '' : 'blue'}" ${popAttr(airspaceNote(as))}>${as ? AS_NAME[as.cls] || as.cls : 'Unknown'}${as && as.partTime ? ' · part-time' : ''}</span>`;
        } else {
          const tf = place.terr;
          pcell = `<span class="tag ${tf.terrain === 'mtn' ? 'blue' : ''}" ${popAttr(terrainNote(tf))}>${tf.terrain === 'mtn' ? 'Mountainous' : 'Non-mtn'}${tf.fixed ? ' (set)' : ''}</span>${tf.info && tf.info.edgeNm != null && tf.info.edgeNm < 10 ? ` <span class="tag warn" ${popAttr(TR.describe(tf.info))}>edge ${Math.round(tf.info.edgeNm)} nm</span>` : ''}`;
        }
        const pair = (c, v) => `<span class="mono">${ceilTxt(lim, c)}</span><br><span class="mono">${fmtSm(v)}</span>`;
        return `<tr><td><b>${esc(a.id)}</b>${minsUi.show === 'now' ? `<div class="muted small">${ph === 'night' ? 'Night now' : 'Day now'}</div>` : ''}</td><td>${pcell}</td>
          <td class="mb-red">${pair(t.ceil.red, t.vis.red)}</td>
          <td class="mb-crit">${B.critCeil || B.critVis ? pair(t.ceil.crit, t.vis.crit) : '—'}</td>
          <td class="mb-amber">${pair(t.ceil.amber, t.vis.amber)}</td></tr>`;
      }).join('');
      let note = '';
      if (!p91 && current && current.route && anchors.length > 1) {
        const legs = routeTerrain(anchors).filter((l) => l.mtn > 0);
        if (legs.length) note = `<p class="small mins-note">Route legs that pass through a designated mountainous area: ${legs.map((l) => `<b>${esc(l.from)}–${esc(l.to)}</b>${l.mtn === l.of ? ' (all of it)' : ' (part)'}`).join(', ')}. The checks above use each airport's own terrain; the 135.609 row for the en-route part is your call.</p>`;
      }
      if (p91 && lastBrief.airspace && !lastBrief.airspace.ok) note = `<p class="small mins-warn">The FAA airspace lookup failed for ${lastBrief.airspace.failed || 'some'} of ${lastBrief.airspace.asked || '?'} places (${esc(lastBrief.airspace.error || 'no answer')}). Those use the surface-area minimums until the next refresh.</p>`;
      if (p91) {
        const nSfc = anchors.filter((a) => { const as = airspaceAt(a.lat, a.lon); return !as || as.cls !== 'G'; }).length;
        briefSum = `${anchors.length} airport${anchors.length > 1 ? 's' : ''} · ${nSfc} in a surface area · ${anchors.length - nSfc} Class G`;
      } else {
        const nMtn = anchors.filter((a) => terrainFor(a.lat, a.lon).terrain === 'mtn').length;
        briefSum = `${anchors.length} airport${anchors.length > 1 ? 's' : ''} · ${nMtn ? `${nMtn} mountainous` : 'all non-mountainous'}`;
      }
      briefBody = `<div class="ms-row"><span class="muted small">Show limits for</span>${seg('show', [['now', 'Now'], ['day', 'Day'], ['night', 'Night']], minsUi.show)}</div>
        <table class="mins-brief small"><thead><tr><th>Airport</th><th>${p91 ? 'Surface airspace' : 'Terrain'}</th>
          <th ${popAttr(p91 ? 'The 91.155 limit. Below it is Red (in a surface area, Special VFR is the only way to fly). Class G has no ceiling minimum.' : 'The 14 CFR 135.609(a) limit. Below it is Red.')}>Limit<br><span class="muted">Red below</span></th>
          <th ${popAttr('From the limit up to this value is Amber Critical.')}>Amber Crit<br><span class="muted">below</span></th>
          <th ${popAttr('From Amber Critical up to this value is Amber. At or above it (ceiling and visibility both) is Green.')}>Amber below<br><span class="muted">Green at/above</span></th></tr></thead>
        <tbody>${rows}</tbody></table>${note}`;
    }

    // --- The regulation table, with the cells in use marked ---
    let tableTitle, tableBody;
    if (p91) {
      const heli = mins.aircraft !== 'plane';
      const r91 = (on, where, day, night) => `<tr class="${on ? 'use' : ''}"><td>${where}</td><td class="mono${on ? ' on' : ''}">${day}</td><td class="mono${on ? ' on' : ''}">${night}</td></tr>`;
      tableTitle = '14 CFR 91.155 / 91.157 (what wxboard checks)';
      tableBody = `<table class="small mins-reg"><thead><tr><th></th><th>Day</th><th>Night</th></tr></thead><tbody>
        ${r91(true, 'Class B, C, D or E surface area (91.155(c), (d))', '1,000 ft – 3 SM', '1,000 ft – 3 SM')}
        ${r91(heli, 'Class G ≤1,200 ft AGL, helicopter (91.155(a))', 'clear of clouds – ½ SM', 'clear of clouds – 1 SM')}
        ${r91(!heli, 'Class G ≤1,200 ft AGL, airplane (91.155(a))', 'clear of clouds – 1 SM', '500 below / 1,000 above / 2,000 horiz – 3 SM')}
        ${r91(false, 'Special VFR in a surface area (91.157), with ATC clearance', heli ? 'clear of clouds – no vis min (helicopter)' : 'clear of clouds – 1 SM', heli ? 'same (helicopter)' : 'only IFR-rated pilot + IFR-equipped')}
        </tbody></table>
        <p class="muted small" style="margin:6px 0 0">Highlighted: the rows wxboard uses for your aircraft. Not covered: cloud clearances above 1,200 ft AGL or 10,000 ft MSL, the Class G traffic-pattern allowances in 91.155(b), and company minimums. Special VFR is shown for reference only; the colors use basic VFR.</p>`;
    } else {
      const T = MN.HAA_135_609;
      const usedRows = mins.terrain === 'auto' ? ['non', 'mtn'] : [mins.terrain];
      const nightCol = mins.nightMode === 'unaided' ? 'night' : 'nvg';
      const tRow = (k, title) => {
        const rowOn = usedRows.some((t) => `${t}-${mins.area === 'local' ? 'local' : 'xc'}` === k);
        return `<tr class="${rowOn ? 'use' : ''}"><td>${title}</td>${['day', 'night', 'nvg'].map((c) => `<td class="mono${rowOn && (c === 'day' || c === nightCol) ? ' on' : ''}">${T[k][c][0].toLocaleString()} ft – ${T[k][c][1]} SM</td>`).join('')}</tr>`;
      };
      tableTitle = '14 CFR 135.609(a) table';
      tableBody = `<table class="small mins-reg"><thead><tr><th></th><th>Day</th><th>Night</th><th>Night NVIS/HTAWS</th></tr></thead><tbody>
        ${tRow('non-local', 'Non-mountainous local')}${tRow('non-xc', 'Non-mountainous non-local')}${tRow('mtn-local', 'Mountainous local')}${tRow('mtn-xc', 'Mountainous non-local')}</tbody></table>
        <p class="muted small" style="margin:6px 0 0">Highlighted: the cells your settings use. Company (GOM) minimums aren't built in; set the bands to match your operator's procedures.</p>`;
    }

    // Regulation check: what the server found on eCFR for every section the minimums rely on.
    const R = lastBrief && lastBrief.regs;
    const regBad = R ? (R.changed || []).length : 0;
    const regList = !R ? '<p class="muted small" style="margin:6px 0 0">Brief an area to see the regulation check.</p>'
      : `<div class="lbl" style="margin-top:8px">Regulation check ${infoTip(`The server asks eCFR once a day whether each section below has been amended, removed or reworded since wxboard's minimums were checked against it (${esc(R.verified)}). A change turns on a red chip in the alert strip and a ⚠ on every minimums badge that relies on it.`)}</div>
        <div class="reg-list">${R.items.map((i) => {
          const bad = BAD_REG.includes(i.status);
          const st = bad ? (i.status === 'amended' ? `CHANGED: amended ${i.latest}` : i.status === 'removed' ? 'CHANGED: removed' : 'CHANGED: reworded')
            : i.status === 'current' ? `current${i.latest ? ` · last amended ${i.latest}` : ''}` : 'not checked yet';
          return `<div class="rl"><span class="mono">14 CFR ${esc(i.section)}</span><span class="muted">${esc(i.uses || '')}</span><b class="${bad ? 'bad' : i.status === 'current' ? 'ok' : ''}">${esc(st)}</b></div>`;
        }).join('')}</div>
        <p class="muted small" style="margin:4px 0 0">${R.checkedAt ? `Last check ${esc(zt(Date.parse(R.checkedAt)))}` : 'The first check runs about 20 seconds after the server starts.'}${R.overdue ? ' · <span class="stale">eCFR not reached for 7+ days</span>' : ''}</p>`;

    d.innerHTML = `<div class="dlg mins-dlg">
      <div class="mins-top"><h3>Weather minimums</h3>
        <label class="switch"><input type="checkbox" id="mEnabled" ${mins.enabled ? 'checked' : ''}><span></span> Check conditions against minimums</label></div>
      ${mins.enabled ? '' : '<p class="muted small" style="margin:0">Off: cards, TAF rows, the trend and the shift outlook are colored by flight category only.</p>'}
      ${sec('bands', 'Color bands', bandsSum, bandsBody)}
      ${sec('setup', 'Which minimums', setupSum, setupBody)}
      ${sec('brief', 'This brief', briefSum, briefBody)}
      ${sec('table', tableTitle, `${p91 ? 'basic VFR' : 'ceiling – visibility'} · ${!R ? '' : regBad ? `<span class="stale">${regBad} regulation${regBad > 1 ? 's' : ''} changed</span>` : 'regulations checked'}`, tableBody + regList)}
      <p class="muted small" style="margin:0">A reading aid, not a flight release. The PIC and the operator make that call. Saved in this browser.</p>
      <div style="display:flex;gap:8px;justify-content:flex-end"><button class="btn" id="mReset">Reset to defaults</button><button class="btn primary" id="mClose">Done</button></div></div>`;
    d.classList.add('on');
    d.querySelector('.dlg').scrollTop = keepScroll;
    const apply = () => { saveMins(); if (lastBrief) render(lastBrief); openMinsDialog(); };
    d.querySelector('#mEnabled').onchange = (e) => { mins.enabled = e.target.checked; apply(); };
    d.querySelectorAll('[data-seg]').forEach((b) => (b.onclick = () => {
      if (b.dataset.seg === 'show') { minsUi.show = b.dataset.val; saveMinsUi(); openMinsDialog(); return; }
      mins[b.dataset.seg] = b.dataset.val; apply();
    }));
    d.querySelectorAll('input[data-band]').forEach((i) => (i.onchange = () => {
      const v = Number(i.value);
      if (Number.isFinite(v) && v >= 0) { mins.bands[i.dataset.band] = v; apply(); } else i.value = mins.bands[i.dataset.band];
    }));
    d.querySelectorAll('details.mins-sec').forEach((s) => s.addEventListener('toggle', () => { minsUi[s.dataset.sec] = s.open; saveMinsUi(); }));
    d.querySelector('#mReset').onclick = () => { mins = JSON.parse(JSON.stringify(MN.DEFAULTS)); apply(); };
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
      // Newest first, so the current observation is the first thing you see; older ones follow to the right.
      const tiles = list.slice().reverse().map((m, i) => {
        const r = riskAt(m.ceilingFt, m.visSM, m.obsTime, a.lat, a.lon);
        const cls = r ? `risk-bg-${r.level}` : `cat-bg-${m.fltCat || 'NA'}`;
        return `<div class="tr-tile ${cls}${i === 0 ? ' tr-latest' : ''}" ${popAttr(m.raw)}>
          <div class="mono small">${i === 0 ? '<b>Latest</b> ' : ''}${lt(m.obsTime)}</div>
          <div class="mono">${m.ceilingFt == null ? '—' : Math.round(m.ceilingFt / 100).toString().padStart(3, '0')}</div>
          <div class="mono small">${m.visSM ?? '?'}SM${m.wx ? ' ' + esc(m.wx) : ''}</div>
        </div>`;
      }).join('');
      return `<div class="tr-row"><div class="tr-id"><b class="mono">${esc(a.id)}</b><div class="muted small">${summary}</div></div><div class="tr-tiles">${tiles}</div></div>`;
    }).join('');
    const legend = mins.enabled ? 'Colored by your minimums (Green / Amber / Amber Crit / Red).' : 'Colored by flight category.';
    return panel('trend', 'METAR trend (6 hr)', null, `<div class="muted small" style="padding:8px 14px 0">${legend} Newest first. Each tile: local time, ceiling (hundreds of ft), visibility. Hover for the raw METAR.</div>${rows}`);
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
    if (i && i.matches('a[href], .chip')) { infoPinned = null; infoPop.classList.remove('on'); return; } // a link or area chip: just follow it
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
  let outlook = (() => { try { return { start: 'now', hours: 12, alt: 3000, shiftSrc: 'all', ...(JSON.parse(localStorage.getItem(OUT_KEY)) || {}) }; } catch { return { start: 'now', hours: 12, alt: 3000, shiftSrc: 'all' }; } })();
  // 'all' = worst case from TAF + LAMP (+ current METAR); 'taf' = TAF (+ current METAR) only. LAMP rows still show either way.
  const lampCounts = () => outlook.shiftSrc !== 'taf';
  const SRC_SHORT = { TAF: 'TAF', LAMP: 'LAMP', 'current METAR': 'METAR' };
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
      let worst = null; // {level, from, to, src}, set below from shiftWorst()
      const t = tafBy.get(a.id);
      if (t) {
        row('TAF', cols.map((c) => {
          const { prevailing: p, cond } = tafAt(t, c + HR / 2);
          if (!p) return `<td class="ocell${past(c)}"></td>`;
          const r = riskAt(p.ceilingFt, p.visSM, c + HR / 2, a.lat, a.lon);
          const worstCond = cond.map((q) => riskAt(q.ceilingFt, q.visSM, c + HR / 2, a.lat, a.lon)).filter(Boolean)
            .reduce((w, q) => (!w || LVL(q.level) > LVL(w.level) ? q : w), null);
          const cls = r ? `risk-bg-${r.level}` : `cat-bg-${p.fltCat || 'NA'}`;
          const tip = `${clouds(p.clouds, p.vertVis)} · ${vis(p.visib)}${p.wxString ? ' ' + p.wxString : ''}${r ? ` · ${r.label} (${r.lim.label})` : ''}${cond.length ? ` · plus ${cond.map((q) => (q.change === 'PROB' ? 'PROB' + (q.probability || '') : q.change) + ' ' + vis(q.visib) + ' ' + clouds(q.clouds, q.vertVis)).join('; ')}` : ''}`;
          return `<td class="ocell ${cls}${past(c)}" title="${esc(tip)}">${p.ceilingFt == null ? '' : Math.round(p.ceilingFt / 100)}${worstCond && (!r || LVL(worstCond.level) > LVL(r.level)) ? `<span class="otempo risk-bg-${worstCond.level}" title="TEMPO/PROB worse">T</span>` : ''}</td>`;
        }));
      }
      const L = lampBy[a.id];
      if (L && L.rows.length) {
        row(`LAMP ${infoTip(LAMP_INFO)}${lampCounts() ? '' : ` <span class="muted small" ${popAttr('LAMP is not counted in the worst case (Worst case from: TAF only).')}>not counted</span>`}`, cols.map((c) => {
          const r0 = L.rows.find((x) => Math.abs(x.t - (c + HR)) < 31 * 60e3) || L.rows.find((x) => Math.abs(x.t - c) < 31 * 60e3);
          if (!r0) return `<td class="ocell${past(c)}"></td>`;
          const ms = c + HR / 2;
          const lo = riskAt(r0.ceilLow, r0.visLow, ms, a.lat, a.lon);           // worst end of the ranges
          const hi = riskAt(r0.ceilHigh, r0.visHigh ?? 10, ms, a.lat, a.lon);  // best end
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
      // Folded header and summary use the same worst-case calculation as the airport card's Shift badge.
      const sw = shiftWorst(b, a);
      const noTafOnly = Boolean(sw && sw.noTaf);
      worst = sw && !sw.noTaf && mins.enabled ? { level: sw.key, from: sw.from, to: sw.to, src: sw.src } : null;
      // A minimized airport still shows its worst conditions for the shift in its header.
      if (folded) {
        const w = noTafOnly ? ' <span class="muted small">No TAF (LAMP not counted)</span>'
          : worst && worst.level !== 'green'
          ? ` <span class="risk risk-${worst.level}">${MN.LABEL[worst.level]} ${hhL(worst.from)}–${hhL(worst.to)}L</span>`
          : worst ? ' <span class="risk risk-green">Green all shift</span>' : '';
        aptBody.rows[0] = `<tr class="ogrp" data-ofold="${esc(a.id)}"><th colspan="${N + 1}">${aptHead(`${w} <span class="muted small">(minimized)</span>`)}</th></tr>`;
      }
      if (noTafOnly) summary.push(`<span class="alert"><b>${esc(a.id)}</b> No TAF <span class="muted">(LAMP not counted)</span></span>`);
      else if (worst && worst.level !== 'green') summary.push(`<span class="alert ${worst.level === 'red' || worst.level === 'critical' ? 'red' : 'hot'}"><b>${esc(a.id)}</b> ${MN.LABEL[worst.level]} ${hhL(worst.from)}–${hhL(worst.to)}L <span class="muted">(${SRC_SHORT[worst.src] || worst.src})</span></span>`);
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
      <label class="chk small" ${popAttr('What the Shift badge on each airport card and the worst-case summary here are worked out from. LAMP is NOAA automated guidance (supplementary, not a TAF). The current METAR always counts for the hour you are in.')}>Worst case from <select id="oSrc" class="sel"><option value="all" ${lampCounts() ? 'selected' : ''}>TAF + LAMP</option><option value="taf" ${lampCounts() ? '' : 'selected'}>TAF only</option></select></label>
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
    on('#oSrc', (v) => (outlook.shiftSrc = v === 'taf' ? 'taf' : 'all'));
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
    const L = lampCounts() && b.lamp && b.lamp.ok ? b.lamp.data[a.id] : null;
    if (!lampCounts() && !t) return { noTaf: true };
    const entries = []; // in time order; within an hour the current METAR, then the TAF, then LAMP, so a tie is credited in that order
    for (let i = 0; i < N; i++) {
      const c = start + i * H, mid = c + H / 2;
      const levels = [];
      if (c <= Date.now() && Date.now() < c + H && b.metars.ok) {
        const m = b.metars.data.find((x) => x.id === a.id);
        if (m) levels.push({ ceil: m.ceilingFt, vis: m.visSM, src: 'current METAR' });
      }
      if (t) {
        const p = t.periods.find((q) => !q.conditional && q.from <= mid && q.to > mid);
        if (p) levels.push({ ceil: p.ceilingFt, vis: p.visSM, src: 'TAF' });
      }
      if (L) {
        const r0 = L.rows.find((x) => Math.abs(x.t - (c + H)) < 31 * 60e3);
        if (r0) levels.push({ ceil: r0.ceilLow, vis: r0.visLow, src: 'LAMP' });
      }
      for (const lv of levels) {
        if (mins.enabled) {
          const r = riskAt(lv.ceil, lv.vis, mid, a.lat, a.lon);
          if (r) entries.push({ rank: MN.LEVELS.indexOf(r.level), key: r.level, label: MN.LABEL[r.level], cls: `risk risk-${r.level}`, c, src: lv.src });
        } else {
          const k = catOf(lv.ceil, lv.vis);
          entries.push({ rank: CAT_RANK[k], key: k, label: k, cls: `cat ${k}`, c, src: lv.src });
        }
      }
    }
    if (!entries.length) return null;
    const top = Math.max(...entries.map((e) => e.rank));
    const first = entries.find((e) => e.rank === top);
    let to = first.c + H; // extend while the following hours stay at the worst level
    while (entries.some((e) => e.c === to && e.rank === top)) to += H;
    const firstBySrc = {};
    for (const e of entries) if (e.rank === top && !(e.src in firstBySrc)) firstBySrc[e.src] = e.c;
    return { rank: top, key: first.key, label: first.label, cls: first.cls, from: first.c, to, src: first.src, firstBySrc, hasTaf: Boolean(t) };
  }
  function shiftBadge(b, a) {
    const w = shiftWorst(b, a);
    if (w && w.noTaf) return `<span class="muted small" ${popAttr('Worst case is set to TAF only (in the Shift outlook) and this airport has no TAF.')}>No TAF (LAMP not counted)</span>`;
    if (!w) return '<span class="muted small">No TAF or LAMP</span>';
    const src = SRC_SHORT[w.src] || w.src;
    if (w.rank === 0) {
      return `<span class="${w.cls}" ${popAttr(`No worse than ${w.label} all shift, from ${lampCounts() ? 'the TAF and LAMP' : 'the TAF (LAMP not counted)'}${'current METAR' in w.firstBySrc ? ' and the current METAR' : ''}.`)}>${esc(`${w.label} all shift`)}</span>`;
    }
    let tip = `Worst forecast for the shift: ${w.label} from ${hhL(w.from)}L, first shown by ${w.src === 'LAMP' ? 'LAMP (NOAA automated guidance, supplementary)' : w.src === 'TAF' ? 'the TAF' : 'the current METAR'}.`;
    if (w.src !== 'TAF' && w.hasTaf) tip += 'TAF' in w.firstBySrc ? ` The TAF reaches ${w.label} at ${hhL(w.firstBySrc.TAF)}L.` : ` The TAF does not reach ${w.label} this shift.`;
    if (!lampCounts()) tip += ' LAMP is not counted (Worst case from: TAF only).';
    tip += ' See the Shift outlook for hour-by-hour detail.';
    return `<span class="${w.cls}" ${popAttr(tip)}>${esc(`${w.label} ${hhL(w.from)}–${hhL(w.to)}L · ${src}`)}</span>`;
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
      map: panel('map', 'Map', null,
        `<div class="tools"><div class="tabs">
          <button class="tab" data-mapv="gfa" ${popAttr('Aviation Weather Center Graphical Forecasts for Aviation: radar, satellite, gridded clouds, icing, turbulence, Low Altitude mode.')}>AWC GFA</button>
          <button class="tab" data-mapv="wx" ${popAttr('Your radius or route outline, METARs by flight category, PIREPs, TFRs and advisories (follows the hazard filter).')}>wxboard map</button></div></div>
        <div id="gfaSlot" class="gfa-slot"></div><div id="map"></div>`,
        `<a class="small map-r-gfa" href="${esc(gfaUrl(b))}" target="_blank" rel="noopener noreferrer" ${popAttr('Open the Aviation Weather Center GFA in a new tab, centered on this area.')}>Open in new tab ↗</a>`
        + `<span class="muted small map-r-wx">${b.area.route ? 'Route corridor' : 'Radius'} ${b.area.radiusNm} nm</span>`),
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
        <div id="links" class="links" aria-label="Other weather sites"></div>
        <div class="lt-right">
          <button class="btn sm" id="collapseAll">Minimize all</button>
          <button class="btn sm" id="expandAll">Expand all</button>
          <button class="btn sm" id="resetLayout" ${popAttr('Put every panel back in its original place')}>Reset layout</button>
          <span class="muted small">Drag ⠿ to move panels · ▾ to minimize</span>
        </div>
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
    setMapView(b);
    renderLinks();
    renderJumpBar();
  }

  // ---------- quick links ("Jump to") in the sticky header ----------
  // One chip per panel, in the order the panels are on the page. Clicking scrolls to the panel,
  // expands it if minimized and flashes it (same as the alert chips). Always shown; it doesn't fold.
  const JUMP_LABELS = {
    summary: 'Conditions', outlook: 'Shift outlook', map: 'Map', trend: 'METAR trend', airports: 'METAR and TAFs',
    winds: 'Winds aloft', stations: 'Stations', notams: 'NOTAMs', advisories: 'Advisories', pireps: 'PIREPs',
    tfrs: 'TFRs', forecast: 'Area forecast',
  };
  function renderJumpBar() {
    const el = document.getElementById('jumpbar');
    if (!el) return;
    const secs = [...document.querySelectorAll('#app .panel[data-id]')];
    if (!secs.length) { el.hidden = true; el.innerHTML = ''; return; }
    el.hidden = false;
    el.innerHTML = '<span class="jb-lbl">Jump to</span>' + secs.map((sec) => {
      const id = sec.dataset.id;
      const label = JUMP_LABELS[id] || (sec.querySelector('h3 .ttl') || {}).textContent || id;
      const cnt = sec.querySelector(':scope > h3 > .count');
      const min = sec.classList.contains('collapsed');
      return `<a href="#" class="jb jump${min ? ' min' : ''}" data-jump="panel:${esc(id)}">${esc(label)}${cnt ? ` <span class="count">${esc(cnt.textContent)}</span>` : ''}</a>`;
    }).join('');
  }
  // Keep scroll targets clear of the sticky header, whose height changes with the jump bar and window width.
  (() => {
    const top = document.querySelector('header.top');
    if (!top) return;
    const set = () => document.documentElement.style.setProperty('--hdr', `${Math.ceil(top.getBoundingClientRect().height) + 8}px`);
    set();
    if (window.ResizeObserver) new ResizeObserver(set).observe(top); else addEventListener('resize', set);
  })();

  function setCollapsed(sec, on) {
    const id = sec.dataset.id;
    sec.classList.toggle('collapsed', on);
    sec.querySelector('.fold').textContent = on ? '▸' : '▾';
    layout.collapsed = layout.collapsed.filter((x) => x !== id);
    if (on) layout.collapsed.push(id);
    if (id === 'map' && !on && mapView === 'wx') refreshMap();
    renderJumpBar();
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
      if (sec.dataset.id === 'map' && mapView === 'wx') refreshMap();
      layout.cols = [...document.querySelectorAll('#app .col')].map((c) => [...c.querySelectorAll(':scope > .panel')].map((p) => p.dataset.id));
      saveLayout();
      renderJumpBar();
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
          ${rNow ? `<b ${popAttr('The latest METAR checked against your minimums. The Shift and TAF rows above are the forecast.')}>Minimums now</b><span>${riskBadge(rNow)} <span class="muted small">${esc(rNow.lim.label.split(',')[0])} ${rNow.lim.noCeil ? `${rNow.lim.vis} SM` : `${rNow.lim.ceil}-${rNow.lim.vis}`}</span>${terrainTag(lat, lon)}</span>` : ''}
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
    // A regulation behind the minimums has changed since wxboard was checked against it (server checks eCFR daily).
    if (b.regs) {
      for (const c of b.regs.changed || []) {
        const what = c.status === 'amended' ? `amended ${c.latest}` : c.status === 'removed' ? 'removed' : 'reworded';
        items.push(`<span class="alert red" ${popAttr(`14 CFR ${c.section} (${c.uses}) is ${what} on eCFR, after wxboard's minimums were checked against it on ${b.regs.verified}. Until wxboard is updated, check the minimums colors against the current regulation yourself.${c.missing && c.missing.length ? ` Text no longer found: "${c.missing.join('", "')}".` : ''}`)}>Regulation changed: 14 CFR ${esc(c.section)}</span>`);
      }
      if (b.regs.overdue) items.push(`<span class="alert hot" ${popAttr(`The server hasn't been able to reach eCFR to confirm the regulations behind the minimums are current${b.regs.lastOkAt ? ` since ${zt(Date.parse(b.regs.lastOkAt))}` : ''}.`)}>Regulations not confirmed for 7+ days</span>`);
    }
    // A source that couldn't be refreshed: the brief used its last good copy. Never silent.
    for (const st of b.stale || []) {
      const since = Date.parse(st.since);
      items.push(`<span class="alert red" ${popAttr(`${st.source} couldn't be refreshed (${st.error}). This brief uses the last copy it got, from ${zt(since)}. Check the source directly before relying on it.`)}>Old data: ${esc(st.source)} from ${ago(since).replace(' ago', '')} ago</span>`);
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

  // Fold state for the METAR and TAFs panel (id 'airports'), remembered per browser. Keys: "KDFW" (whole airport), "KDFW|metar",
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
    if (!b.metars.ok && !b.tafs.ok) return panel('airports', 'METAR and TAFs', null, failed(b.metars));
    const tools = `<div class="tools"><button class="btn sm" data-aptall="0">Minimize airports</button><button class="btn sm" data-aptall="1">Expand airports</button>
      <button class="btn sm" data-aptraw="1" title="Show or hide every raw TAF">Toggle raw TAFs</button></div>`;
    return panel('airports', 'METAR and TAFs', anchorIds.length, tools + blocks);
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
    if (n.data.restricted) {
      return panel('notams', 'NOTAMs', null, `<div class="body">
        <p style="margin-top:0">NOTAMs aren't available on this site. Use <a href="${b.links.notamSearch}" target="_blank" rel="noopener">FAA NOTAM Search</a> for ${esc(b.area.anchors.map((a) => a.id).join(', '))}.</p></div>`);
    }
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
    return `<div class="muted small" style="padding:8px 14px 0">Forecast for ${zt(validAt)} (${ltDay(validAt)} local). Altitudes MSL, direction true. — = within 500 ft of the ground. Model winds (${esc(W.source)}${W.run ? `, GFS run ${pad(new Date(W.run).getUTCHours())}Z ${pad(new Date(W.run).getUTCDate())}` : ''}), not an official NWS winds aloft forecast. Refreshed when a new model run is out (every 6 h).</div>
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

  // ----- Hazards (with hazard-type filter that also applies to the wxboard map) -----
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
    const tools = chips ? `<div class="tools"><span class="muted small">Show:</span>${chips}${nHidden ? `<span class="muted small">${nHidden} hidden from the list, outlook and wxboard map</span>` : ''}</div>` : '';
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

  // ----- wxboard's own map (Leaflet) -----
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
      // OpenStreetMap's tile policy requires a Referer. The site's own policy (same-origin) would strip it, so the
      // tile images alone send the site's origin (https://host/, no path or query).
      L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 12, attribution: '&copy; OpenStreetMap contributors', referrerPolicy: 'strict-origin-when-cross-origin' }).addTo(map);
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
    // Re-fit only when the area changed, so a background refresh keeps your zoom and pan. While the map's tab
    // is hidden it has no size to fit to, so the fit waits until the tab is shown.
    if (!reused || JSON.stringify(newBounds) !== JSON.stringify(mapBounds)) {
      if (map.getContainer().offsetWidth) map.fitBounds(newBounds, { padding: [10, 10] }); else mapNeedsFit = true;
    }
    mapBounds = newBounds;
  }

  // ----- Map panel tabs: AWC GFA | wxboard map (remembered per browser) -----
  // Switching only hides the other map, so neither loses its view.
  let mapView = (() => { try { return localStorage.getItem('wxboard.mapView') === 'wx' ? 'wx' : 'gfa'; } catch { return 'gfa'; } })();
  function setMapView(b) {
    const sec = document.querySelector('#app .panel[data-id=map]');
    if (!sec) return;
    const gfa = mapView === 'gfa';
    sec.querySelectorAll('[data-mapv]').forEach((t) => t.classList.toggle('on', t.dataset.mapv === mapView));
    sec.querySelectorAll('.map-r-gfa').forEach((e) => { e.hidden = !gfa; });
    sec.querySelectorAll('.map-r-wx').forEach((e) => { e.hidden = gfa; });
    const slot = document.getElementById('gfaSlot');
    if (slot) slot.style.display = gfa ? '' : 'none';
    const box = map ? map.getContainer() : document.getElementById('map');
    if (box) box.style.display = gfa ? 'none' : '';
    if (gfa) placeGfa(b || lastBrief);
    else refreshMap();
  }
  function refreshMap() {
    if (!map) return;
    setTimeout(() => {
      map.invalidateSize();
      if (mapNeedsFit && mapBounds && map.getContainer().offsetWidth) { map.fitBounds(mapBounds, { padding: [10, 10] }); mapNeedsFit = false; }
    }, 60);
  }
  document.addEventListener('click', (e) => {
    const t = e.target.closest('#app .panel[data-id=map] [data-mapv]');
    if (!t || t.dataset.mapv === mapView) return;
    mapView = t.dataset.mapv === 'wx' ? 'wx' : 'gfa';
    try { localStorage.setItem('wxboard.mapView', mapView); } catch {}
    setMapView();
  });

  // ----- Map: the Aviation Weather Center GFA, embedded -----
  // An embedded page reloads whenever it is moved in the page, and the board re-renders often (every refresh,
  // most settings). So one GFA frame lives for the whole visit, outside the board, and is laid over the Map
  // panel's slot. It only loads a new address when the briefed area changes, so your own pan, zoom, layers and
  // time in the GFA survive refreshes. Settings you change inside the GFA are kept by the GFA itself.
  const GFA_BASE = 'https://aviationweather.gov/gfa/';
  const GFA_HEIGHT = 600;
  let gfaFrame = null, gfaWrap = null, gfaKey = '';
  function gfaView(b, widthPx) {
    const bb = b.area.bbox;
    const lat = (bb.minLat + bb.maxLat) / 2, lon = (bb.minLon + bb.maxLon) / 2;
    // Web-map zoom that fits the area's box (plus a margin) in the frame.
    const lonSpan = Math.max(0.2, (bb.maxLon - bb.minLon) * 1.3);
    const latSpan = Math.max(0.2, (bb.maxLat - bb.minLat) * 1.3);
    const zLon = Math.log2((widthPx * 360) / (256 * lonSpan));
    const zLat = Math.log2((GFA_HEIGHT * 360 * Math.cos((lat * Math.PI) / 180)) / (256 * latSpan));
    const zoom = Math.max(3, Math.min(11, Math.floor(Math.min(zLon, zLat))));
    return { lat: lat.toFixed(3), lon: lon.toFixed(3), zoom };
  }
  function gfaUrl(b, widthPx = 900) {
    const v = gfaView(b, widthPx);
    return `${GFA_BASE}?tab=obs&center=${v.lat},${v.lon}&zoom=${v.zoom}`;
  }
  function placeGfa(b) {
    const slot = document.getElementById('gfaSlot');
    if (!slot) return;
    slot.style.height = GFA_HEIGHT + 'px';
    if (!gfaWrap) {
      gfaWrap = document.createElement('div');
      gfaWrap.id = 'gfaOverlay';
      gfaFrame = document.createElement('iframe');
      gfaFrame.title = 'Aviation Weather Center Graphical Forecasts for Aviation';
      gfaFrame.referrerPolicy = 'no-referrer';
      gfaWrap.appendChild(gfaFrame);
      document.body.appendChild(gfaWrap);
      requestAnimationFrame(syncGfa);
    }
    if (mapView !== 'gfa') return; // loads the first time its tab is shown
    const url = gfaUrl(b, slot.clientWidth || 900);
    const key = url.replace(/&zoom=\d+/, '') + '|' + b.area.ids.join(' ') + '|' + b.area.radiusNm + '|' + b.area.route;
    if (key !== gfaKey) { gfaKey = key; gfaFrame.src = url; }
  }
  // Keeps the frame over the slot: follows scrolling, folding, dragging and window resizing.
  let gfaLast = '';
  function syncGfa() {
    const slot = document.getElementById('gfaSlot');
    const r = slot && slot.getBoundingClientRect();
    const show = r && r.width > 0 && r.height > 0;
    const sig = show ? `${Math.round(r.left + scrollX)},${Math.round(r.top + scrollY)},${Math.round(r.width)},${Math.round(r.height)}` : 'off';
    if (sig !== gfaLast) {
      gfaLast = sig;
      if (show) {
        Object.assign(gfaWrap.style, { visibility: 'visible', left: `${r.left + scrollX}px`, top: `${r.top + scrollY}px`, width: `${r.width}px`, height: `${r.height}px` });
      } else {
        gfaWrap.style.visibility = 'hidden';
      }
    }
    requestAnimationFrame(syncGfa);
  }

  // Signed-in user's name, account links and sign-out (only when the server has sign-ins turned on).
  function renderUserMenu() {
    const el = $('#usermenu');
    const u = status.user;
    if (!el || !u) return;
    el.innerHTML = `<span class="muted">${esc(u.username)}</span><a href="/account">Account</a>`
      + (u.role === 'admin' ? `<a href="/admin">Admin${u.pending ? ` <span class="tag warn">${Number(u.pending)}</span>` : ''}</a>` : '')
      + `<form method="post" action="/logout"><input type="hidden" name="csrf" value="${esc(u.csrf)}"><button class="linkbtn">Sign out</button></form>`;
  }

  // ---------- other weather sites (link row under the header) ----------
  // Each browser keeps its own list. {lat} {lon} {id} in a URL are filled in from the first airport of the
  // current brief (no brief yet: the link opens the site's home page instead).
  const LINKS_KEY = 'wxboard.links.v1';
  const LINKS_FOLD_KEY = 'wxboard.linksFolded';
  const DEFAULT_LINKS = [
    { name: 'AWC GFA', url: 'https://aviationweather.gov/gfa/', color: '#0085CA',
      info: 'Aviation Weather Center Graphical Forecasts for Aviation. Click the helicopter button for Low Altitude mode (the former HEMS Tool).' },
    { name: 'ForeFlight Web', url: 'https://plan.foreflight.com/', color: '#2B7BD6', info: 'ForeFlight on the web. Needs a ForeFlight subscription.' },
    { name: 'Windy', url: 'https://www.windy.com/?{lat},{lon},8', color: '#A71C20', info: 'Windy model forecasts, centered on your first airport.' },
    { name: 'COD Sat/Radar', url: 'https://weather.cod.edu/satrad/', color: '#1F6B3A', info: 'College of DuPage NEXLAB satellite and radar.' },
    { name: '1800wxbrief', url: 'https://www.1800wxbrief.com/', color: '#850F88', info: 'Leidos Flight Service: standard briefings and flight plans.' },
    { name: 'SPC Outlooks', url: 'https://www.spc.noaa.gov/products/outlook/', color: '#B5651D',
      info: 'NOAA Storm Prediction Center convective outlooks: Day 1, Day 2, Day 3 and Day 4–8 severe thunderstorm risk.' },
    { name: 'NHC Outlooks', url: 'https://www.nhc.noaa.gov/gtwo.php', color: '#00758F',
      info: 'NOAA National Hurricane Center Tropical Weather Outlook (graphical and text): Atlantic and Eastern/Central Pacific.' },
  ];
  // Defaults added after a pilot first edited their list are appended to it once (they can still remove them).
  const LINKS_SEEN_KEY = 'wxboard.links.seenDefaults';
  function loadLinks() {
    try {
      const v = JSON.parse(localStorage.getItem(LINKS_KEY));
      if (Array.isArray(v)) {
        const list = v.filter((l) => l && l.name && safeUrl(l.url)).map((l) => {
          const d = DEFAULT_LINKS.find((x) => x.url === l.url);
          return { ...l, color: safeColor(l.color) || (d && d.color) || '', info: l.info || (d && d.info) || '' };
        });
        // Lists saved before the "seen" record existed had seen the first five defaults.
        let seen; try { seen = JSON.parse(localStorage.getItem(LINKS_SEEN_KEY)); } catch {}
        if (!Array.isArray(seen)) seen = DEFAULT_LINKS.slice(0, 5).map((d) => d.url);
        const fresh = DEFAULT_LINKS.filter((d) => !seen.includes(d.url));
        if (fresh.length) {
          for (const d of fresh) if (!list.some((l) => l.url === d.url)) list.push({ ...d });
          storeLinks(list);
        }
        return list;
      }
    } catch {}
    return DEFAULT_LINKS.map((l) => ({ ...l }));
  }
  // Saving a list means the pilot has seen every current default, so one they removed doesn't come back.
  const storeLinks = (list) => { try { localStorage.setItem(LINKS_KEY, JSON.stringify(list)); localStorage.setItem(LINKS_SEEN_KEY, JSON.stringify(DEFAULT_LINKS.map((d) => d.url))); } catch {} };
  let linksFolded = (() => { try { return localStorage.getItem(LINKS_FOLD_KEY) === '1'; } catch { return false; } })();
  const safeColor = (c) => (/^#[0-9a-f]{6}$/i.test(String(c || '')) ? String(c) : '');
  // Only plain web links: refuses javascript:, data: and the like.
  function safeUrl(u) {
    try { const x = new URL(String(u).replace(/\{(lat|lon|id)\}/g, '0')); return x.protocol === 'https:' || x.protocol === 'http:'; } catch { return false; }
  }
  function linkHref(url) {
    const a = lastBrief && lastBrief.area && lastBrief.area.anchors && lastBrief.area.anchors[0];
    if (!/\{(lat|lon|id)\}/.test(url)) return url;
    if (!a || a.lat == null) { try { return new URL(url.replace(/\{(lat|lon|id)\}/g, '0')).origin + '/'; } catch { return url; } }
    return url.replace(/\{lat\}/g, Number(a.lat).toFixed(3)).replace(/\{lon\}/g, Number(a.lon).toFixed(3)).replace(/\{id\}/g, encodeURIComponent(a.id || ''));
  }
  function renderLinks() {
    const el = document.getElementById('links');
    if (!el) return;
    const list = loadLinks();
    const fold = `<button type="button" class="lk-fold" id="lkFold">${linksFolded ? '▸' : '▾'} Other sites${linksFolded ? ` <span class="count">${list.length}</span>` : ''}</button>`;
    if (linksFolded) { el.innerHTML = fold; }
    else {
      el.innerHTML = fold + list.map((l) => `<a class="lk${safeColor(l.color) ? ' branded' : ''}" ${safeColor(l.color) ? `style="--lk:${safeColor(l.color)}"` : ''} href="${esc(linkHref(l.url))}" target="_blank" rel="noopener noreferrer" ${popAttr(l.info || l.url)}>${esc(l.name)}</a>`).join('')
        + '<button type="button" class="btn sm" id="lkEdit">Edit</button>';
    }
    el.querySelector('#lkFold').onclick = () => { linksFolded = !linksFolded; try { localStorage.setItem(LINKS_FOLD_KEY, linksFolded ? '1' : '0'); } catch {} renderLinks(); };
    const ed = el.querySelector('#lkEdit'); if (ed) ed.onclick = openLinksDialog;
  }
  function openLinksDialog() {
    let d = document.getElementById('linksDlg');
    if (!d) { d = document.createElement('div'); d.id = 'linksDlg'; document.body.appendChild(d); }
    const list = loadLinks();
    const rows = list.map((l, i) => `<div class="lk-row"><div><span class="lk-sw" ${safeColor(l.color) ? `style="background:${safeColor(l.color)}"` : ''}></span><b>${esc(l.name)}</b><div class="u">${esc(l.url)}</div></div>
      <button class="btn sm" data-lkmove="${i}" data-dir="-1" ${i === 0 ? 'disabled' : ''} aria-label="Move up">↑</button>
      <button class="btn sm" data-lkmove="${i}" data-dir="1" ${i === list.length - 1 ? 'disabled' : ''} aria-label="Move down">↓</button>
      <button class="btn sm" data-lkdel="${i}">Remove</button></div>`).join('');
    d.innerHTML = `<div class="dlg"><h3>Other weather sites</h3>
      <div class="lk-list">${rows || '<div class="muted small">No links. Add one below, or reset to the defaults.</div>'}</div>
      <div class="lbl">Add a link</div>
      <div class="lk-add"><label class="fld"><span>Name</span><input id="lkName" maxlength="40"></label>
        <label class="fld"><span>Address</span><input id="lkUrl" placeholder="https://…" spellcheck="false"></label>
        <label class="fld"><span>Color</span><input id="lkColor" type="color" value="#2a3a4d"></label>
        <button class="btn primary" id="lkAdd">Add</button></div>
      <div class="lk-err" id="lkErr"></div>
      <p class="muted small">Saved in this browser only. In an address, <code>{lat}</code>, <code>{lon}</code> and <code>{id}</code> are replaced with the first airport of your current brief.</p>
      <div style="display:flex;gap:8px;justify-content:flex-end"><button class="btn" id="lkReset">Reset to defaults</button><button class="btn primary" id="lkClose">Done</button></div></div>`;
    d.classList.add('on');
    const save = (l) => { storeLinks(l); renderLinks(); openLinksDialog(); };
    d.querySelectorAll('[data-lkdel]').forEach((b) => (b.onclick = () => { const l = loadLinks(); l.splice(Number(b.dataset.lkdel), 1); save(l); }));
    d.querySelectorAll('[data-lkmove]').forEach((b) => (b.onclick = () => {
      const l = loadLinks(), i = Number(b.dataset.lkmove), j = i + Number(b.dataset.dir);
      if (j < 0 || j >= l.length) return;
      [l[i], l[j]] = [l[j], l[i]]; save(l);
    }));
    d.querySelector('#lkAdd').onclick = () => {
      const name = d.querySelector('#lkName').value.trim();
      let url = d.querySelector('#lkUrl').value.trim();
      if (url && !/^[a-z]+:/i.test(url)) url = 'https://' + url;
      const err = d.querySelector('#lkErr');
      if (!name) { err.textContent = 'Give the link a name.'; return; }
      if (!safeUrl(url)) { err.textContent = 'That address doesn\'t look like a web address (https://…).'; return; }
      const color = safeColor(d.querySelector('#lkColor').value);
      const l = loadLinks(); l.push({ name, url, color: color === '#2a3a4d' ? '' : color }); save(l);
    };
    d.querySelector('#lkReset').onclick = () => { try { localStorage.removeItem(LINKS_KEY); } catch {} renderLinks(); openLinksDialog(); };
    d.querySelector('#lkClose').onclick = () => d.classList.remove('on');
    d.onclick = (e) => { if (e.target === d) d.classList.remove('on'); };
  }

  // ---------- start ----------
  // The last brief in this browser, if it still looks valid.
  function lastArea() {
    try {
      const v = JSON.parse(localStorage.getItem(LAST_KEY));
      if (v && typeof v.ids === 'string' && v.ids.trim()) return { ids: v.ids.slice(0, 80), radius: Number(v.radius) || 30, route: Boolean(v.route) };
    } catch {}
    return null;
  }
  async function init() {
    renderLinks();
    try { status = await (await fetch('/api/status')).json(); } catch {}
    baseBanner();
    renderUserMenu();
    if (status.defaultRadiusNm) $('#radius').value = status.defaultRadiusNm;
    await loadAreas();
    renderSaved();
    const p = new URLSearchParams(location.search);
    const def = areas.find((a) => a.default);
    if (p.get('ids')) {
      const a = { ids: p.get('ids'), radius: Number(p.get('radius')) || status.defaultRadiusNm || 30, route: p.get('route') === '1' };
      setForm(a); run(a);
    } else if (def) {
      setForm(def); run(def);
    } else if (lastArea()) {
      const a = lastArea(); setForm(a); run(a);
    } else {
      $('#ids').focus();
    }
  }
  init();
})();
