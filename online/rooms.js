'use strict';

const crypto = require('crypto');

const ROOM_CODE_LEN = 6;
const MAX_PLAYERS   = 2;
const MAX_MESSAGES  = 200;

// Avoid visually confusable characters (0/O, 1/I/L)
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function genCode() {
  let code = '';
  for (let i = 0; i < ROOM_CODE_LEN; i++) {
    code += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
  }
  return code;
}

function genToken() { return crypto.randomBytes(16).toString('hex'); }

// code → {
//   code, host: socketId,
//   players: Map<socketId, {id, pseudo}>,   // Phase 1: presence + chat membership
//   messages: [],
//   seats: [ { seat, token, pseudo, socketId|null, connected } ],  // Phase 2: stable identity
//   game:  GameState | null,                                       // Phase 2: duel state
// }
const rooms = new Map();

// ── Seat helpers ────────────────────────────────────────────────────────────

function seatBySocket(room, socketId) {
  return room.seats.find(s => s.socketId === socketId) || null;
}
function seatByToken(room, token) {
  if (!token) return null;
  return room.seats.find(s => s.token === token) || null;
}

// ── Room lifecycle ──────────────────────────────────────────────────────────

function createRoom(hostSocketId, hostPseudo) {
  let code;
  do { code = genCode(); } while (rooms.has(code));
  const room = {
    code,
    host: hostSocketId,
    players: new Map([[hostSocketId, { id: hostSocketId, pseudo: hostPseudo }]]),
    messages: [],
    seats: [],   // seats are claimed manually via claimSeat()
    game: null,
    settings: { banlistEnforced: true },
  };
  rooms.set(code, room);
  return room;
}

function joinRoom(code, socketId, pseudo, token) {
  const room = rooms.get(code);
  if (!room) return { error: 'room_not_found' };

  // Reconnection: a known token rebinds its seat to the new socket.
  const existing = seatByToken(room, token);
  if (existing) {
    if (existing.connected && existing.socketId && existing.socketId !== socketId)
      return { error: 'already_in_room' };
    existing.socketId = socketId;
    existing.connected = true;
    existing.pseudo = pseudo || existing.pseudo;
    room.players.set(socketId, { id: socketId, pseudo: existing.pseudo });
    return { room, seat: existing.seat, token: existing.token, reconnected: true };
  }

  if (room.players.has(socketId)) return { error: 'already_in_room' };
  // Everyone joins as spectator; seats are claimed manually via claimSeat().
  room.players.set(socketId, { id: socketId, pseudo });
  return { room }; // no seat, no token
}

// Mark a socket as gone. Phase-1 behaviour (no game) deletes empty rooms exactly
// as before. With a running game, seats are PRESERVED for reconnection — we only
// flag the seat disconnected and drop the socket from presence.
// Returns { affected:[codes still alive], emptied:[codes deleted] }.
function leaveRoom(socketId) {
  const affected = [];
  const emptied  = [];
  for (const [code, room] of rooms) {
    if (!room.players.has(socketId)) continue;
    room.players.delete(socketId);

    const seat = seatBySocket(room, socketId);
    if (seat) { seat.connected = false; seat.socketId = null; }

    if (room.game) {
      // Duel in progress: keep the room/seats alive for reconnection.
      if (room.seats.every(s => !s.connected)) {
        rooms.delete(code); // both players gone → reclaim memory
        emptied.push(code);
      } else {
        if (room.host === socketId) {
          const alive = room.seats.find(s => s.connected);
          if (alive) room.host = alive.socketId;
        }
        affected.push(code);
      }
      continue;
    }

    // No game (Phase 1 lobby): original teardown semantics.
    room.seats = room.seats.filter(s => s.socketId !== socketId);
    if (room.players.size === 0) {
      rooms.delete(code);
      emptied.push(code);
    } else {
      if (room.host === socketId) room.host = [...room.players.keys()][0];
      affected.push(code);
    }
  }
  return { affected, emptied };
}

function getRoom(code) { return rooms.get(code) || null; }

function getRoomBySocket(socketId) {
  for (const room of rooms.values()) {
    if (room.players.has(socketId)) return room;
  }
  return null;
}

function addMessage(code, socketId, text) {
  const room = rooms.get(code);
  if (!room || !room.players.has(socketId)) return null;
  const player = room.players.get(socketId);
  const msg = { pseudo: player.pseudo, text, ts: Date.now() };
  room.messages.push(msg);
  if (room.messages.length > MAX_MESSAGES) room.messages.shift();
  return msg;
}

// Join a room as a spectator (no seat, no token). Spectators are tracked in
// room.players like regular players but have no matching entry in room.seats.
function joinSpectator(code, socketId, pseudo) {
  const room = rooms.get(code);
  if (!room) return { error: 'room_not_found' };
  if (room.players.has(socketId)) return { error: 'already_in_room' };
  room.players.set(socketId, { id: socketId, pseudo });
  return { room };
}

// Spectator claims an empty player seat (lobby only, no running game).
function claimSeat(code, socketId, token) {
  const room = rooms.get(code);
  if (!room) return { error: 'room_not_found' };
  if (room.game && !room.game.ended) return { error: 'game_in_progress' };
  if (!room.players.has(socketId)) return { error: 'not_in_room' };
  if (room.seats.find(s => s.socketId === socketId)) return { error: 'already_a_player' };
  if (room.seats.length >= MAX_PLAYERS) return { error: 'room_full' };
  const seatIdx = room.seats.length;
  const rec = { seat: seatIdx, token: token || genToken(), pseudo: room.players.get(socketId).pseudo, socketId, connected: true, wins: 0 };
  room.seats.push(rec);
  return { room, seat: seatIdx, token: rec.token };
}

// Player releases their seat and becomes a spectator (lobby only).
function releaseSeat(code, socketId) {
  const room = rooms.get(code);
  if (!room) return { error: 'room_not_found' };
  if (room.game && !room.game.ended) return { error: 'game_in_progress' };
  const seatRec = room.seats.find(s => s.socketId === socketId);
  if (!seatRec) return { error: 'not_a_player' };
  room.seats = room.seats.filter(s => s.socketId !== socketId);
  // Re-index remaining seats
  room.seats.forEach((s, i) => { s.seat = i; });
  // Transfer host if needed
  if (room.host === socketId) {
    const next = room.seats.find(s => s.connected);
    room.host = next ? next.socketId : [...room.players.keys()].find(k => k !== socketId) || socketId;
  }
  return { room };
}

function getPresence(room) {
  const players = [];
  let spectatorCount = 0;
  for (const [sid, p] of room.players) {
    const seatRec = room.seats.find(s => s.socketId === sid);
    if (seatRec) {
      players.push({ id: p.id, pseudo: p.pseudo, isHost: p.id === room.host, seat: seatRec.seat, wins: seatRec.wins });
    } else {
      spectatorCount++;
    }
  }
  return { players, spectatorCount };
}

module.exports = {
  createRoom, joinRoom, joinSpectator, claimSeat, releaseSeat, leaveRoom,
  getRoom, getRoomBySocket, addMessage, getPresence,
  seatBySocket, seatByToken, genToken, MAX_PLAYERS,
};
