const { _electron: electron } = require('playwright');
const fs = require('node:fs/promises');
const path = require('node:path');

async function main() {
  const root = path.resolve(__dirname, '..');
  const output = path.join(root, 'docs', 'images');
  await fs.mkdir(output, { recursive: true });
  await fs.mkdir(path.join(root, 'test-results'), { recursive: true });
  const profile = await fs.mkdtemp(path.join(root, 'test-results', 'demo-'));
  const env = { ...process.env, PLIEGO_TEST_USER_DATA: profile };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({ args: [root, path.join(root, 'examples', 'borrador.md'), path.join(root, 'examples', 'revision.md')], env });
  try {
    const page = await app.firstWindow();
    await page.waitForSelector('#text-reference [data-role=prose] h1');
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1180, 780));
    // Omit local filesystem paths in the public demonstration screenshot.
    await page.addStyleTag({ content: '#doc-path,[data-role=path]{visibility:hidden!important}' });
    await page.evaluate(() => document.activeElement?.blur());
    await page.screenshot({ path: path.join(output, 'dos-textos.png') });
    console.log('Saved public demonstration screenshot using synthetic examples.');
  } finally {
    await app.close();
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
