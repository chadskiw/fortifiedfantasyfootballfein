// src/rateLimit.js
const rateLimit = require('express-rate-limit');

const limiter = rateLimit({
  windowMs: 60 * 1000,      // 1 minute window
  limit: 1200,              // 1200 req/min per IP
  standardHeaders: true,    // X-RateLimit-*
  legacyHeaders: false,
  keyGenerator: (req) => {
    // With trust proxy enabled, req.ip is the client's IP.
    // If you want to be extra-safe behind Cloudflare:
    return req.headers['cf-connecting-ip'] || req.ip;
  },
  skip: (req) => {
    // Don’t rate limit preflights
    if (req.method === 'OPTIONS') return true;
    // EITHER skip identity completely:
    if (req.path.startsWith('/api/identity/')) return true;
    // OR comment the line above and keep limits but higher for auth:
    return false;
  }
});

module.exports = { rateLimit: limiter };
