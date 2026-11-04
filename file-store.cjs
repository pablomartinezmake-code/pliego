const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

function hash(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }
function decode(buf, filePath) {
  const bom = buf.length >= 3 && buf.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]));
  try { return { text: new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bom ? buf.subarray(3) : buf), bom }; }
  catch { throw new Error(`El archivo no contiene UTF-8 válido: ${filePath}`); }
}
function eolOf(text) { const m = text.match(/\r\n|\n|\r/); return m ? m[0] : '\n'; }
function isMarkdown(p) { return /\.(?:md|markdown)$/i.test(p); }
function folded(p) { return path.resolve(p).toLowerCase(); }

class FileStore {
  constructor(userData) {
    this.userData = userData;
    this.recentPath = path.join(userData, 'recent.json');
    this.authorized = new Map();
    this.folderRoots = new Set();
    this.locks = new Map();
    this.recent = [];
    this._loadRecent();
  }
  _loadRecent() {
    try { this.recent = JSON.parse(fs.readFileSync(this.recentPath, 'utf8')).filter(isMarkdown).slice(0, 20); }
    catch { this.recent = []; }
  }
  async _writeRecent() {
    return this._withLock('recent', async () => {
      await fsp.mkdir(this.userData, { recursive: true });
      const tmp = `${this.recentPath}.${process.pid}.${crypto.randomBytes(5).toString('hex')}.tmp`;
      try { await fsp.writeFile(tmp, JSON.stringify(this.recent, null, 2), { flag: 'wx' }); await fsp.rename(tmp, this.recentPath); }
      finally { await fsp.rm(tmp, { force: true }); }
    });
  }
  async _withLock(key, action) {
    const prior = this.locks.get(key) || Promise.resolve();
    let release;
    const current = new Promise(resolve => { release = resolve; });
    const queued = prior.then(() => current);
    this.locks.set(key, queued);
    await prior;
    try { return await action(); }
    finally { release(); if (this.locks.get(key) === queued) this.locks.delete(key); }
  }
  _authorize(p) { this.authorized.set(folded(p), path.resolve(p)); }
  async _validate(p, allowFolder = true) {
    if (typeof p !== 'string' || !path.isAbsolute(p) || !isMarkdown(p)) throw new Error('Ruta Markdown no autorizada.');
    const absolute = path.resolve(p), key = folded(absolute);
    if (!this.authorized.has(key)) {
      const fromRecent = this.recent.some(x => folded(x) === key);
      const fromFolder = allowFolder && [...this.folderRoots].some(root => {
        const rel = path.relative(root, absolute);
        return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
      });
      if (!fromRecent && !fromFolder) throw new Error('Primero abrí el archivo o seleccioná su carpeta desde Pliego.');
    }
    const st = await fsp.lstat(absolute);
    if (st.isSymbolicLink() || !st.isFile()) throw new Error('No se admiten enlaces simbólicos ni archivos especiales.');
    const real = await fsp.realpath(absolute);
    if (folded(real) !== key) throw new Error('La ruta resuelve fuera del archivo autorizado.');
    return absolute;
  }
  async read(p) {
    const absolute = await this._validate(p);
    const raw = await fsp.readFile(absolute), decoded = decode(raw, absolute);
    const text = decoded.text;
    this._authorize(absolute);
    this.recent = [absolute, ...this.recent.filter(x => folded(x) !== folded(absolute))].slice(0, 20);
    await this._writeRecent();
    return { path: absolute, name: path.basename(absolute), text, revision: hash(raw), eol: eolOf(text), bom: decoded.bom };
  }
  async open(p) { this._authorize(p); return this.read(p); }
  async listFolder(folder) {
    const root = await fsp.realpath(folder), st = await fsp.lstat(folder);
    if (st.isSymbolicLink() || !st.isDirectory()) throw new Error('La carpeta seleccionada no es válida.');
    this.folderRoots.add(root);
    const files = [];
    const walk = async dir => {
      if (files.length >= 1000) return;
      for (const ent of await fsp.readdir(dir, { withFileTypes: true })) {
        if (files.length >= 1000) break;
        if (ent.name.startsWith('.') || ['node_modules', '.git'].includes(ent.name)) continue;
        const full = path.join(dir, ent.name);
        if (ent.isSymbolicLink()) continue;
        if (ent.isDirectory()) await walk(full);
        else if (ent.isFile() && isMarkdown(full)) files.push({ name: ent.name, path: full });
      }
    };
    await walk(root);
    return { path: root, files };
  }
  getRecent() { return this.recent.map(p => ({ name: path.basename(p), path: p })); }
  async save(payload) {
    const target = payload && payload.path;
    if (!target) return null;
    return this._withLock(folded(target), () => this._saveUnlocked(payload));
  }
  async _saveUnlocked({ path: target, text, revision, saveAs = false }) {
    if (typeof text !== 'string') throw new Error('El contenido debe ser texto.');
    if (saveAs || !target) return null; // main process must obtain a native Save dialog destination
    target = await this._validate(target, false);
    const current = await fsp.readFile(target);
    if (hash(current) !== revision) throw new Error('El archivo cambió fuera de Pliego. No se guardó para evitar sobrescribir esos cambios; volvé a abrirlo y compará.');
    const meta = decode(current, target);
    const unchanged = text === meta.text;
    const normalized = unchanged ? meta.text : text.replace(/\r\n|\r|\n/g, meta.eol || eolOf(meta.text));
    const out = unchanged ? current : Buffer.concat([meta.bom ? Buffer.from([0xef, 0xbb, 0xbf]) : Buffer.alloc(0), Buffer.from(normalized, 'utf8')]);
    const backups = path.join(this.userData, 'backups');
    await fsp.mkdir(backups, { recursive: true });
    const backupName = `${hash(Buffer.from(target)).slice(0, 16)}-${hash(current)}.bak`;
    const backup = path.join(backups, backupName);
    try { await fsp.copyFile(target, backup, fs.constants.COPYFILE_EXCL); } catch (e) { if (e.code !== 'EEXIST') throw e; }
    const tmp = path.join(path.dirname(target), `.${path.basename(target)}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`);
    try {
      await fsp.writeFile(tmp, out, { flag: 'wx' });
      const latest = await fsp.readFile(target);
      if (hash(latest) !== revision) throw new Error('El archivo cambió durante el guardado; no se aplicaron cambios.');
      await fsp.rename(tmp, target);
    } finally { await fsp.rm(tmp, { force: true }); }
    return this.read(target);
  }
  async saveAs(target, text, expectedRevision, sourceMeta = {}) {
    if (!isMarkdown(target) || typeof text !== 'string') throw new Error('Destino Markdown no válido.');
    const absolute = path.resolve(target);
    return this._withLock(folded(absolute), async () => {
    try {
      const st = await fsp.lstat(absolute);
      if (st.isSymbolicLink() || !st.isFile()) throw new Error('No se puede guardar sobre un enlace o archivo especial.');
      // Existing files must be opened explicitly before Save As may replace them.
      if (!this.authorized.has(folded(absolute))) throw new Error('Abrí primero el archivo existente antes de reemplazarlo.');
      const doc = await this.read(absolute);
      if (expectedRevision && doc.revision !== expectedRevision) throw new Error('El archivo cambió fuera de Pliego. No se guardó para evitar sobrescribir esos cambios; volvé a abrirlo y compará.');
      return this._saveUnlocked({ path: absolute, text, revision: doc.revision });
    } catch (e) { if (e.code !== 'ENOENT') throw e; }
    const tmp = path.join(path.dirname(absolute), `.${path.basename(absolute)}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`);
    const eol = sourceMeta.eol || eolOf(text);
    const normalized = text.replace(/\r\n|\r|\n/g, eol);
    const bytes = Buffer.concat([sourceMeta.bom ? Buffer.from([0xef, 0xbb, 0xbf]) : Buffer.alloc(0), Buffer.from(normalized, 'utf8')]);
    try {
      await fsp.writeFile(tmp, bytes, { flag: 'wx' });
      try { await fsp.lstat(absolute); throw new Error('El archivo de destino apareció durante el guardado.'); }
      catch (e) { if (e.code !== 'ENOENT') throw e; }
      await fsp.rename(tmp, absolute);
    }
    finally { await fsp.rm(tmp, { force: true }); }
    this._authorize(absolute);
    return this.read(absolute);
    });
  }
  async assetUrl(docPath, relative) {
    if (typeof relative !== 'string' || /^[a-z][a-z\d+.-]*:/i.test(relative) || path.isAbsolute(relative)) return null;
    let decodedRelative;
    try { decodedRelative = decodeURIComponent(relative); } catch { return null; }
    if (/\.(?:png|jpe?g|gif|webp|avif|bmp|svg)$/i.test(decodedRelative) === false) return null;
    const authorizedDoc = await this._validate(docPath);
    const docDir = path.dirname(authorizedDoc);
    const target = path.resolve(docDir, decodedRelative);
    const rel = path.relative(docDir, target);
    if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
    try {
      const st = await fsp.lstat(target);
      if (st.isSymbolicLink() || !st.isFile()) return null;
      const realTarget = await fsp.realpath(target), realDir = await fsp.realpath(docDir);
      const realRel = path.relative(realDir, realTarget);
      if (realRel.startsWith('..') || path.isAbsolute(realRel)) return null;
      return require('node:url').pathToFileURL(realTarget).href;
    }
    catch { return null; }
  }
}

module.exports = { FileStore, hash, decode };
