// If anything throws during top-level script execution, show it instead of
// silently leaving a blank/non-functional app - this is exactly the failure
// mode a missing element or a typo'd id causes, and it's otherwise invisible.
window.addEventListener('error', (e) => {
  let banner = document.getElementById('fatalErrorBanner');
  if (!banner) {
    banner = document.createElement('div');
    banner.id = 'fatalErrorBanner';
    banner.style.cssText = 'position:fixed;bottom:0;left:0;right:0;z-index:9999;background:#7f1d1d;color:#fff;font:12px/1.5 monospace;padding:10px 14px;max-height:40vh;overflow:auto;white-space:pre-wrap;';
    document.body.appendChild(banner);
  }
  banner.textContent += `Script error: ${e.message} (${e.filename}:${e.lineno})\n`;
});

const $ = (sel) => document.querySelector(sel);
if (window.aredl.platform === 'win32') document.body.classList.add('custom-titlebar');
// F11 fullscreen: main.js tells us when it changes so the title bar can drop its drag area
window.aredl.onFullscreenChange((on) => {
  document.body.classList.toggle('fullscreen', on);
  if (typeof updateNavCompact === 'function') updateNavCompact();
});

// Pause every embedded YouTube player. Switching tabs or hiding the window
// are the only triggers - scrolling a player out of view is fine to ignore.
function pauseVideosIn(root) {
  root.querySelectorAll('iframe.yt-player').forEach(f => {
    try { f.contentWindow.postMessage(JSON.stringify({ event: 'command', func: 'pauseVideo', args: '' }), '*'); } catch { /* not loaded yet */ }
  });
}
function pauseAllVideos() { pauseVideosIn(document); }
document.addEventListener('visibilitychange', () => { if (document.hidden) pauseAllVideos(); });

const escapeHtml = (str) => str == null ? '' : String(str).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

// "Full API response" boxes. They used to pretty-print and escape the whole response every time a
// page loaded - megabytes of text nobody had asked to see. Now the text is only built when the box is opened.
const rawJsonStore = new Map();
let rawJsonSeq = 0;
function rawDetails(summaryHtml, data, attrs = '') {
  const id = String(++rawJsonSeq);
  rawJsonStore.set(id, data);
  if (rawJsonStore.size > 300) rawJsonStore.delete(rawJsonStore.keys().next().value); // boxes nobody opens don't pile up
  return `<details class="debug-info"${attrs} data-raw="${id}"><summary>${summaryHtml}</summary><div class="raw-json"></div></details>`;
}
document.addEventListener('toggle', (e) => {
  const d = e.target;
  if (!(d instanceof HTMLDetailsElement) || !d.open || !d.dataset.raw) return;
  const box = d.querySelector('.raw-json');
  if (!box || box.dataset.filled) return;
  const data = rawJsonStore.get(d.dataset.raw);
  box.textContent = data === undefined ? '(no longer available - reload this view)' : JSON.stringify(data, null, 2);
  box.dataset.filled = '1';
  rawJsonStore.delete(d.dataset.raw);
}, true);

// Electron wraps errors thrown in the main process as
// "Error invoking remote method 'x': Error: <message>" - strip that so the UI
// only ever shows the actual reason.
function errMsg(err) {
  let m = String((err && err.message) || err || '');
  m = m.replace(/^Error invoking remote method '[^']*':\s*/, '');
  while (/^\w*Error:\s*/.test(m)) m = m.replace(/^\w*Error:\s*/, '');
  return m || 'Unknown error';
}

// ---------------------------------------------------------------------------
// Toast + clipboard
// ---------------------------------------------------------------------------
let toastTimer = null;
function showToast(text) {
  let el = document.getElementById('toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'toast';
    document.body.appendChild(el);
  }
  el.textContent = text;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 1600);
}
async function copyText(text, label, { silent = false } = {}) {
  const value = String(text);
  try {
    await navigator.clipboard.writeText(value);
  } catch {
    const ta = document.createElement('textarea');
    ta.value = value;
    ta.style.cssText = 'position:fixed;opacity:0;';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); } catch { /* nothing more we can do */ }
    ta.remove();
  }
  if (!silent) showToast(`${label || 'Copied'} copied`);
}

// ---------------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------------
function showTab(name) {
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === name));
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.id === `tab-${name}`));
  if (name !== 'list') abortRecords(); // stop fetching records for a level you're no longer looking at
  else renderRecordsFooter();
  pauseAllVideos(); // whatever was playing on the tab we're leaving is no longer visible
  if (name === 'changelog' && !state.changelogLoaded) loadChangelog(true);
  if (name === 'notifications' && !state.notifLoaded) loadNotifications();
  if (name === 'submissions' && !state.submissionsLoaded) loadSubmissions();
  if (name === 'settings') loadApiLog();
  if (name === 'favourites') renderFavourites();
  if (name === 'followed') renderFollowed();
  if (name === 'personal') loadPersonal().then(renderPersonal);
  if (name === 'list' || name === 'submissions') requestAnimationFrame(redockIdleSlots);
  if (name === 'leaderboard' && !lbState.data) loadLeaderboard(1);
  if (name === 'profile' && !state.profileOpenedOnce) {
    state.profileOpenedOnce = true;
    if (state.signedIn) $('#myProfileBtn').click();
  }
  try { updateNavIndicators(true); } catch { /* top bar not set up yet */ }
  pushNavState();
}
document.querySelectorAll('.nav-btn').forEach(b => b.addEventListener('click', () => showTab(b.dataset.tab)));
window.aredl.onNavigate((tab) => showTab(tab));


// ---------------------------------------------------------------------------
// Mouse back/forward navigation. A history entry records WHERE you are:
//   - which tab
//   - Demon List:   which level is selected
//   - Profile:      which profile is being viewed ('__me__' or a player id)
//   - Submissions:  which submission is open
// Pushes are debounced so one action that touches several of these (e.g.
// jumpToLevel = switch tab + select level) is a single entry. main.js wires
// the mouse's side buttons to the same window.history.
//
// Rule that keeps this safe: pushNavState() must be called synchronously at
// the START of a navigation (never from an async completion), because
// popstate restores run with restoringNavState=true and only synchronous
// calls are suppressed - a late push would wipe out the forward history.
// ---------------------------------------------------------------------------
let restoringNavState = false;
let navPushTimer = null;

function currentNavSnapshot() {
  const tab = document.querySelector('.nav-btn.active')?.dataset.tab || 'list';
  return {
    tab,
    levelId: tab === 'list' ? (state.selectedId ?? null) : null,
    range: tab === 'list' && state.multi.size >= 2 ? [...state.multi] : null,
    profile: tab === 'profile' ? (state.currentProfileId ?? null) : null,
    submission: tab === 'submissions' ? (state.openSubmissionKey ?? null) : null,
  };
}
const rangeKey = (r) => (r || []).map(String).sort().join(',');
function sameNav(a, b) {
  if (!a || !b) return false;
  return a.tab === b.tab
    && rangeKey(a.range) === rangeKey(b.range)
    && (a.levelId ?? null) === (b.levelId ?? null)
    && (a.profile ?? null) === (b.profile ?? null)
    && (a.submission ?? null) === (b.submission ?? null);
}
// The app keeps its own history list rather than the browser's, so back/forward
// (mouse side buttons, Alt+Left/Right) behave the same however the OS delivers them.
const navStack = [{ tab: 'list', levelId: null, profile: null, submission: null }];
let navIndex = 0;

function recordNav() {
  const snap = currentNavSnapshot();
  if (sameNav(navStack[navIndex], snap)) return;
  navStack.splice(navIndex + 1); // anything "forward" of here is discarded
  navStack.push(snap);
  navIndex = navStack.length - 1;
  if (navStack.length > 200) { navStack.shift(); navIndex--; }
}
function pushNavState() {
  if (restoringNavState) return;
  clearTimeout(navPushTimer);
  navPushTimer = setTimeout(recordNav, 80);
}

function restoreProfileView(profileId) {
  if (!profileId) return;
  // Already showing exactly this profile? Nothing to reload.
  if (profileId === state.currentProfileId && document.querySelector('#profileContent .profile-page')) return;
  if (profileId === '__me__') {
    $('#myProfileBtn').click();
  } else {
    $('#profileLookup').value = profileId;
    lookupProfile(profileId);
  }
}
function restoreSubmissionView(key) {
  const idx = key == null ? -1 : submissionsSorted.findIndex(it => subKey(it) === key);
  if (idx === -1) { setOpenSubmission(null); return; }
  setOpenSubmission(idx);
  document.getElementById(`sub-${idx}`)?.scrollIntoView({ block: 'nearest' });
}

function restoreRange(nav) {
  const ids = nav.range.map(String).filter(id => state.levels.some(l => String(l.id) === id));
  if (ids.length < 2) return false;
  const view = state.levels.find(l => String(l.id) === String(nav.levelId)) || state.levels.find(l => String(l.id) === ids[0]);
  state.multi = new Set(ids);
  state.multiViewId = view.id;
  state.selectedId = view.id;
  renderMultiSelection();
  markRangeCards();
  return true;
}
function restoreNav(nav) {
  restoringNavState = true;
  try {
    showTab(nav.tab);
    if (nav.tab === 'list' && nav.range && nav.range.length >= 2 && restoreRange(nav)) {
      // level range restored (which level of it was on screen, too)
    } else if (nav.tab === 'list' && nav.levelId != null) {
      const level = state.levels.find(l => String(l.id) === String(nav.levelId));
      if (level) {
        selectLevel(level);
        document.querySelector(`.list-row[data-id="${CSS.escape(String(level.id))}"]`)?.scrollIntoView({ block: 'nearest' });
      }
    } else if (nav.tab === 'profile') {
      restoreProfileView(nav.profile ?? null);
    } else if (nav.tab === 'submissions') {
      restoreSubmissionView(nav.submission ?? null);
    }
  } finally {
    restoringNavState = false;
  }
}
function navBack() {
  clearTimeout(navPushTimer);
  if (!restoringNavState) recordNav(); // make sure "where I am now" is on the list before leaving it
  if (navIndex > 0) { navIndex--; restoreNav(navStack[navIndex]); }
}
function navForward() {
  clearTimeout(navPushTimer);
  if (!restoringNavState) recordNav();
  if (navIndex < navStack.length - 1) { navIndex++; restoreNav(navStack[navIndex]); }
}
let lastNavCmd = 0;
function navCommand(dir) {
  const now = Date.now();
  if (now - lastNavCmd < 350) return; // the OS command and the raw mouse click can both arrive
  lastNavCmd = now;
  if (dir === 'back') navBack(); else navForward();
}
window.aredl.onNavCmd(navCommand);
window.addEventListener('mouseup', (e) => {
  if (e.button === 3 || e.button === 4) { e.preventDefault(); navCommand(e.button === 3 ? 'back' : 'forward'); }
});
window.addEventListener('auxclick', (e) => { if (e.button === 3 || e.button === 4) e.preventDefault(); });
window.addEventListener('keydown', (e) => {
  if (e.altKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight') && !/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || '')) {
    e.preventDefault();
    navCommand(e.key === 'ArrowLeft' ? 'back' : 'forward');
  }
});


// <details> snaps open/closed with no transition of its own - animate the
// height ourselves so it eases like the other dropdowns.
document.addEventListener('click', (e) => {
  const summary = e.target.closest('details > summary');
  if (!summary) return;
  e.preventDefault();
  const details = summary.parentElement;
  if (details._animating) return;
  const closing = details.open;
  const from = details.offsetHeight;
  let to;
  if (closing) {
    to = 0; // stays open (it already is) while it animates down to 0, then we close it
  } else {
    details.open = true;
    to = details.offsetHeight;
  }
  details._animating = true;
  details.style.overflow = 'hidden';
  const anim = details.animate([{ height: from + 'px' }, { height: to + 'px' }], { duration: 200, easing: 'ease' });
  anim.onfinish = () => { if (closing) details.open = false; details.style.overflow = ''; details._animating = false; };
});

// Jump from a level name mentioned in the changelog/history straight to that
// row in the Demon List tab, instead of opening a browser.
function jumpToLevel(levelId) {
  showTab('list');
  $('#statusFilter').value = '__all__';
  $('#search').value = '';
  updateSearchClearBtn();
  const level = state.levels.find(l => String(l.level_id) === String(levelId));
  if (level) selectLevel(level); // sets state.selectedId before the render below
  applyFilters(); // rebuilds the list (now correctly marking it selected) and scrolls it into view
}
document.addEventListener('click', (e) => {
  if (e.target.closest('[data-fav-remove], .icon-tool:not([data-jump]), .copyable, [data-follow-opt], .fav-label')) return;
  const link = e.target.closest('[data-jump]');
  if (link) {
    e.preventDefault();
    // ctrl/cmd+click anywhere outside the list builds the level range instead of jumping
    if (e.ctrlKey || e.metaKey) addToLevelRange(link.dataset.jump);
    else jumpToLevel(link.dataset.jump);
  }
});

function addToLevelRange(levelId) {
  const level = state.levels.find(l => String(l.level_id) === String(levelId));
  if (!level) { showToast('The level list isn\'t loaded yet'); return; }
  toggleMultiSelect(level);
  markRangeCards();
  const n = state.multi.size;
  showToast(n >= 2 ? `Level range: ${n} levels (see it in the Demon List)` : 'Selected - ctrl+click another level to start a level range');
}

// Cards outside the list (favourites / followed) get an outline while in the current level range.
function markRangeCards() {
  document.querySelectorAll('.fav-card[data-level-id], .follow-card[data-level-id]').forEach(card => {
    const l = state.levels.find(x => String(x.level_id) === card.dataset.levelId);
    card.classList.toggle('in-range', !!l && state.multi.size >= 2 && state.multi.has(String(l.id)));
  });
}

// Decimal places in "3.25 days ago" - Settings > App preferences > Dates (0-2).
const dateDp = () => (Number.isInteger(appSettings.dateDp) && appSettings.dateDp >= 0 && appSettings.dateDp <= 2) ? appSettings.dateDp : 2;
function formatRelativeTime(date) {
  const dp = Math.min(2, Math.max(0, Number.isFinite(appSettings.dateDp) ? appSettings.dateDp : 2));
  const diffSec = (Date.now() - date.getTime()) / 1000;
  if (diffSec < 60) return 'just now';
  const units = [['year', 31536000], ['month', 2592000], ['week', 604800], ['day', 86400], ['hour', 3600], ['minute', 60]];
  for (const [name, secs] of units) {
    const raw = diffSec / secs;
    if (raw < 1) continue;
    const txt = (dp === 0 ? Math.floor(raw) : raw).toFixed(dp);
    return `${txt} ${name}${Number(txt) === 1 ? '' : 's'} ago`;
  }
  return 'just now';
}

// ---------------------------------------------------------------------------
// "Show raw API responses" preference - hides every .debug-info element
// (raw JSON <details> blocks, the level-count/completion-field line) when off.
// ---------------------------------------------------------------------------
// Preferences are kept in the app's data folder (settings.json, via main.js),
// not localStorage - the renderer's origin has a random port, so localStorage
// would be wiped on every launch.
let appSettings = {};
async function setSetting(key, value) {
  appSettings[key] = value;
  try { await window.aredl.setSettings({ [key]: value }); } catch { /* keep the in-memory value for this session */ }
}

function applyRawVisibility() {
  const show = !!appSettings.showRaw;
  document.body.classList.toggle('hide-debug-info', !show);
  $('#showRawToggle').checked = show;
}
$('#showRawToggle').addEventListener('change', () => {
  setSetting('showRaw', $('#showRawToggle').checked);
  applyRawVisibility();
});
applyRawVisibility();

// ---------------------------------------------------------------------------
// Themes (Settings > Visual). Each theme is a full set of the colour variables
// styles.css is built on. To add one, append an entry here.
// ---------------------------------------------------------------------------
const THEMES = [
  { id: 'default',  name: 'Default',  bg: '#0a0a0c', bg2: '#111114', panel: '#16161a', border: '#26262c', text: '#f2f2f4', dim: '#8b8b93', faint: '#57575f', accent: '#ff6f00', on: '#1a0d00' },
  { id: 'amoled',   name: 'AMOLED',   bg: '#000000', bg2: '#050505', panel: '#0d0d0d', border: '#1d1d1d', text: '#f2f2f4', dim: '#8b8b93', faint: '#57575f', accent: '#ff6f00', on: '#1a0d00' },
  { id: 'midnight', name: 'Midnight', bg: '#070a12', bg2: '#0c111c', panel: '#111827', border: '#1f2a3d', text: '#eef2ff', dim: '#8a97b3', faint: '#55617a', accent: '#3b82f6', on: '#04122e' },
  { id: 'ocean',    name: 'Ocean',    bg: '#07100f', bg2: '#0c1716', panel: '#112120', border: '#1d3634', text: '#e9f7f5', dim: '#82a39f', faint: '#53706d', accent: '#14b8a6', on: '#021a17' },
  { id: 'forest',   name: 'Forest',   bg: '#08100c', bg2: '#0d1712', panel: '#121e18', border: '#203429', text: '#ecf6ef', dim: '#86a393', faint: '#55705f', accent: '#22c55e', on: '#04180b' },
  { id: 'violet',   name: 'Violet',   bg: '#0b0912', bg2: '#110e1b', panel: '#171324', border: '#2a2340', text: '#f1eefc', dim: '#9a92b8', faint: '#645c80', accent: '#a855f7', on: '#14041f' },
  { id: 'glass',    name: 'Glass',    bg: '#090b13', bg2: '#10131d', panel: '#171b28', border: 'rgba(255,255,255,.22)', text: '#f7f8ff', dim: '#b9c2da', faint: '#8d98b4', accent: '#7dd3fc', on: '#04121c', glass: true },
  { id: 'adaptive', name: 'Adaptive Glass', bg: '#090b13', bg2: '#10131d', panel: '#171b28', border: 'rgba(255,255,255,.22)', text: '#f7f8ff', dim: '#b9c2da', faint: '#8d98b4', accent: '#7dd3fc', on: '#0b0e16', glass: true, adaptive: true },
  { id: 'crimson',  name: 'Crimson',  bg: '#0e0809', bg2: '#150c0e', panel: '#1b1012', border: '#33191d', text: '#f6eced', dim: '#a58b8f', faint: '#70565a', accent: '#ef4444', on: '#1f0505' },
];

function hexToRgba(hex, alpha) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${n >> 16}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

function renderThemePicker(activeId) {
  $('#themePicker').innerHTML = THEMES.map(t => `
    <button class="theme-card ${t.id === activeId ? 'active' : ''}" data-theme-id="${t.id}">
      <span class="theme-preview" style="background:${t.bg};border-color:${t.border}">
        <i class="tp-side" style="background:${t.bg2};border-color:${t.border}"></i>
        <i class="tp-card" style="background:${t.panel};border-color:${t.border}"></i>
        <i class="tp-line" style="background:${t.text}"></i>
        <i class="tp-accent" style="background:${t.accent}"></i>
      </span>
      <span class="theme-name"><i class="theme-dot" style="background:${t.accent}"></i>${escapeHtml(t.name)}</span>
    </button>`).join('');
}

function applyTheme(id) {
  const t = THEMES.find(x => x.id === id) || THEMES[0];
  const root = document.documentElement.style;
  root.setProperty('--bg', t.bg);
  root.setProperty('--bg2', t.bg2);
  root.setProperty('--panel', t.panel);
  root.setProperty('--border', t.border);
  root.setProperty('--text', t.text);
  root.setProperty('--text-dim', t.dim);
  root.setProperty('--text-faint', t.faint);
  root.setProperty('--accent', t.accent);
  root.setProperty('--on-accent', t.on);
  root.setProperty('--accent-soft', hexToRgba(t.accent, 0.14));
  root.setProperty('--accent-soft2', hexToRgba(t.accent, 0.28));
  document.body.classList.toggle('glassy', !!t.glass);
  state.adaptive = !!t.adaptive;
  document.body.classList.toggle('adaptive', state.adaptive);
  applyGlassTint();
  updateAdaptiveControls();
  applyBgBlur();
  applyAppearance();
  if (state.adaptive) adaptAccent(currentBgVid);
  renderThemePicker(t.id);
  // keep the native window buttons in step with the title bar colour
  try { window.aredl.setTitleBarOverlay({ color: '#00000000', symbolColor: t.dim }); } catch { /* not on Windows */ }
}

$('#themePicker').addEventListener('click', (e) => {
  const card = e.target.closest('[data-theme-id]');
  if (!card) return;
  setSetting('theme', card.dataset.themeId);
  applyTheme(card.dataset.themeId);
});

// ---------------------------------------------------------------------------
// Navigation placement (Settings > Display). The very same tab buttons are
// moved between the side bar and the title bar, so everything they do keeps working.
// ---------------------------------------------------------------------------
const NAV_BTNS = [...document.querySelectorAll('.nav-btn')];
// wrap each tab's text in a span so it can collapse to just the icon
NAV_BTNS.forEach(b => {
  [...b.childNodes].forEach(n => {
    if (n.nodeType === 3 && n.textContent.trim()) {
      const span = document.createElement('span');
      span.className = 'nav-label';
      span.textContent = n.textContent.trim();
      n.replaceWith(span);
    } else if (n.nodeType === 3) {
      n.remove();
    }
  });
});
function navLabel(btn) {
  const l = btn.querySelector('.nav-label');
  return l ? l.textContent.trim() : '';
}
const navBtnOf = (tab) => NAV_BTNS.find(b => b.dataset.tab === tab);

// Which tabs sit on the left / right of the top bar. Unknown or new tabs go to the left.
function currentNavLayout() {
  const tabs = NAV_BTNS.map(b => b.dataset.tab);
  const saved = appSettings.navLayout;
  let left = [], right = [], menu = [];
  if (saved && Array.isArray(saved.left) && Array.isArray(saved.right)) {
    left = saved.left.filter(t => tabs.includes(t));
    right = saved.right.filter(t => tabs.includes(t));
    menu = (Array.isArray(saved.menu) ? saved.menu : []).filter(t => tabs.includes(t));
  } else {
    right = ['settings'];
  }
  right = right.filter(t => !menu.includes(t));
  left = left.filter(t => !right.includes(t) && !menu.includes(t));
  tabs.forEach(t => { if (!left.includes(t) && !right.includes(t) && !menu.includes(t)) left.push(t); });
  return { left, right, menu };
}
function saveNavLayout() {
  const names = (zone) => [...zone.querySelectorAll('.nav-btn')].map(b => b.dataset.tab);
  // with the menu button switched off its tabs sit in the bar, so keep remembering which ones were in the menu
  const menu = appSettings.navMenu ? names($('#topNavMenu')) : ((appSettings.navLayout && appSettings.navLayout.menu) || []);
  setSetting('navLayout', { left: names($('#topNavLeft')), right: names($('#topNavRight')), menu });
}

function applyNavPlacement() {
  const top = !!appSettings.navTop && document.body.classList.contains('custom-titlebar');
  document.body.classList.toggle('nav-top', top);
  $('#navTopOptions').hidden = !top;
  if (!top) setNavEditing(false);
  const sidebar = document.querySelector('.sidebar');
  const spacer = sidebar.querySelector('.sidebar-spacer');
  const status = $('#signinStatus');
  if (top) {
    const { left, right, menu } = currentNavLayout();
    const menuOn = !!appSettings.navMenu;
    const place = (t, zone) => { const b = navBtnOf(t); b.title = navLabel(b); zone.appendChild(b); };
    (menuOn ? left : left.concat(menu)).forEach(t => place(t, $('#topNavLeft')));
    right.forEach(t => place(t, $('#topNavRight')));
    if (menuOn) menu.forEach(t => place(t, $('#topNavMenu')));
    $('#topStatus').appendChild(status);
  } else {
    NAV_BTNS.forEach(b => {
      b.removeAttribute('title');
      if (b.dataset.tab !== 'settings') sidebar.insertBefore(b, spacer);
    });
    sidebar.appendChild(navBtnOf('settings'));
    sidebar.appendChild(status);
  }
  updateNavCompact();
  syncNavMore();
}
$('#navTopToggle').addEventListener('change', () => {
  setSetting('navTop', $('#navTopToggle').checked);
  applyNavPlacement();
});
// ---- version + manual update check (Settings > About) ----
window.aredl.getAppVersion().then(v => { $('#appVersion').textContent = v; }).catch(() => {});
$('#updateCheckBtn').addEventListener('click', async () => {
  const btn = $('#updateCheckBtn'), out = $('#updateStatus');
  btn.disabled = true; out.textContent = 'Checking…';
  try {
    const r = await window.aredl.checkForUpdates();
    out.textContent = {
      available: `Version ${r.version} found - downloading it now. You'll be asked to restart when it's ready.`,
      'up-to-date': "You're on the latest version.",
      portable: "The portable version can't update itself. Install the Setup version to get automatic updates.",
      dev: "Updates only work in the installed app, not when running from source.",
      error: `Couldn't check for updates (${r.message || 'unknown error'}).`,
    }[r.status] || 'Done.';
  } catch { out.textContent = "Couldn't check for updates."; }
  btn.disabled = false;
});
$('#navMenuToggle').addEventListener('change', () => {
  setSetting('navMenu', $('#navMenuToggle').checked);
  applyNavPlacement();
});

// ---- Top bar: the menu button (tabs tucked into a dropdown) ----
const navMoreEl = $('#navMore');
const navMoreBtn = $('#navMoreBtn');
const navMoreOutside = (e) => { if (!navMoreEl.contains(e.target)) closeNavMore(); };
function setNavMore(open) {
  navMoreEl.classList.toggle('open', open);
  navMoreBtn.setAttribute('aria-expanded', String(open));
  document[open ? 'addEventListener' : 'removeEventListener']('mousedown', navMoreOutside, true);
  if (open) { // open towards the left if it would run off the right edge of the window
    const panel = $('#topNavMenu');
    panel.classList.remove('flip');
    if (panel.getBoundingClientRect().right > window.innerWidth - 8) panel.classList.add('flip');
  }
}
function closeNavMore() { if (navMoreEl.classList.contains('open')) setNavMore(false); }
function syncNavMore() {
  const on = !!appSettings.navMenu && document.body.classList.contains('nav-top');
  navMoreEl.hidden = !on;
  if (!on) closeNavMore();
  updateNavIndicators(false);
}
navMoreBtn.addEventListener('click', () => {
  if (document.body.classList.contains('nav-editing')) return;
  setNavMore(!navMoreEl.classList.contains('open'));
});
$('#topNavMenu').addEventListener('click', (e) => {
  if (e.target.closest('.nav-btn') && !document.body.classList.contains('nav-editing')) closeNavMore();
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeNavMore(); });

// ---- Top bar: highlight pills that glide to the selected / hovered tab ----
const topNavEl = $('#topNav');
const navInd = { active: $('#navActiveInd'), hover: $('#navHoverInd') };
let navHoverEl = null;
let navSwitchedAt = 0;
// position inside the bar from layout offsets, so a tab that is mid-"press" (scaled down) doesn't skew it
function navOffsetIn(el, root) {
  let x = 0, y = 0, n = el;
  while (n && n !== root) { x += n.offsetLeft; y += n.offsetTop; n = n.offsetParent; }
  return { x, y, w: el.offsetWidth, h: el.offsetHeight };
}
function navIndPlace(ind, el, animate) {
  if (!el || !el.offsetWidth) { ind.classList.remove('on'); return; }
  const r = navOffsetIn(el, topNavEl);
  const snap = !animate || !ind.classList.contains('on'); // first appearance (or a layout change) jumps, a tab change glides
  if (snap) ind.style.transition = 'none';
  ind.style.transform = `translate(${r.x}px,${r.y}px)`;
  ind.style.width = r.w + 'px';
  ind.style.height = r.h + 'px';
  if (snap) { void ind.offsetWidth; ind.style.transition = ''; }
  ind.classList.add('on');
}
function updateNavIndicators(animate) {
  const body = document.body;
  const live = body.classList.contains('nav-top') && !body.classList.contains('nav-editing');
  let target = null;
  if (live) {
    const b = document.querySelector('.nav-btn.active');
    target = b ? (b.closest('#topNavMenu') ? navMoreBtn : b) : null; // a tab inside the menu lights up the menu button
  }
  navMoreBtn.classList.toggle('has-active', !!target && target === navMoreBtn);
  if (animate) navSwitchedAt = Date.now();
  navIndPlace(navInd.active, target, animate);
  if (live && navHoverEl && navHoverEl.isConnected) navIndPlace(navInd.hover, navHoverEl, animate);
  else navInd.hover.classList.remove('on');
}
topNavEl.addEventListener('mouseover', (e) => {
  if (document.body.classList.contains('nav-editing')) return;
  if (e.target.closest('#topNavMenu')) { navHoverEl = null; navInd.hover.classList.remove('on'); return; }
  const el = e.target.closest('.nav-btn, .nav-more-btn');
  if (!el) return;
  navHoverEl = el;
  navIndPlace(navInd.hover, el, true);
});
topNavEl.addEventListener('mouseleave', () => { navHoverEl = null; navInd.hover.classList.remove('on'); });
// tabs change size / shift while names expand and collapse: follow them every frame, without sliding
const navResizeObserver = new ResizeObserver(() => updateNavIndicators(Date.now() - navSwitchedAt < 450));
[topNavEl, $('#topNavLeft'), $('#topNavRight'), navMoreEl, ...NAV_BTNS].forEach(el => navResizeObserver.observe(el));

// "Icons only" mode: tabs show just their icon and expand when hovered.
// Setting: off | always | fullscreen (icons only while in fullscreen).
function updateNavCompact() {
  const mode = appSettings.navCompact || 'off';
  const on = mode === 'always' || (mode === 'fullscreen' && document.body.classList.contains('fullscreen'));
  document.body.classList.toggle('nav-compact', on);
}
$('#navCompactSelect').addEventListener('change', () => {
  setSetting('navCompact', $('#navCompactSelect').value);
  updateNavCompact();
});

// ---- Reordering the top bar (drag a tab; drop it on the left or right side) ----
let draggingNav = null;
function setNavEditing(on) {
  document.body.classList.toggle('nav-editing', on);
  NAV_BTNS.forEach(b => { b.draggable = on; });
  if (on) closeNavMore();
  $('#navEditHint').textContent = appSettings.navMenu
    ? 'Drag tabs to rearrange - drop them on the left, the right, or into the menu button'
    : 'Drag tabs to rearrange - drop them on the left or right side';
  syncNavMore();
}
$('#navReorderBtn').addEventListener('click', () => setNavEditing(true));
$('#navEditDone').addEventListener('click', () => { setNavEditing(false); showToast('Top bar saved'); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && document.body.classList.contains('nav-editing')) setNavEditing(false); });
// while editing, clicking a tab must not navigate
document.addEventListener('click', (e) => {
  if (document.body.classList.contains('nav-editing') && e.target.closest('.top-nav .nav-btn')) {
    e.stopPropagation();
    e.preventDefault();
  }
}, true);
document.addEventListener('dragstart', (e) => {
  const b = e.target.closest && e.target.closest('.top-nav .nav-btn');
  if (!b || !document.body.classList.contains('nav-editing')) return;
  draggingNav = b;
  b.classList.add('dragging');
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/plain', b.dataset.tab);
});
document.addEventListener('dragover', (e) => {
  const zone = e.target.closest && e.target.closest('.top-zone');
  if (!draggingNav || !zone) return;
  e.preventDefault();
  document.querySelectorAll('.top-zone').forEach(z => z.classList.toggle('drag-over', z === zone));
  const vertical = zone.dataset.axis === 'y'; // the menu is a vertical list
  const after = [...zone.querySelectorAll('.nav-btn:not(.dragging)')].find(b => {
    const r = b.getBoundingClientRect();
    return vertical ? e.clientY < r.top + r.height / 2 : e.clientX < r.left + r.width / 2;
  });
  if (after) zone.insertBefore(draggingNav, after); else zone.appendChild(draggingNav);
});
document.addEventListener('drop', (e) => { if (draggingNav) e.preventDefault(); });
document.addEventListener('dragend', () => {
  if (!draggingNav) return;
  draggingNav.classList.remove('dragging');
  draggingNav = null;
  document.querySelectorAll('.top-zone').forEach(z => z.classList.remove('drag-over'));
  saveNavLayout();
  updateNavIndicators(false);
});

$('#videoLeaveSelect').addEventListener('change', () => setSetting('videoOnLeave', $('#videoLeaveSelect').value));
$('#favSortBy').addEventListener('change', () => { setSetting('favSort', $('#favSortBy').value); renderFavourites(); });

$('#dateDpSlider').addEventListener('input', () => {
  const v = Number($('#dateDpSlider').value);
  $('#dateDpOut').textContent = `${v} dp`;
  setSetting('dateDp', v);
  // refresh anything already showing "x ago"
  try { if (changelogEntries.length) renderChangelog(); } catch { /* not loaded yet */ }
  try { renderFollowed(); } catch { /* not loaded yet */ }
  try { if (clearedNotifIds) renderNotifications(); } catch { /* not loaded yet */ }
  try { if (state.submissionsLoaded) renderSubmissions(); } catch { /* not loaded yet */ }
  try { if (document.querySelector('#historyTable, .history-table')) renderHistoryTable(); } catch { /* no history open */ }
});

