'use strict';

// On Windows, Node.js does not trust the Windows certificate store by default.
// Re-spawn with --use-system-ca so HTTPS fetches work without CA errors.
if (!process.execArgv.some(a => a === '--use-system-ca')) {
  const { spawnSync } = require('child_process');
  const r = spawnSync(process.execPath, ['--use-system-ca', __filename, ...process.argv.slice(2)], { stdio: 'inherit' });
  process.exit(r.status ?? 0);
}

const https = require('https');
const fs = require('fs');
const path = require('path');

const API = 'https://yugipedia.com/api.php';
const DATA_DIR = process.env.RUSH_DATA_DIR || path.join(__dirname, '../data');
const OUT      = path.join(DATA_DIR, 'sets-data.json');
const IMG_URLS = path.join(DATA_DIR, 'image-urls.json');
const RATE_MS = 1200;

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function fetchJson(url, retries = 2) {
  return new Promise((resolve, reject) => {
    const attempt = (n) => {
      const req = https.get(url, {
        headers: { 'User-Agent': 'YgoRushDB/1.0 (https://github.com/user/ygo-rush-db)' },
      }, res => {
        let data = '';
        res.on('data', c => (data += c));
        res.on('end', () => {
          if (res.statusCode < 200 || res.statusCode >= 300) {
            if (n > 0) { setTimeout(() => attempt(n - 1), 3000); }
            else { reject(new Error(`HTTP ${res.statusCode}`)); }
            return;
          }
          try { resolve(JSON.parse(data)); }
          catch (e) { reject(e); }
        });
      });
      req.on('error', err => {
        if (n > 0) { setTimeout(() => attempt(n - 1), 2000); }
        else { reject(err); }
      });
      req.setTimeout(30000, () => {
        req.destroy();
        if (n > 0) { setTimeout(() => attempt(n - 1), 2000); }
        else { reject(new Error('timeout')); }
      });
    };
    attempt(retries);
  });
}

async function getCategoryMembers(category) {
  const titles = [];
  let cmcontinue = '';
  do {
    const cont = cmcontinue ? `&cmcontinue=${encodeURIComponent(cmcontinue)}` : '';
    const url = `${API}?action=query&list=categorymembers&cmtitle=${encodeURIComponent(category)}&cmlimit=500&cmtype=page&format=json${cont}`;
    const data = await fetchJson(url);
    const members = data?.query?.categorymembers ?? [];
    for (const m of members) titles.push(m.title);
    cmcontinue = data?.continue?.cmcontinue ?? '';
    if (cmcontinue) await sleep(RATE_MS);
  } while (cmcontinue);
  return titles;
}

async function getSetWikitext(title) {
  const url = `${API}?action=parse&page=${encodeURIComponent(title)}&prop=wikitext&format=json`;
  const data = await fetchJson(url);
  return data?.parse?.wikitext?.['*'] ?? '';
}

function parseReleaseDate(wikitext) {
  // Try multiple jp_release_date-style param names
  const params = [
    /\|\s*jp_release_date\s*=\s*([^\n|{}]+)/,
    /\|\s*ja_release_date\s*=\s*([^\n|{}]+)/,
    /\|\s*japan_release\s*=\s*([^\n|{}]+)/,
    /\|\s*release_jp\s*=\s*([^\n|{}]+)/,
    /\|\s*jp_date\s*=\s*([^\n|{}]+)/,
    /\|\s*date\s*=\s*([^\n|{}]+)/,
    /\|\s*distribution_date\s*=\s*([^\n|{}]+)/,
    /\|\s*release\s*=\s*([^\n|{}]+)/,
  ];
  for (const p of params) {
    const m = wikitext.match(p);
    if (m && m[1].trim()) return m[1].replace(/<ref\b.*$/, '').trim();
  }
  // Fallback: inline text
  const m2 = wikitext.match(/released?\s+in\s+Japan\s+on\s+([A-Z][a-z]+\s+\d+,\s+\d{4})/i);
  if (m2) return m2[1].trim();
  return null;
}

function parseSetCoverImage(wikitext) {
  const m = wikitext.match(/\|\s*image\s*=\s*([^\n|{}<>]+)/);
  return m ? m[1].trim() || null : null;
}

function parsePacksPerBox(wikitext) {
  // "5 cards per pack and 15 packs per box"
  const m = wikitext.match(/(\d+)\s+packs?\s+per\s+box/i);
  if (m) return parseInt(m[1]);
  // qty_per_box template param
  const m2 = wikitext.match(/\|\s*qty_per_box\s*=\s*(\d+)/);
  if (m2) return parseInt(m2[1]);
  return null;
}

function parseSetSize(wikitext) {
  // | size = 40
  const m = wikitext.match(/\|\s*size\s*=\s*(\d+)/);
  if (m) return parseInt(m[1]);
  // "This Deck contains 40 cards"
  const m2 = wikitext.match(/(?:deck|set)\s+contains?\s+(\d+)\s+cards?/i);
  if (m2) return parseInt(m2[1]);
  // "40-card Deck"
  const m3 = wikitext.match(/(\d+)[\s-]+card\s+(?:starter\s+|structure\s+)?deck/i);
  if (m3) return parseInt(m3[1]);
  return null;
}

