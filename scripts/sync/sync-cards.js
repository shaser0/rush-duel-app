'use strict';

require('../lib/http').ensureSystemCa(__filename);

const fs           = require('fs');
const { sleep } = require('../lib/http');
const { writeJsonAtomic }  = require('../lib/fs-atomic');
const { DATA_DIR }         = require('../lib/paths');
const { getCategoryMembers, getTimestampsBatch, resolveRedirects, fetchQuery, RATE_MS } = require('../lib/yugipedia');
const { cleanCards } = require('../pipeline/clean-cards');

// ── Config ───────────────────────────────────────────────────────────────────

const _path         = require('path');
const CARDS_FILE    = _path.join(DATA_DIR, 'raw-cards.json');
const STATE_FILE    = _path.join(DATA_DIR, 'sync-state.json');
const PROGRESS_FILE = _path.join(DATA_DIR, 'sync-progress.json');
const GALLERY_FILE  = _path.join(DATA_DIR, 'gallery-images.json');
const BANLIST_FILE  = _path.join(DATA_DIR, 'banlist.json');
const BATCH_SIZE    = 50; // titles per timestamp API call

// Other data files keyed by card title also go stale on a rename — patch them
// in place so a rename doesn't orphan cached gallery images or banlist status.
function renameKeyInJsonFile(filePath, oldTitle, newTitle) {
  let data;
  try { data = JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch { return; }
  if (!(oldTitle in data)) return;
  if (Array.isArray(data[oldTitle]) && Array.isArray(data[newTitle])) {
    data[newTitle] = [...new Set([...data[newTitle], ...data[oldTitle]])];
  } else if (!(newTitle in data)) {
    data[newTitle] = data[oldTitle];
  }
  delete data[oldTitle];
  writeJsonAtomic(filePath, data);
}

// ── Wiki parsing ─────────────────────────────────────────────────────────────

function parseCardTable(wikitext) {
  const match = wikitext.match(/\{\{CardTable2([\s\S]*?)\}\}\s*$/);
  if (!match) return null;

  const body = match[1];
  const raw  = {};
  const re   = /\|\s*(\w+)\s*=[ \t]*([\s\S]*?)(?=\n\s*\||\n\s*\}\}|$)/g;
  let m;
  while ((m = re.exec(body)) !== null) {
    const key = m[1].trim(), val = m[2].trim();
    if (val) raw[key] = val;
  }

  return {
    name_en:        raw.en_name || raw.name || null,
    name_ja:        raw.ja_name        || null,
    name_ja_romaji: raw.romaji_name    || null,
    name_ko:        raw.ko_name        || null,
    name_fr:        raw.fr_name        || null,
    name_de:        raw.de_name        || null,
    name_it:        raw.it_name        || null,
    name_es:        raw.es_name        || null,
    // Unofficial literal English translation of the Japanese name (Yugipedia
    // `translated_name`), shown for cards whose English page name differs from
    // a direct rendering of the JP name. Null for most cards.
    name_translated: raw.translated_name || null,
    attribute:      raw.attribute      || null,
    types:          raw.types          || null,
    card_type:      raw.card_type      || null,
    property:       raw.property       || null,
    level:          raw.level          ? parseInt(raw.level)       : null,
    atk:            raw.atk            ? parseInt(raw.atk)         : null,
    def:            raw.def            ? parseInt(raw.def)         : null,
    maximum_atk:    raw.maximum_atk    ? parseInt(raw.maximum_atk) : null,
    materials:      raw.materials      || null,
    condition:      raw.condition      || null,
    effect_types:   raw.effect_types   || null,
    requirement:    raw.requirement    || null,
    effect:         raw.text           || null,
    flavor_text:    raw.flavor_text    || null,
    images:         raw.image          || null,
    sets_jp:        raw.jp_sets        || null,
    sets_kr:        raw.kr_sets        || null,
    database_id:    raw.database_id    || null,
    archseries:     raw.archseries     || null,
    password:       raw.password       || null,
    // Legend cards are flagged via "Legend Card" in the template's misc field
    is_legend:      /Legend Card/i.test(raw.misc || ''),
  };
}

// ── API calls ─────────────────────────────────────────────────────────────────

async function fetchAllTitles() {
  process.stdout.write('Fetching titles...\r');
  const titles = await getCategoryMembers('Category:Rush Duel cards', t => !t.startsWith('List of'));
  console.log(`Fetching titles... ${titles.length} cards found.`);
  return titles;
}

