const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { FileStore } = require('../file-store.cjs');
const { DocumentStore } = require('../document-store.cjs');
const { ResearchStore } = require('../research-store.cjs');
const hash = b => require('node:crypto').createHash('sha256').update(b).digest('hex');
async function fixture(fn) { const root=await fs.mkdtemp(path.join(__dirname,'.pliego-research-')); try { await fn(root); } finally { await fs.rm(root,{recursive:true,force:true}); } }
const entry = (patch={}) => ({id:'n1',type:'note',page:3,title:'Lectura',quote:'texto citado',note:'mi nota',folio:null,rects:[{x:.1,y:.2,width:.3,height:.1}],createdAt:'2026-10-28T00:00:00.000Z',...patch});

test('notebooks persist across store restart and use compare-and-swap versions', async () => fixture(async root => {
  const user=path.join(root,'u'), pdf=path.join(root,'source.pdf'), bytes=Buffer.from('%PDF contenido'); await fs.writeFile(pdf,bytes); const revision=hash(bytes);
  const make=()=>{const docs=new DocumentStore(user,new FileStore(user),{mammoth:{}});return new ResearchStore(user,docs);};
  let research=make(), opened=await research.documentStore.open(pdf); assert.equal(opened.revision,revision);
  const saved=await research.saveNotebook({path:pdf,revision,expectedVersion:0,entries:[entry()]}); assert.equal(saved.version,1);
  await assert.rejects(research.saveNotebook({path:pdf,revision,expectedVersion:0,entries:[]}),/Conflicto de versión/);
  const updated=await research.saveNotebook({path:pdf,revision,expectedVersion:1,entries:[entry({note:'editada'})]}); assert.equal(updated.version,2);
  research=make(); assert.deepEqual(await research.getNotebook({path:pdf,revision}),updated);
}));

test('different PDF content hash has a separate notebook and stale revision is rejected', async () => fixture(async root => {
  const user=path.join(root,'u'), pdf=path.join(root,'source.pdf'), one=Buffer.from('%PDF one'), two=Buffer.from('%PDF two'); await fs.writeFile(pdf,one);
  const docs=new DocumentStore(user,new FileStore(user),{mammoth:{}}); await docs.open(pdf); const r=new ResearchStore(user,docs), rev1=hash(one), rev2=hash(two);
  await r.saveNotebook({path:pdf,revision:rev1,expectedVersion:0,entries:[entry()]}); await fs.writeFile(pdf,two);
  await assert.rejects(r.getNotebook({path:pdf,revision:rev1}),/cambió/);
  await docs.open(pdf); assert.deepEqual(await r.getNotebook({path:pdf,revision:rev2}),{version:0,entries:[]});
}));

test('export distinguishes PDF sheet from unverified printed folio', async () => fixture(async root => {
  const user=path.join(root,'u'), pdf=path.join(root,'material.pdf'), bytes=Buffer.from('%PDF data'); await fs.writeFile(pdf,bytes);
  const docs=new DocumentStore(user,new FileStore(user),{mammoth:{}}); await docs.open(pdf); const r=new ResearchStore(user,docs), revision=hash(bytes);
  await r.saveNotebook({path:pdf,revision,expectedVersion:0,entries:[entry()]});
  const md=await r.exportNotebook({path:pdf,revision}); assert.match(md,/HOJA PDF: 3/); assert.match(md,/Folio impreso: sin verificar/); assert.match(md,/SHA-256:/); assert.match(md,/cotejar con la imagen antes de citar/);
}));

test('rejects malformed, out of bounds and non-finite rectangles', async () => fixture(async root => {
  const user=path.join(root,'u'), pdf=path.join(root,'material.pdf'), bytes=Buffer.from('%PDF data'); await fs.writeFile(pdf,bytes);
  const docs=new DocumentStore(user,new FileStore(user),{mammoth:{}}); await docs.open(pdf); const r=new ResearchStore(user,docs), base={path:pdf,revision:hash(bytes),expectedVersion:0};
  await assert.rejects(r.saveNotebook({...base,entries:[entry({rects:[{x:.9,y:0,width:.2,height:.1}]})]}),/Rectángulo/);
  await assert.rejects(r.saveNotebook({...base,entries:[entry({rects:[{x:NaN,y:0,width:.1,height:.1}]})]}),/Rectángulo/);
  await assert.rejects(r.saveNotebook({...base,entries:[entry({page:0})]}),/Anotación/);
}));

test('notebook access requires prior document authorization', async () => fixture(async root => {
  const user=path.join(root,'u'), pdf=path.join(root,'outside.pdf'), bytes=Buffer.from('%PDF'); await fs.writeFile(pdf,bytes);
  const docs=new DocumentStore(user,new FileStore(user),{mammoth:{}}), r=new ResearchStore(user,docs);
  await assert.rejects(r.getNotebook({path:pdf,revision:hash(bytes)}),/Primero abre/);
}));
