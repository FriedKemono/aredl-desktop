// Runs after each app is assembled (see "afterPack" in package.json).
// The Mac version is not signed with a paid Apple developer certificate. Apple Silicon Macs still refuse to
// start code that has no signature at all, so this gives the app a free "ad-hoc" signature (no account needed).
// It does nothing for the Windows build, and it can only run on a Mac (or the macOS GitHub runner).
const { execFileSync } = require('child_process');
const path = require('path');

module.exports = async function adhocSign(context) {
  if (context.electronPlatformName !== 'darwin') return;
  if (process.platform !== 'darwin') { console.warn('  • skipping ad-hoc signing: it needs to run on a Mac'); return; }
  const appPath = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  console.log(`  • ad-hoc signing ${appPath}`);
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', appPath], { stdio: 'inherit' });
};
module.exports.default = module.exports;
