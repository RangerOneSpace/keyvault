// Builds KeyVault as one standalone executable using Node's "single executable
// application" feature: the official Node binary with KeyVault injected into it.
//
//   node scripts/build-exe.mjs                    build for this computer
//   node scripts/build-exe.mjs --target win-x64 --node-bin path/to/node.exe --blob-node path/to/node
//
// --node-bin   the Node binary to wrap (defaults to the one running this script)
// --blob-node  a Node binary that can run here, of the SAME version as --node-bin,
//              used to prepare the app blob when cross-building (defaults to this Node)

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';
import { inject } from 'postject';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const BUILD = path.join(ROOT, 'build');
const DIST = path.join(ROOT, 'dist');
const arg = (name, dflt) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : dflt; };

const hostTarget = `${process.platform === 'win32' ? 'win' : process.platform === 'darwin' ? 'mac' : 'linux'}-${process.arch}`;
const target = arg('target', hostTarget);
const nodeBin = path.resolve(arg('node-bin', process.execPath));
const blobNode = path.resolve(arg('blob-node', process.execPath));
const isWin = target.startsWith('win');
const isMac = target.startsWith('mac');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const CORPUS_SHA256 = '54e487fbe4fea9feffa6b6660c5e23a6ed58fd7b5539db981a545d5347dced74';
const outName = isWin ? 'KeyVault.exe' : `keyvault-${target}`;
const out = path.join(DIST, outName);

fs.rmSync(BUILD, { recursive: true, force: true });
fs.mkdirSync(BUILD, { recursive: true });
fs.mkdirSync(DIST, { recursive: true });

// 1. Build-time modules: version, and the UI files embedded as strings.
fs.writeFileSync(path.join(BUILD, 'build-info.js'), `export default ${JSON.stringify({ sea: true, version: pkg.version })};\n`);
const ui = {};
for (const f of ['index.html', 'app.js', 'app.css', 'favicon.svg']) ui[f] = fs.readFileSync(path.join(ROOT, 'ui', f), 'utf8');
for (const f of fs.readdirSync(path.join(ROOT, 'ui', 'fonts')).filter(n => n.endsWith('.woff2'))) {
  ui[`fonts/${f}`] = fs.readFileSync(path.join(ROOT, 'ui', 'fonts', f)).toString('base64');
}
fs.writeFileSync(path.join(BUILD, 'ui-embedded.js'), `export default ${JSON.stringify(ui)};\n`);
const corpus = fs.readFileSync(path.join(ROOT, 'data', 'slopsquatting.jsonl'), 'utf8').replace(/\r\n/g, '\n');
const corpusHash = crypto.createHash('sha256').update(corpus).digest('hex');
if (corpusHash !== CORPUS_SHA256) throw new Error(`Trend Micro corpus hash mismatch: ${corpusHash}`);
fs.writeFileSync(path.join(BUILD, 'slopsquatting-corpus.js'), `export default ${JSON.stringify(corpus)};\n`);

// 2. Bundle everything into one CommonJS file.
await esbuild.build({
  entryPoints: [path.join(ROOT, 'bin', 'keyvault.js')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  outfile: path.join(BUILD, 'keyvault.cjs'),
  logLevel: 'error',
  plugins: [{
    name: 'embed',
    setup(b) {
      b.onResolve({ filter: /(^|[\\/])(build-info|ui-embedded|slopsquatting-corpus)\.js$/ }, a => ({ path: path.join(BUILD, path.basename(a.path)) }));
    },
  }],
});

// 3. Prepare the blob. Code cache and snapshots are off so it works cross-platform.
const seaConfig = path.join(BUILD, 'sea-config.json');
const blob = path.join(BUILD, 'sea-prep.blob');
fs.writeFileSync(seaConfig, JSON.stringify({
  main: path.join(BUILD, 'keyvault.cjs'),
  output: blob,
  disableExperimentalSEAWarning: true,
  useSnapshot: false,
  useCodeCache: false,
}, null, 2));
const vBlob = execFileSync(blobNode, ['--version']).toString().trim();
const vTarget = execFileSync(blobNode, ['-e', 'process.stdout.write(process.version)']).toString();
if (arg('node-bin') && !arg('blob-node') && target !== hostTarget) throw new Error('Cross-building needs --blob-node (same Node version as --node-bin)');
execFileSync(blobNode, ['--experimental-sea-config', seaConfig], { stdio: 'inherit' });

// 4. Copy the Node binary, inject the blob, then brand it (Windows).
fs.copyFileSync(nodeBin, out);
fs.chmodSync(out, 0o755);
if (isMac) {
  try { execFileSync('codesign', ['--remove-signature', out]); } catch {}
}
await inject(out, 'NODE_SEA_BLOB', fs.readFileSync(blob), {
  sentinelFuse: 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2',
  ...(isMac ? { machoSegmentName: 'NODE_SEA' } : {}),
});
if (isMac) {
  try { execFileSync('codesign', ['--sign', '-', out]); } catch {}
}
if (isWin) {
  const ResEdit = await import('resedit');
  const PE = await import('pe-library');
  // Done AFTER injection: rewriting resources first confuses the injector's PE parser.
  // The Node signature cannot survive our changes, so it is removed rather than left broken.
  const exe = PE.NtExecutable.from(fs.readFileSync(out), { ignoreCert: true });
  const res = PE.NtExecutableResource.from(exe);
  const icon = ResEdit.Data.IconFile.from(fs.readFileSync(path.join(ROOT, 'assets', 'keyvault.ico')));
  const groups = ResEdit.Resource.IconGroupEntry.fromEntries(res.entries);
  const gid = groups[0]?.id ?? 1; const glang = groups[0]?.lang ?? 1033;
  ResEdit.Resource.IconGroupEntry.replaceIconsForResource(res.entries, gid, glang, icon.icons.map(i => i.data));
  const vi = ResEdit.Resource.VersionInfo.fromEntries(res.entries)[0] || ResEdit.Resource.VersionInfo.createEmpty();
  const [a, b, c] = pkg.version.split('.').map(Number);
  vi.setFileVersion(a, b, c, 0, 1033);
  vi.setProductVersion(a, b, c, 0, 1033);
  const langs = vi.getAllLanguagesForStringValues();
  for (const lang of langs.length ? langs : [{ lang: 1033, codepage: 1200 }]) {
    vi.setStringValues(lang, {
      ProductName: 'KeyVault', FileDescription: 'KeyVault by Ranger One', CompanyName: 'Ranger One',
      LegalCopyright: 'Copyright (c) 2026 Ranger One. MIT licence.', OriginalFilename: 'KeyVault.exe',
      InternalName: 'KeyVault', FileVersion: pkg.version, ProductVersion: pkg.version,
    });
  }
  vi.outputToResourceEntries(res.entries);
  res.outputResource(exe);
  fs.writeFileSync(out, Buffer.from(exe.generate()));
}

const sha = crypto.createHash('sha256').update(fs.readFileSync(out)).digest('hex');
fs.writeFileSync(`${out}.sha256`, `${sha}  ${outName}\n`);
console.log(`Built ${out}`);
console.log(`  Node ${vBlob} (${vTarget}), ${(fs.statSync(out).size / 1048576).toFixed(1)} MB`);
console.log(`  SHA-256 ${sha}`);
