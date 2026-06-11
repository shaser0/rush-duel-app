'use strict';

const fs   = require('fs');
const path = require('path');

const cards   = JSON.parse(fs.readFileSync(path.join(__dirname, '../data/cards.json'), 'utf8'));
const imgUrls = JSON.parse(fs.readFileSync(path.join(__dirname, '../data/image-urls.json'), 'utf8'));
const gallery = JSON.parse(fs.readFileSync(path.join(__dirname, '../data/gallery-images.json'), 'utf8'));

function cleanFile(f) {
  return (f || '').replace(/^\d+\.\d+;\s*/, '').trim();
}

function regionOf(file) {
  return /-KRS?-/.test(file) ? 'KR' : 'JP';
}

// Normalize a name for lookup: strip disambiguation suffixes, (L)/(R) → [L]/[R], remove #
function normalizeName(name) {
  return name
    .replace(/\s*\(L\)$/, ' [L]')
    .replace(/\s*\(R\)$/, ' [R]')
    .replace(/\s*\(card\)$/i, '')
    .replace(/\s*\(Skill Card\)$/i, '')
    .replace(/#/g, '')
    .replace(/\s+\([^)]+\)$/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// Build a map: normalized card name → canonical card name_en
const cardByNorm = {};
for (const card of cards) {
  const name = card.name_en || card.title || card.raw_name_en;
  const norm = normalizeName(name);
  if (!cardByNorm[norm]) cardByNorm[norm] = name;
}

// Build gallery lookup keyed by canonical card name
const galleryByCard = {};
for (const [key, files] of Object.entries(gallery)) {
  const norm = normalizeName(key);
  const cardName = cardByNorm[norm];
  if (!cardName) continue; // no matching card in database
  if (!galleryByCard[cardName]) galleryByCard[cardName] = [];
  galleryByCard[cardName].push(...files);
}

const noImages    = [];
const missingFiles = [];
let totalFiles = 0;

for (const card of cards) {
  const name = card.name_en || card.title || card.raw_name_en;

  const seen = new Set();
  const files = [];

  for (const img of (card.images || [])) {
    const f = cleanFile(img.file);
    if (f && !seen.has(f)) { seen.add(f); files.push(f); }
  }
  for (const f of (galleryByCard[name] || [])) {
    if (f && !seen.has(f)) { seen.add(f); files.push(f); }
  }

  if (files.length === 0) {
    noImages.push(name);
    continue;
  }

  for (const file of files) {
    totalFiles++;
    if (!imgUrls[file]) {
      missingFiles.push({ name, file, region: regionOf(file) });
    }
  }
}

const byRegion = {};
for (const entry of missingFiles) {
  (byRegion[entry.region] = byRegion[entry.region] || []).push(entry);
}

console.log('=== Missing image URLs ===\n');
console.log(`Cards with no image entries (images + gallery): ${noImages.length}`);
for (const n of noImages) console.log(`  ${n}`);

console.log(`\nImage files missing from image-urls.json: ${missingFiles.length} / ${totalFiles}`);
for (const region of Object.keys(byRegion).sort()) {
  const entries = byRegion[region];
  console.log(`\n[${region}] ${entries.length} missing`);
  console.log('name\tfile');
  for (const { name, file } of entries) {
    console.log(`${name}\t${file}`);
  }
}
