const { app, BrowserWindow, Menu, dialog, ipcMain, shell, session } = require('electron');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const crypto = require('node:crypto');
const path = require('node:path');
const { FileStore } = require('./file-store.cjs');
const { DocumentStore } = require('./document-store.cjs');
const { ResearchStore } = require('./research-store.cjs');

let win, store, documents, research, dirty = false, pendingClose = false, allowClose = false, initialDocument = null, initialReferenceDocument = null;

function sendCommand(command) { if (win && !win.isDestroyed()) win.webContents.send('pliego:command', command); }
function senderIsWindow(event) { return !!win && event.sender === win.webContents && event.senderFrame === win.webContents.mainFrame && !win.isDestroyed(); }
function handle(channel, fn) {
  ipcMain.handle(channel, async (event, ...args) => {
    if (!senderIsWindow(event)) throw new Error('Solicitud de una ventana no autorizada.');
    return fn(...args);
  });
}

async function chooseAndOpen(options = {}) {
  const pdfOnly = options && options.type === 'pdf';
  const textOnly = options && options.type === 'text';
  const result = await dialog.showOpenDialog(win, { title: pdfOnly || textOnly ? 'Abrir un segundo documento al lado' : 'Abrir en el panel principal', buttonLabel: pdfOnly || textOnly ? 'Abrir al lado' : 'Abrir aquí', properties: ['openFile'], filters: pdfOnly ? [{ name:'PDF', extensions:['pdf'] }] : [{ name: textOnly ? 'Textos' : 'Documentos', extensions:textOnly ? ['md','markdown','txt','docx'] : ['md','markdown','txt','pdf','docx'] }] });
  if (result.canceled || !result.filePaths[0]) return null;
  return documents.open(result.filePaths[0]);
}
async function chooseFolder() {
  const result = await dialog.showOpenDialog(win, { properties: ['openDirectory'] });
  if (result.canceled || !result.filePaths[0]) return null;
  return documents.listFolder(result.filePaths[0]);
}
async function saveAs(payload) {
  const result = await dialog.showSaveDialog(win, { defaultPath: payload.path || 'sin-titulo.md', filters: [{ name: 'Markdown', extensions: ['md'] }], properties: ['createDirectory'] });
  if (result.canceled || !result.filePath) return null;
  const samePath = payload.path && path.resolve(payload.path).toLowerCase() === path.resolve(result.filePath).toLowerCase();
  return store.saveAs(result.filePath, payload.text, samePath ? payload.revision : undefined, { eol: payload.eol, bom: payload.bom });
}
function sendSaveClose() { pendingClose = true; sendCommand('save-close'); }
function maybeClose() { if (pendingClose && !dirty && win && !win.isDestroyed()) { pendingClose = false; allowClose = true; win.destroy(); } }
function buildMenu() {
  const template = [
    { label: 'Archivo', submenu: [
      { label: 'Nuevo', accelerator: 'CmdOrCtrl+N', click: () => sendCommand('new') },
      { label: 'Abrir…', accelerator: 'CmdOrCtrl+O', click: () => sendCommand('open') },
      { label: 'Abrir carpeta…', accelerator: 'CmdOrCtrl+Shift+O', click: () => sendCommand('folder') },
      { label: 'Abrir al lado (dos documentos)…', accelerator: 'CmdOrCtrl+Alt+O', click: () => sendCommand('compare-text') },
      { type: 'separator' },
      { label: 'Guardar', accelerator: 'CmdOrCtrl+S', click: () => sendCommand('save') },
      { label: 'Guardar como…', accelerator: 'CmdOrCtrl+Shift+S', click: () => sendCommand('saveAs') },
      { type: 'separator' }, { role: 'quit', label: 'Salir' },
    ] },
    { label: 'Editar', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }, { type: 'separator' }, { label: 'Buscar', accelerator: 'CmdOrCtrl+F', click: () => sendCommand('find') }] },
    { label: 'Ver', submenu: [
      { label: 'Lectura', accelerator: 'CmdOrCtrl+1', click: () => sendCommand('mode-read') },
      { label: 'Dividido', accelerator: 'CmdOrCtrl+2', click: () => sendCommand('mode-split') },
      { label: 'Edición', accelerator: 'CmdOrCtrl+3', click: () => sendCommand('mode-edit') },
      { type: 'separator' }, { role: 'toggleDevTools' }, { role: 'togglefullscreen' },
    ] },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
function showError(error) { if (win) dialog.showMessageBox(win, { type: 'error', title: 'Pliego', message: error.message || String(error), buttons: ['Aceptar'] }); }
function confirmClose() {
  if (!dirty) { allowClose = true; win.destroy(); return; }
  dialog.showMessageBox(win, { type: 'warning', title: 'Cambios sin guardar', message: 'Hay cambios pendientes en los documentos abiertos. ¿Querés guardarlos antes de cerrar?', buttons: ['Guardar', 'Descartar', 'Cancelar'], defaultId: 0, cancelId: 2, noLink: true }).then(({ response }) => {
    if (response === 0) sendSaveClose();
    else if (response === 1) { pendingClose = false; dirty = false; allowClose = true; win.destroy(); }
  });
}
function createWindow() {
  win = new BrowserWindow({ width: 1180, height: 820, minWidth: 760, minHeight: 520, title: 'Pliego', autoHideMenuBar: true, backgroundColor: '#f5f4f1', webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false } });
  win.loadFile(path.join(__dirname, 'dist', 'index.html'));
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', event => event.preventDefault());
  win.on('close', event => { if (allowClose) return; event.preventDefault(); confirmClose(); });
}

