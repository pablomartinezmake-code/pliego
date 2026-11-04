const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { MAX_PDF } = require('./document-store.cjs');

const sha = b => crypto.createHash('sha256').update(b).digest('hex');
const bounded = (v, n, label) => { if (typeof v !== 'string' || v.length > n) throw new Error(`${label} debe ser texto de hasta ${n} caracteres.`); return v; };
function validateEntries(entries) {
  if (!Array.isArray(entries) || entries.length > 10000) throw new Error('Lista de anotaciones no válida.');
  const ids = new Set();
  return entries.map(e => {
    if (!e || !['bookmark','note'].includes(e.type) || !Number.isSafeInteger(e.page) || e.page < 1 || e.page > 1_000_000) throw new Error('Anotación no válida.');
    const id = bounded(e.id, 128, 'id'); if (!id || ids.has(id)) throw new Error('Los identificadores deben ser únicos.'); ids.add(id);
    if (!Array.isArray(e.rects) || e.rects.length > 100) throw new Error('Rectángulos no válidos.');
    const rects = e.rects.map(r => {
      if (!r || ![r.x,r.y,r.width,r.height].every(Number.isFinite) || r.x < 0 || r.y < 0 || r.width <= 0 || r.height <= 0 || r.x + r.width > 1 || r.y + r.height > 1) throw new Error('Rectángulo fuera de página.');
      return { x:r.x, y:r.y, width:r.width, height:r.height };
    });
    const createdAt = bounded(e.createdAt, 64, 'createdAt');
    return { id, type:e.type, page:e.page, title:bounded(e.title || '', 500, 'title'), quote:bounded(e.quote || '', 10000, 'quote'), note:bounded(e.note || '', 20000, 'note'), folio:e.folio == null ? null : bounded(e.folio, 200, 'folio'), rects, createdAt };
  });
}
class ResearchStore {
  constructor(userData, documentStore) { this.dir = path.join(userData, 'notebooks'); this.documentStore = documentStore; this.locks = new Map(); }
  async _identity({ path: p, revision }) {
    if (typeof revision !== 'string' || !/^[a-f0-9]{64}$/.test(revision)) throw new Error('Revisión PDF no válida.');
    const a = await this.documentStore._validate(p); if (path.extname(a).toLowerCase() !== '.pdf') throw new Error('Las notas solo están disponibles para PDF.');
    const data = await fs.readFile(a); if (data.length > MAX_PDF) throw new Error('El PDF supera el límite de 200 MiB.');
    const current = sha(data); if (current !== revision) throw new Error('El PDF cambió desde su apertura; no se aplicaron ni cargaron notas antiguas.');
    const canonical = await fs.realpath(a), key = sha(Buffer.from(`${canonical.toLowerCase()}\0${current}`));
    return { key, canonical, revision:current };
  }
  async _locked(key, action) {
    const prev = this.locks.get(key) || Promise.resolve(); let release;
    const hold = new Promise(r => { release = r; }), queued = prev.then(() => hold); this.locks.set(key, queued); await prev;
    try { return await action(); } finally { release(); if (this.locks.get(key) === queued) this.locks.delete(key); }
  }
  async getNotebook(request) {
    const id = await this._identity(request), file = path.join(this.dir, `${id.key}.json`);
    try { const saved = JSON.parse(await fs.readFile(file, 'utf8')); return { version:saved.version, entries:validateEntries(saved.entries) }; }
    catch (e) { if (e.code === 'ENOENT') return { version:0, entries:[] }; throw e; }
  }
  async saveNotebook({ path: p, revision, expectedVersion, entries }) {
    if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 0) throw new Error('Versión esperada no válida.');
    const id = await this._identity({ path:p, revision }), checked = validateEntries(entries), file = path.join(this.dir, `${id.key}.json`);
    return this._locked(id.key, async () => {
      const currentIdentity = await this._identity({ path:p, revision });
      if (currentIdentity.key !== id.key || currentIdentity.revision !== id.revision) throw new Error('El PDF cambió mientras se guardaban las notas. No se escribió el cuaderno.');
      let prior = { version:0, entries:[] }; try { prior = JSON.parse(await fs.readFile(file, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw e; }
      if (prior.version !== expectedVersion) throw new Error(`Conflicto de versión: se esperaba ${expectedVersion} y la versión actual es ${prior.version}.`);
      const result = { version:prior.version + 1, entries:checked }; await fs.mkdir(this.dir, { recursive:true });
      const tmp = `${file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
      try { await fs.writeFile(tmp, JSON.stringify(result, null, 2), { flag:'wx' }); await fs.rename(tmp, file); } finally { await fs.rm(tmp, { force:true }); }
      return result;
    });
  }
  async exportNotebook({ path:p, revision }) {
    const id = await this._identity({ path:p, revision }), notebook = await this.getNotebook({ path:p, revision });
    const lines = ['# Notas de lectura', '', `Documento: ${id.canonical}`, `SHA-256: ${id.revision}`, ''];
    for (const e of notebook.entries) {
      lines.push(`## ${e.title || (e.type === 'bookmark' ? 'Marcador' : 'Nota')}`, '', `- Tipo: ${e.type}`, `- HOJA PDF: ${e.page}`, `- Folio impreso: ${e.folio == null ? 'sin verificar' : e.folio}`);
      if (e.quote) lines.push('', 'Texto extraído del PDF; cotejar con la imagen antes de citar.', '', `> ${e.quote.replace(/\n/g, '\n> ')}`);
      if (e.note) lines.push('', e.note);
      lines.push('');
    }
    return lines.join('\n');
  }
}
module.exports = { ResearchStore, validateEntries };
