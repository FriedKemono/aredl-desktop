# Checklist before delivering a change

- [ ] Works on Windows **and** Mac (no OS-specific path, no Windows-only API without a guard).
- [ ] New UI uses existing components and classes; glass themes and Lite mode checked in the CSS.
- [ ] Anything shown for a level also exists in multi-select.
- [ ] Every new request is needed, cached, and logged (`miscFetch` / `logPic`). Nothing loads before it is shown (the one exception: what the command palette searches is loaded quietly by `prepareSearch()`).
- [ ] New data views have a raw-response box.
- [ ] New setting: wired on start and on change; portable ones are in `SPEC`; local ones are not.
- [ ] New list the person keeps: store + transfer section + sync part.
- [ ] New place the app can send you to: a command-palette entry (short name, hint saying what it does); tour updated if it is a main feature.
- [ ] Text is neutral, sentence case, `’` apostrophes.
- [ ] `version` bumped in `package.json` and a changelog entry added (items have titles, date DD-MM-YYYY) when pushing.
- [ ] `node --check` on every changed `.js` file.
- [ ] New run-time file listed in `package.json → build.files` (outside `renderer/**`).
- [ ] Package named `aredl-desktop-VERSION.zip`.