app.setName('Pliego');
if (process.env.PLIEGO_TEST_USER_DATA) app.setPath('userData', process.env.PLIEGO_TEST_USER_DATA);
const ownsInstance = app.requestSingleInstanceLock();
if (!ownsInstance) app.quit();
app.on('second-instance', async (_event, argv) => {
  if (!win || win.isDestroyed()) return;
  if (win.isMinimized()) win.restore();
  win.show(); win.focus();
  const paths = argv.slice(1).filter(arg => /\.(?:md|markdown|txt|pdf|docx)$/i.test(arg));
  if (!paths.length) return;
  try {
    const primary = await documents.open(path.resolve(paths[0]));
    const reference = paths[1] && primary.type !== 'pdf' ? await documents.open(path.resolve(paths[1])) : null;
    if (reference && reference.type !== 'pdf') win.webContents.send('pliego:open-pair', { primary, reference });
    else win.webContents.send('pliego:open-document', primary);
  } catch (error) { showError(error); }
});

if (ownsInstance) app.whenReady().then(async () => {
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  session.defaultSession.setPermissionCheckHandler(() => false);
  store = new FileStore(app.getPath('userData'));
  documents = new DocumentStore(app.getPath('userData'), store); research = new ResearchStore(app.getPath('userData'), documents);
  handle('pliego:open-file', chooseAndOpen);
  handle('pliego:open-pdf', () => chooseAndOpen({ type:'pdf' }));
  handle('pliego:open-folder', chooseFolder);
  handle('pliego:read-file', p => documents.read(p));
  handle('pliego:refresh-folder', p => documents.refreshFolder(p));
  handle('pliego:open-dropped', async p => documents.openDropped(p));
  handle('pliego:save-file', async payload => {
    if (!payload || typeof payload.text !== 'string') throw new Error('Solicitud de guardado no válida.');
    try {
      if (payload.type && payload.type !== 'md') throw new Error('Solo se pueden guardar documentos Markdown.');
      const doc = payload.saveAs || !payload.path ? await saveAs(payload) : await store.save(payload);
      if (doc) await documents._recordRecent(doc.path, 'md');
      if (!doc && pendingClose) pendingClose = false;
      return doc ? { ...doc, type:'md' } : doc;
    } catch (error) { if (pendingClose) pendingClose = false; throw error; }
  });
  handle('pliego:get-recent', () => documents.getRecent());
  handle('pliego:get-initial-document', () => { const doc = initialDocument; initialDocument = null; return doc; });
  handle('pliego:get-initial-reference-document', () => { const doc = initialReferenceDocument; initialReferenceDocument = null; return doc; });
  handle('pliego:open-external', async url => {
    if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) return false;
    const { response } = await dialog.showMessageBox(win, { type: 'question', title: 'Abrir enlace externo', message: `¿Querés abrir este enlace en el navegador?\n${url}`, buttons: ['Abrir', 'Cancelar'], defaultId: 1, cancelId: 1, noLink: true });
    if (response !== 0) return false;
    await shell.openExternal(url); return true;
  });
  handle('pliego:asset-url', (docPath, relative) => documents.assetUrl(docPath, relative));
  handle('pliego:get-favorites', () => documents.getFavorites());
  handle('pliego:toggle-favorite', value => documents.toggleFavorite(value));
  handle('pliego:select-favorite-folder', p => documents.selectFavoriteFolder(p));
  handle('pliego:get-notebook', value => research.getNotebook(value));
  handle('pliego:save-notebook', async value => {
    try { return await research.saveNotebook(value); }
    catch (error) { if (pendingClose) pendingClose = false; throw error; }
  });
  handle('pliego:export-notebook', async value => {
    const markdown = await research.exportNotebook(value);
    const result = await dialog.showSaveDialog(win, { defaultPath:`${path.basename(value.path, path.extname(value.path))}-notas.md`, filters:[{name:'Markdown',extensions:['md']}], properties:['createDirectory'] });
    if (result.canceled || !result.filePath) return null;
    let dest = result.filePath; if (!/\.md$/i.test(dest)) dest += '.md';
    if (path.resolve(dest).toLowerCase() === path.resolve(value.path).toLowerCase()) throw new Error('El destino no puede ser el PDF original.');
    let existing = false;
    try {
      const st = await fs.lstat(dest);
      if (st.isSymbolicLink() || !st.isFile()) throw new Error('El destino de exportación debe ser un archivo normal, no un enlace ni una carpeta.');
      existing = true;
    } catch (e) { if (e.code !== 'ENOENT') throw e; }
    if (existing) {
      const backup = `${dest}.${Date.now()}.${crypto.randomBytes(4).toString('hex')}.bak`;
      await fs.copyFile(dest, backup, fsSync.constants.COPYFILE_EXCL);
    }
    const tmp = path.join(path.dirname(dest), `.${path.basename(dest)}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`);
    try { await fs.writeFile(tmp, markdown, { encoding:'utf8', flag:'wx' }); await fs.rename(tmp, dest); }
    finally { await fs.rm(tmp, { force:true }); }
    return dest;
  });
  ipcMain.on('pliego:set-dirty', (event, value) => { if (senderIsWindow(event)) { dirty = Boolean(value); if (!dirty) maybeClose(); } });
  ipcMain.on('pliego:cancel-close', event => { if (senderIsWindow(event)) pendingClose = false; });
  const argPaths = process.argv.slice(1).filter(a => /\.(?:md|markdown|txt|pdf|docx)$/i.test(a));
  if (argPaths[0]) { try { initialDocument = await documents.open(path.resolve(argPaths[0])); } catch (e) { showError(e); } }
  if (argPaths[1] && initialDocument && initialDocument.type !== 'pdf') { try { const second = await documents.open(path.resolve(argPaths[1])); if (second.type !== 'pdf') initialReferenceDocument = second; } catch (e) { showError(e); } }
  buildMenu(); createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
