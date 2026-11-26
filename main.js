const { app, BrowserWindow, Tray, Menu, Notification, ipcMain, safeStorage, nativeImage, shell, dialog, screen, session } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');

// ---------------------------------------------------------------------------
// Single instance lock - without this, every launch (double-clicking the
// exe again, `npm start` while one is already running, etc.) spawns a brand
// new process with its own local server, tray icon and notification poller.
// Since the window hides to tray instead of quitting on close (so polling
// keeps working), those extra processes never went away on their own and
// just piled up. Now a second launch just focuses the existing window.
// ---------------------------------------------------------------------------
if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

// Gives Windows a stable identity for this app, so pinning it to the taskbar,
// its right-click jump list and grouping all use the app's own name and icon
// instead of falling back to "Electron". (Deliberately not app.setName() -
// that would change the userData folder and lose the saved API key.)
const APP_ID = 'net.aredl.desktop.unofficial';
if (process.platform === 'win32') app.setAppUserModelId(APP_ID);

// Real on-disk path of a bundled file. Windows can't read icons out of app.asar, so anything the
// taskbar needs lives in app.asar.unpacked (see "asarUnpack" in package.json).
function unpackedPath(...parts) {
  const p = path.join(__dirname, ...parts);
  return app.isPackaged ? p.replace(/app\.asar(?!\.)/, 'app.asar.unpacked') : p;
}

// Tells the Windows taskbar who this window is: the icon, the name shown at the top of its right-click
// menu, and the command that pinning it should run. Without this, a window started from electron.exe
// (npm start) - or one whose exe lost its icon/name - shows up as "Electron" with the Electron icon, and
// pinning it pins electron.exe instead of this app. After this, the app describes itself.
function applyTaskbarIdentity(win) {
  if (process.platform !== 'win32') return;
  try {
    const portableExe = process.env.PORTABLE_EXECUTABLE_FILE; // set by the portable build: the file you double-clicked
    const relaunchCommand = portableExe
      ? `"${portableExe}"`
      : (app.isPackaged ? `"${process.execPath}"` : `"${process.execPath}" "${app.getAppPath()}"`);
    win.setAppDetails({
      appId: APP_ID,
      appIconPath: unpackedPath('assets', 'icon.ico'),
      appIconIndex: 0,
      relaunchCommand,
      relaunchDisplayName: 'AREDL Desktop',
    });
  } catch (err) {
    console.warn('Could not set the taskbar identity:', err && err.message);
  }
}

// ---------------------------------------------------------------------------
// API configuration
//
// levels, notifications, profile: confirmed working (levels + profile via
// live testing, notifications via a 401-without-auth check).
// changelog: confirmed working shape, reverse-engineered from a working
// Google Apps Script the user already had (paginated, ?page=N, {data: [...]}).
// There is no confirmed "who am I" endpoint - /users/@me does not appear to
// exist. See getMyProfile() below for how "My profile" is handled instead.
// ---------------------------------------------------------------------------
const API_BASE = 'https://api.aredl.net/v2/api';

// Classic levels live under /aredl/..., platformer ones under /arepl/... - the same endpoints otherwise.
const apiPrefix = (mode) => (mode === 'platformer' ? 'arepl' : 'aredl');
const ENDPOINTS = {
  levels: (mode) => `${API_BASE}/${apiPrefix(mode)}/levels/?exclude_pending=false&exclude_removed=false`,
  levelDetail: (levelId, mode) => `${API_BASE}/${apiPrefix(mode)}/levels/${levelId}`, // confirmed by user
  levelCreators: (levelId, mode) => `${API_BASE}/${apiPrefix(mode)}/levels/${levelId}/creators`, // confirmed by user
  levelHistory: (levelId, mode) => `${API_BASE}/${apiPrefix(mode)}/levels/${levelId}/history`, // confirmed by user
  levelRecords: (levelId, page, mode) => `${API_BASE}/${apiPrefix(mode)}/levels/${levelId}/records?page=${page}&per_page=100`, // confirmed endpoint; 100 per page means fewer requests (the page shows 50 at a time either way)
  submissions: (mode) => `${API_BASE}/${apiPrefix(mode)}/submissions/@me`, // confirmed by user
  submissionQueue: (id, mode) => `${API_BASE}/${apiPrefix(mode)}/submissions/${id}/queue`, // confirmed by user
  notifications: `${API_BASE}/users/@me/notifications`, // one feed for the account, not per list
  profile: (id, mode) => `${API_BASE}/${apiPrefix(mode)}/profile/${id}`,
  changelog: (page, mode) => `${API_BASE}/${apiPrefix(mode)}/changelog?page=${page}`,
  packTiers: (mode) => `${API_BASE}/${apiPrefix(mode)}/pack-tiers`,
  levelPacks: (levelId, mode) => `${API_BASE}/${apiPrefix(mode)}/levels/${levelId}/packs`,
  customCopies: (levelId, mode) => `${API_BASE}/${apiPrefix(mode)}/levels/${levelId}/custom-copies`, // one level's custom copies (confirmed)
  leaderboard: (page, mode, per = 50) => `${API_BASE}/${apiPrefix(mode)}/leaderboard?page=${page}&per_page=${per}`,
  countries: (page, mode) => `${API_BASE}/${apiPrefix(mode)}/leaderboard/countries?page=${page}&per_page=50`,
  country: (id, mode) => `${API_BASE}/${apiPrefix(mode)}/country/${encodeURIComponent(id)}`,
};

const CHANGELOG_PAGE_SIZE = 20;
const NOTIFICATION_POLL_MS = 2 * 60 * 1000; // check every 2 minutes

const userDataDir = () => app.getPath('userData');
const credsPath = () => path.join(userDataDir(), 'credentials.bin');
const seenPath = () => path.join(userDataDir(), 'seen-notifications.json');
const meIdPath = () => path.join(userDataDir(), 'me-id.json');
const favouritesPath = () => path.join(userDataDir(), 'favourites.json');
const settingsPath = () => path.join(userDataDir(), 'settings.json');
const clearedNotifsPath = () => path.join(userDataDir(), 'cleared-notifications.json');

let mainWindow = null;
let tray = null;
let pollTimer = null;
let cachedApiKey = null; // decrypted, kept only in memory while running

// App preferences (theme, nav placement, ...) live in the app's data folder.
// localStorage can't be used for this: the renderer's origin includes a
// random port, so it would reset on every launch.
function loadSettings() {
  try {
    const data = JSON.parse(fs.readFileSync(settingsPath(), 'utf8'));
    return data && typeof data === 'object' ? data : {};
  } catch {
    return {};
  }
}
function saveSettings(patch) {
  const merged = { ...loadSettings(), ...patch };
  fs.writeFileSync(settingsPath(), JSON.stringify(merged));
  return merged;
}

// ---------------------------------------------------------------------------
// Secret storage (OS keychain-backed via Electron's safeStorage)
// ---------------------------------------------------------------------------
function saveApiKey(key) {
  if (!safeStorage.isEncryptionAvailable()) {
    fs.writeFileSync(credsPath(), key, 'utf8');
    return;
  }
  const encrypted = safeStorage.encryptString(key);
  fs.writeFileSync(credsPath(), encrypted);
}

function loadApiKey() {
  if (cachedApiKey) return cachedApiKey;
  if (!fs.existsSync(credsPath())) return null;
  const raw = fs.readFileSync(credsPath());
  try {
    cachedApiKey = safeStorage.isEncryptionAvailable()
      ? safeStorage.decryptString(raw)
      : raw.toString('utf8');
  } catch {
    cachedApiKey = null;
  }
  return cachedApiKey;
}

function clearApiKey() {
  cachedApiKey = null;
  if (fs.existsSync(credsPath())) fs.unlinkSync(credsPath());
  if (fs.existsSync(meIdPath())) fs.unlinkSync(meIdPath());
}

// ---------------------------------------------------------------------------
// "Who am I" - there's no confirmed identity endpoint, so we remember
// whatever ID has worked before (either the "@me" guess, or one the user
// pasted in manually via Settings) and reuse it.
// ---------------------------------------------------------------------------
function loadMyId() {
  try {
    return JSON.parse(fs.readFileSync(meIdPath(), 'utf8')).id || null;
  } catch {
    return null;
  }
}

function saveMyId(id) {
  fs.writeFileSync(meIdPath(), JSON.stringify({ id }));
}

