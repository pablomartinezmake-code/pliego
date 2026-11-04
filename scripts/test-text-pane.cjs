const { _electron: electron } = require('playwright');
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const esbuild = require('esbuild');

async function run() {
  const root = path.resolve(__dirname, '..');
  const output = path.join(root, 'test-results');
  await fs.mkdir(output, { recursive: true });
  const temp = await fs.mkdtemp(path.join(output, 'text-pane-'));
  const primary = path.join(temp, 'Primario.md');
  const reference = path.join(temp, 'Version alternativa.md');
  const harnessRoot = path.join(temp, 'snapshot-harness');
  await fs.mkdir(harnessRoot);
  await fs.writeFile(path.join(harnessRoot, 'package.json'), JSON.stringify({ name: 'pliego-text-pane-test', version: '1.0.0', main: 'main.cjs' }));
  await fs.writeFile(path.join(harnessRoot, 'main.cjs'), "const { app, BrowserWindow } = require('electron'); const path = require('node:path'); app.whenReady().then(() => { const win = new BrowserWindow({ width: 900, height: 700, webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true } }); win.loadFile(path.join(__dirname, 'index.html')); });\n");
  await fs.writeFile(path.join(harnessRoot, 'index.html'), '<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'self\'; script-src \'self\'; style-src \'self\' \'unsafe-inline\'"><div id="test-root"></div><script src="./pane-harness.js"></script>');
  await esbuild.build({ entryPoints: [path.join(root, 'src', 'text-pane.js')], bundle: true, format: 'iife', globalName: 'TextPaneTestModule', target: 'chrome130', footer: { js: 'window.TextPaneHarness = TextPaneTestModule;' }, outfile: path.join(harnessRoot, 'pane-harness.js') });
  const bom = Buffer.from([0xef, 0xbb, 0xbf]);
  const original = '# Versión dos\r\n\r\nUna frase de referencia con calma.\r\n\r\nUna nota[^1].\r\n\r\n[^1]: Nota local del segundo texto.\r\n\r\n<script>window.__paneInjected = true</script>\r\n\r\n<img src=x onerror="window.__paneInjected = true">\r\n\r\n[enlace peligroso](javascript:alert(1))\r\n';
  await fs.writeFile(primary, '# Versión uno\r\n\r\nTexto principal.\r\n');
  await fs.writeFile(reference, Buffer.concat([bom, Buffer.from(original)]));
  const env = { ...process.env, PLIEGO_TEST_USER_DATA: path.join(temp, 'userdata') };
  delete env.ELECTRON_RUN_AS_NODE;
  let app, harnessApp;
  const errors = [];
  const checks = [];
  const check = (name, value) => { assert.ok(value, name); checks.push(name); console.log(`✓ ${name}`); };
  try {
    app = await electron.launch({ args: [root, primary, reference], env, timeout: 45000 });
    const page = await app.firstWindow();
    page.on('pageerror', error => errors.push(error.message));
    const pane = page.locator('.text-reference-pane');
    await pane.waitFor();
    await page.waitForFunction(() => document.querySelector('.text-reference-pane [data-role=title]')?.textContent === 'Version alternativa.md');
    check('second CLI document opens in the independent pane', (await pane.locator('[data-role=prose] h1').textContent()) === 'Versión dos');
    check('BOM and CRLF source displays as valid Markdown', await pane.locator('[data-role=prose]').textContent().then(text => text.includes('Una frase de referencia') && text.includes('Nota local del segundo texto')));
    check('rendered Markdown blocks unsafe content', await page.evaluate(() => !window.__paneInjected && !document.querySelector('.text-reference-pane script,.text-reference-pane [onerror],.text-reference-pane a[href^="javascript:"]')));
    check('footnote reference and target stay within second pane', await pane.locator('a[href="#footnote-1"]').count() === 1 && await pane.locator('li#footnote-1').count() === 1);

    await pane.locator('[data-role=reader]').click();
    await page.keyboard.press('Control+f');
    await pane.locator('[data-role=query]').fill('frase de referencia');
    check('search is scoped to the secondary reader', (await pane.locator('[data-role=count]').textContent()).includes('1 de 1'));
    await pane.locator('[data-action=find-close]').click();

    await pane.locator('[data-action=toggle]').click();
    const editor = pane.locator('.cm-content');
    await editor.click(); await page.keyboard.press('Control+End'); await page.keyboard.type('\nUna corrección del segundo documento.');
    await pane.locator('[data-action=save]').click();
    await page.waitForFunction(() => document.querySelector('.text-reference-pane [data-role=dot]')?.hidden === true);
    const saved = await fs.readFile(reference);
    check('secondary save preserves UTF-8 BOM', saved.subarray(0, 3).equals(bom));
    check('secondary save preserves CRLF', saved.subarray(3).toString().includes('\r\nUna corrección del segundo documento.'));

    await editor.click(); await page.keyboard.press('Control+End'); await page.keyboard.type('\nCambio pendiente que no debe perderse.');
    const external = Buffer.from('# Cambio externo\r\n');
    await fs.writeFile(reference, external);
    await pane.locator('[data-action=save]').click();
    await page.waitForFunction(() => document.querySelector('#toast')?.textContent.includes('cambió fuera'));
    check('failed secondary save retains its dirty buffer', await pane.locator('[data-role=dot]').isVisible() && (await editor.textContent()).includes('Cambio pendiente que no debe perderse.'));
    check('failed secondary save does not overwrite external edit', (await fs.readFile(reference)).equals(external));
    check('no renderer runtime errors', errors.length === 0);
    await page.evaluate(() => window.pliego.setDirty(false));
    await app.close(); app = null;

    harnessApp = await electron.launch({ args: [harnessRoot], env, timeout: 45000 });
    const harnessPage = await harnessApp.firstWindow();
    harnessPage.on('pageerror', error => errors.push(error.message));
    await harnessPage.waitForFunction(() => Boolean(window.TextPaneHarness?.TextPane));
    const snapshot = await harnessPage.evaluate(async () => {
      const container = document.querySelector('#test-root');
      const pane = new window.TextPaneHarness.TextPane({ container, api: { saveFile: payload => new Promise(resolve => { window.__snapshotPayload = payload; window.__resolveSnapshotSave = resolve; }) } });
      await pane.load({ type: 'md', path: 'synthetic.md', name: 'Sintético', text: '# Original\r\n', revision: 'r1', eol: '\r\n', bom: false });
      pane.setMode('edit'); pane.view.dispatch({ changes: { from: pane.view.state.doc.length, insert: ' guardado' } });
      const pending = pane.save();
      pane.view.dispatch({ changes: { from: pane.view.state.doc.length, insert: ' posterior' } });
      window.__resolveSnapshotSave({ type: 'md', path: 'synthetic.md', name: 'Sintético', revision: 'r2', eol: '\r\n', bom: false });
      await pending;
      const result = { dirty: pane.dirty, payloadText: window.__snapshotPayload.text, liveText: pane.view.state.doc.toString() };
      pane.destroy(); delete window.__snapshotPayload; delete window.__resolveSnapshotSave;
      return result;
    });
    check('editing during pending save keeps the newer buffer dirty', snapshot.dirty && snapshot.payloadText.includes('guardado') && !snapshot.payloadText.includes('posterior') && snapshot.liveText.includes('posterior'));
    check('no renderer runtime errors', errors.length === 0);
    await fs.writeFile(path.join(output, 'text-pane-report.json'), JSON.stringify({ checks, errors, passed: checks.length, temp }, null, 2));
    await harnessApp.close(); harnessApp = null;
  } catch (error) {
    if (app) {
      const page = await app.firstWindow();
      await page.screenshot({ path: path.join(output, 'text-pane-failure.png') });
      await fs.writeFile(path.join(output, 'text-pane-failure.html'), await page.content());
    }
    throw error;
  } finally {
    if (app) { try { await app.evaluate(({ app }) => app.exit()); } catch {} }
    if (harnessApp) { try { await harnessApp.evaluate(({ app }) => app.exit()); } catch {} }
  }
}
run().catch(error => { console.error(error); process.exitCode = 1; });
