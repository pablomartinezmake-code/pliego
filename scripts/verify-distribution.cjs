const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const asar = require('@electron/asar');
const crypto = require('node:crypto');

const root = path.resolve(__dirname, '..');
const { version } = require(path.join(root, 'package.json'));
const app = path.join(root, 'release', `v${version}`, 'Pliego-win32-x64');
const archive = path.join(app, 'resources', 'app.asar');
const extract = name => asar.extractFile(archive, name.split('/').join(path.sep));
const entries = asar.listPackage(archive).map(name => name.replaceAll('\\', '/'));
const allowedRoots = new Set(['package.json', 'main.cjs', 'preload.cjs', 'file-store.cjs', 'document-store.cjs', 'research-store.cjs', 'LICENSE', 'THIRD_PARTY_NOTICES.md', 'dist', 'assets', 'node_modules', 'third-party-licenses']);
for (const name of entries) {
  const first = name.replace(/^\//, '').split('/')[0];
  assert.ok(allowedRoots.has(first), `Unexpected archive root: ${first}`);
  assert.ok(!/(^|\/)(?:\.git|test-results|SESSION_STATE\.md)(?:\/|$)/i.test(name), `Private artifact in archive: ${name}`);
  assert.ok(!name.endsWith('.map'), `Source map in runtime archive: ${name}`);
}
for (const name of ['Pliego.exe', 'Install-Pliego.ps1', 'LICENSE', 'LICENSE.electron.txt', 'LICENSES.chromium.html', 'THIRD_PARTY_NOTICES.md', 'third-party-licenses/pdfjs-dist/LICENSE']) {
  assert.ok(fs.statSync(path.join(app, name)).size > 0, `Missing distribution file: ${name}`);
}
for (const name of ['dist/pdf-assets/standard_fonts/LICENSE_FOXIT', 'dist/pdf-assets/standard_fonts/LICENSE_LIBERATION', 'dist/pdf-assets/wasm/LICENSE_OPENJPEG']) {
  assert.ok(extract(name).length > 0, `Missing asset license: ${name}`);
}
for (const name of ['main.cjs', 'preload.cjs', 'dist/app.js']) {
  const content = extract(name).toString('utf8');
  assert.ok(!/C:[\\/]+Users[\\/]+pablo|Ateneo-KB|firmar-sin-teclear|Manifiesto \d/i.test(content), `Personal workspace content in ${name}`);
}
const zip = path.join(path.dirname(app), `Pliego-${version}-win32-x64.zip`);
const digest = crypto.createHash('sha256').update(fs.readFileSync(zip)).digest('hex');
const checksum = path.join(path.dirname(app), 'SHA256SUMS.txt');
fs.writeFileSync(checksum, `${digest}  ${path.basename(zip)}\n`);
console.log(`PASS: runtime allowlist, privacy exclusions, license files and asset notices.\nSHA-256 ${digest}`);
