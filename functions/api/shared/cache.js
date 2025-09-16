// functions/api/platforms/shared/cache.js
class LRU {
  constructor(limit = 200) { this.limit = limit; this.map = new Map(); }
  get(k) {
    if (!this.map.has(k)) return undefined;
    const v = this.map.get(k); this.map.delete(k); this.map.set(k, v); return v;
  }
  set(k, v, ttlMs = 60_000) {
    const expires = Date.now() + ttlMs;
    this.map.set(k, { v, expires });
    if (this.map.size > this.limit) this.map.delete(this.map.keys().next().value);
  }
  async remember(key, ttlMs, producer) {
    const hit = this.get(key);
    if (hit && hit.expires > Date.now()) return hit.v;
    const v = await producer();
    this.set(key, v, ttlMs);
    return v;
  }
}
module.exports = { LRU };