function parseCardsPerPack(wikitext) {
  const patterns = [
    /(\d+)\s+cards?\s+per\s+pack/i,                    // "5 cards per pack"
    /each\s+pack\s+contains?\s+(\d+)\s+of\s+\d+/i,    // "Each pack contains 1 of 5 Secret Rare cards"
    /each\s+pack\s+contains?\s+(\d+)\s+cards?/i,       // "Each pack contains 2 cards"
    /\|\s*qty_per_pack\s*=\s*(\d+)/,
    /\|\s*pack_contents\s*=\s*(\d+)/,
  ];
  for (const p of patterns) {
    const m = wikitext.match(p);
    if (m) return parseInt(m[1]);
  }
  return null;
}

function isDeck(title) {
  return /(Strongest Battle|Structure|Starter|Half|Go Rush)\s+Deck/i.test(title);
}

function parseDeckListWikitext(wikitext) {
  const contents = {};
  // {{Set list|region=JP|rarities=Common|qty=1|
  // CODE; NAME; RARITY_OVERRIDE; PRINT_STATUS; QTY_OVERRIDE
  // }}
  const blockRe = /\{\{Set list\|([^\n]*)\n([\s\S]*?)\}\}/g;
  let m;
  while ((m = blockRe.exec(wikitext)) !== null) {
    const header = m[1];
    const body   = m[2];
    const rarityM = header.match(/rarities\s*=\s*([^|]+)/);
    const qtyM    = header.match(/\bqty\s*=\s*(\d+)/);
    const defaultRarity = rarityM ? rarityM[1].trim() : 'Common';
    const defaultQty    = qtyM    ? parseInt(qtyM[1]) : 1;
    for (const line of body.split('\n')) {
      const t = line.trim();
      if (!t || !t.includes(';')) continue;
      const parts = t.split(';').map(p => p.trim());
      const code = parts[0];
      if (!code || !/^[A-Z0-9/]+-JP[S]?\d+/i.test(code)) continue;
      const rarityOverride = parts[2] || '';
      const qtyStr = parts[4] || '';
      const rarity = rarityOverride || defaultRarity;
      const qty = parseInt(qtyStr) || defaultQty;
      contents[code] = { rarity, qty };
    }
  }
  return Object.keys(contents).length ? contents : null;
}

async function fetchDeckList(title) {
  const listPage = `Set Card Lists:${title} (OCG-JP)`;
  const url = `${API}?action=parse&page=${encodeURIComponent(listPage)}&prop=wikitext&format=json`;
  try {
    const data = await fetchJson(url);
    const wikitext = data?.parse?.wikitext?.['*'];
    if (!wikitext) return null;
    return parseDeckListWikitext(wikitext);
  } catch (e) {
    return null;
  }
}

function isPromoSet(title) {
  return /Campaign|Promotion|Collaboration|Promotional|prize|Bonus|Victory\s+Pack|Card\s+Game\s+Gum|Tournament|Jump\s+Victory\s+Carnival|Complete\s+Challenge|Galaxy\s+Cup|participation|Secret\s+Ace|Special\s+Pack|Challenge\s+Pack|Duel\s+Disk|Duel\s+Set|Saikyo|Saikyō|Limited\s+Pack/i.test(title);
}

