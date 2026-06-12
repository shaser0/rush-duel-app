'use strict';

const MAX_PSEUDO_LEN = 20;
const MIN_PSEUDO_LEN = 1;
const MAX_CHAT_LEN   = 500;
const CODE_RE        = /^[A-Z2-9]{6}$/;

function isPseudo(v) {
  if (typeof v !== 'string') return false;
  const t = v.trim();
  return t.length >= MIN_PSEUDO_LEN && t.length <= MAX_PSEUDO_LEN;
}

function isCode(v) {
  if (typeof v !== 'string') return false;
  return CODE_RE.test(v.trim().toUpperCase());
}

function isChatText(v) {
  if (typeof v !== 'string') return false;
  return v.trim().length > 0 && v.length <= MAX_CHAT_LEN;
}

// Returns true if the payload is valid for the given event type.
function validate(type, data) {
  if (!data || typeof data !== 'object') return false;
  switch (type) {
    case 'room:create':  return isPseudo(data.pseudo);
    case 'room:join':    return isPseudo(data.pseudo) && isCode(data.code);
    case 'chat:message': return isChatText(data.text);
    default:             return false;
  }
}

module.exports = { validate, MAX_PSEUDO_LEN, MAX_CHAT_LEN };
