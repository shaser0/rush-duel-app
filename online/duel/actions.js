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

  // First shuffle + readiness. When both seats are ready a coin is tossed to
  // decide who picks first/second. The actual start is gated on chooseFirst.
  ready(game, seat) {
    if (game.started) return { error: 'already_started' };
    S.shuffle(game, seat);
    game._readyMask |= (1 << seat);
    S.pushLog(game, { type: 'ready', seat });
    if ((game._readyMask & 3) === 3 && game.tossWinner === null) {
      const both = game.players[0].deck.length > 0 && game.players[1].deck.length > 0;
      if (both) {
        game.tossWinner = Math.floor(Math.random() * 2);
        S.pushLog(game, { type: 'coinToss', tossWinner: game.tossWinner });
      }
    }
    return { ok: true };
  },

  // Cancel readiness before the game starts. Also cancels any pending coin toss
  // so the both-ready handshake restarts cleanly (e.g. if the opponent un-readies
  // while the toss winner is still choosing who goes first).
  unready(game, seat) {
    if (game.started) return { error: 'already_started' };
    game._readyMask &= ~(1 << seat);
    game.tossWinner = null;
    S.pushLog(game, { type: 'unready', seat });
    return { ok: true };
  },

  // Toss winner declares who goes first. This starts the game and deals hands.
  chooseFirst(game, seat, p) {
    if (game.started)           return { error: 'already_started' };
    if (game.tossWinner !== seat) return { error: 'not_your_choice' };
    if (typeof p.goFirst !== 'boolean') return { error: 'bad_payload' };
    game.turn    = p.goFirst ? seat : (seat === 0 ? 1 : 0);
    game.started = true;
    S.draw(game, 0, 4);
    S.draw(game, 1, 4);
    S.pushLog(game, { type: 'chooseFirst', seat, goFirst: p.goFirst, startSeat: game.turn });
    return { ok: true };
  },

  // ── Deck operations ───────────────────────────────────────────────────────
  // Send the top card of the deck directly to the graveyard (publicly logged).
  millTop(game, seat) {
    const board = game.players[seat];
    if (!board.deck.length) return { error: 'deck_empty' };
    const loc = { zone: 'deck', index: 0, card: board.deck[0] };
    const cardKey = board.deck[0].cardKey;
    const res = S.move(game, seat, loc, { zone: 'graveyard' });
    if (res.error) return res;
    S.pushLog(game, { type: 'millTop', seat, cardKey });
    return { ok: true };
  },

  // Reveal top N cards of the deck publicly (both players see the cardKeys in the log).
  // Cards stay in the deck; private response carries iids so the acting player can
  // move them individually via the existing move action.
  excavate(game, seat, p) {
    const n = Number.isInteger(p.n) ? Math.max(1, p.n) : 1;
    const board = game.players[seat];
    if (!board.deck.length) return { error: 'deck_empty' };
    const actual = Math.min(n, board.deck.length);
    const cards = board.deck.slice(0, actual).map(c => ({
      iid: c.iid, cardKey: c.cardKey, rarity: c.rarity, imgFile: c.imgFile,
    }));
    S.pushLog(game, { type: 'excavate', seat, cardKeys: cards.map(c => c.cardKey) });
    return { ok: true, private: { what: 'excavate', cards } };
  },

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

  // Load Fusion/Ritual monsters into the Extra Deck (before game starts).
  loadExtraDeck(game, seat, p) {
    if (game.started) return { error: 'already_started' };
    if (!Array.isArray(p.deck) || p.deck.length === 0) return { error: 'empty_deck' };
    if (p.deck.length > S.MAX_EXTRA_DECK) return { error: 'extra_deck_too_large' };
    S.loadExtraDeck(game, seat, p.deck);
    S.pushLog(game, { type: 'loadExtraDeck', seat, count: game.players[seat].extraDeck.length });
    return { ok: true };
  },

  // Owner privately views their own Extra Deck contents.
  lookExtraDeck(game, seat) {
    const cards = game.players[seat].extraDeck.map(c => ({
      iid: c.iid, cardKey: c.cardKey, rarity: c.rarity, imgFile: c.imgFile,
    }));
    S.pushLog(game, { type: 'lookExtraDeck', seat });
    return { ok: true, private: { what: 'extraDeck', cards } };
  },

  // ── Card movement (drag-and-drop) ─────────────────────────────────────────
  // The general mover. payload: { iid, zone, slot?, deckPos?, faceDown?, position? }
  move(game, seat, p) {
    const o = own(game, seat, p.iid);
    if (o.error) return o;
    const fromZone = o.loc.zone;
    // Capture the source identity BEFORE the move: if the card was already public
    // (face-up in a visible zone), its name stays loggable even when it lands in a
    // hidden zone — e.g. shuffling a Graveyard card back into the Deck.
    const srcVisible = fromZone === 'graveyard' || fromZone in S.SLOT_ZONES;
    const srcKey = (srcVisible && o.loc.card && !o.loc.card.faceDown) ? o.loc.card.cardKey : undefined;
    const res = S.move(game, seat, o.loc, p);
    if (res.error) return res;
    // Find the card in its new location to read final state for the log.
    const board = game.players[seat];
    let card = null;
    if (p.zone in S.SLOT_ZONES)    card = board[p.zone][p.slot];
    else if (p.zone !== 'deck')    card = board[p.zone][board[p.zone].length - 1];
    const faceDown = card ? card.faceDown : !!p.faceDown;
    // Identity is public only when face-up and in a visible zone (not hand/deck/extra).
    const visible = p.zone === 'graveyard' || p.zone in S.SLOT_ZONES;
    const destKey = (!faceDown && visible && card) ? card.cardKey : undefined;
    const cardKey = destKey ?? srcKey;
    S.pushLog(game, {
      type: 'move', seat, fromZone, zone: p.zone,
      slot: p.slot, faceDown, position: card ? card.position : undefined, cardKey,
    });
    return { ok: true };
  },

  // ── Take control of an opponent's monster (manual, declarative — a card
  // effect like "seize control" is trust-based like everything else here).
  // Monsters only: on the field, or off it sitting in their Graveyard.
  // payload: { iid, slot }
  takeControl(game, seat, p) {
    const oppSeat = seat === 0 ? 1 : 0;
    const loc = S.locate(game, oppSeat, p.iid);
    if (!loc) return { error: 'not_found' };
    const cardKey = !loc.card.faceDown ? loc.card.cardKey : undefined;
    const fromZone = loc.zone;
    const res = S.takeControl(game, oppSeat, seat, loc, p.slot);
    if (res.error) return res;
    S.pushLog(game, { type: 'takeControl', seat, fromSeat: oppSeat, fromZone, slot: p.slot, cardKey });
    return { ok: true };
  },

  // ── In-place state changes ────────────────────────────────────────────────
  // Toggle (or set) face-up/face-down for a card sitting in a slot zone.
  flip(game, seat, p) {
    const o = own(game, seat, p.iid);
    if (o.error) return o;
    if (S.PILE_ZONES.has(o.loc.zone)) return { error: 'not_on_field' };
    o.loc.card.faceDown = typeof p.faceDown === 'boolean' ? p.faceDown : !o.loc.card.faceDown;
    const card = o.loc.card;
    // Identity is public when the card is now face-up on the field.
    const cardKey = !card.faceDown ? card.cardKey : undefined;
    S.pushLog(game, { type: 'flip', seat, zone: o.loc.zone, faceDown: card.faceDown, cardKey });
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
    // Position is always public for face-up cards.
    const cardKey = !o.loc.card.faceDown ? o.loc.card.cardKey : undefined;
    S.pushLog(game, { type: 'position', seat, zone: o.loc.zone, position: next, cardKey });
    return { ok: true };
  },

  // Toggle the visual "Maximum mode" flag (renders the 3 monster slots merged).
  maximum(game, seat, p) {
    game.players[seat].maximum = typeof p.on === 'boolean' ? p.on : !game.players[seat].maximum;
    S.pushLog(game, { type: 'maximum', seat, on: game.players[seat].maximum });
    return { ok: true };
  },

  // ── Declare an attack (public). Logs attacker + defender for both clients. ───
  attack(game, seat, p) {
    const o = own(game, seat, p.attackerIid);
    if (o.error) return { error: o.error };
    if (o.loc.zone !== 'monster') return { error: 'not_a_monster' };
    const opp = game.players[seat === 0 ? 1 : 0];
    const defCard = Number.isInteger(p.defenderSlot) ? opp.monster[p.defenderSlot] : null;
    // Always reveal cardKey on attack — face-down defenders flip during battle.
    const defenderCardKey = defCard ? defCard.cardKey : null;
    S.pushLog(game, {
      type: 'attack', seat,
      attackerIid:     p.attackerIid,
      attackerCardKey: o.loc.card.cardKey,
      defenderSlot:    Number.isInteger(p.defenderSlot) ? p.defenderSlot : null,
      defenderCardKey,
      // Stat snapshots at time of attack (null = client uses reference data).
      attackerAtkOvr:  o.loc.card.atkOverride,
      defenderAtkOvr:  defCard?.atkOverride ?? null,
      defenderDefOvr:  defCard?.defOverride ?? null,
      defenderPos:     defCard?.position    ?? null,
    });
    return { ok: true };
  },

  // ── Override ATK/DEF of a face-up monster (synchronised boost/debuff). ──────
  statOverride(game, seat, p) {
    const o = own(game, seat, p.iid);
    if (o.error) return o;
    if (S.PILE_ZONES.has(o.loc.zone))   return { error: 'not_on_field' };
    if (o.loc.zone !== 'monster')        return { error: 'not_a_monster' };
    if (o.loc.card.faceDown)             return { error: 'card_face_down' };
    const card = o.loc.card;
    if (typeof p.atk === 'number') card.atkOverride = Math.max(0, Math.round(p.atk));
    if (p.atk === null)            card.atkOverride = null;
    if (typeof p.def === 'number') card.defOverride = Math.max(0, Math.round(p.def));
    if (p.def === null)            card.defOverride = null;
    S.pushLog(game, {
      type: 'statOverride', seat, iid: card.iid, cardKey: card.cardKey,
      atk: card.atkOverride, def: card.defOverride,
    });
    return { ok: true };
  },

  // ── Override Level / Attribute / Type(race) of a face-up monster. ──────────
  // Parallels statOverride; a value sets the override, null clears it (revert
  // to reference data). Trust-based / manual, like the rest of the board.
  metaOverride(game, seat, p) {
    const o = own(game, seat, p.iid);
    if (o.error) return o;
    if (S.PILE_ZONES.has(o.loc.zone)) return { error: 'not_on_field' };
    if (o.loc.zone !== 'monster')     return { error: 'not_a_monster' };
    if (o.loc.card.faceDown)          return { error: 'card_face_down' };
    const card = o.loc.card;
    if (typeof p.level === 'number') card.levelOverride = Math.max(0, Math.round(p.level));
    if (p.level === null)            card.levelOverride = null;
    if (typeof p.attribute === 'string') card.attrOverride = p.attribute;
    if (p.attribute === null)            card.attrOverride = null;
    if (typeof p.race === 'string') card.raceOverride = p.race;
    if (p.race === null)            card.raceOverride = null;
    S.pushLog(game, {
      type: 'metaOverride', seat, iid: card.iid, cardKey: card.cardKey,
      level: card.levelOverride, attribute: card.attrOverride, race: card.raceOverride,
    });
    return { ok: true };
  },

  // ── Target an opponent's card on the field or in the GY (public declaratory) ─
  target(game, seat, p) {
    const oppSeat = seat === 0 ? 1 : 0;
    // A card can be targeted whether it sits on the opponent's board or the
    // acting player's own (e.g. an effect that targets your own monster).
    const findOn = (ownerSeat) => {
      const board = game.players[ownerSeat];
      for (const zone of Object.keys(S.SLOT_ZONES)) {
        for (let i = 0; i < S.SLOT_ZONES[zone]; i++) {
          const c = board[zone][i];
          if (c && c.iid === p.iid) return { ownerSeat, zone, slot: i, cardKey: c.faceDown ? null : c.cardKey };
        }
      }
      const idx = board.graveyard.findIndex(c => c && c.iid === p.iid);
      if (idx !== -1) return { ownerSeat, zone: 'graveyard', slot: idx, cardKey: board.graveyard[idx].cardKey };
      return null;
    };
    const found = findOn(oppSeat) || findOn(seat);
    if (!found) return { error: 'not_found' };
    S.pushLog(game, {
      type: 'target', seat,
      targetIid: p.iid, targetZone: found.zone, targetSlot: found.slot,
      targetOwnerSeat: found.ownerSeat, cardKey: found.cardKey,
    });
    return { ok: true };
  },

  // ── Announce effect activation (public declaratory — no rule enforcement) ───
  activateEffect(game, seat, p) {
    const o = own(game, seat, p.iid);
    if (o.error) return o;
    if (S.PILE_ZONES.has(o.loc.zone)) return { error: 'not_on_field' };
    if (o.loc.card.faceDown) return { error: 'card_face_down' };
    S.pushLog(game, {
      type: 'activateEffect', seat,
      zone: o.loc.zone, cardKey: o.loc.card.cardKey,
    });
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
    const prev = board.lp;
    if (p.mode === 'set') board.lp = Math.max(0, Math.round(v));
    else                  board.lp = Math.max(0, board.lp + Math.round(v));
    const delta = board.lp - prev;
    S.pushLog(game, { type: 'lp', seat, lp: board.lp, delta });
    if (board.lp === 0 && !game.ended) {
      game.ended = true;
      game.winner = seat === 0 ? 1 : 0;
      S.pushLog(game, { type: 'lpLoss', seat });
    }
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
