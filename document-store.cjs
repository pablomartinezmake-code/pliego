const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { hash } = require('./file-store.cjs');

const MAX_PDF = 200 * 1024 * 1024;
const TYPES = new Set(['md', 'markdown', 'txt', 'pdf', 'docx']);
const typeOf = p => { const ext = path.extname(p).slice(1).toLowerCase(); return ext === 'markdown' ? 'md' : ext; };
const keyOf = p => path.resolve(p).toLowerCase();
const safeJson = p => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return []; } };

class DocumentStore {
  constructor(userData, fileStore, { mammoth = require('mammoth') } = {}) {
    this.userData = userData; this.fileStore = fileStore; this.mammoth = mammoth;
    this.metaPath = path.join(userData, 'documents.json'); this.recentPath = path.join(userData, 'document-recent.json');
    const saved = safeJson(this.metaPath);
    this.authorized = new Map(); this.folderRoots = new Set();
    const rawFavorites = Array.isArray(saved) ? saved : (saved.favorites || []);
    this.favorites = Array.isArray(rawFavorites) ? rawFavorites.filter(x => x && typeof x.path === 'string' && path.isAbsolute(x.path) && typeof x.name === 'string' && (x.type === 'folder' || TYPES.has(x.type))) : [];
    const rawRecent = safeJson(this.recentPath);
    const persisted = Array.isArray(rawRecent) ? rawRecent.filter(x => x && typeof x.path === 'string' && path.isAbsolute(x.path) && TYPES.has(x.type) && typeof x.name === 'string') : [];
    const legacy = fileStore.getRecent().map(x => ({ ...x, type:'md' }));
    this.recent = this._mergeRecent([...persisted, ...legacy]);
  }
  _mergeRecent(items) { const seen = new Set(); return items.filter(x => { const k = keyOf(x.path); if (seen.has(k)) return false; seen.add(k); return true; }).slice(0,20); }
  async _recordRecent(p, type) {
    this.recent = this._mergeRecent([{ path:p, name:path.basename(p), type }, ...this.recent.filter(x => keyOf(x.path) !== keyOf(p))]);
    await fsp.mkdir(this.userData, { recursive:true });
    const tmp = `${this.recentPath}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
    try { await fsp.writeFile(tmp, JSON.stringify(this.recent, null, 2), { flag:'wx' }); await fsp.rename(tmp, this.recentPath); }
    finally { await fsp.rm(tmp, { force:true }); }
  }
  _authorize(p) { const a = path.resolve(p); this.authorized.set(keyOf(a), a); return a; }
  async _validate(p, { allowRecent = true, allowFolder = true } = {}) {
    if (typeof p !== 'string' || !path.isAbsolute(p) || !TYPES.has(path.extname(p).slice(1).toLowerCase())) throw new Error('Ruta de documento no autorizada.');
    const a = path.resolve(p), key = keyOf(a);
    const recent = allowRecent && (this.fileStore.getRecent().some(x => keyOf(x.path) === key) || this.recent.some(x => keyOf(x.path) === key));
    const folder = allowFolder && [...this.folderRoots].some(root => { const r = path.relative(root, a); return r !== '' && !r.startsWith('..') && !path.isAbsolute(r); });
    if (!this.authorized.has(key) && !recent && !folder && !this.favorites.some(x => x.path && keyOf(x.path) === key)) throw new Error('Primero abre el archivo, selecciona su carpeta o guárdalo como favorito desde Pliego.');
    const st = await fsp.lstat(a);
    if (st.isSymbolicLink() || !st.isFile()) throw new Error('No se admiten enlaces simbólicos ni archivos especiales.');
    if (keyOf(await fsp.realpath(a)) !== key) throw new Error('La ruta resuelve fuera del archivo autorizado.');
    return a;
  }
  async open(p) {
    const a = path.resolve(p), type = typeOf(a);
    if (!TYPES.has(path.extname(a).slice(1).toLowerCase())) throw new Error('Formato no compatible.');
    if (type === 'md') { const doc = await this.fileStore.open(a); this._authorize(a); await this._recordRecent(a, 'md'); return { ...doc, type: 'md' }; }
    const full = await this._validate(a, { allowRecent: false, allowFolder: false }).catch(async e => {
      // Opening via native picker or argv is an explicit user authorization.
      const st = await fsp.lstat(a); if (st.isSymbolicLink() || !st.isFile()) throw e;
      if (keyOf(await fsp.realpath(a)) !== keyOf(a)) throw e;
      return a;
    });
    const st = await fsp.stat(full); if (type === 'pdf' && st.size > MAX_PDF) throw new Error('El PDF supera el límite de 200 MiB.');
    const raw = await fsp.readFile(full), revision = hash(raw), base = { path: full, name: path.basename(full), type, revision };
    let doc;
    if (type === 'txt') doc = { ...base, text: new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(raw) };
    else if (type === 'pdf') { if (raw.length > MAX_PDF) throw new Error('El PDF supera el límite de 200 MiB.'); doc = { ...base, data: new Uint8Array(raw) }; }
    else {
      const input = { buffer: raw }, options = { externalFileAccess: false, styleMap: ["p[style-name='Title'] => h1:fresh", "p[style-name='Título'] => h1:fresh", "p[style-name='Heading 1'] => h2:fresh", "p[style-name='Heading 2'] => h3:fresh", "p[style-name='Heading 3'] => h4:fresh"] };
      const [html, text] = await Promise.all([this.mammoth.convertToHtml(input, options), this.mammoth.extractRawText(input, options)]);
      doc = { ...base, html: html.value, text: text.value, messages: [...(html.messages || []), ...(text.messages || [])].map(m => ({ type: String(m.type || ''), message: String(m.message || '') })) };
    }
    this._authorize(full); await this._recordRecent(full, type); return doc;
  }
  async read(p) { const a = await this._validate(p); return this.open(a); }
  async openDropped(p) { return this.open(p); }
  async listFolder(folder) {
    const st = await fsp.lstat(folder); if (st.isSymbolicLink() || !st.isDirectory()) throw new Error('La carpeta seleccionada no es válida.');
    const root = await fsp.realpath(folder); this.folderRoots.add(root); this.fileStore.folderRoots.add(root);
    const files = []; let visited = 0, truncated = false, warning = null;
    const walk = async dir => {
      if (truncated) return;
      let ents; try { ents = await fsp.readdir(dir, { withFileTypes: true }); } catch (e) { warning = warning || `No se pudo leer ${dir}: ${e.message}`; return; }
      for (const ent of ents) {
        if (++visited > 20000 || files.length >= 5000) { truncated = true; break; }
        if (ent.name.startsWith('.') || ['node_modules', '.git', 'release'].includes(ent.name.toLowerCase())) continue;
        const full = path.join(dir, ent.name); if (ent.isSymbolicLink()) continue;
        if (ent.isDirectory()) await walk(full);
        else if (ent.isFile() && TYPES.has(path.extname(ent.name).slice(1).toLowerCase())) {
          try { const s = await fsp.stat(full); files.push({ path: full, name: ent.name, type: typeOf(full), relativePath: path.relative(root, full), size: s.size, mtime: s.mtimeMs }); } catch (e) { warning = warning || e.message; }
        }
        if (truncated) break;
      }
    };
    await walk(root); files.sort((a,b) => a.relativePath.localeCompare(b.relativePath, undefined, { sensitivity: 'base' }));
    return { path: root, files, truncated, ...(warning ? { warning } : {}) };
  }
  async refreshFolder(root) { const a = path.resolve(root); if (!this.folderRoots.has(a) && ![...this.folderRoots].some(x => keyOf(x) === keyOf(a))) throw new Error('La carpeta no fue seleccionada en Pliego.'); return this.listFolder(a); }
  getFavorites() { return this.favorites.map(x => ({ ...x })); }
  async _saveFavorites() { await fsp.mkdir(this.userData, { recursive: true }); const tmp = `${this.metaPath}.${crypto.randomBytes(6).toString('hex')}.tmp`; try { await fsp.writeFile(tmp, JSON.stringify(this.favorites, null, 2), { flag: 'wx' }); await fsp.rename(tmp, this.metaPath); } finally { await fsp.rm(tmp, { force: true }); } }
  async toggleFavorite({ path: p, type } = {}) {
    if (typeof p !== 'string' || !path.isAbsolute(p)) throw new Error('Favorito no válido.');
    const a = path.resolve(p), i = this.favorites.findIndex(x => keyOf(x.path) === keyOf(a));
    if (i >= 0) { this.favorites.splice(i, 1); await this._saveFavorites(); return this.getFavorites(); }
    const st = await fsp.lstat(a); if (st.isSymbolicLink() || (type === 'folder' ? !st.isDirectory() : !st.isFile())) throw new Error('El favorito no corresponde a un archivo o carpeta válido.');
    const isFolder = type === 'folder';
    if (!isFolder) await this._validate(a);
    else if (!this.folderRoots.has(await fsp.realpath(a))) throw new Error('La carpeta debe seleccionarse antes de guardarla como favorita.');
    const fav = { path: a, name: path.basename(a), type: isFolder ? 'folder' : typeOf(a) };
    this.favorites.unshift(fav);
    await this._saveFavorites(); return this.getFavorites();
  }
  async selectFavoriteFolder(p) { if (!this.favorites.some(x => x.type === 'folder' && keyOf(x.path) === keyOf(p))) throw new Error('La carpeta no está guardada como favorita.'); return this.listFolder(p); }
  async getRecent() { return this._mergeRecent([...this.recent, ...this.fileStore.getRecent().map(x => ({ ...x, type:'md' }))]); }
  async assetUrl(docPath, relative) { const a = await this._validate(docPath); return this.fileStore.assetUrl(a, relative); }
}
module.exports = { DocumentStore, MAX_PDF, typeOf };
