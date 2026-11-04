// Fotografía docs/images/portada.html y la guarda como docs/images/portada.png (1280×640 a doble densidad).
// Uso: node scripts/render-cover.cjs   (usa el Chromium de Playwright o, si falta, Edge)
const { chromium } = require('playwright');
const path = require('node:path');

async function main() {
  const root = path.resolve(__dirname, '..');
  const browser = await chromium.launch().catch(() => chromium.launch({ channel: 'msedge' }));
  try {
    // Sin ventana: el tamaño no depende de la pantalla del equipo.
    const page = await browser.newPage({ viewport: { width: 1280, height: 640 }, deviceScaleFactor: 2 });
    await page.goto('file:///' + path.join(root, 'docs', 'images', 'portada.html').replace(/\\/g, '/'));
    await page.evaluate(() => document.fonts.ready);
    const out = path.join(root, 'docs', 'images', 'portada.png');
    await page.screenshot({ path: out });
    console.log(`Portada: ${out}`);
  } finally {
    await browser.close();
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
