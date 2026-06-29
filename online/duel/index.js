'use strict';

// ── Duel socket glue (Phase 2) ──────────────────────────────────────────────
//
// Wires the authoritative duel core (state/actions/view) to Socket.IO. The only
// thing ever pushed to a client is `viewFor(game, seat)` — the filtered snapshot
// — plus targeted private replies (e.g. "look at own deck"). Hidden info is
// therefore structurally unable to reach the wrong client.

const { createGame }              = require('./state');
const { apply }                   = require('./actions');
const { viewFor, spectatorView }  = require('./view');
const rooms                       = require('../rooms');

// Lazily create the game once both seats are present. Auto-resets ended games
// so players can start a new match without leaving the room.
function ensureGame(room) {
  if (room.game && room.game.ended) room.game = null;
  if (room.game) return room.game;
  if (room.seats.length < rooms.MAX_PLAYERS) return null;
  room.game = createGame(room.seats[0].token, room.seats[1].token);
  return room.game;
}

// Push a freshly filtered snapshot to every CONNECTED seat + spectators.
function broadcast(io, room) {
  if (!room.game) return;
  for (const s of room.seats) {
    if (s.connected && s.socketId) {
      io.to(s.socketId).emit('duel:state', viewFor(room.game, s.seat));
    }
  }
  // Spectateurs : joueurs dans room.players sans siège.
  const specView = spectatorView(room.game);
  for (const [sid] of room.players) {
    if (!room.seats.find(s => s.socketId === sid)) {
      const sock = io.sockets.sockets.get(sid);
      if (sock) sock.emit('duel:state', specView);
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

// Send spectator view to a newly joined spectator socket.
function sendSpectatorSnapshot(socket, room) {
  if (!room.game) return;
  socket.emit('duel:state', spectatorView(room.game));
}

// Handle one validated duel:action from `socket`. `room`/`seat` are already
// resolved + membership-checked by the caller.
function onAction(io, socket, room, seat, data) {
  const game = ensureGame(room);
  if (!game) { socket.emit('duel:error', { code: 'waiting_opponent' }); return; }

  const wasEnded = game.ended;
  const res = apply(game, seat, data.action, data.payload);
  if (res.error) { socket.emit('duel:error', { code: res.error, action: data.action }); return; }

  // Game just ended this action — increment winner's wins counter.
  if (!wasEnded && game.ended && game.winner !== null) {
    const winnerSeat = room.seats.find(s => s.seat === game.winner);
    if (winnerSeat) winnerSeat.wins = (winnerSeat.wins || 0) + 1;
    io.to(room.code).emit('presence:update', rooms.getPresence(room));
  }

  if (res.private) socket.emit('duel:private', res.private);
  broadcast(io, room);
}

module.exports = { ensureGame, broadcast, sendSnapshot, sendSpectatorSnapshot, onAction };
