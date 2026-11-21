// The floating player window: the same player as the corner one, kept on top of everything and movable anywhere on any screen.
(() => {
  const api = window.aredlMini;
  const dock = document.querySelector('.video-dock');
  const frame = dock.querySelector('iframe');
  const bar = dock.querySelector('.mp-bar');
  let vid = null, time = 0, playing = false, pingTimer = null;

  const post = (obj) => { try { frame.contentWindow.postMessage(JSON.stringify(obj), '*'); } catch { /* not ready */ } };
  const listen = () => post({ event: 'listening', id: 1, channel: 'widget' });

  api.onInit((d) => {
    document.documentElement.style.cssText = d.rootCss || '';
    document.body.style.cssText = d.bodyCss || '';
    document.body.className = d.bodyClass || '';
    dock.querySelector('.mp-title').textContent = d.title || '';
    vid = d.vid; time = Number(d.time) || 0; playing = !!d.playing;
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

  api.ready();
})();