// Many APIs like this issue JWT-style bearer tokens with the user's own id
// in the payload. We don't verify the signature (we don't have the secret,
// and don't need to - we're just reading a claim from our own token), so
// this is best-effort and wrapped in try/catch throughout.
function tryDecodeJwtId(token) {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const json = Buffer.from(parts[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    const payload = JSON.parse(json);
    return payload.sub || payload.user_id || payload.uid || payload.id || null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Request log - so the user can see every API call this app makes, with
// timestamps, from Settings.
// ---------------------------------------------------------------------------
const requestLog = [];
const REQUEST_LOG_MAX = 500;

function logRequest(entry) {
  if (!entry.kind) entry.kind = 'api'; // 'api' = api.aredl.net, 'misc' = everything else (song lookups...)
  requestLog.push(entry);
  if (requestLog.length > REQUEST_LOG_MAX) requestLog.shift();
  if (mainWindow) mainWindow.webContents.send('requestLog:new', entry);
}

// What a response says about its own rate limit (when the server sends it): the limit, what is left, and how long to wait after a 429.
function rateInfo(res) {
  const h = res && res.headers;
  if (!h || typeof h.get !== 'function') return {};
  const n = (k) => { const v = h.get(k); return v != null && v !== '' && Number.isFinite(Number(v)) ? Number(v) : undefined; };
  return { rlLimit: n('x-ratelimit-limit'), rlRemaining: n('x-ratelimit-remaining'), retryAfter: n('retry-after') };
}

// Turns an error response into just the human-readable reason (e.g. "You are
// being rate limited") instead of dumping the status, URL and raw JSON.
function reasonFromErrorBody(text, status) {
  try {
    const j = JSON.parse(text);
    const reason = j.detail || j.message || j.error_description || (typeof j.error === 'string' ? j.error : null) || j.title;
    if (reason) return String(reason);
  } catch { /* not JSON - fall through */ }
  const plain = String(text || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  if (plain && plain.length <= 160) return plain;
  return status ? `HTTP ${status}` : 'Request failed';
}

// ---------------------------------------------------------------------------
// API helper - attaches the API key whenever one is stored (this is also
// how the demon list gets per-user completion data: the same /levels/
// endpoint returns extra fields when called with auth).
// ---------------------------------------------------------------------------
async function apiFetch(url, { requireAuth = false } = {}) {
  const headers = { Accept: 'application/json' };
  const key = loadApiKey();
  if (requireAuth && !key) throw new Error('Not signed in');
  if (key) headers.Authorization = `Bearer ${key}`;

  const startedAt = Date.now();
  let res, err;
  try {
    res = await fetch(url, { headers });
  } catch (networkErr) {
    err = networkErr;
  }

  if (err || !res.ok) {
    const text = res ? await res.text().catch(() => '') : '';
    const status = res ? res.status : null;
    logRequest({ url, status, ok: false, timestamp: startedAt, error: err ? err.message : text.slice(0, 200), ...rateInfo(res) });
    if (err) throw err;
    const e = new Error(reasonFromErrorBody(text, status));
    e.status = status;
    throw e;
  }

  logRequest({ url, status: res.status, ok: true, timestamp: startedAt, ...rateInfo(res) });
  return res.json();
}

// ---------------------------------------------------------------------------
// Notification polling -> native OS notifications
// ---------------------------------------------------------------------------
function loadSeenIds() {
  try {
    return new Set(JSON.parse(fs.readFileSync(seenPath(), 'utf8')));
  } catch {
    return new Set();
  }
}

function saveSeenIds(set) {
  fs.writeFileSync(seenPath(), JSON.stringify([...set].slice(-500)));
}

function idFor(item, index) {
  return String(item.id ?? item.notification_id ?? item.uuid ?? `${item.created_at || item.date || ''}-${index}`);
}

function textFor(item) {
  return item.message || item.title || item.body || item.text || 'New AREDL notification';
}

async function pollNotifications() {
  if (!loadApiKey()) return;
  try {
    const data = await apiFetch(ENDPOINTS.notifications, { requireAuth: true });
    const list = Array.isArray(data) ? data : (data.data || data.notifications || data.items || data.results || []);
    if (!Array.isArray(list) || !list.length) return;

    const seen = loadSeenIds();
    const fresh = list.filter((item, i) => !seen.has(idFor(item, i)));
    const isFirstRun = seen.size === 0;

    for (const [i, item] of list.entries()) seen.add(idFor(item, i));
    saveSeenIds(seen);

    if (isFirstRun) return; // don't blast old notifications as toasts on first sign-in

    for (const item of fresh) {
      const n = new Notification({
        title: 'AREDL',
        body: textFor(item),
        icon: path.join(__dirname, 'assets', 'icon.png'),
      });
      n.on('click', () => {
        if (mainWindow) {
          mainWindow.show();
          mainWindow.webContents.send('navigate', 'notifications');
        }
      });
      n.show();
    }

    if (mainWindow && fresh.length) {
      mainWindow.webContents.send('notifications:new', fresh);
    }
  } catch (err) {
    console.error('Notification poll failed:', err.message);
  }
}

function startPolling() {
  stopPolling();
  pollNotifications();
  pollTimer = setInterval(pollNotifications, NOTIFICATION_POLL_MS);
}

function stopPolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
}

// ---------------------------------------------------------------------------
// Local static server - the renderer used to load via file://, but YouTube's
// embed permission check rejects the file:// origin outright for a lot of
// videos (this is the "Error 153" the user hit - it's an origin problem, not
// really "YouTube being broken"). A real http://127.0.0.1 origin fixes that
// for anything that doesn't specifically domain-restrict its embeds.
// ---------------------------------------------------------------------------
const MIME_TYPES = {
  '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css',
  '.png': 'image/png', '.ico': 'image/x-icon', '.svg': 'image/svg+xml', '.json': 'application/json',
};
let localServerPort = null;

// ---- a custom backdrop (an image, GIF or video the person chose) ----
const BG_TYPES = {
  '.png': ['image', 'image/png'], '.jpg': ['image', 'image/jpeg'], '.jpeg': ['image', 'image/jpeg'], '.webp': ['image', 'image/webp'], '.gif': ['image', 'image/gif'], '.avif': ['image', 'image/avif'], '.bmp': ['image', 'image/bmp'],
  '.mp4': ['video', 'video/mp4'], '.m4v': ['video', 'video/mp4'], '.webm': ['video', 'video/webm'], '.mov': ['video', 'video/quicktime'], '.ogv': ['video', 'video/ogg'],
};
const BG_MAX_BYTES = 500 * 1024 * 1024;
const customBgFile = () => { const ext = String(loadSettings().bgCustomExt || ''); return BG_TYPES[ext] ? path.join(app.getPath('userData'), `custom-bg${ext}`) : null; };
function serveCustomBg(req, res) {
  const file = customBgFile();
  let size = 0; try { size = file ? fs.statSync(file).size : 0; } catch { size = 0; }
  if (!size) { res.writeHead(404); res.end(); return; }
  const type = BG_TYPES[path.extname(file)][1];
  const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
  let start = 0, end = size - 1, code = 200;
  if (m && (m[1] || m[2])) { // a video asks for the part it needs
    if (m[1]) { start = Number(m[1]); if (m[2]) end = Math.min(end, Number(m[2])); } else { start = Math.max(0, size - Number(m[2])); }
    if (start > end || start >= size) { res.writeHead(416, { 'Content-Range': `bytes */${size}` }); res.end(); return; }
    code = 206;
  }
  const head = { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Content-Length': end - start + 1, 'Cache-Control': 'no-cache' };
  if (code === 206) head['Content-Range'] = `bytes ${start}-${end}/${size}`;
  res.writeHead(code, head);
  fs.createReadStream(file, { start, end }).on('error', () => res.destroy()).pipe(res);
}
const customBgInfo = () => { const s = loadSettings(), ok = !!customBgFile() && fs.existsSync(customBgFile()); return { on: ok && s.bgCustomOn === true, has: ok, type: ok ? (BG_TYPES[s.bgCustomExt] || [])[0] || null : null, name: ok ? String(s.bgCustomName || '') : '', ver: Number(s.bgCustomVer) || 0 }; };
ipcMain.handle('bg:info', async () => customBgInfo());
ipcMain.handle('bg:pickCustom', async () => {
  const r = await dialog.showOpenDialog(mainWindow, {
    title: 'Choose a backdrop', properties: ['openFile'],
    filters: [{ name: 'Images, GIFs and videos', extensions: Object.keys(BG_TYPES).map(e => e.slice(1)) }],
  });
  if (r.canceled || !r.filePaths[0]) return { ok: false, canceled: true };
  const src = r.filePaths[0], ext = path.extname(src).toLowerCase();
  if (!BG_TYPES[ext]) return { ok: false, error: 'That kind of file can’t be used as a backdrop.' };
  let size = 0; try { size = fs.statSync(src).size; } catch { return { ok: false, error: 'That file couldn’t be read.' }; }
  if (size > BG_MAX_BYTES) return { ok: false, error: 'That file is larger than 500 MB.' };
  try {
    for (const e of Object.keys(BG_TYPES)) fs.rmSync(path.join(app.getPath('userData'), `custom-bg${e}`), { force: true });
    fs.copyFileSync(src, path.join(app.getPath('userData'), `custom-bg${ext}`));
  } catch (err) { return { ok: false, error: `That file couldn’t be copied (${err.message}).` }; }
  saveSettings({ bgCustomOn: true, bgCustomExt: ext, bgCustomName: path.basename(src).slice(0, 120), bgCustomVer: Date.now() });
  return { ok: true, ...customBgInfo() };
});
ipcMain.handle('bg:setCustomOn', async (_e, on) => { saveSettings({ bgCustomOn: !!on && !!customBgFile() }); return customBgInfo(); });
ipcMain.handle('bg:clearCustom', async () => {
  for (const e of Object.keys(BG_TYPES)) { try { fs.rmSync(path.join(app.getPath('userData'), `custom-bg${e}`), { force: true }); } catch { /* already gone */ } }
  saveSettings({ bgCustomOn: false, bgCustomExt: '', bgCustomName: '' });
  return customBgInfo();
});

function startLocalServer() {
  return new Promise((resolve) => {
    const rendererDir = path.join(__dirname, 'renderer');
    const server = http.createServer((req, res) => {
      const urlPath = decodeURIComponent(req.url.split('?')[0]);
      if (urlPath === '/_bg/current') { serveCustomBg(req, res); return; }
      let filePath = path.join(rendererDir, urlPath === '/' ? 'index.html' : urlPath);
      if (!filePath.startsWith(rendererDir)) { res.writeHead(403); res.end(); return; }
      fs.readFile(filePath, (err, data) => {
        if (err) { res.writeHead(404); res.end('Not found'); return; }
        res.writeHead(200, { 'Content-Type': MIME_TYPES[path.extname(filePath).toLowerCase()] || 'application/octet-stream', 'Referrer-Policy': 'strict-origin-when-cross-origin' }); // (what YouTube's player asks pages to use)
        res.end(data);
      });
    });
    server.listen(0, '127.0.0.1', () => {
      localServerPort = server.address().port;
      resolve();
    });
  });
}


// Links can now come from API data (e.g. a record's video_url), so only ever
// hand http(s) URLs to the OS - never file:, custom protocols, etc.
function openExternalSafe(url) {
  try {
    const u = new URL(url);
    if (u.protocol === 'http:' || u.protocol === 'https:') shell.openExternal(u.toString());
  } catch { /* malformed url - ignore */ }
}

// The renderer keeps its own back/forward history (see navBack/navForward in app.js);
// this just tells it when a mouse side button was pressed.
function sendNavCommand(dir) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('nav:cmd', dir);
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1060,
    height: 740,
    minWidth: 720,
    minHeight: 480,
    backgroundColor: '#0a0a0c',
    icon: path.join(__dirname, 'assets', process.platform === 'win32' ? 'icon.ico' : 'icon.png'),
    // Windows: hide the stock title bar and let the page draw its own, while
    // keeping the real window buttons (so snap layouts, double-click-to-maximise,
    // dragging and resizing all behave exactly as normal). Other platforms keep
    // their normal frame (Mac: see below).
    ...(process.platform === 'win32' ? {
      titleBarStyle: 'hidden',
      titleBarOverlay: { ...(loadSettings().overlay || { color: '#00000000', symbolColor: '#a1a1aa' }), height: 36 },
    } : {}),
    // Mac: the same idea - the page draws the title bar, and the Mac's red / yellow / green window buttons stay,
    // lined up in the middle of its 36px height.
    ...(process.platform === 'darwin' ? {
      titleBarStyle: 'hidden',
      trafficLightPosition: { x: 14, y: 12 },
    } : {}),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  applyTaskbarIdentity(mainWindow);
  mainWindow.loadURL(`http://127.0.0.1:${localServerPort}/index.html`);

  // Mouse back/forward side buttons. On Windows they arrive as `app-command` events
  // on the window (the renderer also sees the raw button presses; it ignores a repeat).
  mainWindow.on('app-command', (_e, cmd) => {
    if (cmd === 'browser-backward') sendNavCommand('back');
    else if (cmd === 'browser-forward') sendNavCommand('forward');
  });

  // Never render external content inside the app - any link (target="_blank",
  // window.open, or a stray navigation) goes to the system default browser.
  // F11 toggles fullscreen (there is no menu bar, so no built-in shortcut).
  mainWindow.webContents.on('before-input-event', (e, input) => {
    if (input.type === 'keyDown' && input.key === 'F11') {
      e.preventDefault();
      mainWindow.setFullScreen(!mainWindow.isFullScreen());
    }
  });
  // the idle screen takes the whole screen (title bar and window buttons included) and gives it back as it was found
  let idleFsWas = null;
  ipcMain.handle('window:idleFullscreen', async (_e, on) => {
    if (!mainWindow || mainWindow.isDestroyed()) return false;
    if (on) { if (idleFsWas === null) { idleFsWas = mainWindow.isFullScreen(); if (!idleFsWas) mainWindow.setFullScreen(true); } }
    else if (idleFsWas !== null) { const was = idleFsWas; idleFsWas = null; if (!was && mainWindow.isFullScreen()) mainWindow.setFullScreen(false); }
    return true;
  });
  const sendFullscreen = (on) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('window:fullscreen', on);
  };
  mainWindow.on('enter-full-screen', () => sendFullscreen(true));
  mainWindow.on('leave-full-screen', () => sendFullscreen(false));

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    openExternalSafe(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith(`http://127.0.0.1:${localServerPort}`)) {
      e.preventDefault();
      openExternalSafe(url);
    }
  });

  mainWindow.on('close', (e) => {
    if (!app.isQuiting) {
      e.preventDefault();
      // closing the app's window (the X) also closes the videos: every player window goes, and the page is told so nothing keeps playing in it either
      pDestroyAll();
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('win:closed');
      mainWindow.hide();
    }
  });
  // a video that is playing carries on in the floating player while the app is minimised or tucked away, and comes back when the app does
  const tell = (name) => { if (!app.isQuiting && mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(name); };
  pwFollowMainWindow(mainWindow);
  mainWindow.on('minimize', () => tell('win:away'));
  mainWindow.on('hide', () => tell('win:away'));
  mainWindow.on('restore', () => tell('win:back'));
  mainWindow.on('show', () => tell('win:back'));
}

function createTray() {
  // Orange "A" on a transparent background (the full app icon is a black square,
  // which disappears into the dark tray flyout). One image per DPI scale so it
  // stays sharp at 100% / 150% / 200% / 300% display scaling.
  const icon = nativeImage.createEmpty();
  for (const [scaleFactor, size] of [[1, 16], [1.5, 24], [2, 32], [3, 48]]) {
    const file = path.join(__dirname, 'assets', `tray-${size}.png`);
    if (fs.existsSync(file)) icon.addRepresentation({ scaleFactor, buffer: fs.readFileSync(file) });
  }
  tray = new Tray(icon);
  tray.setToolTip('AREDL Desktop');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open', click: () => mainWindow && mainWindow.show() },
    { type: 'separator' },
    { label: 'Quit', click: () => { app.isQuiting = true; app.quit(); } },
  ]));
  tray.on('click', () => mainWindow && mainWindow.show());
}

