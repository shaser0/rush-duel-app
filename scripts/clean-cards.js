'use strict';

const fs = require('fs');
const path = require('path');

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
// No Rush Duel card names or archetypes contain meaningful parentheses —
// all are Yugipedia disambiguation suffixes like (card), (Rush Duel), etc.

function stripParens(text) {
  if (!text) return text;
  return text.replace(/\s*\([^)]*\)\s*/g, ' ').trim();
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
const raw = JSON.parse(fs.readFileSync(path.join(__dirname, '../data/raw-cards.json'), 'utf8'));

const cleaned = raw.map(card => ({
  ...card,
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

fs.writeFileSync(path.join(__dirname, '../data/cards.json'), JSON.stringify(cleaned, null, 2), 'utf8');
console.log(`${cleaned.length} cartes traitées → cards.json`);
return cleaned;
}

module.exports = { cleanCards };

// Run directly: `node scripts/clean-cards.js`
if (require.main === module) cleanCards();
