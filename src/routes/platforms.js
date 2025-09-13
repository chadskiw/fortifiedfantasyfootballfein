// src/routes/platforms.js
const express = require('express');
const path = require('path');
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
router.use('/espn',    require(path.join(__dirname, '../../routers/espnRouter')));
router.use('/sleeper', require(path.join(__dirname, '../../routers/sleeperRouter')));
router.use('/health',  require(path.join(__dirname, '../../routers/healthRouter')));

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
