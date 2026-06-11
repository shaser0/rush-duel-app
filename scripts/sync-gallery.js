'use strict';

if (!process.execArgv.some(a => a === '--use-system-ca')) {
  const { spawnSync } = require('child_process');
  const r = spawnSync(process.execPath, ['--use-system-ca', __filename, ...process.argv.slice(2)], { stdio: 'inherit' });
  process.exit(r.status ?? 0);
}

const https = require('https');
const fs    = require('fs');
const path  = require('path');

const DATA_DIR    = process.env.RUSH_DATA_DIR || path.join(__dirname, '../data');
const CARDS_FILE  = path.join(DATA_DIR, 'cards.json');
const OUT_FILE    = path.join(DATA_DIR, 'gallery-images.json');
const URLS_FILE   = path.join(DATA_DIR, 'image-urls.json');
const API         = 'https://yugipedia.com/api.php';
const RATE_MS     = 1200;

function sleep(ms){ return new Promise(r => setTimeout(r, ms)); }

function fetchJson(url, retries = 2){
  return new Promise((resolve, reject) => {
    const attempt = n => {
      const req = https.get(url, {
        headers: { 'User-Agent': 'YgoRushDB/1.0 (https://github.com/user/ygo-rush-db)' },
      }, res => {
        let d = '';
        res.on('data', c => (d += c));
        res.on('end', () => {
          if(res.statusCode < 200 || res.statusCode >= 300){
            if(n > 0) setTimeout(() => attempt(n-1), 3000); else reject(new Error(`HTTP ${res.statusCode}`));
            return;
          }
          try { resolve(JSON.parse(d)); } catch(e){ reject(e); }
        });
      });
      req.on('error', err => { if(n > 0) setTimeout(() => attempt(n-1), 2000); else reject(err); });
      req.setTimeout(30000, () => { req.destroy(); if(n > 0) setTimeout(() => attempt(n-1), 2000); else reject(new Error('timeout')); });
    };
    attempt(retries);
  });
}

// Batch-resolve filenames → direct CDN URLs via MediaWiki imageinfo API (up to 50 per call)
async function resolveImageUrls(filenames, urlCache){
  const todo = filenames.filter(f => !urlCache[f]);
  for(let i = 0; i < todo.length; i += 50){
    const batch = todo.slice(i, i + 50);
    const titles = batch.map(f => `File:${f}`).join('|');
    const url = `${API}?action=query&titles=${encodeURIComponent(titles)}&prop=imageinfo&iiprop=url&format=json`;
    try {
      await sleep(RATE_MS);
      const data = await fetchJson(url);
      for(const page of Object.values(data?.query?.pages || {})){
        const fname = (page.title || '').replace(/^File:/, '');
        const direct = page?.imageinfo?.[0]?.url;
        if(fname && direct) urlCache[fname] = direct;
      }
    } catch(e) {
      console.error(`[sync-gallery] imageinfo batch failed: ${e.message}`);
    }
  }
}

// Fetch all image filenames referenced in a gallery page (paginated)
async function getGalleryImages(setName){
  const title = `Set Card Galleries:${setName} (OCG-JP)`;
  const enc   = encodeURIComponent(title);
  let imgs = [], imcontinue = '';
  do {
    const cont = imcontinue ? `&imcontinue=${encodeURIComponent(imcontinue)}` : '';
    const url  = `${API}?action=query&titles=${enc}&prop=images&imlimit=500&format=json${cont}`;
    const data = await fetchJson(url);
    const page = Object.values(data?.query?.pages || {})[0];
    if(!page || page.missing !== undefined) return [];
    imgs.push(...(page.images || []).map(i => i.title.replace(/^File:/, '')).filter(f => /\.png$/i.test(f)));
    imcontinue = data?.continue?.imcontinue || '';
    if(imcontinue) await sleep(RATE_MS);
  } while(imcontinue);
  return imgs;
}

// Convert a card title to the slug used in Yugipedia image filenames
// "Sevens Road Ultima Witch"              → "SevensRoadUltimaWitch"
// "Blue-Eyes White Dragon"               → "BlueEyesWhiteDragon"
// "Supreme Machine Magnum Overlord (L)"  → "SupremeMachineMagnumOverlordL"
// Single-letter parentheticals (L/R/C) are folded in as bare letters.
// Multi-word parentheticals like (Rush Duel) are stripped entirely.
function titleToSlug(title){
  return (title || '')
    .replace(/\s*\(([A-Za-z\d])\)\s*/g, '$1') // (L)→L, (R)→R, (C)→C
    .replace(/\s*\([^)]*\)\s*/g, '')           // strip remaining parentheticals
    .replace(/[^a-zA-Z0-9]/g, '');             // keep only alphanumeric
}

