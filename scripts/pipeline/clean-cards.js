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
// (the cleaned file the app serves). Exported so sync-cards.js / tag-legends.js
// can run it in-process; also runnable standalone: `node scripts/pipeline/clean-cards.js`.
function cleanCards() {
let raw;
try {
  raw = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'raw-cards.json'), 'utf8'));
} catch (e) {
  throw new Error(`raw-cards.json illisible ou corrompu (${e.message}). ` +
    `Supprimer le fichier et relancer le sync pour le régénérer.`);
}

const cleaned = raw.map(card => ({
  ...card,
  raw_name_en:  card.name_en || card.title,
  title:        stripParens(card.title),
  name_en:      stripParens(card.name_en || card.title),
  name_ja:      stripRuby(card.name_ja),
  name_ko:      card.name_ko ? stripWikiMarkup(stripRuby(card.name_ko)) : null,
  name_fr:      stripWikiMarkup(card.name_fr),
  name_de:      stripWikiMarkup(card.name_de),
  name_it:      stripWikiMarkup(card.name_it),
  name_es:      stripWikiMarkup(card.name_es),
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
  if (overrideCount) console.log(`${overrideCount} carte(s) avec sets_jp corrigés via sets-overrides.json`);
}

writeJsonAtomic(path.join(DATA_DIR, 'cards.json'), cleaned);
console.log(`${cleaned.length} cartes traitées → cards.json`);
return cleaned;
}

module.exports = { cleanCards };

// Run directly: `node scripts/pipeline/clean-cards.js`
if (require.main === module) cleanCards();
