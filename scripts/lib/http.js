'use strict';

// Re-spawn the calling script with --use-system-ca on Windows so HTTPS
// requests trust the Windows certificate store.
// Call as: ensureSystemCa(__filename) — must be first, before any https request.
// In pkg binaries the flag is baked via `--options use-system-ca`, so
// process.execArgv already contains it and no re-spawn happens.
function ensureSystemCa(callerFile) {
  if (!process.execArgv.some(a => a === '--use-system-ca')) {
    const { spawnSync } = require('child_process');
    const r = spawnSync(
      process.execPath,
      ['--use-system-ca', callerFile, ...process.argv.slice(2)],
      { stdio: 'inherit' }
    );
    process.exit(r.status ?? 0);
  }
}

const https = require('https');

// Single UA for all Yugipedia requests — identifies the app and links to the repo.
const UA = `rush-app/${require('../../package.json').version} (https://github.com/shaser0/rush-duel-app)`;

const sleep = ms => new Promise(r => setTimeout(r, ms));

// HTTPS GET with retry, timeout, and HTTP status check.
// Transient failures — 5xx (Yugipedia throws frequent 502s during wiki
// maintenance), connection errors, timeouts, and malformed JSON — are retried
// with exponential backoff, so a brief outage of a few tens of seconds is
// ridden out instead of aborting a whole sync. The backoff schedule for the
// default 4 retries is 1.5s, 3s, 6s, 12s (~22s total window across 5 attempts);
// a shallow fixed retry previously gave up after ~6s and killed the run on the
// critical-path category fetch. Non-transient 4xx (e.g. a bad request) fail
// fast — a retry can't fix them.
function fetchJson(url, retries = 4) {
  const BACKOFF_BASE_MS = 1500;
  return new Promise((resolve, reject) => {
    const attempt = n => {
      const retryOrFail = err => {
        if (n > 0) setTimeout(() => attempt(n - 1), BACKOFF_BASE_MS * 2 ** (retries - n));
        else reject(err);
      };
      const req = https.get(url, { headers: { 'User-Agent': UA } }, res => {
        let data = '';
        res.on('data', c => (data += c));
        res.on('end', () => {
          const code = res.statusCode;
          if (code < 200 || code >= 300) {
            // Retry server errors and rate-limits; fail fast on other 4xx.
            if (code >= 500 || code === 429) retryOrFail(new Error(`HTTP ${code}`));
            else reject(new Error(`HTTP ${code}`));
            return;
          }
          try { resolve(JSON.parse(data)); }
          catch (e) { retryOrFail(e); }
        });
      });
      req.on('error', retryOrFail);
      req.setTimeout(30000, () => {
        req.destroy();
        retryOrFail(new Error('timeout'));
      });
    };
    attempt(retries);
  });
}

module.exports = { ensureSystemCa, fetchJson, sleep, UA };