async function syncGallery(){
  let cards;
  try { cards = JSON.parse(fs.readFileSync(CARDS_FILE, 'utf8')); }
  catch(e){ console.error('[sync-gallery] Cannot read cards.json:', e.message); process.exit(1); }

  // slug → card map for matching gallery filenames to cards
  const slugMap = new Map();
  // title → [filename] map of images already in cards.json (the baseline)
  const cardBaseImages = new Map();
  for(const card of cards){
    if (!card.images) console.warn('[sync-gallery] images null pour:', card.title);
    const baseFiles = (card.images || [])
      .map(i => i.file.replace(/^\d+\.\d+;\s*/, '').trim())
      .filter(Boolean);
    cardBaseImages.set(card.title, baseFiles);
    for(const f of baseFiles){
      const m = f.match(/^(.+?)-RD[A-Z0-9]/);
      if(m) slugMap.set(m[1], card);
    }
    const slug = titleToSlug(card.title || card.name_en || '');
    if(slug && !slugMap.has(slug)) slugMap.set(slug, card);
  }

  // Load saved gallery data and URL cache
  let galleryData = {};
  try { galleryData = JSON.parse(fs.readFileSync(OUT_FILE, 'utf8')); } catch{ /* first run */ }
  let urlCache = {};
  try { urlCache = JSON.parse(fs.readFileSync(URLS_FILE, 'utf8')); } catch{ /* first run */ }

  // knownFiles = every filename already accounted for (in galleryData OR in cards-clean)
  const allExistingFiles = new Set(
    [...cardBaseImages.values()].flat().concat(Object.values(galleryData).flat())
  );

  // Collect unique set names from JP sets
  const setNames = [...new Set(
    cards.flatMap(c => (c.sets_jp || []).map(s => s.name))
  )];
  console.log(`[sync-gallery] ${setNames.length} JP sets to check`);

  let setsQueried = 0, setsWithImages = 0, newImages = 0;
  for(const setName of setNames){
    await sleep(RATE_MS);
    let imgs;
    try { imgs = await getGalleryImages(setName); }
    catch(e){ console.error(`[sync-gallery] Failed "${setName}": ${e.message}`); continue; }
    setsQueried++;

    if(!imgs.length) continue;
    setsWithImages++;

    const newForSet = [];
    for(const filename of imgs){
      if(allExistingFiles.has(filename)) continue; // already known from any source
      const m = filename.match(/^(.+?)-RD[A-Z0-9]/);
      if(!m) continue;
      const card = slugMap.get(m[1]);
      if(!card) continue;

      const key = card.title;
      // Seed from cards-clean images if this is the first gallery addition for this card
      if(!galleryData[key]){
        galleryData[key] = [...(cardBaseImages.get(key) || [])];
      }
      galleryData[key].push(filename);
      allExistingFiles.add(filename);
      newForSet.push(filename);
      newImages++;
    }

    // Resolve direct URLs for newly found images
    if(newForSet.length) await resolveImageUrls(newForSet, urlCache);

    if(setsWithImages % 20 === 0){
      fs.writeFileSync(OUT_FILE, JSON.stringify(galleryData, null, 2));
      fs.writeFileSync(URLS_FILE, JSON.stringify(urlCache, null, 2));
      fs.writeFileSync(path.join(DATA_DIR, 'sync-progress-gallery.json'), JSON.stringify({ current: setsQueried, total: setNames.length }));
      console.log(`[sync-gallery] ${setsQueried}/${setNames.length} queried, ${setsWithImages} with galleries, ${newImages} new images`);
    }
  }

  // Resolve any filenames in galleryData that don't yet have a cached URL
  const allGalleryFiles = [...new Set(Object.values(galleryData).flat())];
  const unresolved = allGalleryFiles.filter(f => !urlCache[f]);
  if(unresolved.length){
    console.log(`[sync-gallery] Resolving ${unresolved.length} existing filenames to direct URLs...`);
    await resolveImageUrls(unresolved, urlCache);
  }

  // Also resolve base card images from cards.json that aren't in cache
  const allBaseFiles = [...new Set([...cardBaseImages.values()].flat())];
  const unresolvedBase = allBaseFiles.filter(f => !urlCache[f]);
  if(unresolvedBase.length){
    console.log(`[sync-gallery] Resolving ${unresolvedBase.length} base card image URLs...`);
    await resolveImageUrls(unresolvedBase, urlCache);
  }

  fs.writeFileSync(OUT_FILE, JSON.stringify(galleryData, null, 2));
  fs.writeFileSync(URLS_FILE, JSON.stringify(urlCache, null, 2));
  console.log(`[sync-gallery] Done. Queried ${setsQueried} sets, ${setsWithImages} had galleries, ${newImages} new images for ${Object.keys(galleryData).length} cards. ${Object.keys(urlCache).length} URLs cached.`);
}

syncGallery().catch(e => {
  console.error('[sync-gallery] Fatal:', e.message);
  process.exit(1);
});
