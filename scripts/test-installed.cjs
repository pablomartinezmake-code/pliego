const { _electron: electron } = require('playwright');
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');

async function main() {
  const executablePath = process.argv[2];
  assert.ok(executablePath && path.isAbsolute(executablePath), 'Pass the absolute installed Pliego.exe path');
  const output = path.resolve(__dirname, '..', 'test-results');
  await fs.mkdir(output, { recursive: true });
  const temp = await fs.mkdtemp(path.join(output, 'installed-'));
  const left = path.join(temp, 'borrador.md');
  const right = path.join(temp, 'revision.md');
  await fs.writeFile(left, '# Primera versión\n\nUna lectura local.\n');
  await fs.writeFile(right, '# Segunda versión\n\nOtra lectura local.\n');
  const originalLeft = await fs.readFile(left);
  const originalRight = await fs.readFile(right);
  const env = { ...process.env, PLIEGO_TEST_USER_DATA: path.join(temp, 'profile') };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({ executablePath, args: [left], env });
  try {
    const page = await app.firstWindow();
    await page.waitForSelector('#preview h1');
    assert.equal(await page.locator('#preview h1').textContent(), 'Primera versión');
    assert.ok(await page.locator('.topbar #text-compare').isVisible());
    await app.evaluate(({ dialog }, file) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] }); }, right);
    await page.locator('#text-compare').click();
    await page.waitForSelector('#text-reference [data-role=prose] h1');
    assert.equal(await page.locator('#text-reference [data-role=prose] h1').textContent(), 'Segunda versión');
    assert.deepEqual(await fs.readFile(left), originalLeft);
    assert.deepEqual(await fs.readFile(right), originalRight);
    console.log('PASS: installed executable opens Markdown, shows the two-text action and loads the second panel without changing either document.');
  } finally { await app.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
