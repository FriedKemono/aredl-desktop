// ---------------------------------------------------------------------------
// The changelog: one entry per version, newest first.
// For every update: add an entry here AND raise "version" in package.json. (`npm run ship` refuses to
// release a version that has no entry.) This one list feeds the in-app "What's new" window, the notes
// on each GitHub release, and the "update ready" prompt.
// Each item is [type, text] where type is 'new', 'improved' or 'fixed'.
// ---------------------------------------------------------------------------
const APP_RELEASES = [
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
