// api/platforms/index.js
const express = require('express');
const router = express.Router();

/**
 * This file:      src/routes/platforms/index.js
 * Routers folder: /routers/*.js  (repo root)
 * Relative path:  ../../../routers/...
 */

// sanity
router.get('/__alive', (_req, res) => res.json({ ok: true, scope: '/api/platforms' }));

// ✅ Mount Express routers (NOT adapters)
router.use('/espn',    require('../../src/routers/espnRouter'));
router.use('/sleeper', require('../../src/routers/sleeperRouter'));
router.use('/health',  require('../../src/routers/healthRouter'));

// optional helper
router.get('/__routes', (_req, res) => {
  res.json({
    ok: true,
    mounts: ['/api/platforms/espn','/api/platforms/sleeper','/api/platforms/health'],
  });
});

module.exports = router;
