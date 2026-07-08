const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('api', {
  getStatus:      () => ipcRenderer.invoke('get-status'),
  runSync:        (folders) => ipcRenderer.invoke('run-sync', folders),
  createGame:     (name) => ipcRenderer.invoke('create-game', name),
  changeTemplate: () => ipcRenderer.invoke('change-template')
})
