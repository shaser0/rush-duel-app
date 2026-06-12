'use strict';

// ── Duel game state (Phase 2) ───────────────────────────────────────────────
//
// PURE data structure + low-level structural mutators. NO networking, NO game
// rules. The server is a "dumb board" à la Duelingbook: it tracks where opaque
// card instances sit, never what they mean. Rule automation (Phase 5) will be a
// separate layer ON TOP of this — it must never be needed to read/move a card.
//
// A card INSTANCE is opaque to the server:
//   { iid, cardKey, rarity, imgFile, faceDown:bool, position:'atk'|'def' }
// cardKey/rarity/imgFile come straight from the client's deck (the client owns
// cards.json + image-urls.json). The server only assigns the unique `iid` and
// shuffles/moves instances. `faceDown`/`position` are board state, not identity.

const STARTING_LP = 8000;
const MONSTER_SLOTS    = 3;
const SPELLTRAP_SLOTS  = 3;
const FIELD_SLOTS      = 1;
const MAX_DECK         = 100; // structural payload bound (legality is à l'honneur)
const MAX_DRAW         = 20;

// Zones that hold an ordered array of instances (piles).
const PILE_ZONES  = new Set(['hand', 'deck', 'graveyard']);
// Zones that hold a fixed number of single-card slots.
const SLOT_ZONES  = { monster: MONSTER_SLOTS, spellTrap: SPELLTRAP_SLOTS, field: FIELD_SLOTS };
const ALL_ZONES   = new Set([...PILE_ZONES, ...Object.keys(SLOT_ZONES)]);

// ── Construction ────────────────────────────────────────────────────────────

function createBoard(token) {
  return {
    token,                 // stable player identity (for reconnection)
    lp:        STARTING_LP,
    hand:      [],
    deck:      [],         // top of deck = index 0
    graveyard: [],
    monster:   new Array(MONSTER_SLOTS).fill(null),
    spellTrap: new Array(SPELLTRAP_SLOTS).fill(null),
    field:     new Array(FIELD_SLOTS).fill(null),
    maximum:   false,      // visual hint: render the 3 monster slots as one Maximum unit
  };
}

function createGame(seat0Token, seat1Token) {
  return {
    _iidSeq: 0,
    turn:    0,            // seat index currently holding the turn token
    started: false,
    ended:   false,
    winner:  null,         // seat index of winner on surrender, else null
    players: { 0: createBoard(seat0Token), 1: createBoard(seat1Token) },
    log:     [],           // public ephemeral events (coin/dice/reveal/lp/turn…)
  };
}

// ── iid + log helpers ───────────────────────────────────────────────────────

function nextIid(game) {
  return 'i' + (++game._iidSeq).toString(36);
}

const MAX_LOG = 100;
function pushLog(game, entry) {
  game.log.push({ ...entry, ts: Date.now() });
  if (game.log.length > MAX_LOG) game.log.shift();
}

// ── Instance normalisation ──────────────────────────────────────────────────
// Turn a raw client-sent card descriptor into a server instance. We keep ONLY
// the opaque identity fields + board flags; anything else is dropped so a client
// cannot smuggle extra state into the authoritative game.
function makeInstance(game, raw) {
  return {
    iid:      nextIid(game),
    cardKey:  String(raw && raw.cardKey != null ? raw.cardKey : ''),
    rarity:   raw && raw.rarity  != null ? String(raw.rarity)  : '',
    imgFile:  raw && raw.imgFile != null ? String(raw.imgFile) : '',
    faceDown: false,
    position: 'atk',
  };
}

// ── Lookup ──────────────────────────────────────────────────────────────────
// Find a card instance owned by `seat` by its iid. Returns { zone, index, card }
// or null. This is the ownership gate: a card that is not in THIS seat's zones is
// not theirs to touch.
function locate(game, seat, iid) {
  const board = game.players[seat];
  if (!board) return null;
  for (const zone of PILE_ZONES) {
    const idx = board[zone].findIndex(c => c && c.iid === iid);
    if (idx !== -1) return { zone, index: idx, card: board[zone][idx] };
  }
  for (const zone of Object.keys(SLOT_ZONES)) {
    const idx = board[zone].findIndex(c => c && c.iid === iid);
    if (idx !== -1) return { zone, index: idx, card: board[zone][idx] };
  }
  return null;
}

// Remove a card from where it currently sits (pile splice / slot null-out).
function removeAt(board, loc) {
  if (PILE_ZONES.has(loc.zone)) {
    return board[loc.zone].splice(loc.index, 1)[0];
  }
  const card = board[loc.zone][loc.index];
  board[loc.zone][loc.index] = null;
  return card;
}

// ── Mutators (structural only — they assume the caller already validated) ────

function loadDeck(game, seat, instances) {
  const board = game.players[seat];
  board.deck = instances.slice(0, MAX_DECK).map(raw => makeInstance(game, raw));
}

function shuffle(game, seat) {
  const deck = game.players[seat].deck;
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
}

function draw(game, seat, n) {
  const board = game.players[seat];
  const count = Math.max(0, Math.min(n, board.deck.length, MAX_DRAW));
  const drawn = board.deck.splice(0, count);
  for (const c of drawn) { c.faceDown = false; c.position = 'atk'; }
  board.hand.push(...drawn);
  return count;
}

// Move a located card to a destination. dest:
//   { zone, slot?, deckPos?:'top'|'bottom'|'shuffle', faceDown?, position? }
// Returns { ok } or { error }. Structural rules only:
//  - destination zone must exist;
//  - slot zones: slot index in range and target slot empty (or it's the same slot).
function move(game, seat, loc, dest) {
  const board = game.players[seat];
  const zone  = dest.zone;
  if (!ALL_ZONES.has(zone)) return { error: 'bad_zone' };

  if (zone in SLOT_ZONES) {
    const slot = dest.slot;
    if (!Number.isInteger(slot) || slot < 0 || slot >= SLOT_ZONES[zone])
      return { error: 'bad_slot' };
    const occupant = board[zone][slot];
    const sameSlot = loc.zone === zone && loc.index === slot;
    if (occupant && !sameSlot) return { error: 'slot_occupied' };
  }

  const card = removeAt(board, loc);

  // Apply optional state flags requested by the move.
  if (typeof dest.faceDown === 'boolean') card.faceDown = dest.faceDown;
  if (dest.position === 'atk' || dest.position === 'def') card.position = dest.position;

  if (zone in SLOT_ZONES) {
    board[zone][dest.slot] = card;
  } else if (zone === 'deck') {
    card.faceDown = false; card.position = 'atk';
    const where = dest.deckPos || 'top';
    if (where === 'bottom')       board.deck.push(card);
    else if (where === 'shuffle') { board.deck.push(card); shuffle(game, seat); }
    else                          board.deck.unshift(card); // top
  } else { // hand or graveyard
    if (zone === 'hand')      { card.faceDown = false; card.position = 'atk'; }
    if (zone === 'graveyard') { card.faceDown = false; }
    board[zone].push(card);
  }
  return { ok: true };
}

module.exports = {
  STARTING_LP, MONSTER_SLOTS, SPELLTRAP_SLOTS, FIELD_SLOTS, MAX_DECK, MAX_DRAW,
  PILE_ZONES, SLOT_ZONES, ALL_ZONES,
  createGame, createBoard, nextIid, pushLog, makeInstance,
  locate, removeAt, loadDeck, shuffle, draw, move,
};
