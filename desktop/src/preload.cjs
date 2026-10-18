const { contextBridge, ipcRenderer } = require('electron');

// The bridge is available only to our packaged launcher, never to a dashboard.
if (location.protocol === 'pi-research:') {
  contextBridge.exposeInMainWorld('researchDesktop', {
    connect: (url) => ipcRenderer.invoke('research:connect', url),
    startLocal: () => ipcRenderer.invoke('research:start-local'),
    openLogs: () => ipcRenderer.invoke('research:open-logs'),
    getState: () => ipcRenderer.invoke('research:get-state'),
    onState: (listener) => {
      const handler = (_event, state) => listener(state);
      ipcRenderer.on('research:state', handler);
      return () => ipcRenderer.removeListener('research:state', handler);
    }
  });
}
