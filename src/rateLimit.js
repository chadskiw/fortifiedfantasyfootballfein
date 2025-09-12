// src/rateLimit.js
// Simple sliding-window limiter (per IP). Good enough for Render single instance.
// If you scale to multiple instances, switch to Redis-backed store.

const WINDOW_MS = Number(process.env.RATE_LIMIT_WINDOW_MS || 15 * 60 * 1000);
const MAX = Number(process.env.RATE_LIMIT_MAX || 1200);

const buckets = new Map(); // ip -> { count, resetAt }

function rateLimit(req, res, next) {
  const ip = req.headers['cf-connecting-ip'] || req.ip || req.connection?.remoteAddress || 'unknown';
  const now = Date.now();

  let b = buckets.get(ip);
  if (!b || b.resetAt <= now) {
    b = { count: 0, resetAt: now + WINDOW_MS };
    buckets.set(ip, b);
  }

  b.count += 1;
  const remaining = Math.max(0, MAX - b.count);

  res.setHeader('X-RateLimit-Limit', String(MAX));
  res.setHeader('X-RateLimit-Remaining', String(remaining));
  res.setHeader('X-RateLimit-Reset', String(Math.ceil(b.resetAt / 1000)));

  if (b.count > MAX) {
    return res.status(429).json({
      ok: false,
      error: 'Too many requests',
      resetAt: new Date(b.resetAt).toISOString()
    });
  }

  next();
}

module.exports = { rateLimit };
