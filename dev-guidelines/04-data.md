# Data, settings, sync and sources

## Where things live (user data folder)

| What | File |
| --- | --- |
| settings | `settings.json` (all keys, portable or not) |
| account / API key | `credentials.bin` (encrypted by the OS; **never** exported or synced) |
| favourites, lists, filters, following, personal list, picture overwrites … | `<store name>.json` via `getStore` / `setStore` |
| song names | the song cache (`song:getCache`) |
| custom backdrop | `custom-bg.<ext>` (served at `/_bg/current`, up to 500 MB) |
| sync state | `sync-state.json`; backups of anything a sync replaced: `sync-backups/` (latest 40) |

## Export / import and sync

`settings-transfer.js` is the single definition of what can leave the computer:

- `SPEC` = portable settings (each with a `check` that cleans a value; anything not listed is never exported).
- `SECTIONS` = the lists. Each has a cleaner (`CLEAN`), a key function (`KEY`, exported as `ITEM_KEY`) and a cap.
- Import plans are built by `planImport`; combining (add / replace / merge) by `combine`.

`sync.js` uses the same cleaners for the file in the Drive folder. Modes: `full`, `save` (this app replaces the folder), `load` (the folder replaces this app), `push` (background: only send changes; report what waits), `check` (look only, never write). `preview()` lists the differences without changing anything. A part is "really big" when it grew/shrank by ≥ 20 items and ≥ 50 %, or lost everything from 10+ items; the timer asks before saving those.

Timers (Settings → Sync): the save timer runs only when something changed locally (a local hash comparison, no request); the check timer is one small request and never uploads. Linked = one timer doing both.

## Google client

`drive.js` `client()`: the client built into the app (`drive-config.js` + `drive-config.local.js`) always wins. A client saved on the computer is only used when the app has none of its own, and is deleted at start-up when the built-in one exists.

## AREDL API

Base `https://api.aredl.net/v2/api/`, prefix `aredl` (Classic) or `arepl` (Platformer) — use `apiPrefix(mode)`. Endpoints are built in `ENDPOINTS` in `main.js`. Level ids in paths can be the internal id, the game level id, or the position; two-player versions use `_2p` after the game id.

- `pack-tiers`: tiers (`id, name, color, placement`) each with `packs` (`id, name, points, levels[]`); levels carry `level_id`, `two_player`, `position`, `points`, `status`, `completed_by_user`.
- `levels/{id}/packs`: `[{ id, name, tier: { id, name, color } }]`.
- Mutual victors (`records/mutual-victors`) is staff-only; not used.

## Pictures

AREDL publishes level pictures in its public repository (`All-Rated-Extreme-Demon-List/Thumbnails`):

```
https://raw.githubusercontent.com/All-Rated-Extreme-Demon-List/Thumbnails/main/levels/full/<game level id>.webp    1920x1080
https://raw.githubusercontent.com/All-Rated-Extreme-Demon-List/Thumbnails/main/levels/cards/<game level id>.webp   1920x200 strip
https://raw.githubusercontent.com/All-Rated-Extreme-Demon-List/Thumbnails/main/packs/<pack id>.webp
```

One image per request; there is no bulk call. Use `cards` for banners and rows, `full` for the backdrop. A missing picture is a 404: remember it (`aredlMissing`) and fall back to YouTube (`https://img.youtube.com/vi/<id>/hqdefault.jpg`, which has black bars top and bottom). "Refresh level pictures" changes `thumbRev`, which is appended as `?r=` to AREDL picture URLs to bypass the browser's copy.

## Songs

`lookupSong(id)`: the game server (boomlings) is asked first; Newgrounds is asked only if that gave no name. The bulk lookup runs about one song per second and only when started.
