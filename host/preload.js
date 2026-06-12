'use strict';
const { contextBridge, ipcRenderer } = require('electron');

// レンダラ(WebRTC を扱う Chromium 側)へ最小限の API だけ公開する。
contextBridge.exposeInMainWorld('host', {
  listWindows: () => ipcRenderer.invoke('windows:list'),
  selectSource: (id, name) => ipcRenderer.invoke('capture:select', { id, name }),
  getConfig: () => ipcRenderer.invoke('config:get'),
  qrMake: (text) => ipcRenderer.invoke('qr:make', text),
  sendInput: (ev) => ipcRenderer.send('input:event', ev),
  focusTarget: () => ipcRenderer.invoke('input:focus'),
  readSelectedText: () => ipcRenderer.invoke('input:readSelected'),
  trustCheck: (auth) => ipcRenderer.invoke('trust:check', auth),
  trustIssue: (label) => ipcRenderer.invoke('trust:issue', label),
  trustList: () => ipcRenderer.invoke('trust:list'),
  trustRemove: (clientId) => ipcRenderer.invoke('trust:remove', clientId),
  trustClear: () => ipcRenderer.invoke('trust:clear'),
  settingsGet: () => ipcRenderer.invoke('settings:get'),
  settingsSet: (patch) => ipcRenderer.invoke('settings:set', patch),
  onClipHost: (cb) => ipcRenderer.on('clip:host', (_e, text) => cb(text)),
  clipSet: (text) => ipcRenderer.send('clip:set', text),
  onThemePalette: (cb) => ipcRenderer.on('theme:palette', (_e, p) => cb(p)),
  cursorTrack: (on) => ipcRenderer.send('cursor:track', on),
  onCursorShape: (cb) => ipcRenderer.on('cursor:shape', (_e, s) => cb(s)),
  // === MCP (AI アシスタント連携) ===
  // main → renderer のリクエスト (mcp:get-share-state / mcp:start-share / mcp:end-share)
  // を購読し、 同じ _reqId を付けて 'mcp:renderer-reply' で結果を返す。
  onMcpRequest: (cb) => {
    ipcRenderer.on('mcp:get-share-state', (_e, payload) => cb('get-share-state', payload));
    ipcRenderer.on('mcp:start-share', (_e, payload) => cb('start-share', payload));
    ipcRenderer.on('mcp:end-share', (_e, payload) => cb('end-share', payload));
  },
  replyMcp: (reqId, result, error) => ipcRenderer.send('mcp:renderer-reply', { _reqId: reqId, result, error }),
});
