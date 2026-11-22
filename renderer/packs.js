// ---------------------------------------------------------------------------
// Packs: the Packs page, the pack view (opened from anywhere a pack is shown), and the packs a level belongs to.
//
// Requests are kept to the minimum:
//   - the whole list of packs is one request per list (Classic / Platformer), kept for 10 minutes and shared by everything below
//   - the packs of a level are worked out from that list when it is already here; otherwise one small request for that level,
//     which is remembered, so looking at the same level again asks for nothing
//   - nothing is requested until a page or panel actually needs it
// ---------------------------------------------------------------------------
(function () {
  const TTL_MS = 10 * 60 * 1000;
  const tiersCache = { classic: null, platformer: null };   // { at, tiers }
  const tiersLoading = { classic: null, platformer: null }; // in-flight request, so two callers share it
  const packIndex = { classic: null, platformer: null };    // level id -> [pack]
  const levelPacksCache = new Map();                          // level id -> [pack] (from the small per-level request)
  const levelPacksRaw = new Map();                            // level id -> the response itself (shown when raw responses are on)
  const state = { query: '', error: null };

  const esc = (v) => escapeHtml(v);
  const tiersOf = (d) => (Array.isArray(d) ? d : (d && Array.isArray(d.tiers) ? d.tiers : [])).slice().sort((a, b) => (a.placement ?? 1e9) - (b.placement ?? 1e9));
  const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

  function buildIndex(mode, tiers) {
    const idx = new Map();
    for (const t of tiers) for (const p of (t.packs || [])) for (const l of (p.levels || [])) {
      const key = String(l.level_id);
      if (!idx.has(key)) idx.set(key, []);
      if (!idx.get(key).some(x => x.id === p.id)) idx.get(key).push({ id: p.id, name: p.name, tier: { id: t.id, name: t.name, color: t.color }, points: p.points });
    }
    packIndex[mode] = idx;
  }

  function ensureTiers(mode, { force = false } = {}) {
    const c = tiersCache[mode];
    if (!force && c && Date.now() - c.at < TTL_MS) return Promise.resolve(c.tiers);
    if (tiersLoading[mode]) return tiersLoading[mode];
    tiersLoading[mode] = window.aredl.getPackTiers(mode).then(d => {
      const tiers = tiersOf(d);
      tiersCache[mode] = { at: Date.now(), tiers, raw: d };
      buildIndex(mode, tiers);
      return tiers;
    }).finally(() => { tiersLoading[mode] = null; });
    return tiersLoading[mode];
  }
  const cachedTiers = (mode) => (tiersCache[mode] ? tiersCache[mode].tiers : null);
  const rawTiers = (mode) => (tiersCache[mode] ? tiersCache[mode].raw : null);

  // ---- chips -------------------------------------------------------------------------------------------------------
  function chipHtml(p, mode) {
    const color = p.tier && p.tier.color;
    return `<button type="button" class="pack-chip" data-pack-id="${esc(p.id)}" data-pack-mode="${esc(mode)}" title="${esc(p.tier ? p.tier.name : 'Pack')} – view this pack"${color ? ` style="--pack-bg:${esc(color)};"` : ''}><i></i>${esc(p.name)}</button>`;
  }

  // ---- the packs of one level (the level panel) -------------------------------------------------------------------
  async function packsOfLevel(levelId, mode) {
    const key = String(levelId);
    if (packIndex[mode]) return packIndex[mode].get(key) || [];   // worked out from the list that is already here
    if (levelPacksCache.has(key)) return levelPacksCache.get(key);
    const d = await window.aredl.getLevelPacks(levelId, mode);
    levelPacksRaw.set(key, d);
    const list = (Array.isArray(d) ? d : []).map(p => ({ id: p.id, name: p.name, tier: p.tier ? { id: p.tier.id, name: p.tier.name, color: p.tier.color } : null }));
    levelPacksCache.set(key, list);
    return list;
  }
  let levelToken = 0;
  window.showLevelPacks = async function (levelId, mode) {
    let zone = document.getElementById('levelPacks');
    if (!zone) { // the panel was turned from a range back into one level: it has no packs strip yet
      const stage = document.getElementById('videoStage');
      if (!stage || stage.classList.contains('multi')) return;
      zone = document.createElement('div'); zone.id = 'levelPacks'; zone.className = 'level-packs'; stage.appendChild(zone);
    }
    const token = ++levelToken;
    const key = String(levelId);
    const known = packIndex[mode] ? packIndex[mode].get(key) : levelPacksCache.get(key);
    if (!known) zone.innerHTML = '<span class="level-packs-label">Packs</span><span class="level-packs-wait">…</span>';
    try {
      const list = known || await packsOfLevel(levelId, mode);
      if (token !== levelToken) return; // another level was opened meanwhile
      zone.hidden = !list.length;
      zone.innerHTML = list.length ? `<span class="level-packs-label">${list.length === 1 ? 'In a pack' : `In ${list.length} packs`}</span>${list.map(p => chipHtml(p, mode)).join('')}${rawDetails(levelPacksRaw.has(key) ? 'API response for this level’s packs' : 'This level’s packs (from the full pack list)', levelPacksRaw.has(key) ? levelPacksRaw.get(key) : list, ' style="flex-basis:100%;"')}` : '';
    } catch {
      if (token === levelToken) { zone.hidden = true; zone.innerHTML = ''; } // no packs shown rather than an error on the level
    }
  };

  // ---- a range of levels: a button loads the packs of every selected level --------------------------------------------
  let multiLoaded = false;
  window.renderMultiPacks = function () {
    const zone = document.getElementById('multiPacksZone');
    if (!zone) return;
    const levels = (typeof multiOrder !== 'undefined' && multiOrder) ? multiOrder : [];
    if (!levels.length) { zone.innerHTML = ''; return; }
    const mode = (levels[0] && modeOfLevel(levels[0])) || tabModes.list;
    if (!multiLoaded || !packIndex[mode]) {
      zone.innerHTML = `<button type="button" class="btn btn-ghost small-btn" id="multiLoadPacks">Load packs</button> <span class="dim">Shows which packs these levels are in.</span>`;
      return;
    }
    const rows = levels.map(l => ({ l, packs: packIndex[mode].get(String(l.level_id)) || [] })).filter(r => r.packs.length);
    zone.innerHTML = `<div class="stat-label">Packs</div>${rows.length ? `<div class="multi-packs">${rows.map(r => `<div class="multi-pack-row"><span class="multi-pack-level" data-jump="${esc(r.l.level_id)}">${r.l.position != null ? '#' + esc(r.l.position) + ' ' : ''}${esc(r.l.name)}</span><span class="multi-pack-chips">${r.packs.map(p => chipHtml(p, mode)).join('')}</span></div>`).join('')}</div>` : '<div class="dim">None of these levels are in a pack.</div>'}${rawDetails('Packs of the selected levels (from the full pack list)', rows.map(r => ({ level_id: r.l.level_id, name: r.l.name, packs: r.packs })))}`;
  };
  document.addEventListener('click', async (e) => {
    const btn = e.target.closest('#multiLoadPacks');
    if (!btn) return;
    btn.disabled = true; btn.textContent = 'Loading…';
    const mode = (multiOrder && multiOrder[0] && modeOfLevel(multiOrder[0])) || tabModes.list;
    try { await ensureTiers(mode); multiLoaded = true; } catch { showToast('The packs couldn’t be loaded. Try again in a moment.'); }
    renderMultiPacks();
  });

  // ---- the pack view -----------------------------------------------------------------------------------------------------
  function levelRowHtml(l) {
    const rank = l.position != null ? `#${l.position}` : (l.status || 'Legacy');
    const done = l.completed_by_user === true;
    return `<div class="completed-banner pack-level${done ? ' pack-level-done' : ''}" data-jump="${esc(l.level_id)}" data-pack-level="${esc(l.level_id)}">
      <span class="c-rank">${esc(rank)}</span>
      <div class="c-main">
        <div class="c-name">${esc(l.name)}${l.two_player ? ' <span class="pack-2p">2P</span>' : ''}</div>
        <div class="c-meta">${formatPoints(l.points)} points${l.status && l.status !== 'MainList' ? ` · ${esc(l.status)}` : ''}</div>
      </div>
      ${done ? '<span class="pack-check" title="You have beaten this level" aria-label="Beaten">✓</span>' : ''}
    </div>`;
  }
  function attachLevelPictures(root) { // AREDL's own picture of each level as the row's background (no request per level to find a video)
    root.querySelectorAll('[data-pack-level]').forEach(row => {
      const id = row.dataset.packLevel;
      if (aredlMissing.has(String(id))) return;
      const url = picUrl(`a:${id}`, 'cards');
      const img = new Image();
      img.onload = () => { logPic(url, true); row.classList.add('has-bg'); row.style.setProperty('--bg-thumb', `url(${url})`); };
      img.onerror = () => { logPic(url, false); aredlMissing.add(String(id)); };
      img.src = url;
    });
  }
  function findPack(tiers, packId) {
    for (const t of tiers) for (const p of (t.packs || [])) if (String(p.id) === String(packId)) return { pack: p, tier: t };
    return null;
  }
  window.openPack = async function (packId, mode) {
    mode = mode || tabModes.packs || 'classic';
    const m = fx.openModal({ title: 'Pack', wide: true });
    m.body.innerHTML = '<div class="state">Loading the pack…</div>';
    try {
      let tiers = await ensureTiers(mode);
      let hit = findPack(tiers, packId);
      if (!hit) { // the pack may be in the other list
        const other = mode === 'classic' ? 'platformer' : 'classic';
        tiers = await ensureTiers(other); hit = findPack(tiers, packId); if (hit) mode = other;
      }
      if (!hit) { m.body.innerHTML = '<div class="dim">That pack wasn’t found.</div>'; return; }
      const { pack, tier } = hit;
      const levels = (pack.levels || []).slice().sort((a, b) => (a.position ?? 1e9) - (b.position ?? 1e9));
      const known = levels.some(l => typeof l.completed_by_user === 'boolean');
      const done = levels.filter(l => l.completed_by_user === true).length;
      m.box.setAttribute('aria-label', pack.name || 'Pack');
      m.box.querySelector('.fx-head strong').textContent = pack.name || 'Pack';
      m.body.innerHTML = `
        <div class="pack-view-top"${tier.color ? ` style="--pack-bg:${esc(tier.color)};"` : ''}>
          <span class="pack-tier">${esc(tier.name)}</span>
          <span class="pack-view-stat"><strong>${formatPoints(pack.points)}</strong> points</span>
          <span class="pack-view-stat"><strong>${levels.length}</strong> ${levels.length === 1 ? 'level' : 'levels'}</span>
          ${known ? `<span class="pack-view-stat"><strong>${done}/${levels.length}</strong> beaten</span>` : ''}
        </div>
        ${known ? `<div class="pack-progress"><i style="width:${levels.length ? Math.round(done / levels.length * 100) : 0}%"></i></div>` : ''}
        <div class="pack-level-list">${levels.map(levelRowHtml).join('') || '<div class="dim">No levels in this pack.</div>'}</div>
        ${rawDetails('Full API response for this pack', { tier: { id: tier.id, name: tier.name, color: tier.color, placement: tier.placement }, pack })}`;
      attachLevelPictures(m.body);
      m.body.addEventListener('click', (e) => { if (e.target.closest('[data-jump]')) m.close(); }); // the page navigates (its own handler); the view closes
    } catch {
      m.body.innerHTML = '<div class="dim">The pack couldn’t be loaded. Try again in a moment.</div>';
    }
  };
  document.addEventListener('click', (e) => {
    const el = e.target.closest('[data-pack-id]');
    if (!el || el.closest('.fx-modal')) return;
    e.preventDefault(); e.stopPropagation();
    openPack(el.dataset.packId, el.dataset.packMode || null);
  }, true);

  // ---- the Packs page -----------------------------------------------------------------------------------------------------
  function packCardHtml(p, tier, mode) {
    const levels = p.levels || [];
    const known = levels.some(l => typeof l.completed_by_user === 'boolean');
    const done = levels.filter(l => l.completed_by_user === true).length;
    return `<div class="pack-banner pack-card" data-pack-id="${esc(p.id)}" data-pack-mode="${esc(mode)}" tabindex="0" title="View this pack"${tier.color ? ` style="--pack-bg:${esc(tier.color)};"` : ''}>
      <div class="pack-name">${esc(p.name)}</div>
      <div class="pack-tier">${esc(tier.name)}</div>
      <div class="pack-card-meta">${plural(levels.length, 'level', 'levels')} · ${formatPoints(p.points)} points${known ? ` · ${done}/${levels.length} beaten` : ''}</div>
    </div>`;
  }
  function renderPacksPage() {
    const mode = tabModes.packs || 'classic';
    const list = document.getElementById('packsList'), stateEl = document.getElementById('packsState'), count = document.getElementById('packsCount');
    if (!list) return;
    const tiers = cachedTiers(mode);
    if (!tiers) return;
    const terms = (state.query || '').toLowerCase().split(/\s+/).filter(Boolean);
    const matches = (p, t) => !terms.length || terms.every(w => `${p.name} ${t.name} ${(p.levels || []).map(l => l.name).join(' ')}`.toLowerCase().includes(w));
    let total = 0, shown = 0;
    const html = tiers.map(t => {
      const packs = (t.packs || []);
      total += packs.length;
      const hit = packs.filter(p => matches(p, t));
      shown += hit.length;
      if (!hit.length) return '';
      return `<section class="pack-tier-block"${t.color ? ` style="--pack-bg:${esc(t.color)};"` : ''}>
        <h3 class="pack-tier-head"><i></i>${esc(t.name)}<span class="dim-count">${hit.length}</span></h3>
        <div class="pack-grid">${hit.map(p => packCardHtml(p, t, mode)).join('')}</div>
      </section>`;
    }).join('');
    list.innerHTML = html;
    count.textContent = total ? (terms.length ? `${shown} of ${total}` : String(total)) : '';
    stateEl.textContent = !total ? 'No packs yet.' : (shown ? '' : 'No packs match that search.');
    stateEl.style.display = stateEl.textContent ? '' : 'none';
  }
  async function loadPacksPage({ force = false } = {}) {
    const mode = tabModes.packs || 'classic';
    const stateEl = document.getElementById('packsState');
    if (!stateEl) return;
    const showRaw = () => { const z = document.getElementById('packsRawZone'); const raw = rawTiers(mode); if (z) z.innerHTML = raw ? rawDetails(`Full API response (${(cachedTiers(mode) || []).reduce((n, t) => n + (t.packs || []).length, 0)} packs)`, raw) : ''; };
    if (!force && cachedTiers(mode)) { renderPacksPage(); showRaw(); return; } // already here: no request
    stateEl.style.display = ''; stateEl.textContent = 'Loading packs…';
    try { await ensureTiers(mode, { force }); renderPacksPage(); showRaw(); }
    catch { stateEl.style.display = ''; stateEl.textContent = 'The packs couldn’t be loaded. Press Refresh to try again.'; }
  }
  window.loadPacksPage = loadPacksPage;
  // for the command palette: the pack lists of both modes are loaded quietly (one request each, shared with the Packs tab) and searched here
  window.prefetchPacks = () => Promise.all(['classic', 'platformer'].map(m => ensureTiers(m).catch(() => null)));
  window.searchPacks = (query) => {
    const q = String(query || '').toLowerCase(), out = [];
    if (!q) return out;
    ['classic', 'platformer'].forEach(mode => (cachedTiers(mode) || []).forEach(t => (t.packs || []).forEach(p => {
      const inName = String(p.name || '').toLowerCase().includes(q), inTier = String(t.name || '').toLowerCase().includes(q);
      const lv = inName || inTier ? null : (p.levels || []).find(l => String(l.name || '').toLowerCase().includes(q));
      if (inName || inTier || lv) out.push({ id: p.id, mode, name: p.name, tier: t.name, count: (p.levels || []).length, level: lv ? lv.name : '', exact: String(p.name || '').toLowerCase().startsWith(q) });
    })));
    return out;
  };

  // the page's controls
  addModeSelect('packs', () => loadPacksPage());
  document.getElementById('packsSearch').addEventListener('input', (e) => { state.query = e.target.value; renderPacksPage(); });
  document.getElementById('packsRefreshBtn').addEventListener('click', () => loadPacksPage({ force: true }));
  document.getElementById('packsList').addEventListener('keydown', (e) => {
    const c = e.target.closest('.pack-card');
    if (c && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); openPack(c.dataset.packId, c.dataset.packMode); }
  });
})();
