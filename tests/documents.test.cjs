const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { FileStore } = require('../file-store.cjs');
const { DocumentStore } = require('../document-store.cjs');

async function fixture(fn) { const root = await fs.mkdtemp(path.join(__dirname, '.pliego-docs-')); try { await fn(root); } finally { await fs.rm(root, { recursive:true, force:true }); } }

test('mixed folder listing includes supported docs, reports metadata, and read is limited to chosen root', async () => fixture(async root => {
  const docs = path.join(root,'docs'); await fs.mkdir(path.join(docs,'sub'),{recursive:true});
  await fs.writeFile(path.join(docs,'a.md'),'# A'); await fs.writeFile(path.join(docs,'sub','b.txt'),'B'); await fs.writeFile(path.join(docs,'no.csv'),'x');
  await fs.mkdir(path.join(docs,'.hidden')); await fs.writeFile(path.join(docs,'.hidden','secret.pdf'),'x');
  const file = new FileStore(path.join(root,'user')); const store = new DocumentStore(path.join(root,'user'),file,{mammoth:{}});
  const listed = await store.listFolder(docs); assert.deepEqual(listed.files.map(x=>x.type),['md','txt']); assert.equal(listed.truncated,false); assert.ok(listed.files[0].size > 0);
  assert.equal((await store.read(path.join(docs,'sub','b.txt'))).text,'B');
  await assert.rejects(store.read(path.join(root,'nope.txt')),/Primero abre/);
}));

test('Markdown retains the existing text, eol, bom and revision contract', async () => fixture(async root => {
  const p = path.join(root,'existing.md'), bytes = Buffer.concat([Buffer.from([0xef,0xbb,0xbf]),Buffer.from('uno\r\ndos\r\n')]); await fs.writeFile(p,bytes);
  const store = new DocumentStore(path.join(root,'u'),new FileStore(path.join(root,'u')),{mammoth:{}}); const doc = await store.open(p);
  assert.equal(doc.type,'md'); assert.equal(doc.text,'uno\r\ndos\r\n'); assert.equal(doc.eol,'\r\n'); assert.equal(doc.bom,true); assert.equal(doc.revision,require('node:crypto').createHash('sha256').update(bytes).digest('hex'));
}));

test('PDF bytes are read-only and DOCX uses Mammoth without external file access', async () => fixture(async root => {
  const pdf = path.join(root,'one.pdf'), docx = path.join(root,'one.docx'); await fs.writeFile(pdf,Buffer.from('%PDF test')); await fs.writeFile(docx,Buffer.from('fixture'));
  const calls=[]; const mammoth={ convertToHtml: async (input,options)=>{calls.push(['html',input,options]);return {value:'<p>vista</p>',messages:[{type:'warning',message:'aviso'}]};}, extractRawText:async (input,options)=>{calls.push(['text',input,options]);return {value:'vista',messages:[]};} };
  const store = new DocumentStore(path.join(root,'u'),new FileStore(path.join(root,'u')),{mammoth});
  const p = await store.open(pdf); assert.ok(p.data instanceof Uint8Array); assert.equal(p.data[0],37); p.data[0]=0; assert.equal((await fs.readFile(pdf))[0],37);
  const d = await store.open(docx); assert.equal(d.html,'<p>vista</p>'); assert.equal(d.text,'vista'); assert.equal(d.messages[0].message,'aviso'); assert.equal(calls.length,2); assert.equal(calls[0][2].externalFileAccess,false);
}));

test('real DOCX fixture produces a readable Mammoth preview', async () => fixture(async root => {
  const source = path.join(__dirname, 'fixtures', 'ensayos', 'lectura.docx');
  const docx = path.join(root, 'lectura.docx'); await fs.copyFile(source, docx);
  const store = new DocumentStore(path.join(root,'u'),new FileStore(path.join(root,'u')));
  const doc = await store.open(docx); assert.equal(doc.type,'docx'); assert.ok(doc.text.trim().length > 0); assert.ok(doc.html.includes('<'));
}));

test('favorites persist and favorite folder can be selected', async () => fixture(async root => {
  const user=path.join(root,'u'), folder=path.join(root,'research'); await fs.mkdir(folder); await fs.writeFile(path.join(folder,'x.pdf'),'pdf');
  let store = new DocumentStore(user,new FileStore(user),{mammoth:{}}); await store.listFolder(folder); await store.toggleFavorite({path:folder,type:'folder'});
  store = new DocumentStore(user,new FileStore(user),{mammoth:{}}); assert.equal(store.getFavorites()[0].type,'folder'); assert.equal((await store.selectFavoriteFolder(folder)).files[0].name,'x.pdf');
}));

test('stored favorite can be removed after restart even when its file no longer exists', async () => fixture(async root => {
  const user=path.join(root,'u'), p=path.join(root,'gone.pdf'); await fs.writeFile(p,'pdf');
  let store = new DocumentStore(user,new FileStore(user),{mammoth:{}}); await store.open(p); await store.toggleFavorite({path:p,type:'pdf'}); await fs.rm(p);
  store = new DocumentStore(user,new FileStore(user),{mammoth:{}}); assert.equal(store.getFavorites().length,1);
  assert.deepEqual(await store.toggleFavorite({path:p,type:'pdf'}),[]);
}));

test('recent history merges legacy Markdown and newly opened mixed document types', async () => fixture(async root => {
  const user=path.join(root,'u'), md=path.join(root,'legacy.md'), pdf=path.join(root,'new.pdf'), docx=path.join(root,'new.docx');
  await fs.writeFile(md,'# viejo'); await fs.writeFile(pdf,'%PDF'); await fs.writeFile(docx,'docx');
  const fileStore=new FileStore(user); await fileStore.open(md);
  const mammoth={convertToHtml:async()=>({value:'<p>ok</p>',messages:[]}),extractRawText:async()=>({value:'ok',messages:[]})};
  let store=new DocumentStore(user,fileStore,{mammoth}); assert.equal((await store.getRecent())[0].type,'md');
  await store.open(pdf); await store.open(docx);
  assert.deepEqual((await store.getRecent()).map(x=>x.type),['docx','pdf','md']);
  store=new DocumentStore(user,new FileStore(user),{mammoth}); assert.deepEqual((await store.getRecent()).map(x=>x.type),['docx','pdf','md']);
}));
