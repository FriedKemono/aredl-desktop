// ---------------------------------------------------------------------------
// Export / import, between computers and between Windows and Mac.
//
// An export is a JSON document (saved as a file, or squeezed into one line of text that can be pasted anywhere):
//   { "aredl-desktop-settings": 2, "appVersion": "1.1.0", "platform": "win32", "exportedAt": "...",
//     "settings": { ... }, "data": { "favourites": [...], "following": [...], ... } }
// and what goes in is chosen when exporting: the settings, and any of the lists you keep (favourites, followed
// levels, the personal list, cleared notifications). The account / API key is never part of it.
//
// Importing never trusts what it is given. Every setting is checked against a list of the settings this app really
// has (the right kind of value, inside the right range), and every list entry is cleaned and size-limited. Anything
// that doesn't pass is skipped and counted, never applied. Settings that don't exist on this computer (the Windows
// window-button colours on a Mac, say) are skipped with a reason. Only the parts that are really in the file can be
// chosen, and lists can be added to what is already here, or replace it.
// ---------------------------------------------------------------------------
const zlib = require('zlib');

const FORMAT = 2;  // 1 = settings only (still readable); 2 = settings + optional lists
const PREFIX = 'AREDL-SETTINGS:';
const MAX_BYTES = 12 * 1024 * 1024;     // the biggest file / text accepted
const MAX_INFLATED = 24 * 1024 * 1024;  // ...and the most a compressed text may expand to

const TABS = ['list', 'favourites', 'personal', 'followed', 'changelog', 'leaderboard', 'profile', 'submissions', 'notifications', 'settings'];
const MENU_TOKEN = '__menu__';
const TOP_BAR_PLATFORMS = ['win32', 'darwin']; // where the tabs can live in the title bar