// ---------------------------------------------------------------------------
// Customisation settings
// ---------------------------------------------------------------------------
const themeNow = () => THEMES.find(x => x.id === (appSettings.theme || 'default')) || THEMES[0];
const validHex = (v) => typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v);

function applyAccentOverride() {
  const picker = document.getElementById('accentCustom');
  const t = themeNow();
  if (!state.adaptive && validHex(appSettings.accentCustom)) setAccentColour(appSettings.accentCustom, appSettings.accentCustom);
  if (picker) {
    picker.value = (!state.adaptive && validHex(appSettings.accentCustom)) ? appSettings.accentCustom : t.accent;
    picker.disabled = !!state.adaptive;
    $('#accentReset').disabled = !!state.adaptive || !validHex(appSettings.accentCustom);
  }
}
$('#accentCustom').addEventListener('input', () => { appSettings.accentCustom = $('#accentCustom').value; applyAccentOverride(); });
$('#accentCustom').addEventListener('change', () => setSetting('accentCustom', $('#accentCustom').value));
$('#accentReset').addEventListener('click', () => { setSetting('accentCustom', null); applyTheme(appSettings.theme || 'default'); });

function applyRadius() {
  const v = Number.isFinite(appSettings.radius) ? appSettings.radius : 14;
  document.body.style.setProperty('--radius', v + 'px');
  $('#radiusSlider').value = v;
  $('#radiusOut').textContent = v + 'px';
}
$('#radiusSlider').addEventListener('input', () => { setSetting('radius', Number($('#radiusSlider').value)); applyRadius(); });

function applyDensity() {
  document.body.classList.toggle('compact', appSettings.density === 'compact');
  $('#densitySelect').value = appSettings.density === 'compact' ? 'compact' : 'comfortable';
}
$('#densitySelect').addEventListener('change', () => { setSetting('density', $('#densitySelect').value); applyDensity(); });

function applyMotion() {
  document.body.classList.toggle('no-motion', !!appSettings.reduceMotion);
  $('#reduceMotion').checked = !!appSettings.reduceMotion;
}
$('#reduceMotion').addEventListener('change', () => { setSetting('reduceMotion', $('#reduceMotion').checked); applyMotion(); });

// backdrop brightness (unset = the theme's own default) + show / drift toggles
const bgBrightDefault = () => document.body.classList.contains('glassy') ? 50 : 32;
function applyBgBright() {
  const custom = Number.isFinite(appSettings.bgBright) ? appSettings.bgBright : null;
  if (custom == null) document.body.style.removeProperty('--bg-bright');
  else document.body.style.setProperty('--bg-bright', String(custom / 100));
  const slider = document.getElementById('bgBrightSlider');
  const eff = custom == null ? bgBrightDefault() : custom;
  slider.dataset.default = String(bgBrightDefault());
  slider.value = eff;
  $('#bgBrightOut').textContent = custom == null || custom === bgBrightDefault() ? `${eff}% · default` : `${eff}%`;
  $('#bgBrightReset').disabled = custom == null;
}
$('#bgBrightSlider').addEventListener('input', () => {
  const v = Number($('#bgBrightSlider').value);
  setSetting('bgBright', v === bgBrightDefault() ? null : v);
  applyBgBright();
});
$('#bgBrightReset').addEventListener('click', () => { setSetting('bgBright', null); applyBgBright(); });
function applyBgToggles() {
  const show = appSettings.bgShow !== false, drift = appSettings.bgDrift !== false;
  document.body.classList.toggle('no-bg', !show);
  document.body.classList.toggle('no-drift', !drift);
  $('#bgShow').checked = show;
  $('#bgDrift').checked = drift;
  $('#bgDrift').disabled = !show;
}
$('#bgShow').addEventListener('change', () => { setSetting('bgShow', $('#bgShow').checked); applyBgToggles(); });
$('#bgDrift').addEventListener('change', () => { setSetting('bgDrift', $('#bgDrift').checked); applyBgToggles(); });

$('#startTabSelect').addEventListener('change', () => setSetting('startTab', $('#startTabSelect').value));
$('#followMinsSelect').addEventListener('change', () => { setSetting('followMins', Number($('#followMinsSelect').value)); restartFollowTimer(); renderFollowed(); });

function applyAppearance() {
  applyAccentOverride();
  applyRadius();
  applyDensity();
  applyMotion();
  applyBgBright();
  applyBgToggles();
}

async function initSettings() {
  try { appSettings = (await window.aredl.getSettings()) || {}; } catch { appSettings = {}; }
  applyRawVisibility();
  $('#adaptiveTint').value = Number.isFinite(appSettings.adaptiveTint) ? appSettings.adaptiveTint : 30;
  $('#adaptiveMethod').value = appSettings.adaptiveMethod === 'vivid' ? 'vivid' : 'gamma';
  $('#videoLeaveSelect').value = appSettings.videoOnLeave || 'popup';
  $('#startTabSelect').value = appSettings.startTab || 'list';
  $('#plSort').value = appSettings.plSort || 'hardest';
  $('#plProgressSort').value = appSettings.plProgressSort || 'run';
  $('#followMinsSelect').value = String(Number.isFinite(appSettings.followMins) ? appSettings.followMins : 2);
  const dpNow = Number.isFinite(appSettings.dateDp) ? appSettings.dateDp : 2;
  $('#dateDpSlider').value = dpNow;
  $('#dateDpOut').textContent = `${dpNow} dp`;
  $('#favSortBy').value = appSettings.favSort || 'category';
  $('#navNoTitlebar').hidden = document.body.classList.contains('custom-titlebar');
  applyTheme(appSettings.theme || 'default');
  if (document.body.classList.contains('custom-titlebar')) {
    $('#navTopWrap').hidden = false;
    $('#navTopToggle').checked = !!appSettings.navTop;
    $('#navMenuToggle').checked = !!appSettings.navMenu;
    $('#navCompactSelect').value = appSettings.navCompact || 'off';
  }
  if (appSettings.miniPlayer) {
    const mp = appSettings.miniPlayer;
    if (Number(mp.width) >= 220) miniPrefs.width = Number(mp.width);
    if (Number.isFinite(mp.x) && Number.isFinite(mp.y)) miniPrefs.pos = { x: mp.x, y: mp.y };
  }
  applyNavPlacement();
  document.documentElement.classList.remove('booting');
}

function wireRefreshButton(id, fn) {
  const btn = document.getElementById(id);
  if (!btn) return;
  btn.addEventListener('click', async () => {
    btn.classList.add('spinning');
    try { await fn(); } finally { setTimeout(() => btn.classList.remove('spinning'), 500); }
  });
}
const state = {
  levels: [], filtered: [], openId: null,
  signedIn: false, completedIds: new Set(), completionField: null,
  changelogLoaded: false, notifLoaded: false, submissionsLoaded: false,
};

// ---------------------------------------------------------------------------
// Auth / sign-in
//
// There's no confirmed "who am I" endpoint, so sign-in only verifies the key
// (against /users/@me/notifications, which is confirmed to require auth) and
// stores it. Per-user data comes from two places instead:
//   - completed levels: the /aredl/levels/ endpoint itself returns extra
//     fields when called with auth - see extractCompletedFromLevels() below.
//   - "my profile": a best-effort guess (getMyProfile in main.js), with a
//     manual fallback if the guess doesn't resolve.
// ---------------------------------------------------------------------------
async function refreshAuthStatus() {
  const status = await window.aredl.authStatus();
  state.signedIn = status.signedIn;
  $('#signinStatus').textContent = state.signedIn ? 'Signed in' : 'Not signed in';
  $('#signInBtn').hidden = state.signedIn;
  $('#signOutBtn').hidden = !state.signedIn;
  $('#apiKeyInput').hidden = state.signedIn;
  $('#completedFilterWrap').hidden = !state.signedIn;
}

const KNOWN_LEVEL_FIELDS = new Set([
  'id', 'name', 'position', 'publisher_id', 'points', 'status', 'requires_raw_footage',
  'level_id', 'two_player', 'tags', 'description', 'song', 'edel_enjoyment',
  'is_edel_pending', 'gddl_tier', 'nlw_tier',
]);

// Auth-fetched /aredl/levels/ responses include extra per-user fields not
// present in the public response. We don't know the exact field name, so we
// detect it: look at fields beyond the known public schema, and treat either
// an all-boolean field, or a field that's sometimes null/sometimes not, as
// the completion indicator.
function extractCompletedFromLevels(levels) {
  state.completedIds = new Set();
  state.completionField = null;
  if (!state.signedIn || !levels.length) return;

  const sample = levels.slice(0, 30);
  const extraKeys = new Set();
  sample.forEach(l => Object.keys(l).forEach(k => { if (!KNOWN_LEVEL_FIELDS.has(k)) extraKeys.add(k); }));
  if (!extraKeys.size) return;

  for (const key of extraKeys) {
    const values = sample.map(l => l[key]);
    if (values.every(v => typeof v === 'boolean')) {
      state.completionField = key;
      levels.forEach(l => { if (l[key]) state.completedIds.add(String(l.level_id)); });
      return;
    }
  }
  for (const key of extraKeys) {
    const values = sample.map(l => l[key]);
    const hasNull = values.some(v => v === null || v === undefined);
    const hasNonNull = values.some(v => v !== null && v !== undefined);
    if (hasNull && hasNonNull) {
      state.completionField = key;
      levels.forEach(l => { if (l[key] != null) state.completedIds.add(String(l.level_id)); });
      return;
    }
  }
}

$('#signInBtn').addEventListener('click', async () => {
  const key = $('#apiKeyInput').value;
  const msg = $('#signinMsg');
  msg.textContent = 'Verifying…';
  msg.className = 'msg';
  try {
    await window.aredl.signIn(key);
    msg.textContent = 'Signed in successfully.';
    msg.className = 'msg ok';
    $('#apiKeyInput').value = '';
    await refreshAuthStatus();
    await loadLevels(); // refetch with auth so completion fields come through
  } catch (err) {
    msg.textContent = errMsg(err) || 'Sign in failed.';
    msg.className = 'msg err';
  }
});

$('#signOutBtn').addEventListener('click', async () => {
  await window.aredl.signOut();
  await refreshAuthStatus();
  await loadLevels();
});

// ---------------------------------------------------------------------------
// API request log
// ---------------------------------------------------------------------------
let apiLog = [];

// keep the requests/min figure moving while Settings is open
setInterval(() => {
  const tab = document.getElementById('tab-settings');
  if (tab && tab.classList.contains('active')) renderApiLog();
}, 5000);

