'use strict';

// Pure data-transform functions used by clean-cards.js — no I/O, no side
// effects. Kept in a separate module so they can be unit-tested directly
// (see tests/clean-cards.test.js).

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

module.exports = { stripWikiMarkup, stripParens, parseArchseries, stripRuby, parseImages, parseSets };
