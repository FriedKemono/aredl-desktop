# Design system

All styles live in `renderer/styles.css`. Colours come from CSS variables; never hard-code a colour that a theme could change.

## Tokens (`:root`)

| Variable | Use |
| --- | --- |
| `--bg`, `--bg2`, `--panel` | page, raised surface, card/panel background |
| `--border` | every 1px outline |
| `--text`, `--text-dim`, `--text-faint` | primary, secondary, tertiary text |
| `--accent`, `--on-accent` | highlight colour and the text on top of it |
| `--accent-soft`, `--accent-soft2` | translucent accent (hover, active backgrounds) |
| `--glass`, `--glass-hi` | translucent fill for small controls (set by the glass themes) |
| `--ctl-h` | height of standard controls (36px) |
| `--font`, `--mono` | Poppins / UI font stack, monospace |

Themes are the `THEMES` array in `app.js` (Default, AMOLED, Midnight, Ocean, Forest, Violet, Glass, Adaptive Glass, Crimson). A theme sets the variables above on the root. **Adaptive Glass** recolours `--accent` from the current level's picture; anything accent-coloured must use the variable so it follows. The player and floating player copy the root/body inline style so they look the same.

`body.glassy` is on for the glass themes. Small controls get `background-color: var(--glass)` and an inset highlight there. A new pill/button style must be added to the glass rules (search `body.glassy .tag` in the CSS) so it matches the other small controls.

`body.lite` (Lite mode) turns off blur/shadows. Do not add new blur outside the existing glass rules.

## Controls

| Control | Markup / class |
| --- | --- |
| Button | `.btn` (filled accent), `.btn.btn-ghost` (panel + border), `.small-btn` (30px) |
| Icon button | `.btn.btn-ghost.icon-btn` |
| Toggle | `<label class="checkbox-wrap"><input type="checkbox"> Label</label>`, the app's checkbox. There is no separate switch component. |
| Dropdown | a plain `<select>`; every `select` in the page is replaced by the custom dropdown at load (`enhanceSelect`). Setting `.value` from code updates it. `setSelectDisabled(sel, bool)` disables it. |
| Slider | `input[type=range]` with a value pill (`.slider-out`) beside it |
| Text input | `.fx-input` in dialogs; search boxes use `.search-wrap` |
| Level tool buttons | `.title-tools` > `.icon-tool` (one pill with thin dividers; they fold away behind the arrow) built by `levelToolsHtml()` |
| Chips / pills | `.tag` (level tags), `.filter-pill`, `.opt-pill` (selectable), `.pack-chip` (a pack a level is in, tier colour dot via `--pack-bg`) |
| Tooltip | `data-tip="text"` on any element. Never use `title=` for new tooltips. Tooltips are suppressed while a tab is dragged. |

## Settings

A card is `.settings-card` with an `<h3>`. Inside, each option is a row:

```html
<div class="setting-line">
  <div class="setting-label"><strong>Name</strong><small>One or two sentences of what it does.</small></div>
  <!-- the control: select, checkbox-wrap, button(s) -->
</div>
```

A labelled divider inside a card is `<div class="setting-sep"><span>Title</span></div>`. Settings are searchable (the settings search and the command palette read `.setting-line`), so labels must be meaningful on their own.

## Components

- **Modal:** `fx.openModal({ title, wide, persistent, onClose })` returns `{ body, box, overlay, close }`. Build the content with `el()` helpers; rows use `.fx-row`, notes `.fx-note` / `.fx-hint`, lists `.fx-list` > `.fx-listrow`. Only one modal is open at a time.
- **Context menu:** `showContextMenu(x, y, items)`; item = `{ label, onClick, disabled?, danger? }` or `{ separator: true }`. Level menus are built by `levelMenuItems()`.
- **Toast:** `showToast(text)`; with a button `fx.actionToast(text, label, onClick)`.
- **Banner rows:** `.completed-banner` (a level; `--bg-thumb` is its picture, class `has-bg`), `.pack-banner` / `.pack-card` (a pack; `--pack-bg` is the tier colour), `.submission-card`.
- **Raw API response box:** `rawDetails(summary, data)` returns a `<details class="debug-info">`. Hidden unless "Show raw API responses" is on. Add one to every view that loads API data.
- **Command palette rows:** `{ kind, label, hint, run }`: `label` is the short name, `hint` says what choosing it does — see `05-writing.md`.

## Layout rules

- Tabs: `<section class="tab" id="tab-NAME">` with a `.tab-header` (title row, then optional description) and content below.
- Lists with many rows are virtualised (`listV`); only visible rows exist.
- Spacing is multiples of 4px; card radius 10px; controls are fully rounded (`999px`) in the pill style.

## z-index map

| Layer | z-index |
| --- | --- |
| page content | 0–10 |
| menu button list beside the side bar | 5000 |
| tab drag ghost / drop marker | 10006 |
| dropdown menus, context menu, calendar pop | 10010 |
| modals (`.fx-overlay`) | 10010 |
| tooltips, toasts | 10020 |
| tour (`#tour`) | 100000 |
| **corner player** (`.video-dock.mini`, only inside the corner player window) | 2147483000 |
| reorder bar (Done button and text) | 2147483600 |

The corner player is its own window (see 03-patterns.md), always above every other window; inside the app nothing is drawn for it. Do not add anything above 100000 except these.

## Motion

Popups fade/scale in (`fxFadeIn`, `fxPopIn`, ~0.16–0.2s, `cubic-bezier(.2,.8,.2,1)`). Dropdowns/context menus use `ddIn`. Keep new motion in that range, and disable it under Lite mode.
