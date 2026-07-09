'use strict';

// ── Worker mode (pkg sync subprocess) ─────────────────────────────────────
// When spawned with RUSH_SYNC=<name>, run the named sync script and exit.
// RUSH_DATA_DIR points to the real data/ folder next to the binary.
if (process.env.RUSH_SYNC) {
  const mode = process.env.RUSH_SYNC;
  if (mode === 'cards')   { require('./scripts/sync/sync-cards');   return; }
  if (mode === 'sets')    { require('./scripts/sync/sync-sets');    return; }
  if (mode === 'gallery') { require('./scripts/sync/sync-gallery'); return; }
  if (mode === 'banlist') {
    require('./scripts/sync/sync-banlist').syncBanlist()
      .catch(e => { console.error(e); process.exit(1); });
    return;
  }
  process.exit(1);
}

const http    = require('http');
const express = require('express');
const path    = require('path');
const fs      = require('fs');
const { spawn, exec } = require('child_process');
const { writeJsonAtomic } = require('./scripts/lib/fs-atomic');

const app        = express();
const httpServer = http.createServer(app);
const PORT       = process.env.PORT || 3000;

// When running as a pkg .exe, resolve data files from the real exe directory
const APP_DIR = process.pkg ? path.dirname(process.execPath) : __dirname;

// pkg binary always runs in online-capable mode (each user has their own binary,
// so there is no shared-file concern; Socket.IO + 0.0.0.0 are always enabled).
const IS_ONLINE = !!(process.env.ONLINE_MODE || process.pkg);

// Reference data (cards.json & co) now ships from the jsDelivr CDN and is cached
// client-side; distributed clients no longer carry it on disk. A checkout that
// still has it locally is a maintainer/dev env (live wiki-sync tooling enabled).
const HAS_LOCAL_DATA = fs.existsSync(path.join(APP_DIR, 'data', 'cards.json'));

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
  cards:   { script: 'scripts/sync/sync-cards.js',   nodeArgs: [], running: false, exitCode: null },
  sets:    { script: 'scripts/sync/sync-sets.js',    nodeArgs: [], running: false, exitCode: null },
  gallery: { script: 'scripts/sync/sync-gallery.js', nodeArgs: [], running: false, exitCode: null },
  banlist: { script: 'scripts/sync/sync-banlist.js', nodeArgs: [], running: false, exitCode: null },
};

function isStale(name) {
  try {
    const mtime = fs.statSync(path.join(APP_DIR, STALE_FILE[name])).mtime.getTime();
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

// Start whichever syncs are stale; re-checked periodically (see CHECK_INTERVAL_MS)
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
  writeJsonAtomic(COLLECTIONS_FILE, data);
}

// ── Decks (deck builder, saved to data/decks.json) ──────────────────────────

const DECKS_FILE = path.join(APP_DIR, 'data', 'decks.json');

function loadDecks() {
  try { return JSON.parse(fs.readFileSync(DECKS_FILE, 'utf8')); }
  catch { return { activeId: null, decks: [] }; }
}
function saveDecks(data) {
  writeJsonAtomic(DECKS_FILE, data);
}

// ── Middleware ─────────────────────────────────────────────────────────────

// In local mode: restrict to localhost origins only.
// In online mode: allow any origin (players connect from VPN IPs).
const ALLOWED_ORIGINS = new Set([
  `http://localhost:${PORT}`,
  `http://127.0.0.1:${PORT}`,
]);

app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (!IS_ONLINE) {
    if (origin && !ALLOWED_ORIGINS.has(origin)) {
      return res.status(403).json({ error: 'forbidden origin' });
    }
  }
  if (origin) res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Vary', 'Origin');
  next();
});
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ── Static + data endpoints ────────────────────────────────────────────────

// Same-origin fallback used only in dev (DATA_CDN_BASE=""); in prod the client
// loads reference data from the CDN, so these files may be absent on disk.
app.get('/cards.json',         (req, res) => res.sendFile(path.join(APP_DIR, 'data', 'cards.json'),         err => { if (err) res.status(404).json({}); }));
app.get('/sets-data.json',     (req, res) => res.sendFile(path.join(APP_DIR, 'data', 'sets-data.json'),      err => { if (err) res.json({}); }));
app.get('/gallery-images.json',(req, res) => res.sendFile(path.join(APP_DIR, 'data', 'gallery-images.json'), err => { if (err) res.json({}); }));
app.get('/image-urls.json',    (req, res) => res.sendFile(path.join(APP_DIR, 'data', 'image-urls.json'),     err => { if (err) res.json({}); }));
app.get('/banlist.json',       (req, res) => res.sendFile(path.join(APP_DIR, 'data', 'banlist.json'),        err => { if (err) res.json({}); }));

