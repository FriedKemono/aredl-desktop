// `npm run dist` - builds the app for the computer you run it on:
//   on a Mac     -> the Mac app (.dmg and .zip files in dist/)
//   on Windows   -> the Windows installer and portable .exe
// (Neither one publishes anything; `npm run ship` is the one that sends an update to GitHub.)
//
// The dist folder is emptied first (a half-finished build left in it is what makes the installer step fail with
// "Can't open output file"), and a build that fails is tried again after a short wait, with the folder emptied again:
// the installer file is sometimes held open for a moment by antivirus or the indexer right after it is written.
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const dist = path.join(root, 'dist');
const run = (cmd) => { console.log(`> ${cmd}`); execSync(cmd, { stdio: 'inherit', cwd: root }); };
const wait = (ms) => { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch { /* no wait */ } };

// removes dist, trying again while Windows still holds a file in it
function cleanDist() {
  for (let i = 0; i < 6; i++) {
    try { fs.rmSync(dist, { recursive: true, force: true, maxRetries: 5, retryDelay: 400 }); return true; } catch { wait(1000); }
  }
  return !fs.existsSync(dist);
}
// a copy of the app (or a leftover build process) left running keeps its files locked
function stopLeftovers() {
  if (process.platform !== 'win32') return;
  for (const name of ['makensis.exe', 'app-builder.exe']) { try { execSync(`taskkill /F /IM ${name}`, { stdio: 'ignore' }); } catch { /* not running */ } }
}

const build = process.platform === 'darwin' ? 'electron-builder --mac dmg zip --publish never' : 'electron-builder --win nsis portable --publish never';
run('node scripts/release-notes.js');
const ATTEMPTS = 3;
for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
  stopLeftovers();
  if (!cleanDist()) console.warn('The dist folder could not be emptied completely (something still has a file in it open). Trying anyway.');
  try { run(build); break; } catch (err) {
    if (attempt === ATTEMPTS) { console.error(`\nThe build failed ${ATTEMPTS} times. Close AREDL Desktop (also in the tray) and run npm run dist again.`); process.exit(1); }
    console.warn(`\nThe build failed (attempt ${attempt} of ${ATTEMPTS}). Cleaning up and trying again...\n`);
    wait(3000);
  }
}
