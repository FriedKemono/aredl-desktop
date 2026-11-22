// ---------------------------------------------------------------------------
// Updates for the Mac version.
//
// Apple's own automatic-update machinery (what `electron-updater` uses) only works for apps signed with a paid
// Apple developer certificate, which this app doesn't have. So on a Mac the app does the same job itself:
//   1. asks GitHub for the newest release,
//   2. quietly downloads the Mac .zip from it (the Dock icon shows the progress),
//   3. asks "Restart now / Later" - and swaps the new app in for the old one when it quits.
// It is the same experience as the Windows installer. If this copy can't replace itself (it is running from the
// downloaded disk image, or from a folder it can't write to) it says so and offers the download page instead.
// ---------------------------------------------------------------------------
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile, spawn } = require('child_process');
const { promisify } = require('util');
const { Readable, Transform } = require('stream');
const { pipeline } = require('stream/promises');

const execFileP = promisify(execFile);

const verParts = (v) => String(v || '').replace(/^v/i, '').split('.').map(n => parseInt(n, 10) || 0);
function isNewerVersion(a, b) {
  const x = verParts(a), y = verParts(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] || 0) - (y[i] || 0);
    if (d) return d > 0;
  }
  return false;
}

// the script that runs after the app has quit: swap the new app in (keeping the old one until the swap worked),
// then open it again if it was a "Restart now"
const APPLY_SCRIPT = `#!/bin/sh
PID="$1"; OLD="$2"; NEW="$3"; TMP="$4"; RELAUNCH="$5"
DITTO="\${DITTO:-/usr/bin/ditto}"; OPEN="\${OPEN:-/usr/bin/open}"
BACKUP="\${OLD}.previous"
n=0
while kill -0 "$PID" 2>/dev/null; do
  n=$((n+1))
  [ "$n" -gt 240 ] && exit 1
  sleep 0.5
done
rm -rf "$BACKUP"
if mv "$OLD" "$BACKUP"; then
  if "$DITTO" "$NEW" "$OLD"; then
    rm -rf "$BACKUP"
  else
    rm -rf "$OLD"
    mv "$BACKUP" "$OLD"
  fi
fi
rm -rf "$TMP"
[ "$RELAUNCH" = "1" ] && "$OPEN" "$OLD"
exit 0
`;

