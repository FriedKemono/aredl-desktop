// Preload for the floating player window: a tiny, fixed set of calls to the main process.
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('aredlMini', {
  onInit: (cb) => ipcRenderer.on('mini:init', (_e, d) => cb(d)),
  onGo: (cb) => ipcRenderer.on('mini:go', (_e, g) => cb(g)),
  primed: () => ipcRenderer.send('mini:primed'),
  close: () => ipcRenderer.send('mini:close-self'),
  returnToApp: (state) => ipcRenderer.send('mini:return', state),
  gesture: (g) => ipcRenderer.send('mini:gesture', g),
  gestureEnd: () => ipcRenderer.send('mini:gestureEnd'),
  onRequestReturn: (cb) => ipcRenderer.on('mini:requestReturn', (_e, quiet) => cb(quiet === true)),
  ready: () => ipcRenderer.send('mini:ready'),
  onGlide: (cb) => ipcRenderer.on('mini:glide', (_e, g) => cb(g)),
  onGlideGo: (cb) => ipcRenderer.on('mini:glideGo', () => cb()),
  onSettle: (cb) => ipcRenderer.on('mini:settle', () => cb()),
  glideDone: () => ipcRenderer.send('mini:glideDone'),
});
