'use strict';

// ── Phase 2 glue + reconnection tests ───────────────────────────────────────
// Run: node online/duel/glue.test.js
// Exercises rooms.js (seats/token/reconnection) + duel/index.js (snapshot
// targeting) without a real Socket.IO transport, using a captured fake `io`.
// Covers criterion 8 (reconnect restores your game) + correct per-seat routing.

const assert = require('assert');
const rooms  = require('../rooms');
const duel   = require('./index');

let passed = 0;
function ok(label, fn) { fn(); passed++; console.log('  ✓ ' + label); }

// Fake io: records every emit as { id, ev, payload }.
function fakeIo() {
  const sent = [];
  return {
    sent,
    to(id) { return { emit(ev, payload) { sent.push({ id, ev, payload }); } }; },
  };
}

console.log('duel glue — snapshot routing + reconnection');

const TOK_A = 'a'.repeat(32);
const TOK_B = 'b'.repeat(32);

// Two seats join; a game is created and set up.
const room = rooms.createRoom('sock-A', 'Alice', TOK_A);
const code = room.code;
const j = rooms.joinRoom(code, 'sock-B', 'Bob', TOK_B);
assert.strictEqual(j.seat, 1);

const game = duel.ensureGame(room);
assert.ok(game, 'game created once both seats present');
game.players[0].deck = [{ iid: 'x0', cardKey: 'A_SECRET', rarity: '', imgFile: '', faceDown: false, position: 'atk' }];
game.players[1].deck = [{ iid: 'y0', cardKey: 'B_SECRET', rarity: '', imgFile: '', faceDown: false, position: 'atk' }];
game.players[1].hand = [{ iid: 'y1', cardKey: 'B_HAND_SECRET', rarity: '', imgFile: '', faceDown: false, position: 'atk' }];

ok('broadcast routes a distinct, correctly-filtered view to each seat', () => {
  const io = fakeIo();
  duel.broadcast(io, room);
  assert.strictEqual(io.sent.length, 2);
  const toA = io.sent.find(m => m.id === 'sock-A').payload;
  const toB = io.sent.find(m => m.id === 'sock-B').payload;
  assert.strictEqual(toA.you, 0);
  assert.strictEqual(toB.you, 1);
  // Alice must not see Bob's hand identity; Bob must see his own.
  assert.ok(!JSON.stringify(toA).includes('B_HAND_SECRET'));
  assert.ok(JSON.stringify(toB).includes('B_HAND_SECRET'));
});

ok('disconnecting a seat keeps the room + game alive (reservation)', () => {
  const { affected } = rooms.leaveRoom('sock-B');
  assert.ok(affected.includes(code), 'room should survive while a game runs');
  assert.strictEqual(rooms.getRoom(code), room);
  const seatB = room.seats.find(s => s.seat === 1);
  assert.strictEqual(seatB.connected, false);
});

ok('broadcast skips the disconnected seat', () => {
  const io = fakeIo();
  duel.broadcast(io, room);
  assert.strictEqual(io.sent.length, 1);
  assert.strictEqual(io.sent[0].id, 'sock-A');
});

ok('reconnecting with the same token rebinds the seat (criterion 8)', () => {
  const r = rooms.joinRoom(code, 'sock-B2', 'Bob', TOK_B);
  assert.strictEqual(r.reconnected, true);
  assert.strictEqual(r.seat, 1);
  const seatB = room.seats.find(s => s.seat === 1);
  assert.strictEqual(seatB.socketId, 'sock-B2');
  assert.strictEqual(seatB.connected, true);
});

ok('reconnected player gets a snapshot restoring their own game state', () => {
  const io = fakeIo();
  duel.sendSnapshot(io, room, 1);
  assert.strictEqual(io.sent.length, 1);
  assert.strictEqual(io.sent[0].id, 'sock-B2');
  assert.ok(JSON.stringify(io.sent[0].payload).includes('B_HAND_SECRET'),
    'restored snapshot should contain the player\'s own hidden hand');
});

ok('a foreign token cannot take a reserved seat (room_full)', () => {
  const r = rooms.joinRoom(code, 'sock-C', 'Carol', 'c'.repeat(32));
  assert.strictEqual(r.error, 'room_full');
});

ok('both seats gone reclaims the room from memory', () => {
  rooms.leaveRoom('sock-A');
  const { emptied } = rooms.leaveRoom('sock-B2');
  assert.ok(emptied.includes(code));
  assert.strictEqual(rooms.getRoom(code), null);
});

console.log(`\n${passed} checks passed.`);