// ---------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------
// Small JSON lists kept in the app's data folder (followed levels and the
// update notifications they produce). Only these names are allowed.
const STORE_NAMES = new Set(['following', 'follow-notifications', 'personal-list', 'custom-lists', 'saved-filters', 'thumb-overrides']);
const storePath = (name) => path.join(userDataDir(), `${name}.json`);
ipcMain.handle('store:get', async (_e, name) => {
  if (!STORE_NAMES.has(name)) return [];
  try {
    const data = JSON.parse(fs.readFileSync(storePath(name), 'utf8'));
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
});
ipcMain.handle('store:set', async (_e, name, data) => {
  if (!STORE_NAMES.has(name)) return false;
  fs.writeFileSync(storePath(name), JSON.stringify(Array.isArray(data) ? data : []));
  return true;
});

// ---- Song names ----
// Looked up only when the music button on a level is clicked, never in the background. The name comes from the song's
// Newgrounds page; the Geometry Dash server is asked at the same time as a backup (and for the artist if the page
// doesn't give one). Every successful lookup is remembered on disk, so each song is only ever fetched once.
const SONG_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const songCachePath = () => path.join(userDataDir(), 'song-names.json');
let songCache = null;
function loadSongCache() {
  if (songCache) return songCache;
  try {
    const data = JSON.parse(fs.readFileSync(songCachePath(), 'utf8'));
    songCache = data && typeof data === 'object' && !Array.isArray(data) ? data : {};
  } catch { songCache = {}; }
  return songCache;
}
function saveSongCache() { try { fs.writeFileSync(songCachePath(), JSON.stringify(songCache)); } catch { /* the name still shows this session */ } }
function decodeEntities(str) {
  return String(str)
    .replace(/&#x([0-9a-f]+);/gi, (_m, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_m, d) => String.fromCodePoint(Number(d)))
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ').trim();
}
function metaContent(html, prop) {
  const a = new RegExp(`<meta[^>]+(?:property|name)=["']${prop}["'][^>]*?content=["']([^"']*)["']`, 'i').exec(html);
  if (a) return decodeEntities(a[1]);
  const b = new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]*?(?:property|name)=["']${prop}["']`, 'i').exec(html);
  return b ? decodeEntities(b[1]) : '';
}
// every request that isn't to the AREDL API is written to the log too (as 'misc'), so Settings shows everything the app sends
async function miscFetch(url, options, what) {
  const startedAt = Date.now();
  let res;
  try { res = await fetch(url, options); }
  catch (err) { logRequest({ kind: 'misc', what, url, status: null, ok: false, timestamp: startedAt, error: err.message }); throw err; }
  const redirected = !!options && options.redirect === 'manual' && res.status >= 300 && res.status < 400; // a redirect that was asked to be looked at, not followed
  logRequest({ kind: 'misc', what, url, status: res.status, ok: res.ok || res.status === 404 || redirected, timestamp: startedAt, error: res.ok || redirected ? undefined : `HTTP ${res.status}`, ...rateInfo(res) });
  return res;
}
async function fetchNewgroundsSong(id) {
  const res = await miscFetch(`https://www.newgrounds.com/audio/listen/${id}`, {
    headers: { 'User-Agent': SONG_UA, Accept: 'text/html,application/xhtml+xml', 'Accept-Language': 'en-US,en;q=0.8' },
    redirect: 'follow',
    signal: AbortSignal.timeout(9000),
  }, `Looked up song ${id} on Newgrounds`);
  if (res.status === 404) throw new Error('That song is not on Newgrounds (removed?)');
  if (!res.ok) throw new Error(`Newgrounds answered ${res.status}`);
  const html = await res.text();
  let name = '', artist = '';
  // structured data first, when the page has it
  for (const mt of html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const walk = (o) => {
        if (!o || typeof o !== 'object') return;
        if (Array.isArray(o)) { o.forEach(walk); return; }
        if (!name && typeof o.name === 'string' && (o.byArtist || o.author || /Music|Audio/i.test(String(o['@type'] || '')))) {
          name = decodeEntities(o.name);
          const who = o.byArtist || o.author;
          artist = decodeEntities(typeof who === 'string' ? who : (who && who.name) || '');
        }
        Object.values(o).forEach(walk);
      };
      walk(JSON.parse(mt[1]));
    } catch { /* not JSON we can use */ }
  }
  if (!name) name = metaContent(html, 'og:title') || metaContent(html, 'twitter:title');
  if (!name) { const t = /<title[^>]*>([^<]*)<\/title>/i.exec(html); if (t) name = decodeEntities(t[1]); }
  name = name.replace(/\s*[-|–]\s*Newgrounds(\.com)?\s*$/i, '').replace(/\s+on Newgrounds\s*$/i, '').trim();
  if (!artist) artist = metaContent(html, 'og:audio:artist') || metaContent(html, 'music:musician_name') || metaContent(html, 'author');
  if (!name) throw new Error('Could not find the song name on its Newgrounds page');
  return { name, artist };
}
// Geometry Dash's own song lookup - the reply is "key~|~value~|~key~|~value...", with 2 = name and 4 = artist.
async function fetchGdSong(id) {
  const res = await miscFetch('https://www.boomlings.com/database/getGJSongInfo.php', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': '' },
    body: `songID=${id}&secret=Wmfd2893gb7`,
    signal: AbortSignal.timeout(7000),
  }, `Looked up song ${id} on the game server`);
  const text = (await res.text()).trim();
  if (!res.ok || !text.includes('~|~')) throw new Error('The game server has no such song');
  const parts = text.split('~|~'), map = {};
  for (let i = 0; i + 1 < parts.length; i += 2) map[parts[i]] = parts[i + 1];
  return { name: decodeEntities(map['2'] || ''), artist: decodeEntities(map['4'] || '') };
}
// every song name known so far, for showing on level cards without asking for anything
ipcMain.handle('song:getCache', async () => {
  const c = loadSongCache(), out = {};
  for (const [id, v] of Object.entries(c)) if (v && typeof v.name === 'string') out[id] = { name: v.name, artist: v.artist || '' };
  return out;
});
// Looks up many songs one after another, slowly (about one a second) so Newgrounds isn't hammered. Only runs when asked.
const songBulk = { running: false, stop: false, total: 0, done: 0, failed: 0, current: null, startedAt: 0 };
const sendSongProgress = () => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('song:bulkProgress', { ...songBulk }); };
ipcMain.handle('song:bulkStart', async (_e, ids) => {
  if (songBulk.running) return { ok: false, error: 'Already running.' };
  const cache = loadSongCache();
  const todo = [...new Set((Array.isArray(ids) ? ids : []).map(Number).filter(n => Number.isInteger(n) && n > 0 && n <= 1e9 && !cache[n]))].slice(0, 5000);
  Object.assign(songBulk, { running: true, stop: false, total: todo.length, done: 0, failed: 0, current: null, startedAt: Date.now() });
  sendSongProgress();
  (async () => {
    for (const id of todo) {
      if (songBulk.stop) break;
      songBulk.current = id;
      let ok = false;
      try { ok = (await lookupSong(id, false)).ok; } catch { ok = false; }
      songBulk.done++; if (!ok) songBulk.failed++;
      sendSongProgress();
      await new Promise(r => setTimeout(r, 1100));
    }
    songBulk.running = false; songBulk.current = null;
    sendSongProgress();
  })();
  return { ok: true, total: todo.length };
});
ipcMain.handle('song:bulkStop', async () => { songBulk.stop = true; sendSongProgress(); return true; });
ipcMain.handle('song:bulkStatus', async () => ({ ...songBulk }));
const songInflight = new Map();
async function lookupSong(id, force = false) {
  const cache = loadSongCache();
  if (cache[id] && !force) return { ok: true, id, ...cache[id] };
  // the game server (boomlings) is asked first; Newgrounds is only asked when it had no answer
  let name = '', artist = '', ngErr = null;
  try { const gd = await fetchGdSong(id); name = gd.name; artist = gd.artist; } catch { /* no answer from the game server */ }
  if (!name) {
    try { const ng = await fetchNewgroundsSong(id); name = ng.name; artist = ng.artist; } catch (err) { ngErr = err; }
  }
  if (!name) {
    if (cache[id]) return { ok: true, id, ...cache[id] }; // asked again and couldn't: the earlier answer still stands
    return { ok: false, id, error: ngErr ? ngErr.message : 'Song not found' };
  }
  cache[id] = { name, artist: artist || '' };
  saveSongCache();
  return { ok: true, id, ...cache[id] };
}
// Spotify: if the Spotify app is installed, search inside it (spotify:search:...); otherwise the search opens on the web.
// Only this fixed kind of link is ever built here - the renderer just sends the words to search for.
ipcMain.handle('song:openSpotify', async (_e, query) => {
  const q = String(query || '').trim().slice(0, 200);
  if (!q) return { ok: false };
  try {
    if (typeof app.getApplicationInfoForProtocol === 'function') {
      const info = await app.getApplicationInfoForProtocol('spotify:');
      if (info && (info.name || info.path)) {
        await shell.openExternal(`spotify:search:${encodeURIComponent(q)}`);
        return { ok: true, inApp: true };
      }
    }
  } catch { /* nothing is registered for spotify: links - use the web */ }
  openExternalSafe(`https://open.spotify.com/search/${encodeURIComponent(q)}`);
  return { ok: true, inApp: false };
});
ipcMain.handle('song:getInfo', async (_e, rawId, opts) => {
  const id = Number(rawId);
  if (!Number.isInteger(id) || id <= 0 || id > 1e9) return { ok: false, error: 'Invalid song ID' };
  const force = !!(opts && opts.force);
  const key = `${id}:${force}`;
  if (!songInflight.has(key)) songInflight.set(key, lookupSong(id, force).finally(() => songInflight.delete(key)));
  try { return await songInflight.get(key); } catch (err) { return { ok: false, id, error: err.message || 'Lookup failed' }; }
});

// ---- Export / import: settings, and the lists you keep (the rules live in settings-transfer.js) ----
// Never included: the account / API key (credentials.bin is never read here).
const transfer = require('./settings-transfer');
const readList = (file) => { try { const d = JSON.parse(fs.readFileSync(file, 'utf8')); return Array.isArray(d) ? d : []; } catch { return []; } };
// the file each part lives in
const TRANSFER_FILES = {
  settings: settingsPath,
  favourites: favouritesPath,
  lists: () => storePath('custom-lists'),
  filters: () => storePath('saved-filters'),
  demonlist: () => storePath('thumb-overrides'),
  following: () => storePath('following'),
  followNotifications: () => storePath('follow-notifications'),
  personal: () => storePath('personal-list'),
  notifications: clearedNotifsPath,
};
const FILES_OF = { // which files each part of an import touches
  settings: ['settings'], favourites: ['favourites'], lists: ['lists'], filters: ['filters'], demonlist: ['demonlist'], following: ['following', 'followNotifications'], personal: ['personal'], notifications: ['notifications'],
};
// a custom backdrop small enough to ride along inside the Google Drive save file (see settings-transfer.js)
function backdropForSync() {
  try {
    const f = customBgFile();
    if (!f || !fs.existsSync(f) || fs.statSync(f).size > transfer.MAX_SYNC_BACKDROP) return undefined;
    return { ext: path.extname(f), name: String(loadSettings().bgCustomName || '').slice(0, 120), data: fs.readFileSync(f).toString('base64') };
  } catch { return undefined; }
}
function applySyncedBackdrop(bg) { // the file from the save file becomes this computer's custom backdrop (left alone when identical)
  const dir = app.getPath('userData'), target = path.join(dir, `custom-bg${bg.ext}`), bytes = Buffer.from(bg.data, 'base64');
  const same = (() => { try { return fs.existsSync(target) && fs.readFileSync(target).equals(bytes); } catch { return false; } })();
  if (same) return { bgCustomExt: bg.ext, bgCustomName: bg.name };
  for (const e of Object.keys(BG_TYPES)) fs.rmSync(path.join(dir, `custom-bg${e}`), { force: true });
  fs.writeFileSync(target, bytes);
  return { bgCustomExt: bg.ext, bgCustomName: bg.name, bgCustomVer: Date.now() };
}
function gatherTransferSources() {
  return {
    settings: { ...loadSettings(), bgCustomFile: backdropForSync() },
    favourites: readList(TRANSFER_FILES.favourites()),
    customLists: readList(TRANSFER_FILES.lists()),
    savedFilters: readList(TRANSFER_FILES.filters()),
    thumbOverrides: readList(TRANSFER_FILES.demonlist()),
    following: readList(TRANSFER_FILES.following()),
    followNotifications: readList(TRANSFER_FILES.followNotifications()),
    personal: readList(TRANSFER_FILES.personal()),
    clearedNotifications: readList(TRANSFER_FILES.notifications()),
  };
}
const pickSections = (list) => (Array.isArray(list) ? transfer.SECTION_IDS.filter(id => list.includes(id)) : []);
const countLine = (doc) => transfer.SECTIONS
  .filter(s => doc.sections.includes(s.id))
  .map(s => {
    const n = s.id === 'settings' ? Object.keys(doc.settings).length : s.id === 'following' ? (doc.data.following || []).length : (doc.data[s.id] || []).length;
    return { id: s.id, label: s.label, count: n };
  });

