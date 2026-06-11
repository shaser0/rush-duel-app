'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  stripWikiMarkup, stripParens, parseArchseries,
  stripRuby, parseImages, parseSets,
} = require('../scripts/pipeline/clean-cards-pure');

// ── stripWikiMarkup ──────────────────────────────────────────────────────────

test('stripWikiMarkup: null/empty passthrough', () => {
  assert.equal(stripWikiMarkup(null), null);
  assert.equal(stripWikiMarkup(''), '');
});

test('stripWikiMarkup: plain text unchanged', () => {
  assert.equal(stripWikiMarkup('No markup here.'), 'No markup here.');
});

test('stripWikiMarkup: [[Word]] → Word', () => {
  assert.equal(stripWikiMarkup('a [[Dragon]] appears'), 'a Dragon appears');
});

test('stripWikiMarkup: [[Target|Display]] → Display', () => {
  assert.equal(stripWikiMarkup('[[Speed World|the field]]'), 'the field');
});

test('stripWikiMarkup: [[A|B|C]] keeps last segment', () => {
  assert.equal(stripWikiMarkup('[[A|B|C]]'), 'C');
});

test('stripWikiMarkup: multiple links in one string', () => {
  assert.equal(stripWikiMarkup('[[A]] and [[B|b]]'), 'A and b');
});

// ── stripParens ──────────────────────────────────────────────────────────────

test('stripParens: null/empty passthrough', () => {
  assert.equal(stripParens(null), null);
  assert.equal(stripParens(''), '');
});

test('stripParens: removes disambiguation suffix', () => {
  assert.equal(stripParens('Card Name (Rush Duel)'), 'Card Name');
  assert.equal(stripParens('Card Name (card)'), 'Card Name');
});

test('stripParens: preserves Maximum (L) and (R) suffixes', () => {
  assert.equal(stripParens('Magnum Overlord (L)'), 'Magnum Overlord (L)');
  assert.equal(stripParens('Magnum Overlord (R)'), 'Magnum Overlord (R)');
});

test('stripParens: mid-string parenthetical', () => {
  assert.equal(stripParens('Sevens (Rush Duel) Road'), 'Sevens Road');
});

// ── stripRuby ────────────────────────────────────────────────────────────────

test('stripRuby: null/empty passthrough', () => {
  assert.equal(stripRuby(null), null);
  assert.equal(stripRuby(''), '');
});

test('stripRuby: {{Ruby|kanji|furigana}} keeps kanji', () => {
  assert.equal(stripRuby('{{Ruby|漢字|ふりがな}}'), '漢字');
});

test('stripRuby: ruby inside surrounding text', () => {
  assert.equal(stripRuby('{{Ruby|青眼|ブルーアイズ}}の白龍'), '青眼の白龍');
});

test('stripRuby: multiple ruby templates', () => {
  assert.equal(stripRuby('{{Ruby|A|a}}{{Ruby|B|b}}'), 'AB');
});

test('stripRuby: plain text unchanged', () => {
  assert.equal(stripRuby('プレーンテキスト'), 'プレーンテキスト');
});

// ── parseImages ──────────────────────────────────────────────────────────────

test('parseImages: null/empty → []', () => {
  assert.deepEqual(parseImages(null), []);
  assert.deepEqual(parseImages(''), []);
});

test('parseImages: integer-numbered line', () => {
  assert.deepEqual(parseImages('1; Card-RD001-JP.png'),
    [{ artwork: 1, file: 'Card-RD001-JP.png' }]);
});

test('parseImages: plain filename → artwork 1', () => {
  assert.deepEqual(parseImages('Card-RD001-JP.png'),
    [{ artwork: 1, file: 'Card-RD001-JP.png' }]);
});

test('parseImages: -VG- files are skipped', () => {
  assert.deepEqual(parseImages('Card-VG-art.png'), []);
  assert.deepEqual(parseImages('1; Card-VG-art.png'), []);
});

test('parseImages: picks first non-VG file on a multi-file line', () => {
  assert.deepEqual(parseImages('1; Card-VG-art.png; Card-RD001-JP.png'),
    [{ artwork: 1, file: 'Card-RD001-JP.png' }]);
});

test('parseImages: multiline with distinct artwork numbers', () => {
  assert.deepEqual(parseImages('1; A.png\n2; B.png'), [
    { artwork: 1, file: 'A.png' },
    { artwork: 2, file: 'B.png' },
  ]);
});

// ── parseSets ────────────────────────────────────────────────────────────────

test('parseSets: null/empty → []', () => {
  assert.deepEqual(parseSets(null), []);
  assert.deepEqual(parseSets(''), []);
});

test('parseSets: standard 3-field line', () => {
  assert.deepEqual(parseSets('RD/KP01-JP001; Deck Modification Pack; Ultra Rare'),
    [{ code: 'RD/KP01-JP001', name: 'Deck Modification Pack', rarity: 'Ultra Rare' }]);
});

test('parseSets: rarity containing a semicolon is rejoined', () => {
  assert.deepEqual(parseSets('C1; Set Name; Ultra; Secret'),
    [{ code: 'C1', name: 'Set Name', rarity: 'Ultra;Secret' }]);
});

test('parseSets: multiline input', () => {
  assert.equal(parseSets('A; S1; Common\nB; S2; Rare').length, 2);
});

// ── parseArchseries ──────────────────────────────────────────────────────────

test('parseArchseries: null/empty → []', () => {
  assert.deepEqual(parseArchseries(null), []);
  assert.deepEqual(parseArchseries(''), []);
});

test('parseArchseries: leading asterisk and multiple entries', () => {
  assert.deepEqual(parseArchseries('* Draco * The'), ['Draco', 'The']);
});

test('parseArchseries: single entry without asterisk', () => {
  assert.deepEqual(parseArchseries('Draco'), ['Draco']);
});

test('parseArchseries: parentheticals stripped from each entry', () => {
  assert.deepEqual(parseArchseries('Draco (archetype)'), ['Draco']);
});
