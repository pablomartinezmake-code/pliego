import { getDocument, GlobalWorkerOptions, TextLayer } from 'pdfjs-dist/build/pdf.mjs';

const ZOOMS = [50, 75, 100, 125, 150, 200];
const SEARCH_PAGE_LIMIT = 3000;

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function button(label, title, className = '') {
  const node = element('button', className, label);
  node.type = 'button';
  node.title = title;
  node.setAttribute('aria-label', title);
  return node;
}

function flattenOutline(items, depth = 0, output = []) {
  for (const item of items || []) {
    output.push({ title: item.title || 'Sin título', dest: item.dest, depth });
    flattenOutline(item.items, depth + 1, output);
  }
  return output;
}

export class PdfPane {
  constructor({ container, onPage, onSelection, onError, onOutline, onReady } = {}) {
    if (!container) throw new TypeError('PdfPane necesita un contenedor.');
    this.container = container;
    this.callbacks = { onPage, onSelection, onError, onOutline, onReady };
    this.pdf = null;
    this.currentPage = 1;
    this.scale = 1;
    this.fitWidth = true;
    this.loadingTask = null;
    this.renderTask = null;
    this.textLayer = null;
    this.renderVersion = 0;
    this.searchVersion = 0;
    this.searchHits = [];
    this.searchIndex = -1;
    this.lastSearchQuery = '';
    this.searchStatus = '';
    this.lastSelection = null;
    this.highlights = [];
    this.destroyed = false;
    this.readyCalled = false;

    GlobalWorkerOptions.workerSrc = new URL('./pdf-assets/pdf.worker.min.mjs', document.baseURI).href;
    this.root = element('section', 'pdf-pane');
    this.root.setAttribute('aria-label', 'Lector de PDF');
    this.root.innerHTML = `
      <div class="pdf-toolbar" role="toolbar" aria-label="Controles del PDF">
        <div class="pdf-navigation">
          <button type="button" data-action="previous" title="Hoja anterior" aria-label="Hoja anterior">‹</button>
          <label class="pdf-page-label"><input data-role="page" type="number" min="1" value="1" aria-label="Hoja actual"><span data-role="page-total">/ —</span></label>
          <button type="button" data-action="next" title="Hoja siguiente" aria-label="Hoja siguiente">›</button>
        </div>
        <select data-role="zoom" aria-label="Zoom"></select>
        <button type="button" data-action="fit" title="Ajustar al ancho" aria-label="Ajustar al ancho">↔</button>
        <label class="pdf-search-label"><input data-role="search" type="search" placeholder="Buscar en el PDF" aria-label="Buscar en el PDF"><button type="button" data-action="search-next" title="Siguiente resultado" aria-label="Siguiente resultado">⌕</button></label>
        <span class="pdf-status" data-role="status" aria-live="polite">Abre un PDF para empezar.</span>
      </div>
      <div class="pdf-viewport" data-role="viewport" tabindex="0" aria-label="Página del PDF">
        <div class="pdf-page-stack" data-role="stack"></div>
      </div>
      <div class="pdf-selection-note" data-role="selection-note">Selecciona texto para crear una nota.</div>`;
    this.container.replaceChildren(this.root);
    this.viewport = this.root.querySelector('[data-role="viewport"]');
    this.stack = this.root.querySelector('[data-role="stack"]');
    this.pageInput = this.root.querySelector('[data-role="page"]');
    this.pageTotal = this.root.querySelector('[data-role="page-total"]');
    this.zoomSelect = this.root.querySelector('[data-role="zoom"]');
    this.searchInput = this.root.querySelector('[data-role="search"]');
    this.status = this.root.querySelector('[data-role="status"]');
    this.selectionNote = this.root.querySelector('[data-role="selection-note"]');
    this.lastViewportWidth = this.viewport.clientWidth;
    for (const zoom of ZOOMS) {
      const option = element('option', '', `${zoom}%`);
      option.value = String(zoom);
      this.zoomSelect.append(option);
    }
    this.zoomSelect.value = '100';
    this.bind();
    this.resizeObserver = new ResizeObserver(() => {
      const width = this.viewport.clientWidth;
      const changed = Math.abs(width - this.lastViewportWidth) > 1;
      this.lastViewportWidth = width;
      if (changed && this.fitWidth && this.pdf && this.readyCalled) this.scheduleFit();
    });
    this.resizeObserver.observe(this.viewport);
  }

