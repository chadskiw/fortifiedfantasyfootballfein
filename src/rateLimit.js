// TRUE_LOCATION: src/rateLimit.js
// IN_USE: TRUE
// src/rateLimit.js
const { rateLimit, ipKeyGenerator } = require('express-rate-limit');

const limiter = rateLimit({
  windowMs: 60 * 1000,   // 1 minute window
  limit: 1200,           // 1200 req/min per client
  standardHeaders: true,
  legacyHeaders: false,

  // ✅ Use the helper so IPv6 users can’t bypass limits
  keyGenerator: ipKeyGenerator,

  // Keep your skips
  skip: (req) => {
    if (req.method === 'OPTIONS') return true;                   // don’t rate-limit preflights
    if (req.path && req.path.startsWith('/api/quickhitter/')) return true; // skip identity endpoints
    return false;
  },
});

module.exports = { rateLimit: limiter };
