'use strict';

const { Server } = require('socket.io');
const rooms      = require('./rooms');
const { validate }           = require('./validate');
const { chatLimiter, joinLimiter } = require('./rateLimit');

// Error helper — emits room:error and returns undefined so handlers can `return reject(...)`.
function reject(socket, code, message) {
  socket.emit('room:error', { code, message });
}

function mount(httpServer) {
  const io = new Server(httpServer, {
    // Allow all origins in online mode (players connect from VPN IPs).
    cors: { origin: '*', methods: ['GET', 'POST'] },
    // Limit single-message payload to 64 KB.
    maxHttpBufferSize: 64 * 1024,
  });

  io.on('connection', (socket) => {
    // Per-connection state (no shared mutable state across sockets).
    let playerPseudo  = null;
    let playerRoom    = null; // room code

    // ── room:create ────────────────────────────────────────────────────────
    socket.on('room:create', (data) => {
      if (!validate('room:create', data))
        return reject(socket, 'invalid_data', 'Pseudo invalide (1–20 caractères).');
      if (playerRoom)
        return reject(socket, 'already_in_room', 'Tu es déjà dans une room.');
      if (!joinLimiter.check(socket.id))
        return reject(socket, 'rate_limited', 'Trop de tentatives. Attends un peu.');

      playerPseudo = data.pseudo.trim();
      const room   = rooms.createRoom(socket.id, playerPseudo);
      playerRoom   = room.code;
      socket.join(room.code);

      socket.emit('room:created', {
        code:     room.code,
        presence: rooms.getPresence(room),
        history:  room.messages,
      });
      console.log(`[online] room ${room.code} created by ${playerPseudo}`);
    });

    // ── room:join ──────────────────────────────────────────────────────────
    socket.on('room:join', (data) => {
      if (!validate('room:join', data))
        return reject(socket, 'invalid_data', 'Pseudo ou code invalide.');
      if (playerRoom)
        return reject(socket, 'already_in_room', 'Tu es déjà dans une room.');
      if (!joinLimiter.check(socket.id))
        return reject(socket, 'rate_limited', 'Trop de tentatives. Attends un peu.');

      playerPseudo = data.pseudo.trim();
      const code   = data.code.trim().toUpperCase();
      const result = rooms.joinRoom(code, socket.id, playerPseudo);

      if (result.error) {
        const MSGS = {
          room_not_found:  'Room introuvable. Vérifie le code.',
          room_full:       'La room est pleine (2 joueurs max).',
          already_in_room: 'Tu es déjà dans cette room.',
        };
        return reject(socket, result.error, MSGS[result.error] || 'Erreur.');
      }

      playerRoom = code;
      socket.join(code);

      const presence = rooms.getPresence(result.room);
      socket.emit('room:joined', {
        code,
        presence,
        history: result.room.messages,
      });
      // Tell all room members (including joiner) about updated presence.
      io.to(code).emit('presence:update', presence);
      console.log(`[online] ${playerPseudo} joined room ${code}`);
    });

    // ── chat:message ───────────────────────────────────────────────────────
    socket.on('chat:message', (data) => {
      if (!playerRoom)
        return reject(socket, 'not_in_room', 'Tu n\'es pas dans une room.');
      if (!validate('chat:message', data))
        return reject(socket, 'invalid_data', 'Message invalide ou trop long.');
      if (!chatLimiter.check(socket.id))
        return reject(socket, 'rate_limited', 'Ralentis !');

      // Re-verify membership server-side (prevents spoofed room codes).
      const room = rooms.getRoom(playerRoom);
      if (!room || !room.players.has(socket.id))
        return reject(socket, 'not_in_room', 'Tu n\'es pas dans cette room.');

      const msg = rooms.addMessage(playerRoom, socket.id, data.text.trim());
      if (msg) io.to(playerRoom).emit('chat:message', msg);
    });

    // ── disconnect ─────────────────────────────────────────────────────────
    socket.on('disconnect', () => {
      if (!playerRoom) return;
      const affectedCodes = rooms.leaveRoom(socket.id);
      const pseudo = playerPseudo || '(inconnu)';

      // Notify rooms that still exist.
      for (const code of affectedCodes) {
        const updatedRoom = rooms.getRoom(code);
        if (updatedRoom) {
          io.to(code).emit('player:left',     { pseudo });
          io.to(code).emit('presence:update', rooms.getPresence(updatedRoom));
        }
      }
      console.log(`[online] ${pseudo} disconnected (room ${playerRoom})`);
    });
  });

  console.log('[online] Socket.IO mounted on shared HTTP server');
  return io;
}

module.exports = { mount };
