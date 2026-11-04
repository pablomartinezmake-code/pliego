import { PdfPane } from './pdf-pane.js';

const el = (tag, className, text) => { const node = document.createElement(tag); if (className) node.className = className; if (text !== undefined) node.textContent = text; return node; };

export class PdfWorkspace {
  constructor({ container, api, onDirty, onStatus, onOutline, onError }) {
    Object.assign(this, { container, api, onDirty, onStatus, onOutline, onError });
    this.notebook = { version: 0, entries: [] }; this.selection = null; this.editId = null; this.saving = false; this.draftDirty = false; this.loadToken = 0;
    container.innerHTML = `<div class="pdf-desk-toolbar"><span class="eyebrow">LECTURA PDF</span><span class="pdf-original-label">Original intacto · notas en tu cuaderno</span><button id="pdf-compare">Dos documentos</button><button id="pdf-notes-toggle" aria-pressed="true">Cuaderno</button><button id="pdf-export">Exportar fichas…</button></div>
      <div class="pdf-desk-body"><div class="pdf-readers"><section class="pdf-primary"><div class="pdf-document-label" id="pdf-primary-name"></div><div class="pdf-primary-view"></div></section><section class="pdf-secondary" hidden><div class="pdf-document-label"><span id="pdf-secondary-name"></span><button id="pdf-compare-close" aria-label="Cerrar documento de referencia">×</button></div><div class="pdf-secondary-view"></div></section></div>
      <aside class="pdf-notebook" aria-label="Cuaderno de lectura"><div class="notebook-heading"><h2>Cuaderno</h2><span id="notebook-count"></span></div><p class="notebook-hint">Seleccioná un pasaje del documento principal para citarlo, o anotá la hoja que estás leyendo.</p>
      <div class="notebook-actions"><button id="pdf-new-note">＋ Nota de hoja</button><button id="pdf-new-bookmark">☆ Marcador</button></div>
      <form id="pdf-note-form" hidden><div class="note-location" id="pdf-note-location"></div><label for="pdf-note-title">Título</label><input id="pdf-note-title" maxlength="300" placeholder="Una idea para volver"><label for="pdf-note-quote">Pasaje seleccionado</label><textarea id="pdf-note-quote" rows="3" readonly placeholder="Nota de hoja, sin cita textual"></textarea><p class="quote-caution">El texto extraído puede contener errores. Cotejalo con la imagen antes de citar.</p><label for="pdf-note-folio">Folio impreso <span>opcional, leído en esta hoja</span></label><input id="pdf-note-folio" maxlength="100" placeholder="Sin verificar"><label for="pdf-note-comment">Tu nota</label><textarea id="pdf-note-comment" rows="4" maxlength="20000" placeholder="¿Qué querés conservar de esta lectura?"></textarea><div class="note-form-actions"><button type="button" id="pdf-note-cancel">Cancelar</button><button type="submit" id="pdf-note-save" class="save">Guardar nota</button></div></form>
      <form id="pdf-bookmark-form" hidden><label for="pdf-bookmark-name">Nombre del marcador</label><input id="pdf-bookmark-name" maxlength="300" placeholder="Volver a esta hoja"><div class="note-form-actions"><button type="button" id="pdf-bookmark-cancel">Cancelar</button><button type="submit" class="save">Guardar marcador</button></div></form>
      <div id="notebook-entries"></div><p class="notebook-storage">Guardado local. Las notas quedan vinculadas a esta versión del PDF.</p></aside></div>`;
    this.q = selector => container.querySelector(selector);
    this.primary = new PdfPane({
      container: this.q('.pdf-primary-view'),
      onPage: (page, total) => { this.onStatus?.(`Hoja PDF ${page} de ${total}`); this.updateLocation(); },
      onSelection: selection => { if (selection?.quote) this.offerSelection(selection); },
      onOutline: outline => this.onOutline?.(outline.map(item => ({ ...item, go: () => this.primary.goTo(item.page) }))),
      onError: message => this.onError?.(message),
    });
    this.q('#pdf-compare').onclick = () => this.compare();
    this.q('#pdf-compare-close').onclick = () => this.closeCompare();
    this.q('#pdf-notes-toggle').onclick = () => { const hidden = this.q('.pdf-notebook').classList.toggle('notebook-hidden'); this.q('#pdf-notes-toggle').setAttribute('aria-pressed', !hidden); };
    this.q('#pdf-export').onclick = () => this.export();
    this.q('#pdf-new-note').onclick = () => this.startNote();
    this.q('#pdf-new-bookmark').onclick = () => this.startBookmark();
    this.q('#pdf-note-cancel').onclick = () => this.cancelDraft();
    this.q('#pdf-bookmark-cancel').onclick = () => this.cancelDraft();
    this.q('#pdf-note-form').onsubmit = event => { event.preventDefault(); this.saveDraft(); };
    this.q('#pdf-bookmark-form').onsubmit = event => { event.preventDefault(); this.saveDraft(); };
    for (const input of container.querySelectorAll('#pdf-note-form input,#pdf-note-form textarea:not([readonly]),#pdf-bookmark-form input')) input.oninput = () => this.setDraftDirty(true);
  }
  get dirty() { return this.draftDirty; }
  setDraftDirty(value) { this.draftDirty = value; this.onDirty?.(value); }
  async load(doc) {
    const token = ++this.loadToken; this.doc = doc; this.selection = null; this.editId = null;
    this.q('#pdf-primary-name').textContent = doc.name;
    this.cancelDraft();
    this.notebook = await this.api.getNotebook({ path: doc.path, revision: doc.revision });
    if (token !== this.loadToken) return;
    this.renderEntries(); await this.primary.load(doc); this.primary.setHighlights(this.notebook.entries);
  }
  updateLocation() {
    const page = this.draftPage || this.primary.page || 1;
    this.q('#pdf-note-location').textContent = `Hoja PDF ${page} · ${this.doc?.name || ''}`;
  }
  offerSelection(selection) {
    if (this.draftDirty) return;
    if (selection.quote.length > 10000 || selection.rects.length > 100) { this.onError?.('Elegí un pasaje más breve para la ficha (hasta 10.000 caracteres y 100 líneas).'); return; }
    this.selection = selection;
    this.startNote(selection);
  }
  startNote(selection = null, entry = null) {
    if (this.draftDirty && !entry) { this.onError?.('Guardá o cancelá la nota que estás escribiendo antes de empezar otra.'); return; }
    this.q('.pdf-notebook').classList.remove('notebook-hidden'); this.q('#pdf-notes-toggle').setAttribute('aria-pressed', 'true');
    this.q('#pdf-note-form').hidden = false; this.q('#pdf-bookmark-form').hidden = true;
    this.editId = entry?.id || null; this.draftType = 'note'; this.draftPage = entry?.page || selection?.page || this.primary.page || 1;
    this.selection = selection || (entry ? { page: entry.page, quote: entry.quote, rects: entry.rects } : null);
    this.q('#pdf-note-title').value = entry?.title || '';
    this.q('#pdf-note-quote').value = this.selection?.quote || '';
    this.q('#pdf-note-folio').value = entry?.folio || '';
    this.q('#pdf-note-comment').value = entry?.note || '';
    this.updateLocation(); this.setDraftDirty(false);
    if (!selection) this.q('#pdf-note-title').focus();
  }
  startBookmark(entry = null) {
    if (this.draftDirty) { this.onError?.('Guardá o cancelá la nota pendiente antes de crear un marcador.'); return; }
    this.q('#pdf-note-form').hidden = true; this.q('#pdf-bookmark-form').hidden = false;
    this.draftType = 'bookmark'; this.editId = entry?.id || null; this.draftPage = entry?.page || this.primary.page || 1;
    this.q('#pdf-bookmark-name').value = entry?.title || `Hoja ${this.draftPage}`;
    this.setDraftDirty(true); this.q('#pdf-bookmark-name').focus();
  }
  cancelDraft() {
    this.q('#pdf-note-form').hidden = true; this.q('#pdf-bookmark-form').hidden = true;
    this.editId = null; this.selection = null; this.draftPage = null; this.draftType = null;
    this.setDraftDirty(false); this.primary?.clearSelection();
  }
  async saveDraft() {
    if (this.saving) return false;
    if (!this.draftType) return true;
    const bookmark = this.draftType === 'bookmark';
    const old = this.notebook.entries.find(entry => entry.id === this.editId);
    const entry = {
      id: this.editId || crypto.randomUUID(), type: bookmark ? 'bookmark' : 'note', page: this.draftPage || this.primary.page || 1,
      title: (bookmark ? this.q('#pdf-bookmark-name').value : this.q('#pdf-note-title').value).trim() || (bookmark ? 'Marcador' : 'Nota de lectura'),
      quote: bookmark ? '' : this.q('#pdf-note-quote').value,
      note: bookmark ? '' : this.q('#pdf-note-comment').value,
      folio: bookmark ? null : this.q('#pdf-note-folio').value.trim() || null,
      rects: bookmark ? [] : this.selection?.rects || [], createdAt: old?.createdAt || new Date().toISOString(),
    };
    const entries = old ? this.notebook.entries.map(item => item.id === old.id ? entry : item) : [...this.notebook.entries, entry];
    this.saving = true;
    try {
      this.notebook = await this.api.saveNotebook({ path: this.doc.path, revision: this.doc.revision, expectedVersion: this.notebook.version, entries });
      this.cancelDraft(); this.renderEntries(); this.primary.setHighlights(this.notebook.entries); this.onStatus?.('Cuaderno guardado'); return true;
    } catch (error) { this.onError?.(error.message); return false; } finally { this.saving = false; }
  }
  renderEntries() {
    const list = this.q('#notebook-entries'); list.replaceChildren();
    this.q('#notebook-count').textContent = `${this.notebook.entries.length}`;
    if (!this.notebook.entries.length) { list.append(el('p', 'notebook-empty', 'Una lectura empieza sin marcas. Guardá acá los lugares a los que quieras volver.')); return; }
    for (const entry of [...this.notebook.entries].sort((a, b) => a.page - b.page || a.createdAt.localeCompare(b.createdAt))) {
      const card = el('section', 'notebook-entry'); card.dataset.entryId = entry.id;
      const location = el('button', 'entry-location', `${entry.type === 'bookmark' ? '☆ ' : ''}Hoja PDF ${entry.page}${entry.folio ? ` · folio ${entry.folio}` : ''}`);
      location.onclick = () => this.primary.goTo(entry.page); card.append(location, el('h3', '', entry.title));
      if (entry.quote) card.append(el('blockquote', '', entry.quote));
      if (entry.note) card.append(el('p', 'entry-comment', entry.note));
      const actions = el('div', 'entry-actions');
      const edit = el('button', '', 'Editar'); edit.onclick = () => {
        if (this.draftDirty) { this.onError?.('Guardá o cancelá la nota pendiente.'); return; }
        if (entry.type === 'bookmark') this.startBookmark(entry); else this.startNote(null, entry);
      };
      const remove = el('button', '', 'Eliminar'); remove.onclick = async () => {
        if (this.draftDirty) { this.onError?.('Guardá o cancelá la nota pendiente antes de eliminar otra.'); return; }
        if (!confirm(`¿Eliminar «${entry.title}» del cuaderno?`)) return;
        try { this.notebook = await this.api.saveNotebook({ path: this.doc.path, revision: this.doc.revision, expectedVersion: this.notebook.version, entries: this.notebook.entries.filter(item => item.id !== entry.id) }); this.renderEntries(); this.primary.setHighlights(this.notebook.entries); } catch (error) { this.onError?.(error.message); }
      };
      actions.append(edit, remove); card.append(actions); list.append(card);
    }
  }
  async compare() {
    try {
      const doc = await this.api.openFile({ type: 'pdf' }); if (!doc) return;
      if (doc.type !== 'pdf') throw new Error('Elegí un PDF como documento de referencia.');
      this.closeCompare(); this.q('.pdf-secondary').hidden = false; this.q('.pdf-readers').classList.add('comparing');
      this.notesBeforeCompare = !this.q('.pdf-notebook').classList.contains('notebook-hidden');
      this.q('.pdf-notebook').classList.add('notebook-hidden'); this.q('#pdf-notes-toggle').setAttribute('aria-pressed', 'false');
      this.q('#pdf-secondary-name').textContent = `${doc.name} · referencia`;
      this.secondary = new PdfPane({ container: this.q('.pdf-secondary-view'), onError: message => this.onError?.(message) });
      await this.secondary.load(doc); this.q('#pdf-compare').textContent = 'Cambiar referencia';
    } catch (error) { this.onError?.(error.message); }
  }
  closeCompare() {
    this.secondary?.destroy(); this.secondary = null; this.q('.pdf-secondary-view').replaceChildren();
    this.q('.pdf-secondary').hidden = true; this.q('.pdf-readers').classList.remove('comparing'); this.q('#pdf-compare').textContent = 'Dos documentos';
    if (this.notesBeforeCompare) { this.q('.pdf-notebook').classList.remove('notebook-hidden'); this.q('#pdf-notes-toggle').setAttribute('aria-pressed', 'true'); }
    this.notesBeforeCompare = false;
  }
  async export() {
    if (this.draftDirty) { this.onError?.('Guardá primero la nota pendiente para incluirla en la exportación.'); return; }
    try { const result = await this.api.exportNotebook({ path: this.doc.path, revision: this.doc.revision }); if (result) this.onStatus?.('Fichas exportadas a Markdown'); } catch (error) { this.onError?.(error.message); }
  }
  find() { this.primary.focusSearch(); }
  destroy() { this.loadToken++; this.primary.destroy(); this.secondary?.destroy(); this.container.replaceChildren(); }
}
