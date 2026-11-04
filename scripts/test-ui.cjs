const { _electron: electron } = require('playwright');
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');

async function run() {
  const root = path.resolve(__dirname, '..');
  const output = path.join(root, 'test-results');
  await fs.mkdir(output, { recursive: true });
  const temp = await fs.mkdtemp(path.join(output, 'run-'));
  const file = path.join(temp, 'Lectura con tildes.md');
  const source = '# Una lectura propia\r\n\r\nUn párrafo con **énfasis** y una idea abierta.\r\n\r\n## Otra sección\r\n\r\nUna nota[^1] y un [enlace][web].\r\n\r\n[^1]: Una nota al pie.\r\n\r\n[web]: https://example.com\r\n';
  const original = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(source)]);
  await fs.writeFile(file, original);
  const env = { ...process.env, PLIEGO_TEST_USER_DATA: path.join(temp, 'userdata') };
  delete env.ELECTRON_RUN_AS_NODE;
  let app;
  const errors = [], checks = [];
  const check = (name, value) => { assert.ok(value, name); checks.push(name); console.log(`✓ ${name}`); };
  try {
    app = await electron.launch({ args: [root, file], env, timeout: 45000 });
    const page = await app.firstWindow();
    page.on('pageerror', error => errors.push(error.message));
    await page.waitForSelector('#preview h1');
    await page.waitForFunction(() => document.querySelector('#doc-name').textContent === 'Lectura con tildes.md');
    check('argv opens the real local UTF-8 document', (await page.locator('#preview h1').textContent()) === 'Una lectura propia');
    check('footnotes render with working target', await page.locator('#preview #footnote-1').count() === 1);
    check('reference links resolve across paragraphs', await page.locator('#preview a[href="https://example.com"]').count() === 1);
    check('native bridge does not expose Node', await page.evaluate(() => typeof window.require === 'undefined' && typeof window.process === 'undefined'));
    await page.screenshot({ path: path.join(output, 'pliego-paper.png') });

    await page.locator('#settings-toggle').click();
    await page.locator('button[data-theme="night"]').click();
    check('night reading theme works', await page.locator('html').getAttribute('data-theme') === 'night');
    await page.screenshot({ path: path.join(output, 'pliego-night.png') });
    await page.locator('button[data-theme="paper"]').click();
    await page.locator('#settings-close').click();

    await page.locator('#find-toggle').click();
    await page.locator('#find-input').fill('lectura');
    check('reading search finds text', (await page.locator('#find-count').textContent()).includes('1 coincidencias'));
    await page.locator('#find-next').click();
    check('reading search navigates results', await page.locator('#find-count').textContent() === '1 de 1');
    await page.locator('#find-close').click();

    await page.locator('#preview p').first().dblclick();
    check('double click enters split editing at passage', await page.locator('#main').getAttribute('data-mode') === 'split');
    const editor = page.locator('.cm-content');
    await editor.click();
    await page.keyboard.press('Control+End');
    await page.keyboard.type('\nTexto corregido con cuidado.');
    await page.waitForFunction(() => !document.querySelector('#dirty-indicator').hidden);
    check('editing marks document dirty', await page.locator('#save-state').textContent() === 'Cambios sin guardar');
    await page.waitForFunction(() => document.querySelector('#preview').textContent.includes('Texto corregido con cuidado.'));
    await page.locator('#save').click();
    await page.waitForFunction(() => document.querySelector('#dirty-indicator').hidden);
    const saved = await fs.readFile(file);
    check('native save preserves UTF-8 BOM', saved.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])));
    check('native save preserves CRLF', saved.subarray(3).toString().includes('\r\nTexto corregido con cuidado.'));
    const backups = await fs.readdir(path.join(temp, 'userdata', 'backups'));
    check('previous version has a recoverable backup', (await fs.readFile(path.join(temp, 'userdata', 'backups', backups[0]))).equals(original));
    await page.screenshot({ path: path.join(output, 'pliego-split.png') });

    await editor.click(); await page.keyboard.press('Control+End'); await page.keyboard.type(' Un cambio pendiente.');
    await page.locator('#new').click(); await page.locator('#add-new').click();
    await page.waitForSelector('#unsaved-dialog[open]');
    check('switching documents protects unsaved changes', await page.locator('#unsaved-dialog').isVisible());
    await page.locator('#unsaved-cancel').click();
    check('cancel keeps the edited document', await page.locator('#doc-name').textContent() === 'Lectura con tildes.md');

    const external = Buffer.from('# Editado afuera\r\n');
    await fs.writeFile(file, external);
    await page.locator('#save').click();
    await page.waitForFunction(() => document.querySelector('#toast').textContent.includes('cambió fuera'));
    check('save rejects concurrent external changes', (await fs.readFile(file)).equals(external));
    check('save failure retains dirty state and text', !(await page.locator('#dirty-indicator').getAttribute('hidden')) && (await editor.textContent()).includes('Un cambio pendiente.'));

    await page.locator('#new').click(); await page.locator('#add-new').click(); await page.locator('#unsaved-discard').click();
    await page.waitForFunction(() => document.querySelector('#doc-name').textContent === 'Sin título.md');
    const malicious = '# Documento de prueba\n\n<script>window.__injected=true</script>\n\n<img src=x onerror="window.__injected=true">\n\n[mal](javascript:alert(1))';
    await page.evaluate(text => { const el = document.querySelector('.cm-content'); el.focus(); document.execCommand('insertText', false, text); }, malicious);
    await page.waitForFunction(() => document.querySelector('#preview h1')?.textContent === 'Documento de prueba');
    check('Markdown cannot execute scripts or handlers', await page.evaluate(() => !window.__injected && !document.querySelector('#preview script,#preview [onerror],#preview a[href^="javascript:"]')));

    await page.setViewportSize({ width: 800, height: 620 });
    await page.locator('button[data-mode="read"]').click();
    check('small window has no horizontal document overflow', await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await page.screenshot({ path: path.join(output, 'pliego-small.png') });
    check('no renderer runtime errors', errors.length === 0);
    await fs.writeFile(path.join(output, 'ui-report.json'), JSON.stringify({ checks, errors, passed: checks.length, temp }, null, 2));
    // Clear dirty in this isolated test session before closing the test window.
    await page.evaluate(() => window.pliego.setDirty(false));
    await app.close(); app = null;
  } catch (error) {
    if (app) { const page = await app.firstWindow(); await page.screenshot({ path: path.join(output, 'failure.png') }); await fs.writeFile(path.join(output, 'failure.html'), await page.content()); }
    throw error;
  } finally {
    if (app) { try { await app.evaluate(({ app }) => app.exit()); } catch {} }
  }
}
run().catch(error => { console.error(error); process.exitCode = 1; });
