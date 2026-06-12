'use strict';

// ── Phase 2 duel-core tests ─────────────────────────────────────────────────
// Run: node online/duel/state.test.js
// Focus: criterion 7 (no hidden-info leak) + criterion 3 (correct visibility) +
// structural ownership rejection. No test framework — plain asserts + a tally.

const assert = require('assert');
const S = require('./state');
const { apply } = require('./actions');
const { viewFor } = require('./view');

let passed = 0;
function ok(label, fn) {
  fn();
  passed++;
  console.log('  ✓ ' + label);
}

// Build a 5-card deck of sentinel cards with a recognisable prefix.
function deckOf(prefix) {
  return Array.from({ length: 5 }, (_, i) => ({ cardKey: `${prefix}_${i}`, rarity: '', imgFile: '' }));
}

console.log('duel core — visibility + ownership');

// ── Setup: two seats, decks loaded, hands drawn, face-down + face-up monsters ─
const game = S.createGame('a'.repeat(32), 'b'.repeat(32));
assert.strictEqual(apply(game, 0, 'loadDeck', { deck: deckOf('P0_DECKSECRET') }).ok, true);
assert.strictEqual(apply(game, 1, 'loadDeck', { deck: deckOf('P1_DECKSECRET') }).ok, true);
apply(game, 0, 'ready', {});
apply(game, 1, 'ready', {});
apply(game, 0, 'draw', { n: 3 });
apply(game, 1, 'draw', { n: 3 });

// Seat 1 sets a monster FACE-DOWN (secret) and places another FACE-UP (public).
const p1Hand = game.players[1].hand;
const faceDownIid = p1Hand[0].iid;
const faceUpIid   = p1Hand[1].iid;
// Tag the underlying cards so we can grep the serialized view for leaks.
game.players[1].hand.find(c => c.iid === faceDownIid).cardKey = 'P1_FACEDOWN_SECRET';
game.players[1].hand.find(c => c.iid === faceUpIid).cardKey   = 'P1_PUBLIC_MONSTER';
assert.strictEqual(apply(game, 1, 'move', { iid: faceDownIid, zone: 'monster', slot: 0, faceDown: true, position: 'def' }).ok, true);
assert.strictEqual(apply(game, 1, 'move', { iid: faceUpIid,   zone: 'monster', slot: 1, faceDown: false, position: 'atk' }).ok, true);

// ── Criterion 7: seat 0's view must not leak ANY of seat 1's hidden identities ─
const oppView = JSON.stringify(viewFor(game, 0));

ok('opponent deck identities never appear in the snapshot', () => {
  assert.ok(!oppView.includes('P1_DECKSECRET'), 'deck identity leaked to opponent');
});
ok('opponent hand identities never appear in the snapshot', () => {
  // The remaining (undrawn-into-field) hand cards of seat 1 stay hidden.
  const leaked = game.players[1].hand.some(c => oppView.includes(c.cardKey));
  assert.ok(!leaked, 'a hand identity leaked to opponent');
});
ok('opponent face-down monster identity is hidden', () => {
  assert.ok(!oppView.includes('P1_FACEDOWN_SECRET'), 'face-down identity leaked');
});
ok('deck is exposed as a count only, never as an array of cards', () => {
  const v = viewFor(game, 0);
  assert.strictEqual(typeof v.opp.deckCount, 'number');
  assert.strictEqual(v.opp.deck, undefined);
  assert.strictEqual(v.self.deck, undefined);
});

// ── Criterion 3: public things ARE visible with correct visibility ───────────
ok('opponent face-up monster IS visible to the other player', () => {
  assert.ok(oppView.includes('P1_PUBLIC_MONSTER'), 'face-up monster should be visible');
});
ok('opponent hand back-count is exposed (length without identity)', () => {
  const v = viewFor(game, 0);
  assert.strictEqual(v.opp.handCount, game.players[1].hand.length);
  assert.ok(v.opp.hand.every(c => c.hidden === true && c.cardKey === undefined));
});
ok('a player sees their OWN hand identities', () => {
  const selfView = JSON.stringify(viewFor(game, 1));
  assert.ok(game.players[1].hand.every(c => selfView.includes(c.cardKey)));
});
ok('a face-down card owner still sees its own identity', () => {
  const v = viewFor(game, 1);
  assert.strictEqual(v.self.monster[0].cardKey, 'P1_FACEDOWN_SECRET');
  assert.strictEqual(v.self.monster[0].faceDown, true);
});

// ── Ownership: you cannot act on a card that isn't yours ─────────────────────
ok('moving an opponent-owned card is rejected (not_your_card)', () => {
  const oppCardIid = game.players[1].monster[1].iid; // seat 1's face-up monster
  const res = apply(game, 0, 'move', { iid: oppCardIid, zone: 'graveyard' });
  assert.strictEqual(res.error, 'not_your_card');
});
ok('occupied slot rejects a second card (slot_occupied)', () => {
  const handCard = game.players[0].hand[0].iid;
  const res = apply(game, 0, 'move', { iid: handCard, zone: 'monster', slot: 1 });
  // seat 0 slot 1 is empty, so this should succeed; now try slot already filled
  assert.strictEqual(res.ok, true);
  const handCard2 = game.players[0].hand[0].iid;
  const res2 = apply(game, 0, 'move', { iid: handCard2, zone: 'monster', slot: 1 });
  assert.strictEqual(res2.error, 'slot_occupied');
});

// ── Misc actions ─────────────────────────────────────────────────────────────
ok('lp set/delta clamps at 0 and never goes negative', () => {
  apply(game, 0, 'lp', { mode: 'set', value: 8000 });
  apply(game, 0, 'lp', { mode: 'delta', value: -10000 });
  assert.strictEqual(game.players[0].lp, 0);
});
ok('coin + dice produce in-range public results in the log', () => {
  apply(game, 0, 'coin', {});
  apply(game, 0, 'dice', {});
  const coin = [...game.log].reverse().find(e => e.type === 'coin');
  const dice = [...game.log].reverse().find(e => e.type === 'dice');
  assert.ok(['heads', 'tails'].includes(coin.result));
  assert.ok(dice.result >= 1 && dice.result <= 6);
});
ok('turn token only passes for the current holder', () => {
  game.turn = 0;
  assert.strictEqual(apply(game, 1, 'passTurn', {}).error, 'not_your_turn');
  assert.strictEqual(apply(game, 0, 'passTurn', {}).ok, true);
  assert.strictEqual(game.turn, 1);
});
ok('lookDeck returns a PRIVATE payload, not a broadcast field', () => {
  const res = apply(game, 0, 'lookDeck', {});
  assert.ok(res.private && Array.isArray(res.private.cards));
  // And the public log only records that a look happened, not the contents.
  const entry = [...game.log].reverse().find(e => e.type === 'lookDeck');
  assert.ok(entry && entry.cards === undefined);
});

console.log(`\n${passed} checks passed.`);
