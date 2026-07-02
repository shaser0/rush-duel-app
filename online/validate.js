'use strict';

const MAX_PSEUDO_LEN = 20;
const MIN_PSEUDO_LEN = 1;
const MAX_CHAT_LEN   = 500;
const CODE_RE        = /^[A-Z2-9]{6}$/;
const TOKEN_RE       = /^[a-f0-9]{16,64}$/i;

// Duel structural limits (kept in sync with duel/state.js).
const MAX_DECK       = 100;
const MAX_EXTRA_DECK = 15;
const ZONES    = new Set(['hand', 'deck', 'extraDeck', 'graveyard', 'monster', 'spellTrap', 'field']);
const ACTIONS  = new Set([
  'loadDeck', 'loadExtraDeck', 'ready', 'chooseFirst', 'millTop', 'shuffle', 'draw', 'excavate', 'lookDeck', 'lookExtraDeck',
  'move', 'flip', 'position', 'maximum', 'attack', 'statOverride', 'activateEffect', 'target', 'reveal', 'lp', 'coin', 'dice', 'passTurn', 'surrender', 'takeControl',
]);

function isPseudo(v) {
  if (typeof v !== 'string') return false;
  const t = v.trim();
  return t.length >= MIN_PSEUDO_LEN && t.length <= MAX_PSEUDO_LEN;
}

function isCode(v) {
  if (typeof v !== 'string') return false;
  return CODE_RE.test(v.trim().toUpperCase());
}

function isToken(v) {
  return v === undefined || (typeof v === 'string' && TOKEN_RE.test(v));
}

function isChatText(v) {
  if (typeof v !== 'string') return false;
  return v.trim().length > 0 && v.length <= MAX_CHAT_LEN;
}

// A raw card descriptor sent by the client when loading a deck. Identity fields
// are opaque strings; the server never interprets them.
function isCardDesc(c) {
  return c && typeof c === 'object'
    && typeof c.cardKey === 'string' && c.cardKey.length > 0 && c.cardKey.length <= 120
    && (c.rarity  === undefined || typeof c.rarity  === 'string')
    && (c.imgFile === undefined || typeof c.imgFile === 'string');
}

// Validate a duel:action envelope { action, payload }. Structural shape only —
// ownership/legality is enforced server-side in actions.js, not here.
function isDuelAction(data) {
  if (!data || typeof data !== 'object') return false;
  if (!ACTIONS.has(data.action)) return false;
  const p = data.payload || {};
  if (typeof p !== 'object') return false;
  switch (data.action) {
    case 'loadDeck':
      return Array.isArray(p.deck) && p.deck.length > 0 && p.deck.length <= MAX_DECK
        && p.deck.every(isCardDesc);
    case 'loadExtraDeck':
      return Array.isArray(p.deck) && p.deck.length > 0 && p.deck.length <= MAX_EXTRA_DECK
        && p.deck.every(isCardDesc);
    case 'chooseFirst':
      return typeof p.goFirst === 'boolean';
    case 'draw':
    case 'excavate':
      return p.n === undefined || (Number.isInteger(p.n) && p.n >= 1 && p.n <= 20);
    case 'move':
      return typeof p.iid === 'string' && ZONES.has(p.zone)
        && (p.slot === undefined || (Number.isInteger(p.slot) && p.slot >= 0 && p.slot < 3))
        && (p.deckPos === undefined || ['top', 'bottom', 'shuffle'].includes(p.deckPos))
        && (p.faceDown === undefined || typeof p.faceDown === 'boolean')
        && (p.position === undefined || ['atk', 'def'].includes(p.position));
    case 'attack':
      return typeof p.attackerIid === 'string'
        && (p.defenderSlot === undefined || p.defenderSlot === null
            || (Number.isInteger(p.defenderSlot) && p.defenderSlot >= 0 && p.defenderSlot < 3));
    case 'takeControl':
      return typeof p.iid === 'string' && Number.isInteger(p.slot) && p.slot >= 0 && p.slot < 3;
    case 'statOverride': {
      const validStat = v => v === undefined || v === null
        || (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 99999);
      return typeof p.iid === 'string' && validStat(p.atk) && validStat(p.def);
    }
    case 'target':
    case 'flip':
    case 'position':
    case 'activateEffect':
    case 'reveal':
      return typeof p.iid === 'string';
    case 'maximum':
      return p.on === undefined || typeof p.on === 'boolean';
    case 'lp':
      return ['delta', 'set'].includes(p.mode) && Number.isFinite(Number(p.value));
    // shuffle, ready, lookDeck, coin, dice, passTurn, surrender → no payload needed
    default:
      return true;
  }
}

// Returns true if the payload is valid for the given event type.
function validate(type, data) {
  if (!data || typeof data !== 'object') return false;
  switch (type) {
    case 'room:create':       return isPseudo(data.pseudo);
    case 'room:join':         return isPseudo(data.pseudo) && isCode(data.code) && isToken(data.token);
    case 'room:claim-seat':   return true; // no payload needed
    case 'room:release-seat': return true; // no payload needed
    case 'chat:message':      return isChatText(data.text);
    case 'duel:action':       return isDuelAction(data);
    case 'room:setting':      return typeof data.banlistEnforced === 'boolean';
    default:                  return false;
  }
}

module.exports = { validate, isDuelAction, MAX_PSEUDO_LEN, MAX_CHAT_LEN };
