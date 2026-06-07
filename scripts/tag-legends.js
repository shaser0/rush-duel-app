'use strict';

// One-time backfill: enrich every card in raw-cards.json from its Yugipedia page —
//   • is_legend : "Legend Card" marker in the `misc` field
//   • card_type : Spell / Trap (monsters use the existing `types` field)
//   • property  : Normal / Continuous / Field / ... for Spells & Traps
// then regenerate cards.json (cleaned). Future `sync-cards.js` runs keep it current.

const https        = require('https');
const fs           = require('fs');
const path         = require('path');
const { cleanCards } = require('./clean-cards');

const CARDS_FILE = path.join(__dirname, '../data/raw-cards.json');
const RATE_MS    = 1100;
const BATCH_SIZE = 50;

function get(url) {
  return new Promise((resolve, reject) => {
    https.get(url, {
      headers: { 'User-Agent': 'RushDuelDB/1.0 (personal project)' },
      rejectUnauthorized: false,
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch (e) { reject(new Error('JSON parse: ' + e.message)); } });
    }).on('error', reject);
  });
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

function field(body, name) {
  const m = body.match(new RegExp('\\|\\s*' + name + '\\s*=\\s*([\\s\\S]*?)(?=\\n\\s*\\||\\n\\s*\\}\\}|$)'));
  return m ? m[1].trim() : null;
}

// Extract legend/card_type/property from a card page's CardTable2
function parseEnrichment(wikitext) {
  const t = wikitext.match(/\{\{CardTable2([\s\S]*?)\}\}\s*$/);
  if (!t) return null;
  const body = t[1];
  return {
    is_legend: /Legend Card/i.test(field(body, 'misc') || ''),
    card_type: field(body, 'card_type'),
    property:  field(body, 'property'),
  };
}

async function fetchAllTitles() {
  const titles = [];
  let cmcontinue = null;
  do {
    const url = 'https://yugipedia.com/api.php?action=query'
      + '&list=categorymembers&cmtitle=Category:Rush_Duel_cards'
      + '&cmtype=page&cmlimit=500&format=json'
      + (cmcontinue ? '&cmcontinue=' + encodeURIComponent(cmcontinue) : '');
    const r = await get(url);
    for (const m of r.query.categorymembers) if (!m.title.startsWith('List of')) titles.push(m.title);
    cmcontinue = r.continue?.cmcontinue ?? null;
    process.stdout.write(`Fetching titles... ${titles.length}\r`);
    await sleep(RATE_MS);
  } while (cmcontinue);
  console.log(`Fetching titles... ${titles.length} found.    `);
  return titles;
}

async function main() {
  if (!fs.existsSync(CARDS_FILE)) { console.error('raw-cards.json not found — run sync-cards.js first.'); process.exit(1); }
  const cards   = JSON.parse(fs.readFileSync(CARDS_FILE, 'utf8'));
  const byTitle = new Map(cards.map((c, i) => [c.title, i]));

  const titles = await fetchAllTitles();
  const info = new Map(); // wiki page title → { is_legend, card_type, property }

  for (let i = 0; i < titles.length; i += BATCH_SIZE) {
    const batch = titles.slice(i, i + BATCH_SIZE);
    const url = 'https://yugipedia.com/api.php?action=query'
      + '&titles=' + batch.map(encodeURIComponent).join('|')
      + '&prop=revisions&rvprop=content&format=json';
    let r;
    try { r = await get(url); } catch (e) { console.log(`\n  batch @${i} error: ${e.message}`); await sleep(2500); continue; }
    if (r.query && r.query.pages) {
      for (const page of Object.values(r.query.pages)) {
        if (page.missing !== undefined || !page.revisions) continue;
        const wt = page.revisions[0]?.['*'] || page.revisions[0]?.slots?.main?.['*'] || '';
        const e = parseEnrichment(wt);
        if (e) info.set(page.title, e);
      }
    }
    const legSoFar = [...info.values()].filter(x => x.is_legend).length;
    process.stdout.write(`  scanned ${Math.min(i + BATCH_SIZE, titles.length)}/${titles.length}, legends so far: ${legSoFar}\r`);
    await sleep(RATE_MS);
  }

  let tagged = 0, legends = 0;
  for (const c of cards) {
    const e = info.get(c.title);
    if (e) {
      c.is_legend = e.is_legend;
      c.card_type = e.card_type;
      c.property  = e.property;
      tagged++; if (e.is_legend) legends++;
    } else {
      if (c.is_legend === undefined) c.is_legend = false;
      if (c.card_type === undefined) c.card_type = null;
      if (c.property  === undefined) c.property  = null;
    }
  }

  fs.writeFileSync(CARDS_FILE, JSON.stringify(cards, null, 2), 'utf8');
  console.log(`\nEnriched ${tagged} cards (${legends} legends) → raw-cards.json`);

  console.log('Cleaning → cards.json...');
  cleanCards();

  // Quick report of the legend cards found
  const names = cards.filter(c => c.is_legend).map(c => c.title).sort();
  console.log(`\nLegend cards (${names.length}):`);
  console.log(names.join('\n'));
}

main().catch(e => { console.error('\nFatal:', e.message); process.exit(1); });
