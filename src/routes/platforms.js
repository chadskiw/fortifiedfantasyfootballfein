// src/routes/platforms.js
const express = require('express');
const path = require('path');
const router = express.Router();

router.get('/__alive', (_req, res) => res.json({ ok: true, scope: '/api/platforms' }));

router.use('/espn',    require(path.join(__dirname, '../../routers/espnRouter')));
router.use('/sleeper', require(path.join(__dirname, '../../routers/sleeperRouter')));
router.use('/health',  require(path.join(__dirname, '../../routers/healthRouter')));

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
