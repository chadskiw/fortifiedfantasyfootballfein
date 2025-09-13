// src/routes/platforms/index.js
const express = require('express');
const router = express.Router();

/**
 * NOTE on paths:
 * This file lives at: src/routes/platforms/index.js
 * Your routers live at: /routers/*.js
 * To get from here to there you go up three levels: ../../..
 *   src -> routes -> platforms -> (index.js)
 * So "../../../routers/espnRouter" is correct on Linux/Mac/Windows.
 */

// Basic liveness for this group
router.get('/__alive', (_req, res) => res.json({ ok: true, scope: '/api/platforms' }));

// Mount platform routers (ESPN/Sleeper/Health)
router.use('/espn',    require('../../routers/espnRouter'));
router.use('/sleeper', require('../../routers/sleepRouter'));
router.use('/health',  require('../../routers/healthRouter'));

// Optional: list child routes for quick debugging
router.get('/__routes', (_req, res) => {
  res.json({
    ok: true,
    mounts: [
      '/api/platforms/espn',
      '/api/platforms/sleeper',
      '/api/platforms/health',
    ],
    tips: [
      'Hit /api/platforms/espn/__routes to see ESPN endpoints',
      'Hit /api/platforms/health/ping for a quick health check'
    ]
  });
});

module.exports = router;