async function fetchCardData(title) {
  const url = 'https://yugipedia.com/api.php?action=query'
    + '&titles=' + encodeURIComponent(title)
    + '&prop=revisions&rvprop=content|timestamp&rvslots=main&format=json';

  const result = await fetchQuery(url);
  const page   = Object.values(result.query.pages)[0];
  if (page.missing !== undefined || !page.revisions) return null;

  const rev      = page.revisions[0];
  const wikitext = rev?.slots?.main?.['*'] || rev?.['*'] || null;
  if (!wikitext) return null;

  const card = parseCardTable(wikitext);
  if (!card) return null;

  return { ...card, title, _wiki_ts: rev.timestamp };
}

async function fetchJaName(rushDuelTitle) {
  const tcgTitle = rushDuelTitle.replace(/\s*\(Rush Duel\)/i, '').trim();
  const url = 'https://yugipedia.com/api.php?action=query'
    + '&titles=' + encodeURIComponent(tcgTitle)
    + '&prop=revisions&rvprop=content&rvslots=main&format=json';

  const result = await fetchQuery(url);
  const page   = Object.values(result.query.pages)[0];
  if (page.missing !== undefined || !page.revisions) return null;

  const wikitext   = page.revisions[0]?.slots?.main?.['*'] || page.revisions[0]?.['*'] || '';
  const tableMatch = wikitext.match(/\{\{CardTable2([\s\S]*?)\}\}\s*$/);
  if (!tableMatch) return null;

  const body   = tableMatch[1];
  const ja     = body.match(/\|\s*ja_name\s*=\s*([\s\S]*?)(?=\n\s*\||\n\s*\}\}|$)/)?.[1]?.trim() || null;
  const romaji = body.match(/\|\s*romaji_name\s*=\s*([\s\S]*?)(?=\n\s*\||\n\s*\}\}|$)/)?.[1]?.trim() || null;

  return (ja || romaji) ? { name_ja: ja, name_ja_romaji: romaji } : null;
}

// ── Change detection ──────────────────────────────────────────────────────────

const TRACKED_FIELDS = [
  'name_en', 'name_ja', 'name_ja_romaji', 'name_ko', 'name_fr',
  'name_de', 'name_it', 'name_es', 'name_translated', 'attribute', 'types', 'card_type', 'property', 'level',
  'atk', 'def', 'maximum_atk', 'materials', 'condition', 'effect_types', 'requirement', 'effect', 'flavor_text',
  'images', 'sets_jp', 'sets_kr', 'database_id', 'archseries', 'password', 'is_legend',
];

function diffFields(oldCard, newCard) {
  return TRACKED_FIELDS.filter(
    f => JSON.stringify(oldCard[f]) !== JSON.stringify(newCard[f])
  );
}

// Bump whenever parseCardTable's field-mapping logic changes, so cards
// fetched under an older version get force re-fetched even if their wiki
// revision hasn't changed (timestamp diffing alone can't catch a value that
// was captured wrong and never touched again — see the stray legacy
// `jp_sets` field bug this replaced).
// v2: added name_translated (Yugipedia `translated_name`).
const CARD_SCHEMA_VERSION = 2;

