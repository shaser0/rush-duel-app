'use strict';

// Schema version tracker + migration runner for decks.json and collections.json.
// To add a migration: add a numbered function under MIGRATIONS[type][newVersion].
// Bump CURRENT[type] to match. On next server start, the migration runs automatically
// and a .bak-v<n> backup is written before any changes.

const CURRENT = { decks: 1, collections: 1 };

const MIGRATIONS = {
  decks: {
    // example: 2: (data) => { data.decks.forEach(d => { d.newField = d.newField ?? null; }); return data; }
  },
  collections: {
    // example: 2: (data) => { data.collections.forEach(c => { c.newField = c.newField ?? null; }); return data; }
  },
};

function runMigrations(type, data, fromVersion) {
  let current = fromVersion;
  const target = CURRENT[type];
  while (current < target) {
    current++;
    const fn = MIGRATIONS[type][current];
    if (fn) data = fn(data);
  }
  return data;
}

module.exports = { CURRENT, runMigrations };
