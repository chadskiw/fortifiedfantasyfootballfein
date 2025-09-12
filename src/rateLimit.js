// src/rateLimit.js
const WINDOW_MS = Number(process.env.RATE_LIMIT_WINDOW_MS || 15*60*1000);
const MAX       = Number(process.env.RATE_LIMIT_MAX || 1200);
const buckets = new Map(); // ip -> { count, resetAt }

function rateLimit(req, res, next) {
  const ip  = req.headers['cf-connecting-ip'] || req.ip || req.connection?.remoteAddress || 'unknown';
  const now = Date.now();

  let b = buckets.get(ip);
  if (!b || b.resetAt <= now) {
    b = { count: 0, resetAt: now + WINDOW_MS };
    buckets.set(ip, b);
  }
  b.count += 1;
  res.setHeader('X-RateLimit-Limit', String(MAX));
  res.setHeader('X-RateLimit-Remaining', String(Math.max(0, MAX - b.count)));
  res.setHeader('X-RateLimit-Reset', String(Math.ceil(b.resetAt/1000)));

  if (b.count > MAX) {
    return res.status(429).json({ ok:false, error:'Too many requests', resetAt:new Date(b.resetAt).toISOString() });
  }
  next();
}

module.exports = { rateLimit };
