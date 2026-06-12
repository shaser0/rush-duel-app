'use strict';

const { Server } = require('socket.io');
const rooms      = require('./rooms');
const duel       = require('./duel');
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
    let playerSeat    = null; // duel seat index (0/1), set on create/join
    let playerToken   = null; // stable identity for reconnection

    // ── room:create ────────────────────────────────────────────────────────
    socket.on('room:create', (data) => {
      if (!validate('room:create', data))
        return reject(socket, 'invalid_data', 'Pseudo invalide (1–20 caractères).');
      if (playerRoom)
        return reject(socket, 'already_in_room', 'Tu es déjà dans une room.');
      if (!joinLimiter.check(socket.id))
        return reject(socket, 'rate_limited', 'Trop de tentatives. Attends un peu.');

      playerPseudo = data.pseudo.trim();
      const room   = rooms.createRoom(socket.id, playerPseudo, data.token);
      playerRoom   = room.code;
      playerSeat   = 0;
      playerToken  = room.seats[0].token;
      socket.join(room.code);

      socket.emit('room:created', {
        code:     room.code,
        seat:     playerSeat,
        token:    playerToken, // client persists this for reconnection
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
      const result = rooms.joinRoom(code, socket.id, playerPseudo, data.token);

      if (result.error) {
        const MSGS = {
          room_not_found:  'Room introuvable. Vérifie le code.',
          room_full:       'La room est pleine (2 joueurs max).',
          already_in_room: 'Tu es déjà dans cette room.',
        };
        return reject(socket, result.error, MSGS[result.error] || 'Erreur.');
      }

      playerRoom  = code;
      playerSeat  = result.seat;
      playerToken = result.token;
      socket.join(code);

      const presence = rooms.getPresence(result.room);
      socket.emit('room:joined', {
        code,
        seat:        playerSeat,
        token:       playerToken,
        reconnected: !!result.reconnected,
        presence,
        history: result.room.messages,
      });
      // Tell all room members (including joiner) about updated presence.
      io.to(code).emit('presence:update', presence);

      // If a duel is already running, hand the (re)joining player their snapshot.
      if (result.room.game) duel.sendSnapshot(io, result.room, playerSeat);
      console.log(`[online] ${playerPseudo} ${result.reconnected ? 'reconnected to' : 'joined'} room ${code} (seat ${playerSeat})`);
    });

    // ── duel:action ────────────────────────────────────────────────────────
    socket.on('duel:action', (data) => {
      if (!playerRoom)
        return socket.emit('duel:error', { code: 'not_in_room' });
      if (!validate('duel:action', data))
        return socket.emit('duel:error', { code: 'invalid_data' });
      if (!chatLimiter.check(socket.id)) // reuse the per-socket message budget
        return socket.emit('duel:error', { code: 'rate_limited' });

      // Re-verify membership + seat server-side (never trust the socket's claim).
      const room = rooms.getRoom(playerRoom);
      const seat = room && rooms.seatBySocket(room, socket.id);
      if (!room || !seat)
        return socket.emit('duel:error', { code: 'not_in_room' });

      duel.onAction(io, socket, room, seat.seat, data);
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
      const { affected } = rooms.leaveRoom(socket.id);
      const pseudo = playerPseudo || '(inconnu)';

      // Notify rooms that still exist (seat may be kept reserved if a game runs).
      for (const code of affected) {
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
