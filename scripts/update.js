'use strict';

// Binary auto-updater: checks GitHub Releases for a newer version, downloads
// the platform-appropriate asset next to the current binary, and writes a
// helper script (apply-update.bat / apply-update.sh) the user runs after
// closing the app to swap the binary in place.

const https  = require('https');
const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');

const REPO = 'shaser0/rush-duel-app';
const API  = `https://api.github.com/repos/${REPO}/releases/latest`;

function assetName() {
  if (process.platform === 'win32') return 'rush-app-win.exe';
  if (process.platform === 'darwin') return 'rush-app-macos';
  return 'rush-app-linux';
}

function currentVersion() {
  try { return require('../package.json').version; }
  catch { return '0.0.0'; }
}

function semverGt(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) > (pb[i] || 0)) return true;
    if ((pa[i] || 0) < (pb[i] || 0)) return false;
  }
  return false;
}

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: {
        'User-Agent': 'rush-duel-app/updater',
        'Accept': 'application/vnd.github.v3+json',
      },
    }, res => {
      if (res.statusCode < 200 || res.statusCode >= 300) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      let data = '';
      res.on('data', c => (data += c));
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('timeout')); });
  });
}

function fetchText(url) {
  return new Promise((resolve, reject) => {
    const get = (u, redirects) => {
      if (redirects > 5) return reject(new Error('too many redirects'));
      if (!u.startsWith('https://')) return reject(new Error(`Redirect vers URL non-HTTPS refusé: ${u}`));
      require('https').get(u, { headers: { 'User-Agent': 'rush-duel-app/updater' } }, res => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          return get(res.headers.location, redirects + 1);
        }
        if (res.statusCode < 200 || res.statusCode >= 300) {
          res.resume();
          return reject(new Error(`HTTP ${res.statusCode}`));
        }
        let data = '';
        res.on('data', c => (data += c));
        res.on('end', () => resolve(data));
        res.on('error', reject);
      }).on('error', reject)
        .setTimeout(15000, function() { this.destroy(); reject(new Error('timeout')); });
    };
    get(url, 0);
  });
}

async function fetchChecksums(release, assetFilename) {
  const asset = (release.assets || []).find(a => a.name === 'checksums.sha256');
  if (!asset) throw new Error('checksums.sha256 asset manquant dans la release');
  const text = await fetchText(asset.browser_download_url);
  for (const line of text.split('\n')) {
    const [hash, name] = line.trim().split(/\s+/);
    if (name === assetFilename) return hash.toLowerCase();
  }
  throw new Error(`Aucun checksum trouvé pour ${assetFilename}`);
}

function verifyFile(filePath, expectedHash) {
  return new Promise((resolve, reject) => {
    const hash   = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('data', chunk => hash.update(chunk));
    stream.on('end', () => {
      const actual = hash.digest('hex');
      if (actual !== expectedHash) {
        try { fs.unlinkSync(filePath); } catch {}
        reject(new Error(`Checksum mismatch: attendu ${expectedHash}, obtenu ${actual}`));
      } else {
        resolve();
      }
    });
    stream.on('error', reject);
  });
}

function downloadFile(url, destPath, onProgress) {
  return new Promise((resolve, reject) => {
    const tmpPath = destPath + '.tmp';
    // Follow redirects (GitHub asset URLs redirect to S3)
    const get = (u, redirects) => {
      if (redirects > 5) return reject(new Error('too many redirects'));
      if (!u.startsWith('https://')) {
        return reject(new Error(`Redirect vers URL non-HTTPS refusé: ${u}`));
      }
      const mod = require('https');
      mod.get(u, { headers: { 'User-Agent': 'rush-duel-app/updater' } }, res => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          return get(res.headers.location, redirects + 1);
        }
        if (res.statusCode < 200 || res.statusCode >= 300) {
          res.resume();
          return reject(new Error(`HTTP ${res.statusCode}`));
        }
        const total = parseInt(res.headers['content-length'] || '0', 10);
        let received = 0;
        const out = fs.createWriteStream(tmpPath);
        res.on('data', chunk => {
          out.write(chunk);
          received += chunk.length;
          if (onProgress && total > 0) onProgress(received / total);
        });
        res.on('end', () => {
          out.end(() => {
            try { fs.renameSync(tmpPath, destPath); resolve(); }
            catch (e) { reject(new Error(`Rename failed: ${e.message}`)); }
          });
        });
        res.on('error', err => { out.destroy(); reject(err); });
      }).on('error', reject)
        .setTimeout(300000, function() { this.destroy(); reject(new Error('download timeout')); });
    };
    get(url, 0);
  });
}

async function checkUpdate() {
  const release = await fetchJson(API);
  const latest  = (release.tag_name || '').replace(/^v/, '');
  const current = currentVersion();
  const asset   = (release.assets || []).find(a => a.name === assetName());
  return {
    current,
    latest,
    hasUpdate: semverGt(latest, current),
    downloadUrl: asset ? asset.browser_download_url : null,
    assetName: assetName(),
    release,
  };
}

async function downloadUpdate(downloadUrl, release, appDir, onProgress) {
  const name = assetName();
  const dest = path.join(appDir, name + '.new');
  await downloadFile(downloadUrl, dest, onProgress);
  const expectedHash = await fetchChecksums(release, name);
  await verifyFile(dest, expectedHash);
  if (process.platform !== 'win32') {
    try { fs.chmodSync(dest, 0o755); } catch {}
  }
  return dest;
}

function writeApplyScript(appDir) {
  if (process.platform === 'win32') {
    const bin = assetName();
    const script = `@echo off\r\ntimeout /t 2 /nobreak >nul\r\nmove /Y "${bin}.new" "${bin}"\r\nstart "" "${bin}"\r\ndel "%~f0"\r\n`;
    const scriptPath = path.join(appDir, 'apply-update.bat');
    fs.writeFileSync(scriptPath, script, 'utf8');
    return 'apply-update.bat';
  } else {
    const bin = assetName();
    const script = `#!/bin/sh\nsleep 2\nmv "${bin}.new" "${bin}"\nchmod +x "${bin}"\n./"${bin}" &\nrm -- "$0"\n`;
    const scriptPath = path.join(appDir, 'apply-update.sh');
    fs.writeFileSync(scriptPath, script, 'utf8');
    try { fs.chmodSync(scriptPath, 0o755); } catch {}
    return 'apply-update.sh';
  }
}

module.exports = { checkUpdate, downloadUpdate, writeApplyScript, assetName };
