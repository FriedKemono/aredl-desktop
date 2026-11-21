# Patterns: how to add things

## A tab

1. `index.html`: a `<button class="nav-btn" data-tab="NAME">` (icon svg + label) in the nav, and `<section class="tab" id="tab-NAME">`.
2. `app.js`: if it has its own Classic/Platformer choice, add the name to `tabModes` and call `addModeSelect('NAME', reload)`. Load data in `showTab` (`if (name === 'NAME') …`) **only when the tab is first needed**.
3. `settings-transfer.js`: add the name to `TABS` and the "Open on" `startTab` list in Settings.
4. The nav order is read from the buttons in the page, and a tab missing from a saved layout is placed automatically — no list to update.
5. Add it to the tour (`tour.js`), and to the changelog.

## A setting

1. Markup: a `.setting-line` in the right card (`index.html`).
2. Wiring in `app.js`/`features.js`: read `appSettings.key`, write with `setSetting('key', value)`, apply on start in `initSettings()` and after a change.
3. Portable settings (should follow the person to another computer) go in `SPEC` in `settings-transfer.js` with a `label` and a `check` (`bool`, `oneOf(...)`, `int(min,max)`). Settings that only make sense on one computer (sync timing, custom backdrop file, `thumbRev`) stay **out** of `SPEC`.
4. `main.js` `settings:set` accepts any key; nothing to register there.

## A list the person keeps (favourites, lists, overwrites …)

Needs a store file and a transfer section: `STORE_NAMES` + `TRANSFER_FILES` + `FILES_OF` + `gatherTransferSources` in `main.js`; `SECTIONS`, `CLEAN`, `KEY`, `CAPS`, `countSources`, `buildExport`, `planImport` in `settings-transfer.js`; `payloadOf`, `cleanRemote`, default `parts` in `sync.js`; the renderer loads it with `getStore(name)` and saves with `setStore(name, list)`. The `demonlist` section (picture overwrites) is the smallest complete example.

## A button in the level panel

Add it to `levelToolsHtml()`; it then appears next to the name in the panel, the multi-select caption, and cards. Use a `data-…` attribute and one delegated click handler (`document.addEventListener('click', …)`). Give it a `data-tip`.

## A level context-menu entry

Add an item to `levelMenuItems()` in `app.js`. Group related items with `{ separator: true }`.

## A modal

```js
const m = fx.openModal({ title: 'Title', wide: true });
m.body.appendChild(el('p', 'dim', 'text'));
```

## A raw-response box

`${rawDetails('Full API response', data)}` in the view's HTML, once per load (not on every keystroke).

## A command-palette entry

Static actions are in `paletteActions()`, searchable content in `deepSearch()` (`add(kind, label, text, run, base, key, ctx)`). `label` is the short name ("Packs"), `ctx` says what happens and where ("Opens the Packs tab"). Every place the app can send you gets an entry that reads as an action.

## A tour step

Add to `STEPS` in `tour.js`. Fields: `id`, `tab`, `target` (selector, function, or array), `side`, `title`, `body` (string or function), `before`/`after` (open/close what the step shows), `needsLevels`. A step that shows a popup (palette, context menu) opens it in `before` and closes it in `after`. Keep targets resilient: fall back to a larger element if the small one is hidden.

## A request

- Renderer → main → network. Log every request that is not to `api.aredl.net` through `miscFetch(url, options, what)` (shown under Settings → Other requests). Images the page loads itself report through `logPic(url, ok)`.
- Cache on the renderer side (Map with a timestamp) and derive from data already loaded before asking again.
- Never start a request from rendering code that runs on every keystroke or scroll.

## Pictures

`picKey(levelId, vid)` → key (`'a:<id>'`, a YouTube id, or `'custom'`); `picUrl(key, kind)` → URL (`kind` `'full'` or `'cards'`); `withPic(key, ok, fail)` loads it for canvas sampling; `bannerPicCss(...)` gives a banner background. Always fall back to YouTube when AREDL has no picture (`aredlMissing`).

## The floating player

`VideoDock.popOut()` opens it (`main.js` `openMiniWindow`). `renderer/mini.html` reuses the corner player's markup and `styles.css`, so styling changes in `.video-dock.mini` apply to both. It is a transparent window with `MINI_PAD` around the player for the corner grips and shadow; moving and resizing are done by IPC (`mini:move`, `mini:resize`).
