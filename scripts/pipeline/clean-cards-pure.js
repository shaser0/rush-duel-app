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
// Exception: (L), (R) and (C) are part of the card name for Maximum monster
// variants — same letters sync-gallery folds into the image slug.

function stripParens(text) {
  if (!text) return text;
  // [^()]* only matches the innermost level; iterate until stable so
  // nested parentheticals like "(A (B) C)" leave no orphan ")" behind.
  let prev;
  do {
    prev = text;
    text = text.replace(/\s*\((?!(?:[LRC])\))[^()]*\)\s*/g, ' ');
  } while (text !== prev);
  return text.trim().replace(/\s{2,}/g, ' ');
}

// ── Archseries ───────────────────────────────────────────────────────────────
// "* Draco * The" means the card belongs to both "Draco" and "The" archetypes.
// Split on asterisks, strip parens from each part, filter empty strings.

function parseArchseries(raw) {
  if (!raw) return [];
  return raw.split('*').map(a => stripWikiMarkup(stripParens(a)).trim()).filter(Boolean);
}

// ── Ruby markup ──────────────────────────────────────────────────────────────

function stripRuby(text) {
  if (!text) return text;
  // {{Ruby|漢字|ふりがな}} → 漢字
  // [^|{}]+ only matches the innermost template; iterate until stable so a
  // Ruby nested inside another template leaves no orphan "{{" behind.
  let prev;
  do {
    prev = text;
    text = text.replace(/\{\{[Rr]uby\|([^|{}]+)\|[^|{}]+\}\}/g, '$1');
  } while (text !== prev);
  return text.trim();
}

// ── Images ───────────────────────────────────────────────────────────────────

function parseImages(raw) {
  if (!raw) return [];

  const lines = raw.split('\n').map(l => l.trim()).filter(Boolean);
  const result = [];

  for (const line of lines) {
    // Yugipedia uses both "1; file.png" and "1.0; file.png" artwork prefixes
    const numbered = line.match(/^(\d+(?:\.\d+)?)\s*;\s*(.+)$/);

    if (numbered) {
      const artworkNum = parseFloat(numbered[1]);
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
      if (parts.length < 2) return null;
      if (parts.length < 3) console.warn(`[clean-cards] parseSets: ligne sans rarity: "${line}"`);
      // rejoin anything after the 2nd semicolon in case the rarity contains one
      const rarity = parts.length >= 3 ? parts.slice(2).join(';').trim() : '';
      return {
        code:   stripWikiMarkup(parts[0]),
        name:   stripWikiMarkup(parts[1]),
        rarity: stripWikiMarkup(rarity),
      };
    })
    .filter(Boolean);
}

module.exports = { stripWikiMarkup, stripParens, parseArchseries, stripRuby, parseImages, parseSets };