// Plain-English reason for a request, worked out from its URL (using the already-loaded list for names).
function describeRequest(url) {
  let u;
  try { u = new URL(url); } catch { return null; }
  const p = u.pathname.replace(/^\/v2\/api/, '').replace(/\/+$/, '');
  const q = u.searchParams;
  const nameOf = (id) => { const l = state.levels.find(x => String(x.level_id) === String(id)); return l ? l.name : `level ${id}`; };
  const page = q.get('page') ? ` (page ${q.get('page')})` : '';
  let m;
  if (/^\/aredl\/levels$/.test(p)) return 'Loaded the level list';
  if ((m = p.match(/^\/aredl\/levels\/([^/]+)\/records$/))) return `Loaded ${nameOf(m[1])} records${page}`;
  if ((m = p.match(/^\/aredl\/levels\/([^/]+)\/history$/))) return `Loaded ${nameOf(m[1])} position history`;
  if ((m = p.match(/^\/aredl\/levels\/([^/]+)$/))) return `Loaded ${nameOf(m[1])}`;
  if (/^\/aredl\/changelog$/.test(p)) return `Loaded the changelog${page}`;
  if (/^\/aredl\/submissions\/@me$/.test(p)) return 'Loaded your submissions';
  if (/^\/aredl\/submissions\/[^/]+\/queue$/.test(p)) return 'Loaded a submission’s queue position';
  if (/^\/aredl\/profile\//.test(p)) return 'Loaded a profile';
  if (/notifications/.test(p)) return 'Loaded your notifications';
  if (/@me/.test(p)) return 'Checked your account';
  return `Loaded ${p || '/'}`;
}

function renderApiLog() {
  const now = Date.now();
  const ts = (e) => new Date(e.timestamp).getTime();
  const lastMin = apiLog.filter(e => now - ts(e) <= 60000).length;
  const last5 = apiLog.filter(e => now - ts(e) <= 300000).length;
  const limited = apiLog.filter(e => e.status === 429).length;
  const rate = document.getElementById('apiRate');
  if (rate) rate.innerHTML = `<span class="rate-pill strong">${lastMin} requests/min</span>
    <span class="rate-pill">${(last5 / 5).toFixed(1)}/min avg (5 min)</span>
    <span class="rate-pill">${apiLog.length} this session</span>
    ${limited ? `<span class="rate-pill warn">${limited} rate-limited (429)</span>` : ''}`;
  const list = apiLog.slice().reverse();
  $('#apiLogList').innerHTML = list.length
    ? list.map(e => `<div class="api-log-row ${e.ok ? '' : 'err'}">
        <span class="api-log-time">${escapeHtml(new Date(e.timestamp).toLocaleTimeString())}</span>
        <span class="api-log-status">${escapeHtml(e.status ?? 'ERR')}</span>
        <span class="api-log-body">
          <span class="api-log-reason">${escapeHtml(describeRequest(e.url) || 'Request')}</span>
          <span class="api-log-url">${escapeHtml(e.url)}</span>
        </span>
      </div>`).join('')
    : '<div class="dim">No requests yet.</div>';
}

async function loadApiLog() {
  apiLog = await window.aredl.getRequestLog();
  renderApiLog();
}
window.aredl.onNewRequestLog((entry) => {
  apiLog.push(entry);
  if (apiLog.length > 500) apiLog.shift();
  renderApiLog();
});

// ---------------------------------------------------------------------------
// Demon list
// ---------------------------------------------------------------------------
function tierBadgeHtml(tier) {
  if (!tier) return '';
  return `<span class="tag">${escapeHtml(tier)}</span>`;
}

async function loadLevels() {
  const stateEl = $('#listState');
  stateEl.style.display = 'block';
  stateEl.className = 'state';
  stateEl.innerHTML = '<div class="spinner"></div>Fetching live data…';
  $('#countLabel').textContent = 'Loading…';
  let liveDone = false;
  try {
    const live = window.aredl.getLevels(); // start the real request first...
    if (!state.levels.length && window.aredl.getCachedLevels) {
      // ...and meanwhile show the list saved last time, so the app is usable straight away
      window.aredl.getCachedLevels().then(saved => {
        if (liveDone || !Array.isArray(saved) || !saved.length) return;
        state.levels = saved;
        extractCompletedFromLevels(saved);
        populateStatusFilter(saved);
        applyFilters();
        $('#countLabel').textContent += ' · updating…';
      }).catch(() => {});
    }
    const data = await live;
    liveDone = true;
    if (!Array.isArray(data) || !data.length) throw new Error('Empty response');
    state.levels = data;
    extractCompletedFromLevels(data);
    populateStatusFilter(data);
    applyFilters();
    $('#listRawZone').innerHTML = `${rawDetails(`Full API response (${data.length.toLocaleString()} levels)`, data)}`;
  } catch (err) {
    liveDone = true;
    if (state.levels.length) { // offline, but the saved list is on screen: keep it
      stateEl.style.display = 'none';
      $('#countLabel').textContent = $('#countLabel').textContent.replace(' · updating…', '') + ' · offline, showing the last saved list';
      return;
    }
    stateEl.className = 'state error';
    stateEl.innerHTML = `Couldn't load the list (${escapeHtml(errMsg(err))}). <button class="linklike" id="retryList">Retry</button>`;
    $('#countLabel').textContent = 'Failed to load';
    document.getElementById('retryList')?.addEventListener('click', loadLevels);
  }
}

function populateStatusFilter(data) {
  const statuses = [...new Set(data.map(l => l.status).filter(Boolean))];
  const previous = $('#statusFilter').value; // keep what you picked when the list reloads
  $('#statusFilter').innerHTML = `<option value="__all__">All statuses</option>` +
    statuses.map(s => `<option value="${escapeHtml(s)}">${escapeHtml(s)}</option>`).join('');
  $('#statusFilter').value = statuses.includes(previous) ? previous : '__all__'; // starts on All statuses
}

// Search syntax (also explained in the "i" popup next to the search box):
//   text            contains, in the name / tags / description
//   "name"          the whole level name must equal it (capitals ignored)
//   a || b          either part
//   id:123  song:123  tag:wave  tag:"high cps"  pos:50  pos:1-75  pos:>150  status:extended
//                   filters - everything in one `||` part must match (filters AND text)
// An unclosed quote (still typing) is treated as plain text.
const SEARCH_FILTER_RE = /\b(id|song|tag|pos|status)\s*:\s*("[^"]*"|\S+)/gi;
function searchTerms(raw) {
  return String(raw).replace(/[\u201C\u201D]/g, '"').replace(/[\u2018\u2019]/g, "'").split('||').map(piece => {
    const filters = [];
    const rest = piece.replace(SEARCH_FILTER_RE, (_m, key, val) => {
      filters.push({ key: key.toLowerCase(), val: val.replace(/^"|"$/g, '').trim().toLowerCase() });
      return ' ';
    }).trim();
    let text = '', exact = false, nameHas = false;
    if (rest.length >= 2 && rest.startsWith('"') && rest.endsWith('"')) {
      text = rest.slice(1, -1).trim().toLowerCase();
      exact = !!text;
    } else if (rest.length >= 2 && rest.startsWith("'") && rest.endsWith("'")) {
      text = rest.slice(1, -1).trim().toLowerCase();
      nameHas = !!text;
    } else {
      text = rest.replace(/["]/g, '').trim().toLowerCase();
    }
    return (text || filters.length) ? { text, exact, nameHas, filters } : null;
  }).filter(Boolean);
}
// Plain text matching (used by the records search, which has no filters).
function matchesAnyTerm(haystack, terms, exactValue = haystack) {
  return terms.some(t => t.text && (t.exact ? exactValue.trim() === t.text : t.nameHas ? exactValue.includes(t.text) : haystack.includes(t.text)));
}

function levelFilterOk(l, f) {
  const v = f.val;
  if (!v) return true;
  switch (f.key) {
    case 'id': return String(l.level_id ?? '').includes(v);
    case 'song': return l.song != null && String(l.song).includes(v);
    case 'tag': return (l.tags || []).some(t => String(t).toLowerCase().includes(v));
    case 'status': {
      const st = String(l.status || '').toLowerCase();
      const p = l.position;
      if (v === 'main' || v === 'mainlist') return st === 'mainlist' && (p == null || p <= 150);
      if (v.startsWith('ext')) return st === 'mainlist' && p != null && p > 150;
      return st.includes(v.replace(/\s+/g, ''));
    }
    case 'pos': {
      const m = v.match(/^(<=|>=|<|>)?\s*(\d+)(?:\s*-\s*(\d+))?$/);
      if (!m || l.position == null) return false;
      const p = l.position;
      if (m[3]) return p >= +m[2] && p <= +m[3];
      const n = +m[2];
      switch (m[1]) { case '<': return p < n; case '<=': return p <= n; case '>': return p > n; case '>=': return p >= n; default: return p === n; }
    }
    default: return true;
  }
}
const levelTextCache = new WeakMap(); // level -> { hay, name } (lowercase), built once instead of on every keystroke
function levelText(l) {
  let t = levelTextCache.get(l);
  if (!t) { t = { hay: (l.name + ' ' + (l.tags || []).join(' ') + ' ' + (l.description || '')).toLowerCase(), name: String(l.name).toLowerCase() }; levelTextCache.set(l, t); }
  return t;
}
const NAME_COLLATOR = new Intl.Collator(); // same ordering as localeCompare, without re-creating a collator for every comparison
function levelMatchesTerm(l, t, hay, nameLower) {
  if (t.text) {
    if (t.exact) { if (nameLower.trim() !== t.text) return false; }
    else if (t.nameHas) { if (!nameLower.includes(t.text)) return false; }
    else if (!hay.includes(t.text)) return false;
  }
  return t.filters.every(f => levelFilterOk(l, f));
}

function applyFilters() {
  const terms = searchTerms($('#search').value);
  const status = $('#statusFilter').value;
  const completedOnly = $('#completedOnly').checked;
  const includeTags = Object.entries(state.tagFilters).filter(([, m]) => m === 'include').map(([k]) => k);
  const excludeTags = Object.entries(state.tagFilters).filter(([, m]) => m === 'exclude').map(([k]) => k);
  let list = state.levels.filter(l => {
    if (status !== '__all__' && l.status !== status) return false;
    if (completedOnly && !state.completedIds.has(String(l.level_id))) return false;
    if (includeTags.length || excludeTags.length) {
      const tagsLower = (l.tags || []).map(t => String(t).toLowerCase());
      if (includeTags.some(t => !tagsLower.includes(t))) return false;
      if (excludeTags.some(t => tagsLower.includes(t))) return false;
    }
    if (!terms.length) return true;
    const text = levelText(l);
    return terms.some(t => levelMatchesTerm(l, t, text.hay, text.name));
  });
  const sort = $('#sortBy').value;
  const byChosenSort = (a, b) => {
    if (sort === 'points') return (b.points || 0) - (a.points || 0);
    if (sort === 'name') return NAME_COLLATOR.compare(a.name, b.name);
    return (a.position || 0) - (b.position || 0);
  };
  list = list.slice().sort((a, b) => {
    if (status === '__all__') {
      const g = statusGroupRank(a.status) - statusGroupRank(b.status);
      if (g !== 0) return g;
    }
    return byChosenSort(a, b);
  });
  state.filtered = list;
  renderList();
  scrollListToSelected();
  requestAnimationFrame(scrollListToSelected); // once more after layout settles (e.g. the tab only just became visible)
}

// Centre the selected row inside the list. Done by hand on the list's own
// scroller: scrollIntoView() also scrolls every ancestor, and with
// off-screen rows only estimated in height it used to land far off target.
function scrollListToSelected() {
  if (state.selectedId == null) return;
  const list = $('#list');
  const row = list && list.querySelector(`.list-row[data-id="${CSS.escape(String(state.selectedId))}"]`);
  if (!row) return;
  const lr = list.getBoundingClientRect();
  const rr = row.getBoundingClientRect();
  if (!lr.height) return; // list isn't visible
  list.scrollTop += (rr.top - lr.top) - (list.clientHeight - rr.height) / 2;
}

// ---------------------------------------------------------------------------
// Tag filter (tri-state: neutral -> must-have (green) -> must-not-have (red))
// ---------------------------------------------------------------------------
const ALL_TAGS = [
  '2.2', '2.1', '2.0', '1.9PS', '1.9', '1.8', '1.7', '1.6PS', '1.6', '1.5',
  'Medium', 'Long', 'XL', 'XXL', 'XXL+', 'NONG',
  '2P', 'Circles', 'Clicksync', 'Fast-Paced', 'Timings', 'Chokepoints', 'Unbalanced', 'Learny', 'Memory',
  'High CPS', 'Gimmicky', 'Flow', 'Slow-Paced', 'Bossfight', 'Mirror', 'Nerve Control', 'Cube', 'Ship',
  'Ball', 'UFO', 'Wave', 'Robot', 'Spider', 'Old Swing', 'New Swing', 'Duals', 'Overall',
];
state.tagFilters = {}; // lowercase tag -> 'include' | 'exclude'

function renderTagFilterPanel() {
  $('#tagFilterPills').innerHTML = ALL_TAGS.map(t => {
    const key = t.toLowerCase();
    const mode = state.tagFilters[key] || '';
    return `<span class="tag-pill ${mode}" data-tag="${escapeHtml(key)}">${escapeHtml(t)}</span>`;
  }).join('');
}
renderTagFilterPanel();

function updateTagFilterCount() {
  const n = Object.keys(state.tagFilters).length;
  const badge = $('#tagFilterCount');
  badge.hidden = n === 0;
  badge.textContent = n;
}

$('#tagFilterBtn').addEventListener('click', () => $('#tagFilterCollapse').classList.toggle('open'));

$('#tagFilterClear').addEventListener('click', () => {
  state.tagFilters = {};
  renderTagFilterPanel();
  updateTagFilterCount();
  applyFilters();
});

$('#tagFilterPills').addEventListener('click', (e) => {
  const pill = e.target.closest('.tag-pill');
  if (!pill) return;
  cycleTagFilter(pill.dataset.tag);
});

function cycleTagFilter(key) {
  const current = state.tagFilters[key];
  const next = current === undefined ? 'include' : (current === 'include' ? 'exclude' : undefined);
  if (next === undefined) delete state.tagFilters[key];
  else state.tagFilters[key] = next;
  renderTagFilterPanel();
  updateTagFilterCount();
  document.querySelectorAll(`.video-tags .tag-pill[data-apply-tag="${CSS.escape(key)}"]`).forEach(el => {
    el.classList.remove('include', 'exclude');
    if (state.tagFilters[key]) el.classList.add(state.tagFilters[key]);
  });
  applyFilters();
}

// Tag chips under the video: apply the filter, but never force the panel
// open if the user hasn't opened it themselves.
document.addEventListener('click', (e) => {
  const chip = e.target.closest('.video-tags .tag-pill[data-apply-tag]');
  if (chip) cycleTagFilter(chip.dataset.applyTag);
});

const STATUS_GROUP_ORDER = { MainList: 0, Legacy: 1, Pending: 2, Removed: 3 };
function statusGroupRank(s) { return STATUS_GROUP_ORDER[s] ?? 99; }

// One floating section label (never stacks up): it appears only once that section's own
// header has scrolled off the top of the list.
function updateStickyLabel() {
  const list = document.getElementById('list');
  const label = document.getElementById('listStickyLabel');
  if (!list || !label) return;
  const lt = list.getBoundingClientRect().top;
  let cur = null;
  for (const d of list.querySelectorAll('.list-divider')) {
    if (d.getBoundingClientRect().top - lt <= 4) cur = d; else break;
  }
  const show = cur && cur.getBoundingClientRect().bottom - lt <= 0;
  if (show) label.firstElementChild.textContent = cur.textContent;
  label.classList.toggle('show', !!show);
}
document.getElementById('list').addEventListener('scroll', () => requestAnimationFrame(updateStickyLabel), { passive: true });

function renderList() {
  $('#listState').style.display = 'none';
  $('#listLayout').hidden = false;
  let label = `${state.filtered.length.toLocaleString()} shown · ${state.levels.length.toLocaleString()} total`;
  if (state.signedIn) {
    label += state.completionField
      ? ` · completed via \`${state.completionField}\` (${state.completedIds.size} done)`
      : ` · couldn't detect a completion field in the level data`;
  }
  $('#countLabel').textContent = label;

  const showAll = $('#statusFilter').value === '__all__';
  const sortMode = $('#sortBy').value;
  let prevStatus = null;
  let extendedShown = false;
  const favIds = new Set(state.favourites.map(f => String(f.level_id)));
  const followIds = new Set(state.following.map(f => String(f.level_id)));
  $('#list').innerHTML = state.filtered.map(l => {
    const isFav = favIds.has(String(l.level_id)), isFollow = followIds.has(String(l.level_id));
    const completed = state.completedIds.has(String(l.level_id));
    const selected = isRowSelected(l.id);
    const hasPosition = l.position != null;
    const rankLabel = hasPosition ? `#${l.position}` : ((l.status === 'Pending' || l.status === 'Removed') ? '—' : (l.status || 'Legacy'));
    let divider = '';
    if (showAll && l.status !== prevStatus) {
      divider += `<div class="list-divider"><span>${escapeHtml(l.status || 'Other')}</span></div>`;
      prevStatus = l.status;
    }
    if (sortMode === 'position' && l.status === 'MainList' && l.position === 151 && !extendedShown) {
      divider += `<div class="list-divider"><span>Extended List</span></div>`;
      extendedShown = true;
    }
    return `${divider}
    <div class="list-row ${completed ? 'completed' : ''} ${selected ? 'selected' : ''} ${l.status === 'Removed' ? 'removed' : ''} ${isFav ? 'favourite' : ''} ${isFollow ? 'followed' : ''}"
         data-id="${l.id}" data-level-id="${l.level_id}">
      <span class="rank-mini${hasPosition ? '' : (rankLabel === '—' ? ' rank-mini-dash' : ' rank-mini-status')}">${escapeHtml(rankLabel)}</span>
      <span class="name-mini">${escapeHtml(l.name)}</span>
      ${isFollow ? bellSvg('follow-mini') : ''}
      ${isFav ? starSvg('fav-mini') : ''}
      ${completed ? '<span class="check-mini">✓</span>' : ''}
    </div>`;
  }).join('');
  updateStickyLabel();
}


// ---------------------------------------------------------------------------
// Favourites - stored in the app's own data folder (see favourites:* in
// main.js). We keep the level_id plus a name snapshot, but always prefer the
// live name/position from state.levels when it's loaded.
// ---------------------------------------------------------------------------
state.favourites = []; // [{ level_id, name }]
state.multi = new Set(); // level `id`s selected with ctrl+click (multi-select view is active at 2+)

// "MainList" covers two lists on the site: the top 150 and the Extended List below it.
function levelStatusLabel(l) {
  if (!l || !l.status) return '';
  if (l.status === 'MainList') return (l.position != null && l.position > 150) ? 'Extended List' : 'Main List';
  return l.status;
}

// What a favourite is "for". New favourites start as Favourited; completed levels
// show a green Completed pill instead of the picker.
const FAV_LABELS = [
  { key: 'favourited', name: 'Favourited',      color: '#fbbf24' },
  { key: 'looking',    name: 'Planning to beat', color: '#3b82f6' },
  { key: 'want',       name: 'Want to beat',     color: '#06b6d4' },
  { key: 'progress',   name: 'In progress',     color: '#a855f7' },
  { key: 'hold',       name: 'On hold',         color: '#94a3b8' },
  { key: 'dropped',    name: 'Dropped',         color: '#ef4444' },
];
const STATUS_COLORS = { 'Main List': 'var(--accent)', 'Extended List': '#38bdf8', 'Legacy': '#c2410c', 'Pending': '#eab308', 'Removed': '#ef4444' };
const favLabelOf = (key) => FAV_LABELS.find(x => x.key === key) || FAV_LABELS[0];

async function setFavLabel(levelId, key) {
  const f = state.favourites.find(x => String(x.level_id) === String(levelId));
  if (!f) return;
  f.label = key;
  renderFavourites();
  try { await window.aredl.setFavourites(state.favourites); }
  catch (err) { showToast(`Couldn't save favourites: ${errMsg(err)}`); }
}

// Toggle a row's favourite / followed state live, adding its icon if the row was drawn without one.
function setRowFlag(row, flag, on) {
  row.classList.toggle(flag, on);
  if (!on) return;
  const sel = flag === 'favourite' ? '.fav-mini' : '.follow-mini';
  if (!row.querySelector(sel)) row.insertAdjacentHTML('beforeend', flag === 'favourite' ? starSvg('fav-mini') : bellSvg('follow-mini'));
}
function isFavourite(levelId) {
  return state.favourites.some(f => String(f.level_id) === String(levelId));
}

async function toggleFavourite(level) {
  if (level.level_id == null) return;
  if (isFavourite(level.level_id)) {
    state.favourites = state.favourites.filter(f => String(f.level_id) !== String(level.level_id));
  } else {
    state.favourites = [...state.favourites, { level_id: level.level_id, name: level.name, label: 'favourited' }];
  }
  const nowFav = isFavourite(level.level_id);
  document.querySelectorAll(`.list-row[data-level-id="${CSS.escape(String(level.level_id))}"]`)
    .forEach(r => setRowFlag(r, 'favourite', nowFav));
  renderFavourites();
  showToast(nowFav ? 'Added to favourites' : 'Removed from favourites');
  try { await window.aredl.setFavourites(state.favourites); }
  catch (err) { showToast(`Couldn't save favourites: ${errMsg(err)}`); }
}

function renderFavourites() {
  const el = document.getElementById('favList');
  if (!el) return;
  $('#favCount').textContent = state.favourites.length ? `(${state.favourites.length})` : '';
  if (!state.favourites.length) {
    el.innerHTML = '<div class="state">No favourites yet.</div>';
    return;
  }
  const rows = state.favourites.map(f => {
    const live = state.levels.find(l => String(l.level_id) === String(f.level_id));
    return {
      level_id: f.level_id,
      name: (live && live.name) || f.name || `Level ${f.level_id}`,
      position: live ? live.position : null,
      status: live ? levelStatusLabel(live) : null,
      label: f.label || 'favourited',
    };
  }).sort((a, b) => {
    if (a.position == null && b.position == null) return NAME_COLLATOR.compare(a.name, b.name);
    if (a.position == null) return 1;
    if (b.position == null) return -1;
    return a.position - b.position;
  });
  const cardOf = (r) => {
    const l = r.live;
    const hasPos = r.position != null;
    const pills = [];
    const completed = state.completedIds.has(String(r.level_id));
    const lab = favLabelOf(r.label);
    if (r.status) pills.push(`<span class="fav-pill status">${escapeHtml(r.status)}</span>`);
    pills.push(completed
      ? `<span class="fav-pill done">✓ Completed</span>`
      : `<button class="fav-pill fav-label" data-fav-label="${escapeHtml(r.level_id)}" style="--c:${lab.color}" title="Change what this favourite is for"><i class="dot"></i>${escapeHtml(lab.name)}<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 8l5 5 5-5"/></svg></button>`);
    if (l && l.points != null) pills.push(`<span class="fav-pill">${escapeHtml(formatPoints(l.points))} pts</span>`);
    if (l && l.edel_enjoyment != null) pills.push(`<span class="fav-pill">EDEL ${escapeHtml(enjText(l))}</span>`);
    const tags = l ? (l.tags || []) : [];
    const tagHtml = tags.slice(0, 4).map(t => `<span class="tag">${escapeHtml(t)}</span>`).join('')
      + (tags.length > 4 ? `<span class="tag">+${tags.length - 4}</span>` : '');
    const pubName = l && l.publisher_id != null ? publisherNames.get(String(l.publisher_id)) : null;
    return `<div class="fav-card${completed ? ' completed' : ''}" style="--c:${completed ? '#4ade80' : lab.color}" data-level-id="${escapeHtml(r.level_id)}" data-jump="${escapeHtml(r.level_id)}">
      <button class="fav-remove" data-fav-remove="${escapeHtml(r.level_id)}" title="Remove from favourites" aria-label="Remove from favourites">${starSvg('fav-star')}</button>
      <div class="fav-card-rank${hasPos ? '' : ' status'}">${escapeHtml(hasPos ? `#${r.position}` : (r.status || '—'))}</div>
      <div class="fav-card-name">${escapeHtml(r.name)}</div>
      ${pubName ? `<div class="fav-card-by">by ${escapeHtml(pubName)}</div>` : ''}
      ${pills.length ? `<div class="fav-pills">${pills.join('')}</div>` : ''}
      ${tagHtml ? `<div class="fav-tags">${tagHtml}</div>` : ''}
      <div class="fav-card-foot">
        <span class="fav-card-id copyable" data-copy="${escapeHtml(r.level_id)}" data-copy-label="Level ID" title="Click to copy">ID ${escapeHtml(r.level_id)}</span>
        ${levelToolsHtml({ level_id: r.level_id, name: r.name })}
      </div>
    </div>`;
  };

  // Sorting by list or category groups the cards under coloured headers.
  const sortMode = appSettings.favSort || 'category';
  const isDone = (r) => state.completedIds.has(String(r.level_id));
  const groupBy = (keyOf, nameOf, colorOf, order) => {
    const by = new Map();
    rows.forEach(r => { const k = keyOf(r); if (!by.has(k)) by.set(k, []); by.get(k).push(r); });
    const rank = (k) => { const i = order.indexOf(k); return i < 0 ? 99 : i; };
    return [...by.entries()].sort((a, b) => rank(a[0]) - rank(b[0])).map(([k, list]) => ({ name: nameOf(k), color: colorOf(k), rows: list }));
  };
  let groups = [{ name: null, rows }];
  if (sortMode === 'list') {
    groups = groupBy(r => r.status || 'Not loaded', k => k, k => STATUS_COLORS[k] || '#94a3b8', ['Main List', 'Extended List', 'Legacy', 'Pending', 'Removed']);
  } else if (sortMode === 'category') {
    groups = groupBy(r => isDone(r) ? 'completed' : favLabelOf(r.label).key,
      k => k === 'completed' ? 'Completed' : favLabelOf(k).name,
      k => k === 'completed' ? '#4ade80' : favLabelOf(k).color,
      ['completed', ...FAV_LABELS.map(x => x.key)]);
  }
  el.innerHTML = groups.map(g =>
    (g.name ? `<div class="fav-group-head" style="--c:${g.color}"><i class="dot"></i>${escapeHtml(g.name)}<span class="count">${g.rows.length}</span></div>` : '')
    + g.rows.map(cardOf).join('')).join('');
  markRangeCards();
}

// The label pill opens a small menu of options.
document.addEventListener('click', (e) => {
  const pill = e.target.closest('[data-fav-label]');
  if (!pill) return;
  const id = pill.dataset.favLabel;
  const cur = (state.favourites.find(x => String(x.level_id) === String(id)) || {}).label || 'favourited';
  const r = pill.getBoundingClientRect();
  showContextMenu(r.left, r.bottom + 6, FAV_LABELS.map(o => ({
    label: o.name, color: o.color, checked: o.key === cur, onClick: () => setFavLabel(id, o.key),
  })));
});

document.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-fav-remove]');
  if (!btn) return;
  const f = state.favourites.find(x => String(x.level_id) === btn.dataset.favRemove);
  toggleFavourite(state.levels.find(l => String(l.level_id) === btn.dataset.favRemove) || f || { level_id: btn.dataset.favRemove, name: '' });
});

async function loadFavourites() {
  try { state.favourites = await window.aredl.getFavourites(); }
  catch { state.favourites = []; }
  { const ids = new Set(state.favourites.map(f => String(f.level_id))); document.querySelectorAll('.list-row[data-level-id]').forEach(r => setRowFlag(r, 'favourite', ids.has(r.dataset.levelId))); }
  renderFavourites();
}

// ---------------------------------------------------------------------------
// Following levels
//
// A followed level is checked (via its position history) every 2 minutes while
// the app is running, and once at startup. New history entries become
// notifications - shown in the Notifications tab - if the matching option is on
// for that level. Stored in the app's data folder: following.json holds the
// levels + their options + how far we've already looked; follow-notifications.json
// holds the notifications produced.
// ---------------------------------------------------------------------------
const FOLLOW_OPTIONS = [
  { key: 'movedUp',      label: 'Level moves up' },
  { key: 'movedDown',    label: 'Level moves down' },
  { key: 'otherAbove',   label: 'Other levels placed / moved above it' },
  { key: 'otherBelow',   label: 'Other levels moved below it' },
  { key: 'statusChange', label: 'Placed, pending, removed or legacy' },
];
const FOLLOW_DEFAULTS = { movedUp: true, movedDown: true, otherAbove: false, otherBelow: false, statusChange: true };
let followTimer = null;
const followMinutes = () => (Number.isFinite(appSettings.followMins) ? appSettings.followMins : 2);
function restartFollowTimer() {
  clearInterval(followTimer);
  const m = followMinutes();
  if (m > 0) followTimer = setInterval(checkFollowed, m * 60000);
}

state.following = [];   // [{ level_id, name, notify:{...}, lastSeenAt, lastChange }]
let followNotifs = [];  // [{ id, level_id, level_name, category, text, at }]
let followLoaded = false;
let followChecking = false;
let followLastChecked = null;

async function loadFollowStores() {
  if (followLoaded) return;
  try { state.following = await window.aredl.getStore('following'); } catch { state.following = []; }
  try { followNotifs = await window.aredl.getStore('follow-notifications'); } catch { followNotifs = []; }
  followLoaded = true;
}
async function saveFollowing() {
  try { await window.aredl.setStore('following', state.following); }
  catch (err) { showToast(`Couldn't save: ${errMsg(err)}`); }
}
async function saveFollowNotifs() {
  followNotifs = followNotifs.slice(0, 300);
  try { await window.aredl.setStore('follow-notifications', followNotifs); } catch { /* keep in memory */ }
}

function isFollowing(levelId) {
  return state.following.some(f => String(f.level_id) === String(levelId));
}

function historyList(data) {
  return Array.isArray(data) ? data : (data.data || data.items || data.history || data.results || []);
}

function syncFollowButtons(levelId) {
  const on = isFollowing(levelId);
  document.querySelectorAll(`.list-row[data-level-id="${CSS.escape(String(levelId))}"]`).forEach(r => setRowFlag(r, 'followed', on));
  document.querySelectorAll(`[data-follow-toggle="${CSS.escape(String(levelId))}"]`).forEach(b => {
    b.classList.toggle('active', on);
    b.dataset.tip = on ? 'Unfollow level' : 'Follow level';
  });
}

async function toggleFollow(level) {
  if (level.level_id == null) return;
  await loadFollowStores();
  if (isFollowing(level.level_id)) {
    state.following = state.following.filter(f => String(f.level_id) !== String(level.level_id));
    await saveFollowing();
    syncFollowButtons(level.level_id);
    renderFollowed();
    showToast('Unfollowed level');
    return;
  }
  // Baseline: only changes from now on should notify, so remember the newest
  // history entry that already exists.
  let newest = null;
  try {
    const list = historyList(await window.aredl.getLevelHistory(level.level_id));
    list.forEach(e => { const d = entryDate(e); if (d && (!newest || d > newest)) newest = d; });
  } catch { /* fall back to "now" below */ }
  const baseline = (newest || new Date()).toISOString();
  state.following = [...state.following, {
    level_id: level.level_id, name: level.name, notify: { ...FOLLOW_DEFAULTS },
    lastSeenAt: baseline, lastChange: newest ? newest.toISOString() : null,
  }];
  await saveFollowing();
  syncFollowButtons(level.level_id);
  renderFollowed();
  showToast('Following level');
}

// Which option a history entry falls under (null = never notify for it).
function followCategory(entry) {
  const type = String(actionTypeOf(entry) || '');
  switch (type) {
    case 'Raised': return 'movedUp';
    case 'Lowered': return 'movedDown';
    case 'Swapped': return typeof entry.position_diff === 'number' ? (entry.position_diff < 0 ? 'movedUp' : (entry.position_diff > 0 ? 'movedDown' : null)) : null;
    case 'Placed': case 'Pending': case 'Removed': case 'MovedToLegacy': return 'statusChange';
    case 'OtherLowered': case 'OtherMovedDown': return 'otherBelow';
    default: return type.startsWith('Other') ? 'otherAbove' : null;
  }
}

function followText(entry) {
  const type = String(actionTypeOf(entry) || '');
  const pos = historyPosition(entry);
  const diff = typeof entry.position_diff === 'number' ? entry.position_diff : null;
  const from = (pos != null && diff != null && diff !== 0) ? pos - diff : null;
  const move = (verb) => `${verb}${pos != null ? ` to #${pos}` : ''}${from != null ? ` (from #${from})` : ''}`;
  const ref = entry.cause && typeof entry.cause === 'object' ? entry.cause : (entry.affected_level || findLevelRefDeep(entry));
  const other = (ref && ref.name) || 'Another level';
  const now = pos != null ? ` - now #${pos}` : '';
  switch (type) {
    case 'Raised': return move('moved up');
    case 'Lowered': return move('moved down');
    case 'Swapped': return move(diff != null && diff < 0 ? 'moved up (swap)' : 'moved down (swap)');
    case 'Placed': return `placed${pos != null ? ` at #${pos}` : ''}`;
    case 'Pending': return 'put on pending';
    case 'Removed': return 'removed from the list';
    case 'MovedToLegacy': return 'moved to the legacy list';
    case 'OtherPlaced': return `${other} was placed above${now}`;
    case 'OtherRaised': case 'OtherMovedUp': return `${other} was moved above${now}`;
    case 'OtherLowered': case 'OtherMovedDown': return `${other} was moved below${now}`;
    case 'OtherRemoved': return `${other} was removed${now}`;
    case 'OtherMovedToLegacy': return `${other} was moved to legacy${now}`;
    case 'OtherSwapped': return `${other} swapped positions${now}`;
    case 'OtherPending': return `${other} was put on pending${now}`;
    default: return type || 'updated';
  }
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function checkFollowed({ manual = false } = {}) {
  await loadFollowStores();
  if (followChecking) return;
  followChecking = true;
  const btn = $('#followCheckBtn');
  if (btn) btn.classList.add('spinning');
  let added = 0;
  try {
    for (const f of state.following.slice()) {
      const wanted = Object.values(f.notify || {}).some(Boolean);
      if (!wanted) continue;
      try {
        const list = historyList(await window.aredl.getLevelHistory(f.level_id));
        const since = f.lastSeenAt ? new Date(f.lastSeenAt) : new Date(0);
        const fresh = list.map(e => ({ e, d: entryDate(e) })).filter(x => x.d && x.d > since).sort((a, b) => a.d - b.d);
        for (const { e, d } of fresh) {
          const cat = followCategory(e);
          if (cat && f.notify[cat]) {
            const cause = e.cause && typeof e.cause === 'object' ? (e.cause.level_id ?? e.cause.id ?? '') : '';
            const id = `${f.level_id}|${d.toISOString()}|${actionTypeOf(e)}|${cause}`;
            if (!followNotifs.some(n => n.id === id)) {
              followNotifs.unshift({ id, level_id: f.level_id, level_name: f.name, category: cat, text: followText(e), at: d.toISOString() });
              added++;
            }
          }
        }
        if (fresh.length) {
          f.lastSeenAt = fresh[fresh.length - 1].d.toISOString();
          f.lastChange = f.lastSeenAt;
        }
      } catch (err) {
        if (manual) showToast(`Couldn't check ${f.name}: ${errMsg(err)}`);
      }
      await sleep(400); // be gentle with the API
    }
    followLastChecked = new Date();
    await saveFollowing();
    if (added) {
      await saveFollowNotifs();
      bumpNotifBadge(added);
      showToast(`${added} new update${added === 1 ? '' : 's'} on followed levels`);
      if (document.getElementById('tab-notifications').classList.contains('active')) renderNotifications();
    } else if (manual) {
      showToast('No new changes');
    }
  } finally {
    followChecking = false;
    if (btn) btn.classList.remove('spinning');
    renderFollowed();
  }
}

async function startFollowing() {
  await loadFollowStores();
  renderFollowed();
  checkFollowed();                              // once when the app opens
  restartFollowTimer(); // then on the interval from Settings while it's running
}

function renderFollowed() {
  const el = document.getElementById('followList');
  if (!el) return;
  $('#followCount').textContent = state.following.length ? `(${state.following.length})` : '';
  if (!state.following.length) {
    el.innerHTML = '<div class="state">You\'re not following any levels yet.</div>';
    return;
  }
  const checked = followLastChecked ? `Last checked ${formatRelativeTime(followLastChecked)}` : 'Checking…';
  const rows = state.following.map(f => {
    const live = state.levels.find(l => String(l.level_id) === String(f.level_id));
    return { f, live, name: (live && live.name) || f.name || `Level ${f.level_id}`, position: live ? live.position : null, status: live ? levelStatusLabel(live) : '' };
  }).sort((a, b) => (a.position ?? 1e9) - (b.position ?? 1e9) || NAME_COLLATOR.compare(a.name, b.name));
  el.innerHTML = `<div class="follow-checked">${escapeHtml(checked)} · ${followMinutes() > 0 ? `every ${followMinutes() === 1 ? 'minute' : followMinutes() + ' minutes'}` : 'only at startup'} while the app is running</div>` + rows.map(({ f, name, position, status }) => {
    const hasPos = position != null;
    return `<div class="follow-card" data-level-id="${escapeHtml(f.level_id)}">
      <div class="follow-head">
        <span class="fav-card-rank${hasPos ? '' : ' status'}">${escapeHtml(hasPos ? `#${position}` : (status || '—'))}</span>
        <a href="#" class="follow-name" data-jump="${escapeHtml(f.level_id)}">${escapeHtml(name)}</a>
        <span class="follow-actions">
          ${levelToolsHtml({ level_id: f.level_id, name })}
          <button class="icon-tool follow-btn active" data-tip="Unfollow level" data-follow-toggle="${escapeHtml(f.level_id)}" aria-label="Unfollow level"><svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M5.5 8a4.5 4.5 0 0 1 9 0c0 4 1.5 5 1.5 5H4s1.5-1 1.5-5Z"/><path d="M8.5 16a1.7 1.7 0 0 0 3 0"/></svg></button>
        </span>
      </div>
      <div class="follow-meta">${f.lastChange ? `Last change ${escapeHtml(formatRelativeTime(new Date(f.lastChange)))}` : 'No changes recorded yet'}</div>
      <div class="follow-label">Notify me when…</div>
      <div class="follow-opts">${FOLLOW_OPTIONS.map(o => `<button class="opt-pill${f.notify && f.notify[o.key] ? ' active' : ''}" data-follow-opt="${o.key}" data-follow-level="${escapeHtml(f.level_id)}">${escapeHtml(o.label)}</button>`).join('')}</div>
    </div>`;
  }).join('');
  markRangeCards();
}

document.addEventListener('click', async (e) => {
  const tog = e.target.closest('[data-follow-toggle]');
  if (tog) {
    const id = tog.dataset.followToggle;
    const level = state.levels.find(l => String(l.level_id) === id) || (state.following.find(f => String(f.level_id) === id)) || { level_id: id, name: '' };
    toggleFollow(level);
    return;
  }
  const opt = e.target.closest('[data-follow-opt]');
  if (opt) {
    const f = state.following.find(x => String(x.level_id) === opt.dataset.followLevel);
    if (!f) return;
    f.notify = { ...(f.notify || {}), [opt.dataset.followOpt]: !(f.notify && f.notify[opt.dataset.followOpt]) };
    opt.classList.toggle('active', !!f.notify[opt.dataset.followOpt]);
    saveFollowing();
  }
});
$('#followCheckBtn').addEventListener('click', () => checkFollowed({ manual: true }));

// ---------------------------------------------------------------------------
// Personal list - your own hardest-levels sheet
//
// Each entry is one level from the list plus what only you know: attempts, physics,
// version, clears, date, video. A few columns can be filled in from the level list
// (name, ID, AREDL placement, GDDL tier); each of those has its own Auto switch in the
// form, and with Auto off the value you typed is kept instead. "Days since" and the
// "#" rank (hardest first, by tier) are always worked out. Stored in personal-list.json.
// ---------------------------------------------------------------------------
let personalList = [];
let personalLoaded = false;
let plEditingId = null;      // entry being edited (null = adding)
let plPicked = null;         // the level chosen in the form (a state.levels object or a snapshot)
let plDeleteArmed = false;

async function loadPersonal() {
  if (personalLoaded) return;
  try { const stored = await window.aredl.getStore('personal-list'); personalList = Array.isArray(stored) ? stored : []; } catch { personalList = []; }
  personalLoaded = true;
}
async function savePersonal() {
  try { await window.aredl.setStore('personal-list', personalList); return true; }
  catch (err) { showToast(`Couldn't save: ${errMsg(err)}`); return false; }
}

const plLive = (e) => state.levels.find(l => String(l.level_id) === String(e.level_id));
const plSnap = (l) => ({ name: l.name, level_id: l.level_id, position: l.position ?? null, gddl_tier: l.gddl_tier ?? null, status: l.status || null, points: l.points ?? null });

// A run is "53-79" (from 53% to 79%), or just "79" / "100" (from the start). 20-100 is a completion
// that began at 20%. Returns { start, end } (start is null for a plain percentage) or null if invalid.
function plParseRun(text) {
  const t = String(text ?? '').trim().replace(/%/g, '').trim();
  if (!t) return { start: null, end: 100 };
  let m = t.match(/^(\d{1,3})\s*[-\u2013\u2014]\s*(\d{1,3})$/);
  if (m) {
    const start = Number(m[1]), end = Number(m[2]);
    return end >= 1 && end <= 100 && start < end ? { start, end } : null;
  }
  m = t.match(/^\d{1,3}$/);
  if (m) {
    const end = Number(t);
    return end >= 1 && end <= 100 ? { start: null, end } : null;
  }
  return null;
}
// A plain 100% is a completion. Anything under 100, or a run with a start (like 20-100), is a run.
const plIsDone = (e) => (e.percent == null || Number(e.percent) >= 100) && plStartOf(e) == null;
const plIsRun = (run) => !!run && (run.end < 100 || run.start != null);
const plStartOf = (e) => (e.startPercent != null && Number(e.startPercent) < Number(e.percent ?? 100) ? Number(e.startPercent) : null);
const plRunText = (e) => (plStartOf(e) != null ? `${plStartOf(e)}\u2013${Number(e.percent)}%` : `${Number(e.percent ?? 100)}%`);
const plRunInput = (e) => (plStartOf(e) != null ? `${plStartOf(e)}-${Number(e.percent)}` : String(e.percent ?? 100));

// the values an entry shows: from the live list when that field is on Auto, else what you typed
function plResolve(e) {
  const live = plLive(e);
  const sn = live ? plSnap(live) : (e.snap || {});
  const auto = e.auto || {}, man = e.manual || {};
  const placementAuto = sn.position != null ? `Top ${sn.position}` : (sn.status ? (levelStatusLabel({ status: sn.status, position: null }) || '—') : '—');
  const tierRaw = auto.tier === false ? man.tier : sn.gddl_tier;
  const tierNum = tierRaw === '' || tierRaw == null || Number.isNaN(Number(tierRaw)) ? null : Number(tierRaw);
  const pointsNum = auto.points === false
    ? (Number.isNaN(parseFloat(String(man.points || '').replace(/,/g, ''))) ? null : parseFloat(String(man.points).replace(/,/g, '')))
    : (sn.points != null ? sn.points / 10 : null);
  return {
    name: auto.name === false ? (man.name || '') : (sn.name || e.snap?.name || ''),
    id: auto.id === false ? (man.id || '') : (sn.level_id ?? e.level_id ?? ''),
    placement: auto.placement === false ? (man.placement || '—') : placementAuto,
    tier: tierNum,
    pointsNum,
    points: pointsNum != null ? pointsNum.toLocaleString(undefined, { maximumFractionDigits: 2 }) : '—',
    position: sn.position ?? null,
    jumpId: sn.level_id ?? e.level_id ?? null,
  };
}

const plDate = (iso) => {
  if (!iso) return null;
  const [y, m, d] = String(iso).split('-').map(Number);
  return y ? new Date(y, (m || 1) - 1, d || 1) : null;
};
const plFmtDate = (iso) => { const d = plDate(iso); return d ? `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}` : '—'; };
const plDaysSince = (iso) => { const d = plDate(iso); return d ? Math.max(0, Math.floor((Date.now() - d.getTime()) / 86400000)) : null; };

function plSorted() {
  const rows = personalList.filter(plIsDone).map(e => ({ e, r: plResolve(e) }));
  const byTier = (a, b) => (b.r.tier ?? -1) - (a.r.tier ?? -1) || a.r.name.localeCompare(b.r.name);
  // "#" is always the rank by tier, whatever the display order
  const ranked = rows.slice().sort(byTier);
  ranked.forEach((row, i) => { row.rank = i + 1; });
  // (H): at the date it was beaten, nothing you'd beaten before was harder. Levels beaten the same
  // day are compared with each other, so only the hardest of that day counts.
  const dated = rows.filter(x => x.e.date && x.r.tier != null).sort((a, b) => String(a.e.date).localeCompare(String(b.e.date)));
  let hardestSoFar = -Infinity;
  for (let i = 0; i < dated.length;) {
    let j = i;
    while (j < dated.length && dated[j].e.date === dated[i].e.date) j++;
    const dayMax = Math.max(...dated.slice(i, j).map(x => x.r.tier));
    dated.slice(i, j).forEach(x => { x.hardest = x.r.tier === dayMax && x.r.tier > hardestSoFar; });
    hardestSoFar = Math.max(hardestSoFar, dayMax);
    i = j;
  }
  const mode = appSettings.plSort || 'hardest';
  const sorters = {
    hardest: byTier,
    placement: (a, b) => (a.r.position ?? 1e9) - (b.r.position ?? 1e9) || byLevelKey(a, b),
    date: (a, b) => String(b.e.date || '').localeCompare(String(a.e.date || '')),
    attempts: (a, b) => (b.e.attempts ?? -1) - (a.e.attempts ?? -1),
    name: (a, b) => a.r.name.localeCompare(b.r.name),
  };
  return rows.sort(sorters[mode] || byTier);
}
// Runs (anything that isn't a plain completion), in the chosen order
const plLevelKey = (x) => String(x.e.level_id ?? x.r.id ?? x.r.name ?? '');
const byLevelKey = (a, b) => plLevelKey(a).localeCompare(plLevelKey(b));
// The fewest runs that, between them, contain every % from 1 to 100. They may overlap, and they don't
// have to add up to 100 - 0-44, 39-59, 55-86 and 80-100 is 4 runs. A plain "79" counts as 0-79.
// Returns null when some % isn't in any run yet (then the level isn't "in runs").
function plRunsNeeded(entries) {
  const ranges = entries.map(e => [plStartOf(e) ?? 0, Number(e.percent)]);
  let covered = 0, count = 0;
  while (covered < 100) {
    let best = covered;
    for (const [start, end] of ranges) if (start <= covered + 1 && end > best) best = end;
    if (best === covered) return null; // a gap nothing reaches across
    covered = best;
    count++;
  }
  return count;
}
const plRunSize = (e) => Number(e.percent) - (plStartOf(e) ?? 0); // 50-90 is a 40% run, a plain 39 is 39%
function plProgressRows() {
  const rows = personalList.filter(e => !plIsDone(e)).map(e => ({ e, r: plResolve(e) }));
  const byName = (a, b) => a.r.name.localeCompare(b.r.name);
  const sorters = {
    run: (a, b) => plRunSize(b.e) - plRunSize(a.e) || Number(b.e.percent) - Number(a.e.percent),
    furthest: (a, b) => Number(b.e.percent) - Number(a.e.percent) || plRunSize(b.e) - plRunSize(a.e),
    // a level's runs stay together, in the order you made them: 0-44, 39-59, 55-86, 80-100
    placement: (a, b) => (a.r.position ?? 1e9) - (b.r.position ?? 1e9) || byLevelKey(a, b) || Number(a.e.percent) - Number(b.e.percent) || (plStartOf(a.e) ?? 0) - (plStartOf(b.e) ?? 0),
    tier: (a, b) => (b.r.tier ?? -1) - (a.r.tier ?? -1),
    attempts: (a, b) => (b.e.attempts ?? -1) - (a.e.attempts ?? -1),
    recent: (a, b) => String(b.e.date || '').localeCompare(String(a.e.date || '')),
    name: byName,
  };
  const sort = sorters[appSettings.plProgressSort] || sorters.run;
  return rows.sort((a, b) => sort(a, b) || byName(a, b));
}

// Average / median / min / max / total of every column that is a number, laid out under the
// same columns as the list so each figure sits beneath what it describes.
function plStatsHtml(done) {
  const nums = (f) => done.map(f).filter(v => v != null && !Number.isNaN(v));
  const trim = (n, dp) => String(parseFloat(n.toFixed(dp)));
  const none = [[], String, false];
  // columns, in grid order from "Tier" onwards: [values, formatter, whether a total makes sense].
  // Date, physics, version and days since have no statistics, so they are dashes.
  const cols = [
    [nums(x => x.r.tier), n => n.toFixed(2), false],                                                  // tier
    [nums(x => x.r.position), n => `Top ${Math.round(n)}`, false],                                     // AREDL placement
    [nums(x => x.r.pointsNum), n => n.toLocaleString(undefined, { maximumFractionDigits: 2 }), true],  // points
    [nums(x => x.e.attempts), n => Math.round(n).toLocaleString(), true],                              // attempts
    [nums(x => x.e.completions ?? 1), n => trim(n, 1), true],                                          // completions
    none, none, none, none,                                                                            // date, physics, version, days since
  ];
  const stat = (arr, kind) => {
    if (!arr.length) return null;
    const sorted = arr.slice().sort((a, b) => a - b);
    const sum = arr.reduce((a, b) => a + b, 0);
    if (kind === 'Average') return sum / arr.length;
    if (kind === 'Median') return sorted.length % 2 ? sorted[(sorted.length - 1) / 2] : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2;
    if (kind === 'Min') return sorted[0];
    if (kind === 'Max') return sorted[sorted.length - 1];
    return sum;
  };
  const rows = ['Average', 'Median', 'Min', 'Max', 'Total'].map(kind => {
    const cells = cols.map(([arr, fmt, canTotal]) => {
      if (kind === 'Total' && !canTotal) return '<span class="pl-cell">—</span>';
      const v = stat(arr, kind);
      return `<span class="pl-cell">${v == null ? '—' : escapeHtml(fmt(v))}</span>`;
    }).join('');
    // blank under #, the label under Level, a dash under Difficulty, then the columns, then two blanks (ID, actions)
    return `<div class="pl-row pl-stat"><span></span><span class="pl-stat-label">${kind}</span><span class="pl-cell">—</span>${cells}<span></span><span></span></div>`;
  }).join('');
  return `<div class="pl-section-title">Statistics <span class="dim-count">(${done.length} completed)</span></div>${rows}`;
}

function renderPersonal() {
  const el = document.getElementById('plTable');
  if (!el) return;
  const done = plSorted();
  const progress = plProgressRows();
  const totalPts = done.reduce((sum, x) => sum + (x.r.pointsNum || 0), 0);
  $('#plCount').textContent = personalList.length
    ? `(${done.length}${totalPts ? ` · ${totalPts.toLocaleString(undefined, { maximumFractionDigits: 2 })} pts` : ''})`
    : '';
  if (!personalList.length) {
    el.innerHTML = '<div class="state">Nothing here yet. Press <b>+ Add level</b> to start your list.</div>';
    $('#plProgressWrap').hidden = true;
    return;
  }
  // a stat you can click to copy (same hover + cursor as the level ID in the list)
  const cell = (label, html, raw, extra = '') => (raw == null || raw === '' || raw === '—'
    ? `<span class="pl-cell mono${extra}">—</span>`
    : `<span class="pl-cell mono copyable${extra}" data-copy="${escapeHtml(String(raw))}" data-copy-label="${escapeHtml(label)}" title="Click to copy">${html}</span>`);
  const rowHtml = ({ e, r, rank, hardest }, inProgress) => {
    const days = plDaysSince(e.date);
    const cls = !inProgress ? (rank === 1 ? ' rank1' : rank === 2 ? ' rank2' : rank === 3 ? ' rank3' : '') : '';
    const phys = plPhysicsOf(e);
    const physText = phys ? (/^[\d.]+$/.test(phys) ? `${phys} Phys` : phys) : '';
    const tag = rank === 1 ? 'CH' : (hardest ? 'H' : '');
    // (H) / (CH) sits beside the number rather than under it, so no row is taller than another
    const first = inProgress
      ? `<span class="pl-pct"><b>${plRunText(e)}</b></span>`
      : `<span class="pl-rank"><span class="pl-rank-wrap"><b class="rank-badge">${rank}</b>${tag ? `<span class="pl-rank-tag">(${tag})</span>` : ''}</span></span>`;
    const dayText = days != null ? `${days} ${days === 1 ? 'Day' : 'Days'}` : '';
    return `<div class="pl-row${cls}${inProgress ? ' progress' : ''}"${inProgress ? ` style="--from:${plStartOf(e) ?? 0}%;--pct:${Number(e.percent)}%"` : ''}>
      ${first}
      <span class="pl-name">${r.jumpId != null ? `<a href="#" class="level-link" data-jump="${escapeHtml(String(r.jumpId))}">${escapeHtml(r.name || '—')}</a>` : escapeHtml(r.name || '—')}</span>
      <span class="pl-cell">${e.difficulty ? `<span class="pl-diff" style="--c:${PL_DIFFS[e.difficulty] || '#555'}">${escapeHtml(e.difficulty)}</span>` : '—'}</span>
      ${cell('Tier', r.tier != null ? r.tier.toFixed(2) : '', r.tier != null ? r.tier.toFixed(2) : '')}
      ${cell('AREDL placement', escapeHtml(r.placement), r.placement)}
      ${cell('Points', escapeHtml(r.points), r.points)}
      ${cell('Attempts', e.attempts != null ? Number(e.attempts).toLocaleString() : '', e.attempts != null ? e.attempts : '')}
      ${inProgress ? '' : cell('Completions', String(e.completions ?? 1), e.completions ?? 1)}
      ${cell('Date', plFmtDate(e.date), e.date ? plFmtDate(e.date) : '')}
      ${cell('Physics', escapeHtml(physText), physText)}
      ${cell('Version', escapeHtml(e.version || ''), e.version || '')}
      ${cell('Days since', escapeHtml(dayText), dayText, ' dim')}
      ${cell('Level ID', escapeHtml(String(r.id || '')), String(r.id || ''), ' dim')}
      <span class="pl-actions-cell">
        ${e.video ? `<a class="icon-tool" href="${escapeHtml(e.video)}" target="_blank" rel="noopener" data-tip="Watch the video" aria-label="Watch the video"><svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="2.5" y="5" width="15" height="10" rx="3"/><path d="M8.5 7.8v4.4l3.8-2.2z" fill="currentColor"/></svg></a>` : ''}
        <button class="icon-tool" data-pl-edit="${escapeHtml(e.id)}" data-tip="Edit" aria-label="Edit"><svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 16l1-4 8.5-8.5a1.6 1.6 0 0 1 2.3 2.3L7.3 14.3 4 16Z"/></svg></button>
      </span>
    </div>`;
  };
  // Sorted by AREDL placement, each level gets a small heading: its name, and how many runs it has
  const runsByLevel = new Map();
  progress.forEach(x => { const k = plLevelKey(x); runsByLevel.set(k, [...(runsByLevel.get(k) || []), x.e]); });
  const withSubheads = (rows, inProgress, sortMode) => {
    if (sortMode !== 'placement') return rows.map(x => rowHtml(x, inProgress)).join('');
    let last = null;
    return rows.map(x => {
      const key = plLevelKey(x);
      let sub = '';
      if (key !== last) {
        last = key;
        const logged = runsByLevel.get(key) || [];
        const n = plRunsNeeded(logged);
        const badge = n
          ? `<span class="pl-sub-runs" title="Fewest runs that together contain every % (${logged.length} logged)">${n} ${n === 1 ? 'run' : 'runs'}</span>`
          : `<span class="pl-sub-runs none" title="${logged.length ? 'These runs don\'t contain every % yet' : 'No runs logged for this level'}">None</span>`;
        sub = `<div class="pl-subhead"><b>${escapeHtml(x.r.name || '—')}</b>${x.r.placement ? `<span class="pl-sub-pos">${escapeHtml(x.r.placement)}</span>` : ''}${badge}</div>`;
      }
      return sub + rowHtml(x, inProgress);
    }).join('');
  };
  const head = (first, inProgress) => `<div class="pl-row pl-head">${[first, 'Level', 'Difficulty', 'Tier', 'AREDL', 'Points', 'Attempts', inProgress ? null : 'Completions', 'Date', 'Physics', 'Version', 'Days since', 'ID', ''].filter(t => t !== null).map(t => `<span>${t}</span>`).join('')}</div>`;
  el.innerHTML = done.length ? head('#') + withSubheads(done, false, appSettings.plSort) + plStatsHtml(done) : '<div class="state">No completed levels yet.</div>';
  // levels you have progress on (under 100%) sit below, on their own
  const wrap = $('#plProgressWrap');
  wrap.hidden = !progress.length;
  $('#plProgressCount').textContent = `(${progress.length})`;
  $('#plProgress').innerHTML = progress.length ? head('Run', true) + withSubheads(progress, true, appSettings.plProgressSort) : '';
}

// Difficulty names and their colours (same set as the Demon difficulty chart)
const PL_DIFFS = {
  'Bizarre Demon': '#a63a1b', 'Brutal Demon': '#9a3216', 'Extreme Demon': '#8e2d13', 'Radical Demon': '#832810',
  'Supreme Demon': '#78230d', 'Ultimate Demon': '#6a1f0b', 'Horrendous Demon': '#5b1a09', 'Inhumane Demon': '#4b0e10',
  'Slaughter Demon': '#3f0f24', 'Apocalyptic Demon': '#35113f', 'Divine Demon': '#2a0f4a', 'Silent Demon': '#1b0a30', 'Infinite Demon': '#000000',
};
const plPhysicsOf = (e) => (e.auto && e.auto.physics === true ? e.version : e.physics) || '';

// ---- the app's own date picker (no browser one) ----
let calOpen = false;
let calPop = null;
function closeCalendar() {
  if (!calPop) return;
  const pop = calPop;
  calPop = null;
  calOpen = false;
  pop.classList.add('closing');
  setTimeout(() => pop.remove(), 140);
  document.removeEventListener('mousedown', calOutside, true);
  document.removeEventListener('keydown', calKey, true);
  window.removeEventListener('blur', closeCalendar);
}
const calOutside = (e) => { if (calPop && !calPop.contains(e.target) && !e.target.closest('#plDateBtn')) closeCalendar(); };
const calKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); closeCalendar(); } };

function openCalendar(anchor, iso, onPick) {
  closeCalendar();
  const sel = iso ? plDate(iso) : null;
  const today = new Date();
  let vy = (sel || today).getFullYear(), vm = (sel || today).getMonth(), view = 'days';
  const pop = document.createElement('div');
  pop.className = 'cal-pop';
  document.body.appendChild(pop);
  calPop = pop;
  calOpen = true;
  const pad = (n) => String(n).padStart(2, '0');
  const isoOf = (y, m, d) => `${y}-${pad(m + 1)}-${pad(d)}`;
  const monthName = (m, long = true) => new Date(2000, m, 1).toLocaleString(undefined, { month: long ? 'long' : 'short' });

  const render = () => {
    if (view === 'days') {
      const lead = (new Date(vy, vm, 1).getDay() + 6) % 7; // weeks start on Monday
      const dim = new Date(vy, vm + 1, 0).getDate();
      const wk = [...Array(7)].map((_, i) => new Date(2024, 0, 1 + i).toLocaleString(undefined, { weekday: 'short' }).slice(0, 2));
      const todayIso = isoOf(today.getFullYear(), today.getMonth(), today.getDate());
      let cells = '';
      for (let i = 0; i < lead; i++) cells += '<span></span>';
      for (let d = 1; d <= dim; d++) {
        const cur = isoOf(vy, vm, d);
        cells += `<button type="button" class="cal-day${iso === cur ? ' sel' : ''}${cur === todayIso ? ' today' : ''}" data-day="${cur}">${d}</button>`;
      }
      pop.innerHTML = `<div class="cal-head"><button type="button" class="cal-nav" data-cal="prev">‹</button><button type="button" class="cal-title" data-cal="months">${escapeHtml(monthName(vm))} ${vy}</button><button type="button" class="cal-nav" data-cal="next">›</button></div>
        <div class="cal-week">${wk.map(w => `<span>${escapeHtml(w)}</span>`).join('')}</div>
        <div class="cal-grid">${cells}</div>
        <div class="cal-foot"><button type="button" class="cal-link" data-cal="today">Today</button><button type="button" class="cal-link" data-cal="clear">Clear</button></div>`;
    } else {
      pop.innerHTML = `<div class="cal-head"><button type="button" class="cal-nav" data-cal="prevyear">‹</button><button type="button" class="cal-title" data-cal="days">${vy}</button><button type="button" class="cal-nav" data-cal="nextyear">›</button></div>
        <div class="cal-months">${[...Array(12)].map((_, m) => `<button type="button" class="cal-month${m === vm ? ' sel' : ''}" data-month="${m}">${escapeHtml(monthName(m, false))}</button>`).join('')}</div>`;
    }
  };
  const place = () => {
    const r = anchor.getBoundingClientRect();
    const w = pop.offsetWidth, hgt = pop.offsetHeight, PAD = 10;
    const below = window.innerHeight - r.bottom - PAD, above = r.top - PAD;
    const flip = hgt > below && above > below;
    pop.style.left = Math.min(Math.max(r.left, PAD), Math.max(PAD, window.innerWidth - w - PAD)) + 'px';
    pop.style.top = Math.min(Math.max(flip ? r.top - hgt - 6 : r.bottom + 6, PAD), Math.max(PAD, window.innerHeight - hgt - PAD)) + 'px';
    pop.classList.toggle('up', flip);
  };
  pop.addEventListener('click', (e) => {
    const day = e.target.closest('[data-day]');
    if (day) { onPick(day.dataset.day); closeCalendar(); return; }
    const mo = e.target.closest('[data-month]');
    if (mo) { vm = Number(mo.dataset.month); view = 'days'; render(); return; }
    const c = e.target.closest('[data-cal]');
    if (!c) return;
    switch (c.dataset.cal) {
      case 'prev': vm--; if (vm < 0) { vm = 11; vy--; } break;
      case 'next': vm++; if (vm > 11) { vm = 0; vy++; } break;
      case 'months': view = 'months'; break;
      case 'days': view = 'days'; break;
      case 'prevyear': vy--; break;
      case 'nextyear': vy++; break;
      case 'today': onPick(isoOf(today.getFullYear(), today.getMonth(), today.getDate())); closeCalendar(); return;
      case 'clear': onPick(''); closeCalendar(); return;
    }
    render();
  });
  render();
  place();
  document.addEventListener('mousedown', calOutside, true);
  document.addEventListener('keydown', calKey, true);
  window.addEventListener('blur', closeCalendar);
}
function plSetDate(iso) {
  plInput('Date').value = iso || '';
  const [y, m, d] = iso ? String(iso).split('-') : ['', '', ''];
  plInput('Day').value = d || '';
  plInput('Month').value = m || '';
  plInput('Year').value = y || '';
}
// rebuild the ISO date from the three boxes (empty unless it's a real date)
function plSegChanged() {
  const d = Number(plInput('Day').value), m = Number(plInput('Month').value), y = Number(plInput('Year').value);
  let iso = '';
  if (plInput('Day').value && plInput('Month').value && plInput('Year').value.length === 4) {
    const t = new Date(y, m - 1, d);
    if (t.getFullYear() === y && t.getMonth() === m - 1 && t.getDate() === d) iso = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  }
  plInput('Date').value = iso;
  plInput('Day').parentElement.classList.toggle('bad', !iso && !!(plInput('Day').value || plInput('Month').value || plInput('Year').value));
}
['Day', 'Month', 'Year'].forEach((K, idx, all) => {
  const inp = plInput(K);
  const max = K === 'Year' ? 9999 : (K === 'Month' ? 12 : 31), len = K === 'Year' ? 4 : 2;
  inp.addEventListener('input', () => {
    inp.value = inp.value.replace(/\D/g, '').slice(0, len);
    // a number that can't get any bigger jumps to the next box
    if (idx < 2 && (inp.value.length === len || (inp.value.length === 1 && Number(inp.value) * 10 > max))) plInput(all[idx + 1]).focus();
    plSegChanged();
  });
  inp.addEventListener('keydown', (e) => {
    if (e.key === 'Backspace' && !inp.value && idx > 0) { e.preventDefault(); plInput(all[idx - 1]).focus(); }
    else if (e.key === 'ArrowLeft' && inp.selectionStart === 0 && idx > 0) { e.preventDefault(); plInput(all[idx - 1]).focus(); }
    else if (e.key === 'ArrowRight' && inp.selectionStart === inp.value.length && idx < 2) { e.preventDefault(); plInput(all[idx + 1]).focus(); }
    else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault();
      const cur = Number(inp.value) || (K === 'Year' ? new Date().getFullYear() : 0);
      const next = Math.min(max, Math.max(K === 'Year' ? 1000 : 1, cur + (e.key === 'ArrowUp' ? 1 : -1)));
      inp.value = String(next).padStart(len, '0');
      plSegChanged();
    }
  });
  inp.addEventListener('focus', () => inp.select());
  inp.addEventListener('blur', () => { if (K !== 'Year' && inp.value.length === 1) { inp.value = inp.value.padStart(2, '0'); plSegChanged(); } });
});
$('#plDateBtn').addEventListener('click', () => {
  if (calPop) { closeCalendar(); return; }
  openCalendar($('#plDateField'), plInput('Date').value, plSetDate);
});

// ---- add / edit form ----
const PL_AUTO = [['Name', 'name'], ['Id', 'id'], ['Placement', 'placement'], ['Tier', 'tier'], ['Points', 'points']];
function plInput(k) { return document.getElementById('pl' + k); } // (a declaration, so the date boxes below can use it at load time)

// what each Auto field would be, from the picked level
function plAutoValues(l) {
  if (!l) return { name: '', id: '', placement: '', tier: '', points: '' };
  return {
    name: l.name || '',
    id: l.level_id != null ? String(l.level_id) : '',
    placement: l.position != null ? `Top ${l.position}` : (l.status ? levelStatusLabel({ status: l.status, position: null }) : ''),
    tier: l.gddl_tier != null ? Number(l.gddl_tier).toFixed(2) : '',
    points: l.points != null ? formatPoints(l.points) : '',
  };
}
// fields on Auto show the list's value (and are locked); fields off Auto keep what you typed
function plSyncAuto() {
  const vals = plAutoValues(plPicked);
  PL_AUTO.forEach(([K, k]) => {
    const on = plInput('Auto' + K).checked;
    const inp = plInput(K);
    if (on) inp.value = vals[k];
    inp.disabled = on;
  });
}
// Physics follows the Version box (with "Phys" shown after it) while its Auto switch is on
function plSyncPhysics() {
  const on = plInput('AutoPhysics').checked;
  const inp = plInput('Physics');
  if (on) inp.value = plInput('Version').value.trim();
  inp.disabled = on;
}
// Under 100%: it isn't completed, so Completions is blanked and the date is the date of the run
function plSyncPercent() {
  const run = plParseRun(plInput('Percent').value);
  const partial = plIsRun(run);
  plInput('Percent').classList.toggle('bad', !run);
  const clears = plInput('Clears');
  clears.disabled = partial;
  if (partial) clears.value = ''; else if (!clears.value) clears.value = '1';
  $('#plDateLabel').textContent = partial ? 'Date of run' : 'Date completed';
}
function plRenderChosen() {
  const el = $('#plChosen');
  el.innerHTML = plPicked
    ? `<span class="pos">${plPicked.position != null ? `#${plPicked.position}` : '—'}</span><strong>${escapeHtml(plPicked.name || '')}</strong><span class="id">${escapeHtml(String(plPicked.level_id ?? ''))}</span>`
    : '<span class="dim">No level chosen yet - search above.</span>';
}
function plRenderResults() {
  const box = $('#plLevelResults');
  const q = $('#plLevelSearch').value.trim().toLowerCase();
  if (!state.levels.length) { box.innerHTML = '<div class="dim" style="padding:10px;">The level list hasn\'t loaded yet.</div>'; box.hidden = false; return; }
  const list = (q ? state.levels.filter(l => (l.name || '').toLowerCase().includes(q) || String(l.level_id).includes(q)) : state.levels).slice(0, 8);
  box.innerHTML = list.length
    ? list.map(l => `<button type="button" class="pl-result" data-pl-pick="${escapeHtml(String(l.level_id))}"><span class="pos">${l.position != null ? `#${l.position}` : '—'}</span><span class="nm">${escapeHtml(l.name)}</span><span class="id">${escapeHtml(String(l.level_id))}</span></button>`).join('')
    : '<div class="dim" style="padding:10px;">No level matches that.</div>';
  box.hidden = false;
}
function plPick(l) {
  plPicked = l;
  $('#plLevelSearch').value = '';
  $('#plLevelResults').hidden = true;
  plRenderChosen();
  plSyncAuto();
}

function plOpen(entry) {
  plEditingId = entry ? entry.id : null;
  plDeleteArmed = false;
  $('#plModalTitle').textContent = entry ? 'Edit entry' : 'Add level';
  const del = $('#plDelete');
  del.hidden = !entry;
  del.textContent = 'Delete';
  const live = entry ? plLive(entry) : null;
  plPicked = entry ? (live || entry.snap || { name: entry.snap?.name, level_id: entry.level_id }) : null;
  const auto = (entry && entry.auto) || {}, man = (entry && entry.manual) || {};
  PL_AUTO.forEach(([K, k]) => {
    plInput('Auto' + K).checked = auto[k] !== false;
    plInput(K).value = auto[k] === false ? (man[k] ?? '') : '';
  });
  plInput('Difficulty').value = entry?.difficulty || '';
  plInput('Attempts').value = entry?.attempts ?? '';
  plInput('Version').value = entry?.version || appSettings.plLastVersion || '';
  plInput('AutoPhysics').checked = entry ? (entry.auto && entry.auto.physics === true) : true;
  plInput('Physics').value = entry && !(entry.auto && entry.auto.physics === true) ? (entry.physics || '') : '';
  plSyncPhysics();
  plInput('Percent').value = entry ? plRunInput(entry) : 100;
  plInput('Clears').value = entry?.completions ?? 1;
  plSyncPercent();
  plSetDate(entry ? (entry.date || '') : new Date().toISOString().slice(0, 10));
  plInput('Video').value = entry?.video || '';
  $('#plLevelSearch').value = '';
  $('#plLevelResults').hidden = true;
  plRenderChosen();
  plSyncAuto();
  const m = $('#plModal');
  m.hidden = false;
  requestAnimationFrame(() => { m.classList.add('open'); if (!entry) $('#plLevelSearch').focus(); });
}
function plClose() {
  const m = $('#plModal');
  m.classList.remove('open');
  setTimeout(() => { if (!m.classList.contains('open')) m.hidden = true; }, 180);
}

async function plSave() {
  const auto = {}, manual = {};
  PL_AUTO.forEach(([K, k]) => {
    auto[k] = plInput('Auto' + K).checked;
    if (!auto[k]) manual[k] = plInput(K).value.trim();
  });
  auto.physics = plInput('AutoPhysics').checked; // Physics follows Version
  if ((plInput('Day').value || plInput('Month').value || plInput('Year').value) && !plInput('Date').value) { showToast('That date isn\'t complete or valid'); return; }
  const run = plParseRun(plInput('Percent').value);
  if (!run) { showToast('Progress should be like 100, 79 or a run such as 53-79'); return; }
  if (!plPicked && auto.name !== false) { showToast('Choose a level first'); return; }
  if (auto.name === false && !manual.name) { showToast('Type a name or switch Auto back on'); return; }
  const num = (v) => (v === '' || v == null || Number.isNaN(Number(v)) ? null : Number(v));
  const entry = {
    id: plEditingId || (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2)),
    level_id: plPicked?.level_id ?? (manual.id || null),
    snap: plPicked ? plSnap(plPicked) : { name: manual.name },
    auto, manual,
    difficulty: plInput('Difficulty').value.trim(),
    attempts: num(plInput('Attempts').value) != null ? Math.max(0, Math.round(num(plInput('Attempts').value))) : null,
    physics: plInput('AutoPhysics').checked ? plInput('Version').value.trim() : plInput('Physics').value.trim(),
    version: plInput('Version').value.trim(),
    completions: plIsRun(run) ? null : Math.max(1, num(plInput('Clears').value) || 1),
    percent: run.end,
    startPercent: run.start,
    date: plInput('Date').value || '',
    video: plInput('Video').value.trim(),
  };
  const i = personalList.findIndex(x => x.id === entry.id);
  if (i >= 0) personalList[i] = entry; else personalList.push(entry);
  // remember the last physics / version typed, as the starting point for the next entry
  if (entry.version) setSetting('plLastVersion', entry.version);
  if (!(await savePersonal())) return; // the toast already says why; keep the window open so nothing is lost
  renderPersonal();
  plClose();
  showToast(i >= 0 ? 'Entry updated' : 'Level added');
}

function plCsv() {
  const q = (v) => { const t = String(v ?? ''); return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t; };
  const head = ['#', 'Level', 'Difficulty', 'Tier', 'AREDL Placement', 'Points', 'Attempts', 'Completions', 'Progress %', 'Date', 'Physics', 'Version', 'Days Since', 'ID', 'Video'];
  const line = (rank, { e, r }, completions, progress) => [
    rank, r.name, e.difficulty, r.tier != null ? r.tier.toFixed(2) : '', r.placement, r.points, e.attempts ?? '',
    completions, progress, plFmtDate(e.date), plPhysicsOf(e), e.version, plDaysSince(e.date) ?? '', r.id, e.video,
  ].map(q).join(',');
  const lines = [head.join(',')];
  // "#" is the hardest-first rank, with (CH) for the current hardest and (H) for "was the hardest when beaten"
  plSorted().forEach(row => lines.push(line(`${row.rank}${row.rank === 1 ? ' (CH)' : (row.hardest ? ' (H)' : '')}`, row, row.e.completions ?? 1, 100)));
  plProgressRows().forEach(row => lines.push(line('', row, '', plRunInput(row.e))));
  return lines.join('\n');
}

$('#plAddBtn').addEventListener('click', async () => { await loadPersonal(); plOpen(null); });
$('#plCopyBtn').addEventListener('click', () => { if (!personalList.length) { showToast('Nothing to copy yet'); return; } copyText(plCsv(), 'List as CSV'); });
$('#plSort').addEventListener('change', () => { setSetting('plSort', $('#plSort').value); renderPersonal(); });
$('#plProgressSort').addEventListener('change', () => { setSetting('plProgressSort', $('#plProgressSort').value); renderPersonal(); });
$('#plModalClose').addEventListener('click', plClose);
$('#plCancel').addEventListener('click', plClose);
$('#plSave').addEventListener('click', plSave);
$('#plModal').addEventListener('mousedown', (e) => { if (e.target === $('#plModal')) plClose(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('#plModal').hidden && !calOpen) plClose(); });
$('#plModal').addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' || e.isComposing) return;
  const t = e.target;
  if (t.tagName === 'INPUT' && t.type !== 'checkbox' && t.id !== 'plLevelSearch') { e.preventDefault(); plSave(); }
});
$('#plLevelSearch').addEventListener('input', plRenderResults);
$('#plLevelSearch').addEventListener('focus', plRenderResults);
$('#plLevelResults').addEventListener('click', (e) => {
  const b = e.target.closest('[data-pl-pick]');
  if (!b) return;
  const l = state.levels.find(x => String(x.level_id) === b.dataset.plPick);
  if (l) plPick(l);
});
PL_AUTO.forEach(([K]) => plInput('Auto' + K).addEventListener('change', plSyncAuto));
plInput('AutoPhysics').addEventListener('change', plSyncPhysics);
plInput('Percent').addEventListener('input', plSyncPercent);
plInput('Version').addEventListener('input', plSyncPhysics);
$('#plDelete').addEventListener('click', async () => {
  if (!plDeleteArmed) { plDeleteArmed = true; $('#plDelete').textContent = 'Click again to delete'; return; }
  personalList = personalList.filter(x => x.id !== plEditingId);
  await savePersonal();
  renderPersonal();
  plClose();
  showToast('Entry deleted');
});
// Both tables (completed + in progress) share the same behaviour:
//  - the pencil opens the entry for editing
//  - click a stat to copy it; the figure itself briefly reads "Copied"
function plBindTable(el) {
  el.addEventListener('click', (e) => {
    const editBtn = e.target.closest('button[data-pl-edit]');
    if (editBtn) {
      const entry = personalList.find(x => x.id === editBtn.dataset.plEdit);
      if (entry) plOpen(entry);
      return;
    }
    const cellEl = e.target.closest('.pl-cell.copyable');
    if (!cellEl || cellEl._copying) return;
    copyText(cellEl.dataset.copy, cellEl.dataset.copyLabel, { silent: true });
    cellEl._copying = true;
    const original = cellEl.innerHTML;
    cellEl.textContent = 'Copied';
    cellEl.classList.add('copied');
    setTimeout(() => { cellEl.innerHTML = original; cellEl.classList.remove('copied'); cellEl._copying = false; }, 900);
  });
}
plBindTable($('#plTable'));
plBindTable($('#plProgress'));

// ---------------------------------------------------------------------------
// Leaderboard (/aredl/leaderboard) - one page at a time, 50 players per page
// ---------------------------------------------------------------------------
const lbState = { page: 1, data: null, loading: false, error: null };

async function loadLeaderboard(page = lbState.page) {
  lbState.loading = true;
  lbState.error = null;
  renderLeaderboard();
  try {
    lbState.data = await window.aredl.getLeaderboard(page);
    lbState.page = page;
  } catch (err) {
    lbState.error = errMsg(err);
  }
  lbState.loading = false;
  renderLeaderboard();
}

function renderLeaderboard() {
  const table = $('#lbTable');
  const d = lbState.data;
  if (lbState.loading && !d) { table.innerHTML = '<div class="state"><div class="spinner"></div>Loading…</div>'; return; }
  if (lbState.error && !d) { table.innerHTML = `<div class="state error">Couldn't load the leaderboard (${escapeHtml(lbState.error)}).</div>`; return; }
  if (!d) return;
  const all = Array.isArray(d) ? d : (d.data || d.items || []);
  const q = ($('#lbSearch').value || '').trim().toLowerCase();
  const rows = q ? all.filter(r => (personName(r.user) || '').toLowerCase().includes(q) || String(r.user && r.user.username || '').toLowerCase().includes(q)) : all;
  const pages = d.pages || 1, per = d.per_page || all.length || 50;
  $('#lbCount').textContent = d.count != null ? `(${Number(d.count).toLocaleString()} players)` : '';
  const when = d.last_refreshed && new Date(d.last_refreshed).getFullYear() > 1971 ? ` · updated ${formatRelativeTime(new Date(d.last_refreshed))}` : '';
  $('#lbInfo').textContent = `Page ${lbState.page} of ${pages}${when}${lbState.error ? ` · ${lbState.error}` : ''}`;

  const hardestName = (h) => (h && typeof h === 'object') ? (h.name || (h.level && h.level.name) || '') : (h || '');
  const clanLabel = (c) => (c && typeof c === 'object') ? (c.tag || c.name || c.global_name || '') : (c || '');
  const head = ['#', 'Player', 'Points', 'Pack points', 'Extremes', 'Hardest', 'Clan', 'Other ranks'];
  const body = rows.map(r => {
    const u = r.user || {};
    const rank = r.rank ?? 0;
    const cls = rank === 1 ? ' rank1' : rank === 2 ? ' rank2' : rank === 3 ? ' rank3' : '';
    const av = avatarUrl(u);
    const clan = clanLabel(r.clan);
    return `<div class="lb-row${cls}">
      <span class="lb-rank"><b class="rank-badge">${rank || '—'}</b></span>
      <span class="lb-player">
        ${av ? `<img class="lb-avatar" src="${escapeHtml(av)}" alt="" loading="lazy">` : '<span class="lb-avatar ph"></span>'}
        <span class="lb-flag">${countryFlagHtml(r.country ?? u.country, 18)}</span>
        <a href="#" class="level-link" data-lookup-publisher="${escapeHtml(String(u.id || ''))}">${escapeHtml(personName(u) || 'Unknown')}</a>
      </span>
      <span class="lb-num strong">${escapeHtml(formatPoints(r.total_points))}</span>
      <span class="lb-num dim">${escapeHtml(formatPoints(r.pack_points))}</span>
      <span class="lb-num">${Number(r.extremes || 0).toLocaleString()}</span>
      <span class="lb-text">${escapeHtml(hardestName(r.hardest) || '—')}</span>
      <span class="lb-text">${clan ? `<span class="lb-clan">${escapeHtml(clan)}</span>` : '—'}</span>
      <span class="lb-ranks">
        <span class="fav-pill" data-tip="Extremes rank">E ${r.extremes_rank || '—'}</span>
        <span class="fav-pill" data-tip="Raw rank">R ${r.raw_rank || '—'}</span>
        <span class="fav-pill" data-tip="Hardest rank">H ${r.hardest_rank || '—'}</span>
        ${r.country_rank ? `<span class="fav-pill" data-tip="Rank in their country">C ${r.country_rank}</span>` : ''}
      </span>
    </div>`;
  }).join('');
  table.innerHTML = `<div class="lb-row lb-head">${head.map(t => `<span>${t}</span>`).join('')}</div>${body || '<div class="state">No players match.</div>'}`;

  const p = lbState.page;
  $('#lbPager').innerHTML = pages > 1
    ? `<button class="btn btn-ghost" data-lb-page="1" ${p <= 1 ? 'disabled' : ''} title="First page" aria-label="First page">«</button>
       <button class="btn btn-ghost" data-lb-page="${p - 1}" ${p <= 1 ? 'disabled' : ''}>‹ Previous</button>
       <span class="lb-page-info">Page
         <input class="lb-page-input" id="lbPageInput" type="number" min="1" max="${pages}" value="${p}" aria-label="Go to page">
         / ${pages} · ${per} per page</span>
       <button class="btn btn-ghost" id="lbGoBtn" title="Go to that page">Go</button>
       <button class="btn btn-ghost" data-lb-page="${p + 1}" ${p >= pages ? 'disabled' : ''}>Next ›</button>
       <button class="btn btn-ghost" data-lb-page="${pages}" ${p >= pages ? 'disabled' : ''} title="Last page" aria-label="Last page">»</button>`
    : '';
  lbState.pages = pages;
}
$('#lbSearch').addEventListener('input', renderLeaderboard);
$('#lbRefreshBtn').addEventListener('click', () => loadLeaderboard(lbState.page));
$('#lbPager').addEventListener('click', (e) => {
  const b = e.target.closest('[data-lb-page]');
  if (b && !b.disabled) loadLeaderboard(Number(b.dataset.lbPage));
  else if (e.target.closest('#lbGoBtn')) lbGoToTyped();
});
$('#lbPager').addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.id === 'lbPageInput') lbGoToTyped(); });
function lbGoToTyped() {
  const n = Math.round(Number($('#lbPageInput').value));
  if (!Number.isFinite(n)) return;
  const page = Math.min(Math.max(n, 1), lbState.pages || n);
  if (page !== lbState.page) loadLeaderboard(page); else $('#lbPageInput').value = page;
}

