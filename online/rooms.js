'use strict';

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

// code → { code, host: socketId, players: Map<socketId, {id, pseudo}>, messages: [] }
const rooms = new Map();

function createRoom(hostSocketId, hostPseudo) {
  let code;
  do { code = genCode(); } while (rooms.has(code));
  const room = {
    code,
    host: hostSocketId,
    players: new Map([[hostSocketId, { id: hostSocketId, pseudo: hostPseudo }]]),
    messages: [],
  };
  rooms.set(code, room);
  return room;
}

function joinRoom(code, socketId, pseudo) {
  const room = rooms.get(code);
  if (!room)                          return { error: 'room_not_found' };
  if (room.players.size >= MAX_PLAYERS) return { error: 'room_full' };
  if (room.players.has(socketId))     return { error: 'already_in_room' };
  room.players.set(socketId, { id: socketId, pseudo });
  return { room };
}

// Returns room codes that still exist after removal (so callers can notify them).
function leaveRoom(socketId) {
  const affected = [];
  for (const [code, room] of rooms) {
    if (!room.players.has(socketId)) continue;
    room.players.delete(socketId);
    if (room.players.size === 0) {
      rooms.delete(code);
    } else {
      if (room.host === socketId) {
        room.host = [...room.players.keys()][0];
      }
      affected.push(code);
    }
  }
  return affected;
}

function getRoom(code)           { return rooms.get(code) || null; }

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

function getPresence(room) {
  return [...room.players.values()].map(p => ({
    id:     p.id,
    pseudo: p.pseudo,
    isHost: p.id === room.host,
  }));
}

module.exports = { createRoom, joinRoom, leaveRoom, getRoom, getRoomBySocket, addMessage, getPresence };
