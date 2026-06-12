'use strict';

// ── Duel socket glue (Phase 2) ──────────────────────────────────────────────
//
// Wires the authoritative duel core (state/actions/view) to Socket.IO. The only
// thing ever pushed to a client is `viewFor(game, seat)` — the filtered snapshot
// — plus targeted private replies (e.g. "look at own deck"). Hidden info is
// therefore structurally unable to reach the wrong client.

const { createGame } = require('./state');
const { apply }      = require('./actions');
const { viewFor }    = require('./view');
const rooms          = require('../rooms');

// Lazily create the game once both seats are present. Tokens from the two seats
// become the players' stable identities (used for reconnection).
function ensureGame(room) {
  if (room.game) return room.game;
  if (room.seats.length < rooms.MAX_PLAYERS) return null;
  room.game = createGame(room.seats[0].token, room.seats[1].token);
  return room.game;
}

// Push a freshly filtered snapshot to every CONNECTED seat (each sees only its
// own view). Disconnected seats get nothing until they reconnect.
function broadcast(io, room) {
  if (!room.game) return;
  for (const s of room.seats) {
    if (s.connected && s.socketId) {
      io.to(s.socketId).emit('duel:state', viewFor(room.game, s.seat));
    }
  }
}

// Send the current snapshot to a single seat (used on (re)connection).
function sendSnapshot(io, room, seat) {
  if (!room.game) return;
  const s = room.seats.find(x => x.seat === seat);
  if (s && s.connected && s.socketId) {
    io.to(s.socketId).emit('duel:state', viewFor(room.game, seat));
  }
}

// Handle one validated duel:action from `socket`. `room`/`seat` are already
// resolved + membership-checked by the caller.
function onAction(io, socket, room, seat, data) {
  const game = ensureGame(room);
  if (!game) { socket.emit('duel:error', { code: 'waiting_opponent' }); return; }

  const res = apply(game, seat, data.action, data.payload);
  if (res.error) { socket.emit('duel:error', { code: res.error, action: data.action }); return; }

  if (res.private) socket.emit('duel:private', res.private);
  broadcast(io, room);
}

module.exports = { ensureGame, broadcast, sendSnapshot, onAction };
