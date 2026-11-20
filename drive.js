// ---------------------------------------------------------------------------
// Google Drive as a place to keep the sync file.
//
// The person signs in with their Google account in the browser (OAuth 2.0 for installed apps: a one-time loopback
// address on this computer and PKCE, so no password ever reaches the app). The refresh token is kept encrypted with the
// operating system's keychain (Electron safeStorage), the same way the AREDL API key is.
//
// Sync itself is unchanged (sync.js works on a folder on disk). For Google Drive that folder is a small local copy:
// before a sync the sync file is downloaded from the chosen Drive folder into it, and afterwards it is uploaded again if
// it changed. Only that one file (AREDL-Desktop-sync.json) is ever read or written; folders are only listed.
// ---------------------------------------------------------------------------
const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');

const SCOPE = 'https://www.googleapis.com/auth/drive';
const FILE_NAME = 'AREDL-Desktop-sync.json';
const FOLDER_MIME = 'application/vnd.google-apps.folder';
const FORMAT = 1;
let builtin = {};
try { builtin = require('./drive-config'); } catch { /* no built-in client: it can be entered in Settings */ }
// drive-config.local.js is git-ignored, so a client ID and secret kept there are never committed
try { const local = require('./drive-config.local'); if (local && (local.clientId || local.clientSecret)) builtin = local; } catch { /* no local client file */ }

const b64url = (buf) => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
const md5 = (text) => crypto.createHash('md5').update(text).digest('hex');

