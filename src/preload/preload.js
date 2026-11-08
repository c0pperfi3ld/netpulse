'use strict';
/**
 * Preload bridge. The renderer gets exactly this surface and nothing else:
 * no Node, no arbitrary IPC channel names, no child processes.
 */
const { contextBridge, ipcRenderer } = require('electron');

const EVENT_CHANNELS = [
  'np:snapshot',
  'np:event',
  'np:env',
  'np:test-phase',
  'np:test-progress',
  'np:ramp-step',
  'np:window-state',
  'np:gadget',
  'np:qa-view',
];

contextBridge.exposeInMainWorld('netpulse', {
  snapshot: () => ipcRenderer.invoke('np:snapshot'),
  setSettings: (patch) => ipcRenderer.invoke('np:settings:set', patch),
  runTest: (kind, opts) => ipcRenderer.invoke('np:test:run', { kind, opts }),
  setPaused: (paused) => ipcRenderer.invoke('np:pause', paused),
  history: (opts) => ipcRenderer.invoke('np:history', opts),
  exportReport: () => ipcRenderer.invoke('np:report:export'),
  previewReport: () => ipcRenderer.invoke('np:report:preview'),
  applyMtuFix: () => ipcRenderer.invoke('np:mtu:apply'),
  revertMtu: () => ipcRenderer.invoke('np:mtu:revert'),
  openPath: (p) => ipcRenderer.invoke('np:open', p),
  dataStats: () => ipcRenderer.invoke('np:data-stats'),
  copyText: (t) => ipcRenderer.invoke('np:clipboard', t),
  windowAction: (action) => ipcRenderer.send('np:window', action),
  setGadget: (on) => ipcRenderer.invoke('np:gadget', on),
  setGadgetSize: (size) => ipcRenderer.invoke('np:gadget:size', size),
  setGadgetPin: (on) => ipcRenderer.invoke('np:gadget:pin', on),
  setTheme: (theme) => ipcRenderer.send('np:theme', theme),
  on: (channel, cb) => {
    if (!EVENT_CHANNELS.includes(channel)) return () => {};
    const handler = (_e, payload) => cb(payload);
    ipcRenderer.on(channel, handler);
    return () => ipcRenderer.removeListener(channel, handler);
  },
  platform: process.platform,
  versions: {
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
  },
});
