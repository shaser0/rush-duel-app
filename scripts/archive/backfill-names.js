'use strict';

// Backfills name_en for cards where it is null in raw-cards.json.
// Yugipedia stores the English name in the `name` field of CardTable2,
// but sync-cards.js was only reading `en_name`. This script fetches the
// wikitext in batches of 50 and extracts the `name` field for null entries.
//
// Usage: node --use-system-ca scripts/backfill-names.js

if (!process.execArgv.some(a => a === '--use-system-ca')) {
  const { spawnSync } = require('child_process');
  const r = spawnSync(process.execPath, ['--use-system-ca', __filename, ...process.argv.slice(2)], { stdio: 'inherit' });
  process.exit(r.status ?? 0);
}

const https = require('https');
const fs    = require('fs');
const path  = require('path');

const RAW_FILE  = path.join(__dirname, '../data/raw-cards.json');
const RATE_MS   = 1200;
const BATCH     = 50;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function fetchBatch(titles) {
  return new Promise((resolve) => {
    const url = 'https://yugipedia.com/api.php?action=query'
      + '&titles=' + titles.map(encodeURIComponent).join('|')
      + '&prop=revisions&rvprop=content&rvslots=main&format=json';
    const req = https.get(url, { headers: { 'User-Agent': 'rush-app-backfill/1.0' } }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.setTimeout(30000, () => { req.destroy(); resolve(null); });
  });
}

function extractName(wikitext) {
  // Read `en_name` first (explicit override), fall back to `name`
  const en = wikitext.match(/\|\s*en_name\s*=\s*([^\n|{}]+)/)?.[1]?.trim();
  if (en) return en;
  const name = wikitext.match(/\|\s*name\s*=\s*([^\n|{}]+)/)?.[1]?.trim();
  return name || null;
}

async function main() {
  const cards = JSON.parse(fs.readFileSync(RAW_FILE, 'utf8'));
  const needFill = cards.map((c, i) => ({ i, title: c.title })).filter(x => !cards[x.i].name_en);

  console.log(`[backfill-names] ${needFill.length} cards need name_en backfill`);
  if (!needFill.length) { console.log('[backfill-names] Nothing to do.'); return; }

  let filled = 0;
  for (let b = 0; b < needFill.length; b += BATCH) {
    const batch = needFill.slice(b, b + BATCH);
    const result = await fetchBatch(batch.map(x => x.title));
    if (result?.query?.pages) {
      for (const page of Object.values(result.query.pages)) {
        if (page.missing !== undefined) continue;
        const wikitext = page.revisions?.[0]?.slots?.main?.['*'] || page.revisions?.[0]?.['*'] || '';
        const name = extractName(wikitext);
        if (!name) continue;
        const entry = batch.find(x => x.title === page.title);
        if (entry) { cards[entry.i].name_en = name; filled++; }
      }
    }
    process.stdout.write(`\r[backfill-names] ${Math.min(b + BATCH, needFill.length)}/${needFill.length} fetched, ${filled} filled`);
    if (b + BATCH < needFill.length) await sleep(RATE_MS);
  }
  console.log();

  fs.writeFileSync(RAW_FILE, JSON.stringify(cards, null, 2), 'utf8');
  console.log(`[backfill-names] Done. ${filled} names filled → raw-cards.json`);

  // Re-run clean-cards to regenerate cards.json with the new names
  const { cleanCards } = require('../pipeline/clean-cards');
  cleanCards();
  console.log('[backfill-names] cards.json regenerated.');
}

main().catch(e => { console.error(e); process.exit(1); });