function createMacUpdater({ app, dialog, shell, getWindow, owner, repo, apiBase = 'https://api.github.com', fetchImpl = fetch, tools = {}, log = console }) {
  const T = { ditto: '/usr/bin/ditto', xattr: '/usr/bin/xattr', sh: '/bin/sh', ...tools };
  const state = { checking: false, downloading: null, staged: null, spawned: false, offeredManual: null };

  const win = () => { const w = getWindow && getWindow(); return w && !w.isDestroyed() ? w : undefined; };
  const progress = (v) => { const w = win(); if (w) try { w.setProgressBar(v); } catch { /* not important */ } };

  function appPath() {
    const m = /^(.*?\.app)\/Contents\/MacOS\//.exec(app.getPath('exe'));
    return m ? m[1] : null;
  }
  // can this copy of the app swap itself for a new one where it is?
  function canReplaceSelf(p) {
    if (!p || /\/AppTranslocation\//.test(p) || p.startsWith('/Volumes/')) return false;
    try { fs.accessSync(path.dirname(p), fs.constants.W_OK); fs.accessSync(p, fs.constants.W_OK); return true; } catch { return false; }
  }

  const archName = () => (process.arch === 'arm64' ? 'arm64' : 'x64');
  const assetName = () => `AREDL-Desktop-mac-${archName()}.zip`;
  const apiHeaders = { 'User-Agent': 'AREDL-Desktop', Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };

  // 1) GitHub's API: gives the files, their size and the notes in one answer. Without a token it allows only 60 requests an hour for
  //    everyone behind the same address, so a shared network (school, work, VPN, mobile data) can get "403" or "429" from it.
  async function latestFromApi() {
    const get = (url) => fetchImpl(url, { headers: apiHeaders, signal: AbortSignal.timeout(10000) }, 'Checked GitHub for an update');
    const fail = (res, what) => { const e = new Error(`GitHub answered ${res.status}${what ? ` (${what})` : ''}`); e.status = res.status; return e; };
    let rel = null;
    const res = await get(`${apiBase}/repos/${owner}/${repo}/releases/latest`);
    if (res.ok) rel = await res.json();
    else if (res.status === 404) {
      // GitHub answers 404 for "latest" when no release is marked as the latest one (a draft, a pre-release, or none yet).
      // Look through the list of releases instead and take the newest one that is published.
      const list = await get(`${apiBase}/repos/${owner}/${repo}/releases?per_page=30`);
      if (list.ok) {
        const all = (await list.json()).filter(r => r && !r.draft && r.tag_name);
        all.sort((a, b) => (isNewerVersion(a.tag_name, b.tag_name) ? -1 : isNewerVersion(b.tag_name, a.tag_name) ? 1 : 0));
        rel = all[0] || null;
      } else if (list.status !== 404) throw fail(list);
      if (!rel) throw new Error(`No published release found for ${owner}/${repo}. The repository has to be public and the release published, not a draft.`);
    } else throw fail(res, res.headers && res.headers.get('x-ratelimit-remaining') === '0' ? 'request limit reached' : '');
    return {
      version: String(rel.tag_name || '').replace(/^v/i, ''),
      asset: (rel.assets || []).find(a => a.name === assetName()) || null,
      notes: String(rel.body || ''),
      page: rel.html_url || `https://github.com/${owner}/${repo}/releases/latest`,
    };
  }

  // 2) The release pages themselves (github.com, not the API): these have no per-address request limit.
  //    "releases/latest" redirects to the newest published release, the file has a fixed address, and the notes are in the releases feed.
  async function latestFromPages() {
    const site = `https://github.com/${owner}/${repo}`;
    const res = await fetchImpl(`${site}/releases/latest`, { headers: { 'User-Agent': 'AREDL-Desktop' }, redirect: 'manual', signal: AbortSignal.timeout(10000) }, 'Looked up the newest release on GitHub');
    const loc = res.headers.get('location') || '';
    const m = /\/releases\/tag\/([^/?#]+)/.exec(loc);
    if (!m) {
      if (res.status === 404 || res.status === 200) throw new Error(`No published release found for ${owner}/${repo}. The repository has to be public and the release published, not a draft.`);
      throw new Error(`GitHub answered ${res.status}`);
    }
    const tag = decodeURIComponent(m[1]);
    if (!isNewerVersion(tag, app.getVersion())) return { version: tag.replace(/^v/i, ''), asset: null, notes: '', page: `${site}/releases/tag/${encodeURIComponent(tag)}` }; // nothing newer: no more requests
    const url = `${site}/releases/download/${encodeURIComponent(tag)}/${assetName()}`;
    // the file exists once the address redirects to the download (a 404 means the Mac files are not uploaded yet)
    const probe = await fetchImpl(url, { headers: { 'User-Agent': 'AREDL-Desktop' }, redirect: 'manual', signal: AbortSignal.timeout(10000) }, 'Checked that the Mac update is on GitHub');
    const asset = probe.status >= 300 && probe.status < 400 ? { name: assetName(), browser_download_url: url, size: 0 } : null;
    let notes = '';
    try { // the notes are a nice extra: a failure here never stops the update
      const feed = await fetchImpl(`${site}/releases.atom`, { headers: { 'User-Agent': 'AREDL-Desktop' }, signal: AbortSignal.timeout(10000) }, 'Read the release notes from GitHub');
      if (feed.ok) notes = notesFromFeed(await feed.text(), tag);
    } catch { /* no notes */ }
    return { version: tag.replace(/^v/i, ''), asset, notes, page: `${site}/releases/tag/${encodeURIComponent(tag)}` };
  }
  const unescapeXml = (t) => String(t).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&amp;/g, '&');
  function notesFromFeed(xml, tag) {
    for (const entry of String(xml).split('<entry>').slice(1)) {
      const link = /<link[^>]+href="[^"]*\/releases\/tag\/([^"?#]+)"/.exec(entry);
      if (!link || decodeURIComponent(link[1]) !== tag) continue;
      const body = /<content[^>]*>([\s\S]*?)<\/content>/.exec(entry);
      if (!body) return '';
      const html = unescapeXml(body[1]).replace(/<\/(li|p|h\d|ul|ol|div)>/gi, '\n').replace(/<br\s*\/?>/gi, '\n').replace(/<li[^>]*>/gi, '• ');
      return unescapeXml(html.replace(/<[^>]+>/g, '')).replace(/&nbsp;/g, ' ').replace(/\n{3,}/g, '\n\n').trim(); // plain text; the feed escapes its HTML once more, so entities are decoded after the tags are gone
    }
    return '';
  }

  async function latest() {
    if (!owner || !repo) throw new Error('The GitHub repository this app updates from is not set (see "repository" in package.json).');
    try {
      return await latestFromApi();
    } catch (err) {
      // a request limit (403 / 429), a GitHub hiccup or a network that only lets some addresses through: the release pages are tried next
      const retry = !err || err.status == null || err.status === 401 || err.status === 403 || err.status === 429 || err.status >= 500;
      if (!retry) throw err;
      try { return await latestFromPages(); }
      catch (err2) {
        if (err && err.status === 403) throw new Error('GitHub is limiting requests from this network (403). Try again in a while.');
        throw err2 && err2.message ? err2 : err;
      }
    }
  }

  async function download(rel) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aredl-update-'));
    const zip = path.join(dir, 'update.zip');
    const res = await fetchImpl(rel.asset.browser_download_url, { headers: { 'User-Agent': 'AREDL-Desktop' }, redirect: 'follow' }, 'Downloaded the Mac update');
    if (!res.ok || !res.body) throw new Error(`Download failed (${res.status})`);
    const total = Number(res.headers.get('content-length')) || rel.asset.size || 0;
    let got = 0;
    const counter = new Transform({ transform(chunk, _enc, cb) { got += chunk.length; if (total) progress(Math.min(0.99, got / total)); cb(null, chunk); } });
    await pipeline(Readable.fromWeb(res.body), counter, fs.createWriteStream(zip));
    if ((rel.asset.size || total) && got !== (rel.asset.size || total)) throw new Error('The download was incomplete');
    const out = path.join(dir, 'app');
    fs.mkdirSync(out);
    await execFileP(T.ditto, ['-x', '-k', zip, out]);
    const name = fs.readdirSync(out).find(n => n.endsWith('.app'));
    if (!name) throw new Error('The download did not contain the app');
    const newApp = path.join(out, name);
    await execFileP(T.xattr, ['-cr', newApp]).catch(() => {}); // (a download made by the app itself is not quarantined anyway)
    fs.rmSync(zip, { force: true });
    return { dir, newApp };
  }

  function spawnInstaller(relaunch) {
    const s = state.staged;
    if (!s || state.spawned) return;
    state.spawned = true;
    const script = path.join(s.dir, 'apply.sh');
    fs.writeFileSync(script, APPLY_SCRIPT, { mode: 0o755 });
    const child = spawn(T.sh, [script, String(process.pid), s.appPath, s.newApp, s.dir, relaunch ? '1' : '0'], { detached: true, stdio: 'ignore', env: process.env });
    child.unref();
  }
  function installAndQuit() { app.isQuiting = true; spawnInstaller(true); app.quit(); }

  const plainNotes = (md) => String(md || '').replace(/<[^>]+>/g, '').replace(/\*\*/g, '').replace(/^#+\s*/gm, '').trim().slice(0, 900);

  async function downloadAndPrompt(rel, target) {
    if (state.downloading || (state.staged && state.staged.version === rel.version)) return;
    state.downloading = rel.version;
    try {
      const { dir, newApp } = await download(rel);
      state.staged = { version: rel.version, dir, newApp, appPath: target };
      progress(-1);
      const notes = plainNotes(rel.notes);
      const { response } = await dialog.showMessageBox(win(), {
        type: 'info',
        buttons: ['Restart now', 'Later'],
        defaultId: 0,
        cancelId: 1,
        title: 'Update ready',
        message: `AREDL Desktop ${rel.version} is ready to install.`,
        detail: (notes ? `${notes}\n\n` : '') + 'Restart to finish updating. If you choose Later, it installs the next time you quit the app.',
      });
      if (response === 0) installAndQuit();
    } catch (err) {
      progress(-1);
      log.warn('Mac update failed:', err && err.message);
    } finally {
      state.downloading = null;
    }
  }

  async function offerManual(rel) {
    if (state.offeredManual === rel.version) return;
    state.offeredManual = rel.version;
    const { response } = await dialog.showMessageBox(win(), {
      type: 'info',
      buttons: ['Open download page', 'Later'],
      defaultId: 0,
      cancelId: 1,
      title: 'Update available',
      message: `AREDL Desktop ${rel.version} is available.`,
      detail: "This copy can't update itself where it is. Move AREDL Desktop into your Applications folder (then it can), or download the new version yourself.",
    });
    if (response === 0) shell.openExternal(rel.page);
  }

  // manual = the person pressed "Check for updates" (the answer goes back to Settings); otherwise a quiet background check
  async function check(manual = false) {
    if (state.staged) return { status: 'available', version: state.staged.version };
    if (state.downloading) return { status: 'available', version: state.downloading };
    if (state.checking) return { status: 'up-to-date' };
    state.checking = true;
    try {
      const rel = await latest();
      if (!rel.version || !isNewerVersion(rel.version, app.getVersion())) return { status: 'up-to-date' };
      // the Windows files go up first and the Mac ones a few minutes later: nothing to install yet, so look again later
      if (!rel.asset) return { status: 'up-to-date' };
      const target = appPath();
      if (!canReplaceSelf(target)) { offerManual(rel).catch(() => {}); return { status: 'manual', version: rel.version, url: rel.page }; }
      downloadAndPrompt(rel, target); // in the background, like the Windows download
      return { status: 'available', version: rel.version };
    } catch (err) {
      return { status: 'error', message: String((err && err.message) || err).split('\n')[0].slice(0, 220) };
    } finally {
      state.checking = false;
    }
  }

  function start() {
    if (!app.isPackaged) return false;
    const run = () => check(false).catch(() => {}); // offline / no release yet: stay quiet
    setTimeout(run, 8000);                  // shortly after start-up
    setInterval(run, 4 * 60 * 60 * 1000);   // and every 4 hours while it's running
    return true;
  }
  // called when the app quits: if an update was downloaded and you chose "Later", it goes in now
  function onQuit() { spawnInstaller(false); }

  return { start, check, onQuit, _state: state, _isNewer: isNewerVersion, _notesFromFeed: notesFromFeed };
}

module.exports = { createMacUpdater, isNewerVersion };
