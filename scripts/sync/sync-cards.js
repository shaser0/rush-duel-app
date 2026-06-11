'use strict';

require('../lib/http').ensureSystemCa(__filename);

const fs           = require('fs');
const { fetchJson, sleep } = require('../lib/http');
const { writeJsonAtomic }  = require('../lib/fs-atomic');
const { DATA_DIR }         = require('../lib/paths');
const { cleanCards } = require('../pipeline/clean-cards');

// ── Config ───────────────────────────────────────────────────────────────────

const _path         = require('path');
const CARDS_FILE    = _path.join(DATA_DIR, 'raw-cards.json');
const STATE_FILE    = _path.join(DATA_DIR, 'sync-state.json');
const PROGRESS_FILE = _path.join(DATA_DIR, 'sync-progress.json');
const RATE_MS       = 1100;
const BATCH_SIZE    = 50; // titles per timestamp API call

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
  const titles = [];
  let cmcontinue = null;
  process.stdout.write('Récupération des titres...\r');

  do {
    const url = 'https://yugipedia.com/api.php?action=query'
      + '&list=categorymembers&cmtitle=Category:Rush_Duel_cards'
      + '&cmtype=page&cmlimit=500&format=json'
      + (cmcontinue ? '&cmcontinue=' + encodeURIComponent(cmcontinue) : '');

    const result = await fetchJson(url);
    for (const m of result.query.categorymembers) {
      if (!m.title.startsWith('List of')) titles.push(m.title);
    }
    cmcontinue = result.continue?.cmcontinue ?? null;
    process.stdout.write(`Récupération des titres... ${titles.length}\r`);
    await sleep(RATE_MS);
  } while (cmcontinue);

  console.log(`Récupération des titres... ${titles.length} cartes trouvées.`);
  return titles;
}

async function fetchTimestampsBatch(titles, attempt = 0) {
  // Returns { title → wiki_timestamp }
  // Titles joined with literal | (each title encoded individually)
  const url = 'https://yugipedia.com/api.php?action=query'
    + '&titles=' + titles.map(encodeURIComponent).join('|')
    + '&prop=revisions&rvprop=timestamp&format=json';

  const result = await fetchJson(url);

  if (!result.query) {
    if (attempt < 2) {
      await sleep(3000);
      return fetchTimestampsBatch(titles, attempt + 1);
    }
    throw new Error('API sans query après 3 tentatives : ' + JSON.stringify(result).slice(0, 200));
  }

  const out = {};
  for (const page of Object.values(result.query.pages)) {
    if (page.missing !== undefined) continue;
    const ts = page.revisions?.[0]?.timestamp;
    if (ts) out[page.title] = ts;
  }
  return out;
}

async function fetchCardData(title) {
  const url = 'https://yugipedia.com/api.php?action=query'
    + '&titles=' + encodeURIComponent(title)
    + '&prop=revisions&rvprop=content|timestamp&rvslots=main&format=json';

  const result = await fetchJson(url);
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

  const result = await fetchJson(url);
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
  'name_de', 'name_it', 'name_es', 'attribute', 'types', 'card_type', 'property', 'level',
  'atk', 'def', 'maximum_atk', 'materials', 'condition', 'effect_types', 'requirement', 'effect', 'flavor_text',
  'images', 'sets_jp', 'sets_kr', 'database_id', 'archseries', 'password', 'is_legend',
];

