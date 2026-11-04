const { _electron: electron } = require('playwright');
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');

async function run() {
  const root = path.resolve(__dirname, '..');
  const output = path.join(root, 'test-results');
  await fs.mkdir(output, { recursive: true });
  const temp = await fs.mkdtemp(path.join(output, 'packaged-'));
  const env = { ...process.env, PLIEGO_TEST_USER_DATA: path.join(temp, 'userdata') };
  delete env.ELECTRON_RUN_AS_NODE;
  const { version } = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
  const executablePath = path.join(root, 'release', `v${version}`, 'Pliego-win32-x64', 'Pliego.exe');
  let app = await electron.launch({ executablePath, args: [], env, timeout: 45000 });
  const checks = [];
  const check = (name, value) => { assert.ok(value, name); checks.push(name); console.log(`✓ ${name}`); };
  try {
    const page = await app.firstWindow();
    await page.waitForSelector('#preview h1');
    check('portable executable opens the welcome document', await page.locator('#preview h1').textContent() === 'Un lugar para leer.');
    await page.screenshot({ path: path.join(output, 'pliego-welcome.png') });
    await page.locator('button[data-mode="edit"]').click();
    const content = page.locator('.cm-content');
    await content.click(); await page.keyboard.press('Control+End'); await page.keyboard.type('\nUna prueba del ejecutable.');
    await page.waitForFunction(() => !document.querySelector('#dirty-indicator').hidden);
    await app.evaluate(({ dialog, BrowserWindow }) => {
      dialog.showMessageBox = async () => ({ response: 2 });
      BrowserWindow.getAllWindows()[0].close();
    });
    await page.waitForTimeout(150);
    check('native Cancel keeps unsaved window open', !page.isClosed());

    const target = path.join(temp, 'guardado-nativo.md');
    await app.evaluate(({ dialog }, target) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: target });
    }, target);
    await page.locator('#save').click();
    await page.waitForFunction(() => document.querySelector('#dirty-indicator').hidden);
    check('Save dialog destination is actually written', (await fs.readFile(target, 'utf8')).includes('Una prueba del ejecutable.'));

    const second = path.join(temp, 'segundo.md'); await fs.writeFile(second, '# Otro archivo\n\nUna lectura diferente.\n');
    await app.evaluate(({ dialog }, second) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [second] }); }, second);
    await page.locator('#open').click();
    await page.waitForFunction(() => document.querySelector('#doc-name').textContent === 'segundo.md');
    check('native Open replaces document through guarded transition', await page.locator('#preview h1').textContent() === 'Otro archivo');
    await page.locator('button[data-mode="edit"]').click();
    await content.click(); await page.keyboard.press('Control+End'); await page.keyboard.type('\nGuardado al cerrar.');
    await page.waitForFunction(() => !document.querySelector('#dirty-indicator').hidden);
    const closed = page.waitForEvent('close');
    await Promise.race([closed, app.evaluate(({ dialog, BrowserWindow }) => { dialog.showMessageBox = async () => ({ response: 0 }); BrowserWindow.getAllWindows()[0].close(); })]);
    await closed;
    check('native Save on close writes before destroying window', (await fs.readFile(second, 'utf8')).includes('Guardado al cerrar.'));
    await fs.writeFile(path.join(output, 'packaged-report.json'), JSON.stringify({ passed: checks.length, checks, executablePath, temp }, null, 2));
    await app.close().catch(() => {}); app = null;
  } finally {
    if (app) await app.evaluate(({ app }) => app.exit()).catch(() => {});
  }
}
run().catch(error => { console.error(error); process.exitCode = 1; });
