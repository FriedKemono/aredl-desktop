# Project

## Layout

```
main.js              Electron main process: windows, tray, IPC handlers, API calls, local file server, song lookups, floating player
preload.js           the only bridge the page has: window.aredl.* (contextIsolation on)
mini-preload.js      the same for the floating player window: window.aredlMini.*
settings-transfer.js what can be exported/imported and synced: SPEC (settings), SECTIONS (lists), cleaning, combining
sync.js              Google Drive sync engine (what changed, merge rules, backups, preview)
drive.js             Google Drive access (sign-in, folder, upload/download)
drive-config.js      built-in Google client; drive-config.local.js holds the secret (never commit real secrets elsewhere)
mac-updater.js       update checks on Mac
renderer/
  index.html         all markup (tabs, settings, templates)
  styles.css         all styles (one file)
  app.js             the app: state, tabs, list, level panel, profile, records, settings wiring
  features.js        extras: modals (fx.openModal), command palette, pick a level, filters, lists, sync UI, refresh popup
  packs.js           Packs tab, pack view, packs of a level
  tour.js            the guided tour
  whatsnew.js        the "What's new" window
  releases.js        changelog (APP_RELEASES)
  mini.html/.js      the floating player window
scripts/             dist.js, ship.js, publish-release.js, release-notes.js, adhoc-sign.js
```

Renderer scripts are plain scripts (not modules) loaded in this order: `countries.js, releases.js, app.js, features.js, packs.js, tour.js, whatsnew.js`. Top-level `const`/`let`/`function` in one are visible to the later ones. Code that runs at load time may only use things defined earlier.

## Two processes

- **Main** owns anything that touches the disk, the network (except images), the OS, windows and secrets.
- **Renderer** owns the UI. It never reads files or calls APIs itself. It calls `window.aredl.something()`.

Adding a call: handler in `main.js` (`ipcMain.handle('area:name', …)`), a wrapper in `preload.js`, use it in the renderer. Validate every argument in the handler (type, range, length). Events from main to the page use `webContents.send` and `ipcRenderer.on` wrappers in `preload.js`.

The page is served from a local server (`http://127.0.0.1:<port>`), not `file://`. That keeps embeds working and lets canvases read same-origin pictures (the custom backdrop is served at `/_bg/current`).

## Scripts and versions

- `npm install`, `npm run dist` builds the installers.
- `npm run ship` bumps nothing by itself: it expects the version in `package.json` to be new and a changelog entry for it in `renderer/releases.js`, then builds and publishes.
- **Pushing an update:** bump `version` in `package.json` **and** add the entry at the top of `renderer/releases.js`. `scripts/release-notes.js` turns that entry into the release notes.
- Package files delivered for review are named `aredl-desktop-VERSION.zip` (version with dots, no suffix).
- `package.json → build.files` is a whitelist. A new file the app needs at run time **must be added there** (renderer files are covered by `renderer/**/*`).

## Changelog format (`renderer/releases.js`)

```js
{
  version: '1.1.3',
  date: '21-11-2026',            // DD-MM-YYYY
  title: 'Short headline for the release',
  items: [
    ['new' | 'improved' | 'fixed', 'One or two factual sentences.', 'Very short title'],
  ],
}
```

Every item has a very short title (1–4 words). The title shows in bold before the text in "What's new" and in the release notes.