// A single custom list as one line of text (AREDL-LIST:...), for sharing; and back again (cleaned like any import)
const LIST_PREFIX = 'AREDL-LIST:';
ipcMain.handle('list:toText', async (_e, list) => {
  const c = transfer.cleanList('lists', [{ ...(list || {}), id: 'x' }]).items[0];
  if (!c) return { ok: false };
  return { ok: true, text: LIST_PREFIX + require('zlib').deflateSync(Buffer.from(JSON.stringify({ name: c.name, items: c.items }))).toString('base64url') };
});
ipcMain.handle('list:fromText', async (_e, input) => {
  const bad = { ok: false, error: "That doesn't look like a shared list. Paste the text exactly as it was copied." };
  if (typeof input !== 'string' || input.length > 4 * 1024 * 1024) return bad;
  let text = input.trim().replace(/^["'`]+|["'`]+$/g, '').replace(/\s+/g, '');
  if (text.startsWith(LIST_PREFIX)) text = text.slice(LIST_PREFIX.length);
  let data;
  try { data = JSON.parse(require('zlib').inflateSync(Buffer.from(text, 'base64url'), { maxOutputLength: 8 * 1024 * 1024 }).toString('utf8')); } catch { return bad; }
  const c = transfer.cleanList('lists', [{ id: 'x', name: data && data.name, items: data && data.items }]).items[0];
  return c && c.items.length ? { ok: true, list: { name: c.name, items: c.items, createdAt: c.createdAt } } : { ok: false, error: 'That list is empty or damaged.' };
});

// what there is here to export (for the "what to include" ticks)
ipcMain.handle('transfer:info', async () => {
  const c = transfer.countSources(gatherTransferSources());
  return transfer.SECTIONS.map(s => ({ id: s.id, label: s.label, about: s.about, noun: s.noun, count: c[s.id], extra: s.id === 'following' ? c.followNotices : 0 }));
});
function buildTransferDoc(sections) {
  const chosen = pickSections(sections);
  if (!chosen.length) return null;
  return transfer.buildExport(gatherTransferSources(), { platform: process.platform, appVersion: app.getVersion(), sections: chosen });
}
ipcMain.handle('transfer:exportText', async (_e, sections) => {
  const doc = buildTransferDoc(sections);
  if (!doc) return { ok: false, error: 'Tick at least one thing to include.' };
  const text = transfer.toText(doc);
  return { ok: true, text, included: countLine(doc), long: text.length > 150000 };
});
ipcMain.handle('transfer:exportFile', async (_e, sections) => {
  const doc = buildTransferDoc(sections);
  if (!doc) return { ok: false, error: 'Tick at least one thing to include.' };
  const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
    title: 'Export',
    defaultPath: path.join(app.getPath('documents'), 'aredl-desktop-export.json'),
    filters: [{ name: 'AREDL Desktop export', extensions: ['json'] }],
  });
  if (canceled || !filePath) return { ok: false, canceled: true };
  try {
    fs.writeFileSync(filePath, transfer.toJson(doc), 'utf8');
    return { ok: true, path: filePath, included: countLine(doc) };
  } catch (err) {
    return { ok: false, error: `Couldn't save the file: ${err.message}` };
  }
});

// Importing is two steps: look inside (and show what is there to pick from), then apply what was picked.
let pendingImport = null;
const PENDING_MS = 30 * 60 * 1000;
function startTransferImport(text) {
  let plan;
  try {
    plan = transfer.planImport(transfer.parseTransfer(text), { platform: process.platform });
  } catch (err) {
    return { ok: false, error: err instanceof transfer.TransferError ? err.message : 'That could not be read.' };
  }
  const preview = transfer.describePlan(plan);
  if (!preview.sections.some(s => s.available)) {
    const why = preview.sections.flatMap(s => s.skipped).map(s => s.label);
    return { ok: false, error: why.length ? `Nothing in there can be used on this computer (${why.join(', ')}).` : 'There was nothing in there to import.' };
  }
  pendingImport = { plan, at: Date.now() };
  return { ok: true, preview };
}
ipcMain.handle('transfer:importText', async (_e, text) => startTransferImport(text));
ipcMain.handle('transfer:importFile', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
    title: 'Import',
    properties: ['openFile'],
    filters: [{ name: 'Export files', extensions: ['json', 'txt'] }, { name: 'All files', extensions: ['*'] }],
  });
  if (canceled || !filePaths || !filePaths[0]) return { ok: false, canceled: true };
  let text;
  try {
    if (fs.statSync(filePaths[0]).size > 12 * 1024 * 1024) return { ok: false, error: 'That file is far too big to be an export from this app.' };
    text = fs.readFileSync(filePaths[0], 'utf8');
  } catch (err) {
    return { ok: false, error: `Couldn't read that file: ${err.message}` };
  }
  return startTransferImport(text);
});
ipcMain.handle('transfer:importCancel', async () => { pendingImport = null; return true; });

// a copy of everything an import is about to change, so it can be undone
const importBackupDir = () => path.join(userDataDir(), 'import-backup');
function backupForImport(ids) {
  const dir = importBackupDir();
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const manifest = {};
  for (const id of ids) {
    const file = TRANSFER_FILES[id]();
    const existed = fs.existsSync(file);
    manifest[id] = existed;
    if (existed) fs.copyFileSync(file, path.join(dir, id + '.json'));
  }
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest));
}
function restoreImportBackup() {
  const dir = importBackupDir();
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  for (const [id, existed] of Object.entries(manifest)) {
    if (!TRANSFER_FILES[id]) continue;
    const file = TRANSFER_FILES[id]();
    if (existed) fs.copyFileSync(path.join(dir, id + '.json'), file); else fs.rmSync(file, { force: true });
  }
  fs.rmSync(dir, { recursive: true, force: true });
}
const syncOverlay = () => {
  const o = loadSettings().overlay;
  if (o && mainWindow && process.platform === 'win32' && mainWindow.setTitleBarOverlay) { try { mainWindow.setTitleBarOverlay({ ...o, height: 36 }); } catch { /* applied at the next start */ } }
};

ipcMain.handle('transfer:importApply', async (_e, opts) => {
  if (!pendingImport || Date.now() - pendingImport.at > PENDING_MS) { pendingImport = null; return { ok: false, error: 'That import is no longer open. Choose the file or text again.' }; }
  const { plan } = pendingImport;
  const mode = opts && opts.mode === 'replace' ? 'replace' : 'merge';
  const chosen = pickSections(opts && opts.sections).filter(id => plan.sections[id] && plan.sections[id].available); // only what is really in the file
  if (!chosen.length) return { ok: false, error: 'Tick at least one thing to import.' };
  const touched = [...new Set(chosen.flatMap(id => FILES_OF[id]))];
  const done = [];
  try {
    backupForImport(touched);
    for (const id of chosen) {
      const p = plan.sections[id];
      if (id === 'settings') {
        fs.writeFileSync(settingsPath(), JSON.stringify({ ...loadSettings(), ...p.apply }));
        done.push({ id, label: 'Settings', added: p.count, skipped: p.skipped.map(s => ({ label: s.label, reason: s.reason })), unknown: p.unknown });
      } else if (id === 'following') {
        const f = transfer.combine('following', readList(TRANSFER_FILES.following()), p.items, mode);
        const n = transfer.combine('followNotifications', readList(TRANSFER_FILES.followNotifications()), p.noticeItems, mode);
        fs.writeFileSync(TRANSFER_FILES.following(), JSON.stringify(f.list));
        fs.writeFileSync(TRANSFER_FILES.followNotifications(), JSON.stringify(n.list));
        done.push({ id, label: 'Followed levels', added: f.added, kept: f.kept, notices: n.added });
      } else {
        const kind = id; // favourites | personal | notifications
        const r = transfer.combine(kind, readList(TRANSFER_FILES[id]()), p.items, mode);
        fs.writeFileSync(TRANSFER_FILES[id](), JSON.stringify(r.list));
        done.push({ id, label: transfer.SECTIONS.find(s => s.id === id).label, added: r.added, kept: r.kept });
      }
    }
  } catch (err) {
    try { restoreImportBackup(); } catch { /* nothing more to do */ }
    return { ok: false, error: `The import couldn't be finished, so nothing was changed (${err.message}).` };
  }
  if (chosen.includes('settings')) syncOverlay();
  pendingImport = null;
  return { ok: true, mode, done, fromPlatform: plan.fromPlatform, fromVersion: plan.fromVersion, newerFormat: plan.newerFormat };
});
ipcMain.handle('transfer:undo', async () => {
  try {
    restoreImportBackup();
    syncOverlay();
    return { ok: true };
  } catch {
    return { ok: false, error: 'There is nothing to undo.' };
  }
});

