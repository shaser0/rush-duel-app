'use strict';

// Fetches the current Rush Duel Forbidden/Limited list from Yugipedia.
// Starts from a known anchor page and follows | next = ... links until the
// most recent list is found, then saves data/banlist.json.
// Format: { "Card Name": "Forbidden" | "Limited" | "Semi-Limited" }
//
// Usage:  node scripts/sync/sync-banlist.js
//         node --use-system-ca scripts/sync-banlist.js   (Windows TLS fix)

// On Windows, re-spawn with --use-system-ca if needed so HTTPS works.
require('../lib/http').ensureSystemCa(__filename);

const path  = require('path');
const { fetchJson, sleep }  = require('../lib/http');
const { writeJsonAtomic }   = require('../lib/fs-atomic');
const { DATA_DIR, YUGIPEDIA_API: API } = require('../lib/paths');

const OUT = path.join(DATA_DIR, 'banlist.json');

// Known anchor — update if this page ever disappears.
const ANCHOR_PAGE = 'April 2026 Lists (Rush Duel)';

// Resolves null (never rejects) so findLatestPage can probe pages that may
// not exist yet. A missing page returns 200 with an `error` field, so it
// does not burn fetchJson retries.
async function fetchWikitext(page) {
  const url = `${API}?action=parse&page=${encodeURIComponent(page)}&prop=wikitext&format=json`;
  try {
    const j = await fetchJson(url);
    if (j.error) return null;
    return j?.parse?.wikitext?.['*'] || null;
  } catch { return null; }
}

// Extract value of a named template parameter, returns '' if not found.
function tmplParam(wikitext, paramName) {
  // Matches: | paramName = ... (until the next | or }})
  const re = new RegExp(`\\|\\s*${paramName}\\s*=\\s*([\\s\\S]*?)(?=\\|\\s*\\w+\\s*=|\\}\\})`, 'i');
  const m = wikitext.match(re);
  return m ? m[1].trim() : '';
}

// Parse card names listed under one template parameter.
// "// prev::..." suffixes are stripped. Empty lines are skipped.
// "(Rush Duel)" suffix is kept to match raw_name_en in our card data.
// Card names with " & " in them (e.g. "Harpie Lady 1 & 2 & 3") are kept
// as-is — they are single Rush Duel card titles, not combined entries.
function parseNames(block) {
  const names = [];
  for (const raw of block.split('\n')) {
    const line = raw.replace(/\s*\/\/.*$/, '').trim();
    if (!line) continue;
    names.push(line);
  }
  return names;
}

// Also add a version without "(Rush Duel)" suffix so we match either way.
function addEntry(banlist, name, status) {
  banlist[name] = status;
  const stripped = name.replace(/\s*\(Rush Duel\)\s*$/, '').trim();
  if (stripped !== name) banlist[stripped] = status;
}

async function findLatestPage() {
  let current = ANCHOR_PAGE;
  console.log(`[sync-banlist] Starting from anchor: ${current}`);
  for (let i = 0; i < 10; i++) {
    const wt = await fetchWikitext(current);
    if (!wt) { console.error(`[sync-banlist] Could not fetch: ${current}`); return null; }
    const nextPage = tmplParam(wt, 'next');
    if (!nextPage) { break; } // no next link → this is current
    await sleep(1200);
    const nextWt = await fetchWikitext(nextPage);
    if (!nextWt) {
      console.log(`[sync-banlist] Next page not yet published: "${nextPage}" → using "${current}"`);
      break;
    }
    console.log(`[sync-banlist] Advancing to: ${nextPage}`);
    current = nextPage;
    await sleep(1200);
  }
  return current;
}

async function syncBanlist() {
  const page = await findLatestPage();
  if (!page) { console.error('[sync-banlist] Failed to determine current banlist page.'); process.exit(1); }

  console.log(`[sync-banlist] Fetching current list: ${page}`);
  const wikitext = await fetchWikitext(page);
  if (!wikitext) { console.error('[sync-banlist] Failed to fetch wikitext.'); process.exit(1); }

  const banlist = {};
  const sections = { Forbidden: 'forbidden', Limited: 'limited', 'Semi-Limited': 'semi_limited' };
  for (const [status, param] of Object.entries(sections)) {
    const block = tmplParam(wikitext, param);
    for (const name of parseNames(block)) {
      addEntry(banlist, name, status);
    }
  }

  const count = Object.keys(banlist).length;
  if (count === 0) {
    console.warn('[sync-banlist] ABORT: 0 entrées parsées — format inattendu, banlist.json inchangé.');
    console.warn('Wikitext sample:\n' + wikitext.substring(0, 500));
    process.exit(1);
  }
  writeJsonAtomic(OUT, banlist);
  console.log(`[sync-banlist] Saved ${count} entries from "${page}" → data/banlist.json`);
}

module.exports = { syncBanlist };
if (require.main === module) syncBanlist().catch(e => { console.error(e); process.exit(1); });
