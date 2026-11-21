// Writes build/release-notes.md for the version in package.json, from renderer/releases.js.
// electron-builder attaches that file to the GitHub release (and to the update info the app downloads).
//   node scripts/release-notes.js            -> writes a placeholder if there's no entry (local test builds)
//   node scripts/release-notes.js --strict   -> stops if there's no entry (real releases)
const fs = require('fs');
const path = require('path');
const releases = require('../renderer/releases.js');
const version = require('../package.json').version;
const strict = process.argv.includes('--strict');

const entry = releases.find(r => r.version === version);
if (!entry) {
  const msg = `No changelog entry for ${version}. Add one at the top of renderer/releases.js.`;
  if (strict) { console.error(msg); process.exit(1); }
  console.warn('Warning: ' + msg);
}
const label = { new: 'New', improved: 'Improved', fixed: 'Fixed' };
const md = entry
  ? `## What's new in ${version}${entry.title ? ` - ${entry.title}` : ''}\n\n${entry.items.map(([t, x, title]) => `- **${title ? title + ' ' : ''}(${label[t] || t})** ${x}`).join('\n')}\n`
  : `## ${version}\n\nTest build.\n`;
fs.mkdirSync(path.join(__dirname, '..', 'build'), { recursive: true });
fs.writeFileSync(path.join(__dirname, '..', 'build', 'release-notes.md'), md);
console.log(`Wrote build/release-notes.md for ${version}`);
