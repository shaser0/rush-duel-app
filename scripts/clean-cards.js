'use strict';

const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.RUSH_DATA_DIR || path.join(__dirname, '../data');

// ── Wiki markup ──────────────────────────────────────────────────────────────

function stripWikiMarkup(text) {
  if (!text) return text;
  // [[Target|Display]] → Display,  [[Word]] → Word
  return text.replace(/\[\[([^\]]+)\]\]/g, (_, inner) => {
    const parts = inner.split('|');
    return parts[parts.length - 1].trim();
  });
}

// ── Strip parenthetical content ──────────────────────────────────────────────
// Most parenthetical suffixes are Yugipedia disambiguation (card), (Rush Duel).
// Exception: (L) and (R) are part of the card name for Maximum monster variants.

function stripParens(text) {
  if (!text) return text;
  return text.replace(/\s*\((?!(?:L|R)\))[^)]*\)\s*/g, ' ').trim();
}

// ── Archseries ───────────────────────────────────────────────────────────────
// "* Draco * The" means the card belongs to both "Draco" and "The" archetypes.
// Split on asterisks, strip parens from each part, filter empty strings.

function parseArchseries(raw) {
  if (!raw) return [];
  return raw.split('*').map(a => stripParens(a).trim()).filter(Boolean);
}

// ── Ruby markup ──────────────────────────────────────────────────────────────

function stripRuby(text) {
  if (!text) return text;
  // {{Ruby|漢字|ふりがな}} → 漢字
  return text.replace(/\{\{[Rr]uby\|([^|]+)\|[^}]+\}\}/g, '$1').trim();
}

// ── Images ───────────────────────────────────────────────────────────────────

function parseImages(raw) {
  if (!raw) return [];

  const lines = raw.split('\n').map(l => l.trim()).filter(Boolean);
  const result = [];

  for (const line of lines) {
    const numbered = line.match(/^(\d+)\s*;\s*(.+)$/);

    if (numbered) {
      const artworkNum = parseInt(numbered[1], 10);
      const files = numbered[2].split(';').map(f => f.trim()).filter(Boolean);
      const file = files.find(f => !f.includes('-VG-'));
      if (file) result.push({ artwork: artworkNum, file });
    } else {
      // Plain filename — treat as artwork 1
      if (!line.includes('-VG-')) result.push({ artwork: 1, file: line });
    }
  }

  return result;
}

// ── Sets ─────────────────────────────────────────────────────────────────────

function parseSets(raw) {
  if (!raw) return [];

  return raw
    .split('\n')
    .map(l => l.trim())
    .filter(Boolean)
    .map(line => {
      const parts = line.split(';').map(p => p.trim());
      if (parts.length < 3) return null;
      // rejoin anything after the 2nd semicolon in case the rarity contains one
      return { code: parts[0], name: parts[1], rarity: parts.slice(2).join(';').trim() };
    })
    .filter(Boolean);
}

// ── Main ─────────────────────────────────────────────────────────────────────

// Reads data/raw-cards.json (raw Yugipedia fetch) and writes data/cards.json
// (the cleaned file the app serves). Exported so sync-cards.js / tag-legends.js
// can run it in-process; also runnable standalone: `node scripts/clean-cards.js`.
function cleanCards() {
const raw = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'raw-cards.json'), 'utf8'));

const cleaned = raw.map(card => ({
  ...card,
  raw_name_en:  card.name_en || card.title,
  title:        stripParens(card.title),
  name_en:      stripParens(card.name_en || card.title),
  name_ja:      stripRuby(card.name_ja),
  condition:    stripWikiMarkup(card.condition),
  effect_types: card.effect_types || null,
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

const outPath = path.join(DATA_DIR, 'cards.json');
const tmpPath = outPath + '.tmp';
fs.writeFileSync(tmpPath, JSON.stringify(cleaned, null, 2), 'utf8');
fs.renameSync(tmpPath, outPath);
console.log(`${cleaned.length} cartes traitées → cards.json`);
return cleaned;
}

module.exports = { cleanCards };

// Run directly: `node scripts/clean-cards.js`
if (require.main === module) cleanCards();
