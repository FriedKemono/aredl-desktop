// `npm run dist` - builds the app for the computer you run it on:
//   on a Mac     -> the Mac app (.dmg and .zip files in dist/)
//   on Windows   -> the Windows installer and portable .exe
// (Neither one publishes anything; `npm run ship` is the one that sends an update to GitHub.)
const { execSync } = require('child_process');
const path = require('path');
const root = path.join(__dirname, '..');
const run = (cmd) => { console.log(`> ${cmd}`); execSync(cmd, { stdio: 'inherit', cwd: root }); };

run('node scripts/release-notes.js');
if (process.platform === 'darwin') run('electron-builder --mac dmg zip --publish never');
else run('electron-builder --win nsis portable --publish never');
