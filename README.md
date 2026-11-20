# AREDL Desktop (unofficial)

A small Electron desktop app for the All Rated Extreme Demons List: browse the
list, sign in with your API key to see which levels you've completed, get a
native desktop notification when AREDL sends you one, view profiles, and a
color-coded changelog.

Not affiliated with aredl.net or RobTop Games.

## Why this is source code, not a ready-made .exe

I built and tested this in a sandboxed Linux environment with no Windows
machine to actually run/verify a `.exe` on, and cross-compiling a working
Windows executable from Linux without Wine is fragile. `electron-builder`
(used below) is the standard, well-tested tool for producing a real Windows
`.exe` — it just needs to run on a Windows machine, or on a Windows CI runner.
Both options below get you a real, working `.exe` in a couple of minutes.

## Option A — build it yourself (fastest, ~2 minutes)

1. Install [Node.js LTS](https://nodejs.org) if you don't have it.
2. Open a terminal in this folder.
3. `npm install`
4. Try it first without building: `npm start`
5. Build the real portable `.exe`: `npm run dist`
   → `dist/AREDL-Desktop-portable.exe`. Double-click it — no installer, no
   admin rights needed.

## Option B — build via GitHub Actions (no local Node install needed)

1. Push this folder to a new GitHub repo.
2. The included `.github/workflows/build.yml` builds the `.exe` on a real
   Windows runner automatically on every push.
3. Grab the finished `.exe` from the workflow run's **Artifacts** section.

## Signing in / API key

Settings → paste your AREDL API key → Sign in. The key is verified against
`/v2/api/users/@me` and then stored encrypted via your OS's credential store
(Electron's `safeStorage` — Windows: DPAPI, macOS: Keychain, Linux: Secret
Service). It's never sent anywhere except `api.aredl.net`.

## About the API endpoints — please read

Only two endpoints were independently verified while building this:

- `GET /v2/api/aredl/levels/` — **confirmed**, this is the whole list.
- `GET /v2/api/users/@me/notifications` — **confirmed to exist** (returns 401
  without a valid key, which is expected).

The following were **inferred by pattern**, not verified, because AREDL
doesn't currently publish a full public schema at `/v2/docs` that I could
read from here:

- `GET /v2/api/users/@me` — used for sign-in verification, your profile, and
  finding your completed levels.
- `GET /v2/api/aredl/profile/{id}` — used for the "look up a publisher"
  feature (you gave `arepl/profile/`, which 404'd — I've assumed that was a
  typo for `aredl/profile/`).
- `GET /v2/api/aredl/changelog/` — used for the Changelog tab.

If any of these are wrong, everything else in the app still works — just
open `main.js`, find the `ENDPOINTS` object near the top, and fix the one
path. The UI surfaces the raw HTTP error and, for profile/changelog, a direct
link to `https://api.aredl.net/v2/docs` so you can look up the correct path.

The "completed levels" feature also guesses which field on your profile
response is the list of completed levels (it looks for the first array of
objects containing a `level_id`-like key). If that guess is wrong, the
Profile tab still shows the full raw JSON response so you can see the real
field name and adjust `extractCompletedIds()` in `renderer/app.js`.

## Changelog colors

Per your spec — background colors keyed by `action`:

| Action    | Color            |
|-----------|------------------|
| Placed    | Blue *(not specified in your message — I picked this since "Placed" wasn't given a color but is one of the real action types)* |
| Raised    | Green            |
| Lowered   | Light red        |
| Swapped   | Orange           |
| Pending   | Yellow           |
| Removed   | Dark red *(you described this color, but it wasn't in your action-type list — included anyway in case the API returns it)* |

Edit `ACTION_COLORS` in `renderer/app.js` to change any of these.

## Project structure

```
main.js            Electron main process: window, tray, API calls, auth storage, notification polling
preload.js          Safe bridge exposing window.aredl.* to the renderer
renderer/            The UI (plain HTML/CSS/JS, no framework)
build/icon.ico       App icon (original abstract mark, not AREDL's logo)
```


## Top bar tips

Settings → Navigation (Windows): put the tabs in the top bar, then optionally turn on
**Use a menu button**. Press **Reorder tabs** and drag any tab into the menu (the "..." button)
to tuck it away; drag it back out to the bar whenever you like.

## Personal list: runs

The Progress box in the add/edit window takes a percentage (`79`) or a run (`53-79`).
A plain `100` is a completion. Anything under 100, or with a start (like `20-100`), goes in the **Runs** list,
which has its own sort menu (run size by default, so 50-90 counts as a 40% run).

## Taskbar name and icon (Windows)

The app tells Windows its own name ("AREDL Desktop") and icon for the taskbar, its right-click menu and
pinning, so it no longer shows up as "Electron". If you pinned it before this fix, **unpin the old one**
(right-click → Unpin) and pin it again while the new version is running, because the old pin remembers Electron.

## Automatic updates

The **Setup** installer (`AREDL-Desktop-Setup.exe`) updates itself. The portable `.exe` cannot, so send people the Setup one.

One-time setup:
1. Put the project in a **public** GitHub repository.
2. In `package.json`, under `build.publish`, replace `YOUR_GITHUB_USERNAME` and `YOUR_REPO_NAME`.
3. Everyone installs the Setup `.exe` once (updates only reach copies that already contain this feature).

To release an update:
1. Raise `version` in `package.json` (for example 1.0.0 to 1.0.1).
2. Commit and push, then tag it and push the tag (the tag must be `v` + the version):
   `git tag v1.0.1` then `git push origin v1.0.1`
3. GitHub Actions builds it and publishes a Release. Installed copies notice within a few hours (or when
   they press **Check for updates** in Settings → About), download it quietly and ask to restart.

No GitHub Actions? From your own PC, set a token first (`set GH_TOKEN=your_token`) and run `npm run release`.

## Export / import

Settings -> **Export & import** takes your data from one computer to another, Windows or Mac, in either direction.
Export: tick what to include - **settings**, **favourites**, **followed levels** (and their update notices), the **personal
list**, **cleared notifications** - and save it to a `.json` file or copy it as one line of text (`AREDL-SETTINGS:...`).
Import: choose the file (or paste the text) and the app shows what is inside; only the parts that really are in it can be
ticked. The lists can be **added** to what you have (nothing is lost; an entry already there is left alone) or **replace**
it. The result is listed afterwards, with **Undo this import**, which puts everything it changed back (a copy is kept in
`import-backup/` in the app's data folder).

The rules live in `settings-transfer.js` and are strict: every setting is checked against a list of the real ones (right
kind of value, inside its range), every list entry is cleaned and size-limited, and anything that doesn't pass is skipped
and counted. A setting that doesn't exist on the computer you import into (the Windows window-button colours on a Mac, the
top bar on Linux) is skipped with a reason. **The account / API key is never part of an export.**

## More features (1.1.1)

* **Sync** (`sync.js`, Settings -> Sync & songs): one file, `AREDL-Desktop-sync.json`, in a folder both computers share. Per block
  (settings, favourites, custom lists, saved filters, followed levels, personal list, cleared notifications) it compares this
  computer, the file, and what matched last time: only-mine -> sent, only-the-file's -> brought here, both -> newer wins and the
  other is kept in `sync-backups/`; the first sync combines lists. Pulls happen at start-up (before the window reads any data) and
  on "Sync now"; the background timer and quitting only send. Never the API key; Windows-only settings stay put.
* **Command palette** (` by default, changeable in Settings), **pick a level**, **points what-if**, **personal list stats**, **saved filters / EDEL range**,
  **custom lists**, **song names** - all in `renderer/features.js`.

## Mac version

A Mac app is built too. On a Mac, `npm install` then `npm run dist` builds it (`npm run dist` builds for whichever
computer you run it on), and GitHub Actions builds it automatically as well - see `.github/workflows/build.yml`.
A Mac can only be built on a Mac, so on Windows leave that to GitHub: pushing a version tag adds the Mac files to the
release next to the Windows ones:

* `AREDL-Desktop-mac-arm64.dmg` / `AREDL-Desktop-mac-x64.dmg` - the installers (Apple Silicon: M1 and newer / Intel).
* `AREDL-Desktop-mac-arm64.zip` / `AREDL-Desktop-mac-x64.zip` - what installed Mac apps download to update themselves.

**Updates on Mac.** `electron-updater` can't be used there: Apple only lets an app update itself that way if it is signed
with a paid developer certificate. So `mac-updater.js` does the same job: it asks GitHub for the newest release, downloads
the matching `.zip` in the background (progress shows on the Dock icon), asks "Restart now / Later", and swaps the new app
in when the app quits. It checks 8 seconds after start-up and every 4 hours (and Settings -> About -> Check for updates).
The Windows release goes up first and the Mac files a few minutes later; until they exist the Mac app just sees
"nothing new" and looks again later. If a copy can't replace itself (it is running straight from the disk image, or from
a folder it can't write to) it offers the download page instead - the fix is to drag it into Applications.

**Not signed by Apple.** That needs a paid developer account. Instead `scripts/adhoc-sign.js` gives the app a free
"ad-hoc" signature so it runs on Apple Silicon. The first time a *downloaded* copy is opened, macOS will say it can't
verify the app: right-click the app -> **Open** -> **Open**. On newer macOS versions (Sequoia) that button is gone;
instead open **System Settings -> Privacy & Security**, scroll down, and press **Open Anyway**. Or, once, in Terminal:
`xattr -cr "/Applications/AREDL Desktop.app"`. A copy built on your own Mac opens without that, and so does an update the
app downloads itself.

On a Mac the window works like the Windows one: the page draws its own title bar (with the Mac's red / yellow / green buttons
at its left end), so the **Top bar** setting puts the tabs in that bar. There is no tray icon (the Dock icon does that
job: closing the window keeps it running and notifications keep coming), and there is a normal menu bar.

## App tour

The first time the app opens (and once for anyone updating from a version without it) a guided tour walks
through search filters, the right-click menu, the personal list, favourites, followed levels, adaptive glass,
the top-bar tabs and reordering, multi-select and the buttons by a level's name. Replay it any time from
**Settings → About → Replay tour**. The tour lives in `renderer/tour.js`; raise `TOUR_VERSION` there to show
it again to everyone after adding big new features.

## Classic and Platformer

The app covers both lists: Classic (`/api/aredl/...`) and Platformer (`/api/arepl/...`). The Demon List, Favourites,
Followed levels, Personal list, Profile, Submissions, Changelog and the Leaderboard each have a
Classic / Platformer dropdown, always starting on Classic. The Leaderboard also has a Players / Countries dropdown;
clicking a country (or a flag) opens it in the Profile tab (`/api/aredl/country/{id}`, or `arepl` for platformer).
Favourites, followed levels and personal-list entries remember which list they belong to (`mode`); older ones count as Classic.

## Changelog

Every update has an entry at the top of `renderer/releases.js` (and a matching `version` in `package.json`).
That single list becomes the in-app **What's new** window (shown once after an update, and under
Settings → About → View changelog), the notes on the GitHub release, and the text in the "update ready" prompt.
`npm run ship` refuses to release a version that has no entry.

## Performance

The Demon List only draws the rows on screen. Settings → Appearance → **Performance → Lite** turns off blur,
shadows and animations for slower computers, and the app offers it once if scrolling looks slow.

## Creators, backdrop styles

`GET /levels/{id}/creators` (or `/arepl/...`) fills the **Creator(s)** row under Verifier, and is loaded automatically for every
level in a multi-select (each level is only asked once per session). Settings → Background → **Backdrop style** switches between the
blurred Image and the **Shader** (48 averaged colour regions drawn as drifting bubbles; unavailable in Lite mode).
