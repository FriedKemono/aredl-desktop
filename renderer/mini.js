// The floating player window: the same player as the corner one, kept on top of everything and movable anywhere on any screen.
(() => {
  const api = window.aredlMini;
  const dock = document.querySelector('.video-dock');
  const frame = dock.querySelector('iframe');
  const bar = dock.querySelector('.mp-bar');
  let vid = null, time = 0, playing = false, pingTimer = null, PAD = 28;
  const MIN_W = 220, MAX_W = 900; // the same limits as the corner player

  const post = (obj) => { try { frame.contentWindow.postMessage(JSON.stringify(obj), '*'); } catch { /* not ready */ } };
  const listen = () => post({ event: 'listening', id: 1, channel: 'widget' });

  api.onInit((d) => {
    document.documentElement.style.cssText = d.rootCss || '';
    document.body.style.cssText = d.bodyCss || '';
    document.body.className = d.bodyClass || '';
    dock.querySelector('.mp-title').textContent = d.title || '';
    vid = d.vid; time = Number(d.time) || 0; playing = !!d.playing;
    PAD = Number(d.pad) || 28;
    dock.style.left = PAD + 'px'; dock.style.top = PAD + 'px';
    dock.style.width = `calc(100% - ${PAD * 2}px)`; dock.style.height = `calc(100% - ${PAD * 2}px)`;
    const start = time > 1 ? `&start=${Math.floor(time)}` : '';
    frame.src = `https://www.youtube.com/embed/${encodeURIComponent(vid)}?origin=${encodeURIComponent(location.origin)}${playing ? '&autoplay=1' : ''}${start}&enablejsapi=1`;
  });
  frame.addEventListener('load', () => { listen(); clearInterval(pingTimer); pingTimer = setInterval(listen, 3000); });

  // YouTube reports where it is and whether it plays, once we've said we're listening
  window.addEventListener('message', (e) => {
    if (e.source !== frame.contentWindow) return;
    let d = e.data;
    if (typeof d === 'string') { try { d = JSON.parse(d); } catch { return; } }
    if (!d) return;
    if (d.event === 'infoDelivery' && d.info) {
      if (typeof d.info.currentTime === 'number') time = d.info.currentTime;
      if (typeof d.info.playerState === 'number' && d.info.playerState !== -1) playing = d.info.playerState === 1 || d.info.playerState === 3;
    } else if (d.event === 'onStateChange' && typeof d.info === 'number' && d.info !== -1) playing = d.info === 1 || d.info === 3;
  });

  dock.querySelector('[data-mp="close"]').addEventListener('click', () => api.close());
  dock.querySelector('[data-mp="return"]').addEventListener('click', () => api.returnToApp({ vid, time, playing }));

  // drag by the top bar, like the corner player: the window follows the pointer, to any place on any screen
  let drag = null;
  bar.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || e.target.closest('.mp-btn')) return;
    drag = { sx: e.screenX, sy: e.screenY, wx: window.screenX, wy: window.screenY };
    bar.setPointerCapture(e.pointerId);
    dock.classList.add('dragging');
  });
  bar.addEventListener('pointermove', (e) => {
    if (!drag) return;
    api.moveTo(Math.round(drag.wx + e.screenX - drag.sx), Math.round(drag.wy + e.screenY - drag.sy));
  });
  const end = (e) => { if (!drag) return; drag = null; dock.classList.remove('dragging'); try { bar.releasePointerCapture(e.pointerId); } catch { /* already released */ } };
  bar.addEventListener('pointerup', end);
  bar.addEventListener('pointercancel', end);

  // resize from any corner or edge, as in the app: the opposite corner / edge stays put
  dock.querySelectorAll('.mp-resize').forEach(handle => {
    const edge = handle.dataset.edge;
    const sx = edge.includes('l') ? -1 : edge.includes('r') ? 1 : 0;
    const sy = edge.includes('t') ? -1 : edge.includes('b') ? 1 : 0;
    let start = null;
    handle.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      start = { px: e.screenX, py: e.screenY, left: window.screenX + PAD, top: window.screenY + PAD, w: window.innerWidth - PAD * 2 };
      start.h = Math.round(start.w * 9 / 16);
      handle.setPointerCapture(e.pointerId);
      dock.classList.add('dragging');
      e.preventDefault();
    });
    handle.addEventListener('pointermove', (e) => {
      if (!start) return;
      const byX = (e.screenX - start.px) * sx;
      const byY = (e.screenY - start.py) * sy * (16 / 9);
      const grow = !sy ? byX : !sx ? byY : (Math.abs(byX) >= Math.abs(byY) ? byX : byY);
      const w = Math.round(Math.min(Math.max(start.w + grow, MIN_W), MAX_W));
      const h = Math.round(w * 9 / 16);
      const left = sx < 0 ? start.left + start.w - w : start.left;
      const top = sy < 0 ? start.top + start.h - h : start.top;
      api.resize({ x: left, y: top, width: w });
    });
    const end = (e) => { if (!start) return; start = null; dock.classList.remove('dragging'); try { handle.releasePointerCapture(e.pointerId); } catch { /* already released */ } };
    handle.addEventListener('pointerup', end);
    handle.addEventListener('pointercancel', end);
  });
  api.onRequestReturn(() => api.returnToApp({ vid, time, playing })); // the app is back: the player goes with it

  api.ready();
})();
