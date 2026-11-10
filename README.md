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
