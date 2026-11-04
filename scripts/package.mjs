import { packager } from '@electron/packager';
import { cp, mkdir, mkdtemp, readFile, rm, copyFile } from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const root = process.cwd();
const manifest = JSON.parse(await readFile('package.json', 'utf8'));
if (!/^\d+\.\d+\.\d+$/.test(manifest.version)) throw new Error('Expected a simple release version');
const output = path.join(root, 'release', `v${manifest.version}`);
await mkdir(output, { recursive: true });
const stage = await mkdtemp(path.join(output, '.stage-'));
try {
  // The stage is an explicit runtime allowlist, not a copy of the workspace.
  for (const name of ['package.json', 'main.cjs', 'preload.cjs', 'file-store.cjs', 'document-store.cjs', 'research-store.cjs', 'LICENSE', 'THIRD_PARTY_NOTICES.md']) {
    await copyFile(path.join(root, name), path.join(stage, name));
  }
  for (const name of ['dist', 'assets', 'third-party-licenses']) {
    await cp(path.join(root, name), path.join(stage, name), {
      recursive: true,
      filter: source => !source.endsWith('.map'),
    });
  }
  // npm resolves the production dependency graph, including nested dependencies.
  const result = spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', 'npm.cmd ls --all --omit=dev --parseable'], { cwd: root, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`Cannot resolve production dependencies: ${result.stderr}`);
  const modulesRoot = path.join(root, 'node_modules') + path.sep;
  for (const line of result.stdout.split(/\r?\n/).filter(Boolean)) {
    const source = path.resolve(line);
    if (source === root) continue;
    if (!source.toLowerCase().startsWith(modulesRoot.toLowerCase())) throw new Error(`Dependency outside node_modules: ${source}`);
    const relative = path.relative(root, source);
    await cp(source, path.join(stage, relative), {
      recursive: true,
      filter: file => file === source || (!['node_modules', 'test', 'tests', '__tests__', '.git'].includes(path.basename(file)) && !file.endsWith('.map')),
    });
  }
  const paths = await packager({ dir: stage, out: output, name: 'Pliego', executableName: 'Pliego', icon: path.join(root, 'assets', 'pliego.ico'), platform: 'win32', arch: 'x64', overwrite: true, prune: false, asar: true, appCopyright: 'Pablo Martinez Samper', win32metadata: { CompanyName: 'Pablo Martinez Samper', FileDescription: 'Pliego · Documentos y lecturas', ProductName: 'Pliego' } });
  const appDir = paths[0];
  await copyFile(path.join(appDir, 'LICENSE'), path.join(appDir, 'LICENSE.electron.txt'));
  for (const name of ['LICENSE', 'THIRD_PARTY_NOTICES.md']) await copyFile(path.join(root, name), path.join(appDir, name));
  await cp(path.join(root, 'third-party-licenses'), path.join(appDir, 'third-party-licenses'), { recursive: true });
  await copyFile(path.join(root, 'scripts', 'Install-Pliego.ps1'), path.join(appDir, 'Install-Pliego.ps1'));
  const zip = path.join(output, `Pliego-${manifest.version}-win32-x64.zip`);
  const archive = spawnSync(process.execPath, [path.join(root, 'scripts', 'archive-release.mjs'), appDir, zip], { stdio: 'inherit' });
  if (archive.status !== 0) throw new Error('Failed to create release archive');
  console.log(`Application: ${appDir}\nArchive: ${zip}`);
} finally {
  await rm(stage, { recursive: true, force: true });
}
