'use strict';

// On Windows, Node.js does not trust the Windows certificate store by default.
// Re-spawn with --use-system-ca so HTTPS fetches work without CA errors.
require('../lib/http').ensureSystemCa(__filename);

const fs    = require('fs');
const path  = require('path');
const { fetchJson, sleep } = require('../lib/http');
const { writeJsonAtomic }  = require('../lib/fs-atomic');
const { DATA_DIR, YUGIPEDIA_API: API } = require('../lib/paths');
const { resolveImageUrls, RATE_MS } = require('../lib/yugipedia');

const CARDS_FILE  = path.join(DATA_DIR, 'cards.json');
const OUT_FILE    = path.join(DATA_DIR, 'gallery-images.json');
const URLS_FILE   = path.join(DATA_DIR, 'image-urls.json');

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
      .map(i => i.file.trim())
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
      writeJsonAtomic(OUT_FILE, galleryData);
      writeJsonAtomic(URLS_FILE, urlCache);
      writeJsonAtomic(path.join(DATA_DIR, 'sync-progress-gallery.json'), { current: setsQueried, total: setNames.length });
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

  writeJsonAtomic(OUT_FILE, galleryData);
  writeJsonAtomic(URLS_FILE, urlCache);
  console.log(`[sync-gallery] Done. Queried ${setsQueried} sets, ${setsWithImages} had galleries, ${newImages} new images for ${Object.keys(galleryData).length} cards. ${Object.keys(urlCache).length} URLs cached.`);
}

syncGallery().catch(e => {
  console.error('[sync-gallery] Fatal:', e.message);
  process.exit(1);
});
