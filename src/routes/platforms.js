// src/routes/platforms.js
const express = require('express');
const router = express.Router();

/**
 * File location: src/routes/platforms.js
 * Routers dir:   /routers/*.js   (repo root)
 * Relative path: ../../routers/...
 */

router.get('/__alive', (_req, res) =>
  res.json({ ok: true, scope: '/api/platforms' })
);

// Mount platform routers
router.use('/espn',    require('../../routers/espnRouter'));
router.use('/sleeper', require('../../routers/sleeperRouter'));
router.use('/health',  require('../../routers/healthRouter'));

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