// ---- Sync between computers through a shared folder (the rules live in sync.js) ----
const { createSync } = require('./sync');
const { createDrive } = require('./drive');
// Every AREDL API key has its own save file: AREDL-Desktop-<first 16 characters of a SHA-256 of the key>.json.
// (A fingerprint rather than the key itself, so the key never appears in a file name in Google Drive.)
function syncFileName() {
  const key = loadApiKey();
  return key ? `AREDL-Desktop-${require('crypto').createHash('sha256').update(String(key)).digest('hex').slice(0, 16)}.json` : null;
}
const drive = createDrive({ userDataDir, safeStorage, openExternal: (u) => shell.openExternal(u), request: (url, options, what) => miscFetch(url, options, what), fileName: syncFileName, log: console });
const SYNC_FILES_OF = { settings: ['settings'], favourites: ['favourites'], lists: ['lists'], filters: ['filters'], demonlist: ['demonlist'], personal: ['personal'], notifications: ['notifications'], following: ['following', 'followNotifications'] };
const writeJson = (file, data) => fs.writeFileSync(file, JSON.stringify(data));
const syncer = createSync({
  userDataDir,
  io: {
    source: gatherTransferSources,
    mtime: (id) => Math.max(0, ...(SYNC_FILES_OF[id] || []).map(k => { try { return fs.statSync(TRANSFER_FILES[k]()).mtimeMs; } catch { return 0; } })),
    apply: (id, payload) => {
      if (id === 'settings') {
        const { bgCustomFile, ...rest } = payload;
        let file = {};
        if (bgCustomFile) { try { file = applySyncedBackdrop(bgCustomFile); } catch (err) { console.warn('Custom backdrop from the save file could not be written:', err.message); } }
        writeJson(settingsPath(), { ...loadSettings(), ...rest, ...file });
      }
      else if (id === 'following') { writeJson(TRANSFER_FILES.following(), payload.following); writeJson(TRANSFER_FILES.followNotifications(), payload.notices); }
      else writeJson(TRANSFER_FILES[id](), payload);
    },
  },
  fileName: syncFileName,
  log: console,
});
// A sync with a Google Drive folder: fetch the save file first, sync as usual, then upload it again if it changed.
async function safeSync(mode) {
  try {
    if (!drive.active() || !syncFileName()) return syncer.syncNow(mode); // without a folder / a sign-in it says what is missing
    try { await drive.pull(); } catch (err) { return { ok: false, error: `Google Drive: ${err.message}` }; }
    const res = syncer.syncNow(mode);
    if (res.ok && mode !== 'check') { // 'check' only looks at the folder: nothing is uploaded
      try { const up = await drive.push(); if (up.uploaded) res.file = { name: up.name, folder: up.folder, modifiedTime: up.modifiedTime, size: up.size }; }
      catch (err) { syncer.reset(); return { ok: false, error: `Google Drive: the changes couldn’t be uploaded (${err.message}).` }; } // reset: nothing counts as saved
    }
    return res;
  } catch (err) { return { ok: false, error: `Sync failed: ${err.message}` }; }
}
ipcMain.handle('sync:status', async () => {
  const st = syncer.status(), d = drive.info();
  const out = { ...st, drive: d, folderName: d.folder ? d.folder.name : null, account: d.account };
  if (d.folder && !st.needsKey) {
    try { out.remoteFile = await Promise.race([drive.peek(), new Promise((_r, rej) => setTimeout(() => rej(new Error('Google Drive did not answer in time')), 8000))]); }
    catch (err) { out.remoteError = err.message; }
  }
  return out;
});
// ---- Google Drive (the rules live in drive.js) ----
const driveErr = (err) => ({ error: (err && err.message) || 'Something went wrong.' });
ipcMain.handle('drive:info', async () => drive.info());
ipcMain.handle('drive:setClient', async (_e, id, secret) => { drive.setClient(id, secret); return drive.info(); });
ipcMain.handle('drive:signIn', async () => { try { return await drive.signIn(); } catch (err) { return driveErr(err); } });
ipcMain.handle('drive:cancelSignIn', async () => { drive.cancelSignIn(); return true; });
ipcMain.handle('drive:signOut', async () => { try { const r = await drive.signOut(); syncer.disconnect(); return r; } catch (err) { return driveErr(err); } });
ipcMain.handle('drive:listFolders', async () => { try { return { folders: await drive.listFolders() }; } catch (err) { return driveErr(err); } });
ipcMain.handle('drive:connect', async (_e, opts) => {
  try {
    const mode = ['use', 'create'].includes(opts && opts.mode) ? opts.mode : null;
    if (!mode) return { error: 'Choose a folder.' };
    await drive.connect({ folderId: opts.folderId, name: opts.name, mode });
    syncer.setFolder(drive.cacheDir()); syncer.reset(); syncer.setEnabled(false); // automatic saving starts after the first Sync now
    return drive.info();
  } catch (err) { return driveErr(err); }
});
ipcMain.handle('sync:setEnabled', async (_e, on) => syncer.setEnabled(!!on));
ipcMain.handle('sync:setParts', async (_e, parts) => syncer.setParts(parts));
ipcMain.handle('sync:disconnect', async () => { drive.disconnect(); return syncer.disconnect(); });
// choice: 'save' = this app's data replaces the folder's; 'load' = the folder's data replaces this app's
// choice: 'save' = this app's data replaces the folder's save; 'load' = the folder's save replaces this app's data
ipcMain.handle('sync:preview', async () => { // what differs between this app and the folder's save; nothing is changed
  try {
    if (drive.active() && syncFileName()) { try { await drive.pull(); } catch (err) { return { ok: false, error: `Google Drive: ${err.message}` }; } }
    return syncer.preview();
  } catch (err) { return { ok: false, error: `Couldn’t compare: ${err.message}` }; }
});
ipcMain.handle('sync:now', async (_e, choice) => {
  if (choice !== 'save' && choice !== 'load') return { ok: false, error: 'Choose whether to save to the folder or to use its save.' };
  const first = !syncer.status().lastSyncAt;
  const res = await safeSync(choice);
  if (res.ok && first) syncer.setEnabled(true); // after the first Save / Use, changes made here are saved automatically
  if (res.ok && (res.pulled.length || res.merged.length)) res.reload = true; // something here changed: the page reloads to use it
  return res;
});
// ---- how often the app saves to Google Drive, and how often it looks for changes made on another computer ----
// Two separate timers (or one, when they are linked). Nothing is sent when there is nothing to send: a save run first
// checks, on this computer only, whether anything changed since the last save; a check is a single small request.
const SYNC_MINUTES = [0, 1, 2, 5, 10, 15, 30, 60]; // 0 = never on a timer (still on Sync now and when the app closes)
function syncIntervals() {
  const s = loadSettings(), ok = (v) => SYNC_MINUTES.includes(v);
  const save = ok(s.syncSaveMins) ? s.syncSaveMins : 5, linked = s.syncLinked !== false;
  return { save, check: linked ? save : (ok(s.syncCheckMins) ? s.syncCheckMins : 5), linked };
}
let lastWaiting = '', syncBusy = false;
async function backgroundSync(kind) { // kind: 'both' (linked), 'save' or 'check'
  const st = syncer.status();
  if (!st.enabled || !st.folder || syncBusy) return;
  if (kind !== 'check' && !syncer.hasLocalChanges()) { if (kind === 'save') return; } // nothing changed here: no request at all for a save
  syncBusy = true;
  try {
    if (kind !== 'check' && !(await confirmBigChange())) return; // a really big change waits for a yes
    const res = await safeSync(kind === 'check' ? 'check' : 'push'); // never brings anything here: what is waiting is reported for the person to sync on purpose
    const key = res.ok ? res.waiting.join(',') : '';
    if (res.ok && res.waiting.length && key !== lastWaiting && mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('sync:waiting', res.waiting);
    if (kind !== 'save') lastWaiting = key;
  } finally { syncBusy = false; }
}
// A really big change (many levels added or most of a list gone) is not saved by the timer without asking first.
// Saying no leaves things as they are; the same change isn't asked about again until it changes further.
let bigDeclined = '', bigAsking = false;
async function confirmBigChange() {
  const big = syncer.bigChanges();
  if (!big.length) { bigDeclined = ''; return true; }
  const key = big.map(b => `${b.id}:${b.was}>${b.now}`).join(',');
  if (key === bigDeclined) return false;
  if (!mainWindow || mainWindow.isDestroyed() || !mainWindow.isVisible() || mainWindow.isMinimized() || bigAsking) return false; // can't ask now: try again next time
  bigAsking = true;
  const label = (id) => (transfer.SECTIONS.find(x => x.id === id) || {}).label || id;
  const reqId = require('crypto').randomUUID();
  const answer = await new Promise((resolve) => {
    const done = (v) => { ipcMain.removeListener('sync:bigAnswer', on); clearTimeout(t); resolve(v); };
    const on = (_e, id, ok) => { if (id === reqId) done(!!ok); };
    const t = setTimeout(() => done(false), 10 * 60 * 1000);
    ipcMain.on('sync:bigAnswer', on);
    mainWindow.webContents.send('sync:bigChange', { id: reqId, changes: big.map(b => ({ label: label(b.id), was: b.was, now: b.now })) });
  });
  bigAsking = false;
  if (!answer) bigDeclined = key;
  return answer;
}
let syncTimers = [];
const syncNext = { save: null, check: null }; // when each timer runs next (shown as a countdown in Settings)
function startSyncTimer() {
  syncTimers.forEach(clearInterval); syncTimers = [];
  syncNext.save = syncNext.check = null;
  const { save, check, linked } = syncIntervals();
  const every = (key, mins, kind) => {
    syncNext[key] = Date.now() + mins * 60000;
    syncTimers.push(setInterval(() => { syncNext[key] = Date.now() + mins * 60000; backgroundSync(kind); }, mins * 60000));
  };
  if (linked) { if (save) { every('save', save, 'both'); syncNext.check = syncNext.save; syncTimers.push(setInterval(() => { syncNext.check = syncNext.save; }, 1000)); } return; }
  if (save) every('save', save, 'save');
  if (check) every('check', check, 'check');
}
ipcMain.handle('sync:getIntervals', async () => {
  let pending = false; try { pending = syncer.hasLocalChanges(); } catch { /* not connected */ }
  return { ...syncIntervals(), options: SYNC_MINUTES, nextSave: syncNext.save, nextCheck: syncNext.check, pending, now: Date.now() };
});
ipcMain.handle('sync:setIntervals', async (_e, v) => {
  const ok = (x) => SYNC_MINUTES.includes(x), cur = syncIntervals();
  const patch = { syncSaveMins: ok(v && v.save) ? v.save : cur.save, syncLinked: !(v && v.linked === false), syncCheckMins: ok(v && v.check) ? v.check : cur.check };
  saveSettings(patch);
  startSyncTimer();
  return syncIntervals();
});

ipcMain.handle('settings:get', async () => loadSettings());
ipcMain.handle('settings:set', async (_e, patch) => saveSettings(patch && typeof patch === 'object' ? patch : {}));

// Recolours the native window buttons to match the current theme.
ipcMain.handle('window:setOverlay', async (_e, { color, symbolColor } = {}) => {
  if (!/^#[0-9a-f]{6}([0-9a-f]{2})?$/i.test(color || '') || !/^#[0-9a-f]{6}$/i.test(symbolColor || '')) return;
  saveSettings({ overlay: { color, symbolColor } });
  if (mainWindow && process.platform === 'win32' && mainWindow.setTitleBarOverlay) {
    mainWindow.setTitleBarOverlay({ color, symbolColor, height: 36 });
  }
});

// The last level list is kept on disk so the next start-up can show it instantly while the live one loads.
// (It's only reused when you're signed in the same way as when it was saved, so ticks never leak between accounts.)
const levelsCacheFile = (mode) => path.join(app.getPath('userData'), mode === 'platformer' ? 'levels-cache-platformer.json' : 'levels-cache.json');
ipcMain.handle('api:getLevels', async (_e, mode) => {
  const data = await apiFetch(ENDPOINTS.levels(mode));
  fs.promises.writeFile(levelsCacheFile(mode), JSON.stringify({ hadKey: !!loadApiKey(), savedAt: Date.now(), levels: data })).catch(() => {});
  return data;
});
ipcMain.handle('api:getCachedLevels', async (_e, mode) => {
  try {
    const c = JSON.parse(await fs.promises.readFile(levelsCacheFile(mode), 'utf8'));
    return c && c.hadKey === !!loadApiKey() && Array.isArray(c.levels) ? c.levels : null;
  } catch { return null; }
});

ipcMain.handle('api:getChangelog', async (_e, page, mode) => apiFetch(ENDPOINTS.changelog(page || 1, mode)));

ipcMain.handle('api:getPackTiers', async (_e, mode) => apiFetch(ENDPOINTS.packTiers(mode)));
ipcMain.handle('api:getLevelPacks', async (_e, levelId, mode) => apiFetch(ENDPOINTS.levelPacks(encodeURIComponent(levelId), mode)));
ipcMain.handle('api:getCustomCopies', async (_e, levelId, mode) => {
  const id = String(levelId == null ? '' : levelId);
  if (!/^[\w-]{1,64}$/.test(id)) throw new Error('Invalid level');
  return apiFetch(ENDPOINTS.customCopies(encodeURIComponent(id), mode));
});

// The "Find video" button on a video that can't be shown here: the first video results (up to 10) of YouTube's own search page for the text (no account
// or key needed). Returns their ids, best match first.
ipcMain.handle('yt:search', async (e, query) => {
  if (!fromApp(e)) return { ids: [] };
  const q = String(query || '').trim().slice(0, 150);
  if (!q) return { ids: [] };
  const res = await miscFetch(`https://www.youtube.com/results?search_query=${encodeURIComponent(q)}&sp=EgIQAQ%3D%3D`, { // (sp: videos only; listed in Settings → Other requests)
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      'Accept-Language': 'en-US,en;q=0.9',
      Cookie: 'CONSENT=YES+cb; SOCS=CAI', // (so the cookie notice page doesn't come instead of the results)
    },
  }, `Searched YouTube for “${q}”`);
  if (!res.ok) throw new Error(`YouTube search failed (${res.status})`);
  const html = await res.text();
  const ids = [];
  const re = /"videoRenderer":\{"videoId":"([\w-]{11})"/g;
  let m;
  while ((m = re.exec(html)) && ids.length < 10) if (!ids.includes(m[1])) ids.push(m[1]);
  return { ids };
});
ipcMain.handle('api:getLeaderboard', async (_e, page, mode, per) => apiFetch(ENDPOINTS.leaderboard(page || 1, mode, [50, 100].includes(Number(per)) ? Number(per) : 50)));
ipcMain.handle('api:getCountries', async (_e, page, mode) => apiFetch(ENDPOINTS.countries(page || 1, mode)));
ipcMain.handle('api:getCountry', async (_e, id, mode) => apiFetch(ENDPOINTS.country(id, mode)));

ipcMain.handle('api:getProfile', async (_e, id, mode) => apiFetch(ENDPOINTS.profile(id, mode)));

ipcMain.handle('api:getLevelDetail', async (_e, levelId, mode) => apiFetch(ENDPOINTS.levelDetail(levelId, mode)));

ipcMain.handle('api:getLevelCreators', async (_e, levelId, mode) => apiFetch(ENDPOINTS.levelCreators(levelId, mode)));
ipcMain.handle('api:getLevelHistory', async (_e, levelId, mode) => apiFetch(ENDPOINTS.levelHistory(levelId, mode)));

// One page of records at a time - the renderer drives the paging so it can show
// records as they arrive, stop when you leave, and load more on request.
ipcMain.handle('api:getLevelRecordsPage', async (_e, levelId, page, mode) => apiFetch(ENDPOINTS.levelRecords(levelId, page || 1, mode)));

ipcMain.handle('api:getLevelRecords', async (_e, levelId, mode) => {
  let all = [];
  let page = 1;
  let pageSize = null;
  let lastFirstId = null;
  for (;;) {
    const data = await apiFetch(ENDPOINTS.levelRecords(levelId, page, mode));
    const pageItems = Array.isArray(data) ? data : (data.data || data.records || data.items || []);
    if (!pageItems.length) break;
    if (pageSize == null) pageSize = pageItems.length;
    // Defence in depth: if the API ever hands back the same page again,
    // stop rather than appending duplicates until the sanity cap.
    const firstId = pageItems[0] && pageItems[0].id;
    if (page > 1 && firstId != null && firstId === lastFirstId) break;
    lastFirstId = firstId;
    all = all.concat(pageItems);
    if (pageItems.length < pageSize) break; // short page - no more pages follow
    page++;
    if (page > 50) break; // sanity cap
  }
  return all;
});

ipcMain.handle('api:getSubmissionQueue', async (_e, submissionId, mode) => apiFetch(ENDPOINTS.submissionQueue(submissionId, mode), { requireAuth: true }));

ipcMain.handle('api:getRequestLog', async () => requestLog);
// the page loads AREDL's level pictures itself (from the public thumbnails repository); each first load is written to the log
ipcMain.on('log:pic', (_e, url, ok) => {
  if (typeof url !== 'string' || !url.startsWith('https://raw.githubusercontent.com/All-Rated-Extreme-Demon-List/Thumbnails/') || url.length > 300) return;
  logRequest({ kind: 'misc', what: 'AREDL level picture', url, status: ok ? 200 : 404, ok: true, timestamp: Date.now() });
});

ipcMain.handle('api:getSubmissions', async (_e, mode) => apiFetch(ENDPOINTS.submissions(mode), { requireAuth: true }));

// "My profile": there's no confirmed identity endpoint. We try, in order:
// a remembered id (manually entered, or previously resolved), then the bare
// /users/@me (never actually tested before - only its /notifications
// sub-route was confirmed to require auth), then bail out with a clear
// error so the UI can ask for a manual ID.
ipcMain.handle('api:getMyProfile', async (_e, mode) => {
  const key = loadApiKey();
  if (!key) throw new Error('Not signed in');

  const id = loadMyId();
  if (id) return apiFetch(ENDPOINTS.profile(id, mode));

  const data = await apiFetch(`${API_BASE}/users/@me`);
  if (data && data.id) {
    saveMyId(data.id);
    if (mode === 'platformer') return apiFetch(ENDPOINTS.profile(data.id, mode)); // the id works for both lists
  }
  return data;
});

ipcMain.handle('auth:setMyId', async (_e, id) => {
  const trimmed = String(id || '').trim();
  if (!trimmed) throw new Error('ID is empty');
  const data = await apiFetch(ENDPOINTS.profile(trimmed)); // verify it resolves
  saveMyId(trimmed);
  return data;
});

// Favourited levels live in the app's own data folder (userData), not in
// localStorage - the renderer's origin includes a random port, so
// localStorage wouldn't survive a restart.
ipcMain.handle('favourites:get', async () => {
  try {
    const data = JSON.parse(fs.readFileSync(favouritesPath(), 'utf8'));
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
});

ipcMain.handle('favourites:set', async (_e, list) => {
  const clean = (Array.isArray(list) ? list : [])
    .filter(f => f && f.level_id != null)
    .map(f => ({ level_id: f.level_id, name: String(f.name || ''), label: String(f.label || 'favourited').slice(0, 24), mode: f.mode === 'platformer' ? 'platformer' : 'classic' }));
  fs.writeFileSync(favouritesPath(), JSON.stringify(clean));
  return clean;
});

// Notifications the user has cleared. The API has no confirmed "dismiss"
// endpoint, so clearing is local: these ids are just hidden in this app.
ipcMain.handle('notifications:getCleared', async () => {
  try {
    const data = JSON.parse(fs.readFileSync(clearedNotifsPath(), 'utf8'));
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
});

ipcMain.handle('notifications:setCleared', async (_e, ids) => {
  const clean = (Array.isArray(ids) ? ids : []).map(String).slice(-2000);
  fs.writeFileSync(clearedNotifsPath(), JSON.stringify(clean));
  return clean;
});

ipcMain.handle('api:getNotifications', async () => apiFetch(ENDPOINTS.notifications, { requireAuth: true }));

ipcMain.handle('auth:getStatus', async () => ({ signedIn: !!loadApiKey() }));

ipcMain.handle('auth:setKey', async (_e, key) => {
  const trimmed = String(key || '').trim();
  if (!trimmed) throw new Error('API key is empty');
  // Verify against the one endpoint we know for certain requires auth.
  const headers = { Accept: 'application/json', Authorization: `Bearer ${trimmed}` };
  const res = await fetch(ENDPOINTS.notifications, { headers });
  if (!res.ok) {
    throw new Error(`Key rejected by server (HTTP ${res.status}). Double check it was copied correctly.`);
  }
  saveApiKey(trimmed);
  cachedApiKey = trimmed;
  fs.writeFileSync(seenPath(), '[]');

  if (!loadMyId()) {
    const decoded = tryDecodeJwtId(trimmed);
    if (decoded) {
      try {
        await apiFetch(ENDPOINTS.profile(decoded)); // make sure it actually resolves
        saveMyId(decoded);
      } catch {
        // decoded something, but it doesn't resolve to a real profile - ignore,
        // the manual-entry fallback in the UI still covers this.
      }
    }
  }

  startPolling();
  return { signedIn: true };
});

ipcMain.handle('auth:clear', async () => {
  clearApiKey();
  stopPolling();
  return { signedIn: false };
});

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Automatic updates (installed version only)
// The installer build checks GitHub Releases (see "publish" in package.json), downloads a newer version
// quietly in the background, and asks to restart. Running from source (npm start) and the portable .exe
// can't update themselves, so they skip all of this.
// ---------------------------------------------------------------------------
let autoUpdater = null;
// Mac: electron-updater can't be used (it needs a paid Apple certificate), so mac-updater.js does the same job
let macUpdater = null;
function setupMacUpdates() {
  // electron-builder removes the "build" section from the package.json inside the packaged app, so the repository is
  // read from "repository" (kept in the package) and only then from "build.publish" (present when run from source)
  const pkg = require('./package.json');
  const repoUrl = String((pkg.repository && pkg.repository.url) || pkg.repository || '');
  const fromUrl = /github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?\/?$/i.exec(repoUrl);
  const pub = (pkg.build || {}).publish || {};
  const owner = fromUrl ? fromUrl[1] : pub.owner, repo = fromUrl ? fromUrl[2] : pub.repo;
  macUpdater = require('./mac-updater').createMacUpdater({ app, dialog, shell, getWindow: () => mainWindow, owner, repo, fetchImpl: (url, options, what) => miscFetch(url, options, what || 'Checked GitHub for an update') }); // every request is listed in Settings → Other requests
  return macUpdater.start();
}
function setupAutoUpdate() {
  if (process.platform === 'darwin') return setupMacUpdates();
  if (!app.isPackaged || process.env.PORTABLE_EXECUTABLE_FILE) return false;
  try { ({ autoUpdater } = require('electron-updater')); } catch (err) { console.warn('Auto-update unavailable:', err && err.message); return false; }
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true; // if you ignore the prompt, it installs the next time you Quit
  autoUpdater.on('error', (err) => console.warn('Update check failed:', err && err.message));
  autoUpdater.on('update-downloaded', async (info) => {
    // the release notes (from renderer/releases.js) travel with the update; show them as plain text
    const raw = Array.isArray(info.releaseNotes) ? info.releaseNotes.map(n => n && n.note).join('\n') : String(info.releaseNotes || '');
    const notes = raw.replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/\*\*/g, '').trim().slice(0, 900);
    const { response } = await dialog.showMessageBox(mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined, {
      type: 'info',
      buttons: ['Restart now', 'Later'],
      defaultId: 0,
      cancelId: 1,
      title: 'Update ready',
      message: `AREDL Desktop ${info.version} is ready to install.`,
      detail: (notes ? `${notes}\n\n` : '') + 'Restart to finish updating. If you choose Later, it installs the next time you quit the app.',
    });
    if (response === 0) { app.isQuiting = true; autoUpdater.quitAndInstall(); }
  });
  const check = () => autoUpdater.checkForUpdates().catch(() => {}); // offline / no release yet: stay quiet
  setTimeout(check, 8000);                 // shortly after start-up
  setInterval(check, 4 * 60 * 60 * 1000);  // and every 4 hours while it's running
  return true;
}
ipcMain.handle('app:version', () => app.getVersion());
ipcMain.handle('update:check', async () => {
  if (process.platform === 'darwin') return macUpdater && app.isPackaged ? macUpdater.check(true) : { status: 'dev' };
  if (!autoUpdater) return { status: process.env.PORTABLE_EXECUTABLE_FILE ? 'portable' : 'dev' };
  try {
    const r = await autoUpdater.checkForUpdates();
    return r && r.isUpdateAvailable ? { status: 'available', version: r.updateInfo.version } : { status: 'up-to-date' };
  } catch (err) {
    return { status: 'error', message: String((err && err.message) || err).split('\n')[0].slice(0, 160) };
  }
});

app.whenReady().then(async () => {
  // Windows / Linux: no menu bar. A Mac always has one at the top of the screen, and without it copy / paste / quit shortcuts don't work.
  Menu.setApplicationMenu(process.platform === 'darwin'
    ? Menu.buildFromTemplate([{ role: 'appMenu' }, { role: 'editMenu' }, { role: 'windowMenu' }])
    : null);
  if (syncer.status().enabled) await Promise.race([safeSync('full'), new Promise(r => setTimeout(r, 7000))]); // pull what the other computer changed BEFORE the window reads any data (but never wait long for the network)
  startSyncTimer();
  await startLocalServer();
  // YouTube's embedded player refuses to play ("Error 153", a player configuration error) when the request doesn't say which page it is embedded
  // in (the HTTP Referer header). Pages that send it get the video; so the app's own address is added whenever a request for an embed lacks it.
  try {
    session.defaultSession.webRequest.onBeforeSendHeaders({ urls: ['https://www.youtube.com/embed/*', 'https://www.youtube-nocookie.com/embed/*'] }, (details, cb) => {
      const h = details.requestHeaders;
      if (!Object.keys(h).some(k => k.toLowerCase() === 'referer')) h.Referer = `http://127.0.0.1:${localServerPort}/`;
      cb({ requestHeaders: h });
    });
  } catch { /* the embed just goes without it */ }
  createWindow();
  if (process.platform !== 'darwin') createTray(); // on a Mac the Dock icon does that job: closing the window keeps the app running, clicking the Dock icon brings it back
  setupAutoUpdate();
  if (loadApiKey()) startPolling();

  app.on('second-instance', () => {
    if (mainWindow) {
      mainWindow.show();
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
    else mainWindow.show();
  });
});

app.on('window-all-closed', () => {
  // Keep running in the tray so notification polling continues even with
  // the window closed. Quit explicitly via the tray menu.
});


// ---------------------------------------------------------------------------
// The video players. Every video the app shows is played by a window of its own (renderer/mini.html), so it is always YouTube's own player
// and nothing is ever handed over, reloaded or muted and unmuted (so there is no delay and no cut in the sound):
//   - On its page a player is "docked": its window is laid exactly over the page's video, can't be moved, has no controls of its own (it is
//     YouTube's own player, with YouTube's own thumbnail and play button), follows the page when it scrolls and the app when it moves, and
//     belongs to the app's window (so it never covers other apps). When something of the app has to be above the video (a menu, the command
//     palette...) the app says so and the window steps aside (or, for the pack window, only dims) while the page shows the picture under it.
//   - When the page of a playing video goes away (another tab or level, the app minimised) its window is "popped out": it glides to the corner,
//     goes on top of everything (other apps too), and can be moved and resized there.
//   - Moving and resizing are done here: the cursor is read every few milliseconds and the window follows it, so there is no message to the
//     page between the pointer and the window to make it lag.
// ---------------------------------------------------------------------------
const players = new Map();   // id → { id, win, mode, rect, covered, dim, vis, owned, ready, key, lkey, load, gliding, glideEnd }
let miniWidth = 0, miniGesture = null;
const MINI_PAD = 48;             // room around the player inside its window in the corner: the grips and the shadow are drawn there (it is see-through)
const MINI_MIN = 220, MINI_MAX = 900;
const clampNum = (v, lo, hi) => Math.min(Math.max(v, lo), Math.max(lo, hi));
const miniHeight = (w) => Math.round(w * 9 / 16);
function stopMiniGesture() { if (miniGesture) { clearInterval(miniGesture.timer); miniGesture = null; } }
const unionRect = (a, b) => { const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y); return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y }; };
function miniBoundsOf(r) { return { x: Math.round(r.x - MINI_PAD), y: Math.round(r.y - MINI_PAD), width: Math.round(r.w + MINI_PAD * 2), height: Math.round(r.h + MINI_PAD * 2) }; }
// The corner player (popping out, gliding, the masked swap) exists only while Settings › Videos › “Move it to a corner player” is chosen.
const cornerOn = () => (loadSettings().videoOnLeave || 'popup') === 'popup';
const pAlive = (P) => !!P && !!P.win && !P.win.isDestroyed();
const pSend = (P, ch, d) => { if (pAlive(P)) P.win.webContents.send(ch, d); };
const toApp = (channel, data) => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, data); };
const playerOf = (e) => { for (const P of players.values()) if (pAlive(P) && e.sender === P.win.webContents) return P; return null; };
const fromApp = (e) => !!mainWindow && !mainWindow.isDestroyed() && e.sender === mainWindow.webContents;
const cornerPlayer = () => { for (const P of players.values()) if (P.mode === 'corner') return P; return null; };

