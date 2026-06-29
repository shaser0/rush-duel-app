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
        return reject(socket, 'invalid_data', 'Invalid nickname (1–20 characters).');
      if (playerRoom)
        return reject(socket, 'already_in_room', 'You are already in a room.');
      if (!joinLimiter.check(socket.id))
        return reject(socket, 'rate_limited', 'Too many attempts. Wait a moment.');

      playerPseudo = data.pseudo.trim();
      const room   = rooms.createRoom(socket.id, playerPseudo);
      playerRoom   = room.code;
      // No seat assigned yet — creator starts as spectator.
      socket.join(room.code);

      socket.emit('room:created', {
        code:     room.code,
        isHost:   true,
        presence: rooms.getPresence(room),
        history:  room.messages,
        settings: room.settings,
      });
      console.log(`[online] room ${room.code} created by ${playerPseudo}`);
    });

    // ── room:join ──────────────────────────────────────────────────────────
    // Everyone joins as spectator by default. If a valid token for a seat in this
    // room is provided, the seat is re-claimed automatically (reconnection).
    socket.on('room:join', (data) => {
      if (!validate('room:join', data))
        return reject(socket, 'invalid_data', 'Invalid nickname or code.');
      if (playerRoom)
        return reject(socket, 'already_in_room', 'You are already in a room.');
      if (!joinLimiter.check(socket.id))
        return reject(socket, 'rate_limited', 'Too many attempts. Wait a moment.');

      playerPseudo = data.pseudo.trim();
      const code   = data.code.trim().toUpperCase();
      const result = rooms.joinRoom(code, socket.id, playerPseudo, data.token);

      if (result.error) {
        const MSGS = {
          room_not_found:  'Room not found. Check the code.',
          already_in_room: 'You are already in this room.',
        };
        return reject(socket, result.error, MSGS[result.error] || 'Error.');
      }

      playerRoom  = code;
      playerSeat  = result.seat !== undefined ? result.seat : null;
      playerToken = result.token || null;
      socket.join(code);

      const room     = result.room;
      const presence = rooms.getPresence(room);
      socket.emit('room:joined', {
        code,
        isHost:      room.host === socket.id,
        seat:        playerSeat,   // null when spectator
        token:       playerToken,  // null when spectator
        reconnected: !!result.reconnected,
        presence,
        history:     room.messages,
        settings:    room.settings,
      });
      io.to(code).emit('presence:update', presence);

      if (room.game) {
        if (playerSeat !== null) duel.sendSnapshot(io, room, playerSeat);
        else duel.sendSpectatorSnapshot(socket, room);
      }
      console.log(`[online] ${playerPseudo} ${result.reconnected ? 'reconnected to' : 'joined'} room ${code} (seat ${playerSeat ?? 'spectator'})`);
    });

    // ── room:claim-seat ────────────────────────────────────────────────────
    socket.on('room:claim-seat', () => {
      if (!validate('room:claim-seat', {})) return;
      if (!playerRoom) return reject(socket, 'not_in_room', 'Not in a room.');
      if (playerSeat !== null) return reject(socket, 'already_a_player', 'Already seated.');

      const result = rooms.claimSeat(playerRoom, socket.id);
      if (result.error) {
        const MSGS = {
          game_in_progress: 'A duel is in progress.',
          room_full:        'Both seats are taken.',
          already_a_player: 'Already seated.',
        };
        return reject(socket, result.error, MSGS[result.error] || 'Error.');
      }

      playerSeat  = result.seat;
      playerToken = result.token;

      socket.emit('room:seated', { seat: playerSeat, token: playerToken });
      io.to(playerRoom).emit('presence:update', rooms.getPresence(result.room));
      console.log(`[online] ${playerPseudo} claimed seat ${playerSeat} in room ${playerRoom}`);
    });

    // ── room:release-seat ──────────────────────────────────────────────────
    socket.on('room:release-seat', () => {
      if (!validate('room:release-seat', {})) return;
      if (!playerRoom) return reject(socket, 'not_in_room', 'Not in a room.');
      if (playerSeat === null) return reject(socket, 'not_a_player', 'Not seated.');

      const result = rooms.releaseSeat(playerRoom, socket.id);
      if (result.error) {
        const MSGS = { game_in_progress: 'Cannot release seat during a duel.' };
        return reject(socket, result.error, MSGS[result.error] || 'Error.');
      }

      playerSeat  = null;
      playerToken = null;

      socket.emit('room:released', {});
      io.to(playerRoom).emit('presence:update', rooms.getPresence(result.room));
      console.log(`[online] ${playerPseudo} released their seat in room ${playerRoom}`);
    });

    // ── room:setting ───────────────────────────────────────────────────────
    // Host-only: change a room setting before the game starts.
    socket.on('room:setting', (data) => {
      if (!playerRoom) return;
      if (!validate('room:setting', data)) return;
      const room = rooms.getRoom(playerRoom);
      if (!room || room.host !== socket.id || room.game) return;
      Object.assign(room.settings, { banlistEnforced: data.banlistEnforced });
      io.to(playerRoom).emit('settings:update', room.settings);
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
        return reject(socket, 'not_in_room', 'You are not in a room.');
      if (!validate('chat:message', data))
        return reject(socket, 'invalid_data', 'Invalid or too long message.');
      if (!chatLimiter.check(socket.id))
        return reject(socket, 'rate_limited', 'Slow down!');

      // Re-verify membership server-side (prevents spoofed room codes).
      const room = rooms.getRoom(playerRoom);
      if (!room || !room.players.has(socket.id))
        return reject(socket, 'not_in_room', 'You are not in this room.');

      const msg = rooms.addMessage(playerRoom, socket.id, data.text.trim());
      if (msg) io.to(playerRoom).emit('chat:message', msg);
    });

    // ── disconnect ─────────────────────────────────────────────────────────
    socket.on('disconnect', () => {
      if (!playerRoom) return;
      const { affected } = rooms.leaveRoom(socket.id);
      const pseudo = playerPseudo || '(unknown)';

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
