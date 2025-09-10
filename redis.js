// Minimal Upstash/Redis client (works with any redis, too)
const { createClient } = require('redis');

let clientPromise;

function getRedis() {
  if (!process.env.REDIS_URL) return null; // make Redis optional
  if (!clientPromise) {
    const c = createClient({ url: process.env.REDIS_URL, socket: { tls: process.env.REDIS_TLS === '1' } });
    clientPromise = c.connect().then(() => c).catch((e) => { console.error('[redis] connect error', e); return null; });
  }
  return clientPromise;
}

module.exports = { getRedis };
