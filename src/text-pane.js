import { EditorView, basicSetup } from 'codemirror';
import { EditorState } from '@codemirror/state';
import { keymap } from '@codemirror/view';
import { markdown } from '@codemirror/lang-markdown';
import { openSearchPanel } from '@codemirror/search';
import { Marked } from 'marked';
import DOMPurify from 'dompurify';
import markedFootnote from 'marked-footnote';

const parser = new Marked();
parser.use(markedFootnote({ description: 'Notas', backRefLabel: 'Volver al texto' }));

const el = (tag, cls, text) => {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
};
const btn = (text, title, action) => {
  const node = el('button', '', text);
  node.type = 'button'; node.title = title; node.setAttribute('aria-label', title);
  node.dataset.action = action;
  return node;
};

export class TextPane {
  constructor({ container, api, onDirty, onSaved, onClose, onReplace, onError } = {}) {
    if (!container) throw new TypeError('TextPane necesita un contenedor.');
    this.container = container; this.api = api;
    this.callbacks = { onDirty, onSaved, onClose, onReplace, onError };
    this._doc = null; this.baseline = ''; this._dirty = false; this.destroyed = false;
    this.renderVersion = 0; this.searchHits = []; this.searchIndex = -1;
    this.root = el('section', 'text-reference-pane');
    this.root.setAttribute('aria-label', 'Segundo documento');
    this.root.innerHTML = `
      <header class="text-reference-toolbar">
        <div class="text-reference-identity"><span class="text-reference-dot" data-role="dot" hidden>●</span><div class="text-reference-title" data-role="title">Sin documento</div><div class="text-reference-path" data-role="path"></div></div>
        <div class="text-reference-actions"><button type="button" data-action="replace">Cambiar…</button><button type="button" data-action="toggle" aria-pressed="false">Editar</button><button type="button" data-action="save" class="text-reference-save">Guardar</button><button type="button" data-action="save-as">Guardar como…</button><button type="button" data-action="close" aria-label="Cerrar segundo documento" title="Cerrar segundo documento">×</button></div>
      </header>
      <div class="text-reference-find" data-role="find" hidden><input type="search" data-role="query" placeholder="Buscar en este texto" aria-label="Buscar en este texto"><span data-role="count" aria-live="polite"></span><button type="button" data-action="find-prev" aria-label="Coincidencia anterior" title="Coincidencia anterior">↑</button><button type="button" data-action="find-next" aria-label="Coincidencia siguiente" title="Coincidencia siguiente">↓</button><button type="button" data-action="find-close" aria-label="Cerrar búsqueda" title="Cerrar búsqueda">×</button></div>
      <div class="text-reference-reader" data-role="reader" tabindex="0" aria-label="Lectura del segundo documento"><article class="prose" data-role="prose"></article></div>
      <div class="text-reference-editor" data-role="editor"></div>`;
    this.container.replaceChildren(this.root);
    this.title = this.root.querySelector('[data-role=title]'); this.path = this.root.querySelector('[data-role=path]');
    this.dot = this.root.querySelector('[data-role=dot]'); this.reader = this.root.querySelector('[data-role=reader]');
    this.prose = this.root.querySelector('[data-role=prose]'); this.editorHost = this.root.querySelector('[data-role=editor]');
    this.findBar = this.root.querySelector('[data-role=find]'); this.query = this.root.querySelector('[data-role=query]');
    this.findCount = this.root.querySelector('[data-role=count]');
    this.toggleButton = this.root.querySelector('[data-action=toggle]'); this.saveButton = this.root.querySelector('[data-action=save]');
    this.mode = 'read';
    this.view = new EditorView({ state: this.createState(''), parent: this.editorHost });
    this.root.addEventListener('click', event => this.handleClick(event));
    this.root.addEventListener('keydown', event => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f') { event.preventDefault(); event.stopPropagation(); this.focusSearch(); }
      if (event.key === 'Escape' && !this.findBar.hidden) this.closeSearch();
      if (event.key === 'Enter' && event.target === this.query) { event.preventDefault(); this.stepSearch(event.shiftKey ? -1 : 1); }
    });
    this.query.addEventListener('input', () => this.searchReading());
    this.reader.addEventListener('dblclick', event => this.openAtBlock(event));
    this.reader.addEventListener('click', event => this.handleReaderLink(event));
  }

  get dirty() { return this._dirty; }
  get doc() { return this._doc; }

  createState(text) {
    return EditorState.create({ doc: text, extensions: [basicSetup, markdown(), EditorView.lineWrapping,
      keymap.of([{ key: 'Mod-b', run: () => this.wrapSelection('**') }, { key: 'Mod-i', run: () => this.wrapSelection('*') }]),
      EditorView.updateListener.of(update => { if (!update.docChanged) return; this.updateDirty(this.view.state.doc.toString() !== this.baseline); this.scheduleRender(); }),
      EditorView.contentAttributes.of({ 'aria-label': 'Segundo texto Markdown', spellcheck: 'true', lang: 'es' }),
    ] });
  }

  wrapSelection(marker) {
    const selection = this.view.state.selection.main;
    this.view.dispatch({ changes: [{ from: selection.from, insert: marker }, { from: selection.to, insert: marker }], selection: { anchor: selection.from + marker.length, head: selection.to + marker.length } });
    this.view.focus(); return true;
  }

  updateDirty(value) {
    if (this._dirty === value) return;
    this._dirty = value; this.dot.hidden = !value;
    this.saveButton.disabled = !this._doc || this._doc.type !== 'md';
    this.callbacks.onDirty?.(value, this);
  }

  scheduleRender() {
    clearTimeout(this.renderTimer);
    this.renderTimer = setTimeout(() => this.render(), 150);
  }

  async load(doc) {
    if (!doc || !['md', 'txt', 'docx'].includes(doc.type)) throw new TypeError('El panel admite Markdown, texto y Word.');
    this._doc = { ...doc };
    this.baseline = String(doc.text ?? '').replace(/\r\n?/g, '\n');
    this.view.setState(this.createState(this.baseline));
    this.updateDirty(false);
    this.root.dataset.mode = 'read'; this.mode = 'read';
    this.root.dataset.type = doc.type;
    this.toggleButton.hidden = doc.type !== 'md'; this.toggleButton.setAttribute('aria-pressed', 'false');
    this.saveButton.disabled = doc.type !== 'md';
    this.title.textContent = doc.name || 'Documento'; this.title.title = doc.name || '';
    this.path.textContent = doc.path || ''; this.path.title = doc.path || '';
    this.reader.scrollTop = 0; this.view.scrollDOM.scrollTop = 0;
    this.render();
  }

  async render() {
    if (!this._doc || this.destroyed) return;
    const version = ++this.renderVersion;
    const text = this._doc.type === 'md' ? this.view.state.doc.toString() : String(this._doc.text ?? '');
    let html = '';
    const front = this._doc.type === 'md' && text.match(/^\uFEFF?---\n[\s\S]*?\n(?:---|\.\.\.)(?:\n|$)/);
    const bodyOffset = front ? front[0].length : 0;
    if (front) {
      const box = el('pre', 'frontmatter', front[0].trim()); html = box.outerHTML;
    }
    if (this._doc.type === 'docx') html += this._doc.html || '';
    else if (this._doc.type === 'txt') { const pre = el('div', 'plain-text'); pre.textContent = text; html += pre.outerHTML; }
    else html += await parser.parse(text.slice(bodyOffset), { gfm: true });
    if (version !== this.renderVersion || this.destroyed) return;
    this.prose.innerHTML = DOMPurify.sanitize(html, { USE_PROFILES: { html: true }, FORBID_TAGS: ['style', 'form', 'input', 'button', 'textarea', 'iframe', 'object', 'embed', 'script'], FORBID_ATTR: ['style'] });
    if (this._doc.type === 'md') {
      let sourceOffset = bodyOffset;
      const offsets = [];
      for (const token of parser.lexer(text.slice(bodyOffset), { gfm: true })) {
        if (token.type !== 'space' && token.type !== 'def') offsets.push(sourceOffset);
        sourceOffset += token.raw.length;
      }
      const blocks = [...this.prose.children].filter(node => !node.classList.contains('frontmatter'));
      blocks.forEach((node, index) => { if (offsets[index] !== undefined) node.dataset.sourceOffset = String(offsets[index]); });
    }
    for (const img of this.prose.querySelectorAll('img')) {
      const relative = img.getAttribute('src'); img.removeAttribute('src');
      if (relative?.startsWith('data:image/') && !relative.startsWith('data:image/svg')) img.src = relative;
      else if (this._doc.path && relative && !/^[a-z][a-z\d+.-]*:/i.test(relative) && !relative.startsWith('//') && this.api?.assetUrl) {
        const path = this._doc.path;
        try { const url = await this.api.assetUrl(path, relative); if (url && path === this._doc?.path && img.isConnected && version === this.renderVersion) img.src = url; } catch { /* unresolved local image remains omitted */ }
      }
      img.loading = 'lazy';
    }
    if (!this.findBar.hidden) this.searchReading();
  }

  handleClick(event) {
    const action = event.target.closest('[data-action]')?.dataset.action;
    if (!action) return;
    if (action === 'replace') this.callbacks.onReplace?.(this);
    else if (action === 'close') this.callbacks.onClose?.(this);
    else if (action === 'toggle') this.setMode(this.mode === 'read' ? 'edit' : 'read');
    else if (action === 'save') this.save(false);
    else if (action === 'save-as') this.save(true);
    else if (action === 'find-next') this.stepSearch(1);
    else if (action === 'find-prev') this.stepSearch(-1);
    else if (action === 'find-close') this.closeSearch();
  }

  setMode(mode) {
    if (!this._doc || this._doc.type !== 'md') return;
    this.mode = mode; this.root.dataset.mode = mode;
    this.toggleButton.textContent = mode === 'read' ? 'Editar' : 'Leer';
    this.toggleButton.setAttribute('aria-pressed', String(mode === 'edit'));
    if (mode === 'edit') { this.view.requestMeasure(); this.view.focus(); }
  }

  async save(saveAs = false) {
    if (!this._doc || this._doc.type !== 'md') return true;
    if (!this.api?.saveFile) { this.callbacks.onError?.(new Error('No está disponible el guardado nativo.'), this); return false; }
    if (!saveAs && !this.dirty) return true;
    if (this.saving) return false;
    this.saving = true; this.saveButton.disabled = true;
    const snapshot = this.view.state.doc.toString();
    try {
      const result = await this.api.saveFile({ path: this._doc.path, text: snapshot, revision: this._doc.revision, saveAs, bom: this._doc.bom, eol: this._doc.eol, type: 'md' });
      if (!result) return false;
      this._doc = { ...this._doc, ...result };
      this.baseline = snapshot;
      this.updateDirty(this.view.state.doc.toString() !== snapshot);
      this.title.textContent = this._doc.name || result.name || 'Documento'; this.path.textContent = this._doc.path || '';
      this.callbacks.onSaved?.(this._doc, this);
      return !this.dirty;
    } catch (error) { this.callbacks.onError?.(error, this); return false; }
    finally { this.saving = false; this.saveButton.disabled = !this._doc || this._doc.type !== 'md'; }
  }

  focusSearch() {
    if (!this._doc) return;
    if (this.mode === 'edit' && this._doc.type === 'md') { openSearchPanel(this.view); return; }
    this.findBar.hidden = false; this.query.focus(); this.query.select(); this.searchReading();
  }

  closeSearch() { this.findBar.hidden = true; this.clearSearch(); this.reader.focus(); }
  clearSearch() { this.searchHits = []; this.searchIndex = -1; if (CSS.highlights) CSS.highlights.delete('text-reference-matches'); }
  searchReading() {
    this.clearSearch(); const query = this.query.value.trim();
    if (!query || !CSS.highlights || !window.Highlight) { this.findCount.textContent = query ? 'Búsqueda no disponible' : ''; return; }
    const walker = document.createTreeWalker(this.prose, NodeFilter.SHOW_TEXT);
    const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); const regex = new RegExp(escaped, 'giu'); let node;
    while ((node = walker.nextNode())) { for (const match of node.textContent.matchAll(regex)) { const range = new Range(); range.setStart(node, match.index); range.setEnd(node, match.index + match[0].length); this.searchHits.push(range); } }
    CSS.highlights.set('text-reference-matches', new Highlight(...this.searchHits));
    this.searchIndex = this.searchHits.length ? 0 : -1;
    this.findCount.textContent = this.searchHits.length ? `1 de ${this.searchHits.length}` : 'Sin resultados';
    if (this.searchHits.length) this.searchHits[0].startContainer.parentElement?.scrollIntoView({ block: 'nearest' });
  }
  stepSearch(delta) {
    if (!this.searchHits.length) return;
    this.searchIndex = (this.searchIndex + delta + this.searchHits.length) % this.searchHits.length;
    const range = this.searchHits[this.searchIndex]; range.startContainer.parentElement?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    this.findCount.textContent = `${this.searchIndex + 1} de ${this.searchHits.length}`;
  }

  handleReaderLink(event) {
    const link = event.target.closest('a'); if (!link) return;
    const href = link.getAttribute('href') || '';
    if (/^https?:\/\//i.test(href)) { event.preventDefault(); this.api?.openExternal?.(href); return; }
    if (href.startsWith('#')) {
      let targetId;
      try { targetId = decodeURIComponent(href.slice(1)); } catch { event.preventDefault(); return; }
      const target = this.prose.querySelector(`#${CSS.escape(targetId)}`);
      if (target) { event.preventDefault(); target.scrollIntoView({ block: 'center', behavior: 'smooth' }); }
      else event.preventDefault();
    } else event.preventDefault();
  }

  openAtBlock(event) {
    if (!this._doc || this._doc.type !== 'md') return;
    const block = event.target.closest('p,h1,h2,h3,h4,h5,h6,blockquote,li,pre,table');
    const source = block?.dataset.sourceOffset;
    if (source !== undefined) this.view.dispatch({ selection: { anchor: Math.min(Number(source), this.view.state.doc.length) }, scrollIntoView: true });
    this.setMode('edit');
  }

  containsFocus() { return this.root.contains(document.activeElement); }
  destroy() { this.destroyed = true; clearTimeout(this.renderTimer); this.clearSearch(); this.view.destroy(); this.root.remove(); }
}
