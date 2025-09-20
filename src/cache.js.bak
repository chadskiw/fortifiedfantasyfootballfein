// src/cache.js
const TTL = Number(process.env.CACHE_TTL_SECONDS || 0);
const store = new Map(); // key -> { value, exp }

function get(key) {
  if (!TTL) return undefined;
  const hit = store.get(key);
  if (!hit) return undefined;
  if (hit.exp && Date.now() > hit.exp) { store.delete(key); return undefined; }
  return hit.value;
}
function set(key, value) { if (!TTL) return; store.set(key, { value, exp: Date.now() + TTL*1000 }); }
function del(key) { store.delete(key); }
function clear() { store.clear(); }

module.exports = { get, set, del, clear };
