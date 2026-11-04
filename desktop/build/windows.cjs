// Local, cross-platform Windows packaging. No CI, Wine, or publisher account required.
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { spawnSync } = require('node:child_process');

async function main(argv = process.argv.slice(2)) {
  const desktop = path.resolve(__dirname, '..');
  const root = path.resolve(desktop, '..');
  const metadata = require('../package.json');
  const index = argv.indexOf('--arch');
  const arch = index < 0 ? 'x64' : argv[index + 1];
  if (!['x64', 'arm64'].includes(arch)) throw new Error('Use --arch x64 or --arch arm64.');
  const version = require('electron/package.json').version;
  const filename = `electron-v${version}-win32-${arch}.zip`;
  const compiler = findCompiler();
  if (!compiler) throw new Error('Install NSIS (makensis) or set MAKENSIS to its executable path.');
  const [{ downloadArtifact }, asar, { extract }, { default: pngToIco }] = await Promise.all([
    import('@electron/get'), import('@electron/asar'), import('@electron-internal/extract-zip'), import('png-to-ico'),
  ]);
  const work = path.join(root, '.build', `windows-${arch}`);
  const output = path.join(root, 'dist', 'windows');
  fs.mkdirSync(work, { recursive: true });
  fs.mkdirSync(output, { recursive: true });
  const checksums = require('electron/checksums.json');
  const zip = process.env.VIBEZ_ELECTRON_ZIP || await downloadArtifact({
    version, artifactName: 'electron', platform: 'win32', arch,
    cacheRoot: path.join(root, '.build', 'electron-cache'), checksums,
  });
  const expected = checksums[filename];
  if (!expected || createHash('sha256').update(fs.readFileSync(zip)).digest('hex') !== expected) {
    throw new Error(`The Electron runtime checksum does not match ${filename}.`);
  }
  console.log(`Verified Electron ${version} Windows ${arch} runtime.`);
  const payload = path.join(work, 'app');
  const application = path.join(work, 'application');
  fs.rmSync(payload, { force: true, recursive: true });
  fs.rmSync(application, { force: true, recursive: true });
  fs.mkdirSync(payload, { recursive: true });
  fs.mkdirSync(application, { recursive: true });
  await extract(path.resolve(zip), { dir: application });
  for (const file of fs.readdirSync(desktop).filter((file) => file.endsWith('.cjs'))) {
    fs.copyFileSync(path.join(desktop, file), path.join(payload, file));
  }
  for (const folder of ['shared', 'platform', 'assets']) {
    fs.cpSync(path.join(desktop, folder), path.join(payload, folder), {
      recursive: true, filter: (source) => !source.endsWith('.nsi'),
    });
  }
  for (const file of ['offline.html', 'offline.css', 'NOTICE']) {
    fs.copyFileSync(path.join(desktop, file), path.join(payload, file));
  }
  const appMetadata = { ...metadata };
  delete appMetadata.devDependencies;
  delete appMetadata.scripts;
  fs.writeFileSync(path.join(payload, 'package.json'), JSON.stringify(appMetadata, null, 2));
  const icon = await pngToIco(path.join(desktop, 'assets/vibez.png'));
  fs.writeFileSync(path.join(payload, 'assets/vibez.ico'), icon);
  fs.writeFileSync(path.join(application, 'Vibez.ico'), icon);
  await asar.createPackage(payload, path.join(application, 'resources/app.asar'));
  fs.rmSync(path.join(application, 'resources/default_app.asar'), { force: true });
  fs.renameSync(path.join(application, 'electron.exe'), path.join(application, 'Vibez.exe'));
  const uninstallManifest = path.join(work, 'uninstall-files.nsh');
  fs.writeFileSync(uninstallManifest, createUninstallManifest(application));
  const artifact = path.join(output, `Vibez-Setup-${metadata.version}-${arch}.exe`);
  const nsisArgs = [
    `-DAPP_DIR=${application}`, `-DOUT_FILE=${artifact}`, `-DVERSION=${metadata.version}`, `-DAPP_ARCH=${arch}`,
    `-DFILE_MANIFEST=${uninstallManifest}`,
    path.join(desktop, 'platform/windows/installer.nsi'),
  ];
  console.log('Compiling the per-user Windows installer…');
  const result = spawnSync(compiler, nsisArgs, { stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`NSIS failed with exit code ${result.status}.`);
  const digest = createHash('sha256').update(fs.readFileSync(artifact)).digest('hex');
  fs.writeFileSync(`${artifact}.sha256`, `${digest}  ${path.basename(artifact)}\n`);
  console.log(`Ready: ${artifact}\nSHA256: ${digest}`);
}

function findCompiler() {
  const candidates = [process.env.MAKENSIS, 'makensis',
    process.env['ProgramFiles(x86)'] && path.join(process.env['ProgramFiles(x86)'], 'NSIS/makensis.exe'),
    process.env.ProgramFiles && path.join(process.env.ProgramFiles, 'NSIS/makensis.exe'),
  ].filter(Boolean);
  return candidates.find((candidate) => spawnSync(candidate, ['-VERSION'], { stdio: 'ignore' }).status === 0);
}

function createUninstallManifest(application) {
  const files = [];
  const directories = [];
  function walk(folder) {
    for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
      const target = path.join(folder, entry.name);
      if (entry.isDirectory()) { walk(target); directories.push(target); }
      else files.push(target);
    }
  }
  walk(application);
  const quote = (target) => path.relative(application, target).split(path.sep).join('\\').replaceAll('$', '$$').replaceAll('"', '$\\"');
  // Delete the installed file set, then only empty directories. Never recursively
  // erase an install directory the user may share with unrelated files.
  return [
    ...files.sort().map((file) => `Delete "$INSTDIR\\${quote(file)}"`),
    ...directories.map((directory) => `RMDir "$INSTDIR\\${quote(directory)}"`),
    'Delete "$INSTDIR\\Uninstall.exe"', 'RMDir "$INSTDIR"', '',
  ].join('\n');
}

module.exports = { main, createUninstallManifest };
if (require.main === module) main().catch((error) => { console.error(error.message); process.exitCode = 1; });