// ---------------------------------------------------------------------------
// Context menu
//
// To add an option to the right-click menu on levels, push one more item
// onto the array returned by levelMenuItems() below:
//   { label: 'Text shown', onClick: () => { ... } }
// Optional: `danger: true` for a red item, and `separator: true` (alone) for
// a divider line. To give a different kind of thing its own menu, build an
// items array the same way and call showContextMenu(x, y, items).
// ---------------------------------------------------------------------------
function levelMenuItems(level) {
  const fav = isFavourite(level.level_id);
  return [
    { label: 'Copy AREDL link', onClick: () => copyText(`https://aredl.net/list/${level.level_id}`, 'AREDL link') },
    { label: 'Copy level ID', onClick: () => copyText(level.level_id, 'Level ID') },
    { label: 'Open in AREDL', onClick: () => window.open(`https://aredl.net/list/${level.level_id}`, '_blank', 'noopener') },
    { label: 'Search on YouTube', onClick: () => window.open(youtubeSearchUrl(level.name), '_blank', 'noopener') },
    { separator: true },
    { label: fav ? 'Remove from favourites' : 'Add to favourites', onClick: () => toggleFavourite(level) },
    { label: isFollowing(level.level_id) ? 'Unfollow level' : 'Follow level', onClick: () => toggleFollow(level) },
  ];
}

function hideContextMenu() {
  const m = document.getElementById('ctxMenu');
  if (!m) return;
  m.id = ''; // free the id right away; the old menu just finishes its closing animation
  m.classList.add('closing');
  setTimeout(() => m.remove(), 140);
}

function showContextMenu(x, y, items) {
  hideContextMenu();
  const menu = document.createElement('div');
  menu.id = 'ctxMenu';
  menu.className = 'ctx-menu';
  items.forEach(item => {
    if (item.separator) {
      const sep = document.createElement('div');
      sep.className = 'ctx-sep';
      menu.appendChild(sep);
      return;
    }
    const btn = document.createElement('button');
    btn.className = 'ctx-item' + (item.danger ? ' danger' : '');
    if (item.color) {
      const dot = document.createElement('i');
      dot.className = 'ctx-dot';
      dot.style.background = item.color;
      btn.appendChild(dot);
    }
    btn.appendChild(document.createTextNode(item.label));
    if (item.checked) {
      const tick = document.createElement('span');
      tick.className = 'ctx-tick';
      tick.textContent = '✓';
      btn.appendChild(tick);
    }
    btn.addEventListener('click', () => {
      hideContextMenu();
      item.onClick();
    });
    menu.appendChild(btn);
  });
  document.body.appendChild(menu);
  // keep it fully on screen
  menu.style.maxHeight = (window.innerHeight - 20) + 'px';
  const r = { width: menu.offsetWidth, height: menu.offsetHeight }; // layout size, not the animated (scaled) box
  menu.style.left = Math.max(10, Math.min(x, window.innerWidth - r.width - 10)) + 'px';
  menu.style.top = Math.max(10, Math.min(y, window.innerHeight - r.height - 10)) + 'px';
}

document.addEventListener('contextmenu', (e) => {
  const row = e.target.closest('.list-row, .fav-card, .follow-card');
  if (!row) { hideContextMenu(); return; }
  const level = state.levels.find(l => String(l.level_id) === String(row.dataset.levelId));
  const levelId = row.dataset.levelId;
  e.preventDefault();
  // Favourites can still be managed before/without the full list being loaded.
  const target = level || { level_id: levelId, name: (state.favourites.find(f => String(f.level_id) === String(levelId)) || {}).name || '' };
  showContextMenu(e.clientX, e.clientY, levelMenuItems(target));
});
document.addEventListener('mousedown', (e) => { if (!e.target.closest('#ctxMenu')) hideContextMenu(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') hideContextMenu(); });
window.addEventListener('blur', hideContextMenu);
window.addEventListener('resize', hideContextMenu);
document.addEventListener('scroll', hideContextMenu, true);

// Click-to-copy values (Level ID, Song ID in the level info block)
document.addEventListener('click', (e) => {
  const el = e.target.closest('.copyable');
  if (el && !el.classList.contains('pl-cell')) copyText(el.dataset.copy, el.dataset.copyLabel);
});

$('#list').addEventListener('click', (e) => {
  const row = e.target.closest('.list-row');
  if (!row) return;
  const level = state.levels.find(l => String(l.id) === row.dataset.id);
  if (!level) return;
  if (e.ctrlKey || e.metaKey) toggleMultiSelect(level);
  else selectLevel(level);
});

document.addEventListener('click', (e) => {
  const link = e.target.closest('[data-lookup-publisher]');
  if (link) {
    e.preventDefault();
    showTab('profile');
    $('#profileLookup').value = link.dataset.lookupPublisher;
    lookupProfile(link.dataset.lookupPublisher);
  }
});

// The blurred backdrop follows the last level you looked at and stays put
// while you move between tabs. It only changes when a new level's video loads.
// ---- Adaptive Glass: the accent colour follows the backdrop ----
let currentBgVid = null;
const adaptiveCache = new Map();
const ADAPTIVE_DEFAULT = '#7dd3fc';

function rgbToHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2;
  let h = 0, s = 0;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
    h /= 6;
  }
  return [h, s, l];
}
function hslToHex(h, s, l) {
  const f = (n) => {
    const k = (n + h * 12) % 12;
    const a = s * Math.min(l, 1 - l);
    return Math.round(255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))));
  };
  return '#' + [f(0), f(8), f(4)].map(v => v.toString(16).padStart(2, '0')).join('');
}
const srgbToLin = (v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
const linToSrgb = (v) => Math.round(255 * Math.min(1, Math.max(0, v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055)));
const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);

