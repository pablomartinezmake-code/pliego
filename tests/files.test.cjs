const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { FileStore } = require('../file-store.cjs');

async function fixture() {
  const root = await fs.mkdtemp(path.join(__dirname, '.pliego-test-'));
  const userData = path.join(root, 'userdata');
  await fs.mkdir(userData);
  const docPath = path.join(root, 'texto.md');
  const bytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('uno\r\ndos\r\n', 'utf8')]);
  await fs.writeFile(docPath, bytes);
  return { root, userData, docPath, bytes, store: new FileStore(userData), cleanup: () => fs.rm(root, { recursive: true, force: true }) };
}

test('preserves UTF-8 BOM and CRLF on save, returning updated revision', async t => {
  const f = await fixture(); t.after(f.cleanup);
  const doc = await f.store.open(f.docPath);
  assert.equal(doc.text, 'uno\r\ndos\r\n');
  assert.equal(doc.bom, true); assert.equal(doc.eol, '\r\n');
  const saved = await f.store.save({ path: doc.path, text: 'uno\ndos editado\n', revision: doc.revision });
  const raw = await fs.readFile(f.docPath);
  assert.deepEqual(raw.subarray(0, 3), Buffer.from([0xef, 0xbb, 0xbf]));
  assert.equal(raw.subarray(3).toString('utf8'), 'uno\r\ndos editado\r\n');
  assert.notEqual(saved.revision, doc.revision);
});

test('rejects an external edit and leaves the external bytes intact', async t => {
  const f = await fixture(); t.after(f.cleanup);
  const doc = await f.store.open(f.docPath);
  const external = Buffer.from('otro proceso\r\n'); await fs.writeFile(f.docPath, external);
  await assert.rejects(f.store.save({ path: doc.path, text: 'cambio', revision: doc.revision }), /cambió fuera/);
  assert.deepEqual(await fs.readFile(f.docPath), external);
});

test('keeps a recoverable previous-version backup before replacement', async t => {
  const f = await fixture(); t.after(f.cleanup);
  const doc = await f.store.open(f.docPath);
  await f.store.save({ path: doc.path, text: 'nuevo', revision: doc.revision });
  const backups = await fs.readdir(path.join(f.userData, 'backups'));
  assert.equal(backups.length, 1);
  assert.deepEqual(await fs.readFile(path.join(f.userData, 'backups', backups[0])), f.bytes);
});

test('blocks arbitrary paths and rejects invalid UTF-8 without replacement', async t => {
  const f = await fixture(); t.after(f.cleanup);
  const outside = path.join(f.root, 'ajeno.md'); await fs.writeFile(outside, 'privado');
  await assert.rejects(f.store.read(outside), /Primero abrí/);
  const bad = path.join(f.root, 'malo.md'); await fs.writeFile(bad, Buffer.from([0xc3, 0x28]));
  await assert.rejects(f.store.open(bad), /UTF-8 válido/);
});

test('folder listing is bounded, markdown-only and does not follow symlinks', async t => {
  const f = await fixture(); t.after(f.cleanup);
  const dir = path.join(f.root, 'coleccion'); await fs.mkdir(dir);
  await fs.writeFile(path.join(dir, 'a.md'), '# A');
  await fs.writeFile(path.join(dir, 'oculto.txt'), 'x');
  await fs.mkdir(path.join(dir, '.oculta'));
  await fs.writeFile(path.join(dir, '.oculta', 'no.md'), '# no');
  const listing = await f.store.listFolder(dir);
  assert.deepEqual(listing.files.map(x => x.name), ['a.md']);
  assert.equal((await f.store.read(path.join(dir, 'a.md'))).text, '# A');
});

test('asset URLs require an authorized Markdown document and stay inside its folder', async t => {
  const f = await fixture(); t.after(f.cleanup);
  const doc = await f.store.open(f.docPath);
  const imagePath = path.join(f.root, 'cover image.png'); await fs.writeFile(imagePath, 'image');
  const href = await f.store.assetUrl(doc.path, 'cover image.png');
  assert.match(href, /^file:/);
  assert.equal(await f.store.assetUrl(doc.path, '../ajeno.png'), null);
  await assert.rejects(f.store.assetUrl(path.join(f.root, 'ajeno.md'), 'x.png'), /Primero abrí/);
  assert.equal(await f.store.assetUrl(doc.path, 'cover%20image.png'), href);
  assert.equal(await f.store.assetUrl(doc.path, 'texto.md'), null);
});

test('Save As carries the source BOM and line ending to a new Markdown file', async t => {
  const f = await fixture(); t.after(f.cleanup);
  const doc = await f.store.open(f.docPath);
  const destination = path.join(f.root, 'copia.markdown');
  const saved = await f.store.saveAs(destination, 'tres\ncuatro\n', undefined, { eol: doc.eol, bom: doc.bom });
  const raw = await fs.readFile(destination);
  assert.deepEqual(raw.subarray(0, 3), Buffer.from([0xef, 0xbb, 0xbf]));
  assert.equal(raw.subarray(3).toString('utf8'), 'tres\r\ncuatro\r\n');
  assert.equal(saved.name, 'copia.markdown');
});

test('serializes concurrent writes to one path and detects the stale second revision', async t => {
  const f = await fixture(); t.after(f.cleanup);
  const doc = await f.store.open(f.docPath);
  const writes = await Promise.allSettled([
    f.store.save({ path: doc.path, text: 'primero', revision: doc.revision }),
    f.store.save({ path: doc.path, text: 'segundo', revision: doc.revision }),
  ]);
  assert.equal(writes.filter(x => x.status === 'fulfilled').length, 1);
  assert.equal(writes.filter(x => x.status === 'rejected').length, 1);
});
