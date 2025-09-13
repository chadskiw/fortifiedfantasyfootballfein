// src/routes/platforms.js
const express = require('express');
const router = express.Router();

/**
 * File location: src/routes/platforms.js
 * Routers dir:   src/routers/*.js
 * Relative path: ../routers/...
 */

router.get('/__alive', (_req, res) =>
  res.json({ ok: true, scope: '/api/platforms' })
);

// ✅ Mount platform routers (Express routers, not adapters)
router.use('/espn', require('../../routers/espnRouter'));
router.use('/sleeper', require('../../routers/sleeperRouter'));
router.use('/health',  require('../../routers/healthRouter'));

// Optional: quick list of mounts
router.get('/__routes', (_req, res) => {
  res.json({
    ok: true,
    mounts: [
      '/api/platforms/espn',
      '/api/platforms/sleeper',
      '/api/platforms/health',
    ],
  });
});

module.exports = router;