  bind() {
    this.root.addEventListener('click', event => {
      const action = event.target.closest('[data-action]')?.dataset.action;
      if (action === 'previous') this.goTo(this.currentPage - 1);
      if (action === 'next') this.goTo(this.currentPage + 1);
      if (action === 'fit') { this.fitWidth = true; this.scheduleFit(); }
      if (action === 'search-next') this.runSearchFromButton();
    });
    this.pageInput.addEventListener('change', () => this.goTo(Number(this.pageInput.value)));
    this.pageInput.addEventListener('keydown', event => {
      if (event.key === 'Enter') { event.preventDefault(); this.goTo(Number(this.pageInput.value)); }
    });
    this.zoomSelect.addEventListener('change', () => {
      this.fitWidth = false;
      this.scale = Number(this.zoomSelect.value) / 100;
      this.renderCurrentPage();
    });
    this.searchInput.addEventListener('keydown', event => {
      if (event.key === 'Enter') {
        event.preventDefault();
        const query = this.searchInput.value.trim();
        if (query && query.toLocaleLowerCase() === this.lastSearchQuery && this.searchHits.length) this.nextSearchHit();
        else this.search(query).then(() => this.nextSearchHit());
      }
      if (event.key === 'Escape') { this.searchInput.value = ''; this.clearSearch(); }
    });
    this.root.addEventListener('mouseup', () => this.captureSelection());
    this.root.addEventListener('keyup', event => {
      if (['Shift', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) this.captureSelection();
    });
    this.root.addEventListener('keydown', event => {
      if (event.target.matches('input,select,button') || event.shiftKey || event.ctrlKey || event.altKey || event.metaKey) return;
      if (event.key === 'PageDown' || event.key === 'ArrowRight') { event.preventDefault(); this.goTo(this.currentPage + 1); }
      if (event.key === 'PageUp' || event.key === 'ArrowLeft') { event.preventDefault(); this.goTo(this.currentPage - 1); }
    });
  }

  get page() { return this.currentPage; }
  get numPages() { return this.pdf?.numPages || 0; }
  get document() { return this.pdf; }

  async load(doc) {
    this.destroyed = false;
    const version = ++this.renderVersion;
    this.cancelRender();
    this.loadingTask?.destroy();
    this.pdf?.destroy?.();
    this.pdf = null;
    this.lastSelection = null;
    this.highlights = [];
    this.searchVersion++;
    this.searchHits = [];
    this.searchIndex = -1;
    this.lastSearchQuery = '';
    this.searchStatus = '';
    this.stack.replaceChildren();
    this.setStatus('Abriendo documento…');
    this.readyCalled = false;
    try {
      if (!doc || (!doc.data && !doc.path)) throw new Error('El documento no contiene datos PDF.');
      let data = doc.data;
      if (!data && doc.path && window.pliego?.readPdf) data = await window.pliego.readPdf(doc.path);
      if (!data) throw new Error('No hay un archivo PDF legible para este documento.');
      const asset = name => new URL(`./pdf-assets/${name}/`, document.baseURI).href;
      const bytes = data instanceof Uint8Array ? new Uint8Array(data) : new Uint8Array(data);
      this.loadingTask = getDocument({
        data: bytes,
        isEvalSupported: false,
        cMapUrl: asset('cmaps'), cMapPacked: true,
        standardFontDataUrl: asset('standard_fonts'),
        wasmUrl: asset('wasm'),
        useWorkerFetch: false,
        useWasm: true,
        stopAtErrors: false,
      });
      this.pdf = await this.loadingTask.promise;
      if (version !== this.renderVersion || this.destroyed) return;
      this.currentPage = 1;
      this.pageInput.max = String(this.pdf.numPages);
      this.pageTotal.textContent = `/ ${this.pdf.numPages}`;
      const outline = await this.readOutline();
      this.callbacks.onOutline?.(outline);
      if (this.fitWidth) await this.updateFitScale();
      await this.renderCurrentPage();
      if (!this.readyCalled) { this.readyCalled = true; this.callbacks.onReady?.(this.pdf); }
    } catch (error) {
      const message = error?.name === 'PasswordException'
        ? 'Este PDF requiere contraseña, función que el lector todavía no admite.'
        : `No se pudo abrir el PDF: ${error?.message || 'archivo dañado o formato no compatible.'}`;
      if (version === this.renderVersion) {
        this.setStatus(message);
        this.callbacks.onError?.(new Error(message, { cause: error }));
      }
    }
  }

  async readOutline() {
    try {
      const raw = await this.pdf.getOutline();
      const items = flattenOutline(raw);
      const result = [];
      for (const item of items) {
        let page = null;
        try {
          let dest = item.dest;
          if (typeof dest === 'string') dest = await this.pdf.getDestination(dest);
          if (Array.isArray(dest) && dest[0]) page = (await this.pdf.getPageIndex(dest[0])) + 1;
        } catch { /* External, malformed, or unresolved destinations remain without a page. */ }
        result.push({ title: item.title, page, depth: item.depth });
      }
      return result;
    } catch { return []; }
  }

  async goTo(page) {
    if (!this.pdf) return;
    this.currentPage = Math.max(1, Math.min(this.pdf.numPages, Math.trunc(Number(page) || 1)));
    this.pageInput.value = String(this.currentPage);
    await this.renderCurrentPage();
  }

  runSearchFromButton() {
    const query = this.searchInput.value.trim();
    if (!query) return;
    if (query.toLocaleLowerCase() === this.lastSearchQuery && this.searchHits.length) this.nextSearchHit();
    else this.search(query).then(() => this.nextSearchHit());
  }

  async updateFitScale() {
    if (!this.pdf) return;
    const page = await this.pdf.getPage(this.currentPage);
    const base = page.getViewport({ scale: 1 });
    const available = Math.max(180, this.viewport.clientWidth - 40);
    this.scale = Math.min(2, Math.max(0.5, available / base.width));
    this.zoomSelect.value = ZOOMS.reduce((best, value) => Math.abs(value / 100 - this.scale) < Math.abs(best / 100 - this.scale) ? value : best, ZOOMS[0]).toString();
  }

  scheduleFit() {
    cancelAnimationFrame(this.fitFrame);
    this.fitFrame = requestAnimationFrame(() => {
      if (this.fitWidth && this.pdf) this.updateFitScale().then(() => this.renderCurrentPage());
    });
  }

  async renderCurrentPage() {
    if (!this.pdf || this.destroyed) return;
    const version = ++this.renderVersion;
    this.cancelRender();
    this.setStatus('');
    this.pageInput.value = String(this.currentPage);
    this.callbacks.onPage?.(this.currentPage, this.pdf.numPages);
    try {
      const page = await this.pdf.getPage(this.currentPage);
      if (version !== this.renderVersion || this.destroyed) return;
      const viewport = page.getViewport({ scale: this.scale });
      const dpr = window.devicePixelRatio || 1;
      const pageWrap = element('div', 'pdf-page');
      pageWrap.style.width = `${viewport.width}px`;
      pageWrap.style.height = `${viewport.height}px`;
      pageWrap.dataset.page = String(this.currentPage);
      const canvas = element('canvas', 'pdf-canvas');
      canvas.width = Math.ceil(viewport.width * dpr);
      canvas.height = Math.ceil(viewport.height * dpr);
      canvas.style.width = `${viewport.width}px`;
      canvas.style.height = `${viewport.height}px`;
      const textContainer = element('div', 'textLayer');
      textContainer.style.setProperty('--scale-factor', String(this.scale));
      textContainer.style.setProperty('--total-scale-factor', String(this.scale));
      const highlightLayer = element('div', 'pdf-highlight-layer');
      pageWrap.append(canvas, textContainer, highlightLayer);
      const context = canvas.getContext('2d', { alpha: false });
      this.renderTask = page.render({ canvas, canvasContext: context, viewport, transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : null, annotationMode: 0, intent: 'display' });
      await this.renderTask.promise;
      if (version !== this.renderVersion || this.destroyed) return;
      this.stack.replaceChildren(pageWrap);
      const textContent = await page.getTextContent();
      if (version !== this.renderVersion || this.destroyed) return;
      this.textLayer = new TextLayer({ textContentSource: textContent, container: textContainer, viewport });
      await this.textLayer.render();
      if (version !== this.renderVersion || this.destroyed) return;
      this.renderHighlights(highlightLayer);
      pageWrap.dataset.rendered = 'true';
      if (!textContent.items?.some(item => typeof item.str === 'string' && item.str.trim())) {
        this.setStatus(this.withSearchStatus('Esta hoja no tiene texto seleccionable; puedes crear una nota de página.'));
      } else {
        this.setStatus(this.withSearchStatus('El texto del PDF es seleccionable; las notas se guardan aparte.'));
      }
    } catch (error) {
      if (error?.name === 'RenderingCancelledException' || version !== this.renderVersion) return;
      const message = `No se pudo dibujar la hoja ${this.currentPage}: ${error?.message || 'error de renderizado.'}`;
      this.setStatus(message);
      this.callbacks.onError?.(new Error(message, { cause: error }));
    }
  }

  cancelRender() {
    try { this.renderTask?.cancel(); } catch { /* Already settled. */ }
    this.renderTask = null;
    try { this.textLayer?.cancel(); } catch { /* Already settled. */ }
    this.textLayer = null;
  }

  renderHighlights(layer) {
    layer.replaceChildren();
    for (const entry of this.highlights) {
      if (entry.page !== this.currentPage) continue;
      for (const rect of entry.rects || []) {
        const mark = element('div', 'pdf-highlight');
        mark.style.left = `${rect.x * 100}%`;
        mark.style.top = `${rect.y * 100}%`;
        mark.style.width = `${rect.width * 100}%`;
        mark.style.height = `${rect.height * 100}%`;
        layer.append(mark);
      }
    }
  }

  setHighlights(entries = []) {
    this.highlights = Array.isArray(entries) ? entries : [];
    const layer = this.stack.querySelector('.pdf-highlight-layer');
    if (layer) this.renderHighlights(layer);
  }

  captureSelection() {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || !selection.toString().trim()) return this.lastSelection;
    const range = selection.getRangeAt(0);
    const pageElement = range.commonAncestorContainer.nodeType === Node.ELEMENT_NODE
      ? range.commonAncestorContainer.closest?.('.pdf-page')
      : range.commonAncestorContainer.parentElement?.closest('.pdf-page');
    const textLayer = pageElement?.querySelector('.textLayer');
    if (!pageElement || !this.stack.contains(pageElement) || !textLayer || pageElement.dataset.page !== String(this.currentPage)) return this.lastSelection;
    if (!textLayer.contains(range.startContainer) || !textLayer.contains(range.endContainer)) return this.lastSelection;
    const pageRect = pageElement.getBoundingClientRect();
    const clamp = value => Math.max(0, Math.min(1, value));
    const rects = [...range.getClientRects()].map(rect => {
      const x1 = clamp((rect.left - pageRect.left) / pageRect.width);
      const y1 = clamp((rect.top - pageRect.top) / pageRect.height);
      const x2 = clamp((rect.right - pageRect.left) / pageRect.width);
      const y2 = clamp((rect.bottom - pageRect.top) / pageRect.height);
      return { x: x1, y: y1, width: x2 - x1, height: y2 - y1 };
    }).filter(rect => rect.width > 0 && rect.height > 0);
    if (!rects.length) return this.lastSelection;
    this.lastSelection = { page: this.currentPage, quote: selection.toString().trim(), rects };
    this.selectionNote.textContent = `Selección lista · hoja ${this.currentPage}`;
    this.callbacks.onSelection?.(this.lastSelection);
    return this.lastSelection;
  }

