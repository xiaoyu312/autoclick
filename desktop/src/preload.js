'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const api = {
  getState: () => ipcRenderer.invoke('app:get-state'),
  getLogs: () => ipcRenderer.invoke('app:get-logs'),
  openTarget: (url) => ipcRenderer.invoke('app:open-target', url),
  showTarget: () => ipcRenderer.invoke('app:show-target'),
  selectTarget: () => ipcRenderer.invoke('app:select-target'),
  start: (intervalSeconds) => ipcRenderer.invoke('app:start', intervalSeconds),
  stop: () => ipcRenderer.invoke('app:stop'),
  resetCount: () => ipcRenderer.invoke('app:reset-count'),
  exportLogs: () => ipcRenderer.invoke('app:export-logs'),
  onState: (callback) => {
    if (typeof callback !== 'function') return () => {};
    const listener = (_event, value) => callback(value);
    ipcRenderer.on('app:state', listener);
    return () => ipcRenderer.removeListener('app:state', listener);
  }
};

contextBridge.exposeInMainWorld('autoClickDesktop', api);
