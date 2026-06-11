'use strict';

// Computes SHA-256 hashes for all data files listed in data-version.json and
// writes them into the "hashes" field of that manifest.
// Run this after any sync that updates files in data/, then commit the result.
//
// Usage: node scripts/hash-data.js [--bump]
//   --bump  also increments the "version" integer in data-version.json

const fs   = require('fs');
const path = require('path');
const { computeFileHash } = require('../lib/fs-atomic');

const DATA_DIR = path.join(__dirname, '../../data');
const VER_PATH = path.join(DATA_DIR, 'data-version.json');

(async () => {
  const manifest = JSON.parse(fs.readFileSync(VER_PATH, 'utf8'));
  const bump     = process.argv.includes('--bump');

  const hashes = {};
  for (const file of manifest.files || []) {
    const filePath = path.join(DATA_DIR, file);
    if (!fs.existsSync(filePath)) {
      console.warn(`[hash-data] absent, ignoré: ${file}`);
      continue;
    }
    hashes[file] = await computeFileHash(filePath);
    console.log(`  ${hashes[file]}  ${file}`);
  }

  manifest.hashes = hashes;
  if (bump) {
    manifest.version = (manifest.version || 0) + 1;
    console.log(`Version bumped to ${manifest.version}`);
  }

  fs.writeFileSync(VER_PATH, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  console.log('Updated data/data-version.json');
})().catch(e => { console.error(e); process.exit(1); });
