// ---------------------------------------------------------------------------
// "What's new": the changelog window.
// Opens by itself once after an update (showing everything since the version you had), and the full
// history is always available from Settings > About > View changelog. The entries live in releases.js.
// ---------------------------------------------------------------------------
(() => {
  const TYPE_LABEL = { new: 'New', improved: 'Improved', fixed: 'Fixed' };
  const byId = (id) => document.getElementById(id);

  // 1.0.10 > 1.0.9
  const compare = (a, b) => {
    const x = String(a).split('.').map(Number), y = String(b).split('.').map(Number);
    for (let i = 0; i < 3; i++) { const d = (x[i] || 0) - (y[i] || 0); if (d) return d; }
    return 0;
  };

  function releaseHtml(r) {
    const items = r.items.map(([type, text]) =>
      `<li><span class="wn-tag wn-${escapeHtml(type)}">${escapeHtml(TYPE_LABEL[type] || type)}</span><span>${escapeHtml(text)}</span></li>`).join('');
    return `<section class="wn-release"><h4>Version ${escapeHtml(r.version)}${r.date ? ` <small class="wn-date">${escapeHtml(new Date(r.date + 'T12:00:00').toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' }))}</small>` : ''}${r.title ? ` <small>${escapeHtml(r.title)}</small>` : ''}</h4><ul class="wn-list">${items}</ul></section>`;
  }

  function setOpen(open) {
    const m = byId('whatsNew');
    if (open) { m.hidden = false; requestAnimationFrame(() => m.classList.add('open')); }
    else { m.classList.remove('open'); setTimeout(() => { if (!m.classList.contains('open')) m.hidden = true; }, 180); }
  }
  function show(releases, title) {
    byId('whatsNewTitle').textContent = title;
    byId('whatsNewBody').innerHTML = releases.map(releaseHtml).join('');
    byId('whatsNewBody').scrollTop = 0;
    setOpen(true);
    byId('whatsNewOk').focus();
  }

  byId('whatsNewClose').addEventListener('click', () => setOpen(false));
  byId('whatsNewOk').addEventListener('click', () => setOpen(false));
  byId('whatsNew').addEventListener('mousedown', (e) => { if (e.target === byId('whatsNew')) setOpen(false); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !byId('whatsNew').hidden) setOpen(false); });
  byId('whatsNewBtn').addEventListener('click', () => show(APP_RELEASES, 'Changelog'));

  // After an update: show what's new since the version you last saw.
  async function maybeShowWhatsNew() {
    let current;
    try { current = await window.aredl.getAppVersion(); } catch { return; }
    const last = appSettings.lastSeenVersion;
    if (last === current) return;
    setSetting('lastSeenVersion', current);
    // A brand-new install gets the tour, not a list of changes it never had.
    if (!last && !appSettings.tourSeen) return;
    const releases = last
      ? APP_RELEASES.filter(r => compare(r.version, last) > 0 && compare(r.version, current) <= 0)
      : APP_RELEASES.filter(r => r.version === current); // updating from a version that didn't track this: just this one
    if (!releases.length) return;
    // don't talk over the tour; give the screen a moment to settle first
    setTimeout(() => {
      const tour = byId('tour');
      if (tour && !tour.hidden) return;
      show(releases, `What’s new in ${current}`);
    }, 1500);
  }

  if (window.appBooted) maybeShowWhatsNew();
  else window.addEventListener('aredl:ready', maybeShowWhatsNew, { once: true });
})();
