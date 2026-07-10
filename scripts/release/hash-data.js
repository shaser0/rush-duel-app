'use strict';

// Computes SHA-256 hashes for all data files listed in data-version.json and
// writes them into the "hashes" field of that manifest. Also keeps
// data-channel.json's version number in sync, so the two files can't drift
// apart silently the way they did before (data-channel.json had gone two
// releases stale with nothing ever writing to it).
// Run this after any sync that updates files in data/, then commit the result.
//
// Usage: node scripts/hash-data.js [--bump] [--tag=<value>] [--data-tag] [--if-changed]
//   --if-changed exit without writing/bumping if the content hashes are identical
//                to those already in data-version.json. Used by the scheduled sync so
//                a no-op run doesn't publish a version bump + tag (and force every
//                client to reload) when no card data actually changed.
//   --bump       also increments the "version" integer in data-version.json
//                and data-channel.json. NOTE: the tag only becomes real once
//                this commit is actually reachable under it — run this as
//                part of cutting the release, not before bumping the app
//                version in package.json.
//   --tag=<val>  sets data-channel.json's "tag" to the literal <val> instead
//                of the default v<package.json version>. Wins over --data-tag.
//   --data-tag   sets data-channel.json's "tag" to "data-v<new version>" for a
//                data-only publish (e.g. the scheduled auto-sync). The caller
//                (CI) then creates that immutable git tag on the data commit, so
//                jsDelivr serves a *consistent* snapshot from a pinned tag —
//                never the mutable main branch, whose per-file cache TTLs can
//                serve data-channel.json and data-version.json at different
//                versions and drive clients into a reload loop. No vX.Y.Z tag
//                (and no binary rebuild) is needed just to publish new card data.

const fs   = require('fs');
const path = require('path');
const { computeFileHash } = require('../lib/fs-atomic');

const DATA_DIR     = path.join(__dirname, '../../data');
const VER_PATH     = path.join(DATA_DIR, 'data-version.json');
const CHANNEL_PATH = path.join(DATA_DIR, 'data-channel.json');
const PKG_PATH     = path.join(__dirname, '../../package.json');

(async () => {
  const manifest = JSON.parse(fs.readFileSync(VER_PATH, 'utf8'));
  const bump     = process.argv.includes('--bump');
  const tagArg   = process.argv.find(a => a.startsWith('--tag='));
  const tagOverride = tagArg ? tagArg.slice('--tag='.length) : null;
  const dataTag  = process.argv.includes('--data-tag');
  const ifChanged = process.argv.includes('--if-changed');

  const hashes = {};
  for (const file of manifest.files || []) {
    const filePath = path.join(DATA_DIR, file);
    if (!fs.existsSync(filePath)) {
      console.warn(`[hash-data] missing, skipped: ${file}`);
      continue;
    }
    hashes[file] = await computeFileHash(filePath);
    console.log(`  ${hashes[file]}  ${file}`);
  }

  // --if-changed: no-op when the content hashes are identical to what's already
  // recorded. The scheduled sync runs on a schedule even when nothing new was fetched;
  // without this, every run would still bump the version, publish a commit + tag,
  // and force every client to reload for zero data change. Compared key-by-key
  // so hash-map key order doesn't matter.
  const prevHashes = manifest.hashes || {};
  const allKeys = new Set([...Object.keys(prevHashes), ...Object.keys(hashes)]);
  const hashesChanged = [...allKeys].some(k => prevHashes[k] !== hashes[k]);
  if (ifChanged && !hashesChanged) {
    console.log('No data changes since last hash — nothing to write, bump, or publish.');
    return;
  }

  manifest.hashes = hashes;
  if (bump) {
    manifest.version = (manifest.version || 0) + 1;
    console.log(`Version bumped to ${manifest.version}`);
  }

  fs.writeFileSync(VER_PATH, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  console.log('Updated data/data-version.json');

  if (bump && fs.existsSync(CHANNEL_PATH)) {
    const channel = JSON.parse(fs.readFileSync(CHANNEL_PATH, 'utf8'));
    const pkg     = JSON.parse(fs.readFileSync(PKG_PATH, 'utf8'));
    channel.version = manifest.version;
    channel.tag      = tagOverride
      || (dataTag ? `data-v${manifest.version}` : `v${pkg.version}`);
    fs.writeFileSync(CHANNEL_PATH, JSON.stringify(channel, null, 2) + '\n', 'utf8');
    console.log(`Updated data/data-channel.json (tag: ${channel.tag}, version: ${channel.version})`);
  }
})().catch(e => { console.error(e); process.exit(1); });
