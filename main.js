const { app, BrowserWindow, Tray, Menu, Notification, ipcMain, safeStorage, nativeImage, shell, dialog } = require('electron');
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
  levelRecords: (levelId, page, mode) => `${API_BASE}/${apiPrefix(mode)}/levels/${levelId}/records?page=${page}`, // confirmed endpoint, page param follows the same convention as changelog
  submissions: (mode) => `${API_BASE}/${apiPrefix(mode)}/submissions/@me`, // confirmed by user
  submissionQueue: (id, mode) => `${API_BASE}/${apiPrefix(mode)}/submissions/${id}/queue`, // confirmed by user
  notifications: `${API_BASE}/users/@me/notifications`, // one feed for the account, not per list
  profile: (id, mode) => `${API_BASE}/${apiPrefix(mode)}/profile/${id}`,
  changelog: (page, mode) => `${API_BASE}/${apiPrefix(mode)}/changelog?page=${page}`,
  leaderboard: (page, mode) => `${API_BASE}/${apiPrefix(mode)}/leaderboard?page=${page}&per_page=50`,
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
  requestLog.push(entry);
  if (requestLog.length > REQUEST_LOG_MAX) requestLog.shift();
  if (mainWindow) mainWindow.webContents.send('requestLog:new', entry);
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
    logRequest({ url, status, ok: false, timestamp: startedAt, error: err ? err.message : text.slice(0, 200) });
    if (err) throw err;
    const e = new Error(reasonFromErrorBody(text, status));
    e.status = status;
    throw e;
  }

  logRequest({ url, status: res.status, ok: true, timestamp: startedAt });
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

function startLocalServer() {
  return new Promise((resolve) => {
    const rendererDir = path.join(__dirname, 'renderer');
    const server = http.createServer((req, res) => {
      const urlPath = decodeURIComponent(req.url.split('?')[0]);
      let filePath = path.join(rendererDir, urlPath === '/' ? 'index.html' : urlPath);
      if (!filePath.startsWith(rendererDir)) { res.writeHead(403); res.end(); return; }
      fs.readFile(filePath, (err, data) => {
        if (err) { res.writeHead(404); res.end('Not found'); return; }
        res.writeHead(200, { 'Content-Type': MIME_TYPES[path.extname(filePath).toLowerCase()] || 'application/octet-stream' });
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
    // their normal frame.
    ...(process.platform === 'win32' ? {
      titleBarStyle: 'hidden',
      titleBarOverlay: { ...(loadSettings().overlay || { color: '#00000000', symbolColor: '#a1a1aa' }), height: 36 },
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
      mainWindow.hide();
    }
  });
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
const STORE_NAMES = new Set(['following', 'follow-notifications', 'personal-list']);
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
async function fetchNewgroundsSong(id) {
  const res = await fetch(`https://www.newgrounds.com/audio/listen/${id}`, {
    headers: { 'User-Agent': SONG_UA, Accept: 'text/html,application/xhtml+xml', 'Accept-Language': 'en-US,en;q=0.8' },
    redirect: 'follow',
    signal: AbortSignal.timeout(9000),
  });
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
  const res = await fetch('https://www.boomlings.com/database/getGJSongInfo.php', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': '' },
    body: `songID=${id}&secret=Wmfd2893gb7`,
    signal: AbortSignal.timeout(7000),
  });
  const text = (await res.text()).trim();
  if (!res.ok || !text.includes('~|~')) throw new Error('The game server has no such song');
  const parts = text.split('~|~'), map = {};
  for (let i = 0; i + 1 < parts.length; i += 2) map[parts[i]] = parts[i + 1];
  return { name: decodeEntities(map['2'] || ''), artist: decodeEntities(map['4'] || '') };
}
const songInflight = new Map();
async function lookupSong(id, force = false) {
  const cache = loadSongCache();
  if (cache[id] && !force) return { ok: true, id, ...cache[id] };
  const gdP = fetchGdSong(id).catch(() => ({}));
  let ng = {}, ngErr = null;
  try { ng = await fetchNewgroundsSong(id); } catch (err) { ngErr = err; }
  let name = ng.name, artist = ng.artist;
  if (!name || !artist) { const gd = await gdP; name = name || gd.name; artist = artist || gd.artist; }
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

ipcMain.handle('api:getLeaderboard', async (_e, page, mode) => apiFetch(ENDPOINTS.leaderboard(page || 1, mode)));
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
    .map(f => ({ level_id: f.level_id, name: String(f.name || ''), label: String(f.label || 'favourited').slice(0, 24) }));
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
function setupAutoUpdate() {
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
  if (!autoUpdater) return { status: process.env.PORTABLE_EXECUTABLE_FILE ? 'portable' : 'dev' };
  try {
    const r = await autoUpdater.checkForUpdates();
    return r && r.isUpdateAvailable ? { status: 'available', version: r.updateInfo.version } : { status: 'up-to-date' };
  } catch (err) {
    return { status: 'error', message: String((err && err.message) || err).split('\n')[0].slice(0, 160) };
  }
});

app.whenReady().then(async () => {
  Menu.setApplicationMenu(null);
  await startLocalServer();
  createWindow();
  createTray();
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

app.on('before-quit', () => {
  app.isQuiting = true;
  stopPolling();
});
