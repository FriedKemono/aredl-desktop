// Preload for the player window: a tiny, fixed set of calls to the main process.
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('aredlMini', {
  onInit: (cb) => ipcRenderer.on('mini:init', (_e, d) => cb(d)),
  onCmd: (cb) => ipcRenderer.on('mini:cmd', (_e, c) => cb(c)),
  onPlace: (cb) => ipcRenderer.on('mini:place', (_e, p) => cb(p)),
  state: (st) => ipcRenderer.send('mini:state', st),
  close: () => ipcRenderer.send('mini:close-self'),
  returnToApp: () => ipcRenderer.send('mini:return'),
  hideKeep: () => ipcRenderer.send('mini:hide-keep'),
  gesture: (g) => ipcRenderer.send('mini:gesture', g),
  gestureEnd: () => ipcRenderer.send('mini:gestureEnd'),
  ready: () => ipcRenderer.send('mini:ready'),
  onGlide: (cb) => ipcRenderer.on('mini:glide', (_e, g) => cb(g)),
  placed: () => ipcRenderer.send('mini:placed'),
  onGlideGo: (cb) => ipcRenderer.on('mini:glideGo', () => cb()),
  glideDone: () => ipcRenderer.send('mini:glideDone'),
});
