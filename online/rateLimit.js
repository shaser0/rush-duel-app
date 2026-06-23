'use strict';

// Sliding-window rate limiter.
// Returns true (allowed) or false (blocked).
class RateLimiter {
  constructor(maxHits, windowMs) {
    this.maxHits  = maxHits;
    this.windowMs = windowMs;
    this.buckets  = new Map(); // key → sorted array of timestamps
  }

  check(key) {
    const now    = Date.now();
    const cutoff = now - this.windowMs;
    const hits   = (this.buckets.get(key) || []).filter(t => t > cutoff);
    if (hits.length >= this.maxHits) {
      this.buckets.set(key, hits);
      return false;
    }
    hits.push(now);
    this.buckets.set(key, hits);
    return true;
  }

  // Prune expired buckets to prevent unbounded memory growth.
  cleanup() {
    const cutoff = Date.now() - this.windowMs;
    for (const [key, hits] of this.buckets) {
      const fresh = hits.filter(t => t > cutoff);
      if (fresh.length === 0) this.buckets.delete(key);
      else this.buckets.set(key, fresh);
    }
  }
}

// Chat: 10 messages per 10 s per socket
const chatLimiter = new RateLimiter(10, 10_000);
// Room join/create: 5 attempts per 30 s per socket
const joinLimiter = new RateLimiter(5, 30_000);

setInterval(() => { chatLimiter.cleanup(); joinLimiter.cleanup(); }, 60_000).unref();

module.exports = { chatLimiter, joinLimiter };