// ── Collections + Decks API (local client only) ─────────────────────────────
// These persist to a single shared file on disk. On a public ONLINE_MODE host
// that is a global file writable by anyone — so the routes are local-only until
// Phase 3 replaces them with authenticated, per-Discord-account storage (SQLite).
if (!process.env.ONLINE_MODE || process.pkg) {
  app.get('/api/collections', (req, res) => res.json(loadCollections()));

  app.put('/api/collections', (req, res) => {
    if (!req.body || !Array.isArray(req.body.collections))
      return res.status(400).json({ error: 'invalid body' });
    saveCollections(req.body);
    res.json({ ok: true });
  });

  app.get('/api/decks', (req, res) => res.json(loadDecks()));

  app.put('/api/decks', (req, res) => {
    if (!req.body || !Array.isArray(req.body.decks))
      return res.status(400).json({ error: 'invalid body' });
    saveDecks(req.body);
    res.json({ ok: true });
  });
}

// ── Version API ────────────────────────────────────────────────────────────

app.get('/api/version', (req, res) => {
  res.json({ version: require('./package.json').version });
});

// ── Client config ──────────────────────────────────────────────────────────
// Tells the SPA where to load reference data (jsDelivr CDN, pinned to an
// immutable release tag) and, later, the Oracle backend for duels/auth.
// `maintainer` enables the live-sync UI only on a checkout that has local data.

app.get('/api/config', (req, res) => {
  const tag = process.env.DATA_TAG || ('v' + require('./package.json').version);
  // Setting DATA_CDN_BASE="" (empty) forces the same-origin dev fallback.
  const cdnBase = ('DATA_CDN_BASE' in process.env)
    ? process.env.DATA_CDN_BASE
    : `https://cdn.jsdelivr.net/gh/shaser0/rush-duel-app@${tag}/data`;
  // Data "channel": a small pointer file on the main branch naming the current
  // data tag + version, so card data can be refreshed independently of the app
  // version (push a data-only tag + bump the pointer — no binary rebuild). The
  // client polls it in the background (and on demand) and re-caches when the
  // version advances. Phase 3 (Oracle) can override this with a server endpoint.
  const channelUrl = ('DATA_CHANNEL_URL' in process.env)
    ? process.env.DATA_CHANNEL_URL
    : (cdnBase ? 'https://cdn.jsdelivr.net/gh/shaser0/rush-duel-app@main/data/data-channel.json' : '');
  res.json({
    dataBase:       cdnBase.replace(/\/+$/, ''),
    dataTag:        tag,
    dataChannelUrl: channelUrl,
    oracleBase:     (process.env.ORACLE_URL || '').replace(/\/+$/, ''),
    maintainer:     HAS_LOCAL_DATA,
  });
});

// ── Sync API (maintainer/dev only — needs local data + wiki-sync tooling) ────

if (HAS_LOCAL_DATA) {
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
} // end HAS_LOCAL_DATA (sync API)

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

// ── Binary update API (local mode only) ───────────────────────────────────

if (!process.env.ONLINE_MODE || process.pkg) {
  const { checkUpdate, downloadUpdate, writeApplyScript } = require('./scripts/release/update');

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
      await downloadUpdate(info.downloadUrl, info.release, APP_DIR, pct => {
        res.write(JSON.stringify({ progress: Math.round(pct * 100) / 100 }) + '\n');
      });
      const script = writeApplyScript(APP_DIR);
      res.write(JSON.stringify({ done: true, version: info.latest, script }) + '\n');
    } catch (e) {
      res.write(JSON.stringify({ error: e.message }) + '\n');
    }
    res.end();
  });
}

// Data-update-to-disk API removed: reference data is now served from the
// jsDelivr CDN and cached client-side (see /api/config + the SPA loader).

// ── Migrations ─────────────────────────────────────────────────────────────

const { CURRENT: SCHEMA_CURRENT, runMigrations } = require('./scripts/pipeline/migrations');
const SCHEMA_FILE = path.join(APP_DIR, 'data', 'schema.json');

function loadSchema() {
  try { return JSON.parse(fs.readFileSync(SCHEMA_FILE, 'utf8')); }
  catch { return {}; }
}

function saveSchema(schema) {
  try {
    writeJsonAtomic(SCHEMA_FILE, schema);
  } catch (e) { console.error('[migrations] Failed to save schema.json:', e.message); }
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

// ── Online mode ────────────────────────────────────────────────────────────

if (IS_ONLINE) {
  require('./online').mount(httpServer);
}

// ── Start server ───────────────────────────────────────────────────────────

const HOST = IS_ONLINE ? '0.0.0.0' : '127.0.0.1';

httpServer.listen(PORT, HOST, () => {
  console.log(`Server running at http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
  if (IS_ONLINE) {
    console.log(`[online] Listening on 0.0.0.0:${PORT} — reachable via Cloudflare Tunnel`);
  }
  runStartupMigrations();

  if (process.pkg) openBrowser(`http://localhost:${PORT}`);
  // Live wiki-sync only on a maintainer/dev checkout; distributed clients and the
  // Oracle host get reference data from the CDN, so they never scrape.
  if (HAS_LOCAL_DATA) {
    startStaleSyncs();
    setInterval(startStaleSyncs, CHECK_INTERVAL_MS);
  }
});
