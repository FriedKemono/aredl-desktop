// ---------------------------------------------------------------------------
// Sync between computers through a shared folder (OneDrive, iCloud Drive, Dropbox, a network drive...).
//
// Each computer keeps its own copy of the app's data. The sync folder holds ONE file, AREDL-Desktop-sync.json, with one
// block per kind of data (settings, favourites, custom lists, saved filters, followed levels, personal list, cleared
// notifications). A sync compares, for every block you have switched on:
//   * what is on this computer,
//   * what is in the file,
//   * and what it looked like the last time the two matched (a fingerprint kept here),
// and then: nothing changed -> nothing happens; only this computer changed -> it is written to the file; only the file
// changed -> it is brought here; both changed -> the newer one is kept and the other one is saved in sync-backups/
// first. The very first sync of a block that differs on both sides MERGES the lists (nothing is lost) instead.
//
// What travels is exactly what an export carries (see settings-transfer.js): never the account / API key. Settings that
// only exist on one system (the Windows window-button colours) stay where they are. Anything read from the file is
// treated as untrusted and cleaned the same way as an import.
// ---------------------------------------------------------------------------
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const transfer = require('./settings-transfer');

const SYNC_FILE = 'AREDL-Desktop-sync.json';
const FORMAT = 1;
const MAX_BYTES = 40 * 1024 * 1024;
const SECTION_IDS = transfer.SECTION_IDS; // settings, favourites, lists, following, personal, filters, notifications

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
const stable = (v) => JSON.stringify(v, (_k, x) => (isObj(x) ? Object.fromEntries(Object.keys(x).sort().map(k => [k, x[k]])) : x));
const hash = (v) => crypto.createHash('sha1').update(stable(v)).digest('hex');

class SyncError extends Error {}

// the settings that mean the same thing on Windows and on a Mac
const portable = (k) => { const sp = transfer.SPEC[k]; return !!sp && (!sp.platforms || (sp.platforms.includes('win32') && sp.platforms.includes('darwin'))); };

// ---- what one block looks like (the cleaned form, the same on every computer) ----
function payloadOf(id, src) {
  const L = (kind, list) => transfer.cleanList(kind, list).items;
  switch (id) {
    case 'settings': {
      const out = {};
      for (const k of Object.keys(transfer.SPEC)) {
        if (!portable(k) || !src.settings || !(k in src.settings)) continue;
        const v = transfer.SPEC[k].check(src.settings[k]);
        if (v !== undefined) out[k] = v;
      }
      return out;
    }
    case 'favourites': return L('favourites', src.favourites);
    case 'lists': return L('lists', src.customLists);
    case 'filters': return L('filters', src.savedFilters);
    case 'personal': return L('personal', src.personal);
    case 'notifications': return L('notifications', src.clearedNotifications);
    case 'following': return { following: L('following', src.following), notices: L('followNotifications', src.followNotifications) };
    default: return null;
  }
}
// the same cleaning for what was read from the file (it may have been edited, damaged, or written by another version)
function cleanRemote(id, raw) {
  switch (id) {
    case 'settings': {
      const out = {};
      if (isObj(raw)) for (const k of Object.keys(raw)) if (portable(k)) { const v = transfer.SPEC[k].check(raw[k]); if (v !== undefined) out[k] = v; }
      return out;
    }
    case 'following': return { following: transfer.cleanList('following', isObj(raw) ? raw.following : []).items, notices: transfer.cleanList('followNotifications', isObj(raw) ? raw.notices : []).items };
    case 'favourites': case 'lists': case 'filters': case 'personal': case 'notifications': return transfer.cleanList(id, raw).items;
    default: return null;
  }
}
const isEmpty = (id, p) => (id === 'settings' ? !Object.keys(p).length : id === 'following' ? !p.following.length && !p.notices.length : !p.length);

// two different versions of a block combined without losing either (used for the first sync only)
function mergeBlocks(id, a, b) {
  if (id === 'following') {
    return { following: transfer.combine('following', a.following, b.following, 'merge').list, notices: transfer.combine('followNotifications', a.notices, b.notices, 'merge').list };
  }
  if (id === 'settings') return null; // settings can't be merged meaningfully: the newer side wins
  return transfer.combine(id, a, b, 'merge').list;
}