  clearSelection() {
    this.lastSelection = null;
    window.getSelection()?.removeAllRanges();
    this.selectionNote.textContent = 'Selecciona texto para crear una nota.';
    this.callbacks.onSelection?.(null);
  }

  async search(query) {
    const needle = String(query || '').trim().toLocaleLowerCase();
    const version = ++this.searchVersion;
    this.searchHits = [];
    this.searchIndex = -1;
    this.lastSearchQuery = needle;
    this.searchStatus = '';
    if (!needle || !this.pdf) { this.setStatus(''); return []; }
    const limit = Math.min(this.pdf.numPages, SEARCH_PAGE_LIMIT);
    this.setStatus('Buscando…');
    for (let pageNumber = 1; pageNumber <= limit; pageNumber++) {
      if (version !== this.searchVersion) return [];
      const page = await this.pdf.getPage(pageNumber);
      const content = await page.getTextContent();
      const text = content.items.map(item => item.str || '').join(' ').toLocaleLowerCase();
      if (text.includes(needle)) this.searchHits.push({ page: pageNumber, text: content.items.map(item => item.str || '').join(' ') });
    }
    if (version !== this.searchVersion) return [];
    const capped = this.pdf.numPages > SEARCH_PAGE_LIMIT;
    this.searchStatus = `${this.searchHits.length} hoja${this.searchHits.length === 1 ? '' : 's'} con coincidencias${capped ? ` · búsqueda limitada a ${SEARCH_PAGE_LIMIT} hojas` : ''}.`;
    this.setStatus(this.withSearchStatus(''));
    return this.searchHits.slice();
  }

  nextSearchHit() {
    if (!this.searchHits.length) return;
    this.searchIndex = (this.searchIndex + 1) % this.searchHits.length;
    this.goTo(this.searchHits[this.searchIndex].page);
  }

  clearSearch() {
    this.searchVersion++;
    this.searchHits = [];
    this.searchIndex = -1;
    this.lastSearchQuery = '';
    this.searchStatus = '';
    this.setStatus('');
  }

  withSearchStatus(pageStatus) {
    if (pageStatus && this.searchStatus) return `${pageStatus} · ${this.searchStatus}`;
    return pageStatus || this.searchStatus;
  }

  focusSearch() { this.searchInput.focus(); this.searchInput.select(); }
  setStatus(text) { this.status.textContent = text; }

  async destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.renderVersion++;
    this.searchVersion++;
    cancelAnimationFrame(this.fitFrame);
    this.resizeObserver?.disconnect();
    this.cancelRender();
    try { await this.loadingTask?.destroy(); } catch { /* Loading task already ended. */ }
    try { await this.pdf?.destroy?.(); } catch { /* Document already ended. */ }
    this.pdf = null;
    this.stack.replaceChildren();
  }
}