// Reads the thumbnail and works out two colours: `accent` (theme colour) and `tint` (what the glass leans towards).
//  gamma: average of the whole picture done in linear light (the physically right way to mix colours),
//         then toned down so it never gets garish
//  vivid: the single punchiest colour in the picture (the original method)
function thumbnailColours(vid) {
  const method = appSettings.adaptiveMethod === 'vivid' ? 'vivid' : 'gamma';
  const key = `${method}:${vid}`;
  if (adaptiveCache.has(key)) return Promise.resolve(adaptiveCache.get(key));
  return new Promise(resolve => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      try {
        const c = document.createElement('canvas');
        c.width = 48; c.height = 36;
        const g = c.getContext('2d', { willReadFrequently: true });
        g.drawImage(img, 0, 0, 48, 36);
        const d = g.getImageData(0, 0, 48, 36).data;
        let out = null;
        if (method === 'vivid') {
          let rs = 0, gs = 0, bs = 0, wsum = 0;
          for (let i = 0; i < d.length; i += 4) {
            const [, sat, lum] = rgbToHsl(d[i], d[i + 1], d[i + 2]);
            if (lum < 0.08 || lum > 0.95) continue;
            const w = sat * Math.min(lum, 1 - lum) * 2;
            rs += d[i] * w; gs += d[i + 1] * w; bs += d[i + 2] * w; wsum += w;
          }
          if (wsum >= 0.5) {
            let [h, sat, lum] = rgbToHsl(rs / wsum, gs / wsum, bs / wsum);
            const hex = hslToHex(h, Math.max(sat, 0.62), clamp(lum, 0.6, 0.72));
            out = { accent: hex, tint: hex };
          }
        } else {
          let lr = 0, lg = 0, lb = 0, n = 0;
          for (let i = 0; i < d.length; i += 4) { lr += srgbToLin(d[i]); lg += srgbToLin(d[i + 1]); lb += srgbToLin(d[i + 2]); n++; }
          const [h, sat, lum] = rgbToHsl(linToSrgb(lr / n), linToSrgb(lg / n), linToSrgb(lb / n));
          // toned down: moderate saturation, and a lightness that's readable but never glaring
          out = {
            accent: hslToHex(h, clamp(sat * 0.9, 0.34, 0.6), clamp(lum + 0.22, 0.58, 0.68)),
            tint: hslToHex(h, clamp(sat, 0.3, 0.62), clamp(lum + 0.1, 0.3, 0.46)),
          };
        }
        if (out) adaptiveCache.set(key, out);
        resolve(out);
      } catch { resolve(null); } // image not readable (cross-origin) - keep the default
    };
    img.onerror = () => resolve(null);
    img.src = `https://i.ytimg.com/vi/${vid}/hqdefault.jpg`;
  });
}
// text colour that reads on top of the accent colour
function onAccentFor(hex) {
  const n = parseInt(hex.slice(1), 16);
  const lum = (0.2126 * (n >> 16) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255)) / 255;
  return lum > 0.58 ? '#0b0e16' : '#ffffff';
}
function setAccentColour(accent, tint) {
  const root = document.documentElement.style;
  root.setProperty('--accent', accent);
  root.setProperty('--accent-soft', hexToRgba(accent, 0.14));
  root.setProperty('--accent-soft2', hexToRgba(accent, 0.28));
  root.setProperty('--on-accent', onAccentFor(accent));
  root.setProperty('--tint', tint || accent);
}
async function adaptAccent(vid) {
  if (!state.adaptive) return;
  if (!vid) { setAccentColour(ADAPTIVE_DEFAULT, ADAPTIVE_DEFAULT); return; }
  const cols = await thumbnailColours(vid);
  if (state.adaptive && vid === currentBgVid) setAccentColour(cols ? cols.accent : ADAPTIVE_DEFAULT, cols ? cols.tint : ADAPTIVE_DEFAULT);
}

// "Glass tint" slider (0-100) -> how much of the backdrop colour the glass mixes in (0-45%)
// Background blur: unset = the theme's own default (60px, 54px on the Glass themes).
function bgBlurDefault() { return document.body.classList.contains('glassy') ? 54 : 60; }
function applyBgBlur() {
  const custom = Number.isFinite(appSettings.bgBlur) ? appSettings.bgBlur : null;
  if (custom == null) document.body.style.removeProperty('--bg-blur');
  else document.body.style.setProperty('--bg-blur', custom + 'px');
  const slider = document.getElementById('bgBlurSlider');
  if (!slider) return;
  const eff = custom == null ? bgBlurDefault() : custom;
  slider.dataset.default = String(bgBlurDefault());
  slider.value = eff;
  $('#bgBlurOut').textContent = custom == null || custom === bgBlurDefault() ? `${eff}px · default` : `${eff}px`;
  $('#bgBlurReset').disabled = custom == null;
}
$('#bgBlurSlider').addEventListener('input', () => {
  const v = Number($('#bgBlurSlider').value);
  setSetting('bgBlur', v === bgBlurDefault() ? null : v);
  applyBgBlur();
});
$('#bgBlurReset').addEventListener('click', () => { setSetting('bgBlur', null); applyBgBlur(); });

function applyGlassTint() {
  const v = Number.isFinite(appSettings.adaptiveTint) ? appSettings.adaptiveTint : 30;
  document.body.style.setProperty('--glass-tint', (v * 0.45).toFixed(1) + '%');
  const out = document.getElementById('adaptiveTintOut');
  if (out) out.textContent = `${v}%`;
}
function setSelectDisabled(sel, disabled) {
  sel.disabled = disabled;
  const btn = sel.parentElement && sel.parentElement.querySelector('.dd-btn');
  if (btn) btn.disabled = disabled;
}
// The Adaptive Glass controls only do anything while that theme is selected.
function updateAdaptiveControls() {
  const on = !!state.adaptive;
  const box = document.getElementById('adaptiveCard');
  if (!box) return;
  box.classList.toggle('disabled', !on);
  $('#adaptiveTint').disabled = !on;
  setSelectDisabled($('#adaptiveMethod'), !on);
}
$('#adaptiveTint').addEventListener('input', () => {
  setSetting('adaptiveTint', Number($('#adaptiveTint').value));
  applyGlassTint();
});
$('#adaptiveMethod').addEventListener('change', () => {
  setSetting('adaptiveMethod', $('#adaptiveMethod').value);
  adaptAccent(currentBgVid);
});

let bgFront = 0, bgToken = 0, bgShownVid = null;
function setPageBackground(vid) {
  currentBgVid = vid || null;
  adaptAccent(currentBgVid);
  const layers = [document.getElementById('pageBg'), document.getElementById('pageBg2')];
  if (!layers[0] || !layers[1]) return;
  if (!vid) {
    bgToken++;
    bgShownVid = null;
    layers.forEach(l => l.classList.remove('on'));
    return;
  }
  if (vid === bgShownVid) return; // already showing this picture
  const token = ++bgToken;
  const url = `https://img.youtube.com/vi/${vid}/hqdefault.jpg`;
  // load the picture first, then fade it in over the old one - no blank flash while it downloads
  const img = new Image();
  img.onload = () => {
    if (token !== bgToken) return; // a newer level was chosen meanwhile
    const next = layers[1 - bgFront], prev = layers[bgFront];
    next.style.backgroundImage = `url(${url})`;
    next.classList.add('on');
    prev.classList.remove('on');
    bgFront = 1 - bgFront;
    bgShownVid = vid;
  };
  img.src = url;
}

const STAR_PATH = 'M10 2.2l2.4 5 5.4.7-4 3.8 1 5.4L10 14.5 5.2 17.1l1-5.4-4-3.8 5.4-.7z';
function bellSvg(cls) {
  return `<svg class="${cls}" viewBox="0 0 20 20" stroke-linejoin="round" stroke-linecap="round"><path d="M5.5 8a4.5 4.5 0 0 1 9 0c0 4 1.5 5 1.5 5H4s1.5-1 1.5-5Z"/><path d="M8.5 16a1.7 1.7 0 0 0 3 0" fill="none"/></svg>`;
}
function starSvg(cls) {
  return `<svg class="${cls}" viewBox="0 0 20 20" stroke-linejoin="round"><path d="${STAR_PATH}"/></svg>`;
}

// Icon buttons next to the level name: copy / open the AREDL page, search YouTube.
// The video area is the same element in the single-level view and the level-range
// view: entering a range just switches it to "multi" in place, so an iframe that is
// already playing isn't torn down and reloaded (that was the lag spike).
function videoStageHtml(multi) {
  return `<div class="video-stage${multi ? ' multi' : ''}" id="videoStage">
    <button class="multi-nav" data-multi-nav="-1" title="Previous level" aria-label="Previous level">&lt;</button>
    <div id="panelVideoZone"${multi ? ' class="multi-video-zone"' : ''}></div>
    <button class="multi-nav" data-multi-nav="1" title="Next level" aria-label="Next level">&gt;</button>
    <div class="multi-caption" id="multiCaption"></div>
  </div>`;
}

function youtubeSearchUrl(name) {
  return 'https://www.youtube.com/results?search_query=' + String(name || '').trim().split(/\s+/).map(encodeURIComponent).join('+') + '+gd';
}
function levelToolsHtml(level, { follow = false } = {}) {
  const id = level.level_id;
  const yt = youtubeSearchUrl(level.name);
  const icon = (d) => `<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
  const followBtn = follow && id != null
    ? `<button class="icon-tool follow-btn${isFollowing(id) ? ' active' : ''}" data-tip="${isFollowing(id) ? 'Unfollow level' : 'Follow level'}" data-follow-toggle="${escapeHtml(String(id))}" aria-label="Follow level">${icon('<path d="M5.5 8a4.5 4.5 0 0 1 9 0c0 4 1.5 5 1.5 5H4s1.5-1 1.5-5Z"/><path d="M8.5 16a1.7 1.7 0 0 0 3 0"/>')}</button>`
    : '';
  return `<span class="title-tools">
    ${followBtn}
    ${id != null ? `<button class="icon-tool" data-tip="Copy AREDL link" data-copy-aredl="${escapeHtml(String(id))}" aria-label="Copy AREDL link">${icon('<path d="M8.5 11.5a3.2 3.2 0 0 0 4.5 0l2.6-2.6a3.2 3.2 0 0 0-4.5-4.5l-.9.9"/><path d="M11.5 8.5a3.2 3.2 0 0 0-4.5 0l-2.6 2.6a3.2 3.2 0 0 0 4.5 4.5l.9-.9"/>')}</button>
    <a class="icon-tool" data-tip="Open in AREDL" href="https://aredl.net/list/${escapeHtml(String(id))}" target="_blank" rel="noopener" aria-label="Open in AREDL">${icon('<path d="M11 4h5v5"/><path d="M16 4l-7 7"/><path d="M14 11.5V15a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h3.5"/>')}</a>` : ''}
    <a class="icon-tool" data-tip="Search on YouTube" href="${escapeHtml(yt)}" target="_blank" rel="noopener" aria-label="Search on YouTube">${icon('<rect x="2.5" y="5" width="15" height="10" rx="3"/><path d="M8.5 7.8v4.4l3.8-2.2z" fill="currentColor"/>')}</a>
  </span>`;
}
document.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-copy-aredl]');
  if (btn) copyText(`https://aredl.net/list/${btn.dataset.copyAredl}`, 'AREDL link');
});

// The number copies on click; the ↗ stays a separate link to Newgrounds.
function songHtmlFor(level) {
  if (level.song == null) return '—';
  if (level.song < 0) return 'DEFAULT';
  return `<span class="copyable" data-copy="${escapeHtml(level.song)}" data-copy-label="Song ID" title="Click to copy">${escapeHtml(level.song)}</span> <a class="song-link" href="https://www.newgrounds.com/audio/listen/${level.song}" target="_blank" rel="noopener" title="Open on Newgrounds">↗</a>`;
}
function levelIdHtmlFor(level) {
  return level.level_id == null ? '—' : `<span class="copyable" data-copy="${escapeHtml(level.level_id)}" data-copy-label="Level ID" title="Click to copy">${escapeHtml(level.level_id)}</span>`;
}
function gddlText(level) { return level.gddl_tier != null ? String(Math.round(level.gddl_tier * 10) / 10) : '—'; }
function enjText(level) { return level.edel_enjoyment != null ? Math.round(level.edel_enjoyment) + '%' : '—'; }

// ---- Level names inside descriptions become links (checked against the loaded list only) ----
let levelIndexCache = { src: null };
function levelNameIndex() {
  if (levelIndexCache.src === state.levels) return levelIndexCache;
  const norm = (str) => String(str).toLowerCase().replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '').replace(/\s+/g, ' ');
  const map = new Map();
  let maxWords = 1;
  for (const l of state.levels) {
    // duplicate names are written "NAME (creator)" - link by the plain name, and the hardest one wins
    const base = String(l.name).replace(/\s*[(\[][^)\]]*[)\]]/g, ' ').trim() || String(l.name);
    const key = norm(base);
    if (key.length < 3) continue;
    const prev = map.get(key);
    if (!prev || (l.position ?? 1e9) < (prev.position ?? 1e9)) map.set(key, l);
    maxWords = Math.max(maxWords, key.split(' ').length);
  }
  levelIndexCache = { src: state.levels, map, norm, maxWords: Math.min(maxWords, 7) };
  return levelIndexCache;
}
const LINK_STOPWORDS = new Set(['this', 'that', 'with', 'from', 'have', 'level', 'levels', 'list', 'video', 'verified', 'verification', 'first', 'second', 'third', 'hard', 'easy', 'best', 'good', 'long', 'last', 'part', 'game', 'song', 'music', 'demon', 'extreme', 'insane', 'free', 'full', 'time', 'life', 'world', 'road', 'sequel', 'remake', 'official']);
function linkifyLevels(text, selfLevelId) {
  const idx = levelNameIndex();
  if (!idx.map || !idx.map.size) return escapeHtml(text);
  const tokens = [];
  const re = /[^\s/\\|+]+/g; // words split on spaces and on / \ | +  ("Fog/Shimmer" -> Fog, Shimmer)
  let m;
  while ((m = re.exec(text))) tokens.push({ start: m.index, end: m.index + m[0].length });
  let out = '', cursor = 0, i = 0;
  while (i < tokens.length) {
    let hit = null;
    for (let n = Math.min(idx.maxWords, tokens.length - i); n >= 1 && !hit; n--) {
      const raw = text.slice(tokens[i].start, tokens[i + n - 1].end);
      let key = idx.norm(raw);
      let extra = 0;
      let level = idx.map.get(key);
      if (!level && /['’]s$/.test(key)) { key = key.replace(/['’]s$/, ''); level = idx.map.get(key); extra = 2; } // "Fog's"
      if (!level || String(level.level_id) === String(selfLevelId)) continue;
      const bare = raw.replace(/^[^\p{L}\p{N}]+/u, '');
      // a single word must be Capitalised and not an everyday word, to keep false links down
      if (n === 1 && (LINK_STOPWORDS.has(key) || !/^\p{Lu}/u.test(bare))) continue;
      const lead = raw.length - bare.length;
      const trail = (raw.match(/[^\p{L}\p{N}]+$/u) || [''])[0].length;
      hit = { level, from: tokens[i].start + lead, to: tokens[i + n - 1].end - trail - extra, n };
    }
    if (hit) {
      out += escapeHtml(text.slice(cursor, hit.from))
        + `<a href="#" class="level-ref" data-jump="${escapeHtml(String(hit.level.level_id))}" title="Go to ${escapeHtml(hit.level.name)}">${escapeHtml(text.slice(hit.from, hit.to))}</a>`;
      cursor = hit.to;
      i += hit.n;
    } else {
      i++;
    }
  }
  return out + escapeHtml(text.slice(cursor));
}

// Shows the single-level panel. (The video itself lives in the video dock, outside
// this panel, so re-rendering the panel never restarts it.)
function applyDetailHtml(html) {
  $('#detailInner').innerHTML = html;
}

function selectLevel(level, { force = false } = {}) {
  // Clicking the level that's already open (and fully shown) does nothing - no re-fetching.
  const stageNow = document.getElementById('videoStage');
  if (!force && state.multi.size < 2 && String(state.selectedId) === String(level.id)
      && state.detailLoaded === level.id && stageNow && !stageNow.classList.contains('multi')) return;
  state.detailLoaded = null;
  state.multiShownId = null;
  state.multi.clear(); // a normal selection always leaves multi-select
  markRangeCards();
  multiRecordsCache.clear(); // records/history are only kept while a multi-selection is active
  multiHistoryCache.clear();
  state.selectedId = level.id;
  document.querySelectorAll('.list-row').forEach(r => r.classList.toggle('selected', r.dataset.id === String(level.id)));

  const gddl = level.gddl_tier != null ? Math.round(level.gddl_tier * 10) / 10 : '—';
  const enj = level.edel_enjoyment != null ? Math.round(level.edel_enjoyment) + '%' : '—';
  const desc = level.description ? linkifyLevels(level.description, level.level_id) : 'No description available.';
  // The number copies on click; the ↗ stays a separate link to Newgrounds.
  const songHtml = songHtmlFor(level);
  const levelIdHtml = levelIdHtmlFor(level);

  const detailHtml = `
    <h2 class="detail-title">${level.position != null ? `<span class="title-pos">#${level.position}</span><span class="title-divider"></span>` : ''}${escapeHtml(level.name)}${levelToolsHtml(level, { follow: true })}</h2>
    <div class="detail-inner">
      ${videoStageHtml(false)}
      <p class="detail-desc">${desc}</p>
      <div class="video-tags">${(level.tags || []).map(t => {
        const key = t.toLowerCase();
        const mode = state.tagFilters[key] || '';
        return `<span class="tag-pill ${mode}" data-apply-tag="${escapeHtml(key)}">${escapeHtml(t)}</span>`;
      }).join('')}</div>
      <div class="stat-plain-grid">
        <div class="stat-plain"><div class="stat-label">Level ID</div><div class="stat-value">${levelIdHtml}</div></div>
        <div class="stat-plain"><div class="stat-label">List Points</div><div class="stat-value">${formatPoints(level.points)}</div></div>
        <div class="stat-plain"><div class="stat-label">Edel Enjoyment</div><div class="stat-value">${enj}</div></div>
        <div class="stat-plain"><div class="stat-label">Song</div><div class="stat-value">${songHtml}</div></div>
        <div class="stat-plain"><div class="stat-label">NLW Tier</div><div class="stat-value">${escapeHtml(level.nlw_tier || '—')}</div></div>
        <div class="stat-plain"><div class="stat-label">GDDL Tier</div><div class="stat-value">${gddl}</div></div>
      </div>
      <div id="panelCreditsZone"></div>
      <div id="panelHistoryZone"></div>
    </div>
  `;
  applyDetailHtml(detailHtml);

  loadLevelDetail(level);
  loadLevelHistory(level);
  loadLevelRecords(level);
  pushNavState();
}


// ---------------------------------------------------------------------------
// Multi-select (ctrl/cmd + click in the Demon List)
//
// With 2+ levels selected the detail panel becomes a summary of the whole
// group instead of one level: position range, merged tags, total points,
// average enjoyment and every publisher. Dropping back to 1 level (or a
// plain click) returns to the normal single-level view.
// ---------------------------------------------------------------------------
const publisherNames = new Map(); // publisher id -> display name
let multiToken = 0;                // invalidates in-flight work when the selection changes

function rememberPublisher(data) {
  const pub = data && data.publisher;
  const id = (pub && typeof pub === 'object' && pub.id) || data?.publisher_id;
  const name = personName(pub);
  if (id != null && name) publisherNames.set(String(id), name);
  uniqueVerifiers(data).forEach(v => { if (v.id) publisherNames.set(String(v.id), personName(v)); });
}

function isRowSelected(id) {
  return state.multi.size >= 2 ? state.multi.has(String(id)) : String(id) === String(state.selectedId);
}

function toggleMultiSelect(level) {
  const id = String(level.id);
  // Starting a multi-selection: the level that's already open counts as the first pick.
  if (!state.multi.size && state.selectedId != null) {
    state.multi.add(String(state.selectedId));
    state.multiViewId = state.selectedId; // keep showing the level that was already open
  }
  if (state.multi.has(id)) state.multi.delete(id);
  else state.multi.add(id);

  if (state.multi.size < 2) {
    // Back to (at most) one level: show it normally.
    const only = state.multi.size === 1 ? [...state.multi][0] : id;
    const target = state.levels.find(l => String(l.id) === String(only));
    if (target) selectLevel(target);
    return;
  }
  renderMultiSelection();
  markRangeCards();
}

let multiOrder = [];   // the selected level objects, in list order
let multiViewSeq = 0;  // invalidates in-flight video loads when the viewed level changes
const multiRecordsCache = new Map(); // level_id -> records, kept only while 2+ levels are selected
const multiHistoryCache = new Map(); // level_id -> position history, same lifetime

function updateMultiCaption(i) {
  const l = multiOrder[i];
  const el = document.getElementById('multiCaption');
  if (!l || !el) return;
  el.innerHTML = `${l.position != null ? `<span class="multi-caption-pos">#${l.position}</span>` : ''}<span class="multi-caption-name">${escapeHtml(l.name)}</span>${levelToolsHtml(l)}<span class="multi-caption-count">${i + 1} / ${multiOrder.length}</span>`;
}

// Show one level of the selection in the video area; the background and the
// records column follow it. Details/records are fetched once per level and
// reused while the multi-selection lasts.
function showMultiLevel(i) {
  const n = multiOrder.length;
  if (!n) return;
  i = ((i % n) + n) % n;
  const level = multiOrder[i];
  state.multiViewId = level.id;
  state.multiShownId = level.id;
  state.selectedId = level.id;
  pushNavState(); // each level you step to in a range is its own back/forward step
  const seq = ++multiViewSeq;
  updateMultiCaption(i);

  updateMultiViewedUi();

  // Records and position history are not fetched automatically in a level
  // range - a button loads them. Anything already loaded this session shows straight away.
  if (multiRecordsCache.has(level.level_id)) loadLevelRecords(level);
  else showRecordsLoadButton();
  const historyZone = document.getElementById('panelHistoryZone');
  if (multiHistoryCache.has(level.level_id)) loadLevelHistory(level);
  else if (historyZone) historyZone.innerHTML = `<div class="section-label">Position History</div><button class="btn btn-ghost" data-multi-load="history">Load position history</button>`;

  const zone = document.getElementById('panelVideoZone');
  const cached = detailCache.get(level.level_id);
  if (cached) { renderLevelDetail(cached); return; }
  if (zone) { delete zone.dataset.level; zone.innerHTML = '<div class="spinner" style="margin:60px auto;"></div>'; }
  window.aredl.getLevelDetail(level.level_id).then(data => {
    detailCache.set(level.level_id, data);
    rememberPublisher(data);
    if (seq === multiViewSeq && state.multi.size >= 2) { renderLevelDetail(data); renderMultiCredits(); }
  }).catch(err => {
    if (seq !== multiViewSeq || state.multi.size < 2) return;
    const z = document.getElementById('panelVideoZone');
    if (z) z.innerHTML = `<div class="dim" style="padding:14px;">Couldn't load the video (${escapeHtml(errMsg(err))}).</div>`;
  });
}

function showRecordsLoadButton() {
  abortRecords();
  recState = null;
  $('#recordsMore').innerHTML = '';
  $('#recordsCol').hidden = false;
  recordsData = [];
  recordsFiltered = [];
  $('#recordsCount').textContent = '';
  $('#recordsSearch').value = '';
  $('#recordsPager').innerHTML = '';
  $('#recordsRawZone').innerHTML = '';
  $('#recordsList').innerHTML = '<div class="load-on-demand"><button class="btn btn-ghost" data-multi-load="records">Load records</button></div>';
}

function viewedMultiLevel() {
  return multiOrder.find(l => String(l.id) === String(state.multiViewId)) || null;
}

// Publishers of every level in the range (the one for the level being viewed is bold),
// with the viewed level's verifier(s) underneath.
let multiCredit = { ids: [], settled: false, token: 0 };
function renderMultiCredits() {
  const zone = document.getElementById('multiCreditsZone');
  if (!zone || multiCredit.token !== multiToken) return;
  const cur = viewedMultiLevel();
  const curPub = cur && cur.publisher_id != null ? String(cur.publisher_id) : null;
  const rows = [];
  if (multiCredit.ids.length) {
    const links = multiCredit.ids.map(id =>
      `<a href="#" class="pub-link${id === curPub ? ' current' : ''}" data-lookup-publisher="${escapeHtml(id)}">${escapeHtml(publisherNames.get(id) || (multiCredit.settled ? `Publisher ${id}` : 'Loading…'))}</a>`);
    rows.push([multiCredit.ids.length > 1 ? 'Publishers' : 'Publisher', links.join(', ')]);
  }
  // every verifier across the range (same as the publishers); the viewed level's are bold
  const people = new Map();
  const mine = new Set();
  multiOrder.forEach(l => {
    const d = detailCache.get(l.level_id);
    if (!d) return;
    uniqueVerifiers(d).forEach(v => {
      const k = String(v.id || personName(v));
      if (!people.has(k)) people.set(k, v);
      if (cur && l.level_id === cur.level_id) mine.add(k);
    });
  });
  const pending = !multiCredit.settled && multiOrder.some(l => !detailCache.has(l.level_id));
  if (people.size) {
    const links = [...people.entries()].map(([k, v]) => personLinkHtml(v, { current: mine.has(k) }));
    rows.push([people.size > 1 ? 'Verifiers' : 'Verifier', links.join(', ') + (pending ? ' …' : '')]);
  } else if (pending) {
    rows.push(['Verifier', 'Loading…']);
  }
  zone.innerHTML = rows.length
    ? `<div class="credits-list">${rows.map(([k, v]) => `<div class="credit-row"><span class="credit-label">${escapeHtml(k)}</span><span class="credit-value">${v}</span></div>`).join('')}</div>`
    : '';
}

function markCurrentPublisher() { renderMultiCredits(); }

// Everything in the summary that depends on the level currently being viewed:
// its own stats, the individual numbers in brackets, which tags it has, and
// which publisher is its own.
function updateMultiViewedUi() {
  const level = viewedMultiLevel();
  if (!level || !document.querySelector('.multi-video-zone')) return;
  const set = (id, html) => { const el = document.getElementById(id); if (el) el.innerHTML = html; };
  set('multiDesc', level.description ? linkifyLevels(level.description, level.level_id) : 'No description available.');
  set('multiLevelId', levelIdHtmlFor(level));
  set('multiPointsIndiv', `(${formatPoints(level.points)})`);
  set('multiEnjIndiv', `(${enjText(level)})`);
  set('multiSong', songHtmlFor(level));
  set('multiNlw', escapeHtml(level.nlw_tier || '—'));
  set('multiGddl', escapeHtml(gddlText(level)));
  const own = new Set((level.tags || []).map(t => String(t).toLowerCase()));
  document.querySelectorAll('#multiTags .tag-pill').forEach(el => el.classList.toggle('in-level', own.has(el.dataset.applyTag)));
  markCurrentPublisher(level);
}

document.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-multi-load]');
  if (!btn || state.multi.size < 2) return;
  const level = viewedMultiLevel();
  if (!level) return;
  if (btn.dataset.multiLoad === 'records') loadLevelRecords(level);
  else if (btn.dataset.multiLoad === 'history') loadLevelHistory(level);
});

document.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-multi-nav]');
  if (!btn || state.multi.size < 2) return;
  const cur = multiOrder.findIndex(l => String(l.id) === String(state.multiViewId));
  showMultiLevel((cur < 0 ? 0 : cur) + Number(btn.dataset.multiNav));
});

function renderMultiSelection() {
  const levels = [...state.multi].map(id => state.levels.find(l => String(l.id) === id)).filter(Boolean)
    .sort((a, b) => (a.position ?? 1e9) - (b.position ?? 1e9) || NAME_COLLATOR.compare(a.name, b.name));
  if (levels.length < 2) { state.multi.clear(); return; }
  const token = ++multiToken;
  multiOrder = levels;

  document.querySelectorAll('.list-row').forEach(r => r.classList.toggle('selected', state.multi.has(r.dataset.id)));

  const positions = levels.map(l => l.position).filter(p => p != null);
  const lo = positions.length ? Math.min(...positions) : null;
  const hi = positions.length ? Math.max(...positions) : null;
  const range = lo == null ? '—' : (lo === hi ? `#${lo}` : `#${lo}-#${hi}`);

  const totalPoints = levels.reduce((sum, l) => sum + (l.points || 0), 0);
  const enjoyments = levels.map(l => l.edel_enjoyment).filter(v => v != null);
  const enj = enjoyments.length ? Math.round(enjoyments.reduce((a, b) => a + b, 0) / enjoyments.length) + '%' : '—';

  // Every tag across the group, deduped case-insensitively, known tags in their usual order.
  const tagMap = new Map();
  levels.forEach(l => (l.tags || []).forEach(t => { if (!tagMap.has(String(t).toLowerCase())) tagMap.set(String(t).toLowerCase(), String(t)); }));
  const orderOf = (key) => { const i = ALL_TAGS.findIndex(t => t.toLowerCase() === key); return i === -1 ? 1e6 : i; };
  const tagsHtml = [...tagMap.entries()].sort((a, b) => orderOf(a[0]) - orderOf(b[0]) || a[1].localeCompare(b[1])).map(([key, label]) =>
    `<span class="tag-pill ${state.tagFilters[key] || ''}" data-apply-tag="${escapeHtml(key)}">${escapeHtml(label)}</span>`).join('');

  const publisherIds = [...new Set(levels.map(l => l.publisher_id).filter(v => v != null).map(String))];
  const countText = `${levels.length} levels selected`;

  let viewIdx = levels.findIndex(l => String(l.id) === String(state.multiViewId));
  const stageEl = document.getElementById('videoStage');
  const panelExists = !!(stageEl && stageEl.classList.contains('multi'));

  if (!panelExists) {
    const titleHtml = `<h2 class="detail-title"><span class="title-pos" id="multiRange">${escapeHtml(range)}</span><span class="title-divider"></span>Level Range<span class="multi-badge" id="multiCount">${escapeHtml(countText)}</span></h2>`;
    const restHtml = `
        <p class="detail-desc" id="multiDesc"></p>
        <div class="video-tags" id="multiTags">${tagsHtml}</div>
        <div class="stat-plain-grid">
          <div class="stat-plain"><div class="stat-label">Level ID</div><div class="stat-value" id="multiLevelId">—</div></div>
          <div class="stat-plain"><div class="stat-label">Combined List Points</div><div class="stat-value"><span id="multiPoints">${formatPoints(totalPoints)}</span> <span class="stat-indiv" id="multiPointsIndiv"></span></div></div>
          <div class="stat-plain"><div class="stat-label">Average EDEL Enjoyment</div><div class="stat-value"><span id="multiEnj">${enj}</span> <span class="stat-indiv" id="multiEnjIndiv"></span></div></div>
          <div class="stat-plain"><div class="stat-label">Song</div><div class="stat-value" id="multiSong">—</div></div>
          <div class="stat-plain"><div class="stat-label">NLW Tier</div><div class="stat-value" id="multiNlw">—</div></div>
          <div class="stat-plain"><div class="stat-label">GDDL Tier</div><div class="stat-value" id="multiGddl">—</div></div>
        </div>
        <div id="multiCreditsZone"></div>
        <div id="panelHistoryZone"></div>`;
    const oldTitle = document.querySelector('#detailInner > .detail-title');
    if (stageEl && oldTitle) {
      // Turn the open single-level panel into the range panel in place: swap the
      // title and everything under the video, but keep the video element itself.
      oldTitle.outerHTML = titleHtml;
      const inner = stageEl.parentElement;
      [...inner.children].forEach(ch => { if (ch !== stageEl) ch.remove(); });
      inner.insertAdjacentHTML('beforeend', restHtml);
      stageEl.classList.add('multi');
      stageEl.querySelector('#panelVideoZone').classList.add('multi-video-zone');
    } else {
      $('#detailInner').innerHTML = `${titleHtml}<div class="detail-inner">${videoStageHtml(true)}${restHtml}</div>`;
    }
  } else {
    // Panel already showing: refresh just the summary so the video doesn't restart.
    $('#multiRange').textContent = range;
    $('#multiCount').textContent = countText;
    $('#multiTags').innerHTML = tagsHtml;
    $('#multiPoints').textContent = formatPoints(totalPoints);
    $('#multiEnj').textContent = enj;
  }

  let settled = false; // true once every lookup has finished (so unresolved ids show a plain label)
  const renderPublishers = () => { multiCredit = { ids: publisherIds, settled, token }; renderMultiCredits(); };
  renderPublishers();

  // The bulk list only has publisher ids; names come from a level's detail
  // record. One request per publisher we don't already know (3 at a time,
  // to stay friendly to the API's rate limit).
  const todo = levels.filter(l => !detailCache.has(l.level_id));
  let next = 0;
  const worker = async () => {
    while (next < todo.length) {
      const level = todo[next++];
      if (token !== multiToken) return;
      try {
        let data = detailCache.get(level.level_id);
        if (!data) { data = await window.aredl.getLevelDetail(level.level_id); detailCache.set(level.level_id, data); }
        rememberPublisher(data);
      } catch { /* leave the id as a fallback label */ }
      renderPublishers();
      await sleep(120);
    }
  };
  Promise.all([worker(), worker(), worker()]).then(() => {
    settled = true; // anything still unresolved falls back to "Publisher <id>" (still clickable)
    renderPublishers();
  });

  const wantIdx = viewIdx < 0 ? 0 : viewIdx;
  if (!panelExists || viewIdx < 0 || String(levels[wantIdx].id) !== String(state.multiShownId)) showMultiLevel(wantIdx);
  else { updateMultiCaption(viewIdx); updateMultiViewedUi(); }
  pushNavState();
}

