'use strict';

// ── Action registry (Phase 2) ───────────────────────────────────────────────
//
// Each action is a pure function (game, seat, payload) → result, where result is:
//   { error: 'code' }                  → rejected (caller emits duel:error)
//   { ok: true }                       → applied; caller re-broadcasts snapshots
//   { ok: true, private: {...} }       → applied + a payload to send ONLY to the
//                                        acting player (e.g. "look at own deck")
//
// Actions perform STRUCTURAL validation only — ownership (it's your card / your
// zone) and shape — never game rules. They mutate the game via state.js mutators
// and append public ephemeral events via state.pushLog. Phase 5 automation will
// wrap these, not replace them.

const S = require('./state');

// Resolve & ownership-check a card iid for the acting seat.
function own(game, seat, iid) {
  if (typeof iid !== 'string') return { error: 'bad_iid' };
  const loc = S.locate(game, seat, iid);
  if (!loc) return { error: 'not_your_card' }; // also covers "doesn't exist"
  return { loc };
}

const ACTIONS = {
  // ── Start of game ─────────────────────────────────────────────────────────
  // Load a deck (array of opaque {cardKey,rarity,imgFile}) into the deck zone.
  loadDeck(game, seat, p) {
    if (game.started) return { error: 'already_started' };
    if (!Array.isArray(p.deck) || p.deck.length === 0) return { error: 'empty_deck' };
    if (p.deck.length > S.MAX_DECK) return { error: 'deck_too_large' };
    S.loadDeck(game, seat, p.deck);
    S.pushLog(game, { type: 'loadDeck', seat, count: game.players[seat].deck.length });
    return { ok: true };
  },

  // First shuffle + readiness. When both seats have a non-empty deck the game is
  // considered "started" (purely a UI gate; no rules are enforced).
  ready(game, seat) {
    S.shuffle(game, seat);
    const both = game.players[0].deck.length > 0 && game.players[1].deck.length > 0;
    if (both) {
      game.started = true;
      // Deal opening hands
      S.draw(game, 0, 4);
      S.draw(game, 1, 4);
    }
    S.pushLog(game, { type: 'ready', seat });
    return { ok: true };
  },

  // ── Deck operations ───────────────────────────────────────────────────────
  shuffle(game, seat) {
    S.shuffle(game, seat);
    S.pushLog(game, { type: 'shuffle', seat });
    return { ok: true };
  },

  draw(game, seat, p) {
    const n = Number.isInteger(p.n) ? p.n : 1;
    if (n < 1) return { error: 'bad_count' };
    const drawn = S.draw(game, seat, n);
    if (drawn === 0) return { error: 'deck_empty' };
    S.pushLog(game, { type: 'draw', seat, n: drawn });
    return { ok: true };
  },

  // Owner privately inspects their own deck (contents + order). NOT stored in the
  // snapshot, NOT shown to the opponent — a one-shot private reveal.
  lookDeck(game, seat) {
    const cards = game.players[seat].deck.map(c => ({
      iid: c.iid, cardKey: c.cardKey, rarity: c.rarity, imgFile: c.imgFile,
    }));
    S.pushLog(game, { type: 'lookDeck', seat }); // public knows you looked, not what
    return { ok: true, private: { what: 'deck', cards } };
  },

  // ── Card movement (drag-and-drop) ─────────────────────────────────────────
  // The general mover. payload: { iid, zone, slot?, deckPos?, faceDown?, position? }
  move(game, seat, p) {
    const o = own(game, seat, p.iid);
    if (o.error) return o;
    const res = S.move(game, seat, o.loc, p);
    if (res.error) return res;
    S.pushLog(game, { type: 'move', seat, zone: p.zone });
    return { ok: true };
  },

  // ── In-place state changes ────────────────────────────────────────────────
  // Toggle (or set) face-up/face-down for a card sitting in a slot zone.
  flip(game, seat, p) {
    const o = own(game, seat, p.iid);
    if (o.error) return o;
    if (S.PILE_ZONES.has(o.loc.zone)) return { error: 'not_on_field' };
    o.loc.card.faceDown = typeof p.faceDown === 'boolean' ? p.faceDown : !o.loc.card.faceDown;
    S.pushLog(game, { type: 'flip', seat });
    return { ok: true };
  },

  // Toggle (or set) battle position (atk/def) for a card in a slot zone.
  position(game, seat, p) {
    const o = own(game, seat, p.iid);
    if (o.error) return o;
    if (S.PILE_ZONES.has(o.loc.zone)) return { error: 'not_on_field' };
    const next = p.position === 'atk' || p.position === 'def'
      ? p.position
      : (o.loc.card.position === 'atk' ? 'def' : 'atk');
    o.loc.card.position = next;
    S.pushLog(game, { type: 'position', seat, position: next });
    return { ok: true };
  },

  // Toggle the visual "Maximum mode" flag (renders the 3 monster slots merged).
  maximum(game, seat, p) {
    game.players[seat].maximum = typeof p.on === 'boolean' ? p.on : !game.players[seat].maximum;
    S.pushLog(game, { type: 'maximum', seat, on: game.players[seat].maximum });
    return { ok: true };
  },

  // ── Reveal one of your own cards to the opponent (public, one-shot) ────────
  reveal(game, seat, p) {
    const o = own(game, seat, p.iid);
    if (o.error) return o;
    const c = o.loc.card;
    S.pushLog(game, {
      type: 'reveal', seat,
      card: { iid: c.iid, cardKey: c.cardKey, rarity: c.rarity, imgFile: c.imgFile },
    });
    return { ok: true };
  },

  // ── Life points ───────────────────────────────────────────────────────────
  // payload: { mode:'delta'|'set', value:number }
  lp(game, seat, p) {
    const v = Number(p.value);
    if (!Number.isFinite(v)) return { error: 'bad_value' };
    const board = game.players[seat];
    if (p.mode === 'set') board.lp = Math.max(0, Math.round(v));
    else                  board.lp = Math.max(0, board.lp + Math.round(v));
    S.pushLog(game, { type: 'lp', seat, lp: board.lp });
    return { ok: true };
  },

  // ── RNG (public) ──────────────────────────────────────────────────────────
  coin(game, seat) {
    const result = Math.random() < 0.5 ? 'heads' : 'tails';
    S.pushLog(game, { type: 'coin', seat, result });
    return { ok: true };
  },

  dice(game, seat) {
    const result = 1 + Math.floor(Math.random() * 6);
    S.pushLog(game, { type: 'dice', seat, result });
    return { ok: true };
  },

  // ── Turn token ────────────────────────────────────────────────────────────
  // Only the current holder may pass the token to the other seat.
  passTurn(game, seat) {
    if (game.turn !== seat) return { error: 'not_your_turn' };
    game.turn = seat === 0 ? 1 : 0;
    S.pushLog(game, { type: 'passTurn', seat, turn: game.turn });
    return { ok: true };
  },

  surrender(game, seat) {
    if (game.ended) return { error: 'already_ended' };
    game.ended = true;
    game.winner = seat === 0 ? 1 : 0;
    S.pushLog(game, { type: 'surrender', seat });
    return { ok: true };
  },
};

// Dispatch one action. Returns the action's result, or { error } for unknown
// action / not-started guards.
function apply(game, seat, action, payload) {
  const fn = ACTIONS[action];
  if (!fn) return { error: 'unknown_action' };
  if (game.ended && action !== 'surrender') return { error: 'game_over' };
  return fn(game, seat, payload || {});
}

module.exports = { ACTIONS, apply };
