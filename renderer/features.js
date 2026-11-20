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
    const items = tabs.map(t => ({ kind: 'Go to', label: t.label, hint: 'tab', run: () => showTab(t.id) }));
    items.push(
      { kind: 'Action', label: 'Pick a level', hint: 'random level with filters', keys: 'random dice roll next what should i play', run: () => fx.openPicker() },
      { kind: 'Action', label: 'Points what-if', hint: 'points and rank after beating a level', keys: 'rank points calculator if', run: () => fx.openWhatIf() },
      { kind: 'Action', label: 'Personal list stats', hint: 'charts and yearly recap', keys: 'statistics charts recap', run: () => { showTab('personal'); fx.showStats(true); } },
      { kind: 'Action', label: 'Sync now', hint: 'with your Google Drive folder', keys: 'google drive sync', run: () => { showTab('settings'); setTimeout(() => { const b = $('#syncNowBtn'); if (b && !b.closest('[hidden]')) b.click(); else showToast('Choose a sync folder in Settings first'); }, 400); } },
      { kind: 'Action', label: 'Export or import data', hint: 'settings, favourites, lists…', keys: 'backup export import', run: () => { showTab('settings'); setTimeout(() => { const s = $('#settingsSearch'); if (s) { s.value = 'export'; s.dispatchEvent(new Event('input')); } }, 300); } },
      { kind: 'Action', label: 'Saved filters', hint: 'apply or save a Demon List filter', keys: 'filter preset', run: () => { showTab('list'); setTimeout(() => fx.openFiltersMenu(), 120); } },
    );
    (fx.lists || []).forEach(l => items.push({ kind: 'List', label: l.name, hint: plural(l.items.length, 'level'), run: () => fx.openList(l.id) }));
    (fx.filters || []).forEach(f => items.push({ kind: 'Filter', label: f.name, hint: `${modeLabel(f.mode)} filter`, run: () => { showTab('list'); fx.applySavedFilter(f); } }));
    return items;
  }
  function paletteSearch(q) {
    const query = norm(q).trim();
    const acts = paletteActions();
    if (!query) return acts.slice(0, 14);
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
      if (s) lv.push({ kind: 'Level', label: l.name, hint: `${l.position != null ? '#' + l.position + ' · ' : ''}${modeLabel(m)}${l.song > 0 && songLabelOf(l.song) ? ' · ♪ ' + songLabelOf(l.song) : ''}`, score: s, run: () => jumpToLevel(l.level_id) });
    }));
    lv.sort((a, b) => b.score - a.score).slice(0, 8).forEach(x => out.push(x));
    players.rows.filter(p => norm(p.name).includes(query)).sort((a, b) => (norm(a.name).startsWith(query) ? 0 : 1) - (norm(b.name).startsWith(query) ? 0 : 1) || a.rank - b.rank).slice(0, 5)
      .forEach(p => out.push({ kind: 'Player', label: p.name, hint: `#${p.rank} on the leaderboard`, score: 50, run: () => { showTab('profile'); $('#profileLookup').value = p.id; lookupProfile(p.id); } }));
    deepSearch(query).forEach(x => out.push(x));
    return out.sort((a, b) => b.score - a.score).slice(0, 40);
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
    const add = (kind, label, text, run, base = 30, key = null) => {
      const t = norm(text);
      if (!t.includes(q)) return;
      const k = key || `${kind}:${label}`; if (seen.has(k)) return; seen.add(k);
      out.push({ kind, label: label || '(untitled)', hint: snippet(text, q), score: base + (norm(label).includes(q) ? 12 : 0), run });
    };
    const cap = (n) => { let c = 0; return () => ++c <= n; };
    try { // settings: every option and card
      let ok = cap(8);
      document.querySelectorAll('#tab-settings .setting-line, #tab-settings > .settings-card, #tab-settings .api-logs > .settings-card').forEach(node => {
        if (node.matches('.api-logs .settings-card, .settings-card') && node.querySelector('.setting-line')) return;
        const label = (node.querySelector('.setting-label strong, h3') || {}).textContent || 'Setting', card = node.closest('.settings-card'), cname = card && card.querySelector('h3') ? card.querySelector('h3').textContent : '';
        const text = `${label} ${node.textContent}`;
        if (norm(text).includes(q) && ok()) add('Setting', label.trim(), text, () => { showTab('settings'); setTimeout(() => { node.scrollIntoView({ block: 'center' }); node.classList.add('fx-flash'); setTimeout(() => node.classList.remove('fx-flash'), 1800); }, 250); }, 28, `set:${cname}:${label}`);
      });
    } catch { /* settings not drawn */ }
    try { let ok = cap(6); (typeof submissionsData !== 'undefined' ? submissionsData : []).forEach(it => { const text = flat(it); if (norm(text).includes(q) && ok()) add('Submission', subLevelName(it), text, () => { showTab('submissions'); const id = subLevelId(it); if (id != null) jumpToSubmission(id); }, 32, `sub:${subKey(it)}`); }); } catch { /* none */ }
    try { let ok = cap(6); personalList.forEach((e, i) => { const r = plResolve(e), text = `${r.name} ${flat(e)}`; if (norm(text).includes(q) && ok()) add('Personal', r.name || 'Entry', text, () => { showTab('personal'); fx.showStats(false); setTimeout(() => plOpen(e), 150); }, 32, `pl:${i}`); }); } catch { /* none */ }
    try { let ok = cap(6); notifAll.forEach((n, i) => { const text = flat(n); if (norm(text).includes(q) && ok()) add('Notification', String(n.title || n.message || n.text || n.type || 'Notification').slice(0, 70), text, () => showTab('notifications'), 30, `n:${i}`); }); } catch { /* none */ }
    try { let ok = cap(6); changelogEntries.forEach((c, i) => { const text = flat(c); if (norm(text).includes(q) && ok()) add('List changelog', String(describeChange(c, '')).replace(/<[^>]*>/g, '').slice(0, 70) || 'Entry', text, () => showTab('changelog'), 28, `cl:${i}`); }); } catch { /* none */ }
    try { let ok = cap(6); APP_RELEASES.forEach(r => r.items.forEach(([, t], i) => { if (norm(`${r.title} ${t}`).includes(q) && ok()) add('App changelog', `Version ${r.version}`, `${r.title}. ${t}`, () => { showTab('settings'); setTimeout(() => $('#whatsNewBtn').click(), 250); }, 26, `ac:${r.version}:${i}`); })); } catch { /* none */ }
    try { let ok = cap(6); state.favourites.forEach(f => { const text = flat(f); if (norm(text).includes(q) && ok()) add('Favourite', f.name || String(f.level_id), text, () => { fx.view = null; showTab('favourites'); renderFavourites(); }, 33, `fav:${f.level_id}`); }); } catch { /* none */ }
    try { let ok = cap(6); state.following.concat(followNotifs || []).forEach((f, i) => { const text = flat(f); if (norm(text).includes(q) && ok()) add('Followed', f.name || f.level_name || String(f.level_id), text, () => showTab('followed'), 28, `fo:${i}`); }); } catch { /* none */ }
    try { let ok = cap(6); (fx.lists || []).forEach(l => l.items.forEach(it => { if (norm(it.name).includes(q) && ok()) add('List item', `${it.name}`, `${it.name} in ${l.name}`, () => fx.openList(l.id), 32, `li:${l.id}:${it.level_id}`); })); } catch { /* none */ }
    try { let ok = cap(8); MODES.forEach(m => levelsOf(m).forEach(l => { const tx = levelText(l); if (tx.hay.includes(q) && !tx.name.includes(q) && ok()) add('Level', l.name, `${l.description || ''} ${(l.tags || []).join(' ')}`, () => jumpToLevel(l.level_id), 24, `lv:${l.level_id}`); })); } catch { /* none */ }
    return out;
  }
  function openPalette() {
    if (current && current.isPalette) { current.close(); return; }
    const m = openModal({ title: 'Command palette' });
    m.isPalette = true; m.box.classList.add('palette'); m.body.classList.add('palette-body');
    const input = el('input', 'fx-input palette-input'); input.type = 'text'; input.placeholder = 'Type a level, player, tab or action…'; input.spellcheck = false; input.setAttribute('aria-label', 'Search');
    const list = el('div', 'palette-list'); list.setAttribute('role', 'listbox');
    m.body.append(input, list, el('div', 'palette-foot', '↑ ↓ to move · Enter to open · Tab for the first result · Esc to close · ' + keyLabel(paletteKey()) + ' toggles'));
    let items = [], sel = 0;
    const draw = () => {
      list.replaceChildren();
      if (!items.length) { list.appendChild(el('div', 'palette-empty', input.value ? 'Nothing matches.' : 'Nothing to show yet.')); return; }
      items.forEach((it, i) => {
        const row = el('div', 'palette-row' + (i === sel ? ' sel' : '')); row.setAttribute('role', 'option');
        row.append(el('span', 'palette-kind', it.kind), el('span', 'palette-label', it.label), el('span', 'palette-hint', it.hint || ''));
        row.addEventListener('mousemove', () => { if (sel !== i) { sel = i; draw(); } });
        row.addEventListener('click', () => run(it));
        list.appendChild(row);
      });
      const s = list.querySelector('.sel'); if (s) s.scrollIntoView({ block: 'nearest' });
    };
    const run = (it) => { m.close(); try { it.run(); } catch (err) { showToast(`That didn't work: ${errMsg(err)}`); } };
    const refresh = () => { items = paletteSearch(input.value); sel = 0; draw(); };
    input.addEventListener('input', refresh);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown') { e.preventDefault(); sel = Math.min(items.length - 1, sel + 1); draw(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); sel = Math.max(0, sel - 1); draw(); }
      else if (e.key === 'Enter' && items[sel]) { e.preventDefault(); run(items[sel]); }
      else if (e.key === 'Tab' && input.value.trim() && items[0]) { e.preventDefault(); run(items[0]); } // Tab opens the first result
    });
    refresh(); setTimeout(() => input.focus(), 20);
    bothLevels().then(() => { if (m.overlay.isConnected) refresh(); });
    loadPlayers().then(() => { if (m.overlay.isConnected && input.value) refresh(); });
  }
  fx.openPalette = openPalette;
  // ---- the key that opens the palette (Settings > Command palette); stored as e.g. "`" or "Mod+k" (Mod = Ctrl, or Cmd on a Mac)
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
      const near = (dir) => { // a harder (closer to #1) or easier level, picked from the few nearest ones that match
        const k = key(l), pool = matches.filter(x => x !== l && (dir < 0 ? key(x) < k : key(x) > k)).sort((a, b) => (dir < 0 ? key(b) - key(a) : key(a) - key(b))).slice(0, 5);
        return pool;
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
    if (!ids.length) return 'Finds the names of all songs on the lists, about one per second so Newgrounds isn’t hammered. It runs in the background and you can stop it any time. (Open the Demon List first so the lists are loaded.)';
    const known = ids.filter(id => songNames.has(String(id))).length;
    return `${known} of ${ids.length} song names are known. “Look up all song names” finds the rest, about one per second so Newgrounds isn’t hammered. It runs in the background and you can stop it any time.`;
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
  // Sync (settings card)
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
    if (res.pushed.length) lines.push(`Sent to the folder: ${names(res.pushed)}.`);
    if (res.pulled.length) lines.push(`Brought here: ${names(res.pulled)}.`);
    if (res.merged.length) lines.push(`Combined (first sync, nothing lost): ${names(res.merged)}.`);
    res.conflicts.forEach(c => lines.push(`${partName(c.id)} had changed on both computers – kept ${c.kept}’s version (the other is saved in the sync-backups folder).`));
    if (res.waiting && res.waiting.length) lines.push(`Waiting for you to sync: ${names(res.waiting)}.`);
    return { title: lines.length ? 'Synced.' : 'Already up to date.', lines };
  }
  async function refreshSync() {
    let st;
    try { st = await window.aredl.syncStatus(); } catch { return; }
    if (!syncSections.length) { try { syncSections = await window.aredl.transferInfo(); } catch { /* labels fall back to ids */ } }
    $('#syncMoreLine').hidden = !st.folder;
    $('#syncAuto').checked = st.enabled;
    const parts = $('#syncParts'); parts.replaceChildren();
    (syncSections.length ? syncSections : st.parts.map(id => ({ id, label: id, about: '' }))).forEach(sec => {
      const row = el('label', 'transfer-check'); const cb = el('input'); cb.type = 'checkbox'; cb.value = sec.id; cb.checked = st.parts.includes(sec.id);
      const t = el('span', 'transfer-check-text'); t.appendChild(el('b', null, sec.label)); if (sec.about) t.appendChild(el('small', null, sec.about)); row.append(cb, t); parts.appendChild(row);
    });
    syncExtras(st);
    if (st.folder && st.remote && st.remote.error) syncResultBox('error', st.remote.error);
    else if (st.lastSyncAt && $('#syncResultLine').hidden) {
      const s = st.lastSummary || {}; const bits = []; if (s.pushed && s.pushed.length) bits.push(`sent ${s.pushed.length}`); if (s.pulled && s.pulled.length) bits.push(`received ${s.pulled.length}`);
      syncResultBox('ok', `Last synced ${ago(st.lastSyncAt)}.`, bits.length ? [bits.join(', ') + (plural(0, '').trim() ? '' : '')] : []);
    }
  }
  // this computer's name and a plain description of what is in the folder
  // ---- Google Drive: sign in, create a folder, or pick an existing one (checked to be an AREDL save) ----
  async function driveConnectAndReport(opts, okTitle, okLine) {
    const r = await window.aredl.driveConnect(opts).catch(err => ({ error: errMsg(err) }));
    if (r.error) { syncResultBox('error', r.error); return false; }
    await window.aredl.syncSetEnabled(true);
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
        b.append(el('span', 'fx-folder-name', f.name), f.hasSave ? el('span', 'fx-badge', 'AREDL save') : el('span', 'fx-folder-date', ''), el('span', 'fx-folder-date', f.modifiedTime ? ago(f.modifiedTime) : ''));
        b.addEventListener('click', () => inspect(f));
        list.appendChild(b);
      });
    };
    const reasons = { 'no-save': (n) => `“${n}” doesn’t contain an AREDL save, so it can’t be used as an existing folder. Choose another one, or create a new folder instead.`, 'not-aredl': (n) => `The sync file in “${n}” isn’t a valid AREDL save, so it was left alone.`, newer: (n) => `The save in “${n}” was made by a newer version of the app. Update this app first.` };
    async function inspect(f) {
      msg.textContent = `Checking “${f.name}”…`;
      const res = await window.aredl.driveInspect(f.id).catch(err => ({ error: errMsg(err) }));
      if (!m.overlay.isConnected) return;
      if (res.error) { msg.textContent = `“${f.name}” couldn’t be checked (${res.error}).`; return; }
      if (!res.valid) { msg.textContent = (reasons[res.reason] || reasons['not-aredl'])(f.name); return; }
      choice(f, res);
    }
    function choice(f, res) {
      m.body.replaceChildren();
      m.body.appendChild(el('strong', null, `“${f.name}” holds an AREDL save`));
      if (res.updated) m.body.appendChild(el('div', 'fx-note', `Last saved ${ago(res.updated)}.`));
      res.parts.forEach(p => m.body.appendChild(el('div', 'transfer-detail', `${partName(p.id)} – saved by ${p.by ? `“${p.by}”` : 'an unknown computer'}${p.updatedAt ? `, ${ago(p.updatedAt)}` : ''}`)));
      m.body.appendChild(el('div', 'fx-note small', 'Using the save brings its data to this computer; lists are combined with what is here so nothing is lost. Overwriting replaces the save in the folder with this computer’s data, and what the folder holds now is lost.'));
      const row = el('div', 'fx-row');
      const use = el('button', 'btn small-btn', 'Use this save'), over = el('button', 'btn btn-ghost small-btn danger', 'Overwrite it'), back = el('button', 'btn btn-ghost small-btn', 'Back');
      row.append(use, over, back); m.body.appendChild(row);
      back.addEventListener('click', () => { m.close(); driveChooseFolder(); });
      use.addEventListener('click', async () => { use.disabled = over.disabled = true; m.close(); await driveConnectAndReport({ folderId: f.id, name: f.name, mode: 'use' }, `Using the save in “${f.name}”.`, 'Press “Sync now” to choose between saving this app to the folder or using the folder’s save.'); });
      let armed = false;
      over.addEventListener('click', async () => {
        if (!armed) { armed = true; over.textContent = 'Click again to overwrite'; setTimeout(() => { armed = false; over.textContent = 'Overwrite it'; }, 4000); return; }
        use.disabled = over.disabled = true; m.close();
        await driveConnectAndReport({ folderId: f.id, name: f.name, mode: 'overwrite' }, `The save in “${f.name}” was overwritten.`, 'It now starts from this computer’s data. Choose the same folder on the other computer to bring it in.');
      });
    }
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
    box.appendChild(el('div', 'fx-hint', `Signed in as ${d.account || 'a Google account'}.${d.folder ? ` Syncing with the folder “${d.folder.name}”.` : ' No folder chosen yet.'}`));
    const mk = el('button', 'btn btn-ghost small-btn', 'Create a new folder…'), ex = el('button', 'btn btn-ghost small-btn', 'Choose an existing folder…'), out = el('button', 'btn btn-ghost small-btn', 'Sign out');
    mk.addEventListener('click', async () => {
      const name = await askName({ title: 'New Google Drive folder', label: 'Folder name', value: 'AREDL Desktop', ok: 'Create folder' });
      if (name) await driveConnectAndReport({ mode: 'create', name }, `Folder “${name}” created in Google Drive.`, 'Press “Sync now” and choose “Save this app to the folder”, then choose the same folder on the other computer.');
    });
    ex.addEventListener('click', driveChooseFolder);
    out.addEventListener('click', async () => { await window.aredl.driveSignOut(); $('#syncResultLine').hidden = true; refreshSync(); });
    btns.append(mk, ex, out); box.appendChild(btns);
  }
  async function syncExtras(st) {
    driveUi(st);
    const dev = $('#syncDevice'); if (dev && document.activeElement !== dev) { dev.value = st.device || ''; dev.dataset.saved = st.device || ''; $('#syncDeviceSave').hidden = true; }
    const plan = $('#syncPlan'), line = $('#syncPlanLine');
    if (!plan) return;
    line.hidden = !st.folder; plan.replaceChildren();
    if (!st.folder) return;
    plan.appendChild(el('strong', null, st.provider ? `Folder in ${st.provider}` : 'Sync folder'));
    plan.appendChild(el('div', 'transfer-detail', `This computer is “${st.device}”. The sync file is ${st.file}.`));
    const pv = await window.aredl.syncPreview().catch(() => null);
    if (!pv || !pv.ok) return;
    const names = (a) => a.map(x => partName(x.id)).join(', ');
    const by = (pv.parts.find(x => x.by) || {}).by;
    const g = (act) => pv.parts.filter(x => x.action === act);
    if (!pv.fileExists || (!g('receive').length && !g('merge').length && !g('newer').length && !g('same').length)) plan.appendChild(el('div', 'transfer-detail', `The folder is empty, so the first sync saves from this computer (“${pv.device}”). On the other computer, choose the same folder and sync to bring it in.`));
    else plan.appendChild(el('div', 'transfer-detail', `The folder already has data${by ? ` saved by “${by}”` : ''}.`));
    if (g('start').length) plan.appendChild(el('div', 'transfer-detail', `Saved from this computer first: ${names(g('start'))}.`));
    if (g('receive').length) plan.appendChild(el('div', 'transfer-detail', `Brought in from the folder: ${names(g('receive'))}.`));
    if (g('merge').length) plan.appendChild(el('div', 'transfer-detail', `Combined, nothing lost: ${names(g('merge'))}.`));
    if (g('newer').length) plan.appendChild(el('div', 'transfer-detail', `The newer version wins: ${names(g('newer'))}.`));
  }
  function wireSync() {
    const dev = $('#syncDevice');
    if (dev) {
      dev.addEventListener('input', () => { $('#syncDeviceSave').hidden = dev.value.trim() === (dev.dataset.saved || ''); });
      const save = async () => { await window.aredl.syncSetDevice(dev.value); $('#syncDeviceSave').hidden = true; refreshSync(); showToast('Computer name saved'); };
      $('#syncDeviceSave').addEventListener('click', save);
      dev.addEventListener('keydown', (e) => { if (e.key === 'Enter') save(); });
    }
    $('#syncAuto').addEventListener('change', (e) => window.aredl.syncSetEnabled(e.target.checked));
    $('#syncParts').addEventListener('change', () => window.aredl.syncSetParts([...$('#syncParts').querySelectorAll('input:checked')].map(i => i.value)));
    // Sync now: asks whether to save this app to the folder, or to use the folder's save to overwrite this app
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
    $('#syncNowBtn').addEventListener('click', async () => {
      const st = await window.aredl.syncStatus().catch(() => null);
      if (!st || !st.folder) { syncResultBox('error', 'Connect a Google Drive folder first (Google Drive account, above).'); return; }
      const m = openModal({ title: 'Sync now' });
      const where = st.displayFolder || st.folder;
      m.body.appendChild(el('div', 'fx-note', `Folder: ${where}`));
      m.body.appendChild(el('div', 'fx-note', 'Choose which side is kept. The copy that gets replaced is saved in the sync-backups folder first.'));
      const row = el('div', 'fx-row');
      const save = el('button', 'btn small-btn', 'Save this app to the folder'), use = el('button', 'btn btn-ghost small-btn', 'Use the folder’s save'), cancel = el('button', 'btn btn-ghost small-btn', 'Cancel');
      row.append(save, use, cancel); m.body.appendChild(row);
      m.body.appendChild(el('div', 'fx-note small', 'Saving replaces what the folder holds with this app’s data. Using the folder’s save replaces this app’s data with what the folder holds, and the app reloads.'));
      save.addEventListener('click', () => { m.close(); runSync('save'); });
      use.addEventListener('click', () => { m.close(); runSync('load'); });
      cancel.addEventListener('click', () => m.close());
    });
    try { // after the reload that applies what was brought in
      const saved = sessionStorage.getItem(SYNC_REPORT_KEY);
      if (saved) { sessionStorage.removeItem(SYNC_REPORT_KEY); const res = JSON.parse(saved); setTimeout(async () => { syncSections = await window.aredl.transferInfo().catch(() => []); showTab('settings'); const d = describeSync(res); syncResultBox('ok', d.title, d.lines); $('#syncResultLine').scrollIntoView({ block: 'center' }); }, 800); }
    } catch { /* no summary */ }
    window.aredl.onSyncWaiting((parts) => actionToast(`Changes from your other computer are waiting (${parts.length} ${parts.length === 1 ? 'part' : 'parts'}).`, 'Sync now', () => { showTab('settings'); setTimeout(() => $('#syncNowBtn').click(), 350); }));
  }
  fx.onSettingsShown = () => { refreshSync(); $('#songBulkInfo').textContent = songInfoText(); };

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
    const sg = row('Song info', 'Looks up the selected level’s song again, then finds names for songs that are still unknown (about one a second). Level info is left alone.');
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
