// ---------------------------------------------------------------------------
// Guided tour
// Runs once on first open (and again for anyone who hasn't seen this version of it), and can be
// replayed from Settings > About. Each step can switch tab, prepare something (select a level, open
// the right-click menu), and spotlight an element with a small card explaining it.
// Uses globals from app.js: showTab, state, appSettings, setSetting, selectLevel, hideContextMenu...
// ---------------------------------------------------------------------------
(() => {
  const TOUR_VERSION = 1; // raise this to show the tour again to everyone after adding big new features

  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const q = (sel) => document.querySelector(sel);
  const navTop = () => document.body.classList.contains('nav-top');

  // Keep trying until fn() gives something (elements that appear after async loading), or give up.
  async function waitFor(fn, ms = 2500) {
    const t0 = Date.now();
    for (;;) {
      let v = null;
      try { v = fn(); } catch { v = null; }
      if (v) return v;
      if (Date.now() - t0 > ms) return null;
      await sleep(80);
    }
  }

  // ---- the steps ------------------------------------------------------------------------------
  // title/body may be functions (evaluated when the step is shown). target may be an element, a CSS
  // selector, a function returning either, or an array (the spotlight then covers all of them).
  const STEPS = [
    {
      id: 'welcome',
      title: 'Welcome to AREDL Desktop',
      body: 'A quick tour of what the app can do. Use the buttons or <kbd>←</kbd> <kbd>→</kbd>, and <kbd>Esc</kbd> to skip. You can replay it any time from <b>Settings → About</b>.<span class="tour-rec">We recommend taking this tour: it only takes a minute and shows features that are easy to miss.</span>',
    },
    {
      id: 'tabs',
      tab: 'list',
      target: () => (navTop() ? q('#topNav') : q('.sidebar')),
      side: () => (navTop() ? 'bottom' : 'right'),
      title: 'Your tabs',
      body: () => 'Everything lives in these tabs: the <b>Demon List</b>, your <b>Favourites</b>, <b>Personal list</b>, <b>Followed levels</b>, the <b>Leaderboard</b>, your <b>Profile</b> and <b>Settings</b>.'
        + (navTop() && q('#navMore') && !q('#navMore').hidden ? ' Tabs you tuck away sit behind the <b>⋯</b> button.' : ''),
    },
    {
      id: 'list',
      tab: 'list',
      needsLevels: true,
      before: async () => {
        await waitFor(() => q('#list .list-row'));
        if (state.selectedId == null && state.filtered && state.filtered[0] && typeof selectLevel === 'function') selectLevel(state.filtered[0]);
      },
      target: '.list-col',
      side: 'right',
      title: 'The list',
      body: 'Click a level to open its video, details and records on the right. When you’re signed in with your API key, levels you’ve beaten get a ✓.',
    },
    {
      id: 'modes',
      tab: 'list',
      target: '.mode-bar',
      side: 'right',
      title: 'Classic and Platformer',
      body: 'This dropdown under the list switches between the <b>Classic</b> and <b>Platformer</b> lists. Favourites, Followed levels, the Personal list, Profile, Submissions, Changelog and the Leaderboard (which also has a Countries board) have the same dropdown. They start on Classic, except Favourites and Submissions, which also have an <b>All</b> option and start on it.',
    },
    {
      id: 'search',
      tab: 'list',
      target: '.search-wrap',
      side: 'bottom',
      title: 'Search and filters',
      body: 'Type a level name, or mix in filters: <code>pos:1-75</code>, <code>tag:wave</code>, <code>status:legacy</code>, <code>id:…</code>. Use <code>||</code> for “or” and quotes for an exact name. Click the <b>i</b> for the full guide.',
    },
    {
      id: 'filters',
      tab: 'list',
      target: () => ['#tagFilterBtn', '#statusFilter', '#sortBy', '#refreshBtn'].map(q).filter(Boolean),
      side: 'bottom',
      title: 'Narrow it down',
      body: 'The <b>tag</b> button includes or excludes tags (green = must have, red = must not). The status menu starts on <b>All statuses</b>, and you can sort by position, points or A–Z.',
    },
    {
      id: 'tools',
      tab: 'list',
      needsLevels: true,
      before: () => waitFor(() => q('#detailInner .detail-title .title-tools'), 3000),
      target: '#detailInner .detail-title .title-tools',
      side: 'bottom',
      title: 'Buttons by the level name',
      body: 'The <b>bell</b> follows the level, the <b>link</b> copies its AREDL address, the <b>arrow</b> opens it on AREDL, and the <b>play</b> button searches it on YouTube.',
    },
    {
      id: 'rightclick',
      tab: 'list',
      needsLevels: true,
      noScroll: true,
      before: async () => {
        const row = await waitFor(() => q('#list .list-row'));
        if (!row) return;
        row.scrollIntoView({ block: 'nearest' });
        await sleep(200); // let any scrolling settle first (scrolling closes the menu)
        const r = row.getBoundingClientRect();
        row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, view: window, clientX: r.left + 70, clientY: r.top + r.height / 2 }));
        await sleep(200);
      },
      after: () => { if (typeof hideContextMenu === 'function') hideContextMenu(); },
      target: '#ctxMenu',
      side: 'right',
      title: 'Right-click for more',
      body: 'Right-click any level, in the list, Favourites or Followed, to copy its link or ID, open it, search YouTube, <b>add it to Favourites</b> (and pick a category) or <b>follow</b> it.',
    },
    {
      id: 'multi',
      tab: 'list',
      needsLevels: true,
      target: '.list-col',
      side: 'right',
      title: 'Select several levels',
      body: 'Hold <kbd>Ctrl</kbd> (<kbd>⌘</kbd> on Mac) and click more levels to pick them together. With two or more selected, the right side becomes a level range you can flip through with the arrows.',
    },
    {
      id: 'favourites',
      tab: 'favourites',
      target: '#tab-favourites .tab-title-row',
      side: 'bottom',
      title: 'Favourites',
      body: 'Your favourited levels, grouped by <b>category</b> to start with: Completed, Planning to beat, Want to beat, In progress, On hold and Dropped. You can also sort by position or by list. Add one by right-clicking a level in the Demon List.',
    },
    {
      id: 'followed',
      tab: 'followed',
      target: '#tab-followed .tab-title-row',
      side: 'bottom',
      title: 'Followed levels',
      body: 'Follow a level and the app checks it in the background (every 2 minutes by default, changeable in Settings). When it moves, changes status, or something near it changes, you get a notification, and it appears in the <b>Notifications</b> tab.',
    },
    {
      id: 'personal',
      tab: 'personal',
      target: ['#tab-personal .tab-title-row', '#plStatsBtn'],
      side: 'bottom',
      title: 'Personal list',
      body: 'Your own hardest list, with attempts, physics, version, date and video for every level you’ve beaten. You can also log partial runs like <code>53-79</code>: they get their own list, and a level shows how few runs cover every % from 1 to 100. Click a stat to copy it, or export everything as CSV. The <b>Stats</b> button opens charts and a yearly recap.',
    },
    {
      id: 'topbar',
      tab: 'settings',
      navOptions: true, // the options under "Tabs in the top bar" only exist once it's on: show them for these steps
      when: () => !!q('#navTopWrap') && !q('#navTopWrap').hidden,
      target: '#navCard',
      side: 'left',
      title: 'Tabs in the top bar',
      body: 'Prefer the tabs along the top? Turn on <b>Tabs in the top bar</b>. You can show full names, or just icons that expand when you hover them. <i>These options normally appear once it’s on; we’re showing them for the tour.</i>',
    },
    {
      id: 'menubutton',
      tab: 'settings',
      navOptions: true,
      when: () => !!q('#navTopWrap') && !q('#navTopWrap').hidden,
      target: () => { const t = q('#navMenuToggle'); return t && t.closest('.setting-line'); },
      side: 'left',
      title: 'The ⋯ menu button',
      body: 'Switch on <b>Use a menu button</b> to add a small <b>⋯</b> button to the bar. Tabs you drop into it fold away into a dropdown, so the bar never gets crowded.',
    },
    {
      id: 'reorder',
      tab: 'settings',
      navOptions: true,
      when: () => !!q('#navTopWrap') && !q('#navTopWrap').hidden,
      target: '#navReorderBtn',
      side: 'left',
      title: 'Reorder your tabs',
      body: 'Press <b>Reorder tabs</b>, then drag tabs along the bar, to the other side, or into the <b>⋯</b> menu to keep the bar tidy. Press <b>Done</b> when you’re happy.',
    },
    {
      id: 'adaptive',
      tab: 'settings',
      target: '[data-theme-id="adaptive"]',
      side: 'right',
      title: 'Adaptive Glass',
      body: 'A see-through theme that picks up its colours from the level you’re looking at, so the backdrop and accent colour change as you browse. Pick it here, then fine-tune the tint in the Adaptive Glass card.',
    },
    {
      id: 'more',
      tab: 'settings',
      title: 'Lots more to customise',
      body: 'Settings goes much further than this tour: accent colour, corner roundness, list density, backdrop blur and brightness, how videos behave, how often things refresh, and more. Have a poke around, nothing here can break anything.',
    },
    {
      id: 'done',
      title: 'That’s it!',
      body: 'You’re all set. If you ever want a refresher, go to <b>Settings → About</b> and press <b>Replay tour</b>.',
    },
  ];

  // ---- the overlay ---------------------------------------------------------------------------
  let root = null, spot = null, card = null;
  let active = false, index = 0, startTab = 'list', goSeq = 0, resizeTimer = 0;

  function build() {
    root = document.createElement('div');
    root.id = 'tour';
    root.hidden = true;
    root.innerHTML = `
      <div class="tour-block"></div>
      <div class="tour-spot"></div>
      <div class="tour-card" role="dialog" aria-live="polite" aria-label="App tour">
        <div class="tour-meta"><span class="tour-count"></span></div>
        <div class="tour-progress"><i></i></div>
        <div class="tour-text"><h3></h3><p></p></div>
        <div class="tour-actions">
          <button class="linklike tour-skip" type="button">Skip tour</button>
          <span class="tour-spacer"></span>
          <button class="btn btn-ghost tour-back" type="button">Back</button>
          <button class="btn tour-next" type="button">Next</button>
        </div>
      </div>`;
    document.body.appendChild(root);
    spot = root.querySelector('.tour-spot');
    card = root.querySelector('.tour-card');
    root.querySelector('.tour-next').addEventListener('click', () => next());
    root.querySelector('.tour-back').addEventListener('click', () => back());
    root.querySelector('.tour-skip').addEventListener('click', () => finish());
  }

  const resolve = (t) => (typeof t === 'function' ? resolve(t()) : (typeof t === 'string' ? q(t) : t));
  function targetRect(target) {
    const list = (Array.isArray(target) ? target : [target]).map(resolve).flat().filter(Boolean);
    let l = Infinity, t = Infinity, r = -Infinity, b = -Infinity;
    list.forEach(e => {
      const rc = e.getBoundingClientRect();
      if (rc.width <= 0 || rc.height <= 0) return;
      l = Math.min(l, rc.left); t = Math.min(t, rc.top); r = Math.max(r, rc.right); b = Math.max(b, rc.bottom);
    });
    return Number.isFinite(l) ? { left: l, top: t, right: r, bottom: b, width: r - l, height: b - t } : null;
  }

  // Put the spotlight on the rectangle (or dim everything when there is none), then place the card beside it.
  function place(rect, sidePref) {
    const pad = 8, gap = 16, margin = 12;
    const vw = window.innerWidth, vh = window.innerHeight;
    const cw = card.offsetWidth, ch = card.offsetHeight;
    const clamp = (v, lo, hi) => Math.max(lo, Math.min(v, hi));

    if (!rect) {
      spot.style.left = vw / 2 + 'px'; spot.style.top = vh * 0.42 + 'px';
      spot.style.width = '0px'; spot.style.height = '0px';
      card.style.left = Math.round((vw - cw) / 2) + 'px';
      card.style.top = Math.round(Math.max(margin, vh * 0.42 - ch / 2)) + 'px';
      return;
    }
    const sx = clamp(rect.left - pad, 4, vw - 8), sy = clamp(rect.top - pad, 4, vh - 8);
    const sr = clamp(rect.right + pad, sx + 8, vw - 4), sb = clamp(rect.bottom + pad, sy + 8, vh - 4);
    spot.style.left = sx + 'px'; spot.style.top = sy + 'px';
    spot.style.width = (sr - sx) + 'px'; spot.style.height = (sb - sy) + 'px';

    const cx = (sx + sr) / 2, cy = (sy + sb) / 2;
    const fits = (x, y) => x >= margin && y >= margin && x + cw <= vw - margin && y + ch <= vh - margin;
    const spots = {
      bottom: [cx - cw / 2, sb + gap],
      top: [cx - cw / 2, sy - ch - gap],
      right: [sr + gap, cy - ch / 2],
      left: [sx - cw - gap, cy - ch / 2],
    };
    const order = [sidePref, 'bottom', 'top', 'right', 'left'].filter((s, i, a) => s && a.indexOf(s) === i);
    let pos = null;
    for (const s of order) {
      let [x, y] = spots[s];
      // slide along the edge so it stays on screen
      if (s === 'bottom' || s === 'top') x = clamp(x, margin, vw - cw - margin); else y = clamp(y, margin, vh - ch - margin);
      if (fits(x, y)) { pos = [x, y]; break; }
    }
    if (!pos) pos = [clamp(vw - cw - margin, margin, vw), clamp(vh - ch - margin, margin, vh)]; // target fills the window: tuck the card in the corner
    card.style.left = Math.round(pos[0]) + 'px';
    card.style.top = Math.round(pos[1]) + 'px';
  }

  function setText(step, i) {
    const val = (v) => (typeof v === 'function' ? v() : v);
    card.querySelector('h3').textContent = val(step.title);
    card.querySelector('p').innerHTML = val(step.body);
    const visible = visibleSteps();
    const pos = visible.indexOf(i);
    card.querySelector('.tour-count').textContent = `${pos + 1} of ${visible.length}`;
    card.querySelector('.tour-progress i').style.width = `${((pos + 1) / visible.length) * 100}%`;
    const first = pos === 0, last = pos === visible.length - 1;
    card.querySelector('.tour-back').hidden = first;
    card.querySelector('.tour-skip').hidden = last;
    card.querySelector('.tour-next').textContent = first ? 'Start tour' : (last ? 'Finish' : 'Next');
    card.classList.remove('swap'); void card.offsetWidth; card.classList.add('swap'); // little fade for the new text
  }

  // Steps that make no sense right now (no level data yet, tab-bar options this platform lacks) are skipped.
  const stepOk = (s) => !(s.needsLevels && !(state.levels && state.levels.length)) && !(s.when && !s.when());
  function visibleSteps() { return STEPS.map((s, i) => i).filter(i => stepOk(STEPS[i])); }

  // "Tabs in the top bar" options are hidden until that setting is on. For the steps that explain them they are
  // revealed temporarily (the setting itself is never touched) and put back as soon as the tour moves on.
  let navOptionsForced = false;
  function forceNavOptions(on) {
    const box = q('#navTopOptions');
    if (!box) return;
    if (on) { navOptionsForced = true; box.hidden = false; }
    else if (navOptionsForced) { navOptionsForced = false; box.hidden = !document.body.classList.contains('nav-top'); }
  }

  async function show(i) {
    const seq = ++goSeq;
    const step = STEPS[i];
    index = i;
    setText(step, i);
    forceNavOptions(!!step.navOptions);
    if (step.tab && !q(`#tab-${step.tab}.active`)) {
      showTab(step.tab);
      await sleep(380); // the tab fades in; measure after it has settled
    }
    if (step.before) { try { await step.before(); } catch { /* a step that can't prepare still shows */ } }
    if (seq !== goSeq || !active) return;

    let target = step.target;
    if (target && !step.noScroll) {
      const el = await waitFor(() => [].concat(resolve(target)).flat().find(Boolean), 1500);
      if (el && el.scrollIntoView) el.scrollIntoView({ block: 'center', inline: 'nearest' });
      await sleep(60);
    } else if (target) {
      await waitFor(() => [].concat(resolve(target)).flat().find(Boolean), 1500);
    }
    if (seq !== goSeq || !active) return;
    const side = typeof step.side === 'function' ? step.side() : step.side;
    place(target ? targetRect(target) : null, side);
    // layout can still shift a little (images, async content): measure once more
    setTimeout(() => { if (active && seq === goSeq) place(target ? targetRect(target) : null, side); }, 350);
  }

  async function go(delta) {
    const visible = visibleSteps();
    const at = visible.indexOf(index);
    const to = visible[at + delta];
    const cur = STEPS[index];
    if (cur && cur.after) { try { cur.after(); } catch { /* ignore */ } }
    if (to === undefined) { if (delta > 0) finish(); return; }
    await show(to);
  }
  const next = () => go(1);
  const back = () => go(-1);

  function finish() {
    if (!active) return;
    active = false;
    goSeq++;
    const cur = STEPS[index];
    if (cur && cur.after) { try { cur.after(); } catch { /* ignore */ } }
    if (typeof hideContextMenu === 'function') hideContextMenu();
    forceNavOptions(false);
    root.hidden = true;
    document.removeEventListener('keydown', onKey, true);
    window.removeEventListener('resize', onResize);
    if (startTab && !q(`#tab-${startTab}.active`)) showTab(startTab);
    if (typeof setSetting === 'function') setSetting('tourSeen', TOUR_VERSION);
  }

  function onKey(e) {
    if (!active) return;
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(); }
    else if (e.key === 'ArrowRight' || e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); next(); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); e.stopPropagation(); back(); }
  }
  function onResize() {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => { if (active) show(index); }, 200); // re-run the step (the right-click menu closes on resize)
  }

  function startTour() {
    if (active) return;
    if (!root) build();
    const current = q('.tab.active');
    startTab = current ? current.id.replace(/^tab-/, '') : 'list';
    active = true;
    root.hidden = false;
    document.addEventListener('keydown', onKey, true);
    window.addEventListener('resize', onResize);
    show(visibleSteps()[0]);
    root.querySelector('.tour-next').focus();
  }

  // First open: wait for the list to arrive (so the list steps have something to show; gives up after
  // 8s if offline), let the screen settle, then start - once per tour version.
  async function maybeStartTour() {
    if ((appSettings.tourSeen || 0) >= TOUR_VERSION) return;
    await waitFor(() => state.levels && state.levels.length, 8000);
    await sleep(700);
    if (!document.hidden && !active) startTour();
  }

  window.startTour = startTour;
  // start once the app has loaded its settings, whichever of app.js / this file finished first
  if (window.appBooted) maybeStartTour();
  else window.addEventListener('aredl:ready', maybeStartTour, { once: true });
  const replay = document.getElementById('tourReplayBtn');
  if (replay) replay.addEventListener('click', startTour);
})();