// ---- small checkers: each returns the cleaned value, or undefined when the value is not acceptable ----
const bool = (v) => (typeof v === 'boolean' ? v : undefined);
const int = (min, max) => (v) => (Number.isFinite(v) ? Math.min(max, Math.max(min, Math.round(v))) : undefined);
const oneOf = (...list) => (v) => (list.includes(v) ? v : undefined);
const hex6 = (v) => (typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v) ? v.toLowerCase() : undefined);
const hex = (v) => (typeof v === 'string' && /^#[0-9a-f]{6}([0-9a-f]{2})?$/i.test(v) ? v.toLowerCase() : undefined);
const tabList = (allowMenu) => (v) => {
  if (!Array.isArray(v)) return undefined;
  const ok = (t) => TABS.includes(t) || (allowMenu && t === MENU_TOKEN);
  return [...new Set(v.filter(t => typeof t === 'string' && ok(t)))];
};

// key -> { label (shown in reports), check, platforms (omit = everywhere) }
const SPEC = {
  // look
  theme:           { label: 'Theme',                   check: oneOf('default', 'amoled', 'midnight', 'ocean', 'forest', 'violet', 'glass', 'adaptive', 'crimson') },
  accentCustom:    { label: 'Accent colour',           check: (v) => (v === null ? null : hex6(v)) },
  adaptiveTint:    { label: 'Adaptive tint strength',  check: int(0, 100) },
  adaptiveMethod:  { label: 'Adaptive colour method',  check: oneOf('gamma', 'vivid') },
  radius:          { label: 'Corner roundness',        check: int(4, 28) },
  density:         { label: 'Density',                 check: oneOf('comfortable', 'compact') },
  reduceMotion:    { label: 'Reduce motion',           check: bool },
  perf:            { label: 'Performance mode',        check: oneOf('standard', 'lite') },
  // backdrop
  bgStyle:         { label: 'Backdrop style',          check: oneOf('image', 'shader') },
  bgShow:          { label: 'Show backdrop',           check: bool },
  bgDrift:         { label: 'Backdrop drift',          check: bool },
  bgBlur:          { label: 'Backdrop blur',           check: int(0, 140) },
  bgBright:        { label: 'Backdrop brightness',     check: int(5, 100) },
  shaderSpeed:     { label: 'Shader speed',            check: int(0, 400) },
  shaderIntensity: { label: 'Shader intensity',        check: int(10, 200) },
  // behaviour
  startTab:        { label: 'Start-up tab',            check: oneOf('list', 'favourites', 'followed', 'personal', 'changelog', 'leaderboard', 'profile', 'submissions', 'notifications') },
  videoOnLeave:    { label: 'Videos when you leave',   check: oneOf('popup', 'background', 'pause', 'stop') },
  miniPlayer:      { label: 'Corner player size',      check: (v) => (v && typeof v === 'object' && Number.isFinite(v.width) ? { x: null, y: null, width: Math.min(900, Math.max(220, Math.round(v.width))) } : undefined) }, // its position depends on the screen, so only the size travels
  followMins:      { label: 'Followed-level checks',   check: (v) => ([0, 1, 2, 5, 10, 30].includes(v) ? v : undefined) },
  favSort:         { label: 'Favourites sort',         check: oneOf('position', 'list', 'category') },
  plSort:          { label: 'Personal list sort',      check: oneOf('hardest', 'placement', 'date', 'attempts', 'name') },
  plProgressSort:  { label: 'Progress sort',           check: oneOf('run', 'furthest', 'placement', 'tier', 'attempts', 'recent', 'name') },
  dateDp:          { label: 'Date precision',          check: int(0, 2) },
  showRaw:         { label: 'Raw API responses',       check: bool },
  toolsExpanded:   { label: 'Level buttons unfolded',  check: bool },
  // the top bar
  navTop:          { label: 'Tabs in the top bar',     check: bool,                     platforms: TOP_BAR_PLATFORMS, why: 'the top bar is only available on Windows and Mac' },
  navMenu:         { label: 'Top bar menu button',     check: bool,                     platforms: TOP_BAR_PLATFORMS, why: 'the top bar is only available on Windows and Mac' },
  navCompact:      { label: 'Compact top bar tabs',    check: oneOf('off', 'always', 'fullscreen'), platforms: TOP_BAR_PLATFORMS, why: 'the top bar is only available on Windows and Mac' },
  navLayout:       { label: 'Top bar tab layout',      platforms: TOP_BAR_PLATFORMS, why: 'the top bar is only available on Windows and Mac',
                     check: (v) => (v && typeof v === 'object' && !Array.isArray(v) ? { left: tabList(true)(v.left) || [], right: tabList(true)(v.right) || [], menu: tabList(false)(v.menu) || [] } : undefined) },
  // Windows only
  overlay:         { label: 'Window button colours',   platforms: ['win32'], why: 'only Windows has these window buttons',
                     check: (v) => { const color = hex(v && v.color), symbolColor = hex6(v && v.symbolColor); return color && symbolColor ? { color, symbolColor } : undefined; } },
};
// (The few settings that are only bookkeeping - "have I shown this tip" - are deliberately not in the list.)

const KEYS = Object.keys(SPEC);
const label = (k) => (SPEC[k] ? SPEC[k].label : k);

// ---------------------------------------------------------------------------
// The parts of an export, what each one is made of, and how its entries are cleaned
// ---------------------------------------------------------------------------
const SECTIONS = [
  { id: 'settings',      label: 'Settings',              noun: ['setting', 'settings'],       about: 'theme, backdrop, top bar, videos and so on' },
  { id: 'favourites',    label: 'Favourites',            noun: ['level', 'levels'],           about: 'your favourited levels' },
  { id: 'following',     label: 'Followed levels',       noun: ['level', 'levels'],           about: 'the levels you follow, and the update notices they produced' },
  { id: 'personal',      label: 'Personal list',         noun: ['entry', 'entries'],          about: 'your own list of completed levels and runs' },
  { id: 'notifications', label: 'Cleared notifications', noun: ['notification', 'notifications'], about: 'which notifications you have already cleared' },
];
const SECTION_IDS = SECTIONS.map(x => x.id);
const LIST_SECTIONS = SECTION_IDS.filter(id => id !== 'settings');

// anything JSON-shaped, kept but made safe: plain values only, bounded depth / width / length, no sneaky keys
const BAD_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
function cleanJson(v, depth = 0) {
  if (v === null || typeof v === 'boolean') return v;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string') return v.slice(0, 2000);
  if (depth >= 4) return null;
  if (Array.isArray(v)) return v.slice(0, 300).map(x => cleanJson(x, depth + 1));
  if (v && typeof v === 'object') {
    const out = {};
    for (const k of Object.keys(v).slice(0, 60)) { if (!BAD_KEYS.has(k) && k.length <= 60) out[k] = cleanJson(v[k], depth + 1); }
    return out;
  }
  return null;
}
const str = (v, max) => (typeof v === 'string' ? v.slice(0, max) : v == null ? '' : String(v).slice(0, max));
const idOk = (v) => (typeof v === 'number' && Number.isFinite(v)) || (typeof v === 'string' && v.length > 0 && v.length <= 40);
const modeOf = (v) => (v === 'platformer' ? 'platformer' : 'classic');
const isoOr = (v, fallback) => (typeof v === 'string' && !Number.isNaN(Date.parse(v)) ? v.slice(0, 40) : fallback);
const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
const boolMap = (v) => { const o = {}; if (isObj(v)) for (const k of Object.keys(v).slice(0, 20)) if (!BAD_KEYS.has(k) && typeof v[k] === 'boolean') o[k] = v[k]; return o; };

// each cleaner returns one tidy entry, or null when the entry can't be used
const CLEAN = {
  favourites: (f) => (isObj(f) && idOk(f.level_id) ? { level_id: f.level_id, name: str(f.name, 200), label: str(f.label || 'favourited', 24) } : null),
  following: (f) => (isObj(f) && idOk(f.level_id)
    ? { ...cleanJson(f), level_id: f.level_id, name: str(f.name, 200), mode: modeOf(f.mode), notify: boolMap(f.notify), lastSeenAt: isoOr(f.lastSeenAt, new Date().toISOString()), lastChange: isoOr(f.lastChange, null) }
    : null),
  followNotifications: (n) => (isObj(n) && typeof n.id === 'string' && n.id && n.id.length <= 200 && idOk(n.level_id)
    ? { id: n.id, level_id: n.level_id, mode: modeOf(n.mode), level_name: str(n.level_name, 200), category: str(n.category, 40), text: str(n.text, 600), at: isoOr(n.at, new Date().toISOString()) }
    : null),
  personal: (e) => {
    if (!isObj(e) || typeof e.id !== 'string' || !e.id || e.id.length > 100) return null;
    if (e.level_id != null && !idOk(e.level_id)) return null;
    if (e.percent != null && !(Number.isFinite(e.percent) && e.percent >= 0 && e.percent <= 100)) return null;
    return { ...cleanJson(e), id: e.id, mode: modeOf(e.mode), level_id: e.level_id == null ? null : e.level_id };
  },
  notifications: (id) => (typeof id === 'string' && id && id.length <= 200 ? id : (typeof id === 'number' && Number.isFinite(id) ? String(id) : null)),
};
const KEY = {
  favourites: (f) => String(f.level_id),
  following: (f) => `${f.mode}:${f.level_id}`,
  followNotifications: (n) => n.id,
  personal: (e) => e.id,
  notifications: (id) => id,
};
const CAPS = { favourites: 5000, following: 2000, followNotifications: 300, personal: 5000, notifications: 2000 };

// cleans a whole list: { items, dropped }
function cleanList(kind, raw) {
  if (!Array.isArray(raw)) return { items: [], dropped: 0 };
  const seen = new Set(), items = [];
  let dropped = 0;
  for (const r of raw.slice(0, CAPS[kind] * 2)) {
    const c = CLEAN[kind](r);
    if (c == null) { dropped++; continue; }
    const k = KEY[kind](c);
    if (seen.has(k)) continue;
    seen.add(k);
    if (items.length < CAPS[kind]) items.push(c); else dropped++;
  }
  return { items, dropped };
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------
// what you have here, for the "what to include" list: how many of each (0 = nothing to export yet)
function countSources(src) {
  let settingCount = 0;
  for (const k of KEYS) if (src.settings && k in src.settings && SPEC[k].check(src.settings[k]) !== undefined) settingCount++;
  const n = (kind, list) => cleanList(kind, list).items.length;
  return {
    settings: settingCount, favourites: n('favourites', src.favourites), following: n('following', src.following),
    followNotices: n('followNotifications', src.followNotifications), personal: n('personal', src.personal), notifications: n('notifications', src.clearedNotifications),
  };
}

// src: { settings, favourites, following, followNotifications, personal, clearedNotifications }; sections: which parts to include
function buildExport(src, { platform, appVersion, sections = SECTION_IDS }) {
  const want = new Set(sections);
  const doc = { 'aredl-desktop-settings': FORMAT, appVersion, platform, exportedAt: new Date().toISOString(), settings: {}, data: {} };
  if (want.has('settings')) {
    for (const k of KEYS) {
      if (!src.settings || !(k in src.settings)) continue;
      const v = SPEC[k].check(src.settings[k]);
      if (v !== undefined) doc.settings[k] = v;
    }
  }
  if (want.has('favourites')) doc.data.favourites = cleanList('favourites', src.favourites).items;
  if (want.has('following')) {
    doc.data.following = cleanList('following', src.following).items;
    doc.data.followNotifications = cleanList('followNotifications', src.followNotifications).items;
  }
  if (want.has('personal')) doc.data.personal = cleanList('personal', src.personal).items;
  if (want.has('notifications')) doc.data.notifications = cleanList('notifications', src.clearedNotifications).items;
  doc.sections = SECTION_IDS.filter(id => want.has(id));
  return doc;
}
const toJson = (doc) => JSON.stringify(doc, null, 2);
// one line of text: squeezed, then written in letters and digits only, so it survives being pasted into a chat
const toText = (doc) => PREFIX + zlib.deflateSync(Buffer.from(JSON.stringify(doc))).toString('base64url');

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------
class TransferError extends Error {}

// accepts the file's JSON, or the one-line text (with or without the prefix, with stray spaces / line breaks / quotes)
function parseTransfer(input) {
  if (typeof input !== 'string') throw new TransferError('Nothing to import.');
  if (Buffer.byteLength(input) > MAX_BYTES) throw new TransferError('That is far too big to be an export from this app.');
  let text = input.replace(/^\uFEFF/, '').trim();
  if (!text) throw new TransferError('Nothing to import.');
  let json;
  if (text.startsWith('{')) {
    json = text;
  } else {
    text = text.replace(/^["'`]+|["'`]+$/g, '').replace(/\s+/g, '');
    if (text.startsWith(PREFIX)) text = text.slice(PREFIX.length);
    try {
      json = zlib.inflateSync(Buffer.from(text, 'base64url'), { maxOutputLength: MAX_INFLATED }).toString('utf8');
    } catch {
      throw new TransferError("That doesn't look like an AREDL Desktop export. Paste the text exactly as it was copied, or choose an export file.");
    }
  }
  let doc;
  try { doc = JSON.parse(json); } catch { throw new TransferError('That export is damaged (it could not be read).'); }
  if (!isObj(doc) || !('aredl-desktop-settings' in doc) || (doc.settings != null && !isObj(doc.settings)) || (doc.data != null && !isObj(doc.data))) {
    throw new TransferError("That isn't an AREDL Desktop export.");
  }
  return doc;
}

// Works out what is in the file and what this computer can use of it. Nothing is applied here.
// plan.sections[id] = { available, count, ... } for every part that has something in it.
function planImport(doc, { platform }) {
  const data = isObj(doc.data) ? doc.data : {};
  const sections = {};
  let unknown = 0;

  // settings
  const apply = {}, skipped = [];
  for (const [k, raw] of Object.entries(isObj(doc.settings) ? doc.settings : {})) {
    const spec = Object.prototype.hasOwnProperty.call(SPEC, k) ? SPEC[k] : null;
    if (!spec) { unknown++; continue; }  // not a setting this version knows (a newer or older app's)
    if (spec.platforms && !spec.platforms.includes(platform)) { skipped.push({ key: k, label: spec.label, reason: spec.why || `not available on ${platform}` }); continue; }
    const v = spec.check(raw);
    if (v === undefined) { skipped.push({ key: k, label: spec.label, reason: "the saved value isn't one this version understands" }); continue; }
    apply[k] = v;
  }
  const settingCount = Object.keys(apply).length;
  if (settingCount || skipped.length) sections.settings = { available: settingCount > 0, count: settingCount, apply, skipped, unknown };

  // lists
  const fav = cleanList('favourites', data.favourites);
  if (fav.items.length) sections.favourites = { available: true, count: fav.items.length, dropped: fav.dropped, items: fav.items };
  const fol = cleanList('following', data.following), folN = cleanList('followNotifications', data.followNotifications);
  if (fol.items.length || folN.items.length) sections.following = { available: true, count: fol.items.length, notices: folN.items.length, dropped: fol.dropped + folN.dropped, items: fol.items, noticeItems: folN.items };
  const per = cleanList('personal', data.personal);
  if (per.items.length) sections.personal = { available: true, count: per.items.length, dropped: per.dropped, items: per.items };
  const not = cleanList('notifications', data.notifications);
  if (not.items.length) sections.notifications = { available: true, count: not.items.length, dropped: not.dropped, items: not.items };

  const names = { darwin: 'Mac', win32: 'Windows', linux: 'Linux' };
  return {
    sections,
    fromPlatform: typeof doc.platform === 'string' ? (names[doc.platform] || doc.platform.slice(0, 12)) : null,
    fromVersion: typeof doc.appVersion === 'string' ? doc.appVersion.slice(0, 20) : null,
    exportedAt: isoOr(doc.exportedAt, null),
    newerFormat: Number(doc['aredl-desktop-settings']) > FORMAT,
  };
}

// what the import window shows: only the parts that have something in them can be picked
function describePlan(plan) {
  return {
    fromPlatform: plan.fromPlatform, fromVersion: plan.fromVersion, exportedAt: plan.exportedAt, newerFormat: plan.newerFormat,
    sections: SECTIONS.filter(sec => plan.sections[sec.id]).map(sec => {
      const p = plan.sections[sec.id];
      return {
        id: sec.id, label: sec.label, available: p.available, count: p.count, noun: sec.noun, about: sec.about,
        notices: p.notices || 0, dropped: p.dropped || 0,
        skipped: (p.skipped || []).map(x => ({ label: x.label, reason: x.reason })), unknown: p.unknown || 0,
      };
    }),
  };
}

// ---- adding to / replacing what is here ----
// mode 'merge': keep everything already here and add what is new (an entry that is already here is left as it is)
// mode 'replace': use the imported list instead
function combine(kind, localRaw, incoming, mode) {
  const local = cleanList(kind, localRaw).items;
  if (mode === 'replace') return { list: incoming.slice(0, CAPS[kind]), added: incoming.length, kept: 0 };
  const have = new Set(local.map(KEY[kind]));
  const added = incoming.filter(x => !have.has(KEY[kind](x)));
  let list = [...local, ...added];
  if (kind === 'followNotifications') list.sort((a, b) => String(b.at).localeCompare(String(a.at)));  // newest first, like the app keeps them
  if (kind === 'notifications') list = list.slice(-CAPS.notifications);
  else list = list.slice(0, CAPS[kind]);
  return { list, added: added.length, kept: incoming.length - added.length };
}

module.exports = { SPEC, KEYS, SECTIONS, SECTION_IDS, LIST_SECTIONS, FORMAT, PREFIX, TransferError, countSources, buildExport, toJson, toText, parseTransfer, planImport, describePlan, combine, cleanList, cleanJson, label };
