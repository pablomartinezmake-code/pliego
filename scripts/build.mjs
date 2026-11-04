import { build } from 'esbuild';
import { mkdir, copyFile, cp } from 'node:fs/promises';
await mkdir('dist', { recursive: true });
await build({ entryPoints: ['src/app.js'], bundle: true, outfile: 'dist/app.js', format: 'esm', target: 'chrome130', sourcemap: true });
await Promise.all(['index.html', 'style.css'].map(name => copyFile(`src/${name}`, `dist/${name}`)));
await mkdir('dist/pdf-assets', { recursive: true });
await copyFile('node_modules/pdfjs-dist/build/pdf.worker.min.mjs', 'dist/pdf-assets/pdf.worker.min.mjs');
await Promise.all(['cmaps', 'standard_fonts', 'wasm'].map(name => cp(`node_modules/pdfjs-dist/${name}`, `dist/pdf-assets/${name}`, { recursive: true })));
console.log('Pliego: interfaz compilada.');
