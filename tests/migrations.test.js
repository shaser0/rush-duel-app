'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { CURRENT, MIGRATIONS, runMigrations } = require('../scripts/pipeline/migrations');

// Helper: temporarily raise CURRENT.decks and inject migration fns, always
// restoring module state afterwards (CURRENT/MIGRATIONS are shared singletons).
function withDeckMigrations(target, fns, run) {
  const savedTarget = CURRENT.decks;
  try {
    CURRENT.decks = target;
    Object.assign(MIGRATIONS.decks, fns);
    return run();
  } finally {
    CURRENT.decks = savedTarget;
    for (const v of Object.keys(fns)) delete MIGRATIONS.decks[v];
  }
}

test('runMigrations: from = target is a no-op', () => {
  const data = { activeId: null, decks: [{ id: 1 }] };
  assert.deepEqual(runMigrations('decks', data, CURRENT.decks), data);
});

test('runMigrations: from > target is a no-op', () => {
  const data = { decks: [] };
  assert.deepEqual(runMigrations('decks', data, CURRENT.decks + 5), data);
});

test('runMigrations: undefined migration fn is skipped (current v0→v1 stamp)', () => {
  const data = { activeId: null, decks: [{ id: 1 }] };
  assert.deepEqual(runMigrations('decks', data, 0), data);
});

test('runMigrations: defined migration fn is applied', () => {
  withDeckMigrations(2, {
    2: d => ({ ...d, migrated: true }),
  }, () => {
    const out = runMigrations('decks', { decks: [] }, 1);
    assert.equal(out.migrated, true);
  });
});

test('runMigrations: multi-hop migrations run in order', () => {
  withDeckMigrations(3, {
    2: d => ({ ...d, steps: [...d.steps, 2] }),
    3: d => ({ ...d, steps: [...d.steps, 3] }),
  }, () => {
    const out = runMigrations('decks', { steps: [] }, 1);
    assert.deepEqual(out.steps, [2, 3]);
  });
});

test('runMigrations: a throwing migration propagates (caller rolls back)', () => {
  withDeckMigrations(2, {
    2: () => { throw new Error('boom'); },
  }, () => {
    assert.throws(() => runMigrations('decks', { decks: [] }, 1), /boom/);
  });
});
