const { contextBridge, ipcRenderer, webUtils } = require('electron');

function subscribe(channel, callback) {
  if (typeof callback !== 'function') throw new TypeError('Se requiere una función.');
  const listener = (_event, value) => callback(value);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld('pliego', {
  openFile: options => ipcRenderer.invoke('pliego:open-file', options),
  openPdf: () => ipcRenderer.invoke('pliego:open-pdf'),
  openDroppedFile: file => {
    const path = webUtils.getPathForFile(file);
    return path ? ipcRenderer.invoke('pliego:open-dropped', path) : Promise.reject(new Error('No se pudo identificar el archivo arrastrado.'));
  },
  openFolder: () => ipcRenderer.invoke('pliego:open-folder'),
  readFile: path => ipcRenderer.invoke('pliego:read-file', path),
  refreshFolder: path => ipcRenderer.invoke('pliego:refresh-folder', path),
  saveFile: payload => ipcRenderer.invoke('pliego:save-file', payload),
  getRecent: () => ipcRenderer.invoke('pliego:get-recent'),
  getFavorites: () => ipcRenderer.invoke('pliego:get-favorites'),
  toggleFavorite: value => ipcRenderer.invoke('pliego:toggle-favorite', value),
  selectFavoriteFolder: path => ipcRenderer.invoke('pliego:select-favorite-folder', path),
  getNotebook: value => ipcRenderer.invoke('pliego:get-notebook', value),
  saveNotebook: value => ipcRenderer.invoke('pliego:save-notebook', value),
  exportNotebook: value => ipcRenderer.invoke('pliego:export-notebook', value),
  setDirty: dirty => ipcRenderer.send('pliego:set-dirty', Boolean(dirty)),
  cancelClose: () => ipcRenderer.send('pliego:cancel-close'),
  onCommand: callback => subscribe('pliego:command', callback),
  onOpenDocument: callback => subscribe('pliego:open-document', callback),
  onOpenPair: callback => subscribe('pliego:open-pair', callback),
  getInitialDocument: () => ipcRenderer.invoke('pliego:get-initial-document'),
  getInitialReferenceDocument: () => ipcRenderer.invoke('pliego:get-initial-reference-document'),
  openExternal: url => ipcRenderer.invoke('pliego:open-external', url),
  assetUrl: (docPath, relative) => ipcRenderer.invoke('pliego:asset-url', docPath, relative),
});