// ---------------------------------------------------------------------------
// Level detail (confirmed: GET /aredl/levels/{level_id} returns the full
// record including a verification video link and resolved publisher/
// verifier/creator names, not just the IDs the bulk list gives you).
// ---------------------------------------------------------------------------
const detailCache = new Map(); // level_id -> resolved detail JSON

function findYoutubeUrl(obj, seen = new Set()) {
  if (!obj || typeof obj !== 'object' || seen.has(obj)) return null;
  seen.add(obj);
  for (const v of Object.values(obj)) {
    if (typeof v === 'string' && /youtu\.?be/i.test(v)) return v;
    if (v && typeof v === 'object') {
      const found = findYoutubeUrl(v, seen);
      if (found) return found;
    }
  }
  return null;
}

function youtubeThumbId(url) {
  const m = url.match(/(?:youtu\.be\/|youtube\.com\/(?:watch\?v=|embed\/|shorts\/))([\w-]{6,})/i);
  return m ? m[1] : null;
}

// everyone who verified the level (the API lists them under `verifications[].submitted_by`)
function uniqueVerifiers(data) {
  const out = [];
  const seen = new Set();
  (Array.isArray(data && data.verifications) ? data.verifications : []).forEach(v => {
    const who = v && v.submitted_by;
    if (!who || typeof who !== 'object') return;
    const key = who.id || personName(who);
    if (key && !seen.has(key)) { seen.add(key); out.push(who); }
  });
  return out;
}
function personLinkHtml(p, { current = false } = {}) {
  const name = personName(p);
  if (!name) return '';
  if (!p.id) return escapeHtml(name);
  return `<a href="#" class="pub-link${current ? ' current' : ''}" data-lookup-publisher="${escapeHtml(String(p.id))}">${escapeHtml(name)}</a>`;
}

function personName(v) {
  if (!v) return null;
  if (typeof v === 'string') return v;
  if (typeof v === 'object') return v.global_name || v.username || v.name || null;
  return null;
}

function looksLikeLevelObj(o) {
  return o && typeof o === 'object' && ('level_id' in o || 'gddl_tier' in o || 'nlw_tier' in o);
}

// Recursively hunts for a name-shaped field anywhere in an object, skipping
// anything that looks like level data rather than player data - same idea as
// findYoutubeUrl above (a pattern search rather than a fixed field list),
// since the exact shape of records/history entries was never confirmed.
function findPersonNameDeep(obj, seen = new Set(), depth = 0) {
  if (!obj || typeof obj !== 'object' || seen.has(obj) || depth > 4) return null;
  seen.add(obj);
  if (!looksLikeLevelObj(obj)) {
    const direct = personName(obj);
    if (direct) return direct;
  }
  for (const v of Object.values(obj)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && !looksLikeLevelObj(v)) {
      const found = findPersonNameDeep(v, seen, depth + 1);
      if (found) return found;
    }
  }
  return null;
}

// Same idea, hunting for a { name, level_id } pair - used when a history
// entry doesn't match the confirmed changelog shape.
function findLevelRefDeep(obj, seen = new Set(), depth = 0) {
  if (!obj || typeof obj !== 'object' || seen.has(obj) || depth > 4) return null;
  seen.add(obj);
  if (typeof obj.name === 'string' && obj.level_id != null) return { name: obj.name, level_id: obj.level_id };
  for (const v of Object.values(obj)) {
    if (v && typeof v === 'object') {
      const found = findLevelRefDeep(v, seen, depth + 1);
      if (found) return found;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Video players
//
// Every video is a "dock": a YouTube iframe that lives outside all the pages. A page
// only holds an empty "slot" where the video should appear, and the dock is laid
// over that slot while it's on screen, so the video looks like part of the page.
// The iframe never moves in the DOM, so it never reloads.
//
// When a playing video's slot goes away (you changed tab, opened another level or
// submission, scrolled it off...) the dock keeps playing, as a small player in a corner
// (or hidden / paused / stopped, per Settings > Videos). A new video starts in its own
// dock, and the old one only disappears once the new one actually starts playing - so at
// most one video ever plays. Drag the small player by its top bar, resize it from any
// corner, send it back, or close it.
// ---------------------------------------------------------------------------
const docks = new Set();
let currentDock = null;                       // the dock that belongs to the page's current video slot
const miniPrefs = { pos: null, width: 340 };  // shared by the corner player: left/top (null = bottom-right) and width
let dockLoopRunning = false;

function slotHtml(vid) {
  return `<div class="video-slot" data-vid="${escapeHtml(vid)}" style="--thumb:url(https://img.youtube.com/vi/${escapeHtml(vid)}/hqdefault.jpg)">
    <button class="slot-play" aria-label="Play video"><svg viewBox="0 0 68 48"><path d="M66.5 7.7a8.5 8.5 0 0 0-6-6C55.3.3 34 .3 34 .3S12.7.3 7.5 1.7a8.5 8.5 0 0 0-6 6C0 13 0 24 0 24s0 11 1.5 16.3a8.5 8.5 0 0 0 6 6C12.7 47.7 34 47.7 34 47.7s21.3 0 26.5-1.4a8.5 8.5 0 0 0 6-6C68 35 68 24 68 24s0-11-1.5-16.3z" fill="#f00"/><path d="M45 24 27 14v20" fill="#fff"/></svg></button>
    <span class="slot-away-msg">Playing in the corner player</span>
  </div>`;
}
// 'live' = a player is on it, 'away' = its video is in the corner, 'idle' = no player (press play to start one)
function setSlotState(slot, st) {
  if (!slot) return;
  slot.classList.toggle('away', st === 'away');
  slot.classList.toggle('idle', st === 'idle');
}

const dockTopSafe = () => (document.body.classList.contains('custom-titlebar') ? 37 : 0) + 8;

function dockMiniRect() {
  const vw = window.innerWidth, vh = window.innerHeight, top0 = dockTopSafe();
  const w = Math.min(miniPrefs.width, vw - 16), h = Math.round(w * 9 / 16);
  let left = miniPrefs.pos ? miniPrefs.pos.x : vw - w - 16;
  let top = miniPrefs.pos ? miniPrefs.pos.y : vh - h - 16;
  left = Math.min(Math.max(left, 8), Math.max(8, vw - w - 8));
  top = Math.min(Math.max(top, top0), Math.max(top0, vh - h - 8));
  return { left, top, width: w, height: h };
}
function saveMiniPrefs() {
  const pos = miniPrefs.pos;
  setSetting('miniPlayer', { x: pos ? Math.round(pos.x) : null, y: pos ? Math.round(pos.y) : null, width: miniPrefs.width });
}

class VideoDock {
  constructor() {
    this.el = document.getElementById('dockTemplate').content.firstElementChild.cloneNode(true);
    this.frame = this.el.querySelector('iframe');
    document.body.appendChild(this.el);
    this.vid = null; this.slot = null; this.origin = null; this.clipParents = [];
    this.title = ''; this.onReturn = null;
    this.playing = false; this.stateKnown = false; this.assumePlaying = false; this.paused = false;
    this.mode = 'off'; this.leaveSince = 0; this.lastCss = ''; this.animateNext = false;
    this.animTimer = null; this.lastPing = 0; this.dragging = false; this.parkedAt = 0;
    docks.add(this);
    this.frame.addEventListener('load', () => this.ping());
    this.wire();
    if (!dockLoopRunning) { dockLoopRunning = true; requestAnimationFrame(dockLoop); }
  }

  ping() {
    this.lastPing = Date.now();
    try { this.frame.contentWindow.postMessage(JSON.stringify({ event: 'listening', id: 1, channel: 'widget' }), '*'); } catch { /* not ready */ }
  }
  command(func) {
    try { this.frame.contentWindow.postMessage(JSON.stringify({ event: 'command', func, args: '' }), '*'); } catch { /* not ready */ }
  }
  // Counts as "playing" once YouTube says so (until it has said anything: only if we asked for autoplay).
  isPlaying() { return this.stateKnown ? this.playing : this.assumePlaying; }

  load(vid, autoplay) {
    this.vid = vid;
    this.playing = false; this.stateKnown = false; this.assumePlaying = !!autoplay; this.paused = false;
    this.frame.src = `https://www.youtube.com/embed/${vid}?origin=${encodeURIComponent(location.origin)}${autoplay ? '&autoplay=1' : ''}&enablejsapi=1`;
  }
  attach(slot, ctx) {
    this.slot = slot;
    this.origin = slot;
    slot._ctx = ctx;
    this.title = ctx.title || '';
    this.onReturn = ctx.onReturn || null;
    this.clipParents = [];
    for (let p = slot.parentElement; p && p !== document.body; p = p.parentElement) {
      const cs = getComputedStyle(p);
      if (cs.overflowX !== 'visible' || cs.overflowY !== 'visible') this.clipParents.push(p);
    }
    this.el.querySelector('.mp-title').textContent = this.title;
    this.el.classList.remove('off');
    setSlotState(slot, 'live');
  }
  // The page moved on: this player no longer has a place on it, and carries on by itself.
  // The page moved on to another video. This player keeps its slot (so it comes back to it if you
  // return to that tab) and, if it's playing, carries on in the corner without hesitating.
  park() {
    this.parkedAt = Date.now();
    this.leaveSince = Date.now() - 1000;
  }
  destroy() {
    if (!docks.has(this)) return;
    docks.delete(this);
    clearTimeout(this.animTimer);
    this.frame.src = 'about:blank';
    this.el.remove();
    if (currentDock === this) currentDock = null;
    // the slot that showed this video can be played again
    [this.origin, this.slot].forEach(sl => { if (sl && sl.isConnected) setSlotState(sl, 'idle'); });
  }

  setRect(t, animate) {
    const el = this.el;
    const from = animate ? el.getBoundingClientRect() : null;
    el.style.left = t.left + 'px'; el.style.top = t.top + 'px';
    el.style.width = t.width + 'px'; el.style.height = t.height + 'px';
    const c = t.clip;
    const clipped = c && (c.top > 0.5 || c.right > 0.5 || c.bottom > 0.5 || c.left > 0.5);
    el.style.clipPath = clipped ? `inset(${Math.max(0, c.top)}px ${Math.max(0, c.right)}px ${Math.max(0, c.bottom)}px ${Math.max(0, c.left)}px round 10px)` : 'none';
    if (from && from.width > 2) {
      // glide with a transform (GPU-cheap; the player isn't re-laid-out every frame)
      el.style.transition = 'none';
      el.style.transform = 'none';
      const to = el.getBoundingClientRect();
      el.style.transformOrigin = '0 0';
      el.style.transform = `translate(${from.left - to.left}px, ${from.top - to.top}px) scale(${from.width / to.width}, ${from.height / to.height})`;
      void el.offsetWidth;
      el.style.transition = 'transform .38s cubic-bezier(.22,1,.36,1)';
      el.style.transform = 'none';
      clearTimeout(this.animTimer);
      this.animTimer = setTimeout(() => { el.style.transition = ''; }, 420);
    }
  }

  layout() {
    if (this.dragging) return;
    if (!this.stateKnown && Date.now() - this.lastPing > 1500) this.ping(); // keep asking until YouTube answers
    const el = this.el;
    let target = null, mode = 'off';

    const slot = this.slot;
    if (slot && slot.isConnected) {
      const tab = slot.closest('.tab');
      const r = slot.getBoundingClientRect();
      if ((!tab || tab.classList.contains('active')) && r.width > 40 && r.height > 20) {
        let top = r.top, left = r.left, right = r.right, bottom = r.bottom;
        for (const p of this.clipParents) {
          const pr = p.getBoundingClientRect();
          top = Math.max(top, pr.top); left = Math.max(left, pr.left);
          right = Math.min(right, pr.right); bottom = Math.min(bottom, pr.bottom);
        }
        const title = slot.closest('.detail-scroll') && slot.closest('.detail-scroll').querySelector('.detail-title');
        if (title) top = Math.max(top, title.getBoundingClientRect().bottom); // the sticky title covers the top
        const vis = (Math.max(0, bottom - top) * Math.max(0, right - left)) / (r.width * r.height);
        if (vis >= 0.5) {
          mode = 'inline';
          target = { left: r.left, top: r.top, width: r.width, height: r.height, clip: { top: top - r.top, right: r.right - right, bottom: r.bottom - bottom, left: left - r.left } };
        }
      }
    }

    const leave = appSettings.videoOnLeave || 'popup'; // popup | background | pause | stop
    if (mode === 'inline') {
      this.leaveSince = 0;
      this.paused = false;
    } else if (this.mode === 'mini') {
      // once it's a corner player it stays one - even paused or finished - until closed, replaced by a playing video, or brought back
      mode = 'mini';
      target = dockMiniRect();
    } else if (this.isPlaying()) {
      if (!this.leaveSince) this.leaveSince = Date.now();
      const settled = Date.now() - this.leaveSince > 220; // ignore a quick re-render of the page
      if (leave === 'popup') {
        if (settled) { mode = 'mini'; target = dockMiniRect(); }
        else mode = this.mode; // keep the last look for a moment
      } else if (settled) {
        if (leave === 'stop') { this.destroy(); return; }
        if (leave === 'pause' && !this.paused) { this.command('pauseVideo'); this.paused = true; }
        mode = 'off'; // 'background': hidden, but it keeps playing
      } else {
        mode = this.mode;
      }
    } else {
      this.leaveSince = 0;
    }

    // a player with no page slot, not in the corner and not playing has nothing left to do
    const attached = !!(this.slot && this.slot.isConnected);
    if (!attached && this !== currentDock && mode !== 'mini' && !this.isPlaying()) { this.destroy(); return; }

    let animate = this.animateNext;
    this.animateNext = false;
    if (mode !== this.mode) {
      if ((this.mode === 'inline' && mode === 'mini') || (this.mode === 'mini' && mode === 'inline')) animate = true;
      this.mode = mode;
      // only one corner player at a time
      if (mode === 'mini') [...docks].forEach(o => { if (o !== this && o.mode === 'mini') o.destroy(); });
      el.classList.toggle('mini', mode === 'mini');
      el.classList.toggle('off', mode === 'off');
      if (this.slot) setSlotState(this.slot, mode === 'mini' ? 'away' : 'live');
    }
    if (mode === 'off' || !target) return;

    const c = target.clip;
    const css = `${Math.round(target.left)}|${Math.round(target.top)}|${Math.round(target.width)}|${Math.round(target.height)}|${c ? [c.top, c.right, c.bottom, c.left].map(Math.round).join(',') : ''}`;
    if (css === this.lastCss) return;
    this.lastCss = css;
    this.setRect(target, animate);
  }

  wire() {
    const el = this.el;
    el.querySelector('[data-mp="close"]').addEventListener('click', () => this.destroy());
    el.querySelector('[data-mp="return"]').addEventListener('click', () => { if (this.onReturn) this.onReturn(); });

    // drag by the top bar: it stays wherever you drop it, and only sticks to an edge/corner if you let go very close to it
    const bar = el.querySelector('.mp-bar');
    let dx = 0, dy = 0;
    bar.addEventListener('pointerdown', (e) => {
      if (e.target.closest('.mp-btn') || this.mode !== 'mini') return;
      this.dragging = true;
      clearTimeout(this.animTimer);
      el.style.transition = 'none';
      el.style.transform = 'none';
      const r = el.getBoundingClientRect();
      dx = e.clientX - r.left; dy = e.clientY - r.top;
      bar.setPointerCapture(e.pointerId);
      el.classList.add('dragging');
    });
    bar.addEventListener('pointermove', (e) => {
      if (!this.dragging) return;
      el.style.left = (e.clientX - dx) + 'px';
      el.style.top = (e.clientY - dy) + 'px';
    });
    bar.addEventListener('pointerup', (e) => {
      if (!this.dragging) return;
      try { bar.releasePointerCapture(e.pointerId); } catch { /* already released */ }
      el.classList.remove('dragging');
      const r = el.getBoundingClientRect();
      const SNAP = 26, M = 16, top0 = dockTopSafe();
      let x = r.left, y = r.top;
      if (x < SNAP) x = M; else if (window.innerWidth - r.right < SNAP) x = window.innerWidth - r.width - M;
      if (y - top0 < SNAP) y = top0 + 8; else if (window.innerHeight - r.bottom < SNAP) y = window.innerHeight - r.height - M;
      miniPrefs.pos = { x, y };
      this.dragging = false;
      this.animateNext = true;
      this.lastCss = '';
      saveMiniPrefs();
    });

    // resize from any corner (the opposite corner stays put)
    el.querySelectorAll('.mp-resize').forEach(handle => {
      const edge = handle.dataset.edge;
      let startX = 0, startRect = null;
      handle.addEventListener('pointerdown', (e) => {
        this.dragging = true;
        clearTimeout(this.animTimer);
        el.style.transition = 'none';
        el.style.transform = 'none';
        startX = e.clientX;
        startRect = el.getBoundingClientRect();
        handle.setPointerCapture(e.pointerId);
        el.classList.add('dragging');
        e.preventDefault();
      });
      handle.addEventListener('pointermove', (e) => {
        if (!this.dragging || !startRect) return;
        const dxm = e.clientX - startX;
        const leftEdge = edge.includes('l');
        const w = Math.round(Math.min(Math.max(startRect.width + (leftEdge ? -dxm : dxm), 220), Math.min(900, window.innerWidth - 16)));
        const h = Math.round(w * 9 / 16);
        let left = leftEdge ? startRect.right - w : startRect.left;
        let top = edge.startsWith('t') ? startRect.bottom - h : startRect.top;
        left = Math.min(Math.max(left, 8), window.innerWidth - w - 8);
        top = Math.min(Math.max(top, dockTopSafe()), window.innerHeight - h - 8);
        miniPrefs.width = w;
        miniPrefs.pos = { x: left, y: top };
        el.style.left = left + 'px'; el.style.top = top + 'px';
        el.style.width = w + 'px'; el.style.height = h + 'px';
      });
      handle.addEventListener('pointerup', (e) => {
        if (!this.dragging) return;
        try { handle.releasePointerCapture(e.pointerId); } catch { /* already released */ }
        this.dragging = false;
        el.classList.remove('dragging');
        this.lastCss = '';
        saveMiniPrefs();
      });
    });
  }
}

function dockLoop() {
  if (!docks.size) { dockLoopRunning = false; return; }
  [...docks].forEach(d => d.layout());
  requestAnimationFrame(dockLoop);
}

// YouTube reports play / pause / end through postMessage once we say we're listening.
window.addEventListener('message', (e) => {
  const d = [...docks].find(x => x.frame.contentWindow === e.source);
  if (!d) return;
  let data = e.data;
  if (typeof data === 'string') { try { data = JSON.parse(data); } catch { return; } }
  if (!data) return;
  let st = null;
  if (data.event === 'onStateChange' && typeof data.info === 'number') st = data.info;
  else if (data.event === 'infoDelivery' && data.info && typeof data.info.playerState === 'number') st = data.info.playerState;
  if (st == null || st === -1) return;
  const was = d.playing;
  d.stateKnown = true;
  d.playing = st === 1 || st === 3;
  if (d.playing && !was) onDockStartedPlaying(d);
});
// A video started playing: a leftover corner/hidden player goes away at once (no animation).
function onDockStartedPlaying(d) {
  [...docks].forEach(o => {
    if (o === d) return;
    // a corner / hidden player disappears at once (no animation); one still on a page just pauses
    if (o.mode === 'mini' || !o.slot || (o.mode === 'off' && o.isPlaying())) o.destroy();
    else if (o.isPlaying()) o.command('pauseVideo');
  });
}

// Show `vid` in `slot`.
function dockPlay({ vid, slot, title = '', onReturn = null, autoplay = false }) {
  const ctx = { title, onReturn };
  let d = [...docks].find(x => x.vid === vid);
  if (d) {
    d.attach(slot, ctx); // that video already has a player (maybe in the corner): bring it to this slot
    if (autoplay) { d.assumePlaying = true; d.command('playVideo'); }
  } else {
    d = new VideoDock();
    d.load(vid, autoplay);
    d.attach(slot, ctx);
  }
  // the page's previous player: kept only while it's playing (or in the corner); an idle one is closed,
  // and its slot goes back to showing a play button
  const prev = currentDock;
  if (prev && prev !== d) {
    if (prev.isPlaying() || prev.mode === 'mini') prev.park(); else prev.destroy();
  }
  currentDock = d;
  return d;
}

// Back on a tab whose video slot lost its player (it was idle and got closed, or another video took over):
// give it a fresh, paused YouTube player again instead of leaving a bare thumbnail.
function redockIdleSlots() {
  document.querySelectorAll('.tab.active .video-slot.idle').forEach(slot => {
    const ctx = slot._ctx;
    if (!ctx) return;
    const inClosedCard = slot.closest('.submission-card') && !slot.closest('.submission-card.open');
    if (inClosedCard) return;
    dockPlay({ vid: slot.dataset.vid, slot, title: ctx.title, onReturn: ctx.onReturn });
  });
}

// A slot with no player (its video was closed or replaced): pressing play starts one again.
document.addEventListener('click', (e) => {
  const play = e.target.closest('.video-slot.idle .slot-play');
  if (!play) return;
  const slot = play.closest('.video-slot');
  const ctx = slot._ctx || {};
  dockPlay({ vid: slot.dataset.vid, slot, title: ctx.title || '', onReturn: ctx.onReturn || null, autoplay: true });
});

// Show a level's video (or a link if it can't be embedded) in the page's video zone.
function playVideo(url, ctx = {}) {
  const zone = document.getElementById('panelVideoZone');
  if (!zone) return;
  const vid = url ? youtubeThumbId(url) : null;
  // a level with no (embeddable) video leaves whatever is playing alone - it carries on in the corner
  if (!url) { zone.innerHTML = ''; if (currentDock) { currentDock.park(); currentDock = null; } return; }
  if (!vid) {
    zone.innerHTML = `<a class="video-fallback" href="${escapeHtml(url)}" target="_blank" rel="noopener">▶ Watch on YouTube ↗</a>`;
    if (currentDock) { currentDock.park(); currentDock = null; }
    return;
  }
  zone.innerHTML = slotHtml(vid);
  dockPlay({ vid, slot: zone.firstElementChild, title: ctx.title || '', onReturn: ctx.onReturn || null });
}

function renderLevelDetail(data) {
  const video = findYoutubeUrl(data);
  const vid = video ? youtubeThumbId(video) : null;
  const publisher = personName(data.publisher);
  const verifier = personName(data.verifier);
  const creators = Array.isArray(data.creators) ? data.creators.map(personName).filter(Boolean) : [];

  setPageBackground(vid);

  // The verification video is the one thing allowed to render inside the
  // app rather than opening externally, per the user - everything else
  // still opens in the system browser via main.js's setWindowOpenHandler.
  const listed = state.levels.find(l => String(l.level_id) === String(data.level_id));
  state.detailLoaded = listed ? listed.id : null;
  playVideo(video, { title: (listed && listed.name) || data.name || '', onReturn: () => jumpToLevel(data.level_id) });

  const creditsZone = document.getElementById('panelCreditsZone');
  if (creditsZone) {
    const rows = [];
    const publisherObj = data.publisher && typeof data.publisher === 'object' ? data.publisher : null;
    const verifiers = uniqueVerifiers(data);
    // names are text with a dotted underline (click = open that player's profile)
    if (publisher) rows.push(['Publisher', publisherObj && publisherObj.id != null ? personLinkHtml(publisherObj) : escapeHtml(publisher)]);
    if (verifiers.length) rows.push([verifiers.length > 1 ? 'Verifiers' : 'Verifier', verifiers.map(v => personLinkHtml(v)).join(', ')]);
    else if (verifier) rows.push(['Verifier', escapeHtml(verifier)]);
    if (creators.length) rows.push([creators.length > 1 ? 'Creators' : 'Creator', escapeHtml(creators.join(', '))]);
    creditsZone.innerHTML = rows.length
      ? `<div class="credits-list">${rows.map(([k, v]) => `<div class="credit-row"><span class="credit-label">${escapeHtml(k)}</span><span class="credit-value">${v}</span></div>`).join('')}</div>`
      : '';
  }

  return `${rawDetails(`Full API response for this level`, data)}`;
}

async function loadLevelDetail(level) {
  const cached = detailCache.get(level.level_id);
  if (cached) {
    rememberPublisher(cached);
    const raw = renderLevelDetail(cached);
    const rawZone = document.getElementById('panelHistoryZone');
    if (rawZone) rawZone.insertAdjacentHTML('beforebegin', raw);
    return;
  }

  const videoZone = document.getElementById('panelVideoZone');
  if (videoZone) videoZone.innerHTML = '<div class="spinner" style="margin:14px auto 4px;"></div>';
  try {
    const data = await window.aredl.getLevelDetail(level.level_id);
    detailCache.set(level.level_id, data);
    rememberPublisher(data);
    if (state.selectedId === level.id && state.multi.size < 2) {
      const raw = renderLevelDetail(data);
      const rawZone = document.getElementById('panelHistoryZone');
      if (rawZone) rawZone.insertAdjacentHTML('beforebegin', raw);
    }
  } catch (err) {
    if (state.selectedId === level.id && state.multi.size < 2) {
      const zone = document.getElementById('panelVideoZone');
      if (zone) zone.innerHTML = `<div class="dim">Couldn't load full details (${escapeHtml(errMsg(err))}).</div>`;
    }
  }
}

let searchDebounce = null;
// the "i" popup
function setSearchHelp(open) {
  const m = $('#searchHelp');
  if (open) { m.hidden = false; requestAnimationFrame(() => m.classList.add('open')); }
  else { m.classList.remove('open'); setTimeout(() => { if (!m.classList.contains('open')) m.hidden = true; }, 180); }
}
$('#searchInfoBtn').addEventListener('click', () => setSearchHelp(true));
$('#searchHelpClose').addEventListener('click', () => setSearchHelp(false));
$('#searchHelp').addEventListener('mousedown', (e) => { if (e.target === $('#searchHelp')) setSearchHelp(false); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('#searchHelp').hidden) setSearchHelp(false); });

function updateSearchClearBtn() { $('#searchClearBtn').hidden = !$('#search').value; }
function clearSearch() {
  $('#search').value = '';
  clearTimeout(searchDebounce);
  updateSearchClearBtn();
  applyFilters();
  $('#search').focus();
}
$('#search').addEventListener('input', () => {
  updateSearchClearBtn();
  clearTimeout(searchDebounce);
  searchDebounce = setTimeout(applyFilters, 160);
});
$('#search').addEventListener('keydown', (e) => {
  if (e.key === 'Delete' && $('#search').value) {
    e.preventDefault();
    clearSearch();
  }
});
$('#searchClearBtn').addEventListener('click', clearSearch);
$('#statusFilter').addEventListener('change', applyFilters);
$('#sortBy').addEventListener('change', applyFilters);
$('#completedOnly').addEventListener('change', applyFilters);
wireRefreshButton('refreshBtn', async () => {
  const selectedId = state.selectedId;
  const wasMulti = state.multi.size >= 2;
  await loadLevels();
  if (wasMulti) { renderMultiSelection(); return; }
  if (selectedId != null) {
    const level = state.levels.find(l => String(l.id) === String(selectedId));
    if (level) selectLevel(level, { force: true });
  }
});

// ---------------------------------------------------------------------------
// Records side panel (confirmed: GET /aredl/levels/{level_id}/records)
// ---------------------------------------------------------------------------
let recordsData = [];
let recordsFiltered = [];
let recordsPage = 1;
const RECORDS_PER_PAGE = 50;

function toAlpha2(code) {
  if (!code) return null;
  const s = String(code).trim();
  if (/^\d+$/.test(s)) return ISO_NUMERIC_TO_ALPHA2[String(Number(s))] || null;
  if (s.length === 3) return ISO_ALPHA3_TO_ALPHA2[s.toUpperCase()] || null;
  if (s.length === 2) return s.toUpperCase();
  return null;
}
// Windows' emoji font doesn't compose the regional-indicator pairs into an
// actual flag glyph - it just shows the two letters - so this renders a real
// flag image instead, which works regardless of OS/font support.
function countryFlagHtml(code, size = 16) {
  if (code === 0 || code === '0') return `<span class="flag-unknown" title="No country set">?</span>`;
  const alpha2 = toAlpha2(code);
  if (!alpha2) return '';
  const h = Math.round(size * 0.75);
  const lower = alpha2.toLowerCase();
  // flagcdn.com only serves a fixed set of WxH combos (16x12, 20x15, ...) -
  // 18x14 isn't one of them, so every request was 404ing. /w40/ is one of
  // their documented presets; the display size is controlled separately via
  // the width/height attributes below instead of the fetched image's size.
  return `<img class="flag-img" src="https://flagcdn.com/w40/${lower}.png" width="${size}" height="${h}" alt="${alpha2}" title="${alpha2}" onerror="this.outerHTML='<span class=&quot;record-flag-code&quot;>${alpha2}</span>'">`;
}
function recordName(r) {
  return personName(r.submitted_by) || personName(r.player) || personName(r.user) || personName(r.holder) || personName(r.profile)
    || personName(r) || r.username || r.name || findPersonNameDeep(r) || 'Unknown';
}
function extractCountryValue(obj) {
  if (!obj || typeof obj !== 'object') return null;
  for (const key of ['country', 'country_code', 'countryCode', 'nationality', 'nation', 'iso_code', 'location']) {
    const v = obj[key];
    if (v == null) continue;
    if (typeof v === 'string' || typeof v === 'number') return v;
    if (typeof v === 'object') {
      const nested = v.code || v.iso || v.iso2 || v.alpha2 || v.alpha_2 || v.id || v.name;
      if (nested) return nested;
    }
  }
  return null;
}
function findCountryDeep(obj, seen = new Set(), depth = 0) {
  if (!obj || typeof obj !== 'object' || seen.has(obj) || depth > 4) return null;
  seen.add(obj);
  for (const [key, v] of Object.entries(obj)) {
    if (typeof v === 'string' && /country|nation|iso.?code/i.test(key) && v.length <= 3) return v;
    if (v && typeof v === 'object') {
      const found = findCountryDeep(v, seen, depth + 1);
      if (found) return found;
    }
  }
  return null;
}
function recordCountry(r) {
  return extractCountryValue(r.submitted_by) || extractCountryValue(r)
    || extractCountryValue(r.player) || extractCountryValue(r.user)
    || extractCountryValue(r.holder) || extractCountryValue(r.profile)
    || findCountryDeep(r)
    || null;
}
function recordDate(r) { return r.achieved_at || r.created_at || r.date || r.completed_at || null; }
function recordPlayerId(r) {
  return (r.submitted_by && r.submitted_by.id)
    || (r.player && r.player.id) || (r.user && r.user.id) || (r.holder && r.holder.id) || (r.profile && r.profile.id)
    || r.player_id || r.user_id || r.holder_id || r.profile_id || null;
}

$('#recordsList').addEventListener('click', (e) => {
  const row = e.target.closest('.record-row');
  if (!row) return;
  const r = recordsFiltered[Number(row.dataset.recordIdx)];
  const id = r && recordPlayerId(r);
  if (!id) return;
  showTab('profile');
  $('#profileLookup').value = id;
  lookupProfile(id);
});

// Records are fetched one page at a time and shown as they arrive. Leaving the level
// (or the tab) stops the fetching; the first 50 pages (~1000 records) load
// automatically and a button loads more.
let recState = null;
function abortRecords() {
  if (recState) { recState.token++; recState.loading = false; }
}
function renderRecordsFooter() {
  const el = document.getElementById('recordsMore');
  if (!el) return;
  const st = recState;
  if (!st) { el.innerHTML = ''; return; }
  const n = st.data.length.toLocaleString();
  if (st.loading) el.innerHTML = `<div class="records-loading"><div class="spinner mini"></div>Loading… ${n} so far</div>`;
  else if (st.error) el.innerHTML = `<div class="dim" style="margin-bottom:8px;">Couldn't load more (${escapeHtml(st.error)}).</div><button class="btn btn-ghost" data-records-more>Retry</button>`;
  else if (!st.complete) el.innerHTML = `<button class="btn btn-ghost" data-records-more>Load more records (${n} loaded)</button>`;
  else el.innerHTML = '';
}
function renderRecordsRaw() {
  const rawZone = document.getElementById('recordsRawZone');
  if (!rawZone) return;
  rawZone.innerHTML = recordsData.length
    ? `${rawDetails(`Full API response`, recordsData)}`
    : '';
}

async function pumpRecords(st, batch = 50) {
  if (st.loading || st.complete) return;
  st.loading = true;
  st.error = null;
  const token = ++st.token;
  if (recState === st) { renderRecordsFooter(); if (!st.data.length) renderRecordsPage(); }
  let pages = 0;
  try {
    while (!st.complete && pages < batch) {
      const data = await window.aredl.getLevelRecordsPage(st.levelId, st.nextPage);
      if (st.token !== token) return; // you left - stop here, no more requests
      const items = Array.isArray(data) ? data : (data.data || data.records || data.items || []);
      if (!items.length) { st.complete = true; break; }
      const firstId = items[0] && items[0].id;
      if (st.nextPage > 1 && firstId != null && firstId === st.lastFirstId) { st.complete = true; break; }
      st.lastFirstId = firstId;
      if (st.pageSize == null) st.pageSize = items.length;
      for (const it of items) st.data.push(it);
      st.nextPage++;
      pages++;
      if (items.length < st.pageSize) st.complete = true;
      if (recState === st) { applyRecordsFilter({ keepPage: true }); renderRecordsFooter(); }
    }
  } catch (err) {
    if (st.token !== token) return;
    st.error = errMsg(err);
  }
  if (st.token !== token) return;
  st.loading = false;
  if (recState === st) { applyRecordsFilter({ keepPage: true }); renderRecordsFooter(); renderRecordsRaw(); }
}

document.addEventListener('click', (e) => {
  if (e.target.closest('[data-records-more]') && recState) pumpRecords(recState);
});

async function loadLevelRecords(level) {
  abortRecords();
  $('#recordsCol').hidden = false;
  $('#recordsPager').innerHTML = '';
  $('#recordsSearch').value = '';
  const inRange = state.multi.size >= 2;
  let st = inRange ? multiRecordsCache.get(level.level_id) : null; // a level range keeps what it already loaded
  if (!st) {
    st = { levelId: level.level_id, data: [], nextPage: 1, complete: false, loading: false, error: null, pageSize: null, lastFirstId: null, token: 0 };
    if (inRange) multiRecordsCache.set(level.level_id, st);
  }
  recState = st;
  recordsData = st.data;
  applyRecordsFilter();
  renderRecordsFooter();
  renderRecordsRaw();
  if (!st.data.length && !st.complete) pumpRecords(st);
}
function applyRecordsFilter({ keepPage = false } = {}) {
  const terms = searchTerms($('#recordsSearch').value);
  recordsFiltered = terms.length ? recordsData.filter(r => matchesAnyTerm(recordName(r).toLowerCase(), terms)) : recordsData.slice();
  if (!keepPage) recordsPage = 1;
  const more = recState && !recState.complete ? '+' : '';
  // "Records (123)" - or "(12 of 123)" while the records search is narrowing it
  $('#recordsCount').textContent = terms.length
    ? `(${recordsFiltered.length.toLocaleString()} of ${recordsData.length.toLocaleString()}${more})`
    : `(${recordsData.length.toLocaleString()}${more})`;
  renderRecordsPage();
}

function renderRecordsPage() {
  const totalPages = Math.max(1, Math.ceil(recordsFiltered.length / RECORDS_PER_PAGE));
  recordsPage = Math.min(recordsPage, totalPages);
  const start = (recordsPage - 1) * RECORDS_PER_PAGE;
  const pageItems = recordsFiltered.slice(start, start + RECORDS_PER_PAGE);

  $('#recordsList').innerHTML = pageItems.length
    ? pageItems.map((r, i) => {
        const countryRaw = recordCountry(r);
        const flagDisplay = countryFlagHtml(countryRaw, 18);
        const date = recordDate(r);
        const video = findYoutubeUrl(r);
        return `<div class="record-row" data-record-idx="${start + i}">
          <span class="record-flag">${flagDisplay}</span>
          <div class="record-main">
            <div class="record-name">${escapeHtml(recordName(r))}</div>
            ${date ? `<div class="record-date">${escapeHtml(new Date(date).toLocaleDateString())}</div>` : ''}
          </div>
          ${video
            ? `<a class="record-play" href="${escapeHtml(video)}" target="_blank" rel="noopener" title="Watch on YouTube" onclick="event.stopPropagation()">▶</a>`
            : `<span class="record-play" style="opacity:.3;">▶</span>`}
        </div>`;
      }).join('')
    : (recState && recState.loading
        ? '<div class="spinner" style="margin:20px auto;"></div>'
        : '<div class="dim" style="padding:14px;text-align:center;">No records found.</div>');

  $('#recordsPager').innerHTML = totalPages > 1
    ? `<button ${recordsPage <= 1 ? 'disabled' : ''} data-page="prev">Previous</button>
       <button class="current">${recordsPage}</button>
       <button ${recordsPage >= totalPages ? 'disabled' : ''} data-page="next">Next</button>`
    : '';

  if (!(recState && recState.loading)) renderRecordsRaw();
}

$('#recordsPager').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-page]');
  if (!btn || btn.disabled) return;
  recordsPage += btn.dataset.page === 'next' ? 1 : -1;
  renderRecordsPage();
});