function diffFields(oldCard, newCard) {
  return TRACKED_FIELDS.filter(
    f => JSON.stringify(oldCard[f]) !== JSON.stringify(newCard[f])
  );
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  // Load existing data
  const state = fs.existsSync(STATE_FILE)
    ? JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'))
    : { last_synced: null };

  const cards   = fs.existsSync(CARDS_FILE) && fs.statSync(CARDS_FILE).size > 2
    ? JSON.parse(fs.readFileSync(CARDS_FILE, 'utf8'))
    : [];
  const byTitle = new Map(cards.map((c, i) => [c.title, i]));

  // A card built by test-api.js has no _wiki_ts. Treat those as a
  // "first sync": populate timestamps without re-fetching full wikitext.
  const isEmptyDB     = cards.length === 0;
  const isFirstSync   = !isEmptyDB && !state.last_synced;

  if (isEmptyDB)      console.log('=== Premier lancement — récupération complète ===\n');
  else if (isFirstSync) console.log('=== Première synchronisation — établissement de la baseline ===\n');
  else                console.log(`=== Synchronisation — dernière : ${state.last_synced} ===\n`);

  // ── 1. Title list ──────────────────────────────────────────────────────────
  const wikiTitles  = await fetchAllTitles();
  const wikiSet     = new Set(wikiTitles);
  const existingSet = new Set(cards.map(c => c.title));

  const newTitles     = wikiTitles.filter(t => !existingSet.has(t));
  const removedTitles = [...existingSet].filter(t => !wikiSet.has(t));

  console.log(`  Nouvelles cartes sur le wiki : ${newTitles.length}`);
  if (removedTitles.length) {
    console.log(`  Absentes du wiki (signalement) :`);
    removedTitles.forEach(t => console.log(`    - ${t}`));
  }

  // ── 2. Timestamp check for existing cards ──────────────────────────────────
  let modifiedTitles = [];

  if (!isEmptyDB) {
    const toCheck = wikiTitles.filter(t => existingSet.has(t));
    let checked   = 0;

    console.log(isFirstSync
      ? `\nBaseline : récupération des timestamps (${toCheck.length} cartes)...`
      : `\nVérification des révisions (${toCheck.length} cartes)...`);

    for (let i = 0; i < toCheck.length; i += BATCH_SIZE) {
      const batch      = toCheck.slice(i, i + BATCH_SIZE);
      const timestamps = await fetchTimestampsBatch(batch);

      for (const [title, ts] of Object.entries(timestamps)) {
        const idx    = byTitle.get(title);
        const stored = cards[idx]?._wiki_ts;

        if (isFirstSync) {
          // First sync: just stamp existing cards, don't mark as modified
          if (idx !== undefined) cards[idx]._wiki_ts = ts;
        } else {
          // Normal sync: flag if wiki is newer than our stored timestamp
          if (!stored || ts > stored) modifiedTitles.push(title);
        }
      }

      checked += batch.length;
      process.stdout.write(`  ${checked}/${toCheck.length} traités...\r`);
      await sleep(RATE_MS);
    }
    console.log(`  ${checked}/${toCheck.length} traités.    `);

    if (isFirstSync) {
      // Save the stamped cards.json now so future runs have _wiki_ts
      writeJsonAtomic(CARDS_FILE, cards);
      console.log(`  Timestamps enregistrés dans cards.json.`);
    } else {
      console.log(`  Modifiées : ${modifiedTitles.length}`);
    }
  }

  // ── 3. Build fetch list (with resume support) ──────────────────────────────
  let toFetch = [...new Set([...newTitles, ...modifiedTitles])];
  let startAt = 0;

  if (fs.existsSync(PROGRESS_FILE) && !isEmptyDB) {
    const prog = JSON.parse(fs.readFileSync(PROGRESS_FILE, 'utf8'));
    toFetch    = prog.toFetch;
    startAt    = prog.lastIndex + 1;
    console.log(`\nReprise depuis #${startAt}/${toFetch.length}`);
  }

  // ── 4. Fetch loop ──────────────────────────────────────────────────────────
  let added = 0, updated = 0, unchanged = 0, errors = 0, jaFetched = 0;

  if (toFetch.length === 0) {
    console.log('\nAucune carte a mettre a jour.');
  } else {
    console.log(`\nRecuperation de ${toFetch.length} carte(s) (depuis #${startAt})...`);

    for (let i = startAt; i < toFetch.length; i++) {
      const title = toFetch[i];
      const pct   = ((i + 1) / toFetch.length * 100).toFixed(1);
      process.stdout.write(`[${i + 1}/${toFetch.length} — ${pct}%] ${title}... `);

      try {
        const fetched = await fetchCardData(title);

        if (!fetched) {
          process.stdout.write('(ignoree)\n');
        } else {
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
              cards[idx] = fetched;
              process.stdout.write(`mis a jour (${diff.join(', ')})\n`);
              updated++;
            } else {
              cards[idx]._wiki_ts = fetched._wiki_ts; // keep timestamp fresh
              process.stdout.write('inchangee\n');
              unchanged++;
            }
          } else {
            cards.push(fetched);
            byTitle.set(title, cards.length - 1);
            process.stdout.write('ajoutee\n');
            added++;
          }
        }
      } catch (err) {
        process.stdout.write(`ERREUR: ${err.message}\n`);
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
  console.log('\n── Résumé ──────────────────────────────────────');
  console.log(`  Total         : ${cards.length} cartes`);
  if (added)     console.log(`  + Ajoutées    : ${added}`);
  if (updated)   console.log(`  ~ Mises à jour: ${updated}`);
  if (unchanged) console.log(`  = Inchangées  : ${unchanged}`);
  if (jaFetched) console.log(`  JP récupérés  : ${jaFetched}`);
  if (errors)    console.log(`  ! Erreurs     : ${errors}`);

  // ── 7. Cleaning pipeline ───────────────────────────────────────────────────
  console.log('\nNettoyage → cards.json...');
  cleanCards();
  console.log('Terminé.');
}

main().catch(err => {
  console.error('\nErreur fatale :', err.message);
  process.exit(1);
});
