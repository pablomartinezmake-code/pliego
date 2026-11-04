import JSZip from 'jszip';
import { createReadStream, createWriteStream } from 'node:fs';
import { readdir, rename, rm } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';
import crypto from 'node:crypto';

if (!process.argv[2] || !process.argv[3]) throw new Error('Pass the source directory and destination ZIP');
const source = path.resolve(process.argv[2]);
const destination = path.resolve(process.argv[3]);
if (!destination.toLowerCase().endsWith('.zip')) throw new Error('The output must be a ZIP file');
if (destination.toLowerCase().startsWith((source + path.sep).toLowerCase())) throw new Error('The ZIP must be outside its source directory');
const zip = new JSZip();
const folder = zip.folder(path.basename(source));
async function addDirectory(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Unexpected link in release directory: ${file}`);
    if (entry.isDirectory()) await addDirectory(file);
    else if (entry.isFile()) folder.file(path.relative(source, file).split(path.sep).join('/'), createReadStream(file));
  }
}
await addDirectory(source);
const temporary = `${destination}.${crypto.randomUUID()}.tmp`;
try {
  await pipeline(zip.generateNodeStream({ streamFiles: true, compression: 'DEFLATE', compressionOptions: { level: 6 } }), createWriteStream(temporary, { flags: 'wx' }));
  await rename(temporary, destination);
  console.log(`Archive created: ${destination}`);
} finally { await rm(temporary, { force: true }); }
