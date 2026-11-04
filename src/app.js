import { EditorView, basicSetup } from 'codemirror';
import { EditorState } from '@codemirror/state';
import { keymap } from '@codemirror/view';
import { markdown } from '@codemirror/lang-markdown';
import { undo, redo } from '@codemirror/commands';
import { openSearchPanel } from '@codemirror/search';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import markedFootnote from 'marked-footnote';
import { PdfWorkspace } from './pdf-workspace.js';
import './pdf-pane.css';
import './pdf-workspace.css';
import './library.css';
import { TextPane } from './text-pane.js';
import { markChanges, clearChanges } from './compare-view.js';
import './text-pane.css';
import './text-workbench.css';
import './add-menu.css';

marked.use(markedFootnote({ description: 'Notas', backRefLabel: 'Volver al texto' }));

const $ = id => document.getElementById(id);
const api = window.pliego;
const welcome = `# Un lugar para leer.

Hay textos que piden otra velocidad. Una página despejada, una letra amable y el espacio justo para seguir una idea hasta el final.

**Pliego** es un pequeño escritorio para tus documentos. Abre un Markdown, un PDF, un Word o un texto plano. Acomódate y empieza a leer. Si una frase del Markdown pide un retoque, la edición está a un clic.

## El texto, en primer plano

Elige **Leer** para ver la página limpia, **Ambas** para escribir junto a la vista previa o **Editar** para trabajar con el Markdown. Puedes hacer doble clic en un párrafo para pasar directamente a ese pasaje en el editor.

Para leer dos archivos distintos a la vez, abre el primero y pulsa **Dos textos**, junto a **Abrir**, para elegir el segundo. Cada texto queda en su propio panel, y Pliego marca lo que cambia entre ellos: en ocre, lo que solo está en el primero; en verde, lo que solo está en el segundo. También puedes usar **Ctrl + Alt + O** o **＋ → Abrir al lado…**.

> Leer no es pasar los ojos por las palabras. A veces es detenerse donde el texto todavía está pensando.

El botón **Aa** te deja cambiar el tamaño de letra, el ancho de la página y el ambiente: papel, marfil o noche. Tus preferencias se recuerdan; el archivo sigue siendo el mismo.

## Retoques sin ceremonia

La barra de edición tiene lo necesario: títulos, **negritas**, *cursivas*, citas, listas y enlaces. También puedes escribir la sintaxis de Markdown directamente.

- Abre un archivo con **Ctrl + O** o arrástralo a la ventana.
- Guarda los cambios con **Ctrl + S**.
- Busca una frase con **Ctrl + F**.
- Activa la lectura sin distracciones con **Ctrl + Mayús + F**.

Los cambios se guardan cuando tú lo indicas. Si cierras una página con cambios pendientes, Pliego te avisa. Antes de sobrescribir un archivo, conserva una copia de su versión anterior.

## Cada archivo, en su sitio

Abre una **carpeta** para recorrer sus archivos desde el panel lateral. El **índice** se genera a partir de los títulos del documento y te lleva directamente a cada sección.

La **Biblioteca** te deja buscar por nombre o carpeta, filtrar por formato y guardar favoritos. Los PDF tienen su propio **cuaderno**: notas, marcadores con nombre y pasajes seleccionados. Puedes leer dos PDF enfrentados y exportar tus fichas a Markdown. La hoja del PDF y el folio impreso se guardan por separado; el folio lo lees en la imagen de esa misma hoja.

| Para hacer esto | Usa esto |
| --- | --- |
| Leer con calma | Leer + Aa |
| Corregir viendo el resultado | Ambas |
| Concentrarte en las palabras | Lectura sin distracciones |
| Crear otra versión | Guardar como… |

---

Esta página es una bienvenida. Puedes editarla y guardarla como tu primer archivo, o abrir uno de los tuyos.
`;
let current = { path: null, name: 'Bienvenido a Pliego', text: welcome, revision: null, eol: '\n', bom: false };
let baseline = welcome, dirty = false, primaryDirty = false, mode = 'read', folder = null, renderTimer, toastTimer, saving = false, transitioning = false;
let findRanges = [], findIndex = -1, pendingChoice;
let pdfWorkspace = null, favorites = [], fileType = 'all';
let referencePane = null, referenceOpening = false, sidebarBeforeComparison = false;
let changesOn = true, changeHunks = [], changeIndex = -1, changesTimer;
let lastErrorMessage = '';
const docType = () => current.type || 'md';
const preferences = (() => { try { return JSON.parse(localStorage.getItem('pliego-reading') || '{}'); } catch { return {}; } })();
const view = new EditorView({
  state: createState(welcome), parent: $('editor'),
});
function createState(text) {
  return EditorState.create({doc: text, extensions: [basicSetup, markdown(), EditorView.lineWrapping,
    keymap.of([{ key: 'Mod-b', run: () => { format('bold'); return true; } }, { key: 'Mod-i', run: () => { format('italic'); return true; } }]),
    EditorView.updateListener.of(update => {
      if (!update.docChanged) return;
      setDirty(view.state.doc.toString() !== baseline);
      clearTimeout(renderTimer);
      renderTimer = setTimeout(render, 180);
    }),
    EditorView.contentAttributes.of({ 'aria-label': 'Texto Markdown', spellcheck: 'true', lang: 'es' }),
  ] });
}
function toast(message, error = false) {
  if (error) lastErrorMessage = String(message);
  clearTimeout(toastTimer); $('toast').textContent = message; $('toast').hidden = false;
  $('toast').setAttribute('role', error ? 'alert' : 'status');
  toastTimer = setTimeout(() => { $('toast').hidden = true; }, error ? 10000 : 4500);
}
function setDirty(value) {
  primaryDirty = value; syncDirty();
}
function syncDirty() {
  dirty = primaryDirty || Boolean(referencePane?.dirty); api?.setDirty(dirty); $('dirty-indicator').hidden = !primaryDirty;
  $('save-state').textContent = primaryDirty ? (docType() === 'pdf' ? 'Nota sin guardar' : 'Cambios en el primer texto') : referencePane?.dirty ? 'Cambios en el segundo texto' : docType() === 'pdf' ? 'Cuaderno local' : ['docx', 'txt'].includes(docType()) ? 'Vista previa · original intacto' : current.path ? 'Guardado' : current.name === 'Bienvenido a Pliego' ? 'Documento de bienvenida' : 'Archivo nuevo';
  if (!referencePane && primaryDirty && docType() !== 'pdf') $('save-state').textContent = 'Cambios sin guardar';
  document.title = `${dirty ? '● ' : ''}${current.name}${referencePane?.doc ? ` ↔ ${referencePane.doc.name}` : ''} — Pliego`;
}
async function safely(action) { try { return await action(); } catch (e) { toast(e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''), true); return null; } }
function sourceText() { return view.state.doc.toString(); }
function render() {
  if (docType() === 'pdf') return;
  const text = docType() === 'md' ? sourceText() : current.text || '';
  const wordCount = text.trim() ? (text.match(/[\p{L}\p{N}]+(?:[’'-][\p{L}\p{N}]+)*/gu) || []).length : 0;
  $('word-count').textContent = `${wordCount.toLocaleString('es')} palabras`;
  $('reading-time').textContent = `${Math.max(1, Math.ceil(wordCount / 220))} min de lectura`;
  let offset = 0, html = '';
  const front = text.match(/^\uFEFF?---\r?\n[\s\S]*?\r?\n(?:---|\.\.\.)(?:\r?\n|$)/);
  if (front) { const box = document.createElement('pre'); box.className = 'frontmatter'; box.textContent = front[0].trim(); html = box.outerHTML; offset = front[0].length; }
  const tokens = marked.lexer(text.slice(offset), { gfm: true });
  const positions = [];
  for (const token of tokens) { if (token.type !== 'space' && token.type !== 'def') positions.push(offset); offset += token.raw.length; }
  if (docType() === 'docx') html = current.html || '';
  else if (docType() === 'txt') { const pre = document.createElement('div'); pre.className = 'plain-text'; pre.textContent = text; html = pre.outerHTML; }
  else html += marked.parse(text.slice(front ? front[0].length : 0), { gfm: true });
  $('preview').innerHTML = DOMPurify.sanitize(html, { USE_PROFILES: { html: true }, ADD_ATTR: ['data-offset'], FORBID_TAGS: ['style', 'form', 'input', 'button', 'textarea', 'iframe', 'object', 'embed'], FORBID_ATTR: ['style'] });
  [...$('preview').children].filter(el => !el.classList.contains('frontmatter')).forEach((el, index) => { el.dataset.offset = positions[index] ?? 0; });
  // Images are resolved only by the native process, against the current document directory.
  for (const img of $('preview').querySelectorAll('img')) {
    const relative = img.getAttribute('src'); img.removeAttribute('src');
    if (relative?.startsWith('data:image/') && !relative.startsWith('data:image/svg')) img.src = relative;
    else if (current.path && relative && !/^[a-z][a-z\d+.-]*:/i.test(relative) && !relative.startsWith('//')) {
      const expectedPath = current.path;
      api?.assetUrl(current.path, relative).then(url => { if (url && current.path === expectedPath && img.isConnected) img.src = url; }).catch(() => {});
    }
    img.loading = 'lazy';
  }
  const outline = $('outline'); outline.replaceChildren();
  const headings = [...$('preview').querySelectorAll('h1,h2,h3,h4,h5,h6')];
  headings.forEach((heading, index) => {
    if (!heading.id) heading.id = `heading-${index}`;
    const button = document.createElement('button'); button.className = `outline-item depth-${heading.tagName.slice(1)}`;
    button.textContent = heading.textContent; button.dataset.heading = heading.id;
    button.onclick = () => {
      if (mode === 'edit') { jumpTo(Number(heading.closest('[data-offset]')?.dataset.offset || 0)); }
      else heading.scrollIntoView({ block: 'start', behavior: 'smooth' });
    };
    outline.append(button);
  });
  if (!headings.length) { const note = document.createElement('p'); note.className = 'side-note'; note.textContent = 'Los títulos del texto aparecerán aquí.'; outline.append(note); }
  if (!$('find-bar').hidden) searchReading();
  if (referencePane) refreshChanges();
  progress();
}
// Cotejo de los dos textos: marca lo que cambia y permite saltar de un pasaje a otro en ambos paneles.
function refreshChanges() { clearTimeout(changesTimer); changesTimer = setTimeout(applyChanges, 200); }
function applyChanges() {
  clearChanges(); changeHunks = []; changeIndex = -1;
  if (referencePane?.doc && changesOn && docType() !== 'pdf') changeHunks = markChanges($('preview'), referencePane.prose);
  updateChangesUi();
}
function updateChangesUi() {
  const n = changeHunks.length;
  $('changes').hidden = !referencePane;
  $('changes-toggle').setAttribute('aria-pressed', String(changesOn));
  $('changes-count').textContent = !changesOn ? '' : !n ? 'Sin cambios' : changeIndex >= 0 ? `${changeIndex + 1} de ${n}` : `${n} ${n === 1 ? 'pasaje cambia' : 'pasajes cambian'}`;
  $('changes-prev').disabled = $('changes-next').disabled = !changesOn || !n;
}
function bringIntoView(scroller, el) {
  if (!scroller || !el) return;
  const top = el.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop - scroller.clientHeight * 0.25;
  scroller.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
}
function goChange(delta) {
  const n = changeHunks.length; if (!n) return;
  changeIndex = changeIndex < 0 ? (delta > 0 ? 0 : n - 1) : (changeIndex + delta + n) % n;
  const hunk = changeHunks[changeIndex];
  bringIntoView($('reader-pane'), hunk.first); bringIntoView(referencePane?.reader, hunk.second);
  updateChangesUi();
}
function progress() {
  const pane = $('reader-pane'), available = pane.scrollHeight - pane.clientHeight;
  $('read-progress').textContent = `${available > 0 ? Math.round(pane.scrollTop / available * 100) : 100} %`;
  let active;
  for (const heading of $('preview').querySelectorAll('h1,h2,h3,h4,h5,h6')) {
    if (heading.getBoundingClientRect().top <= pane.getBoundingClientRect().top + 130) active = heading.id;
  }
  const items = [...$('outline').querySelectorAll('button')];
  items.forEach((item, index) => item.classList.toggle('active', active ? item.dataset.heading === active : index === 0));
}
function setMode(value) {
  if (referencePane && value === 'split') value = 'read';
  if (docType() !== 'md') { if (value !== 'read') toast('La edición está disponible para Markdown. Este documento se abre para lectura.'); value = 'read'; }
  mode = value; $('main').dataset.mode = value;
  document.querySelectorAll('.mode-switch button[data-mode]').forEach(el => el.setAttribute('aria-pressed', el.dataset.mode === value));
  $('format-bar').hidden = value === 'read';
  if (value !== 'read') { view.requestMeasure(); view.focus(); }
}
function jumpTo(position) {
  const pos = Math.min(position, view.state.doc.length);
  view.dispatch({ selection: { anchor: pos }, effects: EditorView.scrollIntoView(pos, { y: 'center' }) }); view.focus();
}
function chooseUnsaved(message = 'Guarda los cambios antes de pasar a otro documento.') {
  if ($('unsaved-dialog').open) return Promise.resolve('cancel');
  $('unsaved-message').textContent = message;
  $('unsaved-dialog').showModal();
  return new Promise(resolve => { pendingChoice = resolve; });
}
for (const [id, value] of [['unsaved-cancel', 'cancel'], ['unsaved-discard', 'discard'], ['unsaved-save', 'save']]) {
  $(id).onclick = () => { $('unsaved-dialog').close(); pendingChoice?.(value); pendingChoice = null; };
}
$('unsaved-dialog').addEventListener('cancel', () => { pendingChoice?.('cancel'); pendingChoice = null; });
async function canLeave() {
  if (!dirty) return true;
  const choice = await chooseUnsaved();
  if (choice === 'save') return await saveAll();
  return choice === 'discard';
}
async function replaceDocument(doc) {
  if (!doc) return;
  clearReference();
  pdfWorkspace?.destroy(); pdfWorkspace = null;
  current = doc; clearTimeout(renderTimer); closeFind();
  const type = docType(); $('main').dataset.type = type;
  $('markdown-panes').hidden = type === 'pdf'; $('pdf-desk').hidden = type !== 'pdf';
  $('text-workbench').hidden = type === 'pdf';
  $('text-compare').textContent = type === 'pdf' ? 'Dos PDF' : 'Dos textos';
  $('text-compare').setAttribute('aria-pressed', 'false');
  document.querySelector('.mode-switch').hidden = type === 'pdf';
  document.querySelectorAll('button[data-mode="split"],button[data-mode="edit"]').forEach(button => { button.disabled = type !== 'md'; });
  $('save').textContent = type === 'pdf' ? 'Guardar nota' : 'Guardar'; $('save').hidden = ['docx', 'txt'].includes(type);
  $('save-as').hidden = ['docx', 'txt'].includes(type); $('save-as').textContent = type === 'pdf' ? 'Exportar fichas…' : 'Guardar como…';
  $('document-notice').hidden = !['docx', 'txt'].includes(type);
  $('document-notice').textContent = type === 'docx' ? 'Vista previa de Word · se conserva el contenido; el diseño y la paginación pueden variar. El original no se modifica.' + (doc.messages?.length ? ` ${doc.messages.length} observaciones de conversión.` : '') : 'Texto plano · vista de lectura. El original no se modifica.';
  if (type !== 'md') setMode('read');
  if (type === 'pdf') {
    $('format-bar').hidden = true; $('outline').replaceChildren(); $('word-count').textContent = 'PDF'; $('reading-time').textContent = 'Notas locales'; $('read-progress').textContent = '';
    pdfWorkspace = new PdfWorkspace({ container: $('pdf-desk'), api,
      onDirty: setDirty,
      onStatus: message => { $('save-state').textContent = message; },
      onError: message => toast(String(message).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''), true),
      onOutline: items => {
        $('outline').replaceChildren();
        for (const item of items) { const button = document.createElement('button'); button.className = `outline-item depth-${Math.min(6, item.depth + 1)}`; button.textContent = item.title; button.onclick = item.go; $('outline').append(button); }
        if (!items.length) { const p = document.createElement('p'); p.className = 'side-note'; p.textContent = 'Este PDF no tiene un índice de navegación. Puedes usar las hojas o tus marcadores.'; $('outline').append(p); }
      },
    });
    setDirty(false); await pdfWorkspace.load(doc);
  } else {
    if (type === 'md') { view.setState(createState(doc.text)); baseline = view.state.doc.toString(); }
    render(); setDirty(false); $('reader-pane').scrollTop = 0;
  }
  $('doc-name').textContent = doc.name; $('doc-path').textContent = doc.path || 'Nuevo documento'; $('doc-path').title = doc.path || '';
  $('encoding').textContent = type === 'pdf' ? 'PDF · original intacto' : type === 'docx' ? 'Word · lectura' : `${doc.bom ? 'UTF-8 BOM' : 'UTF-8'} · ${doc.eol === '\r\n' ? 'CRLF' : 'LF'}`;
  $('file-favorite').hidden = !doc.path; updateFavoriteButtons();
  await updateRecents(); renderFiles();
}
async function transition(getDoc) {
  if (transitioning || saving) return;
  transitioning = true;
  try { if (await canLeave()) { const doc = await safely(getDoc); if (doc) await safely(() => replaceDocument(doc)); } } finally { transitioning = false; }
}
async function save(saveAs = false) {
  if (docType() === 'pdf') { if (saveAs) { await pdfWorkspace?.export(); return false; } return await pdfWorkspace?.saveDraft(); }
  if (docType() !== 'md') { toast('Este documento se abre para lectura.'); return true; }
  if (saving) return false;
  if (!saveAs && current.path && !primaryDirty) { toast('El archivo ya está guardado.'); return true; }
  if (!api) { toast('Esta vista necesita la aplicación de Windows para guardar.'); return false; }
  saving = true; $('save').disabled = true;
  const snapshot = sourceText();
  try {
      const doc = await safely(() => api.saveFile({ path: current.path, text: snapshot, revision: current.revision, saveAs, bom: current.bom, eol: current.eol }));
    if (!doc) return false;
    current = doc; baseline = snapshot; setDirty(sourceText() !== snapshot);
    $('doc-name').textContent = doc.name; $('doc-path').textContent = doc.path; $('doc-path').title = doc.path;
    $('encoding').textContent = `${doc.bom ? 'UTF-8 BOM' : 'UTF-8'} · ${doc.eol === '\r\n' ? 'CRLF' : 'LF'}`;
    await updateRecents(); toast('Archivo guardado.'); return !primaryDirty;
  } finally { saving = false; $('save').disabled = false; }
}
async function saveAll() {
  lastErrorMessage = '';
  let success = false;
  try {
    if (primaryDirty && !(await save())) return false;
    if (referencePane?.dirty && !(await referencePane.save())) return false;
    success = !primaryDirty && !referencePane?.dirty; return success;
  } finally { if (!success) { api?.cancelClose?.(); toast(`No se completó el guardado. ${lastErrorMessage ? `${lastErrorMessage} ` : ''}Los cambios pendientes siguen abiertos.`, true); } }
}
function clearReference() {
  if (!referencePane) return;
  const pane = referencePane; referencePane = null; pane.destroy();
  clearTimeout(changesTimer); clearChanges(); changeHunks = []; changeIndex = -1; updateChangesUi();
  $('text-reference').replaceChildren(); $('text-reference').hidden = true;
  $('text-workbench').classList.remove('text-comparing'); $('text-compare').textContent = 'Dos textos';
  $('text-compare').setAttribute('aria-pressed', 'false');
  document.querySelector('.mode-switch button[data-mode="split"]').hidden = false;
  if (!sidebarBeforeComparison) document.body.classList.remove('no-sidebar');
  syncDirty();
}
async function referenceMayLeave() {
  if (!referencePane?.dirty) return true;
  const choice = await chooseUnsaved('El segundo texto tiene cambios pendientes. Guárdalo antes de cerrar o reemplazar su panel.');
  if (choice === 'save') return await referencePane.save();
  return choice === 'discard';
}
async function closeReference() {
  if (referenceOpening || saving || referencePane?.saving || transitioning || !(await referenceMayLeave())) return;
  clearReference();
}
async function openReference(suppliedDoc = null) {
  if (referenceOpening || saving || referencePane?.saving || transitioning || docType() === 'pdf') return;
  referenceOpening = true;
  try {
    if (!(await referenceMayLeave())) return;
    const doc = suppliedDoc || await api.openFile({ type: 'text' });
    if (!doc) return;
    if (!['md', 'txt', 'docx'].includes(doc.type || 'md')) { toast('Elige un Markdown, Word o texto plano para el segundo panel.'); return; }
    if (current.path && samePath(current.path, doc.path)) { toast('Ese archivo ya está abierto a la izquierda. Elige la otra versión del texto.'); return; }
    const wasOpen = Boolean(referencePane);
    referencePane?.destroy(); referencePane = null;
    if (!wasOpen) sidebarBeforeComparison = document.body.classList.contains('no-sidebar');
    $('text-reference').hidden = false; $('text-workbench').classList.add('text-comparing');
    document.body.classList.add('no-sidebar');
    referencePane = new TextPane({ container: $('text-reference'), api,
      onDirty: syncDirty, onSaved: () => { updateRecents(); syncDirty(); },
      onClose: closeReference, onReplace: () => openReference(), onError: message => toast(String(message), true), onRender: refreshChanges,
    });
    await referencePane.load(doc);
    setMode('read'); document.querySelector('.mode-switch button[data-mode="split"]').hidden = true;
    $('text-compare').textContent = 'Dos textos'; $('text-compare').setAttribute('aria-pressed', 'true'); syncDirty(); await updateRecents();
  } catch (error) { toast(error.message, true); } finally { referenceOpening = false; }
}
async function openPair(pair) {
  if (transitioning || saving || referenceOpening) return;
  transitioning = true;
  try {
    if (!(await canLeave())) return;
    await replaceDocument(pair.primary);
  } catch (error) { toast(error.message, true); return; }
  finally { transitioning = false; }
  if (pair.reference) await openReference(pair.reference);
}
async function updateRecents() {
  const recent = await safely(() => api?.getRecent()) || []; $('recents').replaceChildren();
  for (const file of recent.slice(0, 5)) {
    const button = document.createElement('button'); button.className = 'recent-file'; button.textContent = file.name; button.title = file.path;
    button.onclick = () => transition(() => api.readFile(file.path)); $('recents').append(button);
  }
  if (!recent.length) { const p = document.createElement('p'); p.className = 'side-note'; p.textContent = 'Tus últimas lecturas, a mano.'; p.style.padding = '0'; $('recents').append(p); }
}
function sideTab(files) {
  $('outline-panel').hidden = files; $('files-panel').hidden = !files;
  $('outline-tab').setAttribute('aria-pressed', !files); $('files-tab').setAttribute('aria-pressed', files);
}
function renderFiles() {
  if (!folder) return;
  const filter = $('file-filter').value.toLocaleLowerCase('es'); $('files').replaceChildren();
  const matches = folder.files.filter(f => (fileType === 'all' || f.type === fileType) && (f.relativePath || f.name).toLocaleLowerCase('es').includes(filter));
  for (const file of matches) {
    const button = document.createElement('button'); button.className = 'file-item'; button.classList.toggle('current', file.path === current.path);
    const kind = document.createElement('span'); kind.className = 'file-kind'; kind.textContent = ({ docx: 'DOCX', md: 'MD', pdf: 'PDF', txt: 'TXT' })[file.type] || 'MD';
    const description = document.createElement('span'); description.className = 'file-description';
    const title = document.createElement('strong'); title.textContent = file.name;
    const detail = document.createElement('small'); const relative = file.relativePath || file.name; const parent = relative.includes('/') || relative.includes('\\') ? relative.replace(/[\\/][^\\/]+$/, '') : '';
    detail.textContent = [parent, file.size > 1024 * 1024 ? `${(file.size / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round((file.size || 0) / 1024))} KB`].filter(Boolean).join(' · ');
    description.append(title, detail); button.append(kind, description); button.title = file.path;
    button.onclick = () => transition(() => api.readFile(file.path)); $('files').append(button);
  }
  if (!$('files').children.length) { const p = document.createElement('p'); p.className = 'side-note'; p.textContent = 'No hay documentos que coincidan con este filtro.'; $('files').append(p); }
  $('library-count').textContent = `${matches.length} de ${folder.files.length} documentos${folder.truncated ? ' · inventario parcial, elige una carpeta más pequeña' : ''}${folder.warning ? ' · algunas carpetas no pudieron leerse' : ''}`;
}
function showFolder(result) { folder = result; $('folder-label').textContent = result.path.split(/[\\/]/).pop(); $('folder-label').title = result.path; renderFiles(); updateFavoriteButtons(); sideTab(true); document.body.classList.remove('no-sidebar'); }
async function openFolder() {
  if (!api) return;
  const result = await safely(() => api.openFolder());
  if (result) showFolder(result);
}
function samePath(a, b) { return a?.toLocaleLowerCase() === b?.toLocaleLowerCase(); }
function updateFavoriteButtons() {
  $('folder-favorite').textContent = folder && favorites.some(f => samePath(f.path, folder.path)) ? '★' : '☆';
  $('folder-favorite').disabled = !folder;
  $('file-favorite').textContent = current.path && favorites.some(f => samePath(f.path, current.path)) ? '★' : '☆';
}
async function updateFavorites() {
  favorites = await safely(() => api?.getFavorites()) || []; $('favorites').replaceChildren();
  for (const favorite of favorites) {
    const row = document.createElement('div'); row.className = 'favorite-row';
    const button = document.createElement('button'); button.textContent = `${favorite.type === 'folder' ? '▱' : '◇'} ${favorite.name}`; button.title = favorite.path;
    button.onclick = () => favorite.type === 'folder' ? safely(async () => showFolder(await api.selectFavoriteFolder(favorite.path))) : transition(() => api.readFile(favorite.path));
    const remove = document.createElement('button'); remove.textContent = '×'; remove.setAttribute('aria-label', `Quitar favorito ${favorite.name}`);
    remove.onclick = () => safely(async () => { await api.toggleFavorite(favorite); await updateFavorites(); });
    row.append(button, remove); $('favorites').append(row);
  }
  if (!favorites.length) { const note = document.createElement('p'); note.className = 'side-note'; note.style.padding = '0'; note.textContent = 'Marca con ☆ una carpeta o un documento.'; $('favorites').append(note); }
  updateFavoriteButtons();
}
function format(kind) {
  if (docType() !== 'md') return;
  if (mode === 'read') setMode('split');
  const { from, to } = view.state.selection.main;
  const selected = view.state.sliceDoc(from, to);
  const wrappers = { bold: ['**', '**', 'texto'], italic: ['*', '*', 'texto'], link: ['[', '](https://)', 'enlace'] };
  if (wrappers[kind]) {
    const [before, after, fallback] = wrappers[kind], middle = selected || fallback;
    view.dispatch({ changes: { from, to, insert: before + middle + after }, selection: { anchor: from + before.length, head: from + before.length + middle.length } });
  } else {
    const line = view.state.doc.lineAt(from), prefix = { heading: '## ', quote: '> ', list: '- ' }[kind];
    view.dispatch({ changes: { from: line.from, insert: prefix } });
  }
  view.focus();
}
function searchReading() {
  const query = $('find-input').value.toLocaleLowerCase('es');
  findRanges = []; findIndex = -1; CSS.highlights?.delete('matches'); CSS.highlights?.delete('current-match');
  if (query) {
    const walker = document.createTreeWalker($('preview'), NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode()) && findRanges.length < 3000) {
      const text = node.textContent.toLocaleLowerCase('es'); let at = text.indexOf(query);
      while (at !== -1 && findRanges.length < 3000) { const range = new Range(); range.setStart(node, at); range.setEnd(node, at + query.length); findRanges.push(range); at = text.indexOf(query, at + query.length); }
    }
  }
  if (CSS.highlights && findRanges.length) CSS.highlights.set('matches', new Highlight(...findRanges));
  $('find-count').textContent = query ? `${findRanges.length} coincidencias` : '';
}
function nextMatch(delta) {
  if (!findRanges.length) return;
  findIndex = (findIndex + delta + findRanges.length) % findRanges.length;
  const range = findRanges[findIndex]; CSS.highlights?.set('current-match', new Highlight(range));
  range.startContainer.parentElement.scrollIntoView({ block: 'center', behavior: 'smooth' });
  $('find-count').textContent = `${findIndex + 1} de ${findRanges.length}`;
}
function find() {
  if (referencePane?.containsFocus()) { referencePane.focusSearch(); return; }
  if (docType() === 'pdf') { pdfWorkspace?.find(); return; }
  if (mode === 'edit') { openSearchPanel(view); return; }
  $('find-bar').hidden = false; $('find-input').focus(); searchReading();
}
const commands = {
  new: () => transition(async () => ({ path: null, name: 'Sin título.md', text: '', revision: null, eol: '\n', bom: false })),
  open: () => api && transition(() => api.openFile()), folder: openFolder,
  save: () => referencePane?.containsFocus() ? referencePane.save() : save(), saveAs: () => referencePane?.containsFocus() ? referencePane.save(true) : save(true), find,
  'mode-read': () => setMode('read'), 'mode-split': () => setMode('split'), 'mode-edit': () => setMode('edit'),
  'save-close': saveAll,
  'compare-text': () => docType() === 'pdf' ? pdfWorkspace?.compare() : openReference(),
};
for (const name of ['open', 'folder', 'save']) $(name).onclick = commands[name];
function setAddMenu(open, restoreFocus = false) {
  $('add-menu').hidden = !open; $('new').setAttribute('aria-expanded', String(open));
  if (open) {
    settings(false);
    $('add-side-description').textContent = docType() === 'pdf' ? 'Otro PDF en paralelo' : referencePane ? 'Cambiar el segundo texto' : 'En un segundo panel';
    $('add-open').focus();
  } else if (restoreFocus) $('new').focus();
}
$('new').onclick = () => setAddMenu($('add-menu').hidden, !$('add-menu').hidden);
for (const [id, command] of [['add-open', commands.open], ['add-new', commands.new], ['add-side', commands['compare-text']]]) {
  $(id).onclick = () => { setAddMenu(false, true); command(); };
}
$('new').addEventListener('keydown', event => {
  if (!['ArrowDown', 'ArrowUp'].includes(event.key)) return;
  event.preventDefault(); setAddMenu(true); if (event.key === 'ArrowUp') $('add-new').focus();
});
$('add-menu').addEventListener('keydown', event => {
  const items = [...$('add-menu').querySelectorAll('[role=menuitem]')];
  const index = items.indexOf(document.activeElement);
  if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setAddMenu(false, true); }
  else if (event.key === 'Tab') setAddMenu(false);
  else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
    event.preventDefault(); const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
    items[next].focus();
  }
});
document.addEventListener('pointerdown', event => { if (!event.target.closest('.add-dropdown')) setAddMenu(false); });
$('save-as').onclick = commands.saveAs;
$('text-compare').onclick = commands['compare-text'];
$('changes-toggle').onclick = () => { changesOn = !changesOn; applyChanges(); };
$('changes-next').onclick = () => goChange(1); $('changes-prev').onclick = () => goChange(-1);
document.querySelectorAll('.mode-switch button[data-mode]').forEach(button => button.onclick = () => setMode(button.dataset.mode));
document.querySelectorAll('[data-format]').forEach(button => button.onclick = () => format(button.dataset.format));
$('undo').onclick = () => { undo(view); view.focus(); }; $('redo').onclick = () => { redo(view); view.focus(); };
$('outline-tab').onclick = () => sideTab(false); $('files-tab').onclick = () => sideTab(true);
$('file-filter').oninput = renderFiles;
$('library-pick').onclick = openFolder;
$('library-refresh').onclick = () => folder && safely(async () => { $('library-refresh').disabled = true; try { showFolder(await api.refreshFolder(folder.path)); } finally { $('library-refresh').disabled = false; } });
$('folder-favorite').onclick = () => folder && safely(async () => { await api.toggleFavorite({ path: folder.path, type: 'folder' }); await updateFavorites(); });
$('file-favorite').onclick = () => current.path && safely(async () => { await api.toggleFavorite({ path: current.path, type: docType() }); await updateFavorites(); });
document.querySelectorAll('button[data-type]').forEach(button => button.onclick = () => { fileType = button.dataset.type; document.querySelectorAll('button[data-type]').forEach(b => b.setAttribute('aria-pressed', b === button)); renderFiles(); });
$('sidebar-toggle').onclick = () => document.body.classList.toggle('no-sidebar');
$('focus').onclick = () => document.body.classList.toggle('focus-mode');
$('preview').ondblclick = event => { if (docType() !== 'md') return; const block = event.target.closest('[data-offset]'); if (block && !event.target.closest('a')) { setMode(referencePane ? 'edit' : 'split'); jumpTo(Number(block.dataset.offset)); } };
$('preview').onclick = event => {
  const a = event.target.closest('a'); if (!a) return; event.preventDefault();
  const href = a.getAttribute('href');
  if (href?.startsWith('#')) {
    let slug; try { slug = decodeURIComponent(href.slice(1)); } catch { return; }
    const target = [...$('preview').querySelectorAll('[id]')].find(el => el.id === slug || el.id === href.slice(1) || el.textContent.toLocaleLowerCase('es').replace(/[^\p{L}\p{N}\s-]/gu, '').replace(/\s+/g, '-') === slug);
    target?.scrollIntoView({ block: 'start' });
  } else if (/^https?:\/\//i.test(href)) safely(() => api?.openExternal(href));
  else toast('Para abrir otro documento, usa Abrir o el panel de archivos.');
};
$('reader-pane').addEventListener('scroll', progress, { passive: true });
$('find-toggle').onclick = find; $('find-input').oninput = searchReading;
$('find-next').onclick = () => nextMatch(1); $('find-prev').onclick = () => nextMatch(-1);
$('find-input').onkeydown = event => { if (event.key === 'Enter') { event.preventDefault(); nextMatch(event.shiftKey ? -1 : 1); } };
function closeFind() { $('find-bar').hidden = true; CSS.highlights?.delete('matches'); CSS.highlights?.delete('current-match'); }
$('find-close').onclick = closeFind;
function applyPreferences() {
  const theme = ['paper', 'warm', 'night'].includes(preferences.theme) ? preferences.theme : 'paper';
  document.documentElement.dataset.theme = theme;
  document.querySelectorAll('button[data-theme]').forEach(b => b.setAttribute('aria-pressed', b.dataset.theme === theme));
  const size = Math.max(16, Math.min(30, Number(preferences.size) || 20));
  const width = Math.max(520, Math.min(1000, Number(preferences.width) || 720));
  $('font-size').value = size; $('font-size-value').textContent = `${size} px`;
  $('page-width').value = width; $('page-width-value').textContent = `${width} px`;
  document.documentElement.style.setProperty('--font-size', `${size}px`); document.documentElement.style.setProperty('--page-width', `${width}px`);
  const fonts = { serif: "Georgia,'Palatino Linotype',serif", humanist: "Calibri,'Segoe UI',sans-serif", mono: 'Consolas,monospace' };
  $('font-select').value = preferences.font in fonts ? preferences.font : 'serif';
  document.documentElement.style.setProperty('--reading-font', fonts[$('font-select').value]);
  try { localStorage.setItem('pliego-reading', JSON.stringify(preferences)); } catch {}
}
document.querySelectorAll('button[data-theme]').forEach(button => button.onclick = () => { preferences.theme = button.dataset.theme; applyPreferences(); });
for (const [id, key] of [['font-size', 'size'], ['page-width', 'width'], ['font-select', 'font']]) $(id).oninput = () => { preferences[key] = $(id).value; applyPreferences(); };
function settings(open) { $('settings').hidden = !open; $('settings-toggle').setAttribute('aria-expanded', open); }
$('settings-toggle').onclick = () => settings($('settings').hidden); $('settings-close').onclick = () => settings(false);
document.addEventListener('pointerdown', event => { if (!event.target.closest('#settings,#settings-toggle')) settings(false); });
document.addEventListener('keydown', event => {
  if (event.key === 'Escape') { settings(false); closeFind(); document.body.classList.remove('focus-mode'); }
  if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
  const key = event.key.toLowerCase();
  let command;
  if (key === 's') command = event.shiftKey ? commands.saveAs : commands.save;
  if (key === 'o') command = commands.open;
  if (key === 'n') command = commands.new;
  if (key === 'f') command = event.shiftKey ? () => document.body.classList.toggle('focus-mode') : commands.find;
  if (command) { event.preventDefault(); command(); }
});
document.addEventListener('dragover', event => event.preventDefault());
document.addEventListener('drop', event => {
  event.preventDefault();
  const file = event.dataTransfer.files[0];
  if (file && api?.openDroppedFile) transition(() => api.openDroppedFile(file));
  else if (file) toast('Abre este archivo con Ctrl + O.');
});
api?.onCommand(command => commands[command]?.());
api?.onOpenDocument(doc => transition(async () => doc));
api?.onOpenPair?.(pair => openPair(pair));
applyPreferences(); render(); setDirty(false); updateRecents(); updateFavorites();
if (api) safely(async () => { const doc = await api.getInitialDocument(); if (doc) await replaceDocument(doc); const reference = await api.getInitialReferenceDocument?.(); if (reference) await openReference(reference); });
