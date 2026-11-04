const { _electron: electron } = require('playwright');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');

async function run() {
  const root = path.resolve(__dirname, '..'), output = path.join(root, 'test-results');
  await fs.mkdir(output, { recursive: true });
  const temp = await fs.mkdtemp(path.join(output, 'library-'));
  const fixtures = path.join(temp, 'biblioteca'); await fs.cp(path.join(root, 'tests', 'fixtures'), fixtures, { recursive: true });
  const pdf = path.join(fixtures, 'lectura.pdf'), second = path.join(fixtures, 'contrapunto.pdf'), docx = path.join(fixtures, 'ensayos', 'lectura.docx');
  const hash = async file => crypto.createHash('sha256').update(await fs.readFile(file)).digest('hex');
  const original = { pdf: await hash(pdf), docx: await hash(docx) };
  const userData = path.join(temp, 'userdata'); const env = { ...process.env, PLIEGO_TEST_USER_DATA: userData }; delete env.ELECTRON_RUN_AS_NODE;
  if (process.argv.includes('--packaged')) { const { version } = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8')); process.env.PLIEGO_PACKAGED_EXE = path.join(root, 'release', `v${version}`, 'Pliego-win32-x64', 'Pliego.exe'); }
  const launchOptions = process.env.PLIEGO_PACKAGED_EXE ? { executablePath: process.env.PLIEGO_PACKAGED_EXE, args: [pdf] } : { args: [root, pdf] };
  let app = await electron.launch({ ...launchOptions, env, timeout: 45000 });
  let page = await app.firstWindow(); const errors = [], checks = [];
  page.on('pageerror', error => errors.push(error.message));
  const check = (name, passed) => { assert.ok(passed, name); checks.push(name); console.log(`✓ ${name}`); };
  const pick = file => app.evaluate(({ dialog }, file) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] }); }, file);
  const primary = () => page.locator('.pdf-primary');
  try {
    await page.waitForSelector('.pdf-primary .pdf-page[data-rendered=true]', { timeout: 45000 });
    check('PDF canvas and selectable text load locally', await primary().locator('canvas').count() === 1 && await primary().locator('.textLayer span').count() > 5);
    check('PDF headings become navigation', (await page.locator('#outline').textContent()).includes('Otra mirada'));
    await page.screenshot({ path: path.join(output, 'pliego-pdf.png') });
    await page.evaluate(() => {
      const span = [...document.querySelectorAll('.pdf-primary .textLayer span')].find(el => el.textContent.includes('La lectura necesita'));
      const range = document.createRange(); range.selectNodeContents(span);
      const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range);
      span.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    });
    await page.waitForSelector('#pdf-note-form:not([hidden])');
    check('selected text is offered as a quote', (await page.locator('#pdf-note-quote').inputValue()).includes('La lectura necesita tiempo.'));
    await page.locator('#pdf-note-title').fill('Una frase para volver');
    await page.locator('#pdf-note-folio').fill('7');
    await page.locator('#pdf-note-comment').fill('Una observación personal, separada del pasaje.');
    check('note drafts participate in unsaved-change guard', !(await page.locator('#dirty-indicator').isHidden()));
    await page.locator('#new').click(); await page.locator('#add-new').click(); await page.waitForSelector('#unsaved-dialog[open]'); await page.locator('#unsaved-cancel').click();
    check('cancel document switch keeps PDF draft', await page.locator('#pdf-note-comment').inputValue() === 'Una observación personal, separada del pasaje.');
    await page.locator('#pdf-note-save').click();
    await page.waitForSelector('.notebook-entry');
    check('saved quote keeps sheet and manual folio distinct', (await page.locator('.entry-location').first().textContent()).includes('Hoja PDF 1 · folio 7'));
    check('saved quote creates a persistent highlight', await primary().locator('.pdf-highlight').count() > 0);

    await page.locator('#pdf-new-bookmark').click(); await page.locator('#pdf-bookmark-name').fill('Inicio del argumento');
    await page.locator('#pdf-bookmark-form button[type=submit]').click(); await page.waitForFunction(() => document.querySelectorAll('.notebook-entry').length === 2);
    check('named bookmark is saved alongside notes', (await page.locator('#notebook-entries').textContent()).includes('Inicio del argumento'));
    const exported = path.join(temp, 'fichas.md');
    await app.evaluate(({ dialog }, file) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: file }); }, exported);
    await page.locator('#pdf-export').click();
    await page.waitForFunction(() => document.querySelector('#save-state').textContent.includes('exportadas'));
    const markdown = await fs.readFile(exported, 'utf8');
    check('fichas export quote, commentary and distinct locators', markdown.includes('HOJA PDF: 1') && markdown.includes('Folio impreso: 7') && markdown.includes('observación personal') && markdown.includes('cotejar'));
    await page.screenshot({ path: path.join(output, 'pliego-notebook.png') });

    check('PDF comparison is directly available in the main toolbar', await page.locator('.topbar #text-compare').isVisible() && await page.locator('#text-compare').textContent() === 'Dos PDF');
    await pick(second); await page.locator('#text-compare').click();
    await page.waitForFunction(() => document.querySelectorAll('.pdf-page[data-rendered=true]').length === 2);
    check('two independent PDF readers render side by side', await page.locator('.pdf-canvas').count() === 2);
    check('reference is clearly identified', (await page.locator('#pdf-secondary-name').textContent()).includes('referencia'));
    await page.screenshot({ path: path.join(output, 'pliego-compare.png') });
    await page.locator('#pdf-compare-close').click();

    const search = primary().locator('[data-role=search]'); await search.fill('lectura');
    await primary().locator('[data-action=search-next]').click();
    await page.waitForFunction(() => document.querySelector('.pdf-primary [data-role=status]').textContent.includes('coincidencias'));
    check('PDF text search finds multiple pages', (await primary().locator('[data-role=status]').textContent()).includes('2 hojas'));
    const pageInput = primary().locator('[data-role=page]'); await pageInput.fill('3'); await pageInput.press('Enter');
    await page.waitForFunction(() => document.querySelector('.pdf-primary [data-role=status]').textContent.includes('no tiene texto seleccionable'));
    check('scanned page is rendered with explicit no-text status', await primary().locator('canvas').count() === 1 && await primary().locator('.textLayer span').count() === 0);
    await page.locator('#pdf-new-note').click(); await page.locator('#pdf-note-comment').fill('Nota sobre la imagen escaneada.');
    await page.locator('#pdf-note-save').click(); await page.waitForFunction(() => document.querySelectorAll('.notebook-entry').length === 3);
    check('scanned page accepts a page note without invented quote', (await page.locator('.notebook-entry').last().textContent()).includes('Hoja PDF 3'));

    await pick(fixtures); await page.locator('#folder').click(); await page.waitForSelector('.file-item');
    check('explorer lists Markdown PDF Word and plain text', await page.locator('.file-item').count() === 5);
    await page.locator('#folder-favorite').click(); await page.waitForFunction(() => document.querySelector('#folder-favorite').textContent === '★');
    await page.locator('#file-filter').fill('ensayos');
    check('explorer searches relative folder paths', await page.locator('.file-item').count() === 2);
    await page.locator('button[data-type=docx]').click();
    check('explorer filters by document format', await page.locator('.file-item').count() === 1);
    await page.locator('.file-item').click(); await page.waitForFunction(() => document.querySelector('#main').dataset.type === 'docx');
    check('Word preview has heading text and table', (await page.locator('#preview').textContent()).includes('Un documento de Word') && await page.locator('#preview table').count() === 1);
    check('Word preview is read only with format caveat', await page.locator('button[data-mode=edit]').isDisabled() && (await page.locator('#document-notice').textContent()).includes('paginación'));
    await page.locator('#file-favorite').click();
    await page.waitForFunction(() => document.querySelector('#file-favorite').textContent === '★');
    check('favorites include both folder and document', await page.locator('.favorite-row').count() === 2);
    await page.screenshot({ path: path.join(output, 'pliego-library-word.png') });

    await pick(pdf); await page.locator('#open').click(); await page.waitForSelector('.pdf-primary .textLayer span');
    await page.waitForFunction(() => document.querySelectorAll('.notebook-entry').length === 3);
    check('reopening PDF restores notebook and original highlights', await primary().locator('.pdf-highlight').count() > 0);
    check('PDF and Word original bytes are unchanged', await hash(pdf) === original.pdf && await hash(docx) === original.docx);
    await page.setViewportSize({ width: 800, height: 620 });
    check('PDF UI fits a narrow desktop window', await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await page.screenshot({ path: path.join(output, 'pliego-pdf-small.png') });
    check('no renderer runtime errors in document workflow', errors.length === 0);
    await app.close(); app = null;
    app = await electron.launch({ ...launchOptions, env, timeout: 45000 }); page = await app.firstWindow();
    await page.waitForSelector('.pdf-primary .pdf-page[data-rendered=true]');
    await page.waitForFunction(() => document.querySelectorAll('.notebook-entry').length === 3);
    await page.locator('#files-tab').click();
    check('notebooks and favorites survive application restart', await page.locator('.favorite-row').count() === 2 && await page.locator('.notebook-entry').count() === 3);
    const secondInstance = spawn(process.env.PLIEGO_PACKAGED_EXE || require('electron'), process.env.PLIEGO_PACKAGED_EXE ? [pdf] : [root, pdf], { env, windowsHide: true });
    await new Promise((resolve, reject) => { secondInstance.on('error', reject); secondInstance.on('exit', code => code === 0 ? resolve() : reject(new Error(`Second instance exited ${code}`))); });
    await page.waitForSelector('.pdf-primary .pdf-page[data-rendered=true]');
    check('relaunch reuses one window to protect concurrent notebook writes', !page.isClosed() && await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length === 1));
    await page.locator('#pdf-new-note').click(); await page.locator('#pdf-note-comment').fill('Guardado nativo al cerrar el cuaderno.');
    const closed = page.waitForEvent('close');
    await app.evaluate(({ dialog, BrowserWindow }) => { dialog.showMessageBox = async () => ({ response: 0 }); BrowserWindow.getAllWindows()[0].close(); });
    await closed;
    const notebookFile = (await fs.readdir(path.join(userData, 'notebooks'))).find(name => name.endsWith('.json'));
    const notebook = JSON.parse(await fs.readFile(path.join(userData, 'notebooks', notebookFile), 'utf8'));
    check('native Save on close persists PDF draft before exit', notebook.entries.some(entry => entry.note.includes('Guardado nativo al cerrar')));
    await fs.writeFile(path.join(output, process.env.PLIEGO_PACKAGED_EXE ? 'packaged-library-report.json' : 'library-report.json'), JSON.stringify({ passed: checks.length, checks, errors, temp, original }, null, 2));
    await app.close().catch(() => {}); app = null;
  } catch (error) {
    if (app) { await page.screenshot({ path: path.join(output, 'library-failure.png') }).catch(() => {}); await fs.writeFile(path.join(output, 'library-failure.html'), await page.content()).catch(() => {}); }
    throw error;
  } finally { if (app) await app.evaluate(({ app }) => app.exit()).catch(() => {}); }
}
run().catch(error => { console.error(error); process.exitCode = 1; });