let recordsSearchDebounce = null;
$('#recordsSearch').addEventListener('input', () => {
  clearTimeout(recordsSearchDebounce);
  recordsSearchDebounce = setTimeout(applyRecordsFilter, 150);
});

// ---------------------------------------------------------------------------
// Changelog
//
// Confirmed shape (from a working Apps Script the user already had):
//   GET /aredl/changelog?page=N  ->  { data: [ ...20 per page... ] }
//   entry.action is either the plain string "Pending", or an object like
//     { Raised: { old_position, new_position } }, { Placed: { new_position } },
//     { Lowered: { old_position, new_position } },
//     { Swapped: { other_level: {...}, upper_position, lower_position } }
//   entry.affected_level = { name, level_id, ... }
//   entry.created_at = ISO date string
// "Removed" wasn't in that script but is handled defensively in case it
// exists as its own action type.
// ---------------------------------------------------------------------------
const CHANGELOG_PAGE_SIZE = 20;

const ACTION_COLORS = {
  placed:  '#3b82f6',
  raised:  '#22c55e',
  lowered: '#f87171',
  swapped: '#fb923c',
  pending: '#eab308',
  removed: '#991b1b',
  movedtolegacy: '#9a3412', // close to Removed, but warmer so the two read as different
};

function actionTypeOf(entry) {
  for (const src of [entry, entry && entry.cause, entry && entry.reason]) {
    if (!src || typeof src !== 'object') continue;
    if (typeof src.action === 'string') return src.action;
    if (src.action && typeof src.action === 'object') return Object.keys(src.action)[0];
  }
  return (entry && (entry.type || entry.event_type || entry.action_type || entry.cause_type || entry.event)) || null;
}
function actionDataOf(entry) {
  for (const src of [entry, entry && entry.cause, entry && entry.reason]) {
    if (!src || typeof src !== 'object') continue;
    if (src.action && typeof src.action === 'object') {
      const type = Object.keys(src.action)[0];
      return src.action[type];
    }
  }
  // Flat shape (e.g. { action: "OtherPlaced", other_level: {...} }) - the
  // relevant fields are siblings on the entry itself, not nested.
  return entry;
}

// The API names its timestamp field differently per endpoint (action_at on
// the history / list-changes responses, created_at elsewhere).
function entryDate(e) {
  const raw = e && (e.action_at || e.created_at || e.date || e.timestamp || e.at || e.updated_at);
  const d = raw ? new Date(raw) : null;
  return d && !isNaN(d) ? d : null;
}
function dateCellHtml(d) {
  if (!d) return '—';
  return `${escapeHtml(d.toLocaleDateString())}<span class="rel">${escapeHtml(formatRelativeTime(d))}</span>`;
}

function levelLinkHtml(name, levelId) {
  const label = escapeHtml(name || 'Unknown level');
  return levelId
    ? `<a href="#" class="level-link" data-jump="${escapeHtml(String(levelId))}">${label}</a>`
    : `<strong>${label}</strong>`;
}

// entry.affected_level / entry.action.Swapped.other_level are the real field
// names confirmed by the user's working Apps Script - used as-is, with
// fallbackName only for the position-history view where affected_level is
// implicitly "this level" and may be omitted by the API.
function describeChange(entry, fallbackName) {
  const type = actionTypeOf(entry) || 'Unknown';
  const d = actionDataOf(entry) || {};
  const lvl = entry.affected_level || {};
  const nameHtml = levelLinkHtml(lvl.name || fallbackName, lvl.level_id);
  switch (type) {
    case 'Placed':  return `${nameHtml} placed at #${d.new_position ?? '?'}`;
    case 'Raised':  return `${nameHtml} moved up: #${d.old_position ?? '?'} → #${d.new_position ?? '?'}`;
    case 'Lowered': return `${nameHtml} moved down: #${d.old_position ?? '?'} → #${d.new_position ?? '?'}`;
    case 'Swapped': {
      const other = d.other_level || {};
      const otherHtml = levelLinkHtml(other.name || 'another level', other.level_id);
      const pos = d.upper_position ?? d.lower_position;
      return `${nameHtml} swapped with ${otherHtml}${pos != null ? ` → #${pos}` : ''}`;
    }
    case 'Pending': return `${nameHtml} put on pending`;
    case 'Removed': return `${nameHtml} removed from the list`;
    case 'MovedToLegacy': return `${nameHtml} moved to the legacy list`;
    default:        return `${nameHtml} — ${escapeHtml(type)}`;
  }
}

let changelogPage = 1;
let changelogEntries = [];
let changelogHasMore = true;

async function loadChangelog(reset) {
  const el = $('#changelogState');
  if (reset) {
    changelogPage = 1;
    changelogEntries = [];
    changelogHasMore = true;
    $('#changelogList').innerHTML = '';
  }
  el.style.display = 'block';
  el.className = 'state';
  el.innerHTML = '<div class="spinner"></div>Loading changelog…';
  try {
    const data = await window.aredl.getChangelog(changelogPage);
    const list = Array.isArray(data) ? data : (data.data || []);
    if (reset && !list.length) throw new Error('Empty response');
    changelogEntries = changelogEntries.concat(list);
    changelogHasMore = list.length >= CHANGELOG_PAGE_SIZE;
    state.changelogLoaded = true;
    el.style.display = 'none';
    renderChangelog();
    $('#changelogRawZone').innerHTML = `${rawDetails(`Full API response (${changelogEntries.length.toLocaleString()} entries loaded)`, changelogEntries)}`;
  } catch (err) {
    el.className = 'state error';
    el.innerHTML = `Couldn't load the changelog (${escapeHtml(errMsg(err))}).`;
  }
}

const changelogFilter = new Set(); // action types currently being shown (empty = show everything)
const CHANGE_LABELS = { movedtolegacy: 'Legacy' };

function renderChangelog() {
  const typeKey = (entry) => String(actionTypeOf(entry) || '').toLowerCase();
  const shown = changelogEntries.filter(e => !changelogFilter.size || changelogFilter.has(typeKey(e)));

  document.querySelectorAll('[data-changelog-filter]').forEach(b => b.classList.toggle('active', changelogFilter.has(b.dataset.changelogFilter)));
  $('#changelogLegend').classList.toggle('filtering', changelogFilter.size > 0);
  $('#changelogFilterClear').hidden = !changelogFilter.size;

  const rows = shown.map(entry => {
    const type = typeKey(entry);
    const hex = ACTION_COLORS[type] || '#8b8b93';
    const label = CHANGE_LABELS[type] || String(actionTypeOf(entry) || '—');
    const created = entryDate(entry);
    return `<div class="change-entry" style="--c:${hex}">
      <span class="change-type">${escapeHtml(label)}</span>
      <span class="change-main">${describeChange(entry)}</span>
      <span class="change-date">
        ${created ? escapeHtml(created.toLocaleString()) : ''}
        ${created ? `<span class="rel">${escapeHtml(formatRelativeTime(created))}</span>` : ''}
      </span>
    </div>`;
  }).join('');

  const info = changelogFilter.size
    ? `<div class="changelog-info">${shown.length ? `Showing ${shown.length.toLocaleString()} of ${changelogEntries.length.toLocaleString()} loaded entries` : `No matching entries in the ${changelogEntries.length.toLocaleString()} loaded so far`}</div>`
    : '';
  const loadMore = changelogHasMore ? `<button class="btn btn-ghost" id="loadMoreChangelog" style="margin-top:6px;">Load more</button>` : '';
  $('#changelogList').innerHTML = info + rows + loadMore;
  document.getElementById('loadMoreChangelog')?.addEventListener('click', () => {
    changelogPage++;
    loadChangelog(false);
  });
}

// Clicking the coloured pills at the top filters the changelog by that kind of change.
$('#changelogLegend').addEventListener('click', (e) => {
  if (e.target.closest('#changelogFilterClear')) { changelogFilter.clear(); renderChangelog(); return; }
  const pill = e.target.closest('[data-changelog-filter]');
  if (!pill) return;
  const key = pill.dataset.changelogFilter;
  if (changelogFilter.has(key)) changelogFilter.delete(key); else changelogFilter.add(key);
  renderChangelog();
});
wireRefreshButton('changelogRefreshBtn', () => loadChangelog(true));

// ---------------------------------------------------------------------------
// Position history for a single level (confirmed endpoint). Exact per-row
// "resulting position" and "change" fields aren't confirmed, so those columns
// show the API's own value if present and "—" otherwise rather than a
// computed guess. Cause/Date are fully real (same action/affected_level
// shape the changelog uses).
// ---------------------------------------------------------------------------
let historyRaw = [];

function historyPosition(entry) {
  return entry.position ?? entry.resulting_position ?? entry.new_level_position ?? entry.new_position ?? null;
}
function historyChangeHtml(delta) {
  if (delta == null || delta === 0) return '—';
  const down = delta > 0; // position number went up -> rank got worse
  return `<span style="color:${down ? '#f87171' : '#4ade80'};font-weight:700;">${down ? '↓' : '↑'} ${Math.abs(delta)}</span>`;
}

// Passive framing for the history table ("X was placed above") vs the
// changelog's own active framing ("X placed at #N") - same real fields when
// the entry matches the confirmed changelog shape. When it doesn't (the
// history endpoint's exact shape was never independently verified), this
// falls back to a deep search for a level reference and/or a plain
// human-readable reason string, rather than printing a confusing
// "Unknown level — Unknown" for every row.
function describeHistoryCause(entry, fallbackName) {
  const type = actionTypeOf(entry);
  const d = actionDataOf(entry) || {};
  let lvl = entry.affected_level || d.affected_level || d.other_level || d.level || entry.level || entry.other_level || null;
  if (!lvl) lvl = findLevelRefDeep(d) || findLevelRefDeep(entry);

  const rawReason = (typeof entry.cause === 'string' ? entry.cause : null)
    || (typeof entry.reason === 'string' ? entry.reason : null)
    || (typeof entry.description === 'string' ? entry.description : null);
  const newPos = d.new_position ?? d.position ?? entry.new_position ?? entry.position;
  const otherHtml = levelLinkHtml((lvl && lvl.name) || fallbackName, lvl && lvl.level_id);

  switch (type) {
    // This level's own events - no need to name it, the table is already
    // scoped to it.
    case 'Placed':  return `Placed at #${newPos ?? '?'}`;
    case 'Raised':  return `Moved up to #${newPos ?? '?'}`;
    case 'Lowered': return `Moved down to #${newPos ?? '?'}`;
    case 'Swapped': {
      const other = d.other_level || {};
      return `Swapped with ${levelLinkHtml(other.name || 'another level', other.level_id)}`;
    }
    case 'Pending': return `Put on pending`;
    case 'Removed': return `Removed from the list`;
    case 'MovedToLegacy': return `Moved to the legacy list`;
    // Events caused by a *different* level, confirmed real type names.
    case 'OtherPlaced':    return `${otherHtml} was placed above`;
    case 'OtherMovedUp':
    case 'OtherRaised':    return `${otherHtml} was moved above`;
    case 'OtherMovedDown':
    case 'OtherLowered':   return `${otherHtml} was moved below`;
    case 'OtherRemoved':   return `${otherHtml} was removed`;
    case 'OtherMovedToLegacy': return `${otherHtml} was moved to legacy`;
    case 'OtherSwapped':   return `${otherHtml} swapped positions`;
    case 'OtherPending':   return `${otherHtml} was put on pending`;
    default:
      if (rawReason) return escapeHtml(rawReason);
      if (lvl) return `${otherHtml} — updated`;
      return type ? `— ${escapeHtml(type)}` : '—';
  }
}

function renderHistoryTable() {
  const group = $('#historyGroup')?.checked;
  const hideOther = $('#historyHideOther')?.checked;

  // historyRaw is newest-first. Each entry's "change" isn't a field the API
  // gives us directly (never confirmed to exist) - it's the difference
  // between this entry's resolved position and the *next* (older) entry's,
  // i.e. what actually happened at that point in time.
  let rows = historyRaw.map((entry, i) => {
    const pos = historyPosition(entry);
    const olderPos = i + 1 < historyRaw.length ? historyPosition(historyRaw[i + 1]) : null;
    const delta = typeof entry.position_diff === 'number' ? entry.position_diff
      : ((pos != null && olderPos != null) ? (pos - olderPos) : null);
    return { entry, pos, delta };
  });
  if (hideOther) rows = rows.filter(r => !String(actionTypeOf(r.entry) || '').startsWith('Other'));

  const built = [];
  if (group) {
    let i = 0;
    while (i < rows.length) {
      const type = actionTypeOf(rows[i].entry);
      let j = i;
      while (j + 1 < rows.length && actionTypeOf(rows[j + 1].entry) === type) j++;
      if (j > i) {
        const sum = rows.slice(i, j + 1).reduce((s, r) => s + (r.delta || 0), 0);
        built.push({ grouped: true, type, rows: rows.slice(i, j + 1), sumDelta: sum });
      } else {
        built.push(rows[i]);
      }
      i = j + 1;
    }
  } else {
    built.push(...rows);
  }

  const body = built.map(row => {
    if (row.grouped) {
      const first = row.rows[0].entry;
      const dateHtml = dateCellHtml(entryDate(first));
      const verb = {
        Placed: 'were placed', Raised: 'were raised', Lowered: 'were lowered',
        Pending: 'were put on pending', Removed: 'were removed', MovedToLegacy: 'were moved to legacy',
        OtherPlaced: 'were placed above', OtherMovedUp: 'were moved above', OtherRaised: 'were moved above',
        OtherMovedDown: 'were moved below', OtherLowered: 'were moved below',
        OtherRemoved: 'were removed', OtherSwapped: 'swapped positions', OtherPending: 'were put on pending',
      }[row.type] || (row.type ? `— ${row.type}` : '— updated');
      return `<tr>
        <td>${row.rows[0].pos != null ? '#' + row.rows[0].pos : '—'}</td>
        <td>${historyChangeHtml(row.sumDelta)}</td>
        <td><strong>${row.rows.length} levels</strong> ${escapeHtml(verb)}</td>
        <td class="hist-date">${dateHtml}</td>
      </tr>`;
    }
    const dateHtml = dateCellHtml(entryDate(row.entry));
    return `<tr>
      <td>${row.pos != null ? '#' + row.pos : '—'}</td>
      <td>${historyChangeHtml(row.delta)}</td>
      <td>${describeHistoryCause(row.entry)}</td>
      <td class="hist-date">${dateHtml}</td>
    </tr>`;
  }).join('');

  $('#historyTableBody').innerHTML = body || `<tr><td colspan="4" class="dim" style="text-align:center;padding:16px;">Nothing matches these filters.</td></tr>`;

  const rawZone = document.getElementById('historyRawZone');
  if (rawZone) {
    rawZone.innerHTML = `${rawDetails(`Full API response`, historyRaw)}`;
  }
}

async function loadLevelHistory(level) {
  const zone = document.getElementById('panelHistoryZone');
  if (!zone) return;
  zone.innerHTML = `<div class="section-label">Position History</div><div class="spinner" style="margin:10px auto;"></div>`;
  try {
    const cachedHistory = state.multi.size >= 2 ? multiHistoryCache.get(level.level_id) : null;
    const data = cachedHistory || await window.aredl.getLevelHistory(level.level_id);
    if (state.selectedId !== level.id) return; // selection changed while this was in flight
    if (!cachedHistory && state.multi.size >= 2) multiHistoryCache.set(level.level_id, data);
    const list = Array.isArray(data) ? data : (data.data || data.history || data.items || []);
    if (!list.length) {
      zone.innerHTML = `<div class="section-label">Position History</div><div class="dim">No history recorded.</div>`;
      return;
    }
    historyRaw = list;
    zone.innerHTML = `
      <div class="section-label">Position History</div>
      <div class="history-controls">
        <label><input type="checkbox" id="historyGroup"> Group similar entries</label>
        <label><input type="checkbox" id="historyHideOther"> Hide other levels' placements</label>
      </div>
      <table class="history-table">
        <thead><tr><th>Position</th><th>Change</th><th>Cause</th><th>Date</th></tr></thead>
        <tbody id="historyTableBody"></tbody>
      </table>
      <div id="historyRawZone" style="margin-top:8px;"></div>`;
    $('#historyGroup').addEventListener('change', renderHistoryTable);
    $('#historyHideOther').addEventListener('change', renderHistoryTable);
    renderHistoryTable();
  } catch (err) {
    if (state.selectedId === level.id) {
      zone.innerHTML = `<div class="section-label">Position History</div><div class="dim">Couldn't load history (${escapeHtml(errMsg(err))}).</div>`;
    }
  }
}

// ---------------------------------------------------------------------------
// Profile
// ---------------------------------------------------------------------------
function humanizeKey(k) {
  return k.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

// No confirmed field for this - checked defensively across a few likely
// names. Returns true/false when found, null when the data genuinely
// doesn't distinguish game modes (in which case the Platformer tab says so
// honestly instead of silently pretending to filter).
function isPlatformerLevel(l) {
  if (typeof l.is_platformer === 'boolean') return l.is_platformer;
  if (typeof l.platformer === 'boolean') return l.platformer;
  const m = l.gamemode || l.game_mode || l.level_type || l.mode;
  if (typeof m === 'string') return /platform/i.test(m);
  return null;
}
function platformerIsDetectable(levels) {
  return levels.some(l => isPlatformerLevel(l) !== null);
}

function formatValue(v) {
  if (v === null || v === undefined) return '—';
  if (typeof v === 'boolean') return v ? 'Yes' : 'No';
  if (typeof v === 'number') return v.toLocaleString();
  if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(v)) return new Date(v).toLocaleString();
  return String(v);
}

function avatarUrl(data) {
  if (data.discord_id && data.discord_avatar) {
    return `https://cdn.discordapp.com/avatars/${data.discord_id}/${data.discord_avatar}.png?size=128`;
  }
  return null;
}

// The API's raw `points` field is 10x what the site actually displays.
function formatPoints(p) {
  return ((p || 0) / 10).toLocaleString(undefined, { maximumFractionDigits: 2 });
}

function findLevelArrayDeep(obj, seen = new Set(), depth = 0) {
  if (!obj || typeof obj !== 'object' || seen.has(obj) || depth > 4) return null;
  seen.add(obj);
  for (const key of ['records', 'completed', 'completed_levels', 'beaten', 'beaten_levels', 'classic_records', 'demons']) {
    const v = obj[key];
    if (Array.isArray(v) && v.length && typeof v[0] === 'object') return v;
  }
  for (const v of Object.values(obj)) {
    if (Array.isArray(v) && v.length && typeof v[0] === 'object') {
      const sample = v[0];
      if ('level_id' in sample || 'position' in sample || (sample.level && typeof sample.level === 'object')) return v;
    }
  }
  for (const v of Object.values(obj)) {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const found = findLevelArrayDeep(v, seen, depth + 1);
      if (found) return found;
    }
  }
  return null;
}
// Only ever hand http(s) URLs from the API to a link.
function safeHttpUrl(u) {
  return (typeof u === 'string' && /^https?:\/\//i.test(u.trim())) ? u.trim() : null;
}

function extractOtherCompletedLevels(data) {
  const arr = findLevelArrayDeep(data);
  state.profileRecordVideos = new Map(); // level_id -> completion video url (their record, not a submission of yours)
  if (!arr) return [];
  return arr
    .map(item => {
      const lid = item.level_id ?? (item.level && item.level.level_id) ?? null;
      const iid = item.id ?? (item.level && item.level.id) ?? null;
      const level = state.levels.find(l => (lid != null && String(l.level_id) === String(lid)) || (iid != null && String(l.id) === String(iid)));
      if (level && !item.hide_video) {
        const url = safeHttpUrl(item.video_url);
        if (url) state.profileRecordVideos.set(String(level.level_id), url);
      }
      return level;
    })
    .filter(Boolean)
    .sort((a, b) => (a.position ?? 1e9) - (b.position ?? 1e9));
}

function packBannerHtml(p) {
  const tierName = p.tier && p.tier.name;
  const tierColor = p.tier && p.tier.color;
  return `<div class="pack-banner" style="${tierColor ? `background:${escapeHtml(tierColor)};` : ''}">
    <div class="pack-name">${escapeHtml(p.name || 'Pack')}</div>
    ${tierName ? `<div class="pack-tier">${escapeHtml(tierName)}</div>` : ''}
  </div>`;
}

function renderProfile(data, { isMe }) {
  $('#profileState').style.display = 'none';
  const displayName = data.global_name || data.username || (isMe ? 'You' : 'Player');
  const avatar = avatarUrl(data);
  const initials = displayName.slice(0, 2).toUpperCase();
  const flag = countryFlagHtml(data.country, 18);

  // For "me" the auth'd /levels/ response's own completion markers are used
  // (richer/guaranteed-fresh). For anyone else, the profile response itself
  // turns out to carry a completed-records array too - just under a field
  // name that has to be guessed at, same as everywhere else in this app.
  state.profileRecordVideos = new Map();
  const completedLevels = isMe
    ? state.levels.filter(l => state.completedIds.has(String(l.level_id))).sort((a, b) => (a.position ?? 1e9) - (b.position ?? 1e9))
    : extractOtherCompletedLevels(data);
  const packs = Array.isArray(data.packs) ? data.packs : [];
  state.profilePacks = packs;
  const createdLevels = state.levels.filter(l => String(l.publisher_id) === String(data.id));
  const hardestLevel = completedLevels[0] || null;
  const modeKnown = platformerIsDetectable(state.levels);
  const completedClassic = completedLevels.filter(l => isPlatformerLevel(l) !== true);
  const completedPlatformer = completedLevels.filter(l => isPlatformerLevel(l) === true);
  const createdClassic = createdLevels.filter(l => isPlatformerLevel(l) !== true);
  const createdPlatformer = createdLevels.filter(l => isPlatformerLevel(l) === true);
  const levelPoints = isMe ? completedLevels.reduce((sum, l) => sum + (l.points || 0), 0) : null;

  const rankObj = (data.rank && typeof data.rank === 'object') ? data.rank : null;
  const globalRankRows = [];
  const countryRankRows = [];
  if (rankObj) {
    Object.entries(rankObj).forEach(([k, v]) => {
      const row = `<div class="profile-rank-row"><span>${escapeHtml(humanizeKey(k))}</span><span>#${escapeHtml(formatValue(v))}</span></div>`;
      (k.toLowerCase().includes('country') ? countryRankRows : globalRankRows).push(row);
    });
  }
  const clanLabel = data.clan ? (typeof data.clan === 'string' ? data.clan : (data.clan.name || 'Member')) : 'None';

  $('#profileContent').innerHTML = `
    <div class="profile-page" id="profilePage">
      <div class="profile-layout">
        <div class="profile-side">
          ${avatar ? `<img class="profile-avatar" src="${avatar}" alt="">` : `<div class="profile-avatar-fallback">${escapeHtml(initials)}</div>`}
          <div class="profile-name">${flag}<span>${escapeHtml(displayName)}</span></div>
          <div class="profile-clan">CLAN: ${escapeHtml(clanLabel.toUpperCase())}</div>
          <p class="profile-bio">${data.description ? escapeHtml(data.description) : "This user hasn't provided a description yet."}</p>
          <div class="profile-mode-tabs">
            <span class="active" data-pmode="classic">CLASSIC (${completedClassic.length})</span>
            <span data-pmode="platformer" ${modeKnown ? '' : 'title="This app can\'t tell platformer levels apart from the data it gets"'}>PLATFORMER (${completedPlatformer.length})</span>
          </div>
          <div class="profile-point-trio">
            <div class="stat"><div class="stat-label">Level Points</div><div class="stat-value">${levelPoints != null ? formatPoints(levelPoints) : '—'}</div></div>
            <div class="stat"><div class="stat-label">Total Points</div><div class="stat-value">${levelPoints != null ? formatPoints(levelPoints) : '—'}</div></div>
            <div class="stat"><div class="stat-label">Pack Points</div><div class="stat-value">—</div></div>
          </div>
          ${globalRankRows.length ? `<div class="profile-rank-section"><h4>🌐 Global Rankings</h4>${globalRankRows.join('')}</div>` : ''}
          ${countryRankRows.length ? `<div class="profile-rank-section"><h4>📍 Country Rankings</h4>${countryRankRows.join('')}</div>` : ''}
        </div>
        <div class="profile-main">
          <div class="profile-main-tabs">
            <span class="active" data-ptab="completed">Completed (${completedLevels.length})</span>
            <span data-ptab="created">Created (${createdLevels.length})</span>
            <span data-ptab="packs">Packs (${packs.length})</span>
          </div>
          <div class="profile-search" id="profileSearchWrap"><input id="profileSearch" type="text" placeholder="Search levels" autocomplete="off"></div>
          <div id="profileTabContent"></div>
          ${rawDetails(`Raw API response`, data, ` style="margin-top:16px;"`)}
        </div>
      </div>
    </div>`;

  state.profileCompleted = { classic: completedClassic, platformer: completedPlatformer };
  state.profileCreated = { classic: createdClassic, platformer: createdPlatformer };
  state.profileMode = 'classic';
  renderProfileTab('completed');

  document.querySelectorAll('#profileContent [data-ptab]').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('#profileContent [data-ptab]').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      renderProfileTab(tab.dataset.ptab);
    });
  });

  let profileSearchTimer = null;
  $('#profileSearch').addEventListener('input', () => {
    clearTimeout(profileSearchTimer);
    profileSearchTimer = setTimeout(() => {
      const activePtab = document.querySelector('#profileContent [data-ptab].active');
      renderProfileTab(activePtab ? activePtab.dataset.ptab : 'completed');
    }, 140);
  });

  document.querySelectorAll('#profileContent [data-pmode]').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('#profileContent [data-pmode]').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      state.profileMode = tab.dataset.pmode;
      const activePtab = document.querySelector('#profileContent [data-ptab].active');
      renderProfileTab(activePtab ? activePtab.dataset.ptab : 'completed');
    });
  });

}

// Someone with hundreds of completions used to trigger hundreds of
// simultaneous level-detail requests (one per banner) the moment the profile
// rendered. Now a banner only fetches its background once it's near the
// scrolling area, so a long profile loads a handful at a time.
let bannerObserver = null;
function observeBannerBackgrounds(levels) {
  if (bannerObserver) bannerObserver.disconnect();
  const byId = new Map(levels.map(l => [String(l.level_id), l]));
  const root = document.querySelector('#profileContent .profile-main');
  bannerObserver = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      bannerObserver.unobserve(entry.target);
      const level = byId.get(entry.target.dataset.jump);
      if (level) attachCompletedBannerBg(level);
    }
  }, { root, rootMargin: '300px 0px' });
  document.querySelectorAll('#profileTabContent .completed-banner').forEach(el => bannerObserver.observe(el));
}

