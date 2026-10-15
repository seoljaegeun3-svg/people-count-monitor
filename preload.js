const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('monitor', {
  settings: () => ipcRenderer.invoke('settings'),
  save: settings => ipcRenderer.invoke('save', settings),
  navigate: (panel, url) => ipcRenderer.invoke('navigate', panel, url),
  action: (panel, action) => ipcRenderer.invoke('action', panel, action),
  connect: enabled => ipcRenderer.invoke('connect', enabled),
  authenticate: input => ipcRenderer.invoke('camera-auth', input),
  onAuth: callback => ipcRenderer.on('camera-auth', (_event, data) => callback(data)),
  onAuthClosed: callback => ipcRenderer.on('camera-auth-closed', (_event, data) => callback(data)),
  layout: bounds => ipcRenderer.send('layout', bounds),
  onPLC: callback => ipcRenderer.on('plc', (_event, data) => callback(data)),
  onPage: callback => ipcRenderer.on('page', (_event, data) => callback(data))
});
