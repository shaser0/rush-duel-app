'use strict';
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// Files in data/ that must NOT ship in a release: user state, runtime logs,
// and the bulky raw cards.json (the binary only serves cards-clean.json).
function includeInRelease(src) {
  const base = path.basename(src);
  if (['collections.json', 'decks.json', 'cards.json', 'sync-state.json'].includes(base)) return false;
  if (/^sync-progress.*\.json$/.test(base)) return false;
  if (base.endsWith('.log')) return false;
  return true;
}

execSync('pkg . --targets node20-win-x64   --output dist/rush-app-win.exe', { stdio: 'inherit' });
execSync('pkg . --targets node20-linux-x64 --output dist/rush-app-linux',   { stdio: 'inherit' });
execSync('pkg . --targets node20-macos-x64 --output dist/rush-app-macos',   { stdio: 'inherit' });

// Patch the Windows exe PE header: change subsystem from console (3) to GUI (2).
// This tells Windows not to create a terminal window when the exe is launched,
// regardless of how it is started (double-click, launcher, etc.).
(function patchToGui(exePath) {
  const buf = fs.readFileSync(exePath);
  const peOffset = buf.readUInt32LE(0x3C);
  const optHeaderOffset = peOffset + 4 + 20; // skip PE sig + COFF header
  const magic = buf.readUInt16LE(optHeaderOffset);
  // PE32 = 0x010B (subsystem at +64), PE32+ = 0x020B (subsystem at +68)
  const subsystemOff = optHeaderOffset + (magic === 0x020B ? 68 : 64);
  buf.writeUInt16LE(2, subsystemOff); // 2 = IMAGE_SUBSYSTEM_WINDOWS_GUI
  fs.writeFileSync(exePath, buf);
  console.log('Patched to GUI subsystem:', exePath);
})('dist/rush-app-win.exe');

fs.rmSync('dist/data', { recursive: true, force: true });
fs.cpSync('data', 'dist/data', { recursive: true, filter: includeInRelease });
fs.copyFileSync('README.md', 'dist/README.md');
fs.chmodSync('dist/rush-app-linux', 0o755);
fs.chmodSync('dist/rush-app-macos', 0o755);

// ── Package upload-ready archives (binary + data/ + README) ─────────────────
// Each executable reads card data from a sibling `data/` folder, so every
// release asset bundles the binary together with data/ and README.md.
// Archives are built from inside dist/ so paths are relative (no "dist/" prefix).
// Listing explicit entries (not ".") avoids an archive including the others.
for (const [bin, archive] of [
  ['rush-app-linux', 'rush-app-linux.tar.gz'],
  ['rush-app-macos', 'rush-app-macos.tar.gz'],
]) {
  execSync(`tar -C dist -czf dist/${archive} ${bin} data README.md`, { stdio: 'inherit' });
  console.log('Packaged', 'dist/' + archive);
}

// Windows → .zip (PowerShell Compress-Archive on Windows, `zip` elsewhere)
if (process.platform === 'win32') {
  execSync(
    'powershell -NoProfile -Command "Compress-Archive -Force '
    + '-Path dist/rush-app-win.exe,dist/data,dist/README.md '
    + '-DestinationPath dist/rush-app-win.zip"',
    { stdio: 'inherit' });
} else {
  execSync('cd dist && zip -r -q rush-app-win.zip rush-app-win.exe data README.md', { stdio: 'inherit' });
}
console.log('Packaged', 'dist/rush-app-win.zip');

console.log('\nBuild complete. Upload-ready archives in dist/:');
console.log('  rush-app-win.zip  •  rush-app-linux.tar.gz  •  rush-app-macos.tar.gz');
