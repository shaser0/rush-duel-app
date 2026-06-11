'use strict';

const { fetchJson, sleep } = require('./http');
const { YUGIPEDIA_API } = require('./paths');

const RATE_MS = 1200;

// action=query can return HTTP 200 with an { error } body and no "query"
// field (e.g. during wiki maintenance). Retry like a transient failure,
// then throw — callers must not mistake an empty response for "no results".
async function fetchQuery(url, retries = 2) {
  const data = await fetchJson(url);
  if (!data?.query) {
    if (retries > 0) {
      await sleep(3000);
      return fetchQuery(url, retries - 1);
    }
    throw new Error('Yugipedia API response missing "query": ' + JSON.stringify(data).slice(0, 200));
  }
  return data;
}

// Fetch all page titles in a Yugipedia category (auto-paginated).
// filter: optional function(title) → bool
async function getCategoryMembers(categoryTitle, filter = null) {
  const titles = [];
  let cmcontinue = '';
  let first = true;
  do {
    const url = `${YUGIPEDIA_API}?action=query&list=categorymembers`
      + `&cmtitle=${encodeURIComponent(categoryTitle)}&cmtype=page&cmlimit=500&format=json`
      + (cmcontinue ? `&cmcontinue=${encodeURIComponent(cmcontinue)}` : '');
    if (!first) await sleep(RATE_MS);
    first = false;
    const data = await fetchQuery(url);
    for (const m of data.query.categorymembers ?? []) {
      if (!filter || filter(m.title)) titles.push(m.title);
    }
    cmcontinue = data.continue?.cmcontinue ?? '';
  } while (cmcontinue);
  return titles;
}

// Fetch wikitext for up to 50 pages in one API call.
// Returns: Map<pageTitle, wikitextString>
async function getPagesBatch(titles) {
  const url = `${YUGIPEDIA_API}?action=query`
    + `&titles=${titles.map(encodeURIComponent).join('|')}`
    + `&prop=revisions&rvprop=content&rvslots=main&format=json`;
  const data = await fetchQuery(url);
  const result = new Map();
  for (const page of Object.values(data.query.pages || {})) {
    if (page.missing !== undefined) continue;
    const wikitext = page.revisions?.[0]?.slots?.main?.['*']
                  || page.revisions?.[0]?.['*']
                  || '';
    if (wikitext) result.set(page.title, wikitext);
  }
  return result;
}

// Fetch revision timestamps for up to 50 pages in one API call.
// Returns: Map<pageTitle, ISO-timestamp>
async function getTimestampsBatch(titles) {
  const url = `${YUGIPEDIA_API}?action=query`
    + `&titles=${titles.map(encodeURIComponent).join('|')}`
    + `&prop=revisions&rvprop=timestamp&format=json`;
  const data = await fetchQuery(url);
  const result = new Map();
  for (const page of Object.values(data.query.pages || {})) {
    const ts = page.revisions?.[0]?.timestamp;
    if (ts) result.set(page.title, ts);
  }
  return result;
}

// Batch-resolve MediaWiki filenames → direct CDN URLs (up to 50 per call).
// urlCache is mutated in-place: { filename: url, ... }
// A failed batch is logged and skipped so one bad batch never aborts a sync.
async function resolveImageUrls(filenames, urlCache) {
  const todo = filenames.filter(f => !urlCache[f]);
  for (let i = 0; i < todo.length; i += 50) {
    const batch = todo.slice(i, i + 50);
    const titles = batch.map(f => `File:${f}`).join('|');
    const url = `${YUGIPEDIA_API}?action=query&titles=${encodeURIComponent(titles)}&prop=imageinfo&iiprop=url&format=json`;
    try {
      if (i > 0) await sleep(RATE_MS);
      const data = await fetchQuery(url);
      for (const page of Object.values(data.query.pages || {})) {
        const fname  = (page.title || '').replace(/^File:/, '');
        const direct = page?.imageinfo?.[0]?.url;
        if (fname && direct) urlCache[fname] = direct;
      }
    } catch (e) {
      console.error(`[yugipedia] imageinfo batch failed: ${e.message}`);
    }
  }
}

module.exports = { getCategoryMembers, getPagesBatch, getTimestampsBatch, resolveImageUrls, RATE_MS };