async function syncSets() {
  // Load existing data to avoid redundant fetches
  let existing = {};
  try { existing = JSON.parse(fs.readFileSync(OUT, 'utf8')); } catch { /* first run */ }

  const categories = [
    'Category:Yu-Gi-Oh! Rush Duel Booster Packs',
    'Category:Yu-Gi-Oh! Rush Duel preconstructed Decks',
  ];

  // Recursively expand sub-categories one level deep
  const setTitles = new Set();
  for (const cat of categories) {
    console.log(`[sync-sets] Fetching category: ${cat}`);
    let members;
    try { members = await getCategoryMembers(cat); }
    catch (e) { console.error(`[sync-sets] Category fetch failed: ${e.message}`); continue; }
    await sleep(RATE_MS);

    for (const t of members) {
      if (t.startsWith('Category:')) {
        // expand one sub-category level
        try {
          const sub = await getCategoryMembers(t);
          sub.filter(s => !s.startsWith('Category:')).forEach(s => setTitles.add(s));
          await sleep(RATE_MS);
        } catch { /* ignore */ }
      } else {
        setTitles.add(t);
      }
    }
  }

  // Supplement with deck set names directly from cards.json.
  // Category expansion alone often misses deeply-nested or event deck pages.
  try {
    const cardsData = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'cards.json'), 'utf8'));
    let added = 0;
    for (const card of cardsData) {
      for (const s of (card.sets_jp || [])) {
        if (s.name && isDeck(s.name) && !setTitles.has(s.name)) {
          setTitles.add(s.name);
          added++;
        }
      }
    }
    if (added) console.log(`[sync-sets] Added ${added} deck set(s) from cards.json`);

    // Also supplement with promo set names so we can fetch their release dates
    let addedPromo = 0;
    for (const card of cardsData) {
      for (const s of (card.sets_jp || [])) {
        if (s.name && isPromoSet(s.name) && !setTitles.has(s.name)) {
          setTitles.add(s.name);
          addedPromo++;
        }
      }
    }
    if (addedPromo) console.log(`[sync-sets] Added ${addedPromo} promo set(s) from cards.json`);
  } catch (e) {
    console.error('[sync-sets] Could not supplement from cards.json:', e.message);
  }

  console.log(`[sync-sets] Found ${setTitles.size} set pages`);

  const result = { ...existing };
  let fetched = 0;

  for (const title of setTitles) {
    const deck = isDeck(title);
    const entry = result[title];

    const hasMetadata = entry
      && 'coverImage' in entry
      && 'packsPerBox' in entry
      && (deck || entry.cardsPerPack != null)
      && (entry.releaseDateJP || deck);
    const hasDeckContents = !deck || 'deckContents' in (entry || {});

    if (hasMetadata && hasDeckContents) continue;

    if (!hasMetadata) {
      await sleep(RATE_MS);
      let wikitext;
      try {
        wikitext = await getSetWikitext(title);
      } catch (e) {
        console.error(`[sync-sets] Failed to fetch "${title}": ${e.message}`);
        continue;
      }

      const releaseDateJP = parseReleaseDate(wikitext);
      const promo = isPromoSet(title);
      if (!releaseDateJP && !deck && !promo) continue;

      const packsPerBox = deck ? 0 : (parsePacksPerBox(wikitext) ?? null);
      const coverImage = parseSetCoverImage(wikitext);
      const cardsPerPack = deck ? null : parseCardsPerPack(wikitext);
      const declaredSize = deck ? (parseSetSize(wikitext) ?? null) : null;

      result[title] = { ...(entry || {}), releaseDateJP, packsPerBox, coverImage, cardsPerPack, declaredSize };
      fetched++;
    }

    if (deck && !hasDeckContents) {
      await sleep(RATE_MS);
      const deckContents = await fetchDeckList(title);
      result[title] = { ...(result[title] || {}), deckContents };
      fetched++;
    }

    if (fetched % 10 === 0) {
      fs.writeFileSync(OUT, JSON.stringify(result, null, 2));
      fs.writeFileSync(path.join(DATA_DIR, 'sync-progress-sets.json'), JSON.stringify({ current: fetched, total: setTitles.size }));
      console.log(`[sync-sets] Saved ${fetched} sets so far...`);
    }
  }

  fs.writeFileSync(OUT, JSON.stringify(result, null, 2));
  console.log(`[sync-sets] Done. ${fetched} sets updated, ${Object.keys(result).length} total.`);
}

async function syncCoverImageUrls() {
  const setsData = JSON.parse(fs.readFileSync(OUT, 'utf8'));
  const existing = fs.existsSync(IMG_URLS) ? JSON.parse(fs.readFileSync(IMG_URLS, 'utf8')) : {};

  // Collect cover image filenames not yet resolved
  const missing = [...new Set(
    Object.values(setsData)
      .map(s => s.coverImage)
      .filter(f => f && !existing[f])
  )];

  if (!missing.length) {
    console.log('[sync-sets] Cover image URLs already up to date.');
    return;
  }

  console.log(`[sync-sets] Fetching URLs for ${missing.length} cover images…`);
  const BATCH = 50; // Yugipedia allows up to 50 titles per imageinfo request

  for (let i = 0; i < missing.length; i += BATCH) {
    const batch = missing.slice(i, i + BATCH);
    const titles = batch.map(f => 'File:' + f).join('|');
    const url = `${API}?action=query&titles=${encodeURIComponent(titles)}&prop=imageinfo&iiprop=url&format=json`;
    try {
      const data = await fetchJson(url);
      const pages = data?.query?.pages ?? {};
      for (const page of Object.values(pages)) {
        const filename = page.title?.replace(/^File:/, '');
        const imgUrl = page.imageinfo?.[0]?.url;
        if (filename && imgUrl) existing[filename] = imgUrl;
      }
    } catch (e) {
      console.warn(`[sync-sets] imageinfo batch failed:`, e.message);
    }
    if (i + BATCH < missing.length) await sleep(RATE_MS);
  }

  fs.writeFileSync(IMG_URLS, JSON.stringify(existing, null, 2));
  console.log(`[sync-sets] Cover image URLs saved to image-urls.json.`);
}

syncSets()
  .then(() => syncCoverImageUrls())
  .catch(e => {
    console.error('[sync-sets] Fatal error:', e.message);
    process.exit(1);
  });
