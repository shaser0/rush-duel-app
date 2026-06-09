'use strict';

// ── Worker mode (pkg sync subprocess) ─────────────────────────────────────
// When spawned with RUSH_SYNC=<name>, run the named sync script and exit.
// RUSH_DATA_DIR points to the real data/ folder next to the binary.
if (process.env.RUSH_SYNC) {
  const mode = process.env.RUSH_SYNC;
  if (mode === 'cards')   { require('./scripts/sync-cards');   return; }
  if (mode === 'sets')    { require('./scripts/sync-sets');    return; }
  if (mode === 'gallery') { require('./scripts/sync-gallery'); return; }
  if (mode === 'banlist') {
    require('./scripts/sync-banlist').syncBanlist()
      .catch(e => { console.error(e); process.exit(1); });
    return;
  }
  process.exit(1);
}

const express = require('express');
const cors    = require('cors');
const path    = require('path');
const fs      = require('fs');
const { spawn, exec } = require('child_process');

const app  = express();
const PORT = process.env.PORT || 3000;

// When running as a pkg .exe, resolve data files from the real exe directory
const APP_DIR = process.pkg ? path.dirname(process.execPath) : __dirname;

// Always write logs to data/rush-app.log; in pkg mode suppress console output.
{
  const logPath = path.join(APP_DIR, 'data', 'rush-app.log');
  try { fs.mkdirSync(path.join(APP_DIR, 'data'), { recursive: true }); } catch {}
  const logStream = fs.createWriteStream(logPath, { flags: 'a' });
  const ts = () => { const d = new Date(), p = n => String(n).padStart(2,'0'); return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`; };
  const fmt = a => a.map(x => typeof x === 'object' ? JSON.stringify(x) : String(x)).join(' ');
  const orig = { log: console.log.bind(console), error: console.error.bind(console), warn: console.warn.bind(console) };
  console.log   = (...a) => { logStream.write(`[${ts()}] ${fmt(a)}\n`);        if (!process.pkg) orig.log(...a);   };
  console.error = (...a) => { logStream.write(`[${ts()}] [ERR] ${fmt(a)}\n`);  if (!process.pkg) orig.error(...a); };
  console.warn  = (...a) => { logStream.write(`[${ts()}] [WARN] ${fmt(a)}\n`); if (!process.pkg) orig.warn(...a);  };
}

// ── Sync process registry ──────────────────────────────────────────────────

// How old a file must be (in ms) before we consider it stale and re-sync
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const STALE_MS = {
  cards:   WEEK_MS,
  sets:    WEEK_MS,
  gallery: WEEK_MS,
  banlist: WEEK_MS,
};

// Which file to check for staleness per sync
const STALE_FILE = {
  cards:   'data/cards.json',
  sets:    'data/sets-data.json',
  gallery: 'data/gallery-images.json',
  banlist: 'data/banlist.json',
};

const SYNCS = {
  cards:   { script: 'scripts/sync-cards.js',   nodeArgs: [], running: false, exitCode: null },
  sets:    { script: 'scripts/sync-sets.js',    nodeArgs: [], running: false, exitCode: null },
  gallery: { script: 'scripts/sync-gallery.js', nodeArgs: [], running: false, exitCode: null },
  banlist: { script: 'scripts/sync-banlist.js', nodeArgs: [], running: false, exitCode: null },
};

function isStale(name) {
  try {
    const mtime = fs.statSync(path.join(__dirname, STALE_FILE[name])).mtime.getTime();
    return (Date.now() - mtime) > STALE_MS[name];
  } catch {
    return true; // file missing → definitely stale
  }
}

// Pipe a child process stream to the log, prefixing every line with `prefix`.
// \r is treated as a terminal cursor-reset: only the text after the last \r
// is kept, so progress-counter lines don't spam the log with intermediates.
// Returns a flush function to call on process exit to emit any buffered partial line.
function pipePrefixed(stream, prefix) {
  let buf = '';
  const emit = line => {
    const clean = line.includes('\r') ? line.split('\r').pop() : line;
    if (clean) console.log(`${prefix} ${clean}`);
  };
  stream.on('data', chunk => {
    buf += chunk.toString();
    const lines = buf.split('\n');
    buf = lines.pop();
    for (const line of lines) emit(line);
  });
  return () => { if (buf) { emit(buf); buf = ''; } };
}

function startSync(name, force = false) {
  const s = SYNCS[name];
  if (s.running) return false;
  if (!force && !isStale(name)) {
    console.log(`[${name}] up to date, skipping`);
    return false;
  }
  // In pkg mode, re-spawn the binary with RUSH_SYNC env var (worker mode).
  const [cmd, args] = process.pkg
    ? [process.execPath, []]
    : ['node', [...s.nodeArgs, s.script]];
  const env = process.pkg
    ? { ...process.env, RUSH_SYNC: name, RUSH_DATA_DIR: path.join(APP_DIR, 'data') }
    : process.env;
  const proc = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], env });
  s.running = true;
  s.exitCode = null;
  const tag = `[${name}]`;
  const flushOut = pipePrefixed(proc.stdout, tag);
  const flushErr = pipePrefixed(proc.stderr, tag);
  proc.on('error', err => { console.error(`${tag} error:`, err.message); s.running = false; });
  proc.on('exit', code => {
    flushOut();
    flushErr();
    console.log(`${tag} exited`, code);
    s.running = false;
    s.exitCode = code;
  });
  return true;
}

// Start whichever syncs are stale; re-check every hour
function startStaleSyncs() {
  for (const name of Object.keys(SYNCS)) startSync(name);
}

const CHECK_INTERVAL_MS = WEEK_MS; // re-check every week

// ── File mtime helper ──────────────────────────────────────────────────────

function fileMtime(filename) {
  try { return fs.statSync(path.join(APP_DIR, 'data', filename)).mtime.toISOString(); }
  catch { return null; }
}

// ── Collections ────────────────────────────────────────────────────────────

const COLLECTIONS_FILE = path.join(APP_DIR, 'data', 'collections.json');

function loadCollections() {
  try { return JSON.parse(fs.readFileSync(COLLECTIONS_FILE, 'utf8')); }
  catch { return { activeId: null, collections: [] }; }
}
function saveCollections(data) {
  fs.writeFileSync(COLLECTIONS_FILE, JSON.stringify(data, null, 2), 'utf8');
}

// ── Decks (deck builder, saved to data/decks.json) ──────────────────────────

const DECKS_FILE = path.join(APP_DIR, 'data', 'decks.json');

function loadDecks() {
  try { return JSON.parse(fs.readFileSync(DECKS_FILE, 'utf8')); }
  catch { return { activeId: null, decks: [] }; }
}
function saveDecks(data) {
  fs.writeFileSync(DECKS_FILE, JSON.stringify(data, null, 2), 'utf8');
}

// ── Middleware ─────────────────────────────────────────────────────────────

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── Static + data endpoints ────────────────────────────────────────────────

app.get('/cards.json',         (req, res) => res.sendFile(path.join(APP_DIR, 'data', 'cards.json')));
app.get('/sets-data.json',     (req, res) => res.sendFile(path.join(APP_DIR, 'data', 'sets-data.json'),      err => { if (err) res.json({}); }));
app.get('/gallery-images.json',(req, res) => res.sendFile(path.join(APP_DIR, 'data', 'gallery-images.json'), err => { if (err) res.json({}); }));
app.get('/image-urls.json',    (req, res) => res.sendFile(path.join(APP_DIR, 'data', 'image-urls.json'),     err => { if (err) res.json({}); }));
app.get('/banlist.json',       (req, res) => res.sendFile(path.join(APP_DIR, 'data', 'banlist.json'),        err => { if (err) res.json({}); }));

// ── Collections API ────────────────────────────────────────────────────────

app.get('/api/collections', (req, res) => res.json(loadCollections()));

app.put('/api/collections', (req, res) => {
  if (!req.body || !Array.isArray(req.body.collections))
    return res.status(400).json({ error: 'invalid body' });
  saveCollections(req.body);
  res.json({ ok: true });
});

// ── Decks API ──────────────────────────────────────────────────────────────

app.get('/api/decks', (req, res) => res.json(loadDecks()));

app.put('/api/decks', (req, res) => {
  if (!req.body || !Array.isArray(req.body.decks))
    return res.status(400).json({ error: 'invalid body' });
  saveDecks(req.body);
  res.json({ ok: true });
});

// ── Version API ────────────────────────────────────────────────────────────

app.get('/api/version', (req, res) => {
  res.json({ version: require('./package.json').version });
});

// ── Sync API ───────────────────────────────────────────────────────────────

app.get('/api/sync-status', (req, res) => {
  // Read sync-state.json written by sync-cards.js for the authoritative cards sync timestamp
  let cardsLastSync = null;
  try {
    const state = JSON.parse(fs.readFileSync(path.join(APP_DIR, 'data', 'sync-state.json'), 'utf8'));
    cardsLastSync = state.last_synced || null;
  } catch { /* file may not exist yet */ }

  res.json({
    cards:   { running: SYNCS.cards.running,   staleAfterMs: STALE_MS.cards,   lastSync: cardsLastSync,                        lastModified: fileMtime('cards.json')           },
    sets:    { running: SYNCS.sets.running,    staleAfterMs: STALE_MS.sets,    lastSync: fileMtime('sets-data.json'),           lastModified: fileMtime('sets-data.json')      },
    gallery: { running: SYNCS.gallery.running, staleAfterMs: STALE_MS.gallery, lastSync: fileMtime('gallery-images.json'),      lastModified: fileMtime('gallery-images.json') },
    banlist: { running: SYNCS.banlist.running, staleAfterMs: STALE_MS.banlist, lastSync: fileMtime('banlist.json'),             lastModified: fileMtime('banlist.json')         },
  });
});

// POST /api/sync           — force-start all syncs
// POST /api/sync?t=cards   — force-start one specific sync
app.post('/api/sync', (req, res) => {
  const target = req.query.t;
  const targets = target && SYNCS[target] ? [target] : Object.keys(SYNCS);
  const started = targets.filter(n => startSync(n, true));
  res.json({
    started,
    skipped: targets.filter(n => !started.includes(n) && !SYNCS[n].running),
    alreadyRunning: targets.filter(n => SYNCS[n].running && !started.includes(n)),
  });
});

// ── Browser launcher ──────────────────────────────────────────────────────

function openBrowser(url) {
  if (process.platform === 'win32') {
    exec(`start msedge --app=${url}`, err => {
      if (err) exec(`start chrome --app=${url}`, err2 => {
        if (err2) exec(`start ${url}`);
      });
    });
  } else if (process.platform === 'darwin') {
    exec(`open -na "Google Chrome" --args --app=${url}`, err => {
      if (err) exec(`open ${url}`);
    });
  } else {
    exec(`google-chrome --app=${url}`, err => {
      if (err) exec(`chromium-browser --app=${url}`, err2 => {
        if (err2) exec(`chromium --app=${url}`, err3 => {
          if (err3) exec(`xdg-open ${url}`);
        });
      });
    });
  }
}

// ── Heartbeat / auto-shutdown (packaged exe only) ──────────────────────────

if (process.pkg) {
  let lastSeen = null;
  let watchdog = null;

  app.post('/api/heartbeat', (req, res) => {
    lastSeen = Date.now();
    if (!watchdog) {
      watchdog = setInterval(() => {
        if (lastSeen !== null && Date.now() - lastSeen > 15000) process.exit(0);
      }, 1000);
    }
    res.json({ ok: true });
  });
}

// ── Binary update API ──────────────────────────────────────────────────────

const { checkUpdate, downloadUpdate, writeApplyScript } = require('./scripts/update');

app.get('/api/update/check', async (req, res) => {
  try {
    const info = await checkUpdate();
    res.json(info);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/update/apply', async (req, res) => {
  res.setHeader('Content-Type', 'application/x-ndjson');
  res.setHeader('Transfer-Encoding', 'chunked');
  res.flushHeaders();
  try {
    const info = await checkUpdate();
    if (!info.hasUpdate || !info.downloadUrl) {
      res.write(JSON.stringify({ done: true, alreadyUpToDate: true }) + '\n');
      return res.end();
    }
    await downloadUpdate(info.downloadUrl, APP_DIR, pct => {
      res.write(JSON.stringify({ progress: Math.round(pct * 100) / 100 }) + '\n');
    });
    const script = writeApplyScript(APP_DIR);
    res.write(JSON.stringify({ done: true, version: info.latest, script }) + '\n');
  } catch (e) {
    res.write(JSON.stringify({ error: e.message }) + '\n');
  }
  res.end();
});

// ── Data update API ────────────────────────────────────────────────────────

const { checkDataUpdate, downloadData } = require('./scripts/data-update');

app.get('/api/data/check', async (req, res) => {
  try {
    const info = await checkDataUpdate(APP_DIR);
    res.json(info);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/data/apply', async (req, res) => {
  res.setHeader('Content-Type', 'application/x-ndjson');
  res.setHeader('Transfer-Encoding', 'chunked');
  res.flushHeaders();
  try {
    const info = await checkDataUpdate(APP_DIR);
    if (!info.hasUpdate) {
      res.write(JSON.stringify({ done: true, alreadyUpToDate: true }) + '\n');
      return res.end();
    }
    await downloadData(APP_DIR, info.files, pct => {
      res.write(JSON.stringify({ progress: Math.round(pct * 100) / 100 }) + '\n');
    });
    // Write updated local data-version.json
    const verPath = path.join(APP_DIR, 'data', 'data-version.json');
    fs.writeFileSync(verPath, JSON.stringify(info.remoteManifest, null, 2), 'utf8');
    res.write(JSON.stringify({ done: true, version: info.remoteVersion }) + '\n');
  } catch (e) {
    res.write(JSON.stringify({ error: e.message }) + '\n');
  }
  res.end();
});

// ── Migrations ─────────────────────────────────────────────────────────────

const { CURRENT: SCHEMA_CURRENT, runMigrations } = require('./scripts/migrations');
const SCHEMA_FILE = path.join(APP_DIR, 'data', 'schema.json');

function loadSchema() {
  try { return JSON.parse(fs.readFileSync(SCHEMA_FILE, 'utf8')); }
  catch { return {}; }
}

function saveSchema(schema) {
  try { fs.writeFileSync(SCHEMA_FILE, JSON.stringify(schema, null, 2), 'utf8'); }
  catch (e) { console.error('[migrations] Failed to save schema.json:', e.message); }
}

function runStartupMigrations() {
  const schema = loadSchema();
  for (const type of ['decks', 'collections']) {
    const from = schema[type] ?? 0;
    const target = SCHEMA_CURRENT[type];
    if (from >= target) continue;
    console.log(`[migrations] ${type}: v${from} → v${target}`);
    try {
      const file = type === 'decks' ? DECKS_FILE : COLLECTIONS_FILE;
      let data = type === 'decks' ? loadDecks() : loadCollections();
      const bakPath = file.replace(/\.json$/, `.bak-v${from}.json`);
      fs.writeFileSync(bakPath, JSON.stringify(data, null, 2), 'utf8');
      data = runMigrations(type, data, from);
      if (type === 'decks') saveDecks(data); else saveCollections(data);
      schema[type] = target;
      saveSchema(schema);
      console.log(`[migrations] ${type} migrated OK (backup: ${path.basename(bakPath)})`);
    } catch (e) {
      console.error(`[migrations] ${type} migration failed — data unchanged:`, e.message);
    }
  }
}

// ── Start server ───────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
  runStartupMigrations();

  if (process.pkg) openBrowser(`http://localhost:${PORT}`);
  startStaleSyncs();
  setInterval(startStaleSyncs, CHECK_INTERVAL_MS);
});
