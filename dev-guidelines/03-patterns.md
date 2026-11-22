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

Static actions are in `paletteActions()`, searchable content in `deepSearch()` (`add(kind, label, text, run, base, key, ctx)`). Content that comes from a page's data must also be loaded by `prepareSearch()` in `features.js` (quietly, once, a few seconds after start-up and when the palette opens), so it can be found without opening that page first. Results are shown twelve at a time; the rest appears as the person goes down the list. `label` is the short name ("Packs"), `ctx` says what happens and where ("Opens the Packs tab"). Every place the app can send you gets an entry that reads as an action.

## A tour step

Add to `STEPS` in `tour.js`. Fields: `id`, `tab`, `target` (selector, function, or array), `side`, `title`, `body` (string or function), `before`/`after` (open/close what the step shows), `needsLevels`. A step that shows a popup (palette, context menu) opens it in `before` and closes it in `after`. Keep targets resilient: fall back to a larger element if the small one is hidden.

## A request

- Renderer → main → network. Log every request that is not to `api.aredl.net` through `miscFetch(url, options, what)` (shown under Settings → Other requests). Images the page loads itself report through `logPic(url, ok)`.
- Cache on the renderer side (Map with a timestamp) and derive from data already loaded before asking again.
- Never start a request from rendering code that runs on every keystroke or scroll.

## Pictures

`picKey(levelId, vid)` → key (`'a:<id>'`, a YouTube id, or `'custom'`); `picUrl(key, kind)` → URL (`kind` `'full'` or `'cards'`); `withPic(key, ok, fail)` loads it for canvas sampling; `bannerPicCss(...)` gives a banner background. Always fall back to YouTube when AREDL has no picture (`aredlMissing`).

## The corner player

The corner player is **always its own window** (`main.js` `openMiniWindow`, page `renderer/mini.html` + `mini.js`), never an element of the app's page, so it never changes from one kind of player into another. It reuses the old markup and `styles.css` (`.video-dock.mini`), so styling changes there apply to it. It is a transparent window with `MINI_PAD` (48 px) around the player for the corner grips and the shadow (the shadow in `mini.html` is sized to fit inside that room).

- **In the app:** `VideoDock` (`app.js`) has modes `inline`, `off` and `float`. In `float` the dock is hidden and blank; its slot shows “Playing in the corner player”. `floatCtx` is the video that is in (or on its way to) the window.
- **Hand-over without a gap:** `floatOut()` opens the window (`mini:open`) while the app's player keeps playing; the window loads the video muted, says `mini:primed` once it plays, the app answers `mini:go {time, playing}` and stops its own player; the window seeks and unmutes. `restore()` / `finishBack()` do the same in the other direction (the app loads muted, unmutes and calls `mini:close`).
- **Coming back:** `requestBack()` asks the window (`mini:requestReturn`, quiet = do not open the page); the window answers with `mini:return`; the app gets `mini:returned`. “Back to the level” is the same without `quiet`, and also calls the level's `onReturn`.
- **Moving and resizing** are done in `main.js` (`mini:gesture`, `mini:gestureEnd`): the page only says when the pointer went down and up; in between the main process reads the cursor every 8 ms and sets the window's bounds (always with the full size, so a screen with a different scale cannot change it). On release the player is kept on a screen and snaps to an edge within 26 px. Position (`sx`, `sy`) and width are saved in the `miniPlayer` setting; only the width is exported or synced.