function createDrive({ userDataDir, safeStorage, openExternal, request, log = console }) {
  const tokenPath = () => path.join(userDataDir(), 'drive-token.bin');
  const clientPath = () => path.join(userDataDir(), 'drive-client.json');
  const statePath = () => path.join(userDataDir(), 'drive-sync.json');
  const cacheDir = () => path.join(userDataDir(), 'drive-cache');
  const cacheFile = () => path.join(cacheDir(), FILE_NAME);

  // ---- the OAuth client (made by the person who builds / uses the app in Google Cloud Console) ----
  function client() {
    let saved = {};
    try { saved = JSON.parse(fs.readFileSync(clientPath(), 'utf8')); } catch { /* none saved */ }
    return { clientId: String(saved.clientId || builtin.clientId || '').trim(), clientSecret: String(saved.clientSecret || builtin.clientSecret || '').trim(), builtIn: !saved.clientId && !!builtin.clientId };
  }
  function setClient(clientId, clientSecret) {
    fs.writeFileSync(clientPath(), JSON.stringify({ clientId: String(clientId || '').trim().slice(0, 200), clientSecret: String(clientSecret || '').trim().slice(0, 200) }));
  }

  // ---- tokens (encrypted at rest) ----
  let tokens = null;
  function loadTokens() {
    if (tokens) return tokens;
    try {
      const raw = fs.readFileSync(tokenPath());
      tokens = JSON.parse(safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(raw) : raw.toString('utf8'));
    } catch { tokens = null; }
    return tokens;
  }
  function saveTokens(t) {
    tokens = t;
    const text = JSON.stringify(t);
    fs.writeFileSync(tokenPath(), safeStorage.isEncryptionAvailable() ? safeStorage.encryptString(text) : text);
  }
  function clearTokens() { tokens = null; try { fs.rmSync(tokenPath(), { force: true }); } catch { /* already gone */ } }

  // ---- what is chosen: which Drive folder, and what the local copy matched last time ----
  let state = null;
  function loadState() {
    if (state) return state;
    try { state = JSON.parse(fs.readFileSync(statePath(), 'utf8')); } catch { state = {}; }
    if (!isObj(state)) state = {};
    return state;
  }
  function saveState() { try { fs.writeFileSync(statePath(), JSON.stringify(state)); } catch (err) { log.warn && log.warn('drive state not saved:', err.message); } }

  async function parseError(res) {
    let text = ''; try { text = await res.text(); } catch { /* no body */ }
    try { const j = JSON.parse(text); return (j.error && (j.error.message || j.error_description)) || j.error_description || (typeof j.error === 'string' ? j.error : '') || `HTTP ${res.status}`; } catch { return `HTTP ${res.status}`; }
  }
  async function tokenRequest(params, what) {
    const c = client();
    const res = await request('https://oauth2.googleapis.com/token', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: c.clientId, client_secret: c.clientSecret, ...params }).toString(), signal: AbortSignal.timeout(20000),
    }, what);
    if (!res.ok) { const e = new Error(await parseError(res)); e.status = res.status; throw e; }
    return res.json();
  }

  // ---- signing in ----
  let pending = null;
  function cancelSignIn() { if (pending) pending.cancel(); }
  async function signIn() {
    const c = client();
    if (!c.clientId || !c.clientSecret) throw new Error('Google Drive isn’t set up yet: add the OAuth client ID and secret first.');
    cancelSignIn();
    const verifier = b64url(crypto.randomBytes(32)), challenge = b64url(crypto.createHash('sha256').update(verifier).digest()), stateParam = b64url(crypto.randomBytes(16));
    const server = http.createServer();
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const redirect = `http://127.0.0.1:${server.address().port}`;
    let timer = null;
    const code = await new Promise((resolve, reject) => {
      const done = (fn, v) => { clearTimeout(timer); pending = null; try { server.close(); } catch { /* closed */ } fn(v); };
      pending = { cancel: () => done(reject, new Error('Sign-in cancelled.')) };
      timer = setTimeout(() => done(reject, new Error('Sign-in timed out. Try again.')), 3 * 60 * 1000);
      server.on('request', (req, res) => {
        const u = new URL(req.url, redirect);
        if (u.pathname !== '/') { res.writeHead(404); res.end(); return; }
        const page = (msg) => { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(`<!doctype html><meta charset="utf-8"><title>AREDL Desktop</title><body style="font-family:system-ui;background:#111;color:#eee;display:grid;place-items:center;height:100vh;margin:0"><div style="text-align:center"><h2>${msg}</h2><p>You can close this tab and go back to AREDL Desktop.</p></div>`); };
        if (u.searchParams.get('state') !== stateParam) { page('That sign-in did not match.'); return; }
        if (u.searchParams.get('error')) { page('Sign-in was not completed.'); done(reject, new Error(u.searchParams.get('error') === 'access_denied' ? 'Access was not granted.' : `Google said: ${u.searchParams.get('error')}`)); return; }
        const got = u.searchParams.get('code');
        if (!got) { page('Nothing to sign in with.'); return; }
        page('Signed in to Google Drive.'); done(resolve, got);
      });
      const url = 'https://accounts.google.com/o/oauth2/v2/auth?' + new URLSearchParams({
        client_id: c.clientId, redirect_uri: redirect, response_type: 'code', scope: SCOPE, code_challenge: challenge, code_challenge_method: 'S256',
        access_type: 'offline', prompt: 'consent', state: stateParam,
      }).toString();
      openExternal(url);
    });
    const t = await tokenRequest({ code, code_verifier: verifier, grant_type: 'authorization_code', redirect_uri: redirect }, 'Google Drive: signed in');
    if (!t.refresh_token) throw new Error('Google did not give lasting access. Remove the app at myaccount.google.com/permissions and try again.');
    saveTokens({ refresh_token: t.refresh_token, access_token: t.access_token, expires_at: Date.now() + (t.expires_in || 3600) * 1000, email: null });
    try { const me = await api('GET', 'https://www.googleapis.com/drive/v3/about?fields=user(displayName,emailAddress)', {}, 'Google Drive: checked the account'); loadTokens().email = (me.user && (me.user.emailAddress || me.user.displayName)) || null; saveTokens(tokens); } catch { /* the name is only for display */ }
    return info();
  }
  async function accessToken(forceRefresh = false) {
    const t = loadTokens();
    if (!t) throw new Error('Not signed in to Google.');
    if (!forceRefresh && t.access_token && t.expires_at > Date.now() + 60000) return t.access_token;
    try {
      const r = await tokenRequest({ refresh_token: t.refresh_token, grant_type: 'refresh_token' }, 'Google Drive: renewed access');
      t.access_token = r.access_token; t.expires_at = Date.now() + (r.expires_in || 3600) * 1000; saveTokens(t);
      return t.access_token;
    } catch (err) {
      if (/invalid_grant|revoked|expired/i.test(err.message) || err.status === 400 || err.status === 401) { clearTokens(); throw new Error('The Google sign-in has expired. Sign in again.'); }
      throw err;
    }
  }
  async function api(method, url, { body, headers, text } = {}, what = 'Google Drive') {
    for (let attempt = 0; attempt < 2; attempt++) {
      const res = await request(url, { method, headers: { Authorization: `Bearer ${await accessToken(attempt > 0)}`, ...(headers || {}) }, body, signal: AbortSignal.timeout(30000) }, what);
      if (res.status === 401 && attempt === 0) continue;
      if (!res.ok) throw new Error(await parseError(res));
      return text ? res.text() : res.json();
    }
    throw new Error('Google refused the request.');
  }
  async function signOut() {
    const t = loadTokens();
    if (t && t.refresh_token) { try { await request(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(t.refresh_token)}`, { method: 'POST', signal: AbortSignal.timeout(10000) }, 'Google Drive: signed out'); } catch { /* the token is deleted here either way */ } }
    clearTokens(); disconnect();
    return info();
  }

  // ---- folders and the sync file ----
  const q = (s) => encodeURIComponent(s);
  async function listFolders() {
    const folders = [], saves = new Map();
    let page = '';
    for (let i = 0; i < 5; i++) {
      const r = await api('GET', `https://www.googleapis.com/drive/v3/files?q=${q(`mimeType='${FOLDER_MIME}' and trashed=false`)}&fields=nextPageToken,files(id,name,modifiedTime)&pageSize=200&orderBy=modifiedTime%20desc${page}`, {}, 'Google Drive: listed folders');
      folders.push(...(r.files || []));
      if (!r.nextPageToken) break; page = `&pageToken=${encodeURIComponent(r.nextPageToken)}`;
    }
    const s = await api('GET', `https://www.googleapis.com/drive/v3/files?q=${q(`name='${FILE_NAME}' and trashed=false`)}&fields=files(id,parents,modifiedTime)&pageSize=100`, {}, 'Google Drive: looked for AREDL saves');
    (s.files || []).forEach(f => (f.parents || []).forEach(p => saves.set(p, f.modifiedTime)));
    return folders.map(f => ({ id: f.id, name: f.name, modifiedTime: f.modifiedTime, hasSave: saves.has(f.id), saveModified: saves.get(f.id) || null }))
      .sort((a, b) => (b.hasSave - a.hasSave) || String(b.modifiedTime).localeCompare(String(a.modifiedTime)));
  }
  async function findFile(folderId) {
    if (!/^[\w-]{5,}$/.test(String(folderId))) throw new Error('That folder isn’t valid.');
    const r = await api('GET', `https://www.googleapis.com/drive/v3/files?q=${q(`'${folderId}' in parents and name='${FILE_NAME}' and trashed=false`)}&fields=files(id,name,modifiedTime,md5Checksum,size)&orderBy=modifiedTime%20desc&pageSize=5`, {}, 'Google Drive: looked for the sync file');
    return (r.files || [])[0] || null;
  }
  // is this folder really an AREDL save? (the file exists, and is a sync file this version understands)
  async function inspect(folderId) {
    const file = await findFile(folderId);
    if (!file) return { valid: false, reason: 'no-save' };
    if (Number(file.size) > 40 * 1024 * 1024) return { valid: false, reason: 'not-aredl' };
    let doc;
    try { doc = JSON.parse(await api('GET', `https://www.googleapis.com/drive/v3/files/${file.id}?alt=media`, { text: true }, 'Google Drive: read the sync file')); } catch (err) { return { valid: false, reason: 'not-aredl', detail: err.message }; }
    if (!isObj(doc) || !isObj(doc.sections) || !Number.isFinite(Number(doc['aredl-desktop-sync']))) return { valid: false, reason: 'not-aredl' };
    if (Number(doc['aredl-desktop-sync']) > FORMAT) return { valid: false, reason: 'newer' };
    const parts = Object.keys(doc.sections).filter(k => isObj(doc.sections[k])).map(k => ({ id: k, by: typeof doc.sections[k].by === 'string' ? doc.sections[k].by.slice(0, 40) : null, updatedAt: doc.sections[k].updatedAt || null }));
    return { valid: true, fileId: file.id, updated: doc.updated || file.modifiedTime || null, parts };
  }
  async function createFolder(name) {
    const r = await api('POST', 'https://www.googleapis.com/drive/v3/files?fields=id,name', { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: String(name || 'AREDL Desktop').slice(0, 100), mimeType: FOLDER_MIME }) }, 'Google Drive: made a folder');
    return { id: r.id, name: r.name };
  }
  async function upload(folderId, fileId, text) {
    const fields = 'id,md5Checksum,modifiedTime';
    if (fileId) return api('PATCH', `https://www.googleapis.com/upload/drive/v3/files/${fileId}?uploadType=media&fields=${fields}`, { headers: { 'Content-Type': 'application/json' }, body: text }, 'Google Drive: saved the sync file');
    const boundary = `aredl${crypto.randomBytes(8).toString('hex')}`;
    const body = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify({ name: FILE_NAME, parents: [folderId], mimeType: 'application/json' })}\r\n--${boundary}\r\nContent-Type: application/json\r\n\r\n${text}\r\n--${boundary}--`;
    return api('POST', `https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=${fields}`, { headers: { 'Content-Type': `multipart/related; boundary=${boundary}` }, body }, 'Google Drive: saved the sync file');
  }

  // ---- used around every sync ----
  const active = () => { const s = loadState(), t = loadTokens(); return !!(s.folderId && t); };
  async function pull() { // newest copy of the sync file from Drive into the local copy
    const s = loadState();
    const file = await findFile(s.folderId);
    if (!file) return { exists: false };
    s.fileId = file.id;
    if (file.md5Checksum !== s.md5 || !fs.existsSync(cacheFile())) {
      const text = await api('GET', `https://www.googleapis.com/drive/v3/files/${file.id}?alt=media`, { text: true }, 'Google Drive: read the sync file');
      fs.mkdirSync(cacheDir(), { recursive: true });
      const tmp = `${cacheFile()}.${process.pid}.tmp`; fs.writeFileSync(tmp, text); fs.renameSync(tmp, cacheFile());
      s.md5 = file.md5Checksum || md5(text);
    }
    saveState();
    return { exists: true };
  }
  async function push() { // the local copy to Drive, only if it changed
    const s = loadState();
    if (!fs.existsSync(cacheFile())) return { uploaded: false };
    const text = fs.readFileSync(cacheFile(), 'utf8');
    if (md5(text) === s.md5) return { uploaded: false };
    const r = await upload(s.folderId, s.fileId, text);
    s.fileId = r.id; s.md5 = r.md5Checksum || md5(text); saveState();
    return { uploaded: true };
  }
  // mode: 'use' (bring the existing save in), 'overwrite' (start the save again from this computer), 'create' (a new folder)
  async function connect({ folderId, name, mode }) {
    let id = folderId, label = name;
    if (mode === 'create') { const f = await createFolder(name); id = f.id; label = f.name; }
    if (!/^[\w-]{5,}$/.test(String(id))) throw new Error('That folder isn’t valid.');
    state = { folderId: id, folderName: String(label || 'Folder').slice(0, 100), fileId: null, md5: null };
    fs.mkdirSync(cacheDir(), { recursive: true });
    if (mode === 'use') {
      const r = await pull();
      if (!r.exists) { state = {}; saveState(); throw new Error('That folder no longer has an AREDL save.'); }
    } else {
      const existing = mode === 'overwrite' ? await findFile(id) : null;
      if (existing) state.fileId = existing.id;
      fs.writeFileSync(cacheFile(), JSON.stringify({ 'aredl-desktop-sync': FORMAT, sections: {}, updated: new Date().toISOString() }));
      await push();
    }
    saveState();
    return info();
  }
  function disconnect() { state = {}; saveState(); try { fs.rmSync(cacheFile(), { force: true }); } catch { /* nothing to remove */ } }
  function info() {
    const c = client(), t = loadTokens(), s = loadState();
    return { configured: !!(c.clientId && c.clientSecret), builtIn: c.builtIn, signedIn: !!t, account: t ? t.email : null, folder: t && s.folderId ? { id: s.folderId, name: s.folderName } : null, cacheDir: cacheDir(), fileName: FILE_NAME };
  }
  return { info, setClient, signIn, cancelSignIn, signOut, listFolders, inspect, connect, disconnect, active, pull, push, cacheDir };
}

module.exports = { createDrive, FILE_NAME };
