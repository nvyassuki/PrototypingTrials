const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('floatnote', {
  send: (channel, data) => {
    const allowed = ['notes:save', 'window:hide', 'window:collapse', 'window:expand', 'clipboard:skip', 'shell:open'];
    if (allowed.includes(channel)) ipcRenderer.send(channel, data);
  },
  receive: (channel, callback) => {
    const allowed = ['notes:loaded', 'clipboard:new', 'window:state', 'whisper:ready', 'whisper:transcript'];
    if (allowed.includes(channel)) ipcRenderer.on(channel, (_, ...args) => callback(...args));
  },
});
