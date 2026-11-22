// The corner player: the same player as before, kept on top of everything and movable anywhere on any screen.
// The app hands a video over to it: it loads muted, says when it plays ("primed"), and on "go" seeks to the app's moment and unmutes.
(() => {
  const api = window.aredlMini;
  const dock = document.querySelector('.video-dock');
  const frame = dock.querySelector('iframe');
  const bar = dock.querySelector('.mp-bar');
  let PAD = 48, warmed = false, frameLoaded = false;
  let vid = null, time = 0, timeAt = Date.now(), playing = false, handover = false, primedSent = false, pingTimer = null;
  const live = () => time + (playing ? (Date.now() - timeAt) / 1000 : 0); // where the video is now, from the last report

  const post = (obj) => { try { frame.contentWindow.postMessage(JSON.stringify(obj), '*'); } catch { /* not ready */ } };
  const listen = () => post({ event: 'listening', id: 1, channel: 'widget' });
  const command = (func, args) => post({ event: 'command', func, args: args === undefined ? '' : args });
  const primed = () => { if (primedSent) return; primedSent = true; dock.classList.add('ready'); api.primed(); }; // the window appears once its video plays

  api.onInit((d) => {
    document.documentElement.style.cssText = d.rootCss || '';
    document.body.style.cssText = d.bodyCss || '';
    document.body.className = d.bodyClass || '';
    dock.querySelector('.mp-title').textContent = d.title || '';
    vid = d.vid; time = Number(d.time) || 0; timeAt = Date.now(); playing = false; handover = !!d.playing;
    PAD = Number(d.pad) || 48;
    dock.style.left = PAD + 'px'; dock.style.top = PAD + 'px';
    dock.style.width = `calc(100% - ${PAD * 2}px)`; dock.style.height = `calc(100% - ${PAD * 2}px)`;
    dock.style.setProperty('--poster', `url(https://img.youtube.com/vi/${encodeURIComponent(vid)}/hqdefault.jpg)`);
    if (d.promote && warmed && frameLoaded) { // the ready player takes the video over: it only has to go to the app's moment and play (muted, next to the app's)
      warmed = false; handover = !!d.playing; primedSent = false; dock.classList.remove('ready');
      command('seekTo', [time, true]);
      if (d.playing) {
        command('mute'); command('playVideo');
        setTimeout(() => { if (!playing) { command('mute'); command('playVideo'); } }, 900);
        setTimeout(primed, 9000);
      } else setTimeout(primed, 300);
      return;
    }
    const start = time > 1 ? `&start=${Math.floor(time)}` : '';
    if (d.warm) { warmed = true; handover = false; frame.src = `https://www.youtube.com/embed/${encodeURIComponent(vid)}?origin=${encodeURIComponent(location.origin)}${start}&enablejsapi=1`; return; } // loaded and waiting, paused
    // a video that is playing in the app is loaded muted next to it, so nothing is heard twice; "go" unmutes it
    frame.src = `https://www.youtube.com/embed/${encodeURIComponent(vid)}?origin=${encodeURIComponent(location.origin)}${d.playing ? '&autoplay=1&mute=1' : ''}${start}&enablejsapi=1`;
    setTimeout(primed, 9000); // never wait for ever (no connection, the video can't play)
  });
  frame.addEventListener('load', () => {
    frameLoaded = true;
    listen(); clearInterval(pingTimer); pingTimer = setInterval(listen, 3000);
    if (!handover && !warmed) setTimeout(primed, 700); // a paused video has nothing to wait for but its own loading
  });

  // YouTube reports where it is and whether it plays, once we've said we're listening
  window.addEventListener('message', (e) => {
    if (e.source !== frame.contentWindow) return;
    let d = e.data;
    if (typeof d === 'string') { try { d = JSON.parse(d); } catch { return; } }
    if (!d) return;
    let st = null;
    if (d.event === 'infoDelivery' && d.info) {
      if (typeof d.info.currentTime === 'number') { time = d.info.currentTime; timeAt = Date.now(); }
      if (typeof d.info.playerState === 'number' && d.info.playerState !== -1) st = d.info.playerState;
    } else if (d.event === 'onStateChange' && typeof d.info === 'number' && d.info !== -1) st = d.info;
    if (st != null) { playing = st === 1 || st === 3; if (st === 1 && handover) primed(); }
  });

  // the app's moment: carry on from exactly where the app's player is, with sound
  api.onGo((g) => {
    if (g.playing) {
      if (!playing) command('playVideo');
      if (Math.abs(g.time - live()) > 0.6) command('seekTo', [g.time, true]);
      command('unMute'); setTimeout(() => command('unMute'), 500);
      playing = true; timeAt = Date.now(); time = g.time;
    }
    handover = false;
    dock.classList.add('ready');
  });
  setTimeout(() => dock.classList.add('ready'), 12000); // and never stay hidden if "go" doesn't come

  dock.querySelector('[data-mp="close"]').addEventListener('click', () => api.close());
  const back = (quiet) => api.returnToApp({ vid, time: live(), playing, quiet });
  dock.querySelector('[data-mp="return"]').addEventListener('click', () => back(false));
  api.onRequestReturn((quiet) => back(quiet)); // the app is back, or the video's page is on screen again: the player goes with it

  // Moving and resizing: the pointer going down and up is reported; between the two the main process moves the window with the cursor.
  let active = null;
  const begin = (el, e, g) => { if (e.button !== 0) return; active = { el, id: e.pointerId }; try { el.setPointerCapture(e.pointerId); } catch { /* fine */ } dock.classList.add('dragging'); api.gesture(g); e.preventDefault(); };
  const finish = () => { if (!active) return; const a = active; active = null; dock.classList.remove('dragging'); try { a.el.releasePointerCapture(a.id); } catch { /* already released */ } api.gestureEnd(); };
  bar.addEventListener('pointerdown', (e) => { if (!e.target.closest('.mp-btn')) begin(bar, e, { kind: 'move' }); });
  dock.querySelectorAll('.mp-resize').forEach(h => h.addEventListener('pointerdown', (e) => begin(h, e, { kind: 'resize', edge: h.dataset.edge })));
  window.addEventListener('pointerup', finish, true);
  window.addEventListener('pointercancel', finish, true);
  window.addEventListener('blur', finish);

  // Gliding between the app's video and the corner: the window is big enough to hold both places, and the player moves inside it with
  // a transform (smooth, done by the graphics card); the window is put on its final place afterwards ('settle').
  let glideMs = 300;
  api.onGlide((g) => {
    glideMs = g.ms || 300;
    const f = g.from, t = g.to;
    dock.style.left = t.x + 'px'; dock.style.top = t.y + 'px'; dock.style.width = t.w + 'px'; dock.style.height = t.h + 'px';
    dock.style.setProperty('--glide', `translate(${f.x - t.x}px, ${f.y - t.y}px) scale(${f.w / t.w}, ${f.h / t.h})`);
    dock.style.setProperty('--glide-ms', glideMs + 'ms');
    dock.classList.add('gliding');
  });
  api.onGlideGo(() => {
    void dock.offsetWidth; // the start position is in place before the move begins
    let done = false;
    const end = () => { if (done) return; done = true; api.glideDone(); };
    dock.addEventListener('transitionend', (e) => { if (e.target === dock && e.propertyName === 'transform') end(); });
    setTimeout(end, glideMs + 250);
    dock.classList.add('run');
  });
  api.onSettle(() => {
    dock.classList.remove('gliding', 'run');
    dock.style.left = PAD + 'px'; dock.style.top = PAD + 'px';
    dock.style.width = `calc(100% - ${PAD * 2}px)`; dock.style.height = `calc(100% - ${PAD * 2}px)`;
  });

  api.ready();
})();
