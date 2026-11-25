// ---------------------------------------------------------------------------
// Extra features, built on top of app.js (which loads first, so everything in it - $, state, levelsOf, showTab... - is
// available here):
//   * command palette (Ctrl/Cmd+K)        * "pick a level for me"          * points / rank "what if"
//   * stats for the personal list         * saved filters + EDEL range     * custom lists
//   * song names across the app           * the sync-folder settings
// ---------------------------------------------------------------------------
(function () {
  'use strict';
  const fx = (window.fx = {});

  // ---- tiny helpers --------------------------------------------------------
  const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };
  const plural = (n, one, many) => `${n} ${n === 1 ? one : (many || one + 's')}`;
  const mouse = { x: 240, y: 200 };
  document.addEventListener('mousemove', (e) => { mouse.x = e.clientX; mouse.y = e.clientY; }, { passive: true });
  const ICON_X = '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M5.5 5.5l9 9M14.5 5.5l-9 9"/></svg>';
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const num = (v) => { const n = Number(v); return v === '' || v == null || !Number.isFinite(n) ? null : n; };
  async function bothLevels() { try { await Promise.all(MODES.map(m => ensureLevels(m))); } catch { /* use what is loaded */ } }
  const modeLabel = (m) => (m === 'platformer' ? 'Platformer' : 'Classic');
  const pts = (raw) => (raw == null ? '—' : Number(raw / 10).toLocaleString(undefined, { maximumFractionDigits: 1 }));

  // ---- a modal window (one at a time) -----------------------------------------
  let current = null;
  function openModal({ title, wide = false, onClose, persistent = false } = {}) {
    if (current) current.close();
    const overlay = el('div', 'fx-overlay');
    const box = el('div', 'fx-modal' + (wide ? ' wide' : ''));
    box.setAttribute('role', 'dialog'); box.setAttribute('aria-modal', 'true'); box.setAttribute('aria-label', title);
    const head = el('div', 'fx-head');
    head.appendChild(el('strong', null, title));
    const x = el('button', 'fx-x'); x.type = 'button'; x.setAttribute('aria-label', 'Close'); x.innerHTML = ICON_X;
    head.appendChild(x);
    const body = el('div', 'fx-body');
    box.append(head, body); overlay.appendChild(box); document.body.appendChild(overlay);
    const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
    let closed = false;
    function close() {
      if (closed) return; closed = true;
      document.removeEventListener('keydown', onKey, true);
      if (current === handle) current = null;
      overlay.classList.add('closing'); // fades out, then goes
      setTimeout(() => overlay.remove(), 150);
      if (onClose) onClose();
    }
    document.addEventListener('keydown', onKey, true);
    overlay.addEventListener('mousedown', (e) => { if (e.target === overlay && !persistent) close(); });
    // dropdowns inside popups use the app's own dropdown look
    new MutationObserver(() => body.querySelectorAll('select.fx-select:not([data-dd])').forEach(s => { if (s.parentNode) enhanceSelect(s); })).observe(body, { childList: true, subtree: true });
    x.addEventListener('click', close);
    const handle = { overlay, box, body, close };
    current = handle;
    return handle;
  }
  fx.closeModal = () => { if (current) current.close(); };
  fx.openModal = openModal;

  // ---- a really big change is about to be saved to Google Drive by the timer: ask first ----------------------------
  async function askBigChange({ id, changes }) {
    for (let i = 0; i < 300 && current; i++) await new Promise(r => setTimeout(r, 1000)); // not on top of a dialog that is open
    let answered = false;
    const reply = (ok) => { if (answered) return; answered = true; window.aredl.syncBigAnswer(id, ok); };
    const m = openModal({ title: 'Save a big change?', persistent: true, onClose: () => reply(false) });
    m.body.appendChild(el('p', null, 'A lot has changed since the last save to Google Drive. Saving it replaces what is in the folder.'));
    const list = el('div', 'fx-list');
    for (const c of changes) {
      const row = el('div', 'fx-listrow');
      const name = el('div', 'fx-listname');
      name.appendChild(el('strong', null, c.label));
      name.appendChild(el('small', 'dim', `${c.was} → ${c.now} (${c.now >= c.was ? `${c.now - c.was} more` : `${c.was - c.now} fewer`})`));
      row.appendChild(name); list.appendChild(row);
    }
    m.body.appendChild(list);
    m.body.appendChild(el('p', 'dim', 'If you don’t save, the folder keeps what it has. You can still save any time with Sync now.'));
    const foot = el('div', 'fx-row');
    const save = el('button', 'btn small-btn', 'Save it'), keep = el('button', 'btn btn-ghost small-btn', 'Don’t save');
    save.addEventListener('click', () => { reply(true); m.close(); });
    keep.addEventListener('click', () => { reply(false); m.close(); });
    foot.append(save, keep); m.body.appendChild(foot);
  }
  window.aredl.onSyncBigChange((d) => askBigChange(d).catch(() => window.aredl.syncBigAnswer(d.id, false)));

  // ---- the level picture: the setting, a custom file, and the per-level overwrites -------------------------------
  function refreshBackdropSettings() {
    const sel = $('#bgSourceSelect');
    if (!sel) return;
    sel.value = customBg.on ? 'custom' : (appSettings.bgSource === 'aredl' ? 'aredl' : 'youtube');
    $('#bgCustomLine').hidden = !customBg.on && !customBg.has && sel.value !== 'custom';
    $('#bgCustomName').textContent = customBg.has ? `${customBg.name || 'A file'} (${customBg.type === 'video' ? 'video, plays silently on a loop' : 'image or GIF'}). A file of 8 MB or less is included in Google Drive sync.` : 'No file chosen. Images, GIFs and videos work; videos play silently on a loop. The shader still takes its colours from it. A file of 8 MB or less is included in Google Drive sync.';
    $('#bgCustomClear').hidden = !customBg.has;
    $('#bgCustomPick').textContent = customBg.has ? 'Choose another file…' : 'Choose file…';
    const n = thumbOverrides.size;
    $('#thumbOverrideNote').textContent = n ? `${n} level${n === 1 ? ' uses' : 's use'} a different picture than the one chosen above.` : 'No level uses a different picture than the one chosen above.';
  }
  fx.refreshBackdropSettings = refreshBackdropSettings;
  function pictureChanged() { // what the backdrop shows is worked out again
    adaptiveCache.clear(); shaderCache.clear(); bgShownVid = null;
    refreshPictures(); // (a level with its own picture keeps it; every other level shows the custom backdrop)
    refreshBackdropSettings();
  }
  $('#bgSourceSelect').addEventListener('change', async () => {
    const v = $('#bgSourceSelect').value;
    if (v === 'custom') {
      if (!customBg.has) { // nothing chosen yet: ask for the file first
        const r = await window.aredl.bgPickCustom();
        if (!r.ok) { if (r.error) showToast(r.error); refreshBackdropSettings(); $('#bgSourceSelect').value = appSettings.bgSource === 'aredl' ? 'aredl' : 'youtube'; return; }
        customBg = r;
      } else customBg = await window.aredl.bgSetCustomOn(true);
    } else {
      if (customBg.has) customBg = await window.aredl.bgSetCustomOn(false);
      setSetting('bgSource', v);
    }
    pictureChanged();
  });
  $('#bgCustomPick').addEventListener('click', async () => {
    const r = await window.aredl.bgPickCustom();
    if (!r.ok) { if (r.error) showToast(r.error); return; }
    customBg = r; pictureChanged();
  });
  $('#bgCustomClear').addEventListener('click', async () => { customBg = await window.aredl.bgClearCustom(); pictureChanged(); });
  $('#thumbOverridesBtn').addEventListener('click', () => openThumbOverrides());

  async function openThumbOverrides() {
    await bothLevels();
    const m = openModal({ title: 'Picture overwrites', wide: true, onClose: refreshBackdropSettings });
    const draw = () => {
      m.body.innerHTML = '';
      if (!thumbOverrides.size) { m.body.appendChild(el('p', 'dim', 'No level has its own picture. Right-click a level and choose a different picture to add one.')); return; }
      m.body.appendChild(el('p', 'dim', 'These levels use a different picture than the one chosen in Settings.'));
      const rows = [...thumbOverrides].map(([id, source]) => ({ id, source, level: anyLevel(id) }))
        .sort((a, b) => ((a.level && a.level.position) ?? 1e9) - ((b.level && b.level.position) ?? 1e9));
      const list = el('div', 'fx-list');
      for (const r of rows) {
        const row = el('div', 'fx-listrow');
        const name = el('div', 'fx-listname');
        name.appendChild(el('strong', null, r.level ? r.level.name : `Level ${r.id}`));
        name.appendChild(el('small', 'dim', `${r.level && r.level.position != null ? '#' + r.level.position + ' · ' : ''}${r.source === 'aredl' ? 'AREDL picture' : 'YouTube thumbnail'}`));
        const flip = el('button', 'btn btn-ghost small-btn', r.source === 'aredl' ? 'Use YouTube’s' : 'Use AREDL’s');
        const del = el('button', 'btn btn-ghost small-btn', 'Delete');
        flip.addEventListener('click', () => { thumbOverrides.set(r.id, r.source === 'aredl' ? 'youtube' : 'aredl'); saveThumbOverrides(); refreshPictures(); draw(); });
        del.addEventListener('click', () => { thumbOverrides.delete(r.id); saveThumbOverrides(); refreshPictures(); draw(); });
        row.append(name, flip, del);
        list.appendChild(row);
      }
      m.body.appendChild(list);
      const foot = el('div', 'fx-row');
      const clear = el('button', 'btn btn-ghost small-btn', 'Clear all');
      clear.addEventListener('click', () => {
        if (clear.dataset.sure !== '1') { clear.dataset.sure = '1'; clear.textContent = `Really clear all ${thumbOverrides.size}?`; setTimeout(() => { if (clear.isConnected) { clear.dataset.sure = ''; clear.textContent = 'Clear all'; } }, 4000); return; }
        thumbOverrides.clear(); saveThumbOverrides(); refreshPictures(); draw();
      });
      foot.appendChild(clear);
      m.body.appendChild(foot);
    };
    draw();
  }
  fx.openThumbOverrides = openThumbOverrides;

  // the picture a level uses as its backdrop, larger (what the setting, the level's own choice or a custom file gives)
  fx.openPictureView = async function (levelId, mode, name) {
    const m = openModal({ title: name || 'Backdrop picture', wide: true });
    m.body.appendChild(el('div', 'state', 'Loading the picture…'));
    const vidFor = async () => {
      let v = currentVidOfLevel(levelId);
      if (!v) { try { v = vidOfDetail(await fetchDetailCached(levelId, mode)); if (v) levelVidCache.set(String(levelId), v); } catch { v = null; } }
      return v;
    };
    let key = picKey(levelId, currentVidOfLevel(levelId));
    if (!key) key = picKey(levelId, await vidFor());
    const show = (k) => {
      m.body.innerHTML = '';
      if (!k) { m.body.appendChild(el('p', 'dim', 'This level has no picture: AREDL has none and its video is unknown.')); return; }
      const url = picUrl(k);
      const wrap = el('div', 'pic-view');
      let media;
      if (k === 'custom' && customBg.type === 'video') { media = el('video'); media.src = url; media.muted = true; media.loop = true; media.autoplay = true; media.controls = true; }
      else {
        media = el('img'); media.alt = name || 'Level picture';
        media.addEventListener('load', () => { if (picIsAredl(k)) logPic(url, true); });
        media.addEventListener('error', async () => { // AREDL has none for this level: YouTube's thumbnail instead
          if (picIsAredl(k)) { logPic(url, false); aredlMissing.add(k.slice(2)); show(await vidFor()); }
        });
        media.src = url;
      }
      wrap.appendChild(media);
      m.body.appendChild(wrap);
      const what = k === 'custom' ? 'Your own backdrop file.' : (picIsAredl(k) ? 'AREDL’s picture of the level.' : 'YouTube’s thumbnail of the level’s video.');
      m.body.appendChild(el('p', 'dim', what));
      if (k !== 'custom') { const a = el('a', 'linklike', 'Open the image in the browser'); a.href = url; a.target = '_blank'; a.rel = 'noopener'; m.body.appendChild(a); }
    };
    show(key);
  };

  // a one-line question ("Name this list")
  function askName({ title, label, value = '', ok = 'Save' }) {
    return new Promise((resolve) => {
      let done = false;
      const m = openModal({ title, onClose: () => { if (!done) resolve(null); } });
      m.body.appendChild(el('label', 'fx-label', label));
      const input = el('input', 'fx-input'); input.type = 'text'; input.value = value; input.maxLength = 60; input.spellcheck = false;
      const row = el('div', 'fx-row');
      const go = el('button', 'btn small-btn', ok), cancel = el('button', 'btn btn-ghost small-btn', 'Cancel');
      row.append(go, cancel);
      m.body.append(input, row);
      const finish = (v) => { done = true; m.close(); resolve(v); };
      go.addEventListener('click', () => { const v = input.value.trim(); if (v) finish(v); else input.focus(); });
      cancel.addEventListener('click', () => finish(null));
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') go.click(); });
      setTimeout(() => { input.focus(); input.select(); }, 30);
    });
  }

  // a toast with a button (the built-in one is text only)
  let toastTimer = null;
  function actionToast(text, label, onClick) {
    let t = document.getElementById('fxToast');
    if (!t) { t = el('div', 'fx-toast'); t.id = 'fxToast'; document.body.appendChild(t); }
    t.replaceChildren(el('span', null, text));
    if (label) { const b = el('button', 'btn small-btn', label); b.addEventListener('click', () => { t.classList.remove('show'); onClick(); }); t.appendChild(b); }
    const x = el('button', 'fx-x'); x.innerHTML = ICON_X; x.setAttribute('aria-label', 'Dismiss'); x.addEventListener('click', () => t.classList.remove('show')); t.appendChild(x);
    t.classList.add('show'); clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), 20000);
  }
  fx.actionToast = actionToast;

  // ==========================================================================
  // Which levels have I beaten? (shared by "pick a level" and "what if")
  // ==========================================================================
  const SOURCES = [
    { id: 'personal',     label: 'Personal list',                         auth: false },
    { id: 'sub-accepted', label: 'Submissions (accepted)',                auth: true },
    { id: 'sub-all',      label: 'Submissions (accepted + pending)',   auth: true },
    { id: 'account',      label: 'Account (levels marked completed)', auth: true },
  ];
  const PENDING_LIKE = new Set(['pending', 'claimed', 'under consideration', 'under review']);
  const subsCache = new Map(); // mode -> items (kept for this session)
  async function submissionsFor(mode) {
    if (subsCache.has(mode)) return subsCache.get(mode);
    let arr = [];
    try {
      const data = await window.aredl.getSubmissions(mode);
      arr = Array.isArray(data) ? data : (data.data || data.submissions || data.items || data.results || []);
    } catch { arr = null; }
    if (arr) subsCache.set(mode, arr);
    return arr || [];
  }
  // -> Set of level ids (as strings) in `mode` that count as beaten under `source`
  async function beatenIds(source, mode) {
    const out = new Set();
    if (source === 'personal') {
      try { await loadPersonal(); } catch { /* none */ }
      personalList.filter(e => (e.mode || 'classic') === mode && plIsDone(e)).forEach(e => { const id = plResolve(e).jumpId ?? e.level_id; if (id != null) out.add(String(id)); });
    } else if (source === 'account') {
      await ensureLevels(mode);
      modeStore[mode].completedIds.forEach(id => out.add(String(id)));
    } else {
      const wantPending = source === 'sub-all';
      (await submissionsFor(mode)).forEach(item => {
        const st = String(subStatus(item)).toLowerCase(), id = subLevelId(item);
        if (id != null && (st === 'accepted' || st === 'approved' || (wantPending && PENDING_LIKE.has(st)))) out.add(String(id));
      });
    }
    return out;
  }
  fx.beatenIds = beatenIds;
  const sourceSelect = (selected) => {
    const sel = el('select', 'fx-select');
    SOURCES.forEach(s => { const o = el('option', null, s.label + (s.auth && !state.signedIn ? ' – sign in first' : '')); o.value = s.id; o.disabled = s.auth && !state.signedIn; sel.appendChild(o); });
    sel.value = SOURCES.find(s => s.id === selected && !(s.auth && !state.signedIn)) ? selected : 'personal';
    return sel;
  };

  // ==========================================================================
  // Command palette (Ctrl / Cmd + K)
  // ==========================================================================
  const players = { rows: [], loaded: false, loading: false };
  async function loadPlayers() {
    if (players.loaded || players.loading) return;
    players.loading = true;
    try {
      const seen = new Set();
      for (const page of [1, 2, 3]) {
        const d = await window.aredl.getLeaderboard(page, 'classic');
        (Array.isArray(d) ? d : (d.data || [])).forEach(r => { const u = r.user; if (u && u.id && !seen.has(u.id)) { seen.add(u.id); players.rows.push({ id: u.id, name: personName(u) || '', rank: r.rank }); } });
        if (page >= (d.pages || 1)) break;
      }
      players.loaded = true;
    } catch { /* offline: the palette still finds levels and tabs */ }
    players.loading = false;
  }
  const norm = (t) => String(t || '').toLowerCase();
  function paletteActions() {
    const tabs = [...document.querySelectorAll('.nav-btn[data-tab]')].map(b => ({ id: b.dataset.tab, label: (b.textContent || '').trim() })).filter(t => t.label);
    const items = tabs.map(t => ({ kind: 'Go to', label: t.label, hint: `Opens the ${t.label} tab`, keys: `open ${t.label} tab`, run: () => showTab(t.id) }));
    items.push(
      { kind: 'Action', label: 'Pick a level', hint: 'Rolls a random level to play, using your filters', keys: 'pick a random level to play dice roll next what should i play', run: () => fx.openPicker() },
      { kind: 'Action', label: 'Points what-if', hint: 'Opens the calculator for points and rank after beating a level', keys: 'open the points what-if calculator rank points calculator if', run: () => fx.openWhatIf() },
      { kind: 'Action', label: 'Personal list stats', hint: 'Shows charts and the yearly recap of the personal list', keys: 'show your personal list stats statistics charts recap', run: () => { showTab('personal'); fx.showStats(true); } },
      { kind: 'Action', label: 'Google Drive sync', hint: 'Opens Sync now for the Google Drive folder', keys: 'sync with google drive now google drive sync', run: () => { showTab('settings'); setTimeout(() => { const b = $('#syncNowBtn'); if (b && !b.closest('[hidden]')) b.click(); else showToast('Choose a sync folder in Settings first'); }, 400); } },
      { kind: 'Action', label: 'Export and import', hint: 'Opens the export and import settings for settings, favourites and lists', keys: 'export or import your data backup export import', run: () => { showTab('settings'); setTimeout(() => { const s = $('#settingsSearch'); if (s) { s.value = 'export'; s.dispatchEvent(new Event('input')); } }, 300); } },
      { kind: 'Action', label: 'Saved filters', hint: 'Opens the saved filters menu in the Demon List', keys: 'apply or save a demon list filter filter preset', run: () => { showTab('list'); setTimeout(() => fx.openFiltersMenu(), 120); } },
    );
    (fx.lists || []).forEach(l => items.push({ kind: 'List', label: l.name, hint: `Opens this list · ${plural(l.items.length, 'level')}`, keys: `open the list ${l.name}`, run: () => fx.openList(l.id) }));
    (fx.filters || []).forEach(f => items.push({ kind: 'Filter', label: f.name, hint: `Applies this filter in the Demon List · ${modeLabel(f.mode)}`, keys: `apply the filter ${f.name}`, run: () => { showTab('list'); fx.applySavedFilter(f); } }));
    return items;
  }
  function paletteSearch(q) {
    const query = norm(q).trim();
    const acts = paletteActions();
    if (!query) return acts;
    const out = [];
    const scoreText = (text, keys) => { const t = norm(text); if (t === query) return 100; if (t.startsWith(query)) return 80; if (t.includes(query)) return 55; if (keys && norm(keys).includes(query)) return 35; return 0; };
    acts.forEach(a => { const s = scoreText(a.label, a.keys); if (s) out.push({ ...a, score: s + 10 }); });
    // levels from both lists: by name, by ID, by "#position"
    const posQ = /^#?\d{1,4}$/.test(query) ? Number(query.replace('#', '')) : null;
    const lv = [];
    MODES.forEach(m => levelsOf(m).forEach(l => {
      let s = scoreText(l.name, '');
      if (!s && /^\d{3,}$/.test(query) && String(l.level_id).startsWith(query)) s = 60;
      if (!s && posQ != null && query.startsWith('#') && l.position === posQ) s = 90;
      if (!s && songLabelOf(l.song) && norm(songLabelOf(l.song)).includes(query)) s = 30;
      if (s) lv.push({ kind: 'Level', label: l.name, hint: `Opens this level in the Demon List · ${l.position != null ? '#' + l.position + ' · ' : ''}${modeLabel(m)}${s === 30 && l.song > 0 && songLabelOf(l.song) ? ' · ♪ ' + songLabelOf(l.song) : ''}`, score: s, run: () => jumpToLevel(l.level_id) });
    }));
    lv.sort((a, b) => b.score - a.score).slice(0, 40).forEach(x => out.push(x));
    players.rows.filter(p => norm(p.name).includes(query)).sort((a, b) => (norm(a.name).startsWith(query) ? 0 : 1) - (norm(b.name).startsWith(query) ? 0 : 1) || a.rank - b.rank).slice(0, 15)
      .forEach(p => out.push({ kind: 'Player', label: p.name, hint: `Opens this player’s profile · #${p.rank} on the leaderboard`, score: 50, run: () => { showTab('profile'); $('#profileLookup').value = p.id; lookupProfile(p.id); } }));
    deepSearch(query).forEach(x => out.push(x));
    return out.sort((a, b) => b.score - a.score).slice(0, 300);
  }
  // Anything that mentions the typed words: settings, submissions, personal list, notifications, changelogs, favourites, followed levels, lists, level descriptions.
  function snippet(text, q) {
    const t = String(text).replace(/\s+/g, ' '), i = t.toLowerCase().indexOf(q);
    if (i < 0) return '';
    return (i > 28 ? '…' : '') + t.slice(Math.max(0, i - 28), i + q.length + 36).trim() + (i + q.length + 36 < t.length ? '…' : '');
  }
  const flat = (o, depth = 0) => (o == null ? '' : typeof o === 'object' ? (depth > 3 ? '' : Object.values(o).map(v => flat(v, depth + 1)).join(' ')) : String(o));
  function deepSearch(q) {
    if (q.length < 2) return [];
    const out = [], seen = new Set();
    // `label` says what choosing the result does; `ctx` says where it is (the matched text is only used to decide that it matches)
    const add = (kind, label, text, run, base = 30, key = null, ctx = null) => {
      const t = norm(text);
      if (!t.includes(q)) return;
      const k = key || `${kind}:${label}`; if (seen.has(k)) return; seen.add(k);
      out.push({ kind, label: label || '(untitled)', hint: ctx != null ? ctx : snippet(text, q), score: base + (norm(label).includes(q) ? 12 : 0), run });
    };
    const cap = (n) => { let c = 0; return () => ++c <= n; };
    try { // settings: every option and card
      let ok = cap(25);
      document.querySelectorAll('#tab-settings .setting-line, #tab-settings > .settings-card, #tab-settings .api-logs > .settings-card').forEach(node => {
        if (node.matches('.api-logs .settings-card, .settings-card') && node.querySelector('.setting-line')) return;
        const label = (node.querySelector('.setting-label strong, h3') || {}).textContent || 'Setting', card = node.closest('.settings-card'), cname = card && card.querySelector('h3') ? card.querySelector('h3').textContent : '';
        const text = `${label} ${node.textContent}`;
        if (norm(text).includes(q) && ok()) add('Setting', label.trim(), text, () => { showTab('settings'); setTimeout(() => { node.scrollIntoView({ block: 'center' }); node.classList.add('fx-flash'); setTimeout(() => node.classList.remove('fx-flash'), 1800); }, 250); }, 28, `set:${cname}:${label}`, `Opens this setting · Settings${cname ? ' › ' + cname.trim() : ''}`);
      });
    } catch { /* settings not drawn */ }
    try { let ok = cap(25); (typeof submissionsData !== 'undefined' ? submissionsData : []).forEach(it => { const text = flat(it); if (norm(text).includes(q) && ok()) add('Submission', subLevelName(it) || 'A level', text, () => { showTab('submissions'); const id = subLevelId(it); if (id != null) jumpToSubmission(id); }, 32, `sub:${subKey(it)}`, `Opens this submission in Submissions${it && it.status ? ' · ' + String(it.status) : ''}`); }); } catch { /* none */ }
    try { let ok = cap(25); personalList.forEach((e, i) => { const r = plResolve(e), text = `${r.name} ${flat(e)}`; if (norm(text).includes(q) && ok()) add('Personal', r.name || 'Level', text, () => { showTab('personal'); fx.showStats(false); setTimeout(() => plOpen(e), 150); }, 32, `pl:${i}`, `Opens this entry to edit · Personal list · ${plRunText(e)}`); }); } catch { /* none */ }
    try { let ok = cap(25); notifAll.forEach((n, i) => { const text = flat(n); if (norm(text).includes(q) && ok()) add('Notification', String(n.title || n.message || n.text || n.type || 'Notification').replace(/\s+/g, ' ').slice(0, 60), text, () => showTab('notifications'), 30, `n:${i}`, 'Opens the Notifications tab'); }); } catch { /* none */ }
    try { let ok = cap(25); changelogEntries.forEach((c, i) => { const text = flat(c); if (norm(text).includes(q) && ok()) add('List changelog', String(describeChange(c, '')).replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').slice(0, 60) || 'Changelog entry', text, () => showTab('changelog'), 28, `cl:${i}`, 'Opens the Demon List changelog'); }); } catch { /* none */ }
    try { let ok = cap(25); APP_RELEASES.forEach(r => r.items.forEach(([, t, ttl], i) => { if (norm(`${r.title} ${ttl || ''} ${t}`).includes(q) && ok()) add('App changelog', ttl || r.title, `${r.title}. ${ttl || ''} ${t}`, () => { showTab('settings'); setTimeout(() => $('#whatsNewBtn').click(), 250); }, 26, `ac:${r.version}:${i}`, `Opens What’s new · app changelog for version ${r.version}`); })); } catch { /* none */ }
    try { let ok = cap(25); state.favourites.forEach(f => { const text = flat(f); if (norm(text).includes(q) && ok()) add('Favourite', f.name || String(f.level_id), text, () => { fx.view = null; showTab('favourites'); renderFavourites(); }, 33, `fav:${f.level_id}`, 'Opens the Favourites tab'); }); } catch { /* none */ }
    try { let ok = cap(25); state.following.concat(followNotifs || []).forEach((f, i) => { const text = flat(f); if (norm(text).includes(q) && ok()) add('Followed', f.name || f.level_name || String(f.level_id), text, () => showTab('followed'), 28, `fo:${f.mode || ''}:${f.level_id != null ? f.level_id : i}`, 'Opens the Followed levels tab'); }); } catch { /* none */ }
    try { let ok = cap(25); (fx.lists || []).forEach(l => l.items.forEach(it => { if (norm(it.name).includes(q) && ok()) add('List item', it.name, `${it.name} in ${l.name}`, () => fx.openList(l.id), 32, `li:${l.id}:${it.level_id}`, `Opens the list ${l.name}`); })); } catch { /* none */ }
    try { let ok = cap(25); MODES.forEach(m => levelsOf(m).forEach(l => { const tx = levelText(l); if (tx.hay.includes(q) && !tx.name.includes(q) && ok()) add('Level', l.name, `${l.description || ''} ${(l.tags || []).join(' ')}`, () => jumpToLevel(l.level_id), 24, `lv:${l.level_id}`, `Opens this level · matched in its description or tags · ${l.position != null ? '#' + l.position + ' · ' : ''}${modeLabel(m)}`); })); } catch { /* none */ }
    try { let ok = cap(25); (window.searchPacks ? window.searchPacks(q) : []).forEach(p => { if (ok()) add('Pack', p.name || 'Pack', `${p.name} ${p.tier} ${p.level}`, () => { showTab('packs'); window.openPack(p.id, p.mode); }, p.exact ? 40 : 30, `pk:${p.mode}:${p.id}`, `Opens this pack · ${p.tier} tier · ${plural(p.count, 'level')} · ${modeLabel(p.mode)}${p.level ? ' · contains ' + p.level : ''}`); }); } catch { /* packs not loaded */ }
    return out;
  }
  // ---- everything the palette searches is loaded quietly in the background (a few seconds after start-up, and again when the palette opens),
  // so no page has to be opened once first. Each source asks only once; the Packs, Notifications, Submissions and Changelog pages reuse the answers.
  const prepared = new Set();
  function prepareSearch(onChange) {
    const run = (key, fn) => {
      if (prepared.has(key)) return null;
      prepared.add(key);
      let p; try { p = Promise.resolve(fn()); } catch { p = Promise.resolve(); }
      return p.catch(() => { prepared.delete(key); }).then(() => { if (onChange) onChange(); });
    };
    return Promise.allSettled([
      run('levels', bothLevels), run('players', loadPlayers), run('personal', loadPersonal), run('followed', () => loadFollowStores()),
      run('packs', () => (window.prefetchPacks ? window.prefetchPacks() : null)),
      state.signedIn ? run('notifications', prefetchNotifications) : null,
      state.signedIn && !state.submissionsLoaded ? run('submissions', loadSubmissions) : null,
      !state.changelogLoaded ? run('changelog', () => loadChangelog(true)) : null,
    ].filter(Boolean));
  }
  fx.prepareSearch = prepareSearch;
  { const soon = () => setTimeout(() => prepareSearch(), 3000); if (window.appBooted) soon(); else window.addEventListener('aredl:ready', soon, { once: true }); }
  // After a result that opens a page of content is chosen, the page is searched for the text that matched: it is scrolled to and the spot is outlined for a moment.
  const FLASH_KINDS = new Set(['Submission', 'Notification', 'List changelog', 'Favourite', 'Followed', 'List item', 'Level']);
  const FLASH_ROWS = '.submission-card, .notif-item, .change-entry, .fav-card, .completed-banner, .list-row, .pack-card, .pack-banner';
  function flashFound(query) {
    const qn = norm(query).trim();
    if (qn.length < 2) return;
    const shown = (e) => !!e && e.getClientRects().length > 0 && !e.closest('.fx-overlay, .sel-pop, .debug-info, [hidden]');
    const find = () => {
      const root = document.querySelector('.tab.active') || document.body;
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        if (!n.nodeValue || norm(n.nodeValue).indexOf(qn) < 0) continue;
        const p = n.parentElement;
        if (p && !/^(SCRIPT|STYLE|TEXTAREA)$/.test(p.tagName) && shown(p)) return p;
      }
      return [...root.querySelectorAll(FLASH_ROWS)].find(r => shown(r) && norm(r.textContent).includes(qn)) || null; // words that span several elements
    };
    let tries = 0;
    const tick = () => {
      const hit = find();
      if (!hit) { if (++tries < 14) setTimeout(tick, 200); return; }
      const target = hit.closest(FLASH_ROWS) || hit;
      target.scrollIntoView({ block: 'center', behavior: 'smooth' });
      target.classList.add('fx-flash');
      setTimeout(() => target.classList.remove('fx-flash'), 1800);
    };
    setTimeout(tick, 300);
  }
  function openPalette(startQuery) {
    const start = typeof startQuery === 'string' ? startQuery.trim().slice(0, 120) : '';
    if (current && current.isPalette) {
      if (start) { const i = current.body.querySelector('.palette-input'); if (i) { i.value = start; i.dispatchEvent(new Event('input')); i.focus(); } return; }
      current.close(); return;
    }
    const m = openModal({ title: 'Command palette' });
    m.isPalette = true; m.box.classList.add('palette'); m.body.classList.add('palette-body');
    const input = el('input', 'fx-input palette-input'); input.type = 'text'; input.placeholder = 'Type a level, player, tab or action…'; input.spellcheck = false; input.setAttribute('aria-label', 'Search');
    const list = el('div', 'palette-list'); list.setAttribute('role', 'listbox');
    m.body.append(input, list, el('div', 'palette-foot', '↑ ↓ to move · Enter to open · Tab to cycle · Esc to close · ' + keyLabel(paletteKey()) + ' toggles'));
    const PAGE = 12; // rows shown at first; the rest appear as you go down
    let items = [], sel = 0, shown = PAGE;
    const markSel = () => { list.querySelectorAll('.palette-row').forEach((r, i) => r.classList.toggle('sel', i === sel)); const s = list.querySelector('.sel'); if (s) s.scrollIntoView({ block: 'nearest' }); };
    const draw = () => {
      list.replaceChildren();
      if (!items.length) { list.appendChild(el('div', 'palette-empty', input.value ? 'Nothing matches.' : 'Nothing to show yet.')); return; }
      shown = Math.min(items.length, Math.max(shown, sel + 1));
      items.slice(0, shown).forEach((it, i) => {
        const row = el('div', 'palette-row' + (i === sel ? ' sel' : '')); row.setAttribute('role', 'option');
        row.append(el('span', 'palette-kind', it.kind), el('span', 'palette-label', it.label), el('span', 'palette-hint', it.hint || ''));
        row.addEventListener('mousemove', () => { if (sel !== i) { sel = i; markSel(); } });
        row.addEventListener('click', () => run(it));
        list.appendChild(row);
      });
      if (shown < items.length) list.appendChild(el('div', 'palette-more', `▾ ${plural(items.length - shown, 'more result')} · keep going down to see them`));
      markSel();
    };
    const run = (it) => { const typed = input.value; m.close(); try { it.run(); } catch (err) { showToast(`That didn't work: ${errMsg(err)}`); return; } if (FLASH_KINDS.has(it.kind)) flashFound(typed); };
    const refresh = (keep) => { const was = keep && sel > 0 ? items[sel] : null; items = paletteSearch(input.value); const at = was ? items.findIndex(x => x.kind === was.kind && x.label === was.label && x.hint === was.hint) : -1; if (at >= 0) sel = at; else { sel = 0; shown = PAGE; } draw(); };
    input.addEventListener('input', () => { shown = PAGE; refresh(); });
    list.addEventListener('scroll', () => { if (shown < items.length && list.scrollTop + list.clientHeight >= list.scrollHeight - 4) { shown = Math.min(items.length, shown + PAGE); const top = list.scrollTop; draw(); list.scrollTop = top; } });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown') { e.preventDefault(); sel = Math.min(items.length - 1, sel + 1); draw(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); sel = Math.max(0, sel - 1); draw(); }
      else if (e.key === 'Enter' && items[sel]) { e.preventDefault(); run(items[sel]); }
      else if (e.key === 'Tab' && items.length) { e.preventDefault(); sel = (sel + (e.shiftKey ? -1 : 1) + items.length) % items.length; draw(); } // Tab goes down the options (Shift+Tab up), round again at the ends
    });
    if (start) input.value = start;
    refresh(); setTimeout(() => { input.focus(); if (start) input.select(); }, 20);
    prepareSearch(() => { if (m.overlay.isConnected) refresh(true); }); // whatever is not loaded yet arrives while the palette is open
  }
  fx.openPalette = openPalette;
  // ---- the key that opens the palette (Settings > Command palette); stored as e.g. "`" or "Mod+k" (Mod = Ctrl, or Cmd on a Mac)
  // ---- highlighting text offers “Search in command palette” just underneath it ----
  (function selectionSearch() {
    let pop = null, timer = 0;
    const hide = () => { if (pop) { pop.remove(); pop = null; } };
    const insideOwn = (n) => { const e = n && (n.nodeType === 1 ? n : n.parentElement); return !!e && !!e.closest('.sel-pop, .palette, input, textarea, [contenteditable=true]'); };
    function show() {
      clearTimeout(timer);
      timer = setTimeout(() => {
        const sel = window.getSelection();
        const text = sel ? sel.toString().replace(/\s+/g, ' ').trim() : '';
        if (!sel || sel.isCollapsed || text.length < 2 || insideOwn(sel.anchorNode) || insideOwn(sel.focusNode)) { hide(); return; }
        const rects = sel.getRangeAt(0).getClientRects(), r = rects.length ? rects[rects.length - 1] : sel.getRangeAt(0).getBoundingClientRect();
        if (!r || (!r.width && !r.height)) { hide(); return; }
        hide();
        pop = el('div', 'sel-pop'); pop.setAttribute('role', 'menu');
        const b = el('button', 'sel-pop-btn', 'Search in command palette'); b.type = 'button'; b.setAttribute('role', 'menuitem');
        b.addEventListener('mousedown', (e) => e.preventDefault()); // keeps the highlight until it is used
        b.addEventListener('click', () => { const q = text.slice(0, 120); hide(); sel.removeAllRanges(); openPalette(q); });
        pop.appendChild(b); document.body.appendChild(pop);
        const w = pop.offsetWidth, h = pop.offsetHeight;
        pop.style.left = Math.max(8, Math.min(r.left, window.innerWidth - w - 8)) + 'px';
        pop.style.top = Math.max(8, Math.min(r.bottom + 6, window.innerHeight - h - 8)) + 'px';
      }, 60);
    }
    document.addEventListener('mouseup', (e) => { if (e.target.closest && e.target.closest('.sel-pop')) return; show(); });
    document.addEventListener('keyup', (e) => { if (e.shiftKey || e.key === 'Shift') show(); });
    document.addEventListener('mousedown', (e) => { if (!(e.target.closest && e.target.closest('.sel-pop'))) hide(); }, true);
    document.addEventListener('scroll', hide, true);
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') hide(); });
    window.addEventListener('blur', hide); window.addEventListener('resize', hide);
  })();
  const DEFAULT_PALETTE_KEY = '`';
  const paletteKey = () => (typeof appSettings.paletteKey === 'string' && appSettings.paletteKey ? appSettings.paletteKey : DEFAULT_PALETTE_KEY);
  const isMac = window.aredl && window.aredl.platform === 'darwin';
  const parseKey = (spec) => { const m = /^((?:(?:Mod|Alt|Shift)\+)*)(.+)$/.exec(spec) || [, '', DEFAULT_PALETTE_KEY]; return { mod: m[1].includes('Mod'), alt: m[1].includes('Alt'), shift: m[1].includes('Shift'), key: m[2].toLowerCase() }; };
  function keyLabel(spec) { const p = parseKey(spec); return [p.mod ? (isMac ? 'Cmd' : 'Ctrl') : '', p.alt ? 'Alt' : '', p.shift ? 'Shift' : '', p.key.length === 1 ? p.key.toUpperCase() : spec.split('+').pop()].filter(Boolean).join('+'); }
  function keyMatches(e, spec) {
    const p = parseKey(spec);
    if ((e.ctrlKey || e.metaKey) !== p.mod || e.altKey !== p.alt || e.shiftKey !== p.shift) return false;
    return e.key.toLowerCase() === p.key || (p.key === '`' && e.code === 'Backquote');
  }
  const typingIn = (t) => !!t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));
  let capturing = false;
  document.addEventListener('keydown', (e) => {
    if (capturing || e.repeat) return;
    const p = parseKey(paletteKey());
    if (typingIn(e.target) && !p.mod && !p.alt) return; // a plain key must not steal typing
    if (keyMatches(e, paletteKey())) { e.preventDefault(); openPalette(); }
  });
  function wirePaletteKey() {
    const btn = $('#paletteKeyBtn'), txt = $('#paletteKeyText'), reset = $('#paletteKeyReset');
    if (!btn) return;
    const show = () => { txt.textContent = keyLabel(paletteKey()); reset.hidden = paletteKey() === DEFAULT_PALETTE_KEY; };
    const stop = () => { capturing = false; btn.classList.remove('listening'); show(); document.removeEventListener('keydown', onKey, true); };
    function onKey(e) {
      e.preventDefault(); e.stopPropagation();
      if (e.key === 'Escape') { stop(); return; }
      if (['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) return;
      const spec = [e.ctrlKey || e.metaKey ? 'Mod+' : '', e.altKey ? 'Alt+' : '', e.shiftKey ? 'Shift+' : ''].join('') + (e.key.length === 1 ? e.key.toLowerCase() : e.key);
      if (!/^(?:(?:Mod|Alt|Shift)\+){0,3}\S{1,12}$/.test(spec)) { showToast('That key can’t be used'); return; }
      setSetting('paletteKey', spec); stop(); showToast(`Command palette key: ${keyLabel(spec)}`);
    }
    btn.addEventListener('click', () => { if (capturing) { stop(); return; } capturing = true; btn.classList.add('listening'); txt.textContent = 'Press a key…'; document.addEventListener('keydown', onKey, true); });
    reset.addEventListener('click', () => { setSetting('paletteKey', DEFAULT_PALETTE_KEY); show(); });
    show();
  }

  // ==========================================================================
  // Pick a level for me
  // ==========================================================================
  const PICK_DEFAULT = { mode: 'classic', posMin: null, posMax: null, edelMin: null, edelMax: null, tags: {}, status: '__all__', hideBeaten: true, source: 'personal' };
  let lastPicked = null;
  fx.openPicker = async function openPicker() {
    const had = appSettings.pickFilter && typeof appSettings.pickFilter === 'object';
    const f = { ...PICK_DEFAULT, search: '', ...(had ? appSettings.pickFilter : {}) };
    if (!had || !MODES.includes(f.mode)) f.mode = tabModes.list; // closing and reopening keeps the list, filters and the level shown
    f.tags = { ...(f.tags || {}) };
    const m = openModal({ title: 'Pick a level', wide: true });
    m.body.appendChild(el('div', 'fx-note', 'Loading the lists…'));
    await bothLevels();
    if (!m.overlay.isConnected) return;
    const save = () => setSetting('pickFilter', { ...f });
    let matches = [], picked = (lastPicked && anyLevel(lastPicked)) || null, token = 0;

    const draw = () => {
      m.body.replaceChildren();
      const form = el('div', 'fx-form');
      // list
      const modeRow = el('div', 'fx-field'); modeRow.appendChild(el('span', 'fx-label', 'List'));
      const seg = el('div', 'fx-seg');
      MODES.forEach(md => { const b = el('button', 'fx-seg-btn' + (f.mode === md ? ' on' : ''), modeLabel(md)); b.type = 'button'; b.addEventListener('click', () => { if (f.mode !== md) { f.mode = md; f.tags = {}; f.status = '__all__'; save(); draw(); recompute(); } }); seg.appendChild(b); });
      modeRow.appendChild(seg); form.appendChild(modeRow);
      // ranges
      const range = (label, kMin, kMax, max, ph) => {
        const row = el('div', 'fx-field'); row.appendChild(el('span', 'fx-label', label));
        const a = el('input', 'fx-input small'); a.type = 'number'; a.min = 0; a.max = max; a.placeholder = ph[0]; a.value = f[kMin] ?? '';
        const b = el('input', 'fx-input small'); b.type = 'number'; b.min = 0; b.max = max; b.placeholder = ph[1]; b.value = f[kMax] ?? '';
        a.addEventListener('change', () => { f[kMin] = num(a.value); save(); recompute(); }); b.addEventListener('change', () => { f[kMax] = num(b.value); save(); recompute(); });
        row.append(a, el('span', 'fx-dash', '–'), b); return row;
      };
      if (fx.filters.length) { // any saved filter can be used here
        const row = el('div', 'fx-field wide'); row.appendChild(el('span', 'fx-label', 'Saved filter'));
        const sel = el('select', 'fx-select'); const none = el('option', null, 'None'); none.value = ''; sel.appendChild(none);
        fx.filters.forEach(sf => { const o = el('option', null, `${sf.name} (${modeLabel(sf.mode)})`); o.value = sf.id; sel.appendChild(o); });
        sel.value = fx.filters.some(sf => sf.id === f.savedId) ? f.savedId : '';
        sel.addEventListener('change', () => {
          const sf = fx.filters.find(x => x.id === sel.value); f.savedId = sel.value;
          if (sf) { f.mode = MODES.includes(sf.mode) ? sf.mode : f.mode; f.status = sf.status || '__all__'; f.tags = { ...(sf.tags || {}) }; f.edelMin = sf.edelMin ?? null; f.edelMax = sf.edelMax ?? null; f.search = sf.search || ''; }
          save(); draw(); recompute();
        });
        row.appendChild(sel); form.appendChild(row);
      }
      { const row = el('div', 'fx-field wide'); row.appendChild(el('span', 'fx-label', 'Search text (same syntax as the Demon List search)'));
        const inp = el('input', 'fx-input'); inp.type = 'text'; inp.value = f.search || ''; inp.spellcheck = false; inp.placeholder = 'Optional';
        inp.addEventListener('change', () => { f.search = inp.value; f.savedId = ''; save(); recompute(); });
        row.appendChild(inp); form.appendChild(row); }
      form.appendChild(range('Position', 'posMin', 'posMax', 5000, ['1', 'any']));
      form.appendChild(range('EDEL enjoyment', 'edelMin', 'edelMax', 100, ['0', '100']));
      // status
      const statuses = [...new Set(levelsOf(f.mode).map(l => levelStatusLabel(l)).filter(Boolean))];
      if (statuses.length > 1) {
        const row = el('div', 'fx-field'); row.appendChild(el('span', 'fx-label', 'Which part of the list'));
        const sel = el('select', 'fx-select'); const any = el('option', null, 'Anywhere'); any.value = '__all__'; sel.appendChild(any);
        statuses.forEach(s => { const o = el('option', null, s); o.value = s; sel.appendChild(o); });
        sel.value = statuses.includes(f.status) ? f.status : '__all__';
        sel.addEventListener('change', () => { f.status = sel.value; save(); recompute(); });
        row.appendChild(sel); form.appendChild(row);
      }
      // tags: click = must have (green), again = must not have (red), again = off
      const tags = [...new Set(levelsOf(f.mode).flatMap(l => (l.tags || []).map(t => String(t).toLowerCase())))].sort();
      if (tags.length) {
        const row = el('div', 'fx-field wide'); row.appendChild(el('span', 'fx-label', 'Tags  (click: must have · again: must not have · again: off)'));
        const chips = el('div', 'fx-chips');
        tags.forEach(t => {
          const c = el('button', 'fx-chip' + (f.tags[t] === 'include' ? ' inc' : f.tags[t] === 'exclude' ? ' exc' : ''), t); c.type = 'button';
          c.addEventListener('click', () => { const cur = f.tags[t]; if (!cur) f.tags[t] = 'include'; else if (cur === 'include') f.tags[t] = 'exclude'; else delete f.tags[t]; save(); c.className = 'fx-chip' + (f.tags[t] === 'include' ? ' inc' : f.tags[t] === 'exclude' ? ' exc' : ''); f.savedId = ''; recompute(); });
          chips.appendChild(c);
        });
        row.appendChild(chips); form.appendChild(row);
      }
      // levels I've beaten
      const beatRow = el('div', 'fx-field wide');
      const lab = el('label', 'fx-check'); const cb = el('input'); cb.type = 'checkbox'; cb.checked = f.hideBeaten;
      lab.append(cb, document.createTextNode(' Leave out levels already beaten, according to'));
      const src = sourceSelect(f.source);
      f.source = src.value;
      cb.addEventListener('change', () => { f.hideBeaten = cb.checked; save(); recompute(); });
      src.addEventListener('change', () => { f.source = src.value; save(); recompute(); });
      beatRow.append(lab, src); form.appendChild(beatRow);
      m.body.appendChild(form);
      m.body.appendChild(el('div', 'fx-result', ''));
      renderResult();
    };

    const renderResult = () => {
      const box = m.body.querySelector('.fx-result'); if (!box) return;
      box.replaceChildren();
      box.appendChild(el('div', 'fx-count', matches.length ? `${plural(matches.length, 'level')} match` : 'No levels match these filters.'));
      if (!picked) return;
      const l = picked;
      const card = el('div', 'fx-pick');
      const top = el('div', 'fx-pick-top');
      top.appendChild(el('span', 'fx-pick-pos', l.position != null ? `#${l.position}` : (levelStatusLabel(l) || '—')));
      top.appendChild(el('span', 'fx-pick-name', l.name));
      card.appendChild(top);
      const meta = el('div', 'fx-pick-meta');
      if (l.points != null) meta.appendChild(el('span', 'fav-pill stat pts', '')).innerHTML = `<b>${escapeHtml(formatPoints(l.points))}</b><small>pts</small>`;
      if (l.edel_enjoyment != null) meta.appendChild(el('span', 'fav-pill stat edel', '')).innerHTML = `<small>EDEL</small><b>${escapeHtml(enjText(l))}</b>`;
      (l.tags || []).slice(0, 8).forEach(t => meta.appendChild(el('span', 'tag', t)));
      card.appendChild(meta);
      const song = l.song > 0 ? songLabelOf(l.song) : '';
      if (song) card.appendChild(el('div', 'fav-card-song', `♪ ${song}`));
      const row = el('div', 'fx-row');
      const again = el('button', 'btn small-btn', matches.length > 1 ? 'Another one' : 'Roll again'); again.addEventListener('click', roll);
      const key = (x) => (x.position != null ? x.position : 100000 - (x.points || 0) / 10);
      const near = (dir) => { // a harder (closer to #1) or easier level, picked from a few that match a little way off
        const k = key(l), pool = matches.filter(x => x !== l && (dir < 0 ? key(x) < k : key(x) > k)).sort((a, b) => (dir < 0 ? key(b) - key(a) : key(a) - key(b)));
        const skip = Math.min(2, pool.length - 1); // jumps a little further than the next level: the 3rd to 7th nearest (fewer when few match)
        return pool.slice(Math.max(0, skip), Math.max(0, skip) + 5);
      };
      const mk = (label, dir) => { const b = el('button', 'btn btn-ghost small-btn', label); b.disabled = !near(dir).length; b.addEventListener('click', () => { const p = near(dir); if (p.length) { picked = p[Math.floor(Math.random() * p.length)]; lastPicked = String(picked.level_id); renderResult(); } }); return b; };
      const harder = mk('↑ Harder', -1), easier = mk('↓ Easier', 1);
      const show = el('button', 'btn btn-ghost small-btn', 'Show in the Demon List'); show.addEventListener('click', () => { m.close(); jumpToLevel(l.level_id); });
      const fav = el('button', 'btn btn-ghost small-btn', isFavourite(l.level_id) ? '★ In favourites' : '☆ Favourite'); fav.addEventListener('click', async () => { await toggleFavourite(l); fav.textContent = isFavourite(l.level_id) ? '★ In favourites' : '☆ Favourite'; });
      const list = el('button', 'btn btn-ghost small-btn', 'Add to a list…'); list.addEventListener('click', () => { const r = list.getBoundingClientRect(); fx.openListsMenu(l, { x: r.left, y: r.bottom + 6 }); });
      row.append(again, harder, easier, show, fav, list); card.appendChild(row);
      box.appendChild(card);
    };

    const roll = () => {
      if (!matches.length) { picked = null; renderResult(); return; }
      let l = matches[Math.floor(Math.random() * matches.length)];
      if (matches.length > 1) for (let i = 0; i < 6 && lastPicked && String(l.level_id) === lastPicked; i++) l = matches[Math.floor(Math.random() * matches.length)];
      picked = l; lastPicked = String(l.level_id); renderResult();
    };

    const recompute = async () => {
      const mine = ++token;
      const beaten = f.hideBeaten ? await beatenIds(f.source, f.mode) : new Set();
      if (mine !== token || !m.overlay.isConnected) return;
      const inc = Object.keys(f.tags).filter(t => f.tags[t] === 'include'), exc = Object.keys(f.tags).filter(t => f.tags[t] === 'exclude');
      const sTerms = f.search && f.search.trim() ? searchTerms(f.search) : [];
      matches = levelsOf(f.mode).filter(l => {
        if (sTerms.length) { const tx = levelText(l); if (!sTerms.some(t => levelMatchesTerm(l, t, tx.hay, tx.name))) return false; }
        if (f.status !== '__all__' && levelStatusLabel(l) !== f.status) return false;
        if (f.posMin != null && (l.position == null || l.position < f.posMin)) return false;
        if (f.posMax != null && (l.position == null || l.position > f.posMax)) return false;
        if (f.edelMin != null || f.edelMax != null) { const e = l.edel_enjoyment; if (e == null || (f.edelMin != null && e < f.edelMin) || (f.edelMax != null && e > f.edelMax)) return false; }
        if (inc.length || exc.length) { const tl = (l.tags || []).map(t => String(t).toLowerCase()); if (inc.some(t => !tl.includes(t)) || exc.some(t => tl.includes(t))) return false; }
        if (beaten.has(String(l.level_id))) return false;
        return true;
      });
      const keep = picked && matches.find(x => String(x.level_id) === String(picked.level_id));
      if (keep) { picked = keep; renderResult(); } else roll(); // the level only changes when it no longer fits the filters
    };
    draw(); recompute();
  };

  // ==========================================================================
  // Points what-if
  // ==========================================================================
  const lb = { classic: { pages: 0, per: 100, count: 0, cache: new Map() }, platformer: { pages: 0, per: 100, count: 0, cache: new Map() } }; // 100 is the most a page can hold
  async function lbPage(mode, p) {
    const L = lb[mode];
    if (L.cache.has(p)) return L.cache.get(p);
    const d = await window.aredl.getLeaderboard(p, mode, 100);
    const rows = Array.isArray(d) ? d : (d.data || []);
    if (d.pages) L.pages = d.pages; if (d.per_page) L.per = d.per_page; if (d.count != null) L.count = d.count;
    L.cache.set(p, rows);
    return rows;
  }
  // How many players have MORE than `raw` points (rank = that + 1). The board is sorted from the top, so this is a search over
  // pages of 100: start in the middle, and every page tells which half to look in next. It stops the moment a page's range
  // contains the target. `hi` lets a second search (a higher score is always nearer the top) start from where the first ended.
  async function rankFor(raw, mode, hi) {
    const L = lb[mode];
    if (!L.pages) { const first = await lbPage(mode, 1); if (!first.length) return null; if (!L.pages) L.pages = 1; }
    const total = L.count || L.per * L.pages;
    let lo = 1; hi = Math.min(hi || L.pages, L.pages);
    while (lo <= hi) {
      const mid = (lo + hi) >> 1, rows = await lbPage(mode, mid);
      if (!rows.length) { hi = mid - 1; continue; }
      if (rows[rows.length - 1].total_points > raw) { lo = mid + 1; continue; }          // everyone here is above: look lower down
      if (rows[0].total_points <= raw) { hi = mid - 1; continue; }                        // nobody here is above: look nearer the top
      return { rank: (mid - 1) * L.per + rows.filter(r => r.total_points > raw).length + 1, of: total, page: mid };
    }
    return { rank: Math.min((lo - 1) * L.per, total) + 1, of: total, page: Math.max(1, Math.min(lo, L.pages)) };
  }
  // what the chosen source adds up to (in the tenths the API uses)
  async function baseTotal(source, mode) {
    const ids = await beatenIds(source, mode);
    let raw = 0, n = 0;
    if (source === 'personal') {
      personalList.filter(e => (e.mode || 'classic') === mode && plIsDone(e)).forEach(e => { const r = plResolve(e); if (r.pointsNum != null) { raw += r.pointsNum * 10; n++; } });
    } else {
      ids.forEach(id => { const l = levelOf(mode, id); if (l && l.points != null) { raw += l.points; n++; } });
    }
    return { raw, n, ids };
  }
  fx.openWhatIf = async function openWhatIf() {
    const f = { mode: tabModes.personal || 'classic', source: 'personal', extra: 0, picks: [] };
    const m = openModal({ title: 'Points what-if', wide: true });
    m.body.appendChild(el('div', 'fx-note', 'Loading…'));
    await bothLevels(); try { await loadPersonal(); } catch { /* none */ }
    if (!m.overlay.isConnected) return;
    let token = 0, beaten = new Set();
    const form = el('div', 'fx-form');
    const rowMode = el('div', 'fx-field'); rowMode.appendChild(el('span', 'fx-label', 'List'));
    const seg = el('div', 'fx-seg');
    const segBtns = MODES.map(md => { const b = el('button', 'fx-seg-btn' + (f.mode === md ? ' on' : ''), modeLabel(md)); b.type = 'button'; b.addEventListener('click', () => { f.mode = md; f.picks = []; segBtns.forEach((x, i) => x.classList.toggle('on', MODES[i] === md)); recalc(); }); seg.appendChild(b); return b; });
    rowMode.appendChild(seg);
    const rowSrc = el('div', 'fx-field'); rowSrc.appendChild(el('span', 'fx-label', 'Based on'));
    const src = sourceSelect('personal'); src.addEventListener('change', () => { f.source = src.value; recalc(); }); rowSrc.appendChild(src);
    const rowExtra = el('div', 'fx-field'); rowExtra.appendChild(el('span', 'fx-label', 'Extra points (packs…)'));
    const extra = el('input', 'fx-input small'); extra.type = 'number'; extra.min = 0; extra.step = '0.1'; extra.value = '0'; extra.addEventListener('change', () => { f.extra = Math.max(0, num(extra.value) || 0); recalc(); });
    rowExtra.append(extra, el('span', 'fx-hint', 'points that don’t come from levels'));
    const rowAdd = el('div', 'fx-field wide'); rowAdd.appendChild(el('span', 'fx-label', 'After beating…'));
    const addWrap = el('div', 'fx-add');
    const search = el('input', 'fx-input'); search.type = 'text'; search.placeholder = 'Type a level name or position…'; search.spellcheck = false;
    const sugg = el('div', 'fx-sugg'); sugg.hidden = true;
    addWrap.append(search, sugg); rowAdd.appendChild(addWrap);
    const chips = el('div', 'fx-chips picks');
    form.append(rowMode, rowSrc, rowExtra, rowAdd, chips);
    const out = el('div', 'fx-whatif-out');
    m.body.replaceChildren(form, out, el('div', 'fx-note small', 'Points are added up from the levels in your chosen source, plus any extra points you enter (the real total can also include pack points). Ranks are worked out against the current leaderboard.'));

    const drawChips = () => {
      chips.replaceChildren();
      f.picks.forEach(l => {
        const c = el('span', 'fx-chip pick' + (beaten.has(String(l.level_id)) ? ' dim' : ''), `${l.position != null ? '#' + l.position + ' ' : ''}${l.name} · +${pts(l.points)}${beaten.has(String(l.level_id)) ? ' (already counted)' : ''}`);
        const x = el('button', 'fx-chip-x'); x.type = 'button'; x.innerHTML = ICON_X; x.setAttribute('aria-label', 'Remove');
        x.addEventListener('click', () => { f.picks = f.picks.filter(p => p !== l); recalc(); }); c.appendChild(x); chips.appendChild(c);
      });
    };
    const showSugg = () => {
      const q = norm(search.value).trim();
      sugg.replaceChildren();
      if (!q) { sugg.hidden = true; return; }
      const posQ = /^#?\d+$/.test(q) ? Number(q.replace('#', '')) : null;
      const hits = levelsOf(f.mode).filter(l => !f.picks.includes(l) && !beaten.has(String(l.level_id)) && (norm(l.name).includes(q) || (posQ != null && l.position === posQ))).slice(0, 8);
      hits.forEach(l => { const r = el('button', 'fx-sugg-row'); r.type = 'button'; r.append(el('span', 'fx-sugg-pos', l.position != null ? `#${l.position}` : '—'), el('span', null, l.name), el('span', 'fx-sugg-pts', `+${pts(l.points)}`)); r.addEventListener('mousedown', (e) => { e.preventDefault(); f.picks.push(l); search.value = ''; sugg.hidden = true; recalc(); }); sugg.appendChild(r); });
      if (!hits.length) sugg.appendChild(el('div', 'fx-sugg-none', 'No unbeaten level matches.'));
      sugg.hidden = false;
    };
    search.addEventListener('input', showSugg); search.addEventListener('focus', showSugg); search.addEventListener('blur', () => setTimeout(() => { sugg.hidden = true; }, 120));

    const recalc = async () => {
      const mine = ++token;
      out.replaceChildren(el('div', 'fx-note', 'Working it out…'));
      let base, now, after;
      try {
        base = await baseTotal(f.source, f.mode); beaten = base.ids;
        if (mine !== token) return;
        drawChips();
        const gain = f.picks.filter(l => !beaten.has(String(l.level_id))).reduce((s, l) => s + (l.points || 0), 0);
        const extraRaw = f.extra * 10;
        const nowRaw = base.raw + extraRaw, afterRaw = nowRaw + gain;
        now = await rankFor(nowRaw, f.mode); after = gain ? await rankFor(afterRaw, f.mode, now ? now.page : undefined) : now;
        if (mine !== token) return;
        out.replaceChildren();
        const grid = el('div', 'fx-whatif-grid');
        const tile = (title, pointsRaw, rank, extraText) => { const t = el('div', 'fx-tile'); t.appendChild(el('div', 'fx-tile-title', title)); t.appendChild(el('div', 'fx-tile-big', `${pts(pointsRaw)} pts`)); t.appendChild(el('div', 'fx-tile-sub', rank ? `Rank #${rank.rank.toLocaleString()} of ${Number(rank.of).toLocaleString()}` : 'Rank unavailable')); if (extraText) t.appendChild(el('div', 'fx-tile-sub dim', extraText)); return t; };
        grid.appendChild(tile('Now', nowRaw, now, plural(base.n, 'level') + (f.extra ? ` + ${f.extra} extra` : '')));
        const arrow = el('div', 'fx-arrow', '→'); grid.appendChild(arrow);
        const moved = now && after ? now.rank - after.rank : 0;
        grid.appendChild(tile('After', afterRaw, after, f.picks.length ? `+${pts(gain)} pts` + (moved > 0 ? ` · up ${plural(moved, 'place')}` : moved === 0 ? ' · same rank' : '') : 'pick a level above'));
        out.appendChild(grid);
        if (!now) out.appendChild(el('div', 'fx-note small', 'The leaderboard couldn’t be loaded, so there are no ranks. The points are still right.'));
      } catch (err) {
        if (mine === token) out.replaceChildren(el('div', 'fx-note', `Couldn’t work that out (${errMsg(err)}).`));
      }
    };
    recalc();
  };

  // ==========================================================================
  // Stats for the personal list
  // ==========================================================================
  let statsOn = false, statsYear = 'all', recapYear = null;
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  function bars(items, { max, fmt = (v) => v, cls = '' } = {}) { // items: [{label, value, title}]
    const top = max || Math.max(1, ...items.map(i => i.value));
    const wrap = el('div', 'fx-bars ' + cls);
    items.forEach(i => {
      const row = el('div', 'fx-bar-row'); if (i.title) row.title = i.title;
      row.appendChild(el('span', 'fx-bar-label', i.label));
      const track = el('span', 'fx-bar-track'), fill = el('span', 'fx-bar-fill'); fill.style.width = `${Math.max(i.value ? 2 : 0, (i.value / top) * 100)}%`; track.appendChild(fill);
      row.append(track, el('span', 'fx-bar-val', fmt(i.value)));
      wrap.appendChild(row);
    });
    return wrap;
  }
  function renderStats() {
    const box = $('#plStats'); if (!box) return;
    box.replaceChildren();
    const mode = tabModes.personal;
    const entries = plEntries();
    const done = entries.filter(plIsDone).map(e => ({ e, r: plResolve(e), date: plDate(e.date), attempts: num(e.attempts) }));
    const runs = entries.length - done.length;
    const head = el('div', 'fx-stats-head');
    head.appendChild(el('strong', null, `${modeLabel(mode)} list – stats`));
    const close = el('button', 'btn btn-ghost small-btn', 'Back to the list'); close.addEventListener('click', () => fx.showStats(false)); head.appendChild(close);
    box.appendChild(head);
    if (!done.length) { box.appendChild(el('div', 'state', 'Nothing to chart yet: completed levels in your personal list will show up here.')); return; }

    const dated = done.filter(x => x.date);
    const years = [...new Set(dated.map(x => x.date.getFullYear()))].sort((a, b) => a - b);
    if (statsYear !== 'all' && !years.includes(Number(statsYear))) statsYear = 'all';
    if (recapYear == null || !years.includes(recapYear)) recapYear = years.length ? years[years.length - 1] : null;
    const totalPts = done.reduce((s, x) => s + (x.r.pointsNum || 0), 0);
    const att = done.filter(x => x.attempts != null);
    const totalAttempts = att.reduce((s, x) => s + x.attempts, 0);
    const hardest = done.filter(x => x.r.tier != null).sort((a, b) => b.r.tier - a.r.tier)[0];
    const sortedDates = dated.map(x => x.date).sort((a, b) => a - b);
    const fmtD = (d) => (d ? `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}` : '—');

    const tiles = el('div', 'fx-tiles');
    const tile = (big, small, sub) => { const t = el('div', 'fx-tile'); t.append(el('div', 'fx-tile-big', big), el('div', 'fx-tile-title', small)); if (sub) t.appendChild(el('div', 'fx-tile-sub dim', sub)); tiles.appendChild(t); };
    tile(String(done.length), 'Completions', runs ? `+ ${plural(runs, 'run')} recorded` : '');
    tile(totalPts.toLocaleString(undefined, { maximumFractionDigits: 1 }), 'Points');
    tile(att.length ? totalAttempts.toLocaleString() : '—', 'Total attempts', att.length ? `${(totalAttempts / att.length).toFixed(0)} per completion` : 'add attempts to see more');
    tile(hardest ? hardest.r.name : '—', 'Hardest (by tier)', hardest ? `tier ${hardest.r.tier}` : 'no tiers yet');
    tile(sortedDates.length ? fmtD(sortedDates[0]) : '—', 'First completion', sortedDates.length ? `latest ${fmtD(sortedDates[sortedDates.length - 1])}` : '');
    box.appendChild(tiles);

    // completions over time
    const sec1 = el('div', 'fx-stat-sec'); const h1 = el('div', 'fx-stat-title');
    h1.appendChild(el('strong', null, 'Completions over time'));
    if (years.length) {
      const sel = el('select', 'fx-select'); const all = el('option', null, 'All years'); all.value = 'all'; sel.appendChild(all);
      years.forEach(y => { const o = el('option', null, String(y)); o.value = String(y); sel.appendChild(o); });
      sel.value = String(statsYear); sel.addEventListener('change', () => { statsYear = sel.value; renderStats(); }); h1.appendChild(sel);
    }
    sec1.appendChild(h1);
    if (!dated.length) sec1.appendChild(el('div', 'fx-note small', 'None of your completions have a date yet.'));
    else if (statsYear === 'all') sec1.appendChild(bars(years.map(y => ({ label: String(y), value: dated.filter(x => x.date.getFullYear() === y).length })), { cls: 'cols' }));
    else sec1.appendChild(bars(MONTHS.map((mn, i) => ({ label: mn, value: dated.filter(x => x.date.getFullYear() === Number(statsYear) && x.date.getMonth() === i).length })), { cls: 'cols' }));
    if (done.length > dated.length) sec1.appendChild(el('div', 'fx-note small', `${plural(done.length - dated.length, 'completion')} without a date aren’t counted here.`));
    box.appendChild(sec1);

    // by tier
    const sec2 = el('div', 'fx-stat-sec'); sec2.appendChild(el('div', 'fx-stat-title')).appendChild(el('strong', null, 'By tier'));
    const byTier = new Map();
    done.forEach(x => { const k = x.r.tier == null ? 'none' : Math.floor(x.r.tier); byTier.set(k, (byTier.get(k) || 0) + 1); });
    const tierKeys = [...byTier.keys()].filter(k => k !== 'none').sort((a, b) => a - b);
    sec2.appendChild(bars([...tierKeys.map(k => ({ label: `Tier ${k}`, value: byTier.get(k) })), ...(byTier.has('none') ? [{ label: 'No tier', value: byTier.get('none') }] : [])]));
    box.appendChild(sec2);

    // attempts per level
    const sec3 = el('div', 'fx-stat-sec'); sec3.appendChild(el('div', 'fx-stat-title')).appendChild(el('strong', null, 'Most attempts'));
    const top = att.slice().sort((a, b) => b.attempts - a.attempts).slice(0, 10);
    if (top.length) sec3.appendChild(bars(top.map(x => ({ label: x.r.name || '—', value: x.attempts, title: x.r.name })), { fmt: (v) => v.toLocaleString() }));
    else sec3.appendChild(el('div', 'fx-note small', 'Add attempt counts to your entries to see them here.'));
    box.appendChild(sec3);

    // yearly recap
    if (years.length) {
      const sec4 = el('div', 'fx-stat-sec recap'); const h4 = el('div', 'fx-stat-title'); h4.appendChild(el('strong', null, 'Yearly recap'));
      const sel = el('select', 'fx-select'); [...years].reverse().forEach(y => { const o = el('option', null, String(y)); o.value = String(y); sel.appendChild(o); });
      sel.value = String(recapYear); sel.addEventListener('change', () => { recapYear = Number(sel.value); renderStats(); }); h4.appendChild(sel); sec4.appendChild(h4);
      const inYear = dated.filter(x => x.date.getFullYear() === recapYear), prev = dated.filter(x => x.date.getFullYear() === recapYear - 1);
      const lines = el('div', 'fx-recap');
      const line = (k, v) => { const r = el('div', 'fx-recap-row'); r.append(el('span', 'fx-recap-k', k), el('span', 'fx-recap-v', v)); lines.appendChild(r); };
      line('Completions', `${inYear.length}${prev.length ? ` (${inYear.length >= prev.length ? '+' : ''}${inYear.length - prev.length} vs ${recapYear - 1})` : ''}`);
      const hy = inYear.filter(x => x.r.tier != null).sort((a, b) => b.r.tier - a.r.tier)[0]; line('Hardest', hy ? `${hy.r.name} (tier ${hy.r.tier})` : '—');
      const ay = inYear.filter(x => x.attempts != null).sort((a, b) => b.attempts - a.attempts)[0]; line('Most attempts', ay ? `${ay.r.name} (${ay.attempts.toLocaleString()})` : '—');
      line('Points earned', inYear.reduce((s, x) => s + (x.r.pointsNum || 0), 0).toLocaleString(undefined, { maximumFractionDigits: 1 }));
      const perMonth = MONTHS.map((_, i) => inYear.filter(x => x.date.getMonth() === i).length), best = Math.max(...perMonth);
      line('Busiest month', best ? `${MONTHS[perMonth.indexOf(best)]} (${best})` : '—');
      const ds = inYear.map(x => x.date).sort((a, b) => a - b); line('First → last', ds.length ? `${fmtD(ds[0])} → ${fmtD(ds[ds.length - 1])}` : '—');
      sec4.appendChild(lines); box.appendChild(sec4);
    }
  }
  fx.showStats = function showStats(on) {
    statsOn = on !== false && (on === true || !statsOn);
    $('#tab-personal').classList.toggle('stats-mode', statsOn);
    $('#plStats').hidden = !statsOn;
    $('#plStatsBtn').classList.toggle('active', statsOn);
    if (statsOn) renderStats();
  };
  // keep the charts current when the list or its mode changes
  const baseRenderPersonal = renderPersonal;
  renderPersonal = function () { baseRenderPersonal.apply(this, arguments); if (statsOn) renderStats(); }; // eslint-disable-line no-global-assign

  // ==========================================================================
  // Saved filters (+ the EDEL range filter they can use)
  // ==========================================================================
  fx.filters = [];
  const saveFilters = () => window.aredl.setStore('saved-filters', fx.filters).catch(() => showToast('Couldn’t save the filters'));
  fx.syncEdelInputs = function () {
    const a = $('#edelMin'), b = $('#edelMax');
    if (a) a.value = state.edelMin ?? '';
    if (b) b.value = state.edelMax ?? '';
  };
  function wireEdelInputs() {
    const apply = () => { state.edelMin = num($('#edelMin').value); state.edelMax = num($('#edelMax').value); updateTagFilterCount(); applyFilters(); };
    $('#edelMin').addEventListener('input', apply); $('#edelMax').addEventListener('input', apply);
  }
  const currentFilter = () => ({
    mode: tabModes.list, search: $('#search').value, status: $('#statusFilter').value, completedOnly: $('#completedOnly').checked,
    tags: { ...state.tagFilters }, edelMin: state.edelMin ?? null, edelMax: state.edelMax ?? null, sort: $('#sortBy').value,
  });
  fx.applySavedFilter = async function (f) {
    showTab('list');
    await switchListMode(f.mode);
    $('#search').value = f.search || ''; updateSearchClearBtn();
    if ([...$('#statusFilter').options].some(o => o.value === f.status)) $('#statusFilter').value = f.status; else $('#statusFilter').value = '__all__';
    $('#completedOnly').checked = !!f.completedOnly && state.signedIn;
    state.tagFilters = { ...f.tags }; state.edelMin = f.edelMin ?? null; state.edelMax = f.edelMax ?? null;
    if ([...$('#sortBy').options].some(o => o.value === f.sort)) $('#sortBy').value = f.sort;
    fx.syncEdelInputs(); renderTagFilterPanel(); updateTagFilterCount(); applyFilters();
    showToast(`Filter “${f.name}” applied`);
  };
  async function saveCurrentFilter() {
    const name = await askName({ title: 'Save this filter', label: 'Name it (for example “Platformer under 30 EDEL”)', ok: 'Save filter' });
    if (!name) return;
    const existing = fx.filters.find(f => norm(f.name) === norm(name));
    const rec = { ...currentFilter(), id: existing ? existing.id : uid(), name, createdAt: existing ? existing.createdAt : new Date().toISOString() };
    fx.filters = existing ? fx.filters.map(f => (f === existing ? rec : f)) : [...fx.filters, rec];
    await saveFilters(); showToast(`Saved “${name}”`);
  }
  function manageFilters() {
    const m = openModal({ title: 'Saved filters' });
    const draw = () => {
      m.body.replaceChildren();
      if (!fx.filters.length) { m.body.appendChild(el('div', 'fx-note', 'No saved filters yet.')); return; }
      fx.filters.forEach(f => {
        const row = el('div', 'fx-manage-row');
        const info = el('div', 'fx-manage-info'); info.append(el('strong', null, f.name), el('small', null, `${modeLabel(f.mode)}${f.search ? ' · “' + f.search + '”' : ''}${f.edelMin != null || f.edelMax != null ? ` · EDEL ${f.edelMin ?? 0}–${f.edelMax ?? 100}` : ''}${Object.keys(f.tags).length ? ' · ' + plural(Object.keys(f.tags).length, 'tag') : ''}`));
        const use = el('button', 'btn small-btn', 'Apply'); use.addEventListener('click', () => { m.close(); fx.applySavedFilter(f); });
        const ren = el('button', 'btn btn-ghost small-btn', 'Rename'); ren.addEventListener('click', async () => { const n = await askName({ title: 'Rename filter', label: 'New name', value: f.name, ok: 'Rename' }); if (n) { f.name = n; await saveFilters(); manageFilters(); } else manageFilters(); });
        const del = el('button', 'btn btn-ghost small-btn danger', 'Delete'); del.addEventListener('click', async () => { fx.filters = fx.filters.filter(x => x !== f); await saveFilters(); draw(); });
        row.append(info, use, ren, del); m.body.appendChild(row);
      });
    };
    draw();
  }
  fx.openFiltersMenu = function () {
    const r = $('#savedFiltersBtn').getBoundingClientRect();
    const items = [];
    if (fx.filters.length) { fx.filters.forEach(f => items.push({ label: f.name, onClick: () => fx.applySavedFilter(f) })); items.push({ separator: true }); }
    else items.push({ header: 'No saved filters yet', sub: 'Set up the search, tags and EDEL range you like, then save it.', dim: true });
    items.push({ label: 'Save the current filter…', onClick: saveCurrentFilter });
    if (fx.filters.length) items.push({ label: 'Manage saved filters…', onClick: manageFilters });
    showContextMenu(r.left, r.bottom + 6, items);
  };

  // ==========================================================================
  // Custom lists (named lists of levels, shown in the Favourites tab)
  // ==========================================================================
  fx.lists = [];
  fx.view = null; // id of the custom list shown in the Favourites tab (null = the favourites)
  const saveLists = () => window.aredl.setStore('custom-lists', fx.lists).catch(() => showToast('Couldn’t save the lists'));
  fx.activeList = () => (fx.view ? fx.lists.find(l => l.id === fx.view) || null : null);
  const levelRec = (l) => ({ level_id: l.level_id, name: l.name, mode: modeOfLevel(l) });
  const inList = (list, id) => list.items.some(i => String(i.level_id) === String(id));

  fx.renderListBar = function () {
    const bar = $('#favListBar'); if (!bar) return;
    bar.replaceChildren();
    if (!fx.lists.length && !fx.view) {
      const add = el('button', 'fx-listchip add', '+ New list'); add.addEventListener('click', () => fx.createList()); bar.appendChild(add);
      const imp = el('button', 'fx-listchip add', 'Import a list…'); imp.addEventListener('click', () => fx.importList()); bar.appendChild(imp);
      return;
    }
    const chip = (label, on, fn, count) => { const b = el('button', 'fx-listchip' + (on ? ' on' : '')); b.type = 'button'; b.appendChild(document.createTextNode(label)); if (count != null) b.appendChild(el('span', 'fx-listchip-n', String(count))); b.addEventListener('click', fn); bar.appendChild(b); return b; };
    chip('★ Favourites', !fx.view, () => fx.openList(null), state.favourites.length);
    fx.lists.forEach(l => chip(l.name, fx.view === l.id, () => fx.openList(l.id), l.items.length));
    const add = el('button', 'fx-listchip add', '+ New list'); add.addEventListener('click', () => fx.createList()); bar.appendChild(add);
    const imp = el('button', 'fx-listchip add', 'Import…'); imp.addEventListener('click', () => fx.importList()); bar.appendChild(imp);
    const active = fx.activeList();
    if (active) {
      const tools = el('span', 'fx-listtools');
      const ren = el('button', 'btn btn-ghost small-btn', 'Rename'); ren.addEventListener('click', async () => { const n = await askName({ title: 'Rename list', label: 'New name', value: active.name, ok: 'Rename' }); if (n) { active.name = n; await saveLists(); renderFavourites(); } });
      const sh = el('button', 'btn btn-ghost small-btn', 'Share as text'); sh.addEventListener('click', () => fx.shareList(active));
      const del = el('button', 'btn btn-ghost small-btn danger', 'Delete list');
      let armed = false; del.addEventListener('click', async () => { if (!armed) { armed = true; del.textContent = 'Click again to delete'; setTimeout(() => { armed = false; del.textContent = 'Delete list'; }, 3500); return; } fx.lists = fx.lists.filter(l => l !== active); fx.view = null; await saveLists(); renderFavourites(); showToast('List deleted'); });
      tools.append(ren, sh, del); bar.appendChild(tools);
    }
  };
  fx.openList = function (id) { fx.view = id; showTab('favourites'); renderFavourites(); };
  fx.createList = async function (first) {
    const name = await askName({ title: 'New list', label: 'Name your list (for example “To practise”)', ok: 'Create list' });
    if (!name) return null;
    const list = { id: uid(), name, items: first ? [levelRec(first)] : [], createdAt: new Date().toISOString() };
    fx.lists = [...fx.lists, list]; await saveLists();
    if (!first) { fx.view = list.id; showTab('favourites'); }
    renderFavourites(); showToast(first ? `Added to “${name}”` : `List “${name}” created`);
    return list;
  };
  fx.toggleInList = async function (list, level) {
    if (inList(list, level.level_id)) list.items = list.items.filter(i => String(i.level_id) !== String(level.level_id));
    else list.items = [...list.items, levelRec(level)];
    await saveLists(); renderFavourites();
    showToast(inList(list, level.level_id) ? `Added to “${list.name}”` : `Removed from “${list.name}”`);
  };
  // the "add to a list" menu for a level (anchored at the mouse, or at a given point)
  fx.openListsMenu = function (level, at) {
    const x = at ? at.x : mouse.x, y = at ? at.y : mouse.y;
    const items = [];
    if (fx.lists.length) fx.lists.forEach(l => items.push({ label: `${inList(l, level.level_id) ? '✓ ' : ''}${l.name}`, onClick: () => fx.toggleInList(l, level) })); else items.push({ header: 'No lists yet', dim: true });
    items.push({ separator: true }, { label: 'New list…', onClick: () => fx.createList(level) });
    showContextMenu(x, y, items);
  };
  fx.shareList = async function (list) {
    const r = await window.aredl.listToText(list).catch(() => null);
    if (!r || !r.ok) { showToast('Couldn’t make the text'); return; }
    copyText(r.text, 'List text');
    actionToast(`Copied “${list.name}” as text. On the other computer: Favourites → Import…`, null);
  };
  fx.importList = function () {
    const m = openModal({ title: 'Import a list' });
    m.body.appendChild(el('label', 'fx-label', 'Paste the list text here'));
    const box = el('textarea', 'fx-textarea'); box.rows = 4; box.spellcheck = false; box.placeholder = 'AREDL-LIST:…';
    const msg = el('div', 'fx-note small');
    const row = el('div', 'fx-row'); const go = el('button', 'btn small-btn', 'Import list'), cancel = el('button', 'btn btn-ghost small-btn', 'Cancel'); row.append(go, cancel);
    m.body.append(box, msg, row);
    cancel.addEventListener('click', () => m.close());
    go.addEventListener('click', async () => {
      const r = await window.aredl.listFromText(box.value).catch(() => ({ ok: false, error: 'That could not be read.' }));
      if (!r.ok) { msg.textContent = r.error; return; }
      let name = r.list.name; if (fx.lists.some(l => norm(l.name) === norm(name))) name += ' (imported)';
      const list = { ...r.list, id: uid(), name }; fx.lists = [...fx.lists, list]; await saveLists(); fx.view = list.id; m.close(); showTab('favourites'); renderFavourites(); showToast(`Imported “${name}” (${plural(list.items.length, 'level')})`);
    });
    setTimeout(() => box.focus(), 30);
  };
  // the little "add to a list" button in a level's header, and removing a level from the list that is shown
  document.addEventListener('click', (e) => {
    const b = e.target.closest('[data-lists-menu]');
    if (b) {
      e.preventDefault();
      const level = anyLevel(b.dataset.listsMenu) || { level_id: b.dataset.listsMenu, name: b.dataset.listsName, _mode: b.dataset.listsMode };
      const r = b.getBoundingClientRect(); fx.openListsMenu(level, { x: r.left, y: r.bottom + 6 });
    }
  });
  document.addEventListener('click', (e) => { // captured, so the favourites "remove" handler never sees it
    const b = e.target.closest('[data-list-remove]');
    if (!b) return;
    e.preventDefault(); e.stopPropagation();
    const list = fx.activeList();
    if (list) { list.items = list.items.filter(i => String(i.level_id) !== String(b.dataset.listRemove)); saveLists(); renderFavourites(); }
  }, true);

  // ==========================================================================
  // Song names across the app
  // ==========================================================================
  const distinctSongIds = () => { const s = new Set(); MODES.forEach(m => levelsOf(m).forEach(l => { if (l.song > 0) s.add(l.song); })); return [...s]; };
  fx.otherLevelsWithSong = (songId, thisLevelId) => {
    let n = 0;
    MODES.forEach(m => levelsOf(m).forEach(l => { if (String(l.song) === String(songId) && String(l.level_id) !== String(thisLevelId)) n++; }));
    return n;
  };
  // Clicking a song ID: the other levels that use the song (both lists), a button to copy the ID, and one to filter the list by it
  fx.openSongLevels = async function (songId, thisLevelId) {
    const id = String(songId);
    const m = openModal({ title: 'Song ' + id });
    const name = songLabelOf(Number(id));
    const head = el('div', 'fx-row');
    head.appendChild(el('span', 'fx-count', name ? `♪ ${name}` : `Song ID ${id}`));
    const copy = el('button', 'btn btn-ghost small-btn', 'Copy ID'); copy.type = 'button';
    copy.addEventListener('click', () => copyText(id, 'Song ID'));
    head.appendChild(copy);
    m.body.appendChild(head);
    const box = el('div', 'fx-note', 'Loading the lists…'); m.body.appendChild(box);
    await bothLevels();
    if (!m.overlay.isConnected) return;
    const rows = [];
    MODES.forEach(md => levelsOf(md).forEach(l => { if (String(l.song) === id && String(l.level_id) !== String(thisLevelId)) rows.push({ l, md }); }));
    rows.sort((a, b) => (a.l.position ?? 1e9) - (b.l.position ?? 1e9) || (a.md < b.md ? -1 : 1));
    box.remove();
    if (!rows.length) { m.body.appendChild(el('div', 'fx-note', 'No other level on the lists uses this song.')); return; }
    m.body.appendChild(el('div', 'fx-count', `${plural(rows.length, 'other level')} with this song`));
    const list = el('div', 'fx-list');
    rows.forEach(({ l, md }) => {
      const r = el('button', 'fx-listrow'); r.type = 'button'; r.style.cursor = 'pointer'; r.style.textAlign = 'left'; r.style.color = 'inherit'; r.style.font = 'inherit';
      r.appendChild(el('span', 'fx-pick-pos', l.position != null ? `#${l.position}` : (levelStatusLabel(l) || '—')));
      r.appendChild(el('span', 'fx-pick-name', l.name));
      const where = el('span', 'dim', modeLabel(md)); where.style.marginLeft = 'auto'; r.appendChild(where);
      r.addEventListener('click', () => { m.close(); jumpToLevel(l.level_id, md); });
      list.appendChild(r);
    });
    m.body.appendChild(list);
    const foot = el('div', 'fx-row');
    const show = el('button', 'btn btn-ghost small-btn', 'Show them in the Demon List'); show.type = 'button';
    show.addEventListener('click', () => { m.close(); fx.showSongLevels(Number(id)); });
    foot.appendChild(show); m.body.appendChild(foot);
  };
  fx.showSongLevels = async function (songId) {
    const counts = MODES.map(m => ({ m, n: levelsOf(m).filter(l => String(l.song) === String(songId)).length }));
    const best = counts.find(c => c.m === tabModes.list && c.n) || counts.slice().sort((a, b) => b.n - a.n)[0];
    showTab('list');
    await switchListMode(best.m);
    $('#statusFilter').value = '__all__'; $('#completedOnly').checked = false;
    state.tagFilters = {}; state.edelMin = state.edelMax = null; fx.syncEdelInputs(); renderTagFilterPanel(); updateTagFilterCount();
    $('#search').value = `song:${songId}`; updateSearchClearBtn(); applyFilters();
    const other = counts.find(c => c.m !== best.m && c.n);
    showToast(`${plural(best.n, 'level')} use this song${other ? ` (and ${other.n} in the ${modeLabel(other.m).toLowerCase()} list)` : ''}`);
  };
  async function refreshSongCache() {
    try { const c = await window.aredl.getSongCache(); Object.entries(c).forEach(([id, v]) => rememberSong(id, v)); } catch { /* none known yet */ }
  }
  const rerenderSongViews = () => { try { refreshSongStats(); } catch { /* not ready */ } try { applyFilters(); } catch { /* list not ready */ } try { renderFavourites(); } catch { /* not ready */ } };
  function songInfoText() {
    const ids = distinctSongIds();
    if (!ids.length) return 'Finds the names of all songs on the lists, about one per second so the game server isn’t hammered. It runs in the background and you can stop it any time. (Open the Demon List first so the lists are loaded.)';
    const known = ids.filter(id => songNames.has(String(id))).length;
    return `${known} of ${ids.length} song names are known. “Look up all song names” finds the rest, about one per second so the game server isn’t hammered. It runs in the background and you can stop it any time.`;
  }
  function wireSongSettings() {
    const toggle = $('#showSongNames'), bulk = $('#songBulkBtn'), stop = $('#songBulkStopBtn'), info = $('#songBulkInfo');
    toggle.checked = appSettings.showSongNames !== false;
    toggle.addEventListener('change', () => { setSetting('showSongNames', toggle.checked); songVersion++; rerenderSongViews(); });
    const eta = (p) => {
      const secs = (Date.now() - (p.startedAt || Date.now())) / 1000;
      if (!p.done || secs < 3) return 'estimating the time left…';
      const left = Math.round(((p.total - p.done) / (p.done / secs)));
      return left < 60 ? `about ${Math.max(1, left)} s left` : left < 3600 ? `about ${Math.round(left / 60)} min left` : `about ${Math.floor(left / 3600)} h ${Math.round((left % 3600) / 60)} min left`;
    };
    fx.songEta = eta;
    bulk.addEventListener('click', async () => {
      bulk.disabled = true; bulk.textContent = 'Starting…'; info.textContent = 'Starting the lookup…';
      await bothLevels();
      const ids = distinctSongIds();
      const res = await window.aredl.songBulkStart(ids).catch(err => ({ ok: false, error: errMsg(err) }));
      if (!res.ok) { info.textContent = res.error || 'Could not start.'; bulk.disabled = false; bulk.textContent = 'Look up all song names'; return; }
      if (!res.total) { info.textContent = `All ${ids.length} song names are already known.`; bulk.disabled = false; bulk.textContent = 'Look up all song names'; }
    });
    stop.addEventListener('click', () => { stop.disabled = true; stop.textContent = 'Stopping…'; info.textContent = 'Stopping after the song being looked up…'; window.aredl.songBulkStop(); });
    let lastRefresh = 0;
    window.aredl.onSongBulkProgress(async (p) => {
      bulk.hidden = p.running; stop.hidden = !p.running;
      if (p.running) { stop.disabled = !!p.stop; stop.textContent = p.stop ? 'Stopping…' : 'Stop'; }
      if (!p.running) { bulk.disabled = false; bulk.textContent = 'Look up all song names'; }
      if (p.running && p.stop) { info.textContent = 'Stopping after the song being looked up…'; }
      else if (p.running) {
        info.textContent = `Looking up song names… ${p.done} of ${p.total} done${p.failed ? ` (${p.failed} not found)` : ''}, ${eta(p)}.`;
        if (p.done - lastRefresh >= 15) { lastRefresh = p.done; await refreshSongCache(); }
      } else {
        lastRefresh = 0; await refreshSongCache(); rerenderSongViews();
        info.textContent = `Finished: ${p.done} looked up${p.failed ? `, ${p.failed} couldn’t be found` : ''}. ${songInfoText()}`;
      }
    });
    window.aredl.songBulkStatus().then(p => { if (p && p.running) { bulk.hidden = true; stop.hidden = false; info.textContent = `Looking up song names… ${p.done} of ${p.total} done, ${eta(p)}.`; } }).catch(() => {});
  }

  // ==========================================================================
  // Sync (settings card): a Google Drive folder, with one save file per AREDL API key
  // ==========================================================================
  const SYNC_REPORT_KEY = 'aredl-sync-report';
  let syncSections = [];
  const ago = (iso) => { const s = (Date.now() - Date.parse(iso)) / 1000; return !Number.isFinite(s) ? '' : s < 60 ? 'just now' : s < 3600 ? `${Math.round(s / 60)} min ago` : s < 86400 ? `${Math.round(s / 3600)} h ago` : `${Math.round(s / 86400)} d ago`; };
  const partName = (id) => (syncSections.find(s => s.id === id) || { label: id }).label;
  function syncResultBox(kind, title, lines = []) {
    const box = $('#syncResult'); box.replaceChildren(); box.className = `transfer-result ${kind}`;
    box.appendChild(el('strong', null, title)); lines.forEach(t => box.appendChild(el('div', 'transfer-detail', t)));
    $('#syncResultLine').hidden = false;
  }
  function describeSync(res) {
    const names = (ids) => ids.map(partName).join(', ');
    const lines = [];
    if (res.mode === 'save') {
      if (res.pushed.length) lines.push(`Saved: ${names(res.pushed)}.`);
      if (res.file) lines.push(`File: ${res.file.name} in “${res.file.folder}”${res.file.modifiedTime ? `, ${ago(res.file.modifiedTime)}` : ''}.`);
      return { title: 'Saved to Google Drive.', lines };
    }
    if (res.pulled.length) lines.push(`Replaced from the save: ${names(res.pulled)}.`);
    if (res.unchanged) lines.push(`Already the same: ${res.unchanged} ${res.unchanged === 1 ? 'part' : 'parts'}.`);
    if (res.missing && res.missing.length) lines.push(`Not in the save, left as they are: ${names(res.missing)}.`);
    return { title: res.pulled.length ? 'Loaded from Google Drive.' : 'Nothing to change.', lines };
  }
  // the two timing dropdowns (shown once a folder is connected); linked = the check time follows the save time
  async function refreshSyncTiming(show) {
    for (const id of ['syncTimingSep', 'syncSaveLine', 'syncCheckLine', 'syncLinkLine', 'syncTimerLine']) $('#' + id).hidden = !show;
    if (!show) { clearInterval(syncClock); syncClock = null; return; }
    let iv; try { iv = await window.aredl.syncGetIntervals(); } catch { return; }
    syncTimes = { saveAt: iv.nextSave ? Date.now() + (iv.nextSave - iv.now) : null, checkAt: iv.nextCheck ? Date.now() + (iv.nextCheck - iv.now) : null, linked: iv.linked, pending: iv.pending, save: iv.save, check: iv.check };
    drawSyncClock();
    if (!syncClock) syncClock = setInterval(() => { if (document.getElementById('tab-settings').classList.contains('active')) drawSyncClock(); }, 1000);
    $('#syncSaveSelect').value = String(iv.save);
    $('#syncCheckSelect').value = String(iv.linked ? iv.save : iv.check);
    $('#syncLinked').checked = iv.linked;
    setSelectDisabled($('#syncCheckSelect'), iv.linked);
    $('#syncCheckLine').classList.toggle('muted', iv.linked);
  }
  // a live countdown to the next save and the next check
  let syncClock = null, syncTimes = null;
  function drawSyncClock() {
    const t = syncTimes, box = $('#syncTimerText');
    if (!t || !box) return;
    const left = (at) => { const ms = Math.max(0, at - Date.now()), m = Math.floor(ms / 60000), sec = Math.floor(ms / 1000) % 60; return `${m}:${String(sec).padStart(2, '0')}`; };
    const save = t.saveAt ? `next save in ${left(t.saveAt)}${t.pending ? ' (changes are waiting to be saved)' : ' (nothing to save right now)'}` : 'saves when the app closes';
    const check = t.checkAt ? `next check in ${left(t.checkAt)}` : 'checks when the app starts';
    box.textContent = t.linked ? (t.saveAt ? `Save and check together: ${left(t.saveAt)} until the next run${t.pending ? ' (changes are waiting to be saved)' : ' (nothing to save right now)'}.` : 'Nothing runs on a timer; the app saves when it closes.') : `${save[0].toUpperCase() + save.slice(1)}; ${check}.`;
    if (t.saveAt && Date.now() > t.saveAt + 1500) { syncTimes = null; refreshSyncTiming(true); } // a run happened: ask for the new times
    else if (t.checkAt && Date.now() > t.checkAt + 1500) { syncTimes = null; refreshSyncTiming(true); }
  }
  async function saveSyncTiming(from) {
    const linked = $('#syncLinked').checked;
    const save = Number($('#syncSaveSelect').value);
    let check = Number($('#syncCheckSelect').value);
    if (linked) check = save;
    else if (from === 'link') check = save; // unlinking starts both at the same time
    await window.aredl.syncSetIntervals({ save, check, linked }).catch(() => {});
    refreshSyncTiming(true);
  }
  async function refreshSync() {
    let st;
    try { st = await window.aredl.syncStatus(); } catch { return; }
    if (!syncSections.length) { try { syncSections = await window.aredl.transferInfo(); } catch { /* labels fall back to ids */ } }
    $('#syncMoreLine').hidden = !st.folder;
    $('#syncAuto').checked = st.enabled;
    await refreshSyncTiming(!!st.folder);
    const parts = $('#syncParts'); parts.replaceChildren();
    (syncSections.length ? syncSections : st.parts.map(id => ({ id, label: id, about: '' }))).forEach(sec => {
      const row = el('label', 'transfer-check'); const cb = el('input'); cb.type = 'checkbox'; cb.value = sec.id; cb.checked = st.parts.includes(sec.id);
      const t = el('span', 'transfer-check-text'); t.appendChild(el('b', null, sec.label)); if (sec.about) t.appendChild(el('small', null, sec.about)); row.append(cb, t); parts.appendChild(row);
    });
    driveUi(st);
    // one plain sentence about what is in the folder for this API key
    const t = $('#syncStatusText');
    if (!st.folder) t.textContent = 'No Google Drive folder connected yet.';
    else if (st.needsKey) t.textContent = 'Sign in with your AREDL API key first. Each API key has its own save file in the folder.';
    else if (st.remoteError) t.textContent = `The folder couldn’t be checked (${st.remoteError}).`;
    else if (st.remoteFile && st.remoteFile.exists) t.textContent = `Folder “${st.folderName}” has a save for this API key (${st.fileName}), last saved ${ago(st.remoteFile.modifiedTime)}.`;
    else t.textContent = `Folder “${st.folderName}” has no save for this API key yet. Sync now creates it as ${st.fileName}.`;
  }
  // ---- Google Drive: sign in, create a folder, or choose an existing one ----
  async function driveConnectAndReport(opts, okTitle, okLine) {
    const r = await window.aredl.driveConnect(opts).catch(err => ({ error: errMsg(err) }));
    if (r.error) { syncResultBox('error', r.error); return false; }
    $('#syncResultLine').hidden = true; await refreshSync();
    syncResultBox('ok', okTitle, [okLine]);
    return true;
  }
  async function driveChooseFolder() {
    const m = openModal({ title: 'Choose a Google Drive folder', wide: true });
    m.body.appendChild(el('div', 'fx-note', 'Loading folders…'));
    const r = await window.aredl.driveListFolders().catch(err => ({ error: errMsg(err) }));
    if (!m.overlay.isConnected) return;
    if (r.error) { m.body.replaceChildren(el('div', 'fx-note', `The folders couldn’t be loaded (${r.error}).`)); return; }
    const search = el('input', 'fx-input'); search.type = 'text'; search.placeholder = 'Filter folders…'; search.spellcheck = false;
    const list = el('div', 'fx-folder-list'), msg = el('div', 'fx-note small');
    const draw = () => {
      const q = norm(search.value).trim(); list.replaceChildren();
      const rows = r.folders.filter(f => !q || norm(f.name).includes(q));
      if (!rows.length) list.appendChild(el('div', 'fx-note', r.folders.length ? 'No folder matches.' : 'This Google Drive has no folders yet. Create a new one instead.'));
      rows.forEach(f => {
        const b = el('button', 'fx-folder-row'); b.type = 'button';
        b.append(el('span', 'fx-folder-name', f.name), f.hasSave ? el('span', 'fx-badge', 'Has your save') : el('span', 'fx-folder-date', ''), el('span', 'fx-folder-date', f.modifiedTime ? ago(f.modifiedTime) : ''));
        b.addEventListener('click', async () => {
          msg.textContent = `Connecting “${f.name}”…`;
          m.close();
          await driveConnectAndReport({ folderId: f.id, name: f.name, mode: 'use' }, `Folder “${f.name}” connected.`, f.hasSave ? 'It already has a save for this API key. Press “Sync now” to save this app to it, or to use it.' : 'It has no save for this API key yet. Press “Sync now” to save this app to it.');
        });
        list.appendChild(b);
      });
    };
    search.addEventListener('input', draw);
    m.body.replaceChildren(search, list, msg); draw();
  }
  async function driveUi(st) {
    const box = $('#driveBox'); if (!box) return;
    const d = st.drive || await window.aredl.driveInfo().catch(() => null);
    if (!d) return;
    box.replaceChildren();
    const btns = el('div', 'transfer-btns');
    const fail = (t) => syncResultBox('error', t);
    if (!d.signedIn) {
      if (!d.configured) {
        box.appendChild(el('div', 'fx-hint', 'Google needs an OAuth client for the app, made once in Google Cloud Console: create a project, turn on the Google Drive API, then create an OAuth client ID of type “Desktop app” and paste its ID and secret here. While the project is in Testing, the Google account has to be added as a test user.'));
        const a = el('a', 'linklike', 'Open Google Cloud Console credentials'); a.href = 'https://console.cloud.google.com/apis/credentials'; a.target = '_blank'; a.rel = 'noopener'; box.appendChild(a);
        const id = el('input', 'fx-input'); id.type = 'text'; id.placeholder = 'Client ID'; id.spellcheck = false;
        const sec = el('input', 'fx-input'); sec.type = 'password'; sec.placeholder = 'Client secret'; sec.spellcheck = false;
        const save = el('button', 'btn btn-ghost small-btn', 'Save');
        save.addEventListener('click', async () => { if (!id.value.trim() || !sec.value.trim()) { fail('Both the client ID and the secret are needed.'); return; } await window.aredl.driveSetClient(id.value, sec.value); refreshSync(); });
        btns.appendChild(save); box.append(id, sec, btns);
        return;
      }
      const go = el('button', 'btn small-btn', 'Connect a Google account'), cancel = el('button', 'btn btn-ghost small-btn', 'Cancel'); cancel.hidden = true;
      go.addEventListener('click', async () => {
        go.disabled = true; go.textContent = 'Waiting for Google in the browser…'; cancel.hidden = false;
        const r = await window.aredl.driveSignIn().catch(err => ({ error: errMsg(err) }));
        if (r && r.error && r.error !== 'Sign-in cancelled.') fail(r.error);
        refreshSync();
      });
      cancel.addEventListener('click', () => window.aredl.driveCancelSignIn());
      btns.append(go, cancel); box.appendChild(btns);
      return;
    }
    box.appendChild(el('div', 'fx-hint', `Signed in as ${d.account || 'a Google account'}.${d.folder ? ` Folder: “${d.folder.name}”.` : ' No folder connected yet.'}`));
    const mk = el('button', 'btn btn-ghost small-btn', 'Create a new folder…'), ex = el('button', 'btn btn-ghost small-btn', 'Choose an existing folder…'), out = el('button', 'btn btn-ghost small-btn', 'Sign out');
    mk.addEventListener('click', async () => {
      const name = await askName({ title: 'New Google Drive folder', label: 'Folder name', value: 'AREDL Desktop', ok: 'Create folder' });
      if (name) await driveConnectAndReport({ mode: 'create', name }, `Folder “${name}” created in Google Drive.`, 'It is empty. Press “Sync now” to save this app to it.');
    });
    ex.addEventListener('click', driveChooseFolder);
    out.addEventListener('click', async () => { await window.aredl.driveSignOut(); $('#syncResultLine').hidden = true; refreshSync(); });
    btns.append(mk, ex, out); box.appendChild(btns);
  }
  function wireSync() {
    $('#syncAuto').addEventListener('change', (e) => window.aredl.syncSetEnabled(e.target.checked));
    $('#syncSaveSelect').addEventListener('change', () => saveSyncTiming('save'));
    $('#syncCheckSelect').addEventListener('change', () => saveSyncTiming('check'));
    $('#syncLinked').addEventListener('change', () => saveSyncTiming('link'));
    $('#syncParts').addEventListener('change', () => window.aredl.syncSetParts([...$('#syncParts').querySelectorAll('input:checked')].map(i => i.value)));
    const runSync = async (choice) => {
      const btn = $('#syncNowBtn'); btn.disabled = true;
      try {
        flushSoftSettings();
        const res = await window.aredl.syncNow(choice);
        if (!res.ok) { syncResultBox('error', res.error || 'The sync failed.'); return; }
        if (res.reload) { try { sessionStorage.setItem(SYNC_REPORT_KEY, JSON.stringify(res)); } catch { /* fine */ } softPatch = null; clearTimeout(softTimer); softTimer = null; location.reload(); return; }
        const d = describeSync(res); syncResultBox('ok', d.title, d.lines); refreshSync();
      } catch (err) { syncResultBox('error', `The sync failed: ${errMsg(err)}`); } finally { btn.disabled = false; }
    };
    // The comparison as an outline: what the part is, then each kind of difference with its items as sub-points and what each button would do about it.
    function renderSyncChanges(box, res) {
      box.innerHTML = '';
      if (!res || !res.ok) { box.appendChild(el('p', 'dim', (res && res.error) || 'Couldn’t compare.')); return; }
      if (!res.parts.length) { box.appendChild(el('p', 'dim', 'This app and the folder’s save are the same. Nothing would change.')); return; }
      const total = (p) => p.onlyHere.length + p.onlyFolder.length + (p.changed || 0);
      box.appendChild(el('p', 'fx-hint', `${plural(res.parts.length, 'part')} differ between this app and the folder’s save. Nothing has been changed: this is only a comparison.`));
      const li = (text, cls) => el('li', cls || null, text);
      const sub = (items, more) => { const ul = el('ul', 'sync-sub'); items.slice(0, 10).forEach(t => ul.appendChild(li(t))); if (items.length > 10) ul.appendChild(li(`…and ${items.length - 10} more`, 'sync-more')); return ul; };
      const point = (head, items, effects) => { // one kind of difference: a heading, its items, then what each button does
        const row = li(null, 'sync-point'); row.appendChild(el('span', 'sync-point-head', head));
        if (items && items.length) row.appendChild(sub(items));
        const fx2 = el('ul', 'sync-sub sync-effects');
        effects.forEach(([who, what]) => { const e = li(null); e.append(el('b', null, who + ': '), document.createTextNode(what)); fx2.appendChild(e); });
        row.appendChild(fx2);
        return row;
      };
      for (const p of res.parts) {
        const one = (p.noun && p.noun[0]) || 'item', many = (p.noun && p.noun[1]) || 'items';
        const them = (n) => (n === 1 ? 'it' : 'them');
        const card = el('div', 'sync-change');
        const head = el('div', 'sync-change-head'); head.append(el('strong', null, p.label), el('span', 'sync-count', p.folderHasNone ? 'not in the folder' : plural(total(p), 'difference')));
        card.appendChild(head);
        if (p.about) card.appendChild(el('div', 'fx-hint', `This part holds ${p.about}.`));
        const ul = el('ul', 'sync-points');
        if (p.folderHasNone) ul.appendChild(point('The folder has no save of this part yet.', p.onlyHere, [['Save this app to the folder', 'creates it in the folder from what is here.'], ['Use the folder’s save', 'leaves this part here as it is, because the folder has nothing to bring.']]));
        else {
          if (p.onlyHere.length) ul.appendChild(point(`Only in this app: ${plural(p.onlyHere.length, one, many)}`, p.onlyHere, [['Save this app to the folder', `adds ${them(p.onlyHere.length)} to the folder.`], ['Use the folder’s save', `removes ${them(p.onlyHere.length)} from this app.`]]));
          if (p.onlyFolder.length) ul.appendChild(point(`Only in the folder: ${plural(p.onlyFolder.length, one, many)}`, p.onlyFolder, [['Use the folder’s save', `brings ${them(p.onlyFolder.length)} into this app.`], ['Save this app to the folder', `removes ${them(p.onlyFolder.length)} from the folder.`]]));
          if (p.changed) ul.appendChild(point(`In both, with different content: ${p.changed}`, p.changedNames && p.changedNames.length ? p.changedNames : null, [['Save this app to the folder', 'the folder gets the version from this app.'], ['Use the folder’s save', 'this app gets the version from the folder.']]));
        }
        card.appendChild(ul);
        box.appendChild(card);
      }
    }
    // Sync now: asks whether to save this app to the folder, or to use the folder's save to overwrite this app
    $('#syncNowBtn').addEventListener('click', async () => {
      const st = await window.aredl.syncStatus().catch(() => null);
      if (!st || !st.folder) { syncResultBox('error', 'Connect a Google Drive folder first (Google Drive folder, above).'); return; }
      if (st.needsKey) { syncResultBox('error', 'Sign in with your AREDL API key first. Each API key has its own save file in the folder.'); return; }
      const has = !!(st.remoteFile && st.remoteFile.exists);
      const m = openModal({ title: 'Sync now' });
      m.body.appendChild(el('div', 'fx-note', `Folder: Google Drive › ${st.folderName}`));
      m.body.appendChild(el('div', 'fx-note', has ? `It has a save for this API key, last saved ${ago(st.remoteFile.modifiedTime)}.` : 'It has no save for this API key yet.'));
      const row = el('div', 'fx-row');
      const save = el('button', 'btn small-btn', 'Save this app to the folder'), use = el('button', 'btn btn-ghost small-btn', 'Use the folder’s save'), cancel = el('button', 'btn btn-ghost small-btn', 'Cancel');
      use.disabled = !has; row.append(save, use, cancel); m.body.appendChild(row);
      // what would change, before choosing: a list of every difference between this app and the folder's save (nothing is applied)
      const listBtn = el('button', 'btn btn-ghost small-btn', 'List the changes'), changes = el('div', 'sync-changes');
      listBtn.addEventListener('click', async () => {
        listBtn.disabled = true; listBtn.textContent = 'Comparing…'; changes.innerHTML = '';
        try { renderSyncChanges(changes, await window.aredl.syncPreview()); } catch (err) { changes.appendChild(el('p', 'dim', `Couldn’t compare (${errMsg(err)}).`)); }
        listBtn.disabled = false; listBtn.textContent = 'List the changes again';
      });
      m.body.append(listBtn, changes);
      m.body.appendChild(el('div', 'fx-note small', has ? 'Saving replaces the folder’s save with this app’s data. Using the folder’s save replaces this app’s data with it, and the app reloads.' : 'Saving creates the save in the folder. Using the folder’s save is available once it exists.'));
      save.addEventListener('click', () => { m.close(); runSync('save'); });
      use.addEventListener('click', () => { m.close(); runSync('load'); });
      cancel.addEventListener('click', () => m.close());
    });
    try { // after the reload that applies what was brought in
      const saved = sessionStorage.getItem(SYNC_REPORT_KEY);
      if (saved) { sessionStorage.removeItem(SYNC_REPORT_KEY); const res = JSON.parse(saved); setTimeout(async () => { syncSections = await window.aredl.transferInfo().catch(() => []); showTab('settings'); const d = describeSync(res); syncResultBox('ok', d.title, d.lines); $('#syncResultLine').scrollIntoView({ block: 'center' }); }, 800); }
    } catch { /* no summary */ }
    window.aredl.onSyncWaiting((parts) => actionToast(`Changes from another computer are waiting (${parts.length} ${parts.length === 1 ? 'part' : 'parts'}).`, 'Sync now', () => { showTab('settings'); setTimeout(() => $('#syncNowBtn').click(), 350); }));
  }
  fx.onSettingsShown = () => { refreshSync(); refreshBackdropSettings(); $('#songBulkInfo').textContent = songInfoText(); };

  // ==========================================================================
  // The Demon List Refresh button: a popup with two separate choices that stays open until it is closed
  // ==========================================================================
  fx.openRefreshPopup = function () {
    if (current && current.isRefresh) return;
    const m = openModal({ title: 'Refresh', persistent: true }); m.isRefresh = true;
    const row = (title, about) => {
      const r = el('div', 'fx-refresh-row'), t = el('div', 'fx-refresh-text'), btn = el('button', 'btn small-btn', 'Refresh'), st = el('div', 'fx-hint', '');
      t.append(el('strong', null, title), el('div', 'fx-hint', about), st); r.append(t, btn); m.body.appendChild(r);
      return { btn, st };
    };
    const lv = row('Level info', 'Reloads the list and the selected level. Song names are left alone.');
    lv.btn.addEventListener('click', async () => {
      lv.btn.disabled = true; lv.btn.textContent = 'Refreshing…'; lv.st.textContent = '';
      try { await refreshLevelData(); lv.st.textContent = `Done at ${new Date().toLocaleTimeString()}.`; } catch (err) { lv.st.textContent = `Couldn’t refresh (${errMsg(err)}).`; }
      lv.btn.disabled = false; lv.btn.textContent = 'Refresh';
    });
    const pc = row('Level pictures', 'Loads AREDL’s level pictures again, including levels that had none last time. The app keeps a picture after loading it once, so this is only needed when AREDL has added or changed pictures.');
    pc.btn.addEventListener('click', () => { refreshAredlPictures(); pc.st.textContent = `Done at ${new Date().toLocaleTimeString()}.`; });
    const sg = row('Song info', 'Looks up the selected level’s song again, then finds names for songs that are still unknown (about one a second; the game server is asked first and Newgrounds only if it has no answer). Level info is left alone.');
    const stopBtn = el('button', 'btn btn-ghost small-btn', 'Stop'); stopBtn.hidden = true; sg.btn.parentNode.appendChild(stopBtn);
    stopBtn.addEventListener('click', () => { stopBtn.disabled = true; stopBtn.textContent = 'Stopping…'; window.aredl.songBulkStop(); });
    const onProg = (p) => {
      if (!m.overlay.isConnected) return;
      if (p.running) { sg.btn.hidden = true; stopBtn.hidden = false; stopBtn.disabled = !!p.stop; stopBtn.textContent = p.stop ? 'Stopping…' : 'Stop'; sg.st.textContent = p.stop ? 'Stopping…' : `Looking up song names… ${p.done} of ${p.total}, ${fx.songEta ? fx.songEta(p) : ''}.`; }
      else { sg.btn.hidden = false; sg.btn.disabled = false; sg.btn.textContent = 'Refresh'; stopBtn.hidden = true; sg.st.textContent = `Done at ${new Date().toLocaleTimeString()}.`; }
    };
    window.aredl.onSongBulkProgress(onProg);
    sg.btn.addEventListener('click', async () => {
      sg.btn.disabled = true; sg.btn.textContent = 'Refreshing…'; sg.st.textContent = 'Looking up the selected song…';
      refreshEpoch++; // song menus ask again
      try {
        await bothLevels();
        const sel = state.multi.size >= 2 ? [...state.multi].map(id => state.levels.find(l => String(l.id) === String(id))) : [state.levels.find(l => String(l.id) === String(state.selectedId))];
        for (const l of sel.filter(x => x && x.song > 0)) { const r = await window.aredl.getSongInfo(l.song, { force: true }); if (r && r.ok) rememberSong(l.song, r); }
        await refreshSongCache(); rerenderSongViews();
        const res = await window.aredl.songBulkStart(distinctSongIds());
        if (!res.ok) sg.st.textContent = res.error || 'Couldn’t start.';
        else if (!res.total) sg.st.textContent = `Done at ${new Date().toLocaleTimeString()}. Every song name is already known.`;
      } catch (err) { sg.st.textContent = `Couldn’t refresh (${errMsg(err)}).`; }
      if (!sg.btn.hidden) { sg.btn.disabled = false; sg.btn.textContent = 'Refresh'; }
    });
  };

  // ==========================================================================
  // Start-up
  // ==========================================================================
  const asArray = (v) => (Array.isArray(v) ? v : []);
  async function init() {
    try { fx.filters = asArray(await window.aredl.getStore('saved-filters')).filter(f => f && typeof f.id === 'string' && typeof f.name === 'string'); } catch { fx.filters = []; }
    try { fx.lists = asArray(await window.aredl.getStore('custom-lists')).filter(l => l && typeof l.id === 'string' && typeof l.name === 'string').map(l => ({ ...l, items: asArray(l.items) })); } catch { fx.lists = []; }
    $('#pickBtn').addEventListener('click', () => fx.openPicker());
    const rb = $('#refreshBtn'); if (rb) { rb.addEventListener('click', (e) => { e.stopImmediatePropagation(); fx.openRefreshPopup(); }, true); }
    $('#savedFiltersBtn').addEventListener('click', () => fx.openFiltersMenu());
    $('#plStatsBtn').addEventListener('click', () => fx.showStats());
    $('#plWhatIfBtn').addEventListener('click', () => fx.openWhatIf());
    $('#lbWhatIfBtn').addEventListener('click', () => fx.openWhatIf());
    wireEdelInputs(); wireSongSettings(); wireSync(); wirePaletteKey();
    await refreshSongCache(); rerenderSongViews();
    fx.renderListBar();
  }
  init();
})();