// The window is always "on screen" (a page of a window that was never shown counts as hidden, and YouTube then often won't play in it):
// out of sight it is fully see-through and click-through. `vis` is how opaque it is (0 to 1).
function pSetVis(P, vis) {
  if (!pAlive(P)) return;
  if (P.swapping && vis > 0) return; // see pSwapBegin: it is revealed when the page says its new layout is on screen
  if (vis !== P.vis) { P.vis = vis; P.win.setOpacity(vis); P.win.setIgnoreMouseEvents(vis < 1); }
  if (!P.win.isVisible()) P.win.showInactive();
}
// Docked, the window belongs to the app's window (it stays above it but under other apps, and goes with it); popped out, it belongs to nobody.
function pOwn(P, on) {
  if (!pAlive(P) || on === P.owned) return;
  if (on && mainWindow && !mainWindow.isDestroyed()) {
    P.owned = true;
    P.win.setAlwaysOnTop(false);
    if (process.platform === 'darwin') P.win.setVisibleOnAllWorkspaces(false);
    P.win.setParentWindow(mainWindow);
  } else {
    P.owned = false;
    P.win.setParentWindow(null);
    P.win.setAlwaysOnTop(true, 'screen-saver'); // above full-screen windows and other apps
    if (process.platform === 'darwin') P.win.setVisibleOnAllWorkspaces(true);
  }
}
// The window and its page are different processes: when a window is moved or resized, the OS shows it at once but the page draws its new layout a
// frame or two later, so for that moment the old layout shows in the new window, displaced by however far the window's origin moved. That is the
// short jump at the start and end of a glide. So during that swap only (never while scrolling) the window is see-through, and it is shown again
// when the page reports (mini:placed) that the new layout has been drawn.
function pSwapBegin(P) { if (!pAlive(P)) return; clearTimeout(P.swapTimer); P.swapping = false; pSetVis(P, 0); P.swapping = true; }
function pSwapEnd(P) {
  if (!P) return;
  clearTimeout(P.swapTimer); P.onAck = null;
  if (!P.swapping) return;
  P.swapping = false;
  if (!pAlive(P)) return;
  if (P.mode === 'corner') pSetVis(P, 1); else if (P.mode === 'docked') pSetVis(P, P.covered ? 0 : (P.dim ? 0.5 : 1));
}
function pAwaitPlaced(P, fn) { // fn runs when the page says its layout is drawn (or after a short wait, so it can never stay hidden)
  clearTimeout(P.swapTimer);
  const run = () => { if (P.onAck !== run) return; P.onAck = null; clearTimeout(P.swapTimer); fn(); };
  P.onAck = run;
  P.swapTimer = setTimeout(run, 250);
}
// A player glides between two places on the screen without its window being resized on every frame (which is what makes it stutter):
// the window is made big enough to cover both places, the page moves the player inside it with a transform (done by the graphics card,
// so it is smooth), and when it has arrived the window is put on its final place by `done`.
function pGlide(P, from, to, ms, done, opt = {}) {
  const win = P.win;
  P.gliding = true;
  const u = unionRect(from, to), ox = u.x - MINI_PAD, oy = u.y - MINI_PAD;
  const rel = (r) => ({ x: r.x - ox, y: r.y - oy, w: r.w, h: r.h });
  const finish = () => { if (P.glideEnd !== finish) return; P.glideEnd = null; P.gliding = false; if (!win.isDestroyed()) done(); };
  P.glideEnd = finish;
  const nb = miniBoundsOf(u);
  // The player is told first how to sit in the bigger window (ww/wh: the size it is about to get). fromClip/toClip: the part of the video that is
  // scrolled out of view at either end, so a partly visible video glides as the whole video with that part revealed or covered.
  pSwapBegin(P);
  win.webContents.send('mini:glide', { from: rel(from), to: rel(to), ms, ww: nb.width, wh: nb.height, fromClip: opt.fromClip || null, toClip: opt.toClip || null, toDocked: !!opt.toDocked, ack: true });
  win.setBounds(nb);
  pAwaitPlaced(P, () => {
    if (P.glideEnd !== finish || win.isDestroyed()) return;
    pSwapEnd(P); // (the swap is over: it is visible at the start of the glide, exactly where the video was)
    win.webContents.send('mini:glideGo');
    setTimeout(finish, ms + 700); // never stay stuck
  });
}
const miniPrefs = () => { const v = loadSettings().miniPlayer; return v && typeof v === 'object' ? v : {}; };
// width travels with the settings; the position (sx, sy: where the player's top-left corner is on the screen) stays on this computer
const saveMiniPrefs = (patch) => { try { saveSettings({ miniPlayer: { x: null, y: null, ...miniPrefs(), ...patch } }); } catch { /* not saved this time */ } };
// the player's rectangle put inside the screen it is on; with snap, it sticks to an edge or corner it was let go close to
function miniFit(x, y, w, h, snap) {
  const wa = screen.getDisplayNearestPoint({ x: Math.round(x + w / 2), y: Math.round(y + h / 2) }).workArea;
  const SNAP = 26, M = 16;
  let nx = clampNum(x, wa.x, wa.x + wa.width - w), ny = clampNum(y, wa.y, wa.y + wa.height - h);
  if (snap) {
    if (nx - wa.x < SNAP) nx = wa.x + M; else if (wa.x + wa.width - (nx + w) < SNAP) nx = wa.x + wa.width - w - M;
    if (ny - wa.y < SNAP) ny = wa.y + M; else if (wa.y + wa.height - (ny + h) < SNAP) ny = wa.y + wa.height - h - M;
  }
  return { x: Math.round(nx), y: Math.round(ny) };
}
// where the corner player goes: the last place it was put; otherwise the bottom-right of the app (or of its screen when the app is minimised or hidden)
function miniPlace() {
  const saved = miniPrefs();
  const w = clampNum(Math.round(Number(miniWidth || saved.width) || 340), MINI_MIN, MINI_MAX), h = miniHeight(w);
  miniWidth = w;
  const mw = mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
  let pt = { x: 0, y: 0 };
  if (Number.isFinite(saved.sx) && Number.isFinite(saved.sy)) pt = { x: saved.sx, y: saved.sy };
  else if (mw && mw.isVisible() && !mw.isMinimized()) { const cb = mw.getContentBounds(); pt = { x: cb.x + cb.width - w - 16, y: cb.y + cb.height - h - 16 }; }
  else if (mw) { const wa = screen.getDisplayMatching(mw.getBounds()).workArea; pt = { x: wa.x + wa.width - w - 16, y: wa.y + wa.height - h - 16 }; }
  return { w, h, at: miniFit(pt.x, pt.y, w, h, false) };
}
const pwCornerRect = () => { const { w, h, at } = miniPlace(); return { x: at.x, y: at.y, w, h }; };
const validVid = (v) => typeof v === 'string' && /^[\w-]{6,20}$/.test(v);
const validMedalPart = (v) => typeof v === 'string' && /^[A-Za-z0-9_-]{3,60}$/.test(v);

