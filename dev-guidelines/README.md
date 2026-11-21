# AREDL Desktop – developer guidelines

For people (and tools) working on the app. This folder is **not** part of the packaged app: `package.json → build.files` is a whitelist and does not list it, so it never reaches users.

| File | What it covers |
| --- | --- |
| [01-project.md](01-project.md) | Files, the two processes, IPC, scripts, versions, shipping |
| [02-design-system.md](02-design-system.md) | Colours, themes, controls, components, z-index map, motion |
| [03-patterns.md](03-patterns.md) | How to add a tab, a setting, a modal, a menu item, a tour step, … |
| [04-data.md](04-data.md) | Settings, stores, export/import, Google Drive sync, API and picture sources |
| [05-writing.md](05-writing.md) | Wording rules for the UI, the changelog and descriptions |
| [06-checklist.md](06-checklist.md) | What to check before a change is delivered |

Rules that apply everywhere:

1. **Windows and Mac are one code base.** Every change must work on both. Platform differences go through `process.platform` / `body.mac-titlebar`, never separate files.
2. **New UI copies existing UI.** Use the components in `02-design-system.md`. Do not invent a second style for something that already exists.
3. **Multi-select matches single-level.** Whatever changes in the level panel (buttons, packs, pictures, raw responses) also applies to multi-select, unless a change says otherwise.
4. **No request that isn't needed.** Cache, derive from data already loaded, and load only what is on screen. See `04-data.md`.
5. **Neutral wording.** Descriptions and changelog text state facts. They never mention what a person wanted or asked for.
6. **Every update needs a version bump and a changelog entry.** See `01-project.md`.