// ---------------------------------------------------------------------------
// Idle screen: after a set time without use, random level thumbnails (YouTube's) fade in full screen, one after another, drifting slowly.
// It is a layer over the app and changes nothing under it, so any movement, click, scroll or key press removes it at once and the app
// is exactly as it was (a click or key that ends it is not also passed on to the app).
// ---------------------------------------------------------------------------
(() => {
  const SHOW_MS = 10000;        // how long each picture stays before the next one fades in
  const el = document.createElement('div');
  el.className = 'idle-saver'; el.hidden = true;
  el.innerHTML = '<div class="idle-layer"></div><div class="idle-layer"></div><div class="idle-cap"></div><div class="idle-cap"></div>';
  document.body.appendChild(el);
  const layers = [...el.querySelectorAll('.idle-layer')], caps = [...el.querySelectorAll('.idle-cap')], levelOf = [null, null];
  const offer = document.createElement('div'); // what comes up after the idle screen: view the level that was on screen
  offer.className = 'idle-offer'; offer.hidden = true;
  document.body.appendChild(offer);
  let offerTimer = 0;
  const hideOffer = () => { clearTimeout(offerTimer); offer.hidden = true; };
  function showOffer(level) {
    if (!level) return;
    offer.textContent = '';
    const msg = document.createElement('span'), name = document.createElement('b'), btn = document.createElement('button');
    name.textContent = level.name || 'this level';
    msg.append('View ', name, ' in the list?');
    btn.className = 'btn'; btn.textContent = 'View';
    btn.title = 'Ctrl+click adds it to multi-select instead';
    btn.addEventListener('click', (ev) => { hideOffer(); if (ev.ctrlKey || ev.metaKey) addToLevelRange(level.level_id); else jumpToLevel(level.level_id, modeOfLevel(level)); });
    offer.append(msg, btn);
    offer.hidden = false;
    clearTimeout(offerTimer);
    offerTimer = setTimeout(() => { if (!offer.matches(':hover')) hideOffer(); }, 9000);
  }
  // it stays for a while; while the mouse is over it, it stays until it is clicked or the mouse leaves it (clicking elsewhere does nothing to it)
  offer.addEventListener('mouseenter', () => clearTimeout(offerTimer));
  offer.addEventListener('mouseleave', () => { clearTimeout(offerTimer); offerTimer = setTimeout(hideOffer, 2500); });
  let lastActive = Date.now(), running = false, starting = false, swallowUntil = 0, runId = 0, lastX = null, lastY = null, front = 0;
  const recent = [];            // the last few levels shown, so the same one doesn't come back at once

  const enabled = () => appSettings.idleOn !== false;
  const idleMs = () => Math.max(30, Number(appSettings.idleSecs) || 120) * 1000;
  const videoPlaying = () => { try { return !!(floatCtx || [...docks].some(d => d.isPlaying())); } catch { return false; } };

  function stop() {
    if (!running) return;
    const seen = levelOf[front];
    running = false; runId++;
    clearTimeout(cursorTimer); el.classList.remove('hide-cursor');
    el.classList.remove('on'); el.hidden = true; // straight away, no fade out
    layers.forEach(l => { l.classList.remove('show'); l.style.backgroundImage = ''; });
    caps.forEach(c => c.classList.remove('show'));
    window.aredl.idleFullscreen(false).catch(() => {}); // the window goes back to how it was
    if (!document.hidden) showOffer(seen);
  }
  const activity = (e) => {
    if (Date.now() < graceUntil) return;
    const press = !!e && ['mousedown', 'pointerdown', 'keydown', 'touchstart'].includes(e.type);
    if (running && !press) {
      if (e && (e.type === 'wheel' || e.type === 'touchmove')) e.preventDefault();
      if (e && e.type === 'mousemove') { // the mouse stays visible, and goes away after 3 seconds without moving
        const moved = lastX == null || Math.abs(e.clientX - lastX) + Math.abs(e.clientY - lastY) >= 1;
        lastX = e.clientX; lastY = e.clientY; pointerIn = true;
        if (moved) wakeCursor();
      }
      return;
    } // only pressing a button ends it: moving or scrolling doesn't
    if (e && e.type === 'mousemove') { // a mouse that merely sits still can still report a move after the page changes: only real movement counts
      const moved = lastX == null || Math.abs(e.clientX - lastX) + Math.abs(e.clientY - lastY) >= 3;
      lastX = e.clientX; lastY = e.clientY;
      if (!moved) return;
    }
    if (!running && e && Date.now() < swallowUntil && ['mousedown', 'touchstart', 'mouseup', 'click', 'keyup', 'pointerup'].includes(e.type)) { e.stopPropagation(); e.preventDefault(); return; } // the rest of the press that ended it
    const was = running;
    lastActive = Date.now();
    if (was) { stop(); if (press) { swallowUntil = Date.now() + 600; e.stopPropagation(); e.preventDefault(); } }
  };
  ['mousemove', 'mousedown', 'pointerdown', 'mouseup', 'click', 'wheel', 'keydown', 'keyup', 'touchstart', 'touchmove', 'contextmenu'].forEach(t => window.addEventListener(t, activity, { capture: true, passive: false }));
  window.addEventListener('focus', () => { lastActive = Date.now(); });
  document.addEventListener('visibilitychange', () => { lastActive = Date.now(); if (document.hidden) stop(); });

  async function pickPicture() { // a random level's YouTube thumbnail: { src, level }
    const pool = (state.levels || []).filter(l => l && l.level_id != null && l.status !== 'Removed');
    for (let tries = 0; tries < 14 && pool.length; tries++) {
      const l = pool[Math.floor(Math.random() * pool.length)];
      if (recent.includes(l.level_id)) continue;
      let vid = levelVidCache.get(String(l.level_id)) || null;
      if (!vid) { try { vid = vidOfDetail(await fetchDetailCached(l.level_id, modeOfLevel(l))); } catch { vid = null; } }
      if (!vid) continue;
      for (const q of ['maxresdefault', 'hqdefault']) {
        const src = `https://img.youtube.com/vi/${vid}/${q}.jpg`;
        const ok = await new Promise(res => { const i = new Image(); i.onload = () => res(i.naturalWidth > 200); i.onerror = () => res(false); i.src = src; });
        if (ok) { recent.push(l.level_id); if (recent.length > 12) recent.shift(); return { src, level: l }; }
      }
    }
    return null;
  }
  const rnd = (a, b) => a + Math.random() * (b - a);
  function caption(i, level) {
    levelOf[i] = level;
    caps[i].textContent = level.name || '';
    if (level.position != null) { const p = document.createElement('small'); p.textContent = `#${level.position}`; caps[i].append(p); }
  }
  function show(layer, src) {
    const zoomIn = Math.random() < 0.65, s0 = zoomIn ? rnd(1.02, 1.06) : rnd(1.12, 1.18), s1 = zoomIn ? rnd(1.12, 1.18) : rnd(1.02, 1.06);
    const dir = () => (Math.random() < 0.5 ? -1 : 1) * rnd(1.5, 4);
    layer.style.cssText = `background-image:url(${src});--s0:${s0};--s1:${s1};--x0:${dir()}%;--y0:${dir() / 2}%;--x1:${dir()}%;--y1:${dir() / 2}%;`;
    layer.classList.remove('show'); void layer.offsetWidth; layer.classList.add('show'); // (restarts its drift)
  }
  let graceUntil = 0, cursorTimer = 0, pointerIn = true;
  const wakeCursor = () => { // visible now; hidden after 3 seconds without moving (only while the mouse is over the app)
    el.classList.remove('hide-cursor');
    clearTimeout(cursorTimer);
    cursorTimer = setTimeout(() => { if (running && pointerIn) el.classList.add('hide-cursor'); }, 3000);
  };
  document.documentElement.addEventListener('mouseleave', () => { pointerIn = false; clearTimeout(cursorTimer); el.classList.remove('hide-cursor'); });
  document.documentElement.addEventListener('mouseenter', () => { pointerIn = true; if (running) wakeCursor(); });
  async function start(preview) {
    const id = ++runId;
    starting = true;
    const first = await pickPicture();
    starting = false;
    if (id !== runId) return;
    if (!first) { lastActive = Date.now() - idleMs() + 15000; if (preview) showToast('No level picture could be found right now.'); return; } // nothing to show yet: try again a bit later
    if (!preview && Date.now() - lastActive < idleMs()) return;
    if (preview) graceUntil = Date.now() + 1500; // used again while the first picture was being found
    running = true; el.hidden = false; void el.offsetWidth; el.classList.add('on');
    window.aredl.idleFullscreen(true).catch(() => {}); // the whole screen, title bar included
    wakeCursor();
    front = 0; show(layers[0], first.src); caption(0, first.level); caps[0].classList.add('show');
    let next = pickPicture();
    while (id === runId) {
      await new Promise(r => setTimeout(r, SHOW_MS));
      if (id !== runId) return;
      const pic = await next;
      if (id !== runId) return;
      if (pic) {
        const back = 1 - front;
        show(layers[back], pic.src);
        caption(back, pic.level); caps[back].classList.add('show'); caps[front].classList.remove('show');
        layers[front].classList.remove('show');
        front = back;
      }
      next = pickPicture(); // the one after is found and loaded while this one is on screen
    }
  }
  setInterval(() => {
    if (running || starting || !enabled() || document.hidden) return;
    if (Date.now() - lastActive < idleMs() || videoPlaying()) return;
    start();
  }, 1000);

  const pv = document.getElementById('idlePreviewBtn');
  if (pv) pv.addEventListener('click', () => { if (!running && !starting) start(true); });
  const on = document.getElementById('idleOnToggle'), secs = document.getElementById('idleSecsSelect');
  if (on) on.addEventListener('change', () => { setSetting('idleOn', on.checked); setSelectDisabled(secs, !on.checked); lastActive = Date.now(); });
  if (secs) secs.addEventListener('change', () => { setSetting('idleSecs', Math.max(30, Number(secs.value) || 120)); lastActive = Date.now(); });
})();
