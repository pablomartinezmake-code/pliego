const { _electron: electron } = require('playwright');
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');

async function run() {
  const root = path.resolve(__dirname, '..'), output = path.join(root, 'test-results');
  await fs.mkdir(output, { recursive: true });
  const temp = await fs.mkdtemp(path.join(output, 'two-texts-'));
  const left = path.join(temp, 'borrador.md'), right = path.join(temp, 'version-dos.md');
  const paragraphs = Array.from({ length: 35 }, (_, i) => `Un párrafo para leer con calma, número ${i + 1}.\n\n`).join('');
  const originalLeft = Buffer.from(`# Primera versión\n\n${paragraphs}`);
  const originalRight = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(`# Segunda versión\r\n\r\n${paragraphs.replace(/\n/g, '\r\n')}`)]);
  await fs.writeFile(left, originalLeft); await fs.writeFile(right, originalRight);
  const env = { ...process.env, PLIEGO_TEST_USER_DATA: path.join(temp, 'userdata') }; delete env.ELECTRON_RUN_AS_NODE;
  const { version } = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
  const packaged = process.argv.includes('--packaged');
  const options = packaged ? { executablePath: path.join(root, 'release', `v${version}`, 'Pliego-win32-x64', 'Pliego.exe'), args: [] } : { args: [root] };
  let app = await electron.launch({ ...options, env, timeout: 45000 }); const page = await app.firstWindow();
  const errors = [], checks = []; page.on('pageerror', e => errors.push(e.message));
  const check = (name, value) => { assert.ok(value, name); checks.push(name); console.log(`✓ ${name}`); };
  const ref = () => page.locator('#text-reference');
  const rightEditor = () => ref().locator('.cm-content');
  const leftEditor = () => page.locator('#editor .cm-content');
  const append = async (editor, text) => { await editor.click(); await page.keyboard.press('Control+End'); await page.keyboard.type(text); };
  const read = file => fs.readFile(file, 'utf8');
  try {
    await page.waitForSelector('#preview h1');
    check('two-text action is directly available beside Open in the main toolbar', await page.locator('.topbar #text-compare').isVisible());
    for (const width of [760, 900, 1180]) {
      await app.evaluate(({ BrowserWindow }, width) => BrowserWindow.getAllWindows()[0].setContentSize(width, 720), width);
      const usable = await page.locator('#text-compare').evaluate(button => {
        const box = button.getBoundingClientRect();
        return box.width > 0 && box.left >= 0 && box.right <= innerWidth && document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2) === button;
      });
      check(`two-text button stays visible and clickable at ${width}px`, usable);
    }
    await page.locator('#new').click();
    check('plus opens a menu without replacing the document', await page.locator('#add-menu').isVisible() && await page.locator('#doc-name').textContent() === 'Bienvenido a Pliego');
    await page.screenshot({ path: path.join(output, 'pliego-plus-menu.png') });
    await page.keyboard.press('Escape');
    check('Escape closes menu and restores button focus', await page.locator('#add-menu').isHidden() && await page.evaluate(() => document.activeElement.id === 'new'));
    await app.evaluate(({ dialog }, file) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] }); }, left);
    await page.locator('#new').click(); await page.locator('#add-open').click();
    await page.waitForFunction(() => document.querySelector('#doc-name').textContent === 'borrador.md');
    check('Open here loads the selected file in the main panel', await page.locator('#text-reference').isHidden());
    await page.locator('#new').click(); await page.locator('#doc-name').click();
    check('clicking outside closes the add menu', await page.locator('#add-menu').isHidden());
    await app.evaluate(({ dialog }, file) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] }); }, right);
    await page.locator('#new').click(); await page.keyboard.press('ArrowDown'); await page.keyboard.press('Enter');
    await page.waitForSelector('#text-reference [data-role=prose] h1');
    check('Open alongside from plus loads the second text using keyboard', await page.locator('#preview h1').textContent() === 'Primera versión' && await ref().locator('[data-role=prose] h1').textContent() === 'Segunda versión');
    check('each pane shows its own filename and path', await page.locator('#doc-name').textContent() === 'borrador.md' && await ref().locator('[data-role=title]').textContent() === 'version-dos.md' && (await ref().locator('[data-role=path]').textContent()).endsWith('version-dos.md'));
    await page.evaluate(() => { document.querySelector('#text-reference [data-role=reader]').scrollTop = 800; });
    await page.waitForFunction(() => document.querySelector('#text-reference [data-role=reader]').scrollTop > 0);
    check('reading scroll is independent in each pane', await page.evaluate(() => document.querySelector('#reader-pane').scrollTop === 0 && document.querySelector('#text-reference [data-role=reader]').scrollTop > 0));
    await page.screenshot({ path: path.join(output, 'pliego-two-texts.png') });
    await ref().locator('[data-role=reader]').click(); await page.keyboard.press('Control+f');
    await ref().locator('[data-role=query]').fill('calma');
    check('Ctrl F searches the focused second text', (await ref().locator('[data-role=count]').textContent()).includes('35'));
    await ref().locator('[data-action=find-close]').click();

    await ref().locator('[data-action=toggle]').click();
    await append(rightEditor(), '\nRetoque de la derecha.'); await page.keyboard.press('Control+s');
    await page.waitForFunction(() => document.querySelector('#text-reference [data-role=dot]').hidden);
    const savedRight = await fs.readFile(right);
    check('Ctrl S saves only the focused right document', (await read(right)).includes('Retoque de la derecha.') && (await fs.readFile(left)).equals(originalLeft));
    check('right document preserves UTF-8 BOM and CRLF', savedRight.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])) && savedRight.toString().includes('\r\nRetoque de la derecha.'));
    await page.locator('.mode-switch button[data-mode=edit]').click();
    check('each document switches read or edit independently', await page.locator('#main').getAttribute('data-mode') === 'edit' && await ref().locator('.text-reference-pane').getAttribute('data-mode') === 'edit');
    await append(leftEditor(), '\nRetoque de la izquierda.'); await page.locator('#save').click();
    await page.waitForFunction(() => document.querySelector('#dirty-indicator').hidden);
    check('primary Save targets the left document', (await read(left)).includes('Retoque de la izquierda.') && (await fs.readFile(right)).equals(savedRight));

    await append(rightEditor(), '\nPendiente a la derecha.');
    await ref().locator('[data-action=close]').click(); await page.waitForSelector('#unsaved-dialog[open]'); await page.locator('#unsaved-cancel').click();
    check('closing second panel asks before losing its edits', await ref().isVisible() && (await rightEditor().textContent()).includes('Pendiente a la derecha.'));

    const external = Buffer.from('# Cambio desde otro programa\r\n'); await fs.writeFile(right, external);
    await ref().locator('[data-action=save]').click();
    await page.waitForFunction(() => document.querySelector('#toast').textContent.includes('cambió fuera'));
    check('right save rejects external change and retains draft', (await fs.readFile(right)).equals(external) && await ref().locator('[data-role=dot]').isVisible());
    await append(leftEditor(), '\nGuardar primero no debe borrar el segundo.');
    await app.evaluate(({ dialog, BrowserWindow }) => { dialog.showMessageBox = async () => ({ response: 0 }); BrowserWindow.getAllWindows()[0].close(); });
    await page.waitForFunction(() => document.querySelector('#toast').textContent.includes('pendientes siguen abiertos'));
    await page.waitForFunction(() => document.querySelector('#dirty-indicator').hidden);
    check('failed native save-all keeps unsaved right document open', !page.isClosed() && (await read(left)).includes('Guardar primero no debe borrar el segundo.') && (await fs.readFile(right)).equals(external));
    await ref().locator('[data-action=close]').click(); await page.locator('#unsaved-discard').click();
    await page.waitForFunction(() => document.querySelector('#text-reference').hidden);
    check('discard after failed close-save does not unexpectedly close app', !page.isClosed());

    await app.evaluate(({ dialog }, file) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] }); }, right);
    await page.locator('#text-compare').click(); await page.waitForSelector('#text-reference [data-role=prose] h1');
    await ref().locator('[data-action=toggle]').click(); await append(rightEditor(), '\nGuardado derecho al cerrar.');
    await page.locator('.mode-switch button[data-mode=edit]').click();
    await append(leftEditor(), '\nGuardado izquierdo al cerrar.');
    const closed = page.waitForEvent('close');
    await Promise.race([closed, app.evaluate(({ dialog, BrowserWindow }) => { dialog.showMessageBox = async () => ({ response: 0 }); BrowserWindow.getAllWindows()[0].close(); })]); await closed;
    check('native Save on close writes both documents to their own paths', (await read(left)).includes('Guardado izquierdo al cerrar.') && (await read(right)).includes('Guardado derecho al cerrar.'));
    check('two-text workflow has no renderer errors', errors.length === 0);
    await fs.writeFile(path.join(output, packaged ? 'packaged-two-texts-report.json' : 'two-texts-report.json'), JSON.stringify({ checks, passed: checks.length, errors, temp }, null, 2));
    await app.close().catch(() => {}); app = null;
  } catch (error) {
    if (app && !page.isClosed()) { await page.screenshot({ path: path.join(output, 'two-texts-failure.png') }); await fs.writeFile(path.join(output, 'two-texts-failure.html'), await page.content()); }
    throw error;
  } finally { if (app) await app.evaluate(({ app }) => app.exit()).catch(() => {}); }
}
run().catch(error => { console.error(error); process.exitCode = 1; });
