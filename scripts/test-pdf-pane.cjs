const { chromium, _electron: electron } = require('playwright');
const { build } = require('esbuild');
const { cp, mkdir, readFile, writeFile } = require('node:fs/promises');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const harness = path.join(root, 'test-results', 'pdf-pane-harness');
const builtAssets = path.join(root, 'dist', 'pdf-assets');

async function main() {
  await mkdir(harness, { recursive: true });
  await build({ entryPoints: [path.join(root, 'src/pdf-pane.js')], bundle: true, format: 'esm', platform: 'browser', target: 'chrome130', outfile: path.join(harness, 'pdf-pane.mjs') });
  if (await exists(builtAssets)) {
    await cp(builtAssets, path.join(harness, 'pdf-assets'), { recursive: true, force: true });
  } else {
    const targetAssets = path.join(harness, 'pdf-assets');
    await mkdir(targetAssets, { recursive: true });
    await cp(path.join(root, 'node_modules/pdfjs-dist/build/pdf.worker.min.mjs'), path.join(targetAssets, 'pdf.worker.min.mjs'));
    for (const name of ['cmaps', 'standard_fonts', 'wasm']) await cp(path.join(root, 'node_modules/pdfjs-dist', name), path.join(targetAssets, name), { recursive: true });
  }
  await writeFile(path.join(harness, 'pdf-pane.css'), await readFile(path.join(root, 'src/pdf-pane.css')));
  await writeFile(path.join(harness, 'index.html'), `<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="pdf-pane.css"><style>html,body,#mount{height:100%;margin:0}</style><div id="mount"></div><script type="module">import {PdfPane} from './pdf-pane.mjs';window.pane=new PdfPane({container:document.querySelector('#mount')});window.ready=new Promise(resolve=>window.pane.callbacks.onReady=resolve);window.errors=[];window.pane.callbacks.onError=e=>window.errors.push(e.message);</script>`);
  await writeFile(path.join(harness, 'package.json'), JSON.stringify({ name: 'pdf-pane-harness', main: 'main.cjs' }));
  const userData = path.join(harness, 'userdata');
  await writeFile(path.join(harness, 'main.cjs'), `const {app,BrowserWindow}=require('electron');app.setPath('userData',${JSON.stringify(userData)});app.whenReady().then(()=>{const w=new BrowserWindow({width:1100,height:850,webPreferences:{contextIsolation:true}});w.loadFile(${JSON.stringify(path.join(harness, 'index.html'))});});`);

  const env = { ...process.env, PLIEGO_TEST_USER_DATA: userData };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({ args: [harness], cwd: root, timeout: 30000, env });
  const page = await app.firstWindow();
  try {
    await page.waitForSelector('.pdf-pane', { timeout: 10000 });
    const bytes = [...await readFile(path.join(root, 'test-results/fixtures/lectura.pdf'))];
    await page.evaluate(data => window.pane.load({ name: 'lectura.pdf', data: new Uint8Array(data) }), bytes);
    await page.evaluate(() => window.ready);
    const first = await page.evaluate(() => ({ canvas: !!document.querySelector('canvas'), rendered: document.querySelector('.pdf-page')?.dataset.rendered === 'true', textCount: document.querySelectorAll('.textLayer span').length, status: document.querySelector('[data-role=status]').textContent, dimensions: [document.querySelector('canvas').width, document.querySelector('canvas').height] }));
    if (!first.canvas || !first.rendered || !first.textCount || first.dimensions.some(n => n < 100)) throw new Error(`Primera hoja no renderizada correctamente: ${JSON.stringify(first)}`);
    await page.screenshot({ path: path.join(harness, 'reader.png') });

    const selected = await page.evaluate(() => {
      const span = document.querySelector('.textLayer span');
      const range = document.createRange(); range.selectNodeContents(span);
      const sel = getSelection(); sel.removeAllRanges(); sel.addRange(range);
      return window.pane.captureSelection();
    });
    if (!selected?.quote || selected.page !== 1 || !selected.rects.length || selected.rects.some(rect => rect.x < 0 || rect.y < 0 || rect.x + rect.width > 1 || rect.y + rect.height > 1)) throw new Error(`Selección inválida: ${JSON.stringify(selected)}`);
    await page.evaluate(() => window.pane.setHighlights([{ page: 2, rects: [{ x: .1, y: .2, width: .25, height: .03 }] }]));
    await page.evaluate(() => window.pane.goTo(2));
    const second = await page.evaluate(() => ({ page: window.pane.page, textCount: document.querySelectorAll('.textLayer span').length, highlightCount: document.querySelectorAll('.pdf-highlight').length }));
    if (second.page !== 2 || !second.textCount || second.highlightCount !== 1) throw new Error(`Segunda hoja o resaltado inválido: ${JSON.stringify(second)}`);
    const hits = await page.evaluate(() => window.pane.search('lectura'));
    if (!hits.some(hit => hit.page === 2)) throw new Error(`Búsqueda no encontró página 2: ${JSON.stringify(hits)}`);
    await page.evaluate(() => window.pane.goTo(3));
    const scan = await page.evaluate(() => ({ page: window.pane.page, textCount: document.querySelectorAll('.textLayer span').length, status: document.querySelector('[data-role=status]').textContent }));
    if (scan.page !== 3 || scan.textCount !== 0 || !scan.status.includes('no tiene texto seleccionable')) throw new Error(`Hoja escaneada no informada: ${JSON.stringify(scan)}`);
    console.log(JSON.stringify({ first, selectionQuote: selected.quote, second, searchHitPages: hits.map(hit => hit.page), scan }, null, 2));
  } finally {
    await page.evaluate(async () => { await window.pane?.destroy(); });
    await app.close();
  }
}

async function exists(file) {
  try { await readFile(path.join(file, 'pdf.worker.min.mjs')); return true; } catch { return false; }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
