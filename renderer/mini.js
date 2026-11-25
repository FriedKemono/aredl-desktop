// The player window: the one YouTube player of the app. Docked over its page's video it shows only the video; popped out, it has its bar and grips.
(() => {
  const api = window.aredlMini;
  const dock = document.querySelector('.video-dock');
  const frame = dock.querySelector('iframe');
  const bar = dock.querySelector('.mp-bar');
  let PAD = 48, vid = null, pingTimer = null, lastTimeSent = 0, lastState = null, host = 'www.youtube.com', triedNoCookie = false, initArgs = null;

  const post = (obj) => { try { frame.contentWindow.postMessage(JSON.stringify(obj), '*'); } catch { /* not ready */ } };
  const listen = () => post({ event: 'listening', id: 1, channel: 'widget' });
  const command = (func, args) => post({ event: 'command', func, args: args === undefined ? '' : args });

  api.onInit((d) => {
    document.documentElement.style.cssText = d.rootCss || '';
    document.body.style.cssText = d.bodyCss || '';
    document.body.className = (d.bodyClass || '') + (dock.classList.contains('docked') ? ' docked-win' : '');
    dock.querySelector('.mp-title').textContent = d.title || '';
    PAD = Number(d.pad) || 48;
    vid = d.vid; lastState = null; lastTimeSent = 0;
    document.body.classList.toggle('standalone', !!d.standalone); // opened from a record, no page behind it: no “Back to the level”
    dock.style.setProperty('--poster', d.kind && d.kind !== 'youtube' ? 'none' : `url(https://img.youtube.com/vi/${encodeURIComponent(vid)}/hqdefault.jpg)`);
    initArgs = d; host = 'www.youtube.com'; triedNoCookie = false;
    load();
  });
  function load() {
    const d = initArgs;
    if (d.kind === 'medal') { frame.src = `${d.url}?autoplay=${d.autoplay ? 1 : 0}&muted=0&loop=0`; return; } // Medal's own embed address; it reports nothing back
    if (d.kind === 'twitch') { frame.src = d.url; return; } // Twitch's own player address (with the parent it needs), also silent
    const start = Number(d.time) > 1 ? `&start=${Math.floor(Number(d.time))}` : '';
    frame.src = `https://${host}/embed/${encodeURIComponent(vid)}?origin=${encodeURIComponent(location.origin)}${d.autoplay ? '&autoplay=1' : ''}${start}&enablejsapi=1`;
  }
  frame.addEventListener('load', () => { if (initArgs && initArgs.kind !== 'youtube') return; listen(); clearInterval(pingTimer); pingTimer = setInterval(listen, 3000); });
  api.onCmd((c) => command(c.func, c.args));

  // YouTube reports where it is and whether it plays, once we've said we're listening; the app is told (the moment about once a second)
  window.addEventListener('message', (e) => {
    if (e.source !== frame.contentWindow) return;
    let d = e.data;
    if (typeof d === 'string') { try { d = JSON.parse(d); } catch { return; } }
    if (!d) return;
    let st = null, time = null;
    if (d.event === 'infoDelivery' && d.info) {
      if (typeof d.info.currentTime === 'number') time = d.info.currentTime;
      if (typeof d.info.playerState === 'number' && d.info.playerState !== -1) st = d.info.playerState;
    } else if (d.event === 'onStateChange' && typeof d.info === 'number' && d.info !== -1) st = d.info;
    if (d.event === 'onError' && typeof d.info === 'number') { // YouTube says why it can't play the video
      if ((d.info === 152 || d.info === 153) && !triedNoCookie) { triedNoCookie = true; host = 'www.youtube-nocookie.com'; load(); return; } // once more through YouTube's other embed address
      api.state({ vid, state: null, time: null, error: d.info });
      return;
    }
    const now = Date.now();
    if (st != null && st !== lastState) { lastState = st; lastTimeSent = now; api.state({ vid, state: st, time }); }
    else if (time != null && now - lastTimeSent > 1000) { lastTimeSent = now; api.state({ vid, state: null, time }); }
  });

  dock.querySelector('[data-mp="close"]').addEventListener('click', () => api.close());
  dock.querySelector('[data-mp="return"]').addEventListener('click', () => api.returnToApp());

  // Moving and resizing (popped out): the pointer going down and up is reported; between the two the main process moves the window with the cursor.
  let active = null;
  const begin = (el, e, g) => { if (e.button !== 0) return; active = { el, id: e.pointerId }; try { el.setPointerCapture(e.pointerId); } catch { /* fine */ } dock.classList.add('dragging'); api.gesture(g); e.preventDefault(); };
  const finish = () => { if (!active) return; const a = active; active = null; dock.classList.remove('dragging'); try { a.el.releasePointerCapture(a.id); } catch { /* already released */ } api.gestureEnd(); };
  bar.addEventListener('pointerdown', (e) => { if (!e.target.closest('.mp-btn')) begin(bar, e, { kind: 'move' }); });
  dock.querySelectorAll('.mp-resize').forEach(h => h.addEventListener('pointerdown', (e) => begin(h, e, { kind: 'resize', edge: h.dataset.edge })));
  window.addEventListener('pointerup', finish, true);
  window.addEventListener('pointercancel', finish, true);
  window.addEventListener('blur', finish);

  // A message about a change of the window's size carries the size the window is about to get (ww/wh). It is applied in the very frame the window
  // has that size, so the video never shows for a moment at the wrong place inside it (the window and the page are different processes, so the
  // size and the message can't arrive at the same instant). Without a size, or when the window already has it, it is applied at once.
  let pend = null, pendTimer = 0, goQueued = false;
  const sized = (m) => !(m.ww > 0 && m.wh > 0) || (Math.abs(innerWidth - m.ww) <= 2 && Math.abs(innerHeight - m.wh) <= 2);
  // the app is told once the new layout has been drawn (two frames after it is applied), so it can show the window again
  const placed = (m) => { if (m && m.ack) requestAnimationFrame(() => requestAnimationFrame(() => api.placed())); };
  function flush() { clearTimeout(pendTimer); pendTimer = 0; const p = pend; pend = null; if (p) p.run(); }
  function whenSized(kind, m, run) {
    if (pend) { if (pend.kind === kind) { pend = null; clearTimeout(pendTimer); pendTimer = 0; } else flush(); } // a newer message of the same kind replaces the older one
    if (sized(m)) { run(); return; }
    pend = { kind, m, run };
    pendTimer = setTimeout(flush, 150); // the window never got that size (e.g. it was changed again): apply anyway
  }
  window.addEventListener('resize', () => { if (pend && sized(pend.m)) flush(); });

  // How the player sits in the window: docked, it fills the visible part of its page's video (when part of the video is scrolled out of
  // view the player is bigger than the window and offset, so the window just shows the part that is in view); popped out, it has room around it.
  api.onPlace((p) => whenSized('place', p, () => {
    dock.classList.remove('gliding', 'run', 'clip-glide');
    if (p.mode === 'docked') {
      dock.classList.add('docked');
      dock.style.left = -p.ox + 'px'; dock.style.top = -p.oy + 'px'; dock.style.width = p.w + 'px'; dock.style.height = p.h + 'px';
    } else {
      dock.classList.remove('docked');
      dock.style.left = PAD + 'px'; dock.style.top = PAD + 'px';
      dock.style.width = `calc(100% - ${PAD * 2}px)`; dock.style.height = `calc(100% - ${PAD * 2}px)`;
    }
    placed(p);
  }));

  // Gliding between the page's video and the corner: the window is big enough to hold both places, and the player moves inside it with
  // a transform (smooth, done by the graphics card); the window is put on its final place afterwards (the next 'place').
  // The part of the video that is scrolled out of view (fromClip / toClip) is covered by a clip that opens or closes during the move, and the
  // shadow of the corner player fades in or out with it, so nothing appears or vanishes suddenly at either end.
  let glideMs = 300, glideToDocked = false;
  const inset = (c, kx, ky) => (c ? `inset(${[c.t * ky, c.r * kx, c.b * ky, c.l * kx].map(v => (v > 0 ? v + 'px' : '-60px')).join(' ')})` : 'inset(-60px)');
  api.onGlide((g) => whenSized('glide', g, () => {
    glideMs = g.ms || 300; glideToDocked = !!g.toDocked;
    const f = g.from, t = g.to;
    dock.style.left = t.x + 'px'; dock.style.top = t.y + 'px'; dock.style.width = t.w + 'px'; dock.style.height = t.h + 'px';
    dock.style.setProperty('--glide', `translate(${f.x - t.x}px, ${f.y - t.y}px) scale(${f.w / t.w}, ${f.h / t.h})`);
    dock.style.setProperty('--glide-ms', glideMs + 'ms');
    dock.style.setProperty('--glide-clip-from', inset(g.fromClip, t.w / f.w, t.h / f.h)); // (in the player's own size, before the transform scales it)
    dock.style.setProperty('--glide-clip-to', inset(g.toClip, 1, 1));
    dock.classList.toggle('clip-glide', !!(g.fromClip || g.toClip));
    dock.classList.remove('run');
    dock.classList.add('gliding');
    if (goQueued) { goQueued = false; go(); }
    placed(g);
  }));
  function go() {
    void dock.offsetWidth; // the start position is in place before the move begins
    let done = false;
    const end = () => { if (done) return; done = true; api.glideDone(); };
    dock.addEventListener('transitionend', (e) => { if (e.target === dock && e.propertyName === 'transform') end(); });
    setTimeout(end, glideMs + 250);
    dock.classList.toggle('docked', glideToDocked); // the shadow and border of the corner player fade in or out over the move
    dock.classList.add('run');
  }
  api.onGlideGo(() => { if (pend && pend.kind === 'glide') goQueued = true; else go(); });

  api.ready();
})();
