'use strict';

// ── Visibility filter (Phase 2) — THE anti-leak boundary ────────────────────
//
// `viewFor(game, seat)` is the ONLY game object ever sent to a client. It walks
// every zone and, for any card the viewer must not see, strips the identity
// fields (cardKey/rarity/imgFile) and replaces them with { hidden:true }.
//
// Invariant (criterion 7): a payload produced here NEVER contains the identity
// of a hidden card — opponent hand, any face-down card, or ANY deck card (order
// + identity stay server-side for both players; only the count is exposed).

// Public form: full identity + board flags.
function pub(card) {
  if (!card) return null;
  return {
    iid:      card.iid,
    cardKey:  card.cardKey,
    rarity:   card.rarity,
    imgFile:  card.imgFile,
    faceDown: card.faceDown,
    position: card.position,
  };
}

// Hidden form: a placeholder with a stable iid (for DOM keys/animations) but NO
// identity. We expose only board flags that are themselves public (a face-down
// card is visibly face-down to the opponent, and its battle position shows via
// rotation), never the card's name/art.
function hidden(card) {
  if (!card) return null;
  return {
    iid:      card.iid,
    hidden:   true,
    faceDown: card.faceDown,
    position: card.position,
  };
}

// A single slot (monster/spellTrap/field) as seen by a viewer.
//  - empty slot           → null
//  - face-up card         → visible to both
//  - face-down (set) card → identity only to its owner; opponent sees a back
function slotView(card, isOwner) {
  if (!card) return null;
  if (!card.faceDown) return pub(card);
  return isOwner ? pub(card) : hidden(card);
}

function boardView(board, isOwner) {
  return {
    lp:        board.lp,
    maximum:   board.maximum,
    // Hand: owner sees identities; opponent sees only backs (count = length).
    handCount: board.hand.length,
    hand:      board.hand.map(c => (isOwner ? pub(c) : hidden(c))),
    // Deck: NEVER expose contents or order to anyone — only the count.
    deckCount: board.deck.length,
    // Graveyard is a public, face-up pile for both players.
    graveyard: board.graveyard.map(pub),
    monster:   board.monster.map(c => slotView(c, isOwner)),
    spellTrap: board.spellTrap.map(c => slotView(c, isOwner)),
    field:     board.field.map(c => slotView(c, isOwner)),
  };
}

function viewFor(game, seat) {
  const opp = seat === 0 ? 1 : 0;
  return {
    you:     seat,
    turn:    game.turn,
    started: game.started,
    ended:   game.ended,
    winner:  game.winner,
    self:    boardView(game.players[seat], true),
    opp:     boardView(game.players[opp], false),
    log:     game.log.slice(-50),
  };
}

module.exports = { viewFor, boardView, slotView, pub, hidden };
