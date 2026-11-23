const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  list: () => ipcRenderer.invoke('storms:list'),
  save: (id, text, mtime) => ipcRenderer.invoke('storms:save', id, text, mtime),
  saveSync: (id, text, mtime) => ipcRenderer.sendSync('storms:saveSync', id, text, mtime),
  remove: (id) => ipcRenderer.invoke('storms:remove', id),
  copy: (text) => ipcRenderer.invoke('clipboard:write', text),
  wallpaper: () => ipcRenderer.invoke('wallpaper:get'),
  chooseWallpaper: () => ipcRenderer.invoke('wallpaper:choose'),
  clearWallpaper: () => ipcRenderer.invoke('wallpaper:clear'),
  onMenu: (fn) => ipcRenderer.on('menu', (_e, action) => fn(action)),
});
