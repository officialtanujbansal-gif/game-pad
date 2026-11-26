const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('omniSyncBridge', Object.freeze({
  setPairingPin(pin) {
    return ipcRenderer.invoke('omnisync:receiver:set-pin', String(pin || ''));
  },
}));
