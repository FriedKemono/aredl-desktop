// Runs in the GitHub release build, right after the Windows files are uploaded: makes sure the release for this tag is
// published (not a draft) and marked as the latest one. GitHub's "latest release" address, which installed copies use
// to look for updates, answers 404 until that is the case. It never stops the build: a problem is only printed.
const repo = process.env.GITHUB_REPOSITORY, tag = process.env.GITHUB_REF_NAME, token = process.env.GH_TOKEN;
const api = (p, opts = {}) => fetch(`https://api.github.com/repos/${repo}${p}`, { ...opts, headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'AREDL-Desktop-release', ...(opts.headers || {}) } });
(async () => {
  if (!repo || !tag || !token) { console.log('Not running on GitHub: nothing to publish.'); return; }
  const res = await api('/releases?per_page=30');
  if (!res.ok) throw new Error(`Listing releases failed (${res.status})`);
  const rel = (await res.json()).find(r => r.tag_name === tag);
  if (!rel) throw new Error(`No release found for ${tag}`);
  const patch = await api(`/releases/${rel.id}`, { method: 'PATCH', body: JSON.stringify({ draft: false, prerelease: false, make_latest: 'true' }) });
  if (!patch.ok) throw new Error(`Publishing the release failed (${patch.status})`);
  console.log(`Release ${tag} is published and marked as the latest.`);
})().catch(err => console.warn(`Could not publish the release automatically: ${err.message}`));
