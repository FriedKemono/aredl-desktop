// `npm run ship` - uploads the current version to GitHub and starts the release build.
// It does: git add . / git commit / git push / git tag v<version> / git push origin v<version>
// If this folder was never connected to GitHub (for example a freshly extracted zip, which has no
// hidden .git folder), it connects itself to the repo named in package.json first.
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const pkg = require('../package.json');
const version = pkg.version;
const tag = `v${version}`;
const root = path.join(__dirname, '..');
const run = (cmd) => { console.log(`> ${cmd}`); execSync(cmd, { stdio: 'inherit', cwd: root }); };
const out = (cmd) => execSync(cmd, { encoding: 'utf8', cwd: root, stdio: ['ignore', 'pipe', 'ignore'] }).trim();

try {
  if (!fs.existsSync(path.join(root, '.git'))) {
    const { owner, repo } = (pkg.build && pkg.build.publish) || {};
    if (!owner || !repo || /YOUR_/.test(owner + repo)) {
      console.error('package.json still has placeholder GitHub names under build.publish. Fill those in first.');
      process.exit(1);
    }
    console.log(`This folder isn't connected to GitHub yet - connecting it to ${owner}/${repo} (your files stay as they are)...`);
    run('git init');
    run('git branch -M main');
    run(`git remote add origin https://github.com/${owner}/${repo}.git`);
    run('git fetch origin --tags');
    run('git reset origin/main');                       // takes on the repo's history, keeps the files in this folder
    run('git branch --set-upstream-to=origin/main main');
  }

  // forgot to raise the version? stop before uploading anything
  if (out(`git tag -l ${tag}`)) {
    console.error(`\nVersion ${version} was already released (tag ${tag} exists).\nRaise "version" in package.json first, then run this again.`);
    process.exit(1);
  }

  run('git add .');
  try { run(`git commit -m "Version ${version}"`); } catch { console.log('(nothing new to commit - continuing)'); }
  run('git push');
  run(`git tag ${tag}`);
  run(`git push origin ${tag}`);
  console.log(`\nDone. Release ${tag} is building on GitHub (Actions tab, about 3-5 minutes).`);
} catch {
  console.error('\nStopped - read the message just above for why (a git error).');
  process.exit(1);
}
