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
- **Window and page change together:** the player window and its page are different processes, so a new window size and a message to the page never arrive at the same instant. Any message that goes with a change of the window's size (`mini:place`, `mini:glide`) carries the size the window is about to get (`ww`, `wh`) and is sent **before** `setBounds`; `mini.js` applies it in the frame the window has that size (`whenSized`). Do not call `setBounds` first and message afterwards: the video then shows at the wrong place for a frame. A docked video that only moves is not messaged at all.
- **Geometry in whole pixels:** `pDockedGeometry` rounds from the video's own corner once. Keep the window and the offset of the video inside it derived from the same integers.
- **Scrolling never hides the video:** while the page scrolls, the player stays visible and follows. Do not add a hide/fade-while-scrolling step to cover lag.
- **Window swaps are masked until drawn:** moving or resizing the window shows the old layout in the new window for a frame or two. Around the start and end of a glide the window is see-through (`pSwapBegin`) and shown again when the page sends `mini:placed` (`pSwapEnd`). Messages that need this carry `ack: true`. Use it for glides and mode changes only, never while scrolling.
- **Window only with the setting:** a separate player window (docked over the page, popping out, gliding, the masked swap) exists only while `videoOnLeave` is `popup` (“Move it to a corner player”). With any other choice a `VideoDock` has `host === 'page'`: an iframe inside the page (the `#dockTemplate` element, fixed at z-index 950, placed by `pagePlace`), so menus and other page elements are drawn above it. The host is chosen when the player is made (`dockHostKind()`); `retargetDocks()` swaps players when the setting changes. Any new route into the corner must check the setting, in the page (`VideoDock.toCorner`) and in `main.js` (`cornerOn()`).
- **Full screen:** a player window can't be a system full-screen window (see-through, frameless, owned by the app, `fullscreenable: false`). On `enter-html-full-screen` it is made as big as its screen and put on top (`pFullscreen`); placement messages are ignored while `P.fs` is set. A player in the page uses the browser's own full screen; `layout()` leaves it alone then.
- **Miniplayer from a record:** `miniPlay()` makes a standalone `VideoDock` (`standalone = true`, always `host = 'window'`, mode `corner`, no slot): `layout()` and `retargetDocks()` skip it, `dockPlay()` never reuses it, and it is sent to the corner with `force: true` so the “Move it to a corner player” setting doesn't block it (the person asked for it). A Medal clip loads with `kind: 'medal'` (main builds `https://medal.tv/clip/ID[/HASH]` from validated parts) and a Twitch video or clip with `kind: 'twitch'` (`player.twitch.tv/?video=vID` or `clips.twitch.tv/embed?clip=SLUG`, with `parent=127.0.0.1`, the address the player windows are served from, which Twitch accepts for local pages). Neither reports anything back, so they have no playing state. A record's button is the site's own mark in white (`RECORD_ICONS`); a new site needs its icon, a parser (`…Parts`), a branch in `recordVideo()` and one in `player:load`.
- **Personal list difficulty:** an entry's difficulty is `plResolve(e).difficulty`, never `e.difficulty` directly. With Auto on (`e.auto.difficulty`, the default; an old entry that already has a difficulty counts as off) it is `plAutoDifficulty(tier, topNumber)` from the Demon difficulty list; otherwise it is the stored dropdown value. The form's `plSyncDifficulty()` follows the tier and placement boxes as shown.
- **Difficulty:** `DEMON_DIFFS` is the one table of Demon difficulties (tiers and colours); `demonDiffFor(tier, position, mode)` picks a level's. In the level info it is plain text plus an eye button (`.diff-eye`, `diffCellHtml`); only the eye is clickable and opens `openDiffModal`, a window in the style of the pack view (`pack-view-top` strip + `pack-level-list` of `.diff-row` rows). The rows are information only: no hover change, no click.
- **Level info grid:** the single-level and multi-select panels share the `level-facts` block, which is always two rows (`.fact-row`) of the same height (`grid-auto-rows:1fr`): Level ID, List Points and Edel Enjoyment on top; Song, NLW Tier, GDDL Tier and Difficulty below. Every box in a row has the same width (halves, thirds, quarters); Song is always in the bottom row. A box with no value is left out (single: `factHtml` skips it, `factRowHtml` drops an empty row; multi-select: `showFact` hides it for the viewed level) and the rest of its row share the width. The song name goes on its own line under the ID, clamped to one line (`.song-line`), so a long name never makes the box tall. `fitLevelFacts()` (run by a MutationObserver/ResizeObserver on `#detailInner`) grows each box’s value up to 30px while it fits on one line and the rows do not get taller, so short values fill their box and long ones keep the normal size.
- **Custom copies:** one request per level, `GET levels/{level id}/custom-copies` (`loadCustomCopies`, cached in `ccCache` by mode and level id). Entry fields: `id`, `level_id`, `copy_id` (in-game id), `added_by`, `id_type` (`Bugfix`/`GlobedCopy`/`Ldm`/`Other`), `status` (`Published`/`Allowed`/`Banned`), `description`, `created_at`; `ccNormalize` reads them directly. `levelIdHtmlFor(level, multi)` leaves a `.cc-slot` under the ID, filled by `ccFillSlots()`. The single-level panel loads on its own (`ccRefresh(level, false)`); multi-select (`data-cc-multi`) shows a “Load custom copies” button and loads only on click (`ccRefresh(level, true)` just redraws from the cache).
- **Find video:** the "Find video" button of a video error (`showError`) asks the main process (`yt:search`, logged through `miscFetch`) for the first video results of YouTube's search page for `NAME gd`, and `findVideoFor` tries up to ten of them in the miniplayer, moving on when one reports an error.
- **Video bar:** `videoStageHtml` puts `#videoBar` in the gap above the video (single and multi-select). It is positioned out of the flow (`position:absolute` in `.video-stage`), so it never changes the title, the gap above the video or the video’s place. It sits at the right edge, level with the video’s top; `placeVideoBar()` moves it above the video (compact, `.above`) when the panel is too narrow for that: **Find Video** (`[data-find-video]`, runs `findVideoFor` for `barLevel()`, same search as the error message's button) and **Popout** (`[data-popout]`, `popOutNow`). `updateVideoBar` (every 400 ms) switches Find Video off while a found video (`d.found`) plays and Popout on while `popTarget()` exists. `VideoDock.popOut()` sends the video to the corner for good (`manual`, no automatic dock-back); `keepPlaying()` (the miniplayer's minus button, IPC `mini:hide-keep` → `player:hide`) hides the window while the video plays (`userHidden`). A standalone player (`miniPlay`: records, found videos) takes `returnTo`; its “Back to the level” calls it and never docks the video. Closing the app window (`close` in main.js) calls `pDestroyAll()` and sends `win:closed`, which destroys every dock; nothing is re-created until `win:back`.
- **Overlays above a window player:** nothing should be marked `keeps-video` (it dims the player window over the overlay). A covering overlay hides the player window; it keeps playing.
- **Request log places:** `LOG_PLACES` (app.js) maps a request's host to a place and holds the limit its service publishes (`limit`) or `Not published`. The setting `logByPlace` (in the sync spec) splits the figures per place; `#rateLimits` lists every place with its limit and the current rate. `rateInfo(res)` in main.js adds `rlLimit`, `rlRemaining` and `retryAfter` to a log entry when the response has them. `describeRequest` / `describeMisc` name the level for level, song and picture lines (`levelNameFromRef`, `levelNamesForSong`). A `429` answer is learned by `learnRateLimit`: the number of that place’s requests that went through in its period (a minute, or the place’s published period) is saved in the `rateLimitHits` setting (in the sync spec), replaces the published or “Not published” text in orange (`.rl-limit.found`, with a key). A place with no published, found or server-reported limit shows `>` the most requests that went through in a minute (`peakPerMinute`), or a dash when there are none, also in orange. There are no meter bars and is changed only by a later 429 with another number or by the “Clear found limits” button. The rate limit rows use `minmax(0, …)` columns and wrap, so the block never scrolls sideways.
- **Advanced settings:** the Developer card, the Request log card and the two log lists carry `.adv-only` and the `hidden` attribute; `applyAdvancedVisibility()` shows them when the `showAdvanced` setting is on (default off). A command-palette result for one of them turns the setting on before scrolling to it. New developer-only settings get `.adv-only` too.
- **Idle screen offer:** after the idle screen the offer has **View** and **View last 10** (`openLastShown` in features.js): the last 10 levels put on screen (`shown`, newest first, each once) in a window styled like the pack view (`pack-level-list`, `attachLevelPictures` from packs.js, `data-jump` rows).
