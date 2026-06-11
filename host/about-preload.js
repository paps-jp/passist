'use strict';
// PAssistについて(about) ウィンドウ専用 preload。
// メインの preload とは別の最小APIだけを露出する（about 専用機能のみ）。
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('about', {
  getInfo: () => ipcRenderer.invoke('about:info'),
  fetchServer: (signalWs) => ipcRenderer.invoke('about:fetch-server', signalWs),
  cosignVerify: (registry, digest) => ipcRenderer.invoke('about:cosign-verify', { registry, digest }),
  openExternal: (url) => ipcRenderer.invoke('about:open-external', url),
});
