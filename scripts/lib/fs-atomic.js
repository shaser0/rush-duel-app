'use strict';

const fs     = require('fs');
const crypto = require('crypto');

// Write JSON atomically: write to a .tmp sibling, then rename over the target.
// A failed write never leaves a corrupted target file; on rename failure the
// .tmp file is cleaned up before rethrowing.
function writeJsonAtomic(filePath, data) {
  const tmp = filePath + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  try {
    fs.renameSync(tmp, filePath);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch {}
    throw e;
  }
}

// SHA-256 of a file, streamed so multi-MB files are never buffered whole.
// Shared by the updater (binary checksums), data updater and hash-data.
function computeFileHash(filePath) {
  return new Promise((resolve, reject) => {
    const hash   = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('data', chunk => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

module.exports = { writeJsonAtomic, computeFileHash };