// Non-content bookkeeping fields alongside TRACKED_FIELDS. Anything else on a
// card is unexpected — almost certainly a leftover from an old schema (like
// the stray `jp_sets` field bug) rather than something a reader intended to
// keep. Cheap, no network needed: run on every sync.
const KNOWN_FIELDS = new Set([...TRACKED_FIELDS, 'title', '_wiki_ts', 'former_titles', 'card_schema_version']);
function auditCardShape(cards) {
  for (const card of cards) {
    const stray = Object.keys(card).filter(k => !KNOWN_FIELDS.has(k));
    if (stray.length) console.warn(`[sync-cards] "${card.title}" has unexpected field(s): ${stray.join(', ')}`);
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  // Load existing data
  const state = fs.existsSync(STATE_FILE)
    ? JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'))
    : { last_synced: null };

  let cards     = fs.existsSync(CARDS_FILE) && fs.statSync(CARDS_FILE).size > 2
    ? JSON.parse(fs.readFileSync(CARDS_FILE, 'utf8'))
    : [];
  const byTitle = new Map(cards.map((c, i) => [c.title, i]));

  // A card built by test-api.js has no _wiki_ts. Treat those as a
  // "first sync": populate timestamps without re-fetching full wikitext.
  const isEmptyDB     = cards.length === 0;
  const isFirstSync   = !isEmptyDB && !state.last_synced;

  if (isEmptyDB)      console.log('=== First run — full fetch ===\n');
  else if (isFirstSync) console.log('=== First sync — establishing baseline ===\n');
  else                console.log(`=== Sync — last run: ${state.last_synced} ===\n`);

  if (!isEmptyDB) auditCardShape(cards);

  // ── 1. Title list ──────────────────────────────────────────────────────────
  const wikiTitles  = await fetchAllTitles();
  const wikiSet     = new Set(wikiTitles);
  const existingSet = new Set(cards.map(c => c.title));

  let removedTitles = wikiTitles.length
    ? [...existingSet].filter(t => !wikiSet.has(t))
    : [];

  // A title missing from the wiki listing is often just a page rename
  // (Yugipedia redirects the old title to a new one), not a deletion. Detect
  // those and merge the existing card entry into its new title in place,
  // instead of reporting it as gone while a duplicate gets created under the
  // new title on some future sync.
  if (removedTitles.length) {
    const redirects = await resolveRedirects(removedTitles);
    const stillRemoved = [];
    const merged = [];

    for (const oldTitle of removedTitles) {
      const newTitle = redirects.get(oldTitle);
      if (!newTitle || !wikiSet.has(newTitle)) { stillRemoved.push(oldTitle); continue; }

      const oldIdx = byTitle.get(oldTitle);
      let survivor;
      if (existingSet.has(newTitle)) {
        // A (possibly stale) entry already exists under the new title from
        // an earlier sync — drop this stale duplicate; the newTitle entry
        // will be refreshed normally via the timestamp check below.
        survivor = cards[byTitle.get(newTitle)];
        cards[oldIdx] = null;
      } else {
        survivor = cards[oldIdx];
        survivor.title = newTitle;
        existingSet.add(newTitle);
      }
      // Record the old title on the surviving card so the app can migrate any
      // saved collection/deck entries still pointing at it. Chained renames
      // (A→B, later B→C) land on the same array since it travels with the
      // one surviving card object.
      survivor.former_titles = [...new Set([...(survivor.former_titles || []), oldTitle])];

      existingSet.delete(oldTitle);
      byTitle.delete(oldTitle);
      merged.push([oldTitle, newTitle]);
    }

    if (merged.length) {
      cards = cards.filter(Boolean);
      byTitle.clear();
      cards.forEach((c, i) => byTitle.set(c.title, i));
      console.log(`  Renamed on the wiki (merged): ${merged.length}`);
      for (const [from, to] of merged) {
        console.log(`    - ${from} -> ${to}`);
        // gallery-images.json and banlist.json are dicts keyed by card title
        // (unlike raw-cards.json/cards.json, which are arrays) — patch them
        // directly so a rename doesn't orphan cached data under the old key.
        renameKeyInJsonFile(GALLERY_FILE, from, to);
        renameKeyInJsonFile(BANLIST_FILE, from, to);
      }
    }

    removedTitles = stillRemoved;
  }

  const newTitles = wikiTitles.filter(t => !existingSet.has(t));

  console.log(`  New cards on the wiki: ${newTitles.length}`);
  if (removedTitles.length) {
    console.log(`  Missing from the wiki (reporting only):`);
    removedTitles.forEach(t => console.log(`    - ${t}`));
  }

  // ── 2. Timestamp check for existing cards ──────────────────────────────────
  let modifiedTitles = [];

  if (!isEmptyDB) {
    const toCheck = wikiTitles.filter(t => existingSet.has(t));
    let checked   = 0;

    console.log(isFirstSync
      ? `\nBaseline: fetching timestamps (${toCheck.length} cards)...`
      : `\nChecking for revisions (${toCheck.length} cards)...`);

    for (let i = 0; i < toCheck.length; i += BATCH_SIZE) {
      const batch      = toCheck.slice(i, i + BATCH_SIZE);
      const timestamps = await getTimestampsBatch(batch);

      for (const [title, ts] of timestamps) {
        const idx    = byTitle.get(title);
        const stored = cards[idx]?._wiki_ts;

        if (isFirstSync) {
          // First sync: just stamp existing cards, don't mark as modified
          if (idx !== undefined) cards[idx]._wiki_ts = ts;
        } else {
          // Normal sync: flag if wiki is newer than our stored timestamp, or
          // if this card predates the current parser (its content may have
          // been captured wrong by an older version and never revisited).
          const staleSchema = cards[idx]?.card_schema_version !== CARD_SCHEMA_VERSION;
          if (!stored || ts > stored || staleSchema) modifiedTitles.push(title);
        }
      }

      checked += batch.length;
      process.stdout.write(`  ${checked}/${toCheck.length} processed...\r`);
      await sleep(RATE_MS);
    }
    console.log(`  ${checked}/${toCheck.length} processed.    `);

    if (isFirstSync) {
      // Save the stamped cards.json now so future runs have _wiki_ts
      writeJsonAtomic(CARDS_FILE, cards);
      console.log(`  Timestamps saved to cards.json.`);
    } else {
      console.log(`  Modified: ${modifiedTitles.length}`);
    }
  }

  // ── 3. Build fetch list (with resume support) ──────────────────────────────
  let toFetch = [...new Set([...newTitles, ...modifiedTitles])];
  let startAt = 0;

  if (fs.existsSync(PROGRESS_FILE) && !isEmptyDB) {
    const prog = JSON.parse(fs.readFileSync(PROGRESS_FILE, 'utf8'));
    toFetch    = prog.toFetch;
    startAt    = prog.lastIndex + 1;
    console.log(`\nResuming from #${startAt}/${toFetch.length}`);
  }

  // ── 4. Fetch loop ──────────────────────────────────────────────────────────
  let added = 0, updated = 0, unchanged = 0, errors = 0, jaFetched = 0;

  if (toFetch.length === 0) {
    console.log('\nNo cards to update.');
  } else {
    console.log(`\nFetching ${toFetch.length} card(s) (from #${startAt})...`);

    for (let i = startAt; i < toFetch.length; i++) {
      const title = toFetch[i];
      const pct   = ((i + 1) / toFetch.length * 100).toFixed(1);
      process.stdout.write(`[${i + 1}/${toFetch.length} — ${pct}%] ${title}... `);

      try {
        const fetched = await fetchCardData(title);

        if (!fetched) {
          process.stdout.write('(skipped)\n');
        } else {
          fetched.card_schema_version = CARD_SCHEMA_VERSION;

          // Fetch JP name for (Rush Duel) cards missing it
          if (title.includes('(Rush Duel)') && !fetched.name_ja) {
            await sleep(RATE_MS);
            const ja = await fetchJaName(title);
            if (ja) {
              if (ja.name_ja)         fetched.name_ja        = ja.name_ja;
              if (ja.name_ja_romaji)  fetched.name_ja_romaji = ja.name_ja_romaji;
              jaFetched++;
            }
          }

          if (byTitle.has(title)) {
            const idx  = byTitle.get(title);
            const diff = diffFields(cards[idx], fetched);

            if (diff.length > 0) {
              // Preserve former_titles (set by the rename-merge step above) —
              // a fresh wiki fetch has no concept of this card's prior titles.
              cards[idx] = cards[idx].former_titles
                ? { ...fetched, former_titles: cards[idx].former_titles }
                : fetched;
              process.stdout.write(`updated (${diff.join(', ')})\n`);
              updated++;
            } else {
              // Tracked content is identical, but this fetch still confirms
              // it under the current parser — keep timestamp and schema
              // version fresh so a stale-schema flag doesn't loop forever.
              cards[idx]._wiki_ts = fetched._wiki_ts;
              cards[idx].card_schema_version = CARD_SCHEMA_VERSION;
              process.stdout.write('unchanged\n');
              unchanged++;
            }
          } else {
            cards.push(fetched);
            byTitle.set(title, cards.length - 1);
            process.stdout.write('added\n');
            added++;
          }
        }
      } catch (err) {
        process.stdout.write(`ERROR: ${err.message}\n`);
        errors++;
      }

      // Incremental save every 50 cards
      if ((i + 1) % 50 === 0) {
        writeJsonAtomic(CARDS_FILE,    cards);
        writeJsonAtomic(PROGRESS_FILE, { lastIndex: i, toFetch });
        writeJsonAtomic(_path.join(DATA_DIR, 'sync-progress-cards.json'), { current: i + 1, total: toFetch.length });
      }

      await sleep(RATE_MS);
    }
  }

  // ── 5. Final saves ─────────────────────────────────────────────────────────
  writeJsonAtomic(CARDS_FILE, cards);
  if (fs.existsSync(PROGRESS_FILE))        fs.unlinkSync(PROGRESS_FILE);
  const _spc = _path.join(DATA_DIR, 'sync-progress-cards.json');
  if (fs.existsSync(_spc)) fs.unlinkSync(_spc);

  writeJsonAtomic(STATE_FILE, {
    last_synced: new Date().toISOString(),
    total_cards: cards.length,
  });

  // ── 6. Summary ─────────────────────────────────────────────────────────────
  console.log('\n── Summary ──────────────────────────────────────');
  console.log(`  Total       : ${cards.length} cards`);
  if (added)     console.log(`  + Added     : ${added}`);
  if (updated)   console.log(`  ~ Updated   : ${updated}`);
  if (unchanged) console.log(`  = Unchanged : ${unchanged}`);
  if (jaFetched) console.log(`  JA fetched  : ${jaFetched}`);
  if (errors)    console.log(`  ! Errors    : ${errors}`);

  // ── 7. Cleaning pipeline ───────────────────────────────────────────────────
  console.log('\nCleaning -> cards.json...');
  cleanCards();
  console.log('Done.');
}

main().catch(err => {
  console.error('\nFatal error:', err.message);
  process.exit(1);
});
