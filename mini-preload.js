// Preload for the floating player window: a tiny, fixed set of calls to the main process.
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('aredlMini', {
  onInit: (cb) => ipcRenderer.on('mini:init', (_e, d) => cb(d)),
  close: () => ipcRenderer.send('mini:close-self'),
  returnToApp: (state) => ipcRenderer.send('mini:return', state),
  moveTo: (x, y) => ipcRenderer.send('mini:move', x, y),
  ready: () => ipcRenderer.send('mini:ready'),
});