// where the visible part of a docked video is on the screen (and how the player sits inside that part, for a video partly scrolled out of view).
// Everything is rounded once, to whole pixels, from the video's own corner: the window and the video inside it then always agree, so the video
// doesn't shift by a pixel from one frame to the next while the page scrolls.
function pDockedGeometry(P) {
  const mw = mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
  if (!mw || !mw.isVisible() || mw.isMinimized() || !P.rect) return null;
  const r = P.rect, c = r.clip, cb = mw.getContentBounds(), z = mw.webContents.getZoomFactor() || 1;
  const cx = Math.round(cb.x + r.left * z), cy = Math.round(cb.y + r.top * z);
  const cw = Math.round(r.width * z), ch = Math.round(r.height * z);
  const x0 = Math.max(cx, Math.round(cb.x + (r.left + c.left) * z)), y0 = Math.max(cy, Math.round(cb.y + (r.top + c.top) * z));
  const x1 = Math.min(cx + cw, Math.round(cb.x + (r.left + r.width - c.right) * z)), y1 = Math.min(cy + ch, Math.round(cb.y + (r.top + r.height - c.bottom) * z));
  if (x1 - x0 < 8 || y1 - y0 < 8) return null;
  return { vis: { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }, ox: x0 - cx, oy: y0 - cy, w: cw, h: ch };
}
// the whole video (also the part out of view) and how much of it is out of view on each side, for gliding
const pContentRect = (g) => ({ x: g.vis.x - g.ox, y: g.vis.y - g.oy, w: g.w, h: g.h });
function pClipOf(g) {
  const c = { t: g.oy, l: g.ox, r: Math.max(0, g.w - g.ox - g.vis.w), b: Math.max(0, g.h - g.oy - g.vis.h) };
  return c.t > 0 || c.l > 0 || c.r > 0 || c.b > 0 ? c : null;
}
function pApplyDocked(P) {
  if (!pAlive(P) || P.mode !== 'docked' || P.gliding || P.fs) return;
  const g = pDockedGeometry(P);
  if (!g || P.covered) { pSetVis(P, 0); P.key = ''; P.lkey = ''; return; }
  const bKey = `${g.vis.x},${g.vis.y},${g.vis.w},${g.vis.h}`;
  const lKey = `${g.ox},${g.oy},${g.w},${g.h}`;
  pOwn(P, true);
  // Scrolling mostly only moves the window (or changes the part of it in view at the bottom or right), and then the player isn't told anything.
  // When how the video sits inside the window changes too, the player is told before the window changes size and applies it in that same frame.
  if (lKey !== P.lkey) {
    const b = P.win.getBounds();
    const resizing = b.width !== g.vis.w || b.height !== g.vis.h;
    P.lkey = lKey;
    pSend(P, 'mini:place', { mode: 'docked', ox: g.ox, oy: g.oy, w: g.w, h: g.h, ww: resizing ? g.vis.w : 0, wh: resizing ? g.vis.h : 0, ack: !!P.swapping });
  }
  if (bKey !== P.key) {
    P.key = bKey;
    P.win.setBounds({ x: g.vis.x, y: g.vis.y, width: g.vis.w, height: g.vis.h });
  }
  pSetVis(P, P.dim ? 0.5 : 1);
}
function pToDocked(P) { // over the page's video: straight there, or gliding in from the corner
  const was = P.mode;
  P.mode = 'docked'; P.key = ''; P.lkey = '';
  const g = pDockedGeometry(P);
  if (!g || P.covered) { pSetVis(P, 0); return; }
  if (was === 'corner' && P.vis > 0 && cornerOn()) { // (with the setting off there is no glide or masked swap: the video is simply put over its page)
    const b = P.win.getBounds();
    stopMiniGesture();
    pGlide(P, { x: b.x + MINI_PAD, y: b.y + MINI_PAD, w: b.width - MINI_PAD * 2, h: b.height - MINI_PAD * 2 }, pContentRect(g), 260, () => { P.key = ''; P.lkey = ''; pSwapBegin(P); pApplyDocked(P); pAwaitPlaced(P, () => pSwapEnd(P)); }, { toClip: pClipOf(g), toDocked: true });
  } else pApplyDocked(P);
}
function pToCorner(P, instant) { // popped out: glides from the page's video to the corner (or just appears there, e.g. when the app is minimised)
  if (!pAlive(P)) return;
  // one popped-out player at a time
  for (const o of [...players.values()]) if (o !== P && o.mode === 'corner') pDestroy(o, true);
  const to = pwCornerRect();
  const mw = mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
  const away = !mw || mw.isMinimized() || !mw.isVisible();
  let from = null, fromClip = null;
  if (P.mode === 'docked' && P.vis > 0 && !instant && !away) {
    const g = pDockedGeometry(P);
    if (g) { from = pContentRect(g); fromClip = pClipOf(g); } // the whole video, with the part out of view covered, so it doesn't glide as a squashed piece
    else { const b = P.win.getBounds(); if (b.width > 40) from = { x: b.x, y: b.y, w: b.width, h: b.height }; }
  }
  pSwapEnd(P); P.mode = 'corner'; P.key = ''; P.lkey = ''; P.glideEnd = null; P.gliding = false; P.dim = false; P.covered = false;
  pOwn(P, false);
  pSetVis(P, 1);
  P.win.showInactive();
  const settle = (swap) => { // the player is told first and applies it in the frame the window gets its final size
    const nb = miniBoundsOf(to);
    if (swap) pSwapBegin(P);
    pSend(P, 'mini:place', { mode: 'corner', ww: nb.width, wh: nb.height, ack: !!swap });
    P.win.setBounds(nb);
    if (swap) pAwaitPlaced(P, () => pSwapEnd(P));
  };
  if (from) pGlide(P, from, to, 300, () => settle(true), { fromClip, toDocked: false });
  else settle(false);
}
function pHide(P) {
  if (!pAlive(P)) return;
  P.mode = 'hidden'; P.key = ''; P.lkey = '';
  pSetVis(P, 0);
}
function pDestroy(P, quiet) { // the window goes; it is taken out of the list first so its 'closed' event isn't taken for the person closing it
  if (!P) return;
  players.delete(P.id);
  if (miniGesture && miniGesture.P === P) stopMiniGesture();
  P.glideEnd = null; P.gliding = false; clearTimeout(P.swapTimer); P.onAck = null;
  const w = P.win; P.win = null;
  if (w && !w.isDestroyed()) w.destroy();
  if (quiet) return;
}
// Full screen for a player window (YouTube's full-screen button). The window is only as big as the video and can't be made a full-screen window of
// the system (it is see-through, has no frame and belongs to the app), so it is made as big as the screen it is on and put on top of everything;
// the page's full-screen player then fills it. When full screen ends, the window goes back to where it was.
function pFullscreen(P, on) {
  if (!pAlive(P)) return;
  if (on) {
    if (P.fs) return;
    const b = P.win.getBounds();
    P.fs = { bounds: b, mode: P.mode };
    stopMiniGesture();
    pOwn(P, false); // (not the app's own window any more: it covers the whole screen, other apps included)
    P.vis = -1; pSetVis(P, 1); // visible and clickable
    P.win.setBounds(screen.getDisplayMatching(b).bounds);
    P.win.setAlwaysOnTop(true, 'screen-saver');
    P.win.focus();
  } else {
    const f = P.fs;
    if (!f) return;
    P.fs = null;
    P.win.setBounds(f.bounds);
    P.key = ''; P.lkey = '';
    if (P.mode === 'docked') { P.vis = -1; pApplyDocked(P); }
    else if (P.mode === 'corner') pSend(P, 'mini:place', { mode: 'corner', ww: f.bounds.width, wh: f.bounds.height });
  }
}
function pCreate(id) {
  const { w, h, at } = miniPlace();
  const win = new BrowserWindow({
    width: w + MINI_PAD * 2, height: h + MINI_PAD * 2, x: at.x - MINI_PAD, y: at.y - MINI_PAD, show: false, transparent: true, backgroundColor: '#00000000',
    frame: false, resizable: false, minimizable: false, maximizable: false, fullscreenable: false, hasShadow: false,
    skipTaskbar: true, alwaysOnTop: true, title: 'AREDL Desktop', focusable: true,
    webPreferences: { preload: path.join(__dirname, 'mini-preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false },
  });
  const P = { id, win, mode: 'hidden', rect: null, covered: false, dim: false, vis: 1, owned: false, ready: false, key: '', lkey: '', load: null, gliding: false, glideEnd: null };
  players.set(id, P);
  win.setSkipTaskbar(true);
  win.setMenuBarVisibility(false);
  win.setOpacity(0); win.setIgnoreMouseEvents(true); P.vis = 0; win.showInactive(); // on screen but see-through, so the page counts as visible and the video plays
  win.setAlwaysOnTop(true, 'screen-saver');
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('enter-html-full-screen', () => pFullscreen(P, true));
  win.webContents.on('leave-html-full-screen', () => pFullscreen(P, false));
  // scrolling the wheel over a docked video scrolls the page under it (with the same kind of scroll: notched wheel or trackpad, and its speed)
  const num = (v, d = 0) => (Number.isFinite(v) ? v : d);
  win.webContents.on('input-event', (_e, input) => {
    try {
      if (input.type !== 'mouseWheel' || P.mode !== 'docked' || P.fs || !mainWindow || mainWindow.isDestroyed()) return;
      const b = win.getBounds(), cb = mainWindow.getContentBounds(), z = mainWindow.webContents.getZoomFactor() || 1;
      mainWindow.webContents.sendInputEvent({ type: 'mouseWheel', x: Math.round((b.x + input.x - cb.x) / z), y: Math.round((b.y + input.y - cb.y) / z), deltaX: input.deltaX || 0, deltaY: input.deltaY || 0, wheelTicksX: num(input.wheelTicksX), wheelTicksY: num(input.wheelTicksY), accelerationRatioX: num(input.accelerationRatioX, 1), accelerationRatioY: num(input.accelerationRatioY, 1), hasPreciseScrollingDeltas: input.hasPreciseScrollingDeltas === true, canScroll: true });
    } catch { /* the page just doesn't scroll */ }
  });
  win.on('closed', () => { if (players.get(id) === P) { players.delete(id); if (miniGesture && miniGesture.P === P) stopMiniGesture(); P.win = null; toApp('player:closed', { id }); } });
  win.loadURL(`http://127.0.0.1:${localServerPort}/mini.html`);
  return P;
}

// the app: load a video (its window is made if it hasn't one yet), place the window, pop out, send a command to YouTube, close
ipcMain.handle('player:load', async (e, o) => {
  if (!fromApp(e) || !o || !Number.isInteger(o.id)) return false;
  // a Medal clip or a Twitch video (played through their own embed addresses) instead of a YouTube video
  const kind = o.kind === 'medal' ? 'medal' : o.kind === 'twitch' ? 'twitch' : 'youtube';
  const tclip = kind === 'twitch' && o.tkind === 'clip';
  const ttime = typeof o.ttime === 'string' && /^[\dhms]{1,20}$/.test(o.ttime) ? o.ttime : '';
  const ap = o.autoplay === true;
  if (kind === 'medal' ? !(validMedalPart(o.mid) && (!o.mhash || validMedalPart(o.mhash)))
    : kind === 'twitch' ? !(typeof o.tid === 'string' && (tclip ? /^[\w-]{3,100}$/ : /^\d{3,15}$/).test(o.tid))
    : !validVid(o.vid)) return false;
  // Twitch only plays inside a page that names itself in `parent`: the player windows are served from 127.0.0.1, which Twitch accepts for that
  const url = kind === 'medal' ? `https://medal.tv/clip/${o.mid}${o.mhash ? '/' + o.mhash : ''}`
    : kind === 'twitch' ? (tclip ? `https://clips.twitch.tv/embed?clip=${o.tid}&parent=127.0.0.1&autoplay=${ap}&muted=false`
      : `https://player.twitch.tv/?video=v${o.tid}&parent=127.0.0.1&autoplay=${ap}&muted=false${ttime ? '&time=' + ttime : ''}`)
    : '';
  const load = {
    kind, standalone: o.standalone === true, canReturn: o.canReturn === true, url,
    vid: kind === 'medal' ? o.mid : kind === 'twitch' ? o.tid : o.vid, time: Math.max(0, Number(o.time) || 0), autoplay: o.autoplay === true, title: String(o.title || '').slice(0, 300), pad: MINI_PAD,
    rootCss: String(o.rootCss || '').slice(0, 20000), bodyCss: String(o.bodyCss || '').slice(0, 20000), bodyClass: String(o.bodyClass || '').slice(0, 2000),
  };
  let P = players.get(o.id);
  if (!pAlive(P)) P = pCreate(o.id);
  P.load = load;
  if (P.ready) pSend(P, 'mini:init', { ...load, id: P.id });
  return true;
});
ipcMain.on('player:place', (e, p) => {
  const P = p && players.get(p.id);
  if (!fromApp(e) || !pAlive(P) || P.fs) return; // (a player in full screen stays as it is)
  if (p.mode === 'docked') {
    const r = p.rect || {}, c = r.clip || {};
    const v = [r.left, r.top, r.width, r.height, c.top, c.right, c.bottom, c.left].map(Number);
    if (!v.every(Number.isFinite) || v[2] < 40 || v[3] < 20 || v[2] > 4000 || v[3] > 4000) return;
    P.rect = { left: v[0], top: v[1], width: v[2], height: v[3], clip: { top: Math.max(0, v[4]), right: Math.max(0, v[5]), bottom: Math.max(0, v[6]), left: Math.max(0, v[7]) } };
    P.covered = p.covered === true; P.dim = p.dim === true;
    if (P.mode !== 'docked') pToDocked(P); else pApplyDocked(P);
  } else if (p.mode === 'hidden') {
    if (P.mode !== 'hidden') pHide(P);
  }
});
ipcMain.on('player:corner', (e, o) => { const P = o && players.get(o.id); if (fromApp(e) && pAlive(P) && !P.fs && P.mode !== 'corner' && (cornerOn() || o.force === true)) pToCorner(P, o.instant === true); });
ipcMain.on('player:cmd', (e, c) => {
  const P = c && players.get(c.id);
  if (!fromApp(e) || !pAlive(P) || typeof c.func !== 'string' || c.func.length > 40) return;
  pSend(P, 'mini:cmd', { func: c.func, args: c.args === undefined ? '' : c.args });
});
ipcMain.on('player:close', (e, id) => { if (fromApp(e)) pDestroy(players.get(id)); });

// the windows
ipcMain.on('mini:ready', (e) => { // its page has loaded: it gets the video to show
  const P = playerOf(e);
  if (!P) return;
  P.ready = true;
  if (P.load) pSend(P, 'mini:init', { ...P.load, id: P.id });
  P.key = ''; P.lkey = '';
  if (P.mode === 'docked') pApplyDocked(P); else if (P.mode === 'corner') pSend(P, 'mini:place', { mode: 'corner' });
});
ipcMain.on('mini:state', (e, st) => {
  const P = playerOf(e);
  if (P && st && typeof st === 'object') toApp('player:state', { id: P.id, state: typeof st.state === 'number' ? st.state : null, time: typeof st.time === 'number' ? st.time : null, error: typeof st.error === 'number' ? st.error : null });
});
ipcMain.on('mini:placed', (e) => { const P = playerOf(e); if (P && P.onAck) P.onAck(); });
ipcMain.on('mini:glideDone', (e) => { const P = playerOf(e); if (P && P.glideEnd) P.glideEnd(); });
// Moving and resizing (popped out only): the page says when the pointer went down on the bar or a grip and when it came up; in between the window follows the cursor.
ipcMain.on('mini:gesture', (e, g) => {
  const P = playerOf(e);
  if (!P || P.mode !== 'corner' || !g || (g.kind !== 'move' && g.kind !== 'resize')) return;
  stopMiniGesture();
  if (P.gliding) return; // (a glide only lasts a moment)
  const win = P.win, c0 = screen.getCursorScreenPoint(), b0 = win.getBounds();
  const w0 = miniWidth, h0 = miniHeight(w0), left0 = b0.x + MINI_PAD, top0 = b0.y + MINI_PAD;
  let tick;
  if (g.kind === 'move') {
    const W = w0 + MINI_PAD * 2, H = h0 + MINI_PAD * 2;
    let lx = null, ly = null;
    tick = () => {
      const p = screen.getCursorScreenPoint(), x = left0 - MINI_PAD + p.x - c0.x, y = top0 - MINI_PAD + p.y - c0.y;
      if (x === lx && y === ly) return;
      lx = x; ly = y;
      win.setBounds({ x, y, width: W, height: H }); // the size is given every time, so it can't drift when crossing screens with a different scale
    };
  } else {
    const edge = String(g.edge || '');
    if (!/^(tl|tr|bl|br|t|b|l|r)$/.test(edge)) return;
    const sx = edge.includes('l') ? -1 : edge.includes('r') ? 1 : 0, sy = edge.includes('t') ? -1 : edge.includes('b') ? 1 : 0; // which way is "outwards"
    const wa = screen.getDisplayNearestPoint({ x: Math.round(left0 + w0 / 2), y: Math.round(top0 + h0 / 2) }).workArea;
    let lw = 0;
    tick = () => {
      const p = screen.getCursorScreenPoint();
      const byX = (p.x - c0.x) * sx, byY = (p.y - c0.y) * sy * (16 / 9); // a 16:9 picture grows with both pulls
      const grow = !sy ? byX : !sx ? byY : (Math.abs(byX) >= Math.abs(byY) ? byX : byY);
      const roomX = sx < 0 ? left0 + w0 - wa.x - 8 : wa.x + wa.width - 8 - left0; // the most room there is on the side it grows towards
      const roomY = (sy < 0 ? top0 + h0 - wa.y - 8 : wa.y + wa.height - 8 - top0) * 16 / 9;
      const w = Math.round(clampNum(w0 + grow, MINI_MIN, Math.max(MINI_MIN, Math.min(MINI_MAX, roomX, roomY))));
      if (w === lw) return;
      lw = w;
      const h = miniHeight(w);
      miniWidth = w;
      win.setBounds({ x: (sx < 0 ? left0 + w0 - w : left0) - MINI_PAD, y: (sy < 0 ? top0 + h0 - h : top0) - MINI_PAD, width: w + MINI_PAD * 2, height: h + MINI_PAD * 2 });
    };
  }
  miniGesture = { kind: g.kind, P, timer: setInterval(() => { if (!pAlive(P)) stopMiniGesture(); else tick(); }, 8) };
});
ipcMain.on('mini:gestureEnd', (e) => {
  const P = playerOf(e);
  if (!P || P.mode !== 'corner') return;
  const kind = miniGesture && miniGesture.kind;
  stopMiniGesture();
  const b = P.win.getBounds(), w = miniWidth, h = miniHeight(w);
  const at = miniFit(b.x + MINI_PAD, b.y + MINI_PAD, w, h, kind === 'move'); // kept on a screen; sticks to an edge only if let go very close to it
  if (at.x !== b.x + MINI_PAD || at.y !== b.y + MINI_PAD || b.width !== w + MINI_PAD * 2) P.win.setBounds({ x: at.x - MINI_PAD, y: at.y - MINI_PAD, width: w + MINI_PAD * 2, height: h + MINI_PAD * 2 });
  saveMiniPrefs({ width: w, sx: at.x, sy: at.y });
});
// "Close the player, keep playing": the window goes out of sight and the video carries on (sound only); the app decides how it comes back
ipcMain.on('mini:hide-keep', (e) => { const P = playerOf(e); if (P) toApp('player:hide', { id: P.id }); });
ipcMain.on('mini:close-self', (e) => { const P = playerOf(e); if (!P) return; const id = P.id; pDestroy(P); toApp('player:closed', { id }); });
// "Back to the level": the app opens the video's page, and the player docks over its video there
ipcMain.on('mini:return', (e) => {
  const P = playerOf(e);
  if (!P) return;
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show(); mainWindow.focus();
  }
  toApp('player:return', { id: P.id });
});
// docked videos follow the app when it is moved, resized or brought back
function pwFollowMainWindow(mw) {
  ['move', 'resize', 'maximize', 'unmaximize', 'restore', 'show', 'enter-full-screen', 'leave-full-screen'].forEach(ev => mw.on(ev, () => { for (const P of players.values()) { P.key = ''; P.lkey = ''; pApplyDocked(P); } }));
  mw.on('closed', () => pDestroyAll());
}
function pDestroyAll() { [...players.values()].forEach(P => pDestroy(P, true)); }

let quitSynced = false;
app.on('before-quit', (e) => {
  app.isQuiting = true;
  pDestroyAll();
  stopPolling();
  if (macUpdater) macUpdater.onQuit(); // an update you chose "Later" for goes in as the app quits
  try {
    if (syncer.status().enabled && !quitSynced) {
      quitSynced = true;
      if (drive.active()) { e.preventDefault(); Promise.race([safeSync('push'), new Promise(r => setTimeout(r, 8000))]).catch(() => {}).finally(() => app.quit()); } // the upload needs a moment: quit once it is done
      else syncer.syncNow('push');
    }
  } catch { /* quitting anyway */ }
});
