'use strict';

const fs = require('fs');
const path = require('path');
const { writeJsonAtomic } = require('../lib/fs-atomic');
const { DATA_DIR }        = require('../lib/paths');
const {
  stripWikiMarkup, stripParens, parseArchseries,
  stripRuby, parseImages, parseSets,
} = require('./clean-cards-pure');

// ── Main ─────────────────────────────────────────────────────────────────────

// Reads data/raw-cards.json (raw Yugipedia fetch) and writes data/cards.json
// (the cleaned file the app serves). Exported so sync-cards.js can run it
// in-process; also runnable standalone: `node scripts/pipeline/clean-cards.js`.
function cleanCards() {
let raw;
try {
  raw = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'raw-cards.json'), 'utf8'));
} catch (e) {
  throw new Error(`raw-cards.json unreadable or corrupted (${e.message}). ` +
    `Delete the file and re-run the sync to regenerate it.`);
}

const cleaned = raw.map(card => ({
  ...card,
  raw_name_en:  card.name_en || card.title,
  title:        stripParens(card.title),
  // Keep name_en null when the wiki has no distinct English name. It's a
  // sparse field (~60 cards, Duel Links crossover) carrying the canonical
  // formatting — [L]/[R] and #2 where the page title only has (L)/(R)/2 —
  // which is why cname() and the L/R badge prefer it. Folding the title in
  // here would just mask which cards actually have that native name.
  name_en:      card.name_en ? stripParens(card.name_en) : null,
  name_ja:      stripRuby(card.name_ja),
  name_ko:      card.name_ko ? stripWikiMarkup(stripRuby(card.name_ko)) : null,
  name_fr:      stripWikiMarkup(card.name_fr),
  name_de:      stripWikiMarkup(card.name_de),
  name_it:      stripWikiMarkup(card.name_it),
  name_es:      stripWikiMarkup(card.name_es),
  name_translated: stripWikiMarkup(card.name_translated),
  flavor_text:  stripWikiMarkup(card.flavor_text),
  condition:    stripWikiMarkup(card.condition),
  effect_types: stripWikiMarkup(card.effect_types) || null,
  materials:    stripWikiMarkup(card.materials),
  requirement:  stripWikiMarkup(card.requirement),
  effect:       stripWikiMarkup(card.effect),
  images:       parseImages(card.images),
  sets_jp:      parseSets(card.sets_jp),
  sets_kr:      parseSets(card.sets_kr),
  archseries:   parseArchseries(card.archseries),
  is_legend:    !!card.is_legend,
}));

// Drop null name fields rather than carry them on every card. All of these
// are sparse: name_en (~60, Duel Links crossover), fr/de/it/es (457 each,
// same), name_ko (~2830), name_translated (~1014). Consumers treat a missing
// key and null identically (name lookups fall back through cname/searchName).
const NAME_FIELDS = [
  'name_en', 'name_ja', 'name_ja_romaji', 'name_ko',
  'name_fr', 'name_de', 'name_it', 'name_es', 'name_translated',
];
for (const card of cleaned)
  for (const f of NAME_FIELDS)
    if (card[f] == null || card[f] === '') delete card[f];

// Apply manual set overrides for cards missing sets_jp on the wiki
const overridesPath = path.join(DATA_DIR, 'sets-overrides.json');
if (fs.existsSync(overridesPath)) {
  const overrides = JSON.parse(fs.readFileSync(overridesPath, 'utf8'));
  let overrideCount = 0;
  for (const card of cleaned) {
    if (card.sets_jp && card.sets_jp.length > 0) continue;
    const name = card.name_en || card.title;
    if (overrides[name]) {
      card.sets_jp = overrides[name];
      overrideCount++;
    }
  }
  if (overrideCount) console.log(`${overrideCount} card(s) with sets_jp fixed via sets-overrides.json`);
}

writeJsonAtomic(path.join(DATA_DIR, 'cards.json'), cleaned);
console.log(`${cleaned.length} cards processed -> cards.json`);
return cleaned;
}

module.exports = { cleanCards };

// Run directly: `node scripts/pipeline/clean-cards.js`
if (require.main === module) cleanCards();