function createSync({ userDataDir, io, now = () => Date.now(), log = console }) {
  const statePath = () => path.join(userDataDir(), 'sync-state.json');
  const backupDir = () => path.join(userDataDir(), 'sync-backups');
  const defaults = () => ({ folder: null, enabled: false, parts: ['settings', 'favourites', 'lists', 'filters', 'following', 'personal'], hashes: {}, lastSyncAt: null, lastSummary: null, device: os.hostname().slice(0, 40) });
  let state = null;
  function load() {
    if (state) return state;
    try { state = { ...defaults(), ...JSON.parse(fs.readFileSync(statePath(), 'utf8')) }; } catch { state = defaults(); }
    if (!Array.isArray(state.parts)) state.parts = defaults().parts;
    state.parts = state.parts.filter(p => SECTION_IDS.includes(p));
    if (!isObj(state.hashes)) state.hashes = {};
    return state;
  }
  function save() { try { fs.writeFileSync(statePath(), JSON.stringify(state)); } catch (err) { log.warn && log.warn('sync state not saved:', err.message); } }
  const file = () => path.join(load().folder, SYNC_FILE);

  function readRemote() {
    const f = file();
    if (!fs.existsSync(f)) return { exists: false, doc: { 'aredl-desktop-sync': FORMAT, sections: {} } };
    let size;
    try { size = fs.statSync(f).size; } catch (err) { throw new SyncError(`Couldn't read the sync file (${err.message}).`); }
    if (size > MAX_BYTES) throw new SyncError('The sync file is far bigger than it should be, so it was left alone.');
    let doc;
    try { doc = JSON.parse(fs.readFileSync(f, 'utf8')); } catch { throw new SyncError('The sync file is damaged (it could not be read). Move it away and sync again to start a fresh one.'); }
    if (!isObj(doc) || !isObj(doc.sections)) throw new SyncError("The file in the sync folder isn't an AREDL Desktop sync file.");
    if (Number(doc['aredl-desktop-sync']) > FORMAT) throw new SyncError('The sync file was made by a newer version of the app. Update this app to keep syncing.');
    return { exists: true, doc };
  }
  function writeRemote(doc) {
    doc['aredl-desktop-sync'] = FORMAT;
    doc.updated = new Date(now()).toISOString();
    const f = file(), tmp = `${f}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(doc));
    fs.renameSync(tmp, f); // the file is replaced in one step, so another computer never sees half of it
  }
  function backup(id, which, data) {
    try {
      fs.mkdirSync(backupDir(), { recursive: true });
      fs.writeFileSync(path.join(backupDir(), `${new Date(now()).toISOString().replace(/[:.]/g, '-')}-${id}-${which}.json`), JSON.stringify(data));
      const all = fs.readdirSync(backupDir()).sort();
      all.slice(0, Math.max(0, all.length - 40)).forEach(n => fs.rmSync(path.join(backupDir(), n), { force: true })); // keep the latest 40
    } catch { /* a backup that can't be written must not stop the sync */ }
  }

  // mode 'save' / 'load': an explicit choice where one side replaces the other (what "Sync now" asks about).
  // mode 'full': both directions. mode 'push': only send this computer's changes (what runs in the background and when
  // the app quits); anything that needs bringing here is reported as "waiting" for you to sync on purpose.
  function syncNow(mode = 'full') {
    const st = load();
    if (!st.folder) return { ok: false, error: 'Choose a sync folder first.' };
    if (!fs.existsSync(st.folder)) return { ok: false, error: `The sync folder can't be found (${st.folder}). Is the drive connected / is OneDrive running?` };
    const result = { ok: true, mode, pushed: [], pulled: [], merged: [], waiting: [], conflicts: [], unchanged: 0, at: new Date(now()).toISOString() };
    let remote;
    try { remote = readRemote(); } catch (err) { return { ok: false, error: err.message }; }
    const doc = remote.doc;
    const src = io.source();
    let writeNeeded = false;

    for (const id of st.parts) {
      const local = payloadOf(id, src), lh = hash(local);
      const rs = isObj(doc.sections[id]) ? doc.sections[id] : null;
      // 'save': this computer's data replaces what the folder holds (the old copy is kept in sync-backups first)
      if (mode === 'save') {
        const old = rs ? cleanRemote(id, rs.data) : null;
        if (old && !isEmpty(id, old) && hash(old) !== lh) backup(id, 'replaced-remote', old);
        doc.sections[id] = { updatedAt: new Date(now()).toISOString(), by: st.device, data: local };
        st.hashes[id] = lh; writeNeeded = true; result.pushed.push(id); continue;
      }
      // 'load': what the folder holds replaces this computer's data (this computer's copy is kept in sync-backups first)
      if (mode === 'load') {
        const rem = rs ? cleanRemote(id, rs.data) : null;
        if (!rem) { result.unchanged++; continue; }
        if (hash(rem) === lh) { st.hashes[id] = lh; result.unchanged++; continue; }
        backup(id, 'replaced-local', local);
        io.apply(id, rem); st.hashes[id] = hash(payloadOf(id, io.source())); result.pulled.push(id); continue;
      }
      const rem = rs ? cleanRemote(id, rs.data) : null, rh = rem ? hash(rem) : null;
      const last = st.hashes[id] || null;
      const push = () => { doc.sections[id] = { updatedAt: new Date(now()).toISOString(), by: st.device, data: local }; st.hashes[id] = lh; writeNeeded = true; result.pushed.push(id); };
      const pull = (data) => { io.apply(id, data); st.hashes[id] = hash(payloadOf(id, io.source())); result.pulled.push(id); };

      if (!rem) { if (!isEmpty(id, local)) push(); else result.unchanged++; continue; }
      if (lh === rh) { st.hashes[id] = lh; result.unchanged++; continue; }

      const localChanged = lh !== last, remoteChanged = rh !== last;
      const remoteAt = Date.parse(rs.updatedAt) || 0, localAt = io.mtime(id) || 0;
      if (last === null) { // the two have never matched: combine the lists, let the newer settings win
        if (mode === 'push') { result.waiting.push(id); continue; }
        if (isEmpty(id, rem)) { push(); continue; }                 // nothing there yet: this computer's copy starts it
        if (isEmpty(id, local)) { pull(rem); continue; }            // a new computer joining: it gets what is already there
        const merged = mergeBlocks(id, local, rem);
        if (merged) {
          backup(id, 'before-merge-local', local); backup(id, 'before-merge-remote', rem);
          io.apply(id, merged);
          const final = payloadOf(id, io.source());
          doc.sections[id] = { updatedAt: new Date(now()).toISOString(), by: st.device, data: final };
          st.hashes[id] = hash(final); writeNeeded = true; result.merged.push(id);
          continue;
        }
      }
      if (localChanged && !remoteChanged && last !== null) { push(); continue; }
      if (!localChanged && remoteChanged) { if (mode === 'push') { result.waiting.push(id); continue; } pull(rem); continue; }
      // both sides changed (or settings that never matched): keep the newer, save the other
      if (mode === 'push') { result.waiting.push(id); continue; }
      if (localAt >= remoteAt) { backup(id, 'replaced-remote', rem); push(); result.conflicts.push({ id, kept: 'this computer' }); }
      else { backup(id, 'replaced-local', local); pull(rem); result.conflicts.push({ id, kept: 'the other computer' }); }
    }
    try { if (writeNeeded) writeRemote(doc); } catch (err) { return { ok: false, error: `Couldn't write to the sync folder (${err.message}).` }; }
    st.lastSyncAt = result.at;
    st.lastSummary = { pushed: result.pushed, pulled: result.pulled, merged: result.merged, waiting: result.waiting, conflicts: result.conflicts, mode };
    save();
    return result;
  }

  // ---- settings of the sync itself ----
  function status() {
    const st = load();
    let remoteInfo = null;
    if (st.folder) {
      try {
        const r = readRemote();
        if (!r.exists) remoteInfo = { exists: false };
        else {
          const sections = {};
          for (const id of Object.keys(r.doc.sections)) {
            if (!SECTION_IDS.includes(id) || !isObj(r.doc.sections[id])) continue;
            const s = r.doc.sections[id], data = cleanRemote(id, s.data);
            sections[id] = { by: typeof s.by === 'string' ? s.by.slice(0, 40) : null, updatedAt: s.updatedAt || null, empty: isEmpty(id, data) };
          }
          remoteInfo = { exists: true, updated: r.doc.updated || null, parts: Object.keys(sections), sections };
        }
      } catch (err) { remoteInfo = { error: err.message }; }
    }
    return { folder: st.folder, provider: providerOf(st.folder), enabled: st.enabled, parts: st.parts.slice(), device: st.device, lastSyncAt: st.lastSyncAt, lastSummary: st.lastSummary, remote: remoteInfo, folderOk: !!st.folder && fs.existsSync(st.folder), file: st.folder ? file() : null };
  }
  // What the first sync would do for each part, worked out WITHOUT changing anything (shown when a folder is chosen).
  function preview() {
    const st = load();
    if (!st.folder || !fs.existsSync(st.folder)) return { ok: false };
    let remote;
    try { remote = readRemote(); } catch (err) { return { ok: false, error: err.message }; }
    const src = io.source(), out = [];
    for (const id of st.parts) {
      const local = payloadOf(id, src), rs = isObj(remote.doc.sections[id]) ? remote.doc.sections[id] : null;
      const rem = rs ? cleanRemote(id, rs.data) : null;
      const localEmpty = isEmpty(id, local), remEmpty = !rem || isEmpty(id, rem);
      let action;
      if (remEmpty && localEmpty) action = 'nothing';
      else if (remEmpty) action = 'start';          // this computer fills the folder
      else if (localEmpty) action = 'receive';      // the folder fills this computer
      else if (hash(local) === hash(rem)) action = 'same';
      else action = id === 'settings' ? 'newer' : 'merge';
      out.push({ id, action, by: rs && typeof rs.by === 'string' ? rs.by.slice(0, 40) : null, updatedAt: rs ? rs.updatedAt || null : null });
    }
    return { ok: true, device: st.device, fileExists: remote.exists, parts: out };
  }
  function setDevice(name) { const st = load(); const n = String(name || '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, 40); st.device = n || os.hostname().slice(0, 40); save(); return status(); }
  function setFolder(folder) { const st = load(); if (st.folder !== folder) { st.folder = folder; st.hashes = {}; } save(); return status(); }
  function setEnabled(on) { load().enabled = !!on; save(); return status(); }
  function setParts(list) { const st = load(); st.parts = SECTION_IDS.filter(id => Array.isArray(list) && list.includes(id)); save(); return status(); }
  function reset() { const st = load(); st.hashes = {}; st.lastSummary = null; save(); }
  function disconnect() { const st = load(); st.folder = null; st.enabled = false; st.hashes = {}; st.lastSummary = null; save(); return status(); }

  return { syncNow, status, preview, reset, setDevice, setFolder, setEnabled, setParts, disconnect, _state: load, _hash: hash, SYNC_FILE };
}

// ---- which cloud-drive folder is this? (by its path) ----
function providerOf(folder) {
  const p = String(folder || '');
  if (!p) return null;
  if (/google ?drive|GoogleDrive-|[\\/]My Drive\b|[\\/]Shared drives\b/i.test(p)) return 'Google Drive';
  if (/onedrive/i.test(p)) return 'OneDrive';
  if (/dropbox/i.test(p)) return 'Dropbox';
  if (/iclouddrive|CloudDocs|Mobile Documents/i.test(p)) return 'iCloud Drive';
  return null;
}

module.exports = { createSync, SyncError, SYNC_FILE, payloadOf, cleanRemote, hash, providerOf };
