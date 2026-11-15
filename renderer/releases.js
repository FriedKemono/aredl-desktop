// ---------------------------------------------------------------------------
// The changelog: one entry per version, newest first.
// For every update: add an entry here AND raise "version" in package.json. (`npm run ship` refuses to
// release a version that has no entry.) This one list feeds the in-app "What's new" window, the notes
// on each GitHub release, and the "update ready" prompt.
// Each item is [type, text] where type is 'new', 'improved' or 'fixed'.
// ---------------------------------------------------------------------------
const APP_RELEASES = [
  {
    version: '1.0.9',
    title: 'Settings search, smoother scrolling and an easier corner player',
    items: [
      ['new', 'Search bar at the top of Settings (Ctrl+F also jumps to it). Type to narrow the page down to the options that match; Esc clears it.'],
      ['fixed', 'Slider value pills (like 100%) keep one fixed size, so the slider no longer changes size under your hand when it reaches the default. Sitting on the default just tones the pill down.'],
      ['fixed', 'Scrolling Settings is much smoother: the animated backdrop holds still while you scroll, and settings cards no longer re-blur the background on every frame in glass themes.'],
      ['improved', 'Resizing the corner player is easier: bigger grab areas just outside the corners, all four edges resize too, and it stops at the window edge instead of drifting away from the corner you are holding.'],
    ],
  },
  {
    version: '1.0.8',
    title: 'Shader controls, tidier sliders and a steadier corner player',
    items: [
      ['new', 'Shader speed and Shader intensity sliders (Settings → Background, shown while the Shader backdrop is chosen). At 0% speed the bubbles stand still and the shader stops using any processing power.'],
      ['fixed', 'The Background blur slider now works with the Shader backdrop. It had no effect before.'],
      ['fixed', 'Reordering tabs is smooth now. Drag a tab and a line shows exactly where it will land; nothing jumps around while you drag, and letting go in the gap between the left and right sides works.'],
      ['fixed', 'The Done button always shows while you reorder tabs (it was getting hidden behind the glass title bar). Reorder tabs in Settings also turns into Done, and Esc still finishes too.'],
      ['fixed', 'When Videos is not set to “Move it to a corner player”, the video no longer lingers on screen for a moment after you leave its page.'],
      ['fixed', 'Every slider’s value (like 20%) now sits in a tidy pill right beside the slider, in the app’s own font, instead of floating off to the side in a different one.'],
      ['improved', 'The corner player’s resize handles now sit on the player’s actual corners, outside it, following its rounded shape. You can also resize by dragging up or down, not only sideways.'],
      ['improved', 'The dates slider now applies to the Personal list too: “Days since” shows 12.37 days (or 12.4, or 12) to match.'],
      ['improved', 'Drop a tab straight onto the ⋯ button to tuck it into the menu. Pressing Esc mid-drag cancels just that move.'],
      ['improved', 'Faster and lighter: dragging a slider no longer rewrites your settings file dozens of times a second, and the shader draws fewer frames and goes completely idle when nothing is moving.'],
    ],
  },
  {
    version: '1.0.7',
    title: 'Creators, shader backdrop and tidier tabs',
    items: [
      ['new', 'Creators on every level, right under Verifier. In multi-select they load automatically (once per level) and are highlighted just like verifiers.'],
      ['new', 'Backdrop style (Settings → Background): choose the classic blurred Image or a new Shader, which turns the level picture’s colours (50 or so regions, each averaged) into soft floating bubbles. The Shader is greyed out in Lite mode, and “Let it drift slowly” is always on with it.'],
      ['new', 'Favourites and Submissions now have an All option next to Classic and Platformer, and start on it.'],
      ['new', 'In Notifications, level names are links that take you to that level.'],
      ['improved', 'Back and Forward now remember the Classic / Platformer choice on every page (and the Players / Countries board, and which country you were viewing).'],
      ['improved', 'Reordering tabs: the hint now floats at the bottom of the window instead of using up top bar space, and the ⋯ menu button can be dragged like any tab. The side bar can no longer be reordered.'],
      ['improved', 'The app tour now goes left to right through the Demon List, recommends itself in red, and keeps its right-click menu open while you read.'],
      ['improved', 'Favourite cards now show each level’s points and tags, as they were meant to.'],
      ['fixed', 'Country pages in the Profile tab can scroll.'],
    ],
  },
  {
    version: '1.0.6',
    title: 'Smoother on slower computers',
    items: [
      ['improved', 'The Demon List now only draws the rows you can see, so scrolling, searching and switching lists are far smoother on slower computers, even with every status showing.'],
      ['improved', 'The glass themes no longer re-blur behind scrolling panels, which was their biggest slowdown. They look the same.'],
      ['new', 'Lite mode (Settings → Appearance → Performance) turns off blur, shadows and animations. The app offers it if it notices scrolling is struggling.'],
      ['new', 'A “What’s new” window appears after each update, and the full changelog is in Settings → About.'],
      ['new', 'Release notes now come with every update: on the GitHub release and in the “update ready” prompt.'],
    ],
  },
  {
    version: '1.0.5',
    title: 'Platformer lists and countries',
    items: [
      ['new', 'Platformer lists. A Classic / Platformer dropdown sits under the Demon List, and in Favourites, Followed levels, Personal list, Profile, Submissions, Changelog and the Leaderboard. Everything starts on Classic.'],
      ['new', 'Countries leaderboard (the Players / Countries dropdown). Click a country or a flag to open that country in the Profile tab.'],
      ['improved', 'Corner video: in sound-only, pause and stop modes the player disappears the instant you change tab. Pause and stop now only apply when you leave the page, not when you scroll, and changing the setting takes effect immediately.'],
      ['improved', 'The play button on a profile’s completed levels has a proper design.'],
      ['improved', 'The app tour has a step for the Classic / Platformer dropdown.'],
    ],
  },
  {
    version: '1.0.4',
    title: 'Readability and polish',
    items: [
      ['fixed', 'In sound-only mode the video no longer vanishes when you scroll a little; it stays until it has scrolled out of view.'],
      ['improved', 'Easier-to-read grey text in every theme except Adaptive Glass, with a soft edge on text in the glass themes.'],
      ['fixed', 'The floating section label (MAINLIST…) no longer overlaps level names; the rows fade out beneath it.'],
      ['improved', 'Pack cards redesigned: readable text, with the tier shown as a colour accent.'],
      ['improved', 'The corner video player’s drag bar, buttons and resize corners now match the app.'],
      ['improved', 'The tour covers the ⋯ menu button, shows the top-bar options while explaining them, and ends with a note about all the other settings.'],
    ],
  },
  {
    version: '1.0.3',
    title: 'App tour',
    items: [
      ['new', 'A guided tour on first open, which you can replay from Settings → About.'],
      ['improved', 'Favourites start sorted by category.'],
      ['improved', 'The Demon List starts on All statuses, and keeps the status you picked when it refreshes.'],
    ],
  },
  {
    version: '1.0.2',
    title: 'Faster',
    items: [
      ['improved', 'Faster start-up: the level list appears instantly from the last saved copy while the live one loads.'],
      ['improved', 'Quicker search and sorting, and lighter pages that load less behind the scenes.'],
      ['fixed', 'Spacing between the cards in Settings → Advanced.'],
    ],
  },
  {
    version: '1.0.1',
    title: 'First release',
    items: [
      ['new', 'Browse the Demon List with search filters, tag filters, sorting and a right-click menu.'],
      ['new', 'Favourites (with categories) and Followed levels, with notifications when they change.'],
      ['new', 'A Personal list with runs, statistics and CSV export.'],
      ['new', 'Leaderboard with a page picker, Profile, Submissions, Notifications and the list Changelog.'],
      ['new', 'Tabs in the top bar with reordering and a ⋯ menu button, and themes including Adaptive Glass.'],
      ['new', 'Automatic updates.'],
    ],
  },
];
if (typeof module !== 'undefined') module.exports = APP_RELEASES; // so scripts can read it too