function renderProfileTab(which) {
  const zone = document.getElementById('profileTabContent');
  if (!zone) return;
  if (which === 'packs') {
    const packs = state.profilePacks || [];
    if (bannerObserver) bannerObserver.disconnect();
    $('#profileSearchWrap').hidden = true;
    zone.innerHTML = packs.length ? packs.map(packBannerHtml).join('') : '<div class="dim">Nothing found.</div>';
    return;
  }
  $('#profileSearchWrap').hidden = false;
  const bucket = which === 'created' ? state.profileCreated : state.profileCompleted;
  const levels = bucket ? bucket[state.profileMode || 'classic'] : [];
  if (state.profileMode === 'platformer' && !platformerIsDetectable(state.levels)) {
    zone.innerHTML = '<div class="dim">This app can\'t tell platformer levels apart in the data it receives, so nothing\'s shown here rather than guessing.</div>';
    return;
  }
  const q = ($('#profileSearch') || {}).value || '';
  const terms = searchTerms(q);
  const shown = terms.length
    ? levels.filter(l => {
        const hay = (l.name + ' ' + (l.tags || []).join(' ') + ' ' + (l.description || '')).toLowerCase();
        return terms.some(t => levelMatchesTerm(l, t, hay, String(l.name).toLowerCase()));
      })
    : levels;
  zone.innerHTML = shown.length ? shown.map(l => completedBannerHtml(l, which)).join('') : `<div class="dim">${terms.length ? 'No levels match that search.' : 'Nothing found.'}</div>`;
  observeBannerBackgrounds(shown);
}

function completedBannerHtml(l, kind = 'completed') {
  const isMe = state.currentProfileId === '__me__';
  let play;
  if (kind === 'created') {
    // A published level has no "completion video" - keep a neutral icon;
    // clicking the banner (or this) just opens the level in the list.
    play = `<div class="c-play" title="View this level">▶</div>`;
  } else if (isMe) {
    play = `<div class="c-play" data-play-submission="${l.level_id}" title="Open your submission">▶</div>`;
  } else {
    const video = state.profileRecordVideos && state.profileRecordVideos.get(String(l.level_id));
    play = video
      ? `<a class="c-play" href="${escapeHtml(video)}" target="_blank" rel="noopener" title="Watch their completion in your browser" onclick="event.stopPropagation()">▶</a>`
      : `<div class="c-play c-play-none" title="No completion video available" onclick="event.stopPropagation()">▶</div>`;
  }
  return `<div class="completed-banner" id="cbanner-${l.level_id}" data-jump="${l.level_id}">
    <span class="c-rank">${l.position != null ? '#' + l.position : (l.status || 'Legacy')}</span>
    <div class="c-main">
      <div class="c-name">${escapeHtml(l.name)}</div>
      <div class="c-meta">${formatPoints(l.points)} points</div>
    </div>
    ${play}
  </div>`;
}

// A submission's stable identity (its position in the list changes with the sort).
function subKey(item) {
  return String(item.id ?? subLevelId(item) ?? '');
}

// Exactly one submission is open at a time (or none), which is what lets
// back/forward restore "the submission you had open". Closing a card also
// tears its player down - otherwise a video keeps playing, hidden, after
// you collapse it or navigate away.
function setOpenSubmission(idx, { autoplay = false } = {}) {
  document.querySelectorAll('.submission-card.open').forEach(card => {
    card.classList.remove('open');
    pauseVideosIn(card); // stop the video right away even though the card eases shut
  });
  if (idx == null) {
    state.openSubmissionKey = null;
  } else {
    const card = document.getElementById(`sub-${idx}`);
    if (!card) return;
    card.classList.add('open');
    loadSubmissionBody(idx, { autoplay });
    state.openSubmissionKey = subKey(submissionsSorted[idx]);
  }
  pushNavState();
}

async function jumpToSubmission(levelId) {
  showTab('submissions');
  if (!state.submissionsLoaded) await loadSubmissions();
  const idx = submissionsSorted.findIndex(item => String(subLevelId(item)) === String(levelId));
  if (idx === -1) return;
  const card = document.getElementById(`sub-${idx}`);
  if (!card) return;
  setOpenSubmission(idx, { autoplay: true });
  card.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

document.addEventListener('click', (e) => {
  const playBtn = e.target.closest('[data-play-submission]');
  if (!playBtn) return;
  e.stopPropagation(); // don't also trigger the banner's own data-jump navigation
  jumpToSubmission(playBtn.dataset.playSubmission);
});

async function fetchDetailCached(levelId) {
  let detail = detailCache.get(levelId);
  if (!detail) {
    detail = await window.aredl.getLevelDetail(levelId);
    detailCache.set(levelId, detail);
  }
  return detail;
}

async function attachCompletedBannerBg(level) {
  try {
    const detail = await fetchDetailCached(level.level_id);
    const url = findYoutubeUrl(detail);
    const vid = url ? youtubeThumbId(url) : null;
    if (!vid) return;
    const el = document.getElementById(`cbanner-${level.level_id}`);
    if (el) {
      el.classList.add('has-bg');
      el.style.setProperty('--bg-thumb', `url(https://img.youtube.com/vi/${vid}/hqdefault.jpg)`);
    }
  } catch { /* leave it with the plain background */ }
}

async function attachProfileBackground(level) {
  try {
    const detail = await fetchDetailCached(level.level_id);
    const url = findYoutubeUrl(detail);
    const vid = url ? youtubeThumbId(url) : null;
    if (!vid) return;
    const page = document.getElementById('profilePage');
    if (page) {
      page.classList.add('has-bg');
      page.style.setProperty('--bg-thumb', `url(https://img.youtube.com/vi/${vid}/hqdefault.jpg)`);
    }
  } catch { /* leave it with the plain background */ }
}

async function lookupProfile(id) {
  state.currentProfileId = id;
  pushNavState();
  const el = $('#profileState');
  el.style.display = 'block';
  el.className = 'state';
  el.innerHTML = '<div class="spinner"></div>Loading profile…';
  $('#profileContent').innerHTML = '';
  try {
    const data = await window.aredl.getProfile(id);
    if (state.currentProfileId !== id) return; // you navigated elsewhere while this loaded
    renderProfile(data, { isMe: false });
  } catch (err) {
    if (state.currentProfileId !== id) return;
    el.className = 'state error';
    el.innerHTML = `Couldn't load that profile (${escapeHtml(errMsg(err))}).`;
  }
}

$('#profileLookupBtn').addEventListener('click', () => {
  const id = $('#profileLookup').value.trim();
  if (id) lookupProfile(id);
});

wireRefreshButton('profileRefreshBtn', async () => {
  if (state.currentProfileId === '__me__') return $('#myProfileBtn').click();
  if (state.currentProfileId) return lookupProfile(state.currentProfileId);
});
wireRefreshButton('submissionsRefreshBtn', loadSubmissions);
wireRefreshButton('notifRefreshBtn', loadNotifications);
wireRefreshButton('settingsRefreshBtn', async () => { await refreshAuthStatus(); await loadApiLog(); });

$('#myProfileBtn').addEventListener('click', async () => {
  if (!state.signedIn) {
    showTab('settings');
    return;
  }
  state.currentProfileId = '__me__';
  pushNavState();
  const el = $('#profileState');
  el.style.display = 'block';
  el.className = 'state';
  el.innerHTML = '<div class="spinner"></div>Loading your profile…';
  $('#profileContent').innerHTML = '';
  try {
    const data = await window.aredl.getMyProfile();
    if (state.currentProfileId !== '__me__') return; // you navigated elsewhere while this loaded
    renderProfile(data, { isMe: true });
  } catch (err) {
    if (state.currentProfileId !== '__me__') return;
    el.className = 'state error';
    el.innerHTML = `
      Couldn't auto-detect your profile (${escapeHtml(errMsg(err))}).
      Paste your own publisher ID below (the same kind of ID used in level publisher links) and it'll be remembered from then on.
      <div class="signin-row" style="margin-top:10px;max-width:420px;">
        <input id="myIdInput" type="text" placeholder="Your publisher ID">
        <button class="btn" id="myIdSaveBtn">Save</button>
      </div>`;
    document.getElementById('myIdSaveBtn').onclick = async () => {
      const id = document.getElementById('myIdInput').value.trim();
      if (!id) return;
      try {
        const data = await window.aredl.setMyId(id);
        renderProfile(data, { isMe: true });
      } catch (e2) {
        el.className = 'state error';
        el.innerHTML = `Couldn't verify that ID (${escapeHtml(errMsg(e2))}).`;
      }
    };
  }
});

// ---------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------
// Same id rule main.js uses when it polls for new notifications.
function notifId(item, index) {
  return String(item.id ?? item.notification_id ?? item.uuid ?? `${item.created_at || item.date || ''}-${index}`);
}
let notifAll = [];           // everything the API returned, in order
let clearedNotifIds = null;  // Set of ids hidden by the user (saved in the app's data folder)
const NOTIF_TYPE_COLORS = { failure: '#f87171', success: '#22c55e', info: '#3b82f6', warning: '#eab308' };

async function saveClearedNotifs() {
  try { await window.aredl.setClearedNotifications([...clearedNotifIds]); }
  catch (err) { showToast(`Couldn't save: ${errMsg(err)}`); }
}

function bumpNotifBadge(n) {
  const badge = $('#notifBadge');
  badge.hidden = false;
  badge.textContent = (parseInt(badge.textContent || '0', 10) || 0) + n;
}

// API notifications and local "followed level" updates are shown as one list, newest first.
function renderNotifications() {
  const el = $('#notifState');
  const api = notifAll.map((item, i) => ({ item, id: notifId(item, i) })).filter(n => !clearedNotifIds.has(n.id)).map(({ item, id }) => ({
    id,
    text: item.content || item.message || item.title || item.body || JSON.stringify(item),
    type: item.notification_type || null,
    hex: item.notification_type ? (NOTIF_TYPE_COLORS[String(item.notification_type).toLowerCase()] || '#8b8b93') : null,
    date: entryDate(item),
    local: false,
  }));
  const followed = followNotifs.map(n => ({
    id: `f:${n.id}`,
    text: `${n.level_name}: ${n.text}`,
    type: 'followed',
    hex: 'var(--accent)',
    date: n.at ? new Date(n.at) : null,
    local: true,
  }));
  const all = [...followed, ...api].sort((a, b) => (b.date ? b.date.getTime() : 0) - (a.date ? a.date.getTime() : 0));

  $('#notifClearAllBtn').hidden = !all.length;
  if (!all.length) {
    $('#notifList').innerHTML = '';
    el.className = 'state';
    el.style.display = 'block';
    el.textContent = state.signedIn ? 'No notifications.' : 'No notifications yet. Sign in from Settings to also see your account notifications.';
    return;
  }
  el.style.display = 'none';
  $('#notifList').innerHTML = all.map(n => `<div class="notif-item" style="--c:${n.hex || 'var(--accent)'}">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:10px;">
        <span>${escapeHtml(n.text)}</span>
        <span class="notif-right">
          ${n.type ? `<span class="tag" style="color:${n.hex};border-color:${n.hex};flex:none;">${escapeHtml(n.type)}</span>` : ''}
          <button class="notif-clear" data-notif-clear="${escapeHtml(n.id)}" title="Clear this notification" aria-label="Clear this notification">✕</button>
        </span>
      </div>
      ${n.date ? `<div class="date">${escapeHtml(n.date.toLocaleString())} · ${escapeHtml(formatRelativeTime(n.date))}</div>` : ''}
    </div>`).join('');
}

async function loadNotifications() {
  const el = $('#notifState');
  el.style.display = 'block';
  el.className = 'state';
  el.innerHTML = '<div class="spinner"></div>Loading…';
  try {
    if (!clearedNotifIds) {
      try { clearedNotifIds = new Set((await window.aredl.getClearedNotifications()).map(String)); }
      catch { clearedNotifIds = new Set(); }
    }
    await loadFollowStores();
    const badge = $('#notifBadge');
    badge.hidden = true; // you're looking at them now
    badge.textContent = '0';
    if (!state.signedIn) {
      notifAll = [];
      state.notifLoaded = true;
      $('#notifRawZone').innerHTML = '';
      renderNotifications();
      return;
    }
    const data = await window.aredl.getNotifications();
    notifAll = Array.isArray(data) ? data : (data.data || data.notifications || data.items || data.results || []);
    state.notifLoaded = true;
    $('#notifRawZone').innerHTML = notifAll.length
      ? `${rawDetails(`Full API response`, data)}`
      : '';
    renderNotifications();
  } catch (err) {
    // account notifications failed - still show the followed-level updates we have locally
    notifAll = [];
    renderNotifications();
    if (!followNotifs.length) {
      el.style.display = 'block';
      el.className = 'state error';
      el.innerHTML = `Couldn't load notifications (${escapeHtml(errMsg(err))}).`;
    }
  }
}

$('#notifList').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-notif-clear]');
  if (!btn || !clearedNotifIds) return;
  const id = btn.dataset.notifClear;
  if (id.startsWith('f:')) {
    followNotifs = followNotifs.filter(n => `f:${n.id}` !== id);
    saveFollowNotifs();
  } else {
    clearedNotifIds.add(id);
    saveClearedNotifs();
  }
  renderNotifications();
});

$('#notifClearAllBtn').addEventListener('click', () => {
  if (!clearedNotifIds) return;
  notifAll.forEach((item, i) => clearedNotifIds.add(notifId(item, i)));
  saveClearedNotifs();
  followNotifs = [];
  saveFollowNotifs();
  renderNotifications();
  showToast('Notifications cleared');
});

window.aredl.onNewNotifications(() => {
  const badge = $('#notifBadge');
  badge.hidden = false;
  badge.textContent = (parseInt(badge.textContent || '0', 10) || 0) + 1;
  state.notifLoaded = false; // refetch next time the tab is opened
});

// ---------------------------------------------------------------------------
// Submissions (confirmed endpoint: GET /aredl/submissions/@me, auth required)
//
// Field names below are best-effort guesses (unverified shape). Each card's
// background uses the *original level's* video thumbnail (fetched via the
// same getLevelDetail/detailCache used by the Demon List tab), while the
// expanded body embeds the *submitted* video - these are two different
// videos per the user's clarification.
// ---------------------------------------------------------------------------
const SUBMISSION_STATUS_COLORS = {
  pending: '#eab308',
  claimed: '#3b82f6',
  'under consideration': '#fb923c',
  denied: '#f87171', rejected: '#f87171',
  accepted: '#22c55e', approved: '#22c55e',
  'under review': '#a78bfa',
};

function subLevelId(item) {
  return item.level_id ?? (item.level && item.level.level_id) ?? (item.affected_level && item.affected_level.level_id) ?? null;
}
function subLevelName(item) {
  return personName(item.level) || item.level_name || (item.affected_level && item.affected_level.name) || 'Unknown level';
}
function subStatus(item) { return item.status || item.state || 'pending'; }
function subCreated(item) { return item.created_at || item.submitted_at || item.date || null; }
function subUpdated(item) { return item.updated_at || item.last_changed || item.changed_at || subCreated(item); }
function subQueuePosition(item) { return item.queue_position ?? item.position ?? item.rank ?? null; }

let submissionsData = [];
let submissionsSorted = [];

function submissionLevelPosition(item) {
  const levelId = subLevelId(item);
  const level = levelId != null ? state.levels.find(l => String(l.level_id) === String(levelId)) : null;
  return level && level.position != null ? level.position : 1e9;
}

function sortSubmissions(list, mode) {
  const arr = list.slice();
  if (mode === 'submitted') arr.sort((a, b) => new Date(subCreated(b) || 0) - new Date(subCreated(a) || 0));
  else if (mode === 'position') arr.sort((a, b) => (subQueuePosition(a) ?? 1e9) - (subQueuePosition(b) ?? 1e9));
  else if (mode === 'status') arr.sort((a, b) => String(subStatus(a)).localeCompare(String(subStatus(b))) || (submissionLevelPosition(a) - submissionLevelPosition(b)));
  else arr.sort((a, b) => new Date(subUpdated(b) || 0) - new Date(subUpdated(a) || 0)); // 'changed' (default)
  return arr;
}

async function loadSubmissions() {
  const el = $('#submissionsState');
  if (!state.signedIn) {
    el.style.display = 'block';
    el.textContent = 'Sign in from Settings to see your submissions.';
    return;
  }
  el.style.display = 'block';
  el.className = 'state';
  el.innerHTML = '<div class="spinner"></div>Loading…';
  try {
    const data = await window.aredl.getSubmissions();
    submissionsData = Array.isArray(data) ? data : (data.data || data.submissions || data.items || data.results || []);
    state.submissionsLoaded = true;
    el.style.display = 'none';
    $('#submissionsRawZone').innerHTML = `${rawDetails(`Full API response (${submissionsData.length.toLocaleString()} submissions)`, submissionsData)}`;
    if (!submissionsData.length) {
      el.style.display = 'block';
      el.textContent = 'No submissions.';
      $('#submissionsList').innerHTML = '';
      return;
    }
    renderSubmissions();
  } catch (err) {
    el.className = 'state error';
    el.innerHTML = `Couldn't load submissions (${escapeHtml(errMsg(err))}).`;
  }
}

function renderSubmissions() {
  submissionsSorted = sortSubmissions(submissionsData, $('#submissionsSortBy').value);
  state.openSubmissionKey = null; // the list is rebuilt with every card closed
  $('#submissionsList').innerHTML = submissionsSorted.map((item, i) => {
    const name = subLevelName(item);
    const status = subStatus(item);
    const hex = SUBMISSION_STATUS_COLORS[String(status).toLowerCase()] || '#8b8b93';
    const created = subCreated(item);
    const levelId = subLevelId(item);
    const listedLevel = levelId != null ? state.levels.find(l => String(l.level_id) === String(levelId)) : null;
    const positionPrefix = listedLevel && listedLevel.position != null
      ? `<span class="title-pos">#${listedLevel.position}</span><span class="title-divider"></span>`
      : '';
    return `<div class="submission-card" id="sub-${i}" style="--c:${hex}">
      <div class="submission-head" data-toggle-sub="${i}">
        <div class="submission-main">
          <strong>${positionPrefix}${escapeHtml(name)}${listedLevel ? `<button class="icon-tool sub-jump" data-jump="${escapeHtml(String(listedLevel.level_id))}" data-tip="Show in Demon List" aria-label="Show in Demon List"><svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 6h12M4 10h12M4 14h7"/></svg></button>` : ''}</strong>
          <div class="submission-meta">
            <span class="tag status-tag">${escapeHtml(status)}</span>
            <span class="tag" id="squeue-${i}">Queue …</span>
            ${created ? `<span class="dim-inline">${escapeHtml(new Date(created).toLocaleDateString())} · ${escapeHtml(formatRelativeTime(new Date(created)))}</span>` : ''}
          </div>
        </div>
        <svg class="sub-chevron" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M5 8l5 5 5-5"/></svg>
      </div>
      <div class="collapse" id="sub-collapse-${i}"><div class="collapse-inner"><div class="submission-body" id="sub-body-${i}"></div></div></div>
    </div>`;
  }).join('');

  submissionsSorted.forEach((item, i) => {
    attachSubmissionBg(item, i);
    attachSubmissionQueue(item, i);
  });
}

// Confirmed endpoint: GET /aredl/submissions/{submissionID}/queue
async function attachSubmissionQueue(item, i) {
  const id = item.id ?? item.submission_id ?? item.submissionId;
  const el = document.getElementById(`squeue-${i}`);
  if (id == null) { el?.remove(); return; }
  try {
    const data = await window.aredl.getSubmissionQueue(id);
    const pos = (typeof data === 'number') ? data : (data.position ?? data.queue_position ?? data.rank ?? null);
    const el2 = document.getElementById(`squeue-${i}`);
    if (!el2) return;
    if (pos != null) el2.textContent = `Queue #${pos}`;
    else el2.remove();
  } catch {
    document.getElementById(`squeue-${i}`)?.remove();
  }
}

// Lazily resolve each card's background to the *original level's* video
// thumbnail (not the submitted video), reusing the same detail cache the
// Demon List tab uses so a level only gets fetched once either way.
async function attachSubmissionBg(item, i) {
  const levelId = subLevelId(item);
  if (!levelId) return;
  try {
    let detail = detailCache.get(levelId);
    if (!detail) {
      detail = await window.aredl.getLevelDetail(levelId);
      detailCache.set(levelId, detail);
    }
    const url = findYoutubeUrl(detail);
    const vid = url ? youtubeThumbId(url) : null;
    if (!vid) return;
    const card = document.getElementById(`sub-${i}`);
    if (card) {
      card.classList.add('has-bg');
      card.style.setProperty('--bg-thumb', `url(https://img.youtube.com/vi/${vid}/hqdefault.jpg)`);
    }
  } catch {
    // no original video available - leave the card with its plain background
  }
}

function loadSubmissionBody(i, opts = {}) {
  const item = submissionsSorted[i];
  const body = document.getElementById(`sub-body-${i}`);
  if (!body || !item) return;
  if (body.dataset.loaded && !opts.autoplay) {
    // already built - just make sure its video has a player again
    const again = body.querySelector('.video-slot');
    if (again && again._ctx) dockPlay({ vid: again.dataset.vid, slot: again, title: again._ctx.title, onReturn: again._ctx.onReturn });
    return;
  }
  body.dataset.loaded = '1';

  const video = findYoutubeUrl(item);
  const vid = video ? youtubeThumbId(video) : null;
  let html = '';
  if (video) {
    html += `<div class="section-label">Submitted video</div>`;
    html += vid
      ? slotHtml(vid)
      : `<a class="video-fallback" href="${escapeHtml(video)}" target="_blank" rel="noopener">▶ Watch on YouTube ↗</a>`;
  } else {
    html += `<div class="dim">No video found on this submission.</div>`;
  }

  const updated = subUpdated(item);
  html += `<div class="stat-grid" style="margin-top:10px;">
    <div class="stat"><div class="stat-label">Status</div><div class="stat-value">${escapeHtml(subStatus(item))}</div></div>
    ${updated ? `<div class="stat"><div class="stat-label">Last changed</div><div class="stat-value">${escapeHtml(new Date(updated).toLocaleString())}<br><span class="dim-inline">${escapeHtml(formatRelativeTime(new Date(updated)))}</span></div></div>` : ''}
  </div>`;
  html += `${rawDetails(`Full submission data`, item)}`;
  body.innerHTML = html;

  const slot = body.querySelector('.video-slot');
  if (slot) {
    const title = subLevelName(item);
    const onReturn = () => { showTab('submissions'); setOpenSubmission(i); document.getElementById(`sub-${i}`)?.scrollIntoView({ block: 'center' }); };
    dockPlay({ vid: slot.dataset.vid, slot, title, onReturn, autoplay: !!opts.autoplay });
  }
}

document.addEventListener('click', (e) => {
  if (e.target.closest('[data-jump]')) return; // the jump button inside a submission shouldn't also open it
  const head = e.target.closest('[data-toggle-sub]');
  if (!head) return;
  const i = Number(head.dataset.toggleSub);
  const card = document.getElementById(`sub-${i}`);
  if (!card) return;
  setOpenSubmission(card.classList.contains('open') ? null : i);
});

$('#submissionsSortBy').addEventListener('change', () => {
  if (state.submissionsLoaded) renderSubmissions();
});

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Animated dropdowns. Native <select> popups can't be animated, so each select
// is kept (it still holds the value and fires "change") but is shown through a
// button + menu that expands and contracts.
// ---------------------------------------------------------------------------
function enhanceSelect(sel) {
  if (sel.dataset.dd) return;
  sel.dataset.dd = '1';
  const wrap = document.createElement('div');
  wrap.className = 'dd';
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'dd-btn';
  btn.innerHTML = '<span class="dd-label"></span><svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 8l5 5 5-5"/></svg>';
  sel.parentNode.insertBefore(wrap, sel);
  wrap.appendChild(btn);
  wrap.appendChild(sel);
  sel.style.display = 'none';

  const label = btn.querySelector('.dd-label');
  const dotFor = (o) => (o && o.dataset.color ? `<i class="dd-dot" style="background:${escapeHtml(o.dataset.color)}"></i>` : '');
  const refresh = () => { const o = sel.options[sel.selectedIndex]; label.innerHTML = dotFor(o) + escapeHtml(o ? o.textContent : ''); };
  // setting select.value from code should update the button too
  const desc = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value');
  Object.defineProperty(sel, 'value', { configurable: true, get() { return desc.get.call(sel); }, set(v) { desc.set.call(sel, v); refresh(); } });
  new MutationObserver(refresh).observe(sel, { childList: true, subtree: true, characterData: true });
  sel.addEventListener('change', refresh);
  refresh();

  let menu = null;
  const outside = (e) => { if (menu && !menu.contains(e.target) && !btn.contains(e.target)) close(); };
  function close() {
    if (!menu) return;
    const m = menu;
    menu = null;
    btn.classList.remove('open');
    m.classList.add('closing');
    setTimeout(() => m.remove(), 140);
    document.removeEventListener('mousedown', outside, true);
    window.removeEventListener('blur', close);
    window.removeEventListener('resize', close);
  }
  function open() {
    menu = document.createElement('div');
    menu.className = 'dd-menu';
    [...sel.options].forEach(o => {
      if (o.disabled || o.hidden) return;
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'dd-item' + (o.value === sel.value ? ' selected' : '');
      item.textContent = o.textContent;
      if (o.dataset.color) { item.classList.add('colored'); item.style.setProperty('--c', o.dataset.color); }
      item.addEventListener('click', () => {
        sel.value = o.value;
        sel.dispatchEvent(new Event('change', { bubbles: true }));
        close();
      });
      menu.appendChild(item);
    });
    document.body.appendChild(menu);
    const r = btn.getBoundingClientRect();
    const vw = window.innerWidth, vh = window.innerHeight, PAD = 10;
    menu.style.minWidth = r.width + 'px';
    menu.style.maxWidth = (vw - 2 * PAD) + 'px';
    menu.style.maxHeight = (vh - 2 * PAD) + 'px';
    let mr = { width: menu.offsetWidth, height: menu.offsetHeight }; // layout size - getBoundingClientRect would be scaled by the opening animation
    const spaceBelow = vh - r.bottom - PAD - 6, spaceAbove = r.top - PAD - 6;
    const flip = mr.height > spaceBelow && spaceAbove > spaceBelow;
    menu.style.maxHeight = Math.max(120, Math.min(vh - 2 * PAD, flip ? spaceAbove : spaceBelow)) + 'px';
    mr = { width: menu.offsetWidth, height: menu.offsetHeight };
    const left = Math.min(Math.max(r.left, PAD), Math.max(PAD, vw - mr.width - PAD));
    const top = flip ? r.top - mr.height - 6 : r.bottom + 6;
    menu.style.left = left + 'px';
    menu.style.top = Math.min(Math.max(top, PAD), Math.max(PAD, vh - mr.height - PAD)) + 'px';
    menu.classList.toggle('up', flip);
    btn.classList.add('open');
    menu.querySelector('.selected')?.scrollIntoView({ block: 'nearest' });
    document.addEventListener('mousedown', outside, true);
    window.addEventListener('blur', close);
    window.addEventListener('resize', close);
  }
  btn.addEventListener('click', () => (menu ? close() : open()));
  btn.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
}
document.querySelectorAll('select').forEach(enhanceSelect);

// ---------------------------------------------------------------------------
// Sliders: a filled rail, a round handle, a value bubble while you hover/drag, and
// - when there are only a few steps (like 0-1-2) - a dot for every step. A slider with a
// data-default gets a small mark where the default sits.
// ---------------------------------------------------------------------------
function enhanceSlider(inp) {
  if (inp.dataset.sl) return;
  inp.dataset.sl = '1';
  inp.removeAttribute('list');
  const wrap = document.createElement('div');
  wrap.className = 'slider';
  inp.parentNode.insertBefore(wrap, inp);
  // rail = the line the handle's centre travels along; the visible track pokes out past both ends
  const rail = document.createElement('div');
  rail.className = 'slider-rail';
  rail.innerHTML = '<div class="slider-track"></div><div class="slider-fill"></div>';
  const fill = rail.querySelector('.slider-fill');
  const bubble = document.createElement('div');
  bubble.className = 'slider-bubble';
  wrap.appendChild(rail);
  wrap.appendChild(inp);
  wrap.appendChild(bubble);

  const min = Number(inp.min) || 0, max = Number(inp.max) || 100, step = Number(inp.step) || 1;
  const steps = Math.round((max - min) / step);
  const few = steps <= 6; // few options: a dot and a label at every step
  const dots = [], ticks = [];
  if (few) {
    wrap.classList.add('has-ticks');
    for (let i = 0; i <= steps; i++) {
      const d = document.createElement('i');
      d.className = 'slider-dot';
      d.style.left = (i / steps * 100) + '%';
      rail.appendChild(d);
      dots.push(d);
      const t = document.createElement('span');
      t.className = 'slider-tick';
      t.style.left = `calc(11px + (100% - 22px) * ${i / steps})`;
      t.textContent = String(min + i * step);
      wrap.appendChild(t);
      ticks.push(t);
    }
  }
  const mark = document.createElement('i');
  mark.className = 'slider-default';
  mark.dataset.tip = 'Default';
  rail.appendChild(mark);

  const refresh = () => {
    const val = Number(inp.value);
    const pct = (val - min) / (max - min);
    fill.style.width = `calc(8px + ${pct * 100}%)`;
    dots.forEach((d, i) => d.classList.toggle('on', i / steps <= pct + 1e-6));
    ticks.forEach((t, i) => t.classList.toggle('on', Math.abs(i / steps - pct) < 1e-6));
    bubble.textContent = inp.value + (inp.dataset.suffix || '');
    bubble.style.left = `calc(11px + (100% - 22px) * ${pct})`;
    bubble.style.display = few ? 'none' : '';
    const def = inp.dataset.default;
    mark.style.display = def !== undefined && def !== '' ? 'block' : 'none';
    if (mark.style.display === 'block') mark.style.left = ((Number(def) - min) / (max - min) * 100) + '%';
    wrap.classList.toggle('disabled', inp.disabled);
  };
  const desc = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
  Object.defineProperty(inp, 'value', { configurable: true, get() { return desc.get.call(inp); }, set(v) { desc.set.call(inp, v); refresh(); } });
  inp.addEventListener('input', refresh);
  inp.addEventListener('pointerdown', () => wrap.classList.add('dragging'));
  window.addEventListener('pointerup', () => wrap.classList.remove('dragging'));
  new MutationObserver(refresh).observe(inp, { attributes: true, attributeFilter: ['disabled', 'data-default'] });
  inp._refresh = refresh;
  refresh();
}
document.querySelectorAll('input[type=range]').forEach(enhanceSlider);

// ---------------------------------------------------------------------------
// Tooltips. Any element's `title` attribute is turned into data-tip (the browser's
// own grey tooltip never appears) and shown in a themed bubble after a short hover.
// ---------------------------------------------------------------------------
(function initTooltips() {
  const tip = document.createElement('div');
  tip.id = 'tip';
  document.body.appendChild(tip);
  const convert = (root) => {
    if (!root || root.nodeType !== 1) return;
    const fix = (el) => { const t = el.getAttribute('title'); if (t != null) { if (t) el.dataset.tip = t; el.removeAttribute('title'); } };
    fix(root);
    root.querySelectorAll('[title]').forEach(fix);
  };
  convert(document.body);
  new MutationObserver((muts) => {
    for (const m of muts) {
      if (m.type === 'attributes') convert(m.target);
      else m.addedNodes.forEach(convert);
    }
  }).observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['title'] });

  let target = null, timer = null;
  const hide = () => { clearTimeout(timer); target = null; tip.classList.remove('show'); };
  const show = (el) => {
    const text = el.dataset.tip;
    if (!text || !el.isConnected) return;
    tip.textContent = text;
    tip.style.maxWidth = '280px';
    tip.classList.add('show');
    const r = el.getBoundingClientRect();
    const tr = tip.getBoundingClientRect();
    let left = r.left + r.width / 2 - tr.width / 2;
    left = Math.min(Math.max(left, 8), window.innerWidth - tr.width - 8);
    let top = r.bottom + 8;
    if (top + tr.height > window.innerHeight - 8) top = r.top - tr.height - 8;
    tip.style.left = left + 'px';
    tip.style.top = Math.max(8, top) + 'px';
  };
  document.addEventListener('mouseover', (e) => {
    const el = e.target.closest && e.target.closest('[data-tip]');
    if (el === target) return;
    hide();
    if (!el) return;
    target = el;
    timer = setTimeout(() => show(el), 350);
  });
  document.addEventListener('mousedown', hide, true);
  document.addEventListener('scroll', hide, true);
  window.addEventListener('blur', hide);
})();

(async function init() {
  await initSettings();
  if (appSettings.startTab && appSettings.startTab !== 'list') showTab(appSettings.startTab);
  await refreshAuthStatus();
  window.appBooted = true; // settings are loaded: tour.js (loaded after this file) starts the first-open tour from this signal
  window.dispatchEvent(new Event('aredl:ready'));
  await loadLevels();
  startFollowing();
})();

loadFavourites();
